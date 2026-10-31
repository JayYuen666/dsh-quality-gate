// 0.1.3 修复②（「卡片保存期间的编辑不再被静默丢弃」）的行为用例：直接驱动 writeTouched
// 的串行写入与草稿回收。React 组件接线是渲染面、留在覆盖率分母外；这段纯异步逻辑的
// 契约（受理位消费、在途编辑保留、拒写/传输失败不清草稿）在这里逐行为钉住。
import { beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { writeTouched } from "../src/client-entry.ts";
import type { SaveChannels } from "../src/client-entry.ts";
import { loggedText } from "./setup-logs.ts";

/** t 的调用记录：断言 key 与 params，而不是假 translator 的拼接产物。 */
const tCalls: { key: string; params?: Record<string, unknown> }[] = [];

/** 与生产同形的最小 t：记录调用并回稳定串（真实双语值由 client-card 的字典用例钉）。 */
const translator = ((key: string, params?: Record<string, unknown>) => {
  tCalls.push(params === undefined ? { key } : { key, params });
  return `t:${key}`;
}) as unknown as SaveChannels["t"];

/** 写调用记录里 alpha 那一条（多处断言复用，避免重复字面量）。 */
const ALPHA_SET_CALL = "set:alpha=1";

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
    // 冻结副本：生产实现若改成原地删键/改键，严格模式下当场抛错；正向的 setTouched
    // 提交新对象则不受影响（草稿层不可被原地改是这条用例的数据完整性面）。
    touched: Object.freeze({ ...snapshot }),
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
  beforeEach(() => {
    tCalls.length = 0;
  });

  it("多键成功路径严格串行：上一个写 resolve 之后才发出下一个", async () => {
    const events: string[] = [];
    const harness = makeHarness({ alpha: 1, beta: 2 }, async (field, _value, edit) => {
      events.push(`start:${field}`);
      if (field === "alpha") {
        // 在途时用户又改了 beta：这条 updater 必须排到写队列之后，而不是插进两次写之间。
        edit((prev) => ({ ...prev, beta: 9 }));
      }
      events.push(`done:${field}`);
      return true;
    });
    await writeTouched(harness.channels);
    assert.deepEqual(
      events,
      ["start:alpha", "done:alpha", "start:beta", "done:beta"],
      "第二个写必须等第一个写 resolve 之后才发出（并行会把半写状态留给宿主）",
    );
    assert.deepEqual(harness.writes, [ALPHA_SET_CALL, "set:beta=2"]);
    assert.equal(harness.state.busy, false);
    assert.equal(harness.state.saveError, null);
  });

  it("在途期间的新改动留在草稿层：成功后只清「当前值仍等于快照」的键", async () => {
    const harness = makeHarness({ alpha: 1 }, async (_field, _value, edit) => {
      edit((prev) => ({ ...prev, alpha: 2, beta: 5 }));
      return true;
    });
    await writeTouched(harness.channels);
    assert.deepEqual(harness.writes, [ALPHA_SET_CALL]);
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
    assert.equal(harness.state.busy, false, "成功路径必须复位 busy，否则保存按钮永久禁用");
    assert.equal(harness.state.saveError, null);
  });

  it("宿主拒写（受理位 false）：首个被拒即停，草稿全量保留并给出可见反馈", async () => {
    const harness = makeHarness({ alpha: 1, beta: 2 }, async () => false);
    await writeTouched(harness.channels);
    assert.deepEqual(harness.writes, [ALPHA_SET_CALL], "后续键不再写，避免半写状态");
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
    assert.equal(harness.state.saveError, "t:saveFailed");
    assert.deepEqual(tCalls.at(-1), { key: "saveFailed", params: { message: "boom" } });
    assert.equal(harness.state.busy, false);
    assert.match(loggedText(), /save write failed/u, "传输失败要留在算子日志里，不静默");
  });

  it("快照里被清成 undefined 的键走 unset 通道：受理后同样从草稿清除", async () => {
    const harness = makeHarness({ alpha: undefined }, async () => true);
    await writeTouched(harness.channels);
    assert.deepEqual(harness.writes, ["unset:alpha"]);
    assert.deepEqual(harness.draft(), {});
    assert.equal(harness.state.busy, false);
    assert.equal(harness.state.saveError, null);
  });

  it("网关地址不合规：一个字节都不写，草稿保留并给出可读错误", async () => {
    const harness = makeHarness(
      { memoryGatewayUrl: "https://user:pass@gateway.example" },
      async () => true,
    );
    await writeTouched(harness.channels);
    assert.deepEqual(harness.writes, [], "不合规地址不能写进设置面");
    assert.deepEqual(harness.draft(), {
      memoryGatewayUrl: "https://user:pass@gateway.example",
    });
    assert.equal(harness.state.saveError, "t:invalidGatewayUrl");
    assert.deepEqual(tCalls.at(-1), { key: "invalidGatewayUrl" });
    assert.equal(harness.state.busy, false);
  });
});
