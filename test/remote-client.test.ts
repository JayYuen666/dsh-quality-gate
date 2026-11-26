// test/remote-client.test.ts —— 客户端读取面（src/remote.ts）的契约。
//
// 跨进程边界没有类型保证：坏应答、坏行、坏诊断都要在这里被丢掉或转成明确错误，
// 而不是画到面板上。读取器本身只依赖 `$mount` 与 `ctx.get`，用最小替身即可覆盖。
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { QUALITY_GATE_DESCRIPTORS, createQualityGateReader } from "../src/remote.ts";
import type { GateResultRow, QualityGateReader } from "../src/remote.ts";

const ok = (value: unknown): { ok: true; value: unknown } => ({ ok: true, value });

interface FakeCtx {
  get: (name: string) => unknown;
}

function makeCtx(options: {
  readonly remote?: unknown;
  readonly namespace?: unknown;
  readonly throwOnGet?: boolean;
}): FakeCtx {
  return {
    get: (name: string) => {
      if (options.throwOnGet === true) {
        throw new Error("服务表不可读");
      }
      if (name === "remote") {
        return options.remote;
      }
      return name === "remote.qualityGate" ? options.namespace : undefined;
    },
  };
}

function readerWith(
  namespace: unknown,
  mount: () => Promise<unknown> = async () => 1,
  withRun = true,
): QualityGateReader {
  const patched =
    withRun && typeof namespace === "object" && namespace !== null
      ? { run: async () => ok({ status: "done" }), ...namespace }
      : namespace;
  const ctx = makeCtx({ remote: { $mount: mount }, namespace: patched });
  const reader = createQualityGateReader(ctx);
  assert.ok(reader !== undefined, "有 remote 通道时必须给出读取器");
  return reader;
}

const validRow: GateResultRow = {
  at: 7,
  gate: "tsc",
  root: "/p",
  outcome: "code-failure",
  detail: "exit=1",
  diagnostics: [{ path: "src/a.ts", line: 3, message: "boom" }],
};

describe("客户端远程读取器", () => {
  it("descriptor 覆盖 latest/run/state，请求 codec 拒绝非对象与缺 sessionId", () => {
    assert.deepEqual(
      QUALITY_GATE_DESCRIPTORS.map((item) => item.method),
      ["latest", "run", "state"],
    );
    const run = QUALITY_GATE_DESCRIPTORS.find((item) => item.method === "run");
    assert.ok(run !== undefined);
    const parameter = run.parameters.find((item) => item.name === "request");
    assert.ok(parameter !== undefined && "codec" in parameter);
    const { codec } = parameter;
    if (codec.mode !== "strict") {
      assert.fail("run 的请求参数必须是 strict codec");
    }
    const request = codec.create();
    assert.deepEqual(request.parse({ sessionId: "s" }), { sessionId: "s" });
    assert.throws(() => request.parse({}), TypeError);
    assert.throws(() => request.parse("s"), TypeError);
  });

  it("没有 remote 通道或读取抛错时返回 undefined", () => {
    assert.equal(createQualityGateReader(makeCtx({})), undefined);
    assert.equal(createQualityGateReader(makeCtx({ throwOnGet: true })), undefined);
    assert.equal(createQualityGateReader(makeCtx({ remote: {} })), undefined);
  });

  it("宿主少挂一个方法就不算命名空间；run 缺失也不能只校验两个读方法", async () => {
    const reader = readerWith(
      { latest: async () => ok({}), state: async () => ok({ rows: [] }) },
      async () => 1,
      false,
    );
    await assert.rejects(reader.run("s"), /未提供/u);
  });

  it("mount 失败会清掉缓存，下一次可重试", async () => {
    let attempts = 0;
    const namespace = { latest: async () => ok({}), state: async () => ok({ rows: [] }) };
    const reader = readerWith(namespace, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("gateway down");
      }
    });
    await assert.rejects(reader.state("s"), /gateway down/u);
    assert.deepEqual(await reader.state("s"), { sessionId: "s", rows: [] });
    assert.equal(attempts, 2);
  });

  it("latest 只认带 row 的 ok 应答，坏行交 undefined", async () => {
    const reader = readerWith({
      latest: async () => ok({ row: { ...validRow, outcome: "weird" } }),
      state: async () => ok({ rows: [] }),
    });
    assert.equal(await reader.latest(), undefined);
    const good = readerWith({
      latest: async () => ok({ row: validRow }),
      state: async () => ok({ rows: [] }),
    });
    assert.deepEqual(await good.latest(), validRow);
    const empty = readerWith({
      latest: async () => ok({}),
      state: async () => ok({ rows: [] }),
    });
    assert.equal(await empty.latest(), undefined);
    const notRecord = readerWith({
      latest: async () => ok([]),
      state: async () => ok({ rows: [] }),
    });
    assert.equal(await notRecord.latest(), undefined);
  });

  it("state 丢掉坏行与坏诊断，保留可用诊断", async () => {
    const reader = readerWith({
      latest: async () => ok({}),
      state: async () =>
        ok({
          rows: [
            validRow,
            { at: 8, gate: "tsc", root: "/p", outcome: "pass", detail: "ok" },
            null,
            { ...validRow, at: "x" },
            { ...validRow, diagnostics: ["bad", { path: "a", line: "x", message: 1 }] },
          ],
        }),
    });
    const state = await reader.state("s");
    assert.equal(state.sessionId, "s");
    assert.equal(state.rows.length, 3);
    assert.deepEqual(state.rows[0]?.diagnostics, validRow.diagnostics);
    assert.equal(state.rows[1]?.diagnostics, undefined, "无诊断字段时省略");
    assert.equal(state.rows[2]?.diagnostics, undefined, "全坏时省略诊断字段");
  });

  it("state 的应答不是对象时交空表", async () => {
    const reader = readerWith({
      latest: async () => ok({}),
      state: async () => ok("nope"),
    });
    assert.deepEqual(await reader.state("s"), { sessionId: "s", rows: [] });
  });

  it("run 返回非字符串状态词时归一成 unknown", async () => {
    const reader = readerWith({
      latest: async () => ok({}),
      state: async () => ok({ rows: [] }),
      run: async () => ok({ status: 7 }),
    });
    assert.equal(await reader.run("s"), "unknown");
    const missing = readerWith({
      latest: async () => ok({}),
      state: async () => ok({ rows: [] }),
      run: async () => ok(null),
    });
    assert.equal(await missing.run("s"), "unknown", "非对象应答同样归一成 unknown");
    const done = readerWith({
      latest: async () => ok({}),
      state: async () => ok({ rows: [] }),
      run: async () => ok({ status: "done" }),
    });
    assert.equal(await done.run("s"), "done");
  });

  it("unwrap 对四种坏应答给出明确错误", async () => {
    const cases: readonly unknown[] = [
      null,
      { ok: "yes" },
      { ok: false, error: {} },
      { ok: false, error: { code: "X", message: "y" } },
      { ok: true },
    ];
    await Promise.all(
      cases.map(async (raw, index) => {
        const reader = readerWith({
          latest: async () => ok({}),
          state: async () => raw,
        });
        await assert.rejects(reader.state("s"), (error: unknown): boolean => {
          if (index === 3) {
            return String(error) === "Error: X: y";
          }
          return error instanceof TypeError;
        });
      }),
    );
  });
});
