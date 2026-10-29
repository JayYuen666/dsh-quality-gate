// 0.1.3 修复②（「卡片保存期间的编辑不再被静默丢弃」）的行为用例：直接驱动 writeTouched
// 的串行写入与草稿回收。React 组件接线是渲染面、留在覆盖率分母外；这段纯异步逻辑的
// 契约（受理位消费、在途编辑保留、拒写/传输失败不清草稿）在这里逐行为钉住。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { writeTouched } from "../src/client-entry.ts";
import type { SaveChannels } from "../src/client-entry.ts";
import { loggedText } from "./setup-logs.ts";

/** 与生产同形的最小 t：只回可断言的稳定串（真实双语值由 client-card 的字典用例钉）。 */
const translator = ((key: string, params?: Record<string, unknown>) =>
  params === undefined
    ? `t:${key}`
    : `t:${key}:${JSON.stringify(params)}`) as unknown as SaveChannels["t"];

type DraftUpdate = (prev: Record<string, unknown>) => Record<string, unknown>;

interface Harness {
  readonly channels: SaveChannels;
  readonly state: { busy: boolean; saveError: string | null };
  /** 已发出的写调用（含值），按顺序。 */
  readonly writes: string[];
  /** 应用全部排队 updater 之后的草稿层（按入队顺序套用，对应 React 的提交时序）。 */
  readonly draft: () => Record<string, unknown>;
}

/**
 * 造一组与生产接线同形的通道。write 回调拿到 edit()：在写请求在途时把「用户又改了」
 * 的 updater 排进同一条 setTouched 队列——保存期间输入框并未禁用，用户编辑与保存收尾
 * 走的是同一个 setter，这正是被修复的那个竞态面。
 */
function makeHarness(
  snapshot: Record<string, unknown>,
  write: (field: string, value: unknown, edit: (update: DraftUpdate) => void) => Promise<boolean>,
): Harness {
  const state = { busy: true, saveError: null as string | null };
  const updaters: DraftUpdate[] = [];
  const writes: string[] = [];
  const enqueue = (update: DraftUpdate): void => {
    updaters.push(update);
  };
  const channels: SaveChannels = {
    t: translator,
    keys: Object.keys(snapshot),
    touched: snapshot,
    set: (field, value) => {
      writes.push(`set:${field}=${String(value)}`);
      return write(field, value, enqueue);
    },
    unset: (field) => {
      writes.push(`unset:${field}`);
      return write(field, undefined, enqueue);
    },
    setBusy: (busy) => {
      state.busy = busy;
    },
    setSaveError: (error) => {
      state.saveError = error;
    },
    setTouched: enqueue,
  };
  let draft: Record<string, unknown> = { ...snapshot };
  return {
    channels,
    state,
    writes,
    draft: () => {
      while (updaters.length > 0) {
        draft = updaters.shift()!(draft);
      }
      return draft;
    },
  };
}

describe("writeTouched：保存期间的编辑不丢", () => {
  it("在途期间的新改动留在草稿层：成功后只清「当前值仍等于快照」的键", async () => {
    const harness = makeHarness({ alpha: 1 }, async (_field, _value, edit) => {
      edit((prev) => ({ ...prev, alpha: 2, beta: 5 }));
      return true;
    });
    await writeTouched(harness.channels);
    assert.deepEqual(harness.writes, ["set:alpha=1"]);
    assert.deepEqual(harness.draft(), { alpha: 2, beta: 5 }, "在途的新键与被再改的键都要留下");
    assert.equal(harness.state.busy, false);
    assert.equal(harness.state.saveError, null);
  });

  it("在途期间把同一键改回快照值：该键视为已落盘，从草稿清除", async () => {
    const harness = makeHarness({ alpha: 1 }, async (_field, _value, edit) => {
      edit((prev) => ({ ...prev, alpha: 1 }));
      return true;
    });
    await writeTouched(harness.channels);
    assert.deepEqual(harness.draft(), {}, "改回快照值等于宿主已写入的那个值，不该再标脏");
  });

  it("宿主拒写（受理位 false）：首个被拒即停，草稿全量保留并给出可见反馈", async () => {
    const harness = makeHarness({ alpha: 1, beta: 2 }, async () => false);
    await writeTouched(harness.channels);
    assert.deepEqual(harness.writes, ["set:alpha=1"], "后续键不再写，避免半写状态");
    assert.deepEqual(harness.draft(), { alpha: 1, beta: 2 });
    assert.equal(harness.state.saveError, "t:saveRejected");
    assert.equal(harness.state.busy, false);
  });

  it("传输失败（reject）：草稿保留，错误文案带上成因消息", async () => {
    const harness = makeHarness({ alpha: 1 }, async () => {
      throw new Error("boom");
    });
    await writeTouched(harness.channels);
    assert.deepEqual(harness.draft(), { alpha: 1 });
    assert.equal(harness.state.saveError, 't:saveFailed:{"message":"boom"}');
    assert.equal(harness.state.busy, false);
    assert.match(loggedText(), /save write failed/u, "传输失败要留在算子日志里，不静默");
  });

  it("快照里被清成 undefined 的键走 unset 通道：受理后同样从草稿清除", async () => {
    const harness = makeHarness({ alpha: undefined }, async () => true);
    await writeTouched(harness.channels);
    assert.deepEqual(harness.writes, ["unset:alpha"]);
    assert.deepEqual(harness.draft(), {});
  });
});
