/** 会话编辑台账投影：折叠与回退扫描共用 `toolEventRowsOf`，两处不会各自演化。 */
import { z } from "zod";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import { editPathOf, toolEventRowsOf } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
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

const entrySchema = z.strictObject({
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

/** 把最近一条同 callId 的记录标记为失败（tool/result 的 isError）；找不到就不动。 */
function failEntry(state: readonly EditLedgerEntry[], callId: string): readonly EditLedgerEntry[] {
  let index = -1;
  for (let at = state.length - 1; at >= 0; at -= 1) {
    if (state[at]?.callId === callId) {
      index = at;
      break;
    }
  }
  const next =
    index < 0
      ? state
      : state.map((entry, at) => (at === index ? { ...entry, failed: true } : entry));
  return next;
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
      const target = editPathOf(call);
      if (target.kind === "write") {
        edits = [
          ...edits,
          {
            seq: call.seq,
            callId: call.callId ?? "",
            name: call.name,
            path: target.path ?? "",
            failed: false,
          },
        ];
      }
    }
    if (result !== undefined && result.isError && result.callId !== undefined) {
      edits = failEntry(edits, result.callId);
    }
    const bounded =
      edits.length > EDIT_LEDGER_MAX ? edits.slice(edits.length - EDIT_LEDGER_MAX) : edits;
    return bounded === state.edits ? state : { edits: bounded };
  },
} satisfies ProjectionDefinition<typeof EDIT_LEDGER_KEY, EditLedgerState>;
