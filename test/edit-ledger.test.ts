// 编辑台账投影的单元测试：从事件累加状态与从历史重放走的是同一套判断（`EDIT_TOOLS`、badArguments、
// editPathOf 都共用），所以这里逐条固定的是"哪些事件会记成条目、哪些不会"，不重复测 shared 的字段解析。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import { EDIT_LEDGER_KEY, EDIT_LEDGER_MAX, editLedgerProjection } from "../lib/edit-ledger.ts";
import type { EditLedgerState } from "../lib/edit-ledger.ts";

/** 一条 tool/call 事件。参数按原始 JSON 字符串给出（和模型实际产出的写法一致）。 */
function callEvent(seq: number, name: string, args: unknown, callId?: string): SessionEvent {
  return {
    type: "tool/call",
    seq,
    time: seq,
    data: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
      ...(callId === undefined ? {} : { callId }),
    },
    // 本文件只把事件交给投影，事件的其他字段不参与状态累加；写一次显式类型转换比照着官方的判别联合逐个字段抄更可靠。
  } as unknown as SessionEvent;
}

/** 一条 tool/result 事件（isError 在 data.message 里，失败身份在 data 顶层；与官方 rc.2 结构一致）。 */
function resultEvent(
  seq: number,
  callId: string,
  isError: boolean,
  error?: { readonly name: string; readonly code: string },
): SessionEvent {
  return {
    type: "tool/result",
    seq,
    time: seq,
    data: {
      message: { source: { callId }, isError },
      ...(error === undefined ? {} : { error }),
    },
  } as unknown as SessionEvent;
}

function fold(events: readonly SessionEvent[]): EditLedgerState {
  let state = editLedgerProjection.init();
  for (const event of events) {
    state = editLedgerProjection.apply(state, event);
  }
  return state;
}

/** 一条编辑 + 一次带身份的失败结算 → 台账里那条记录的状态。 */
function outcomeOf(error: { name: string; code: string }): string | undefined {
  const state = fold([
    callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1"),
    resultEvent(2, "c1", true, error),
  ]);
  return state.edits[0]?.outcome;
}

