/** 会话编辑台账的投影：从事件累加状态与从历史重建共用 `toolEventRowsOf`，两边不会各写一套。 */
import { z } from "zod";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { SessionEvent, ToolResultRecord } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import {
  editPathOf,
  editPathsOf,
  toolEventRowsOf,
} from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import { EDIT_TOOLS } from "./accumulator.ts";

export const EDIT_LEDGER_KEY = "quality-gate.edit-ledger";

/** 台账上限：超过即丢最旧的（门禁游标每回合推到末端；防的是从没跑成门禁的长会话）。 */
export const EDIT_LEDGER_MAX = 1024;

/**
 * 一条编辑调用在台账里的最终状态。只有 `ok` 与 `aborted` 会进回合门禁：
 *  - `ok`：结果成功，文件一定按调用改了；
 *  - `aborted`：工具体**已经派发过**才被取消（官方 `ABORTED`），写可能已经落盘——
 *    门禁必须核验，宁可多跑一次也不能漏掉半截补丁；
 *  - `rejected`：审批类拒绝与"派发前取消"（官方 `APPROVAL_*` / `ABORTED_BEFORE_DISPATCH`），
 *    工具体根本没执行，文件一定没变；
 *  - `failed`：其余失败（没有身份、守卫拒绝、工具体自己抛错）——沿用旧行为排除：
 *    这些工具要么没写，要么写入不是原子语义可推断的，旧行为是不核验，保持一致。
 */
export type EditOutcome = "ok" | "rejected" | "aborted" | "failed";

/** 审批类错误码（官方 `dsh-tools` 的持久化契约字符串，见其 error-codes 模块）。 */
const APPROVAL_CODES: ReadonlySet<string> = new Set([
  "APPROVAL_REJECTED",
  "APPROVAL_CANCELLED",
  "APPROVAL_UNAVAILABLE",
]);

/** 官方取消码：`ABORTED` 表示工具体已派发（可能已写），`ABORTED_BEFORE_DISPATCH` 表示没执行。 */
const ABORTED_AFTER_DISPATCH = "ABORTED";
const ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";

/**
 * 把一条结算记录归到编辑语义上。失败身份缺失（旧宿主、普通工具错误）按 `failed` 处理，
 * 与旧行为一致；只有官方 rc.2 明确给出的身份才会改变"是否核验"这个判断。
 * `AbortError` 名字是取消码之外的保守兜底：名字已经说明是取消，按"可能已写"核验。
 * @param result - 一条 tool/result 或 PTC dispatch 结算
 * @returns 该次编辑调用最终落在台账里的状态
 */
export function editOutcomeOf(result: ToolResultRecord): EditOutcome {
  if (!result.isError) {
    return "ok";
  }
  const info = result.error;
  if (info === undefined) {
    return "failed";
  }
  if (APPROVAL_CODES.has(info.code) || info.code === ABORTED_BEFORE_DISPATCH) {
    return "rejected";
  }
  if (info.code === ABORTED_AFTER_DISPATCH || info.name === "AbortError") {
    return "aborted";
  }
  return "failed";
}

/** 这条台账记录要不要进回合门禁（见 {@link EditOutcome} 的分档理由）。 */
export function countsAsEdit(outcome: EditOutcome): boolean {
  return outcome === "ok" || outcome === "aborted";
}

/** 一条编辑记录。`callId` 与 `path` 用空串表示"没有"，状态里不设可选字段。 */
export interface EditLedgerEntry {
  readonly seq: number;
  readonly callId: string;
  readonly name: string;
  readonly path: string;
  readonly outcome: EditOutcome;
}

export interface EditLedgerState {
  readonly edits: readonly EditLedgerEntry[];
}

const entrySchema = z.object({
  seq: z.int().nonnegative(),
  callId: z.string(),
  name: z.string(),
  path: z.string(),
  outcome: z.enum(["ok", "rejected", "aborted", "failed"]),
});

/** 宿主投影包自带一份 zod（4.4.3），与本包 catalog 里的 4.6.7 在 `exactOptionalPropertyTypes`
 *  下不是同一个 `ZodType` 类型；本包只把 schema 交给宿主调用 `safeParse`，运行期形状一致，
 *  所以按宿主声明的 `stateSchema` 类型做一次受限的类型转换。 */
type LedgerStateSchema = ProjectionDefinition<
  typeof EDIT_LEDGER_KEY,
  EditLedgerState
>["stateSchema"];
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 两份 zod 只是类型来源不同：宿主只对这份 schema 调用 safeParse，运行期形状由本包的测试钉住。
const editLedgerSchema = z.object({
  edits: z.array(entrySchema),
}) as unknown as LedgerStateSchema;

/** 把同一 callId 的记录落成结算状态。普通编辑器沿用"只标最近一条"的既有行为；`apply_patch`
 *  一次调用可以产生多条记录，只标最后一条会让其余路径在失败之后仍然算成功编辑，所以全部标上。 */
function settleEntry(
  state: readonly EditLedgerEntry[],
  callId: string,
  outcome: EditOutcome,
): readonly EditLedgerEntry[] {
  const matches: number[] = [];
  for (let at = 0; at < state.length; at += 1) {
    if (state[at]?.callId === callId) {
      matches.push(at);
    }
  }
  if (matches.length === 0) {
    return state;
  }
  const markAll = matches.some((at) => state[at]?.name === "apply_patch");
  const selected = markAll ? matches : matches.slice(-1);
  // 已经落成同一状态时原样返回：同一条 result 被重复交回来，不该每次都产生新的状态对象。
  if (selected.every((at) => state[at]?.outcome === outcome)) {
    return state;
  }
  return state.map((entry, at) => (selected.includes(at) ? { ...entry, outcome } : entry));
}

export const editLedgerProjection = {
  key: EDIT_LEDGER_KEY,
  // 字段与折叠语义变化时递增（`failed: boolean` → `outcome` 分档）；版本对不上的历史数据由官方 restore 丢弃。
  stateVersion: 2,
  stateSchema: editLedgerSchema,
  init: (): EditLedgerState => ({ edits: [] }),
  apply: (state: EditLedgerState, event: SessionEvent): EditLedgerState => {
    const { call, result } = toolEventRowsOf(event, event.seq);
    let { edits } = state;
    if (call !== undefined && EDIT_TOOLS.has(call.name) && !call.badArguments) {
      let targets: readonly string[];
      if (call.name === "apply_patch") {
        targets = editPathsOf(call);
      } else {
        const target = editPathOf(call);
        targets = target.kind === "write" ? [target.path ?? ""] : [];
      }
      const additions = targets.map((filePath) => ({
        seq: call.seq,
        callId: call.callId ?? "",
        name: call.name,
        path: filePath,
        outcome: "ok" as const,
      }));
      edits = [...edits, ...additions];
    }
    if (result !== undefined && result.callId !== undefined && result.callId !== "") {
      edits = settleEntry(edits, result.callId, editOutcomeOf(result));
    }
    const bounded =
      edits.length > EDIT_LEDGER_MAX ? edits.slice(edits.length - EDIT_LEDGER_MAX) : edits;
    return bounded === state.edits ? state : { edits: bounded };
  },
} satisfies ProjectionDefinition<typeof EDIT_LEDGER_KEY, EditLedgerState>;
