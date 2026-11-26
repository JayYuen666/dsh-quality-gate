// test/remote.test.ts —— 会话侧栏读面的宿主侧形状。
//
// 覆盖三件事：结果行按会话查询、跨会话取最新一条、容量按 20 条截断。
// 用真实的 cordis Context 构造官方 Service（替身的 ctx 没有 root/reflect，构造会抛）。
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { QUALITY_GATE_NAMESPACE, QualityGateRemoteService } from "../host.ts";
import { appendResultRow, SESSION_RESULTS_MAX, trimSessionResults } from "../lib/gate-results.ts";
import type { GateResultRow } from "../lib/gate-results.ts";

/** 读面只用到 rt.recentResults：构造参数按官方签名取型，替身只补这一位。 */
type RuntimeOf = ConstructorParameters<typeof QualityGateRemoteService>[1];

/** 造一行结果（时间可指定，便于比较"最新"）。 */
function row(at: number, session: string): GateResultRow {
  return { at, gate: "pnpm run check", root: `/p/${session}`, outcome: "pass", detail: "ok" };
}

describe("会话侧栏读面", () => {
  it("按 sessionId 交出该会话的行；缺失或形状不对时交空表", () => {
    const results = new Map<string, GateResultRow[]>([["s-a", [row(1, "a")]]]);
    const service = new QualityGateRemoteService(new Context(), {
      recentResults: results,
    } as unknown as RuntimeOf);
    assert.deepEqual(service.state({ sessionId: "s-a" }).rows, [row(1, "a")]);
    assert.deepEqual(service.state({ sessionId: "s-missing" }).rows, []);
    assert.deepEqual(service.state(undefined).rows, []);
    assert.deepEqual(service.state({ sessionId: 7 }).rows, []);
    assert.equal(QUALITY_GATE_NAMESPACE, "qualityGate");
  });

  it("latest 跨会话取时间最大的一条；空表交 undefined", () => {
    const rowsA = [row(5, "a")];
    const rowsB: GateResultRow[] = [row(9, "b"), row(3, "b")];
    const results = new Map<string, GateResultRow[]>([
      ["a", rowsA],
      ["b", rowsB],
      ["c", []],
    ]);
    const service = new QualityGateRemoteService(new Context(), {
      recentResults: results,
    } as unknown as RuntimeOf);
    assert.equal(service.latest().row, rowsA[0], "仍取全局最新（b 的最后一行时间更早）");
    const empty = new QualityGateRemoteService(new Context(), {
      recentResults: new Map(),
    } as unknown as RuntimeOf);
    assert.equal(empty.latest().row, undefined);
  });

  it("会话表总量收敛：超过上限时淘汰最后一条结果最旧的会话", () => {
    const results = new Map<string, GateResultRow[]>();
    for (let index = 0; index <= SESSION_RESULTS_MAX; index += 1) {
      results.set(
        `s-${index}`,
        index === SESSION_RESULTS_MAX ? [] : [row(index + 1, `s-${index}`)],
      );
    }
    trimSessionResults(results);
    assert.equal(results.size, SESSION_RESULTS_MAX);
    assert.equal(results.has(`s-${SESSION_RESULTS_MAX}`), false, "空表会话按 0 排最旧");
    assert.equal(results.has("s-0"), true, "有结果的最旧会话仍应留下");
    trimSessionResults(results);
    assert.equal(results.size, SESSION_RESULTS_MAX, "未超上限时不动");
  });

  it("容量 20 条：第 21 条挤掉最旧一条", () => {
    const rows: GateResultRow[] = [];
    for (let index = 0; index < 25; index += 1) {
      appendResultRow(rows, row(index, "a"));
    }
    assert.equal(rows.length, 20);
    assert.equal(rows[0]?.at, 5);
    assert.equal(rows.at(-1)?.at, 24);
  });
});
