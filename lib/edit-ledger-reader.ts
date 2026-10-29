/**
 * `sessionProjections` 双协议读口：一侧同步交回 disposer，另一侧 `await` 后是 handle。
 * 判别必须在 await 之后——两版的原始返回值都是带 `.then` 的函数。
 */
import type { EditLedgerEntry } from "./edit-ledger.ts";
import { EDIT_LEDGER_KEY, editLedgerProjection } from "./edit-ledger.ts";

/** 官方注册表面（结构投影）。 */
export interface ProjectionsRegistry {
  register: (definition: typeof editLedgerProjection) => unknown;
  stateOf: (session: unknown, key: typeof EDIT_LEDGER_KEY) => unknown;
}

/** 读口：会话 → 可信台账（形状校验不过交回 undefined）。 */
export type EditLedgerReader = (session: unknown) => readonly EditLedgerEntry[] | undefined;

interface ProjectionHandle {
  readonly stateOf: (session: unknown) => unknown;
  readonly dispose: () => Promise<void> | undefined;
}

const isDisposer = (value: unknown): value is () => void => typeof value === "function";

const isProjectionHandle = (value: unknown): value is ProjectionHandle =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { stateOf?: unknown }).stateOf === "function" &&
  typeof (value as { dispose?: unknown }).dispose === "function";

/** 把原始状态校验成台账：形状不合约定的持久行按「不可读」处理。 */
function asLedger(raw: unknown): readonly EditLedgerEntry[] | undefined {
  const parsed = editLedgerProjection.stateSchema.safeParse(raw);
  return parsed.success ? parsed.data.edits : undefined;
}

export interface LedgerReadFace {
  readonly publish: (reader: EditLedgerReader | undefined) => void;
  readonly effect: (factory: () => () => void) => unknown;
  readonly onError: (error: unknown) => void;
}

/**
 * 注册投影并发布读口；失败（同步抛错或异步拒绝）只报告、不发布。
 * @param registry - 官方 sessionProjections 服务
 * @param face - 读口发布位与释放登记位
 */
export async function mountEditLedgerReader(
  registry: ProjectionsRegistry,
  face: LedgerReadFace,
): Promise<void> {
  let read: EditLedgerReader;
  let release: () => void;
  try {
    const ready: unknown = await registry.register(editLedgerProjection);
    if (isDisposer(ready)) {
      read = (session) => asLedger(registry.stateOf(session, EDIT_LEDGER_KEY));
      release = ready;
    } else if (isProjectionHandle(ready)) {
      read = (session) => asLedger(ready.stateOf(session));
      release = () => {
        void ready.dispose();
      };
    } else {
      throw new TypeError("sessionProjections.register returned neither a disposer nor a handle");
    }
  } catch (error) {
    face.onError(error);
    return;
  }
  face.publish(read);
  face.effect(() => () => {
    face.publish(undefined);
    release();
  });
}