describe("编辑台账投影", () => {
  it("callId 为空串的失败结果，不会把最近一条没有 callId 的编辑标成失败", () => {
    const state = fold([callEvent(1, "edit", { file_path: "/w/a.ts" }), resultEvent(2, "", true)]);
    assert.deepEqual(
      state.edits.map((entry) => entry.outcome),
      ["ok"],
      "空字符串的 callId 不能当作关联依据",
    );
  });

  it("同一条失败结果重复送入 → 状态引用不变（已经标为失败时原样返回）", () => {
    const first = fold([
      callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1"),
      resultEvent(2, "c1", true),
    ]);
    const again = editLedgerProjection.apply(first, resultEvent(2, "c1", true));
    assert.equal(again, first, "没有变化时必须返回同一个引用");
  });

  it("stateSchema 能校验真实累加出的状态，并去掉未知字段（旧版本留下的字段不会让整份台账读不出来）", () => {
    const folded = fold([callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1")]);
    assert.equal(editLedgerProjection.stateSchema.safeParse(folded).success, true);
    const withExtra = {
      edits: [{ seq: 1, callId: "c1", name: "edit", path: "/w/a.ts", outcome: "ok", legacy: "x" }],
    };
    const parsed = editLedgerProjection.stateSchema.safeParse(withExtra);
    if (!parsed.success) {
      assert.fail("带未知字段的存档状态必须能读出来（内层 schema 会去掉未知字段）");
    }
    assert.equal(parsed.data.edits[0]?.name, "edit");
  });

  it("写类编辑会记成条目；read-view、非编辑工具和参数不合法都不记录", () => {
    const state = fold([
      callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1"),
      callEvent(2, "write", { file_path: "/w/b.ts" }, "c2"),
      callEvent(3, "str_replace_editor", { command: "view", path: "/w/c.ts" }, "c3"),
      callEvent(4, "read", { file_path: "/w/d.ts" }, "c4"),
      callEvent(5, "edit", "{not json", "c5"),
      callEvent(6, "str_replace_editor", { command: "create", path: "/w/e.ts" }, "c6"),
      // 是写操作但没给路径：仍然记一条，路径用空串（和没有 callId 那组一样，保守地直接记录）。
      callEvent(7, "edit", {}, "c7"),
    ]);
    assert.deepEqual(
      state.edits.map((entry) => [entry.seq, entry.callId, entry.name, entry.path]),
      [
        [1, "c1", "edit", "/w/a.ts"],
        [2, "c2", "write", "/w/b.ts"],
        [6, "c6", "str_replace_editor", "/w/e.ts"],
        [7, "c7", "edit", ""],
      ],
      "只有真正的写操作会记录，seq 用事件自带的日志序号",
    );
    assert.equal(
      state.edits.every((entry) => entry.outcome === "ok"),
      true,
      "没看到失败结果之前一律按未失败处理",
    );
  });

  it("apply_patch 每个文件记一条；失败结果把同 callId 的全部记录都标为失败", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+a",
      "*** Update File: b.ts",
      "*** Move to: c.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: d.ts",
      "*** End Patch",
    ].join("\n");
    const state = fold([
      callEvent(1, "apply_patch", { input: patch }, "c1"),
      resultEvent(2, "c1", true),
    ]);
    assert.deepEqual(
      state.edits.map((entry) => [entry.name, entry.path, entry.outcome]),
      [
        ["apply_patch", "a.ts", "failed"],
        ["apply_patch", "b.ts", "failed"],
        ["apply_patch", "c.ts", "failed"],
        ["apply_patch", "d.ts", "failed"],
      ],
      "四处文件改动都要记录；失败结果不能只标最后一条",
    );
  });

  it("失败结果只标 callId 相同的那一条；匹配不上的结果不改动台账", () => {
    const state = fold([
      callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1"),
      callEvent(2, "edit", { file_path: "/w/b.ts" }, "c2"),
      resultEvent(3, "c1", true),
      resultEvent(4, "c2", false),
      resultEvent(5, "c9", true),
    ]);
    assert.deepEqual(
      state.edits.map((entry) => [entry.callId, entry.outcome]),
      [
        ["c1", "failed"],
        ["c2", "ok"],
      ],
      "只标 callId 匹配上的那一条；成功的结果和找不到的 callId 都不改变状态",
    );
  });

  it("没有 callId 的编辑记成空串（保守地直接记录）", () => {
    const state = fold([callEvent(7, "edit", { file_path: "/w/a.ts" })]);
    assert.deepEqual(state.edits, [
      { seq: 7, callId: "", name: "edit", path: "/w/a.ts", outcome: "ok" },
    ]);
  });

  it("无关的事件原样返回同一份状态（投影按引用判断有没有变化）", () => {
    const empty = editLedgerProjection.init();
    const same = editLedgerProjection.apply(empty, resultEvent(1, "nobody", false));
    assert.equal(same, empty, "不需要记录的事件不能产生新状态");
  });

  it("条数超过上限时丢掉最旧的，保留最近 EDIT_LEDGER_MAX 条", () => {
    const events: SessionEvent[] = [];
    for (let at = 0; at < EDIT_LEDGER_MAX + 2; at += 1) {
      events.push(callEvent(at, "edit", { file_path: `/w/${String(at)}.ts` }, `c${String(at)}`));
    }
    const state = fold(events);
    assert.equal(state.edits.length, EDIT_LEDGER_MAX, "台账条数有上限");
    assert.equal(state.edits[0]?.seq, 2, "丢掉的是最旧的两条");
    assert.equal(state.edits.at(-1)?.seq, EDIT_LEDGER_MAX + 1, "最新一条还在");
  });

  it("投影不会就地修改传进来的 state（重放不能污染历史快照）", () => {
    const empty = editLedgerProjection.init();
    const before = empty.edits;
    const after = editLedgerProjection.apply(
      empty,
      callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1"),
    );
    assert.equal(before.length, 0, "原来的 state.edits 必须仍然为空");
    assert.equal(after.edits.length, 1);
    assert.notEqual(after.edits, before, "新状态必须用新数组，而不是往旧数组里 push");
  });

  it("callId 重复时，失败结果只标最近那一条（从末尾找，这个行为在此明确固定）", () => {
    // 真实日志里 callId 可能被重试或者代理重放复用；这个投影按"最近一条相同 callId"来标失败。
    const state = fold([
      callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1"),
      callEvent(2, "edit", { file_path: "/w/b.ts" }, "c1"),
      resultEvent(3, "c1", true),
    ]);
    assert.deepEqual(
      state.edits.map((entry) => [entry.path, entry.outcome]),
      [
        ["/w/a.ts", "ok"],
        ["/w/b.ts", "failed"],
      ],
    );
  });

  it("键和版本号属于发布时对外声明的一部分", () => {
    assert.equal(editLedgerProjection.key, EDIT_LEDGER_KEY);
    assert.equal(editLedgerProjection.stateVersion, 2);
  });
});

describe("结算身份对编辑语义的分档（rc.2 的 data.error）", () => {
  it("审批类拒绝与派发前取消归为 rejected：工具体没执行，文件一定没变", () => {
    for (const code of [
      "APPROVAL_REJECTED",
      "APPROVAL_CANCELLED",
      "APPROVAL_UNAVAILABLE",
      "ABORTED_BEFORE_DISPATCH",
    ]) {
      assert.equal(outcomeOf({ name: "ApprovalError", code }), "rejected", code);
    }
  });

  it("已派发后中止归为 aborted：写可能已落盘，门禁必须核验", () => {
    assert.equal(outcomeOf({ name: "AbortError", code: "ABORTED" }), "aborted");
    // 只带 AbortError 名字的取消（码不认识）同样按"可能已写"处理
    assert.equal(outcomeOf({ name: "AbortError", code: "CANCELLED" }), "aborted");
  });

  it("其余错误身份与完全没有身份都归为 failed（沿用旧行为：不核验）", () => {
    assert.equal(outcomeOf({ name: "ToolOutputError", code: "UNKNOWN" }), "failed");
    const state = fold([
      callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1"),
      resultEvent(2, "c1", true),
    ]);
    assert.equal(state.edits[0]?.outcome, "failed");
  });
});
