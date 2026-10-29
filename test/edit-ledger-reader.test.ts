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
    assert.deepEqual(harness.published.at(-1)?.(SESSION), VALID_STATE.edits);
    harness.disposers[0]?.();
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
    assert.equal(harness.published.at(-1)?.(SESSION), undefined);
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
    assert.match(String(rejected.errors[0]), /async boom/u);
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
