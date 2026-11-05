/** 会话编辑台账投影：折叠与回退扫描共用 `toolEventRowsOf`，两处不会各自演化。 */
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

/** 一条编辑记录。`callId`/`path` 用空串表示「没有」，状态里不留可选位。 */
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

/** 宿主投影包自带一份 zod（4.4.3），与本包 catalog 的 4.6.7 在 `exactOptionalPropertyTypes`
 *  下不是同一枚 `ZodType` 类型；本包只把 schema 交给宿主调用 `safeParse`，运行期形状一致，
 *  故经宿主声明的 `stateSchema` 类型做一次窄桥接。 */
type LedgerStateSchema = ProjectionDefinition<
  typeof EDIT_LEDGER_KEY,
  EditLedgerState
>["stateSchema"];
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 两份 zod 仅类型身份不同：宿主只对这份 schema 调 safeParse，运行期形状由本包测试钉住。
const editLedgerSchema = z.object({
  edits: z.array(entrySchema),
}) as unknown as LedgerStateSchema;

/** 同 callId 的失败回填。普通编辑器沿用“只否定最近一条”的既有语义；`apply_patch`
 *  一条调用可产生多行，只否定最后一行会让其余路径在失败后仍被当成成功编辑，故全部否定。 */
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
  // 已标记失败时原样返回：重复投递同一 result 不该持续产生新状态对象。
  if (selected.every((at) => state[at]?.failed === true)) {
    return state;
  }
  return state.map((entry, at) => (selected.includes(at) ? { ...entry, failed: true } : entry));
}

export const editLedgerProjection = {
  key: EDIT_LEDGER_KEY,
  // 字段变了才递增；版本对不上的持久行由官方 restore 丢弃。
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
