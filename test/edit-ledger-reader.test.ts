// `sessionProjections` 的两种返回形态：区分只能在 await 之后做（两种原始返回值都带 .then），
// 而且失败时不能把一个不能用的读取函数交出去——门禁逻辑读到一个总是返回空的读取函数，会把
// "没有证据"当成"没有编辑"。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { EDIT_LEDGER_KEY } from "../lib/edit-ledger.ts";
import { mountEditLedgerReader } from "../lib/edit-ledger-reader.ts";
import type { EditLedgerReader, ProjectionsRegistry } from "../lib/edit-ledger-reader.ts";

const SESSION = { id: "s1" };

/** 无效的注册表（这些用例只关心注册结果，不读状态）。 */
const NO_STATE = undefined;

/** 旧版的释放函数：本文件只断言它被调用过，本身什么都不做。 */
function release(): void {
  void 0;
}

const VALID_STATE = {
  edits: [{ seq: 1, callId: "c1", name: "edit", path: "/w/a.ts", outcome: "ok" }],
};

interface Face {
  readonly published: (EditLedgerReader | undefined)[];
  readonly errors: unknown[];
  readonly disposers: (() => void)[];
  readonly face: {
    publish: (reader: EditLedgerReader | undefined) => void;
    effect: (factory: () => () => void) => unknown;
    onError: (error: unknown) => void;
  };
}

function makeFace(): Face {
  const published: (EditLedgerReader | undefined)[] = [];
  const errors: unknown[] = [];
  const disposers: (() => void)[] = [];
  return {
    published,
    errors,
    disposers,
    face: {
      publish: (reader) => {
        published.push(reader);
      },
      effect: (factory) => {
        const dispose = factory();
        disposers.push(dispose);
      },
      onError: (error) => {
        errors.push(error);
      },
    },
  };
}

