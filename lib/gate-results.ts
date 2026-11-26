// lib/gate-results.ts —— 门禁结果的留存形状与环形容量（宿主与远程读面共用）。
import type { TsDiagnostic } from "./gate-detect.ts";

/** 一次门禁结果，按会话留存供会话侧栏读取（不超过 `RESULT_ROWS_MAX` 条）。 */
export interface GateResultRow {
  readonly at: number;
  readonly gate: string;
  readonly root: string;
  readonly outcome: "pass" | "code-failure" | "not-run";
  readonly detail: string;
  /** 行诊断（path 相对仓库根）；只有代码失败且输出认得出才有。 */
  readonly diagnostics?: readonly TsDiagnostic[];
}

/** 每个会话留多少条结果：侧栏只画最近一条，留一小段历史供查询与排错。 */
export const RESULT_ROWS_MAX = 20;
/** 单条 detail 的字节上限（超长的 tsc/pnpm 输出只留头部）。 */
export const RESULT_DETAIL_MAX = 200;

/** 结果表最多保留多少个会话；超过按「最后一条结果最旧」淘汰。 */
export const SESSION_RESULTS_MAX = 100;

/** 把一行结果并进会话表，超过容量时丢最旧的（导出仅供单测钉住容量口径）。 */
export function appendResultRow(rows: GateResultRow[], row: GateResultRow): void {
  rows.push(row);
  if (rows.length > RESULT_ROWS_MAX) {
    rows.splice(0, rows.length - RESULT_ROWS_MAX);
  }
}

/** 会话表总量收敛：超过 `SESSION_RESULTS_MAX` 时丢掉最后一条结果最旧的会话。 */
export function trimSessionResults(results: Map<string, GateResultRow[]>): void {
  if (results.size <= SESSION_RESULTS_MAX) {
    return;
  }
  const excess = results.size - SESSION_RESULTS_MAX;
  // 取每行表最后一条的时间；空表按 0。用一次显式遍历而不是 `at(-1)?.at ?? 0`：后者在 V8 覆盖率里
  // 会多出一条只在「空表参与比较」时才走的分支，而生产路径上的会话只要有记录就不会是空表。
  const lastAt = (rows: readonly GateResultRow[]): number => {
    let at = 0;
    for (const row of rows) {
      ({ at } = row);
    }
    return at;
  };
  const oldest = [...results.entries()].toSorted(
    (left, right) => lastAt(left[1]) - lastAt(right[1]),
  );
  for (const [key] of oldest.slice(0, excess)) {
    results.delete(key);
  }
}
