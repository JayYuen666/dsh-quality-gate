// 编辑台账投影的单元用例：折叠判定与回退扫描**同源**（同一套 EDIT_TOOLS / badArguments /
// editPathOf），所以这里逐条钉的是「哪些事件成行、哪些不成行」，不重复测 shared 的字段解析。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import { EDIT_LEDGER_KEY, EDIT_LEDGER_MAX, editLedgerProjection } from "../lib/edit-ledger.ts";
import type { EditLedgerState } from "../lib/edit-ledger.ts";

/** 一条 tool/call 事件。参数按原始 JSON 串给（与模型产出同形）。 */
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
    // 本文件只喂投影，事件的其余位不参与折叠；一次显式断言比逐字段照抄官方判别联合稳。
  } as unknown as SessionEvent;
}

/** 一条 tool/result 事件（isError 在 data.message 里，与官方 v4 同形）。 */
function resultEvent(seq: number, callId: string, isError: boolean): SessionEvent {
  return {
    type: "tool/result",
    seq,
    time: seq,
    data: { message: { source: { callId }, isError } },
  } as unknown as SessionEvent;
}

function fold(events: readonly SessionEvent[]): EditLedgerState {
  let state = editLedgerProjection.init();
  for (const event of events) {
    state = editLedgerProjection.apply(state, event);
  }
  return state;
}

describe("编辑台账投影", () => {
  it("写类编辑成行；read-view、非编辑工具与坏参数都不入账", () => {
    const state = fold([
      callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1"),
      callEvent(2, "write", { file_path: "/w/b.ts" }, "c2"),
      callEvent(3, "str_replace_editor", { command: "view", path: "/w/c.ts" }, "c3"),
      callEvent(4, "read", { file_path: "/w/d.ts" }, "c4"),
      callEvent(5, "edit", "{not json", "c5"),
      callEvent(6, "str_replace_editor", { command: "create", path: "/w/e.ts" }, "c6"),
      // 写操作但没给路径：照样成行，路径记空串（noCallId 组同款保守直记）。
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
      "只有真写操作成行，且 seq 取事件自带的日志位",
    );
    assert.equal(
      state.edits.every((entry) => !entry.failed),
      true,
      "没见到失败结果前一律按未否定处理",
    );
  });

  it("失败结果只否定同 callId 的那一条；未匹配的结果不动台账", () => {
    const state = fold([
      callEvent(1, "edit", { file_path: "/w/a.ts" }, "c1"),
      callEvent(2, "edit", { file_path: "/w/b.ts" }, "c2"),
      resultEvent(3, "c1", true),
      resultEvent(4, "c2", false),
      resultEvent(5, "c9", true),
    ]);
    assert.deepEqual(
      state.edits.map((entry) => [entry.callId, entry.failed]),
      [
        ["c1", true],
        ["c2", false],
      ],
      "只否定命中 callId 的那一条，成功结果与陌生 callId 都不改状态",
    );
  });

  it("缺 callId 的编辑记空串（noCallId 组保守直记）", () => {
    const state = fold([callEvent(7, "edit", { file_path: "/w/a.ts" })]);
    assert.deepEqual(state.edits, [
      { seq: 7, callId: "", name: "edit", path: "/w/a.ts", failed: false },
    ]);
  });

  it("无关事件原样交回同一份状态（投影按引用判变化）", () => {
    const empty = editLedgerProjection.init();
    const same = editLedgerProjection.apply(empty, resultEvent(1, "nobody", false));
    assert.equal(same, empty, "非记录事件不产生新状态");
  });

  it("超过上限丢最旧的，保留最近 EDIT_LEDGER_MAX 条", () => {
    const events: SessionEvent[] = [];
    for (let at = 0; at < EDIT_LEDGER_MAX + 2; at += 1) {
      events.push(callEvent(at, "edit", { file_path: `/w/${String(at)}.ts` }, `c${String(at)}`));
    }
    const state = fold(events);
    assert.equal(state.edits.length, EDIT_LEDGER_MAX, "台账有界");
    assert.equal(state.edits[0]?.seq, 2, "丢掉的是最旧的两条");
    assert.equal(state.edits.at(-1)?.seq, EDIT_LEDGER_MAX + 1, "最新一条仍在");
  });

  it("键与版本号是发布契约的一部分", () => {
    assert.equal(editLedgerProjection.key, EDIT_LEDGER_KEY);
    assert.equal(editLedgerProjection.stateVersion, 1);
  });
});
