/** 会话编辑台账的投影：从事件累加状态与从历史重建共用 `toolEventRowsOf`，两边不会各写一套。 */
import { z } from "zod";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import {
  editPathOf,
  editPathsOf,
  toolEventRowsOf,
} from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import { EDIT_TOOLS } from "./accumulator.ts";

export const EDIT_LEDGER_KEY = "quality-gate.edit-ledger";

/** 台账上限：超过即丢最旧的（门禁游标每回合推到末端；防的是从没跑成门禁的长会话）。 */
export const EDIT_LEDGER_MAX = 1024;

/** 一条编辑记录。`callId` 与 `path` 用空串表示"没有"，状态里不设可选字段。 */
export interface EditLedgerEntry {
  readonly seq: number;
  readonly callId: string;
  readonly name: string;
  readonly path: string;
  readonly failed: boolean;
}

export interface EditLedgerState {
  readonly edits: readonly EditLedgerEntry[];
}

const entrySchema = z.object({
  seq: z.int().nonnegative(),
  callId: z.string(),
  name: z.string(),
  path: z.string(),
  failed: z.boolean(),
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

/** 把同一 callId 的记录标为失败。普通编辑器沿用"只标最近一条"的既有行为；`apply_patch`
 *  一次调用可以产生多条记录，只标最后一条会让其余路径在失败之后仍然算成功编辑，所以全部标上。 */
function failEntry(state: readonly EditLedgerEntry[], callId: string): readonly EditLedgerEntry[] {
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
  // 已经标为失败时原样返回：同一条 result 被重复交回来，不该每次都产生新的状态对象。
  if (selected.every((at) => state[at]?.failed === true)) {
    return state;
  }
  return state.map((entry, at) => (selected.includes(at) ? { ...entry, failed: true } : entry));
}

export const editLedgerProjection = {
  key: EDIT_LEDGER_KEY,
  // 字段变化时才递增；版本对不上的历史数据由官方 restore 丢弃。
  stateVersion: 1,
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
        failed: false,
      }));
      edits = [...edits, ...additions];
    }
    if (
      result !== undefined &&
      result.isError &&
      result.callId !== undefined &&
      result.callId !== ""
    ) {
      edits = failEntry(edits, result.callId);
    }
    const bounded =
      edits.length > EDIT_LEDGER_MAX ? edits.slice(edits.length - EDIT_LEDGER_MAX) : edits;
    return bounded === state.edits ? state : { edits: bounded };
  },
} satisfies ProjectionDefinition<typeof EDIT_LEDGER_KEY, EditLedgerState>;
