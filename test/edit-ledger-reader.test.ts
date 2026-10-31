// `sessionProjections` 双协议读口：判别只能在 await 之后（两版原始返回值都带 .then），
// 且失败路径不得发布失效读口——门禁读到一个空读口会把「没有证据」当成「没有编辑」。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { EDIT_LEDGER_KEY } from "../lib/edit-ledger.ts";
import { mountEditLedgerReader } from "../lib/edit-ledger-reader.ts";
import type { EditLedgerReader, ProjectionsRegistry } from "../lib/edit-ledger-reader.ts";

const SESSION = { id: "s1" };

/** 无效的注册表读口（这些用例只关心注册结果，不读状态）。 */
const NO_STATE = undefined;

/** 旧版的释放器：本文件只断言它被调用，不做任何事。 */
function release(): void {
  void 0;
}

const VALID_STATE = {
  edits: [{ seq: 1, callId: "c1", name: "edit", path: "/w/a.ts", failed: false }],
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

describe("编辑台账读口（双协议）", () => {
  it("旧版：await 得到 disposer，读口经注册表 stateOf 取值", async () => {
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
    assert.equal(typeof harness.published.at(-1), "function", "旧版发布同步读口");
    assert.deepEqual(harness.published.at(-1)?.(SESSION), VALID_STATE.edits);
    assert.equal(harness.disposers.length, 1, "登记一枚释放器");
    harness.disposers[0]?.();
    assert.equal(harness.published.at(-1), undefined, "卸载先撤读口");
  });

  it("register 交回 Promise<disposer>：判别发生在 await 之后", async () => {
    // 旧协议原始返回值是函数（新协议是 handle），而两种都可能被包在 thenable 里；
    // 这里用 Promise<disposer>：await 之前拿到的是 Promise，await 之后才是函数——
    // 实现若在 await 之前按 typeof 判别，就会把它当成 handle 或直接判坏形状。
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
      "Promise<disposer> await 后仍按 disposer 处理",
    );
    assert.deepEqual(
      harness.published.at(-1)?.(SESSION),
      VALID_STATE.edits,
      "读口仍走注册表 stateOf",
    );
    harness.disposers[0]?.();
    assert.equal(releaseCalls, 1, "释放器就是 await 落地后的那个函数");
  });

  it("新版：await 得到 handle，读口经 handle.stateOf 取值，释放走 dispose", async () => {
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
        throw new Error("新版不应走注册表 stateOf");
      },
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    assert.equal(typeof harness.published.at(-1), "function", "新版也要发布读口");
    assert.deepEqual(harness.published.at(-1)?.(SESSION), VALID_STATE.edits);
    harness.disposers[0]?.();
    // dispose 返回 Promise：等它落定再断言，避免用例与实现的微任务时序耦合。
    await Promise.resolve();
    assert.equal(disposed, 1, "卸载释放 handle");
    assert.equal(harness.published.at(-1), undefined);
  });

  it("坏形状的状态按不可读处理（读口交回 undefined，由调用方回退扫描）", async () => {
    const registry: ProjectionsRegistry = {
      register: () => (): void => {
        void 0;
      },
      stateOf: () => ({ edits: "not-an-array" }),
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    // 先钉住读口确实发布了：只断言取值会让「根本没发布」也返回 undefined，用例自证。
    assert.equal(typeof harness.published.at(-1), "function", "坏形状也要发布读口");
    assert.equal(harness.published.at(-1)?.(SESSION), undefined);
  });

  it("持久行元素不合 schema（seq 为负）同样按不可读处理", async () => {
    const registry: ProjectionsRegistry = {
      register: () => (): void => {
        void 0;
      },
      stateOf: () => ({
        edits: [{ seq: -1, callId: "c1", name: "edit", path: "/w/a.ts", failed: false }],
      }),
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    assert.equal(harness.published.at(-1)?.(SESSION), undefined, "单行不合约束即整份不可读");
  });

  it("同步抛错与异步拒绝都只报告、不发布", async () => {
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
    assert.equal(thrown.published.length, 0, "同步抛错不发布");
    assert.equal(thrown.disposers.length, 0, "注册都没成功，不得登记释放器");
    assert.match(String(thrown.errors[0]), /sync boom/u);

    const rejected = makeFace();
    await mountEditLedgerReader(
      {
        register: () => Promise.reject(new Error("async boom")),
        stateOf: () => NO_STATE,
      },
      rejected.face,
    );
    assert.equal(rejected.published.length, 0, "异步拒绝不发布");
    assert.equal(rejected.disposers.length, 0, "异步拒绝同样不得登记释放器");
    assert.match(String(rejected.errors[0]), /async boom/u);
  });

  it("注册成功后 effect 抛错 ⇒ 撤读口 + 释放投影 + 报告（不泄漏投影）", async () => {
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
    assert.equal(released, 1, "注册成功了就必须释放，否则投影永久挂在注册表上");
    assert.equal(published.at(-1), undefined, "已发布的读口必须撤回（没有清理路径的读口不能留着）");
    assert.match(String(errors[0]), /effect boom/u, "报告的是最初那个错误");
  });

  it("publish 抛错 ⇒ 释放投影 + 报告（不把已注册的投影留在注册表里）", async () => {
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

  it("撤读口本身抛错时不盖掉根因（报告最初那个错误 + 仍释放投影）", async () => {
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
    assert.equal(released, 1, "撤读口失败也要释放投影");
    assert.match(String(errors[0]), /effect boom/u, "撤读口失败不许盖掉根因");
  });

  it("stateOf 抛错按不可读处理：读口交回 undefined，不把异常升级给调用方", async () => {
    const registry: ProjectionsRegistry = {
      register: () => release,
      stateOf: () => {
        throw new Error("registry stateOf boom");
      },
    };
    const harness = makeFace();
    await mountEditLedgerReader(registry, harness.face);
    assert.equal(typeof harness.published.at(-1), "function", "stateOf 抛错不影响读口发布");
    assert.equal(harness.published.at(-1)?.(SESSION), undefined);
  });

  it("handle.dispose 拒绝 → 走 onError，不产生未处理 rejection", async () => {
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
    // dispose 是异步的：让它的 rejection 落到 onError。
    await Promise.resolve();
    await Promise.resolve();
    assert.match(String(harness.errors.at(-1)), /dispose boom/u);
  });

  it("清理重复调用只释放一次（宿主重放清理不得二次 dispose）", async () => {
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
    assert.equal(disposed, 1, "重复清理只释放一次");
  });

  it("既非 disposer 也非 handle ⇒ TypeError 走报告面", async () => {
    const harness = makeFace();
    await mountEditLedgerReader(
      { register: () => Promise.resolve({}), stateOf: () => NO_STATE },
      harness.face,
    );
    assert.equal(harness.published.length, 0);
    assert.ok(harness.errors[0] instanceof TypeError, "第三种形状按类型错报告");
  });
});