describe("编辑台账读取函数的挂载（两种返回形态）", () => {
  it("旧形态：await 得到释放函数，读取时经注册表的 stateOf 取值", async () => {
    const registry: ProjectionsRegistry = {
      register: () => release,
      stateOf: (session, key) => {
        assert.equal(session, SESSION);
        assert.equal(key, EDIT_LEDGER_KEY);
        return VALID_STATE;
      },
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    assert.equal(typeof harness.published.at(-1), "function", "旧形态也要交出读取函数");
    assert.deepEqual(harness.published.at(-1)?.(SESSION), VALID_STATE.edits);
    assert.equal(harness.disposers.length, 1, "登记一个释放函数");
    harness.disposers[0]?.();
    assert.equal(harness.published.at(-1), undefined, "卸载时先收回读取函数");
  });

  it("register 返回 Promise<释放函数>：区分发生在 await 之后", async () => {
    // 旧形态的原始返回值是函数（新形态是 handle），而两种都可能被包在 thenable 里；
    // 这里用 Promise<disposer>：await 之前拿到的是 Promise，await 之后才是函数——
    // 实现如果在 await 之前用 typeof 区分，就会把它当成 handle 或者直接判成不合法的结构。
    let releaseCalls = 0;
    const disposer = (): void => {
      releaseCalls += 1;
    };
    const registry: ProjectionsRegistry = {
      register: () => Promise.resolve(disposer),
      stateOf: () => VALID_STATE,
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    assert.equal(
      typeof harness.published.at(-1),
      "function",
      "Promise<disposer> 在 await 之后仍然按释放函数处理",
    );
    assert.deepEqual(
      harness.published.at(-1)?.(SESSION),
      VALID_STATE.edits,
      "读取仍然走注册表的 stateOf",
    );
    harness.disposers[0]?.();
    assert.equal(releaseCalls, 1, "被调用的释放函数就是 await 之后拿到的那个函数");
  });

  it("新形态：await 得到 handle，读取时经 handle.stateOf 取值，释放走 dispose", async () => {
    let disposed = 0;
    const registry: ProjectionsRegistry = {
      register: () =>
        Promise.resolve({
          stateOf: (session: unknown) => {
            assert.equal(session, SESSION);
            return VALID_STATE;
          },
          dispose: (): Promise<void> => {
            disposed += 1;
            return Promise.resolve();
          },
        }),
      stateOf: () => {
        throw new Error("新形态不应该走注册表的 stateOf");
      },
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    assert.equal(typeof harness.published.at(-1), "function", "新形态也要交出读取函数");
    assert.deepEqual(harness.published.at(-1)?.(SESSION), VALID_STATE.edits);
    harness.disposers[0]?.();
    // dispose 返回 Promise：等它结束再断言，避免用例和实现的微任务顺序绑在一起。
    await Promise.resolve();
    assert.equal(disposed, 1, "卸载时释放 handle");
    assert.equal(harness.published.at(-1), undefined);
  });

  it("不合法的状态按读不到处理（读取函数返回 undefined，由调用方改用扫描）", async () => {
    const registry: ProjectionsRegistry = {
      register: () => (): void => {
        void 0;
      },
      stateOf: () => ({ edits: "not-an-array" }),
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    // 先确认读取函数确实交出去了：只断言返回值会让"根本没交出去"也得到 undefined，用例自己证明自己。
    assert.equal(typeof harness.published.at(-1), "function", "状态不合法时也要交出读取函数");
    assert.equal(harness.published.at(-1)?.(SESSION), undefined);
  });

  it("存档状态里的元素不符合 schema（seq 为负）同样按读不到处理", async () => {
    const registry: ProjectionsRegistry = {
      register: () => (): void => {
        void 0;
      },
      stateOf: () => ({
        edits: [{ seq: -1, callId: "c1", name: "edit", path: "/w/a.ts", outcome: "ok" }],
      }),
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    assert.equal(harness.published.at(-1)?.(SESSION), undefined, "一条不合约束就整份按读不到处理");
  });

  it("同步抛错和异步拒绝都只报告、不交出读取函数", async () => {
    const thrown = makeFace();
    await mountEditLedgerReader(
      {
        register: () => {
          throw new Error("sync boom");
        },
        stateOf: () => NO_STATE,
      },
      thrown.face,
    );
    assert.equal(thrown.published.length, 0, "同步抛错时不交出读取函数");
    assert.equal(thrown.disposers.length, 0, "注册都没成功，不能登记释放函数");
    assert.match(String(thrown.errors[0]), /sync boom/u);

    const rejected = makeFace();
    await mountEditLedgerReader(
      {
        register: () => Promise.reject(new Error("async boom")),
        stateOf: () => NO_STATE,
      },
      rejected.face,
    );
    assert.equal(rejected.published.length, 0, "异步拒绝时也不交出读取函数");
    assert.equal(rejected.disposers.length, 0, "异步拒绝同样不能登记释放函数");
    assert.match(String(rejected.errors[0]), /async boom/u);
  });

  it("注册成功之后 effect 抛错 ⇒ 收回读取函数 + 释放投影 + 报告（不把投影漏在注册表上）", async () => {
    let released = 0;
    const published: (EditLedgerReader | undefined)[] = [];
    const errors: unknown[] = [];
    await mountEditLedgerReader(
      {
        register: () => (): void => {
          released += 1;
        },
        stateOf: () => VALID_STATE,
      },
      {
        publish: (reader) => {
          published.push(reader);
        },
        effect: () => {
          throw new Error("effect boom");
        },
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    assert.equal(released, 1, "注册成功过就必须释放，否则投影会一直挂在注册表上");
    assert.equal(
      published.at(-1),
      undefined,
      "已经交出去的读取函数必须收回（没有清理路径的读取函数不能留着）",
    );
    assert.match(String(errors[0]), /effect boom/u, "报告的是最初那个错误");
  });

  it("publish 抛错 ⇒ 释放投影 + 报告（不把已经注册的投影留在注册表里）", async () => {
    let released = 0;
    const errors: unknown[] = [];
    await mountEditLedgerReader(
      {
        register: () => (): void => {
          released += 1;
        },
        stateOf: () => VALID_STATE,
      },
      {
        publish: () => {
          throw new Error("publish boom");
        },
        effect: () => () => {
          void 0;
        },
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    assert.equal(released, 1);
    assert.match(String(errors[0]), /publish boom/u);
  });

  it("收回读取函数这一步自己抛错时，不掩盖真正的原因（报告最初那个错误 + 仍然释放投影）", async () => {
    let released = 0;
    let publishCalls = 0;
    const errors: unknown[] = [];
    await mountEditLedgerReader(
      {
        register: () => (): void => {
          released += 1;
        },
        stateOf: () => VALID_STATE,
      },
      {
        publish: () => {
          publishCalls += 1;
          if (publishCalls > 1) {
            throw new Error("unpublish boom");
          }
        },
        effect: () => {
          throw new Error("effect boom");
        },
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    assert.equal(released, 1, "收回读取函数失败时也要释放投影");
    assert.match(String(errors[0]), /effect boom/u, "收回读取函数失败不许掩盖真正的原因");
  });

  it("stateOf 抛错按读不到处理：读取函数返回 undefined，不把异常转给调用方", async () => {
    const registry: ProjectionsRegistry = {
      register: () => release,
      stateOf: () => {
        throw new Error("registry stateOf boom");
      },
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    assert.equal(typeof harness.published.at(-1), "function", "stateOf 抛错不影响读取函数的交出");
    assert.equal(harness.published.at(-1)?.(SESSION), undefined);
  });

  it("handle.dispose 拒绝 → 走 onError，不产生未处理的 rejection", async () => {
    const registry: ProjectionsRegistry = {
      register: () =>
        Promise.resolve({
          stateOf: () => VALID_STATE,
          dispose: () => Promise.reject(new Error("dispose boom")),
        }),
      stateOf: () => NO_STATE,
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    harness.disposers[0]?.();
    // dispose 是异步的：让它的 rejection 落到 onError 上。
    await Promise.resolve();
    await Promise.resolve();
    assert.match(String(harness.errors.at(-1)), /dispose boom/u);
  });

  it("清理被重复调用时只释放一次（宿主重放清理不能二次 dispose）", async () => {
    let disposed = 0;
    const registry: ProjectionsRegistry = {
      register: () =>
        Promise.resolve({
          stateOf: () => VALID_STATE,
          dispose: (): Promise<void> => {
            disposed += 1;
            return Promise.resolve();
          },
        }),
      stateOf: () => NO_STATE,
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    harness.disposers[0]?.();
    harness.disposers[0]?.();
    await Promise.resolve();
    assert.equal(disposed, 1, "重复清理时只释放一次");
  });

  it("既不是释放函数也不是 handle ⇒ TypeError 走报告", async () => {
    const harness = makeFace();
    await mountEditLedgerReader(
      { register: () => Promise.resolve({}), stateOf: () => NO_STATE },
      harness.face,
    );
    assert.equal(harness.published.length, 0);
    assert.ok(harness.errors[0] instanceof TypeError, "第三种返回形态按类型错误报告");
  });
});
