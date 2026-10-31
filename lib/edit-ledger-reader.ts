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

/** 读一次 stateOf 并按台账形状收口：抛错与形状不合都交回 undefined（fail-closed）。 */
function readAsLedger(stateOf: () => unknown): readonly EditLedgerEntry[] | undefined {
  try {
    return asLedger(stateOf());
  } catch {
    // 读不出来与形状不合约定的持久行同档；这里不把异常升级成调用方的失败。
    return asLedger(null);
  }
}

export interface LedgerReadFace {
  readonly publish: (reader: EditLedgerReader | undefined) => void;
  readonly effect: (factory: () => () => void) => unknown;
  readonly onError: (error: unknown) => void;
}

/**
 * 注册投影并发布读口；失败（同步抛错或异步拒绝）只报告、不发布。
 *
 * 发布与登记也在这段 try 里：注册成功后投影已经挂在注册表上，只要 publish/effect 任一抛错
 * 而不释放，投影就永久泄漏（若是 effect 抛错，读口还会被发布出去却没有任何清理路径）。
 * 因此失败路径统一「先撤读口、再释放投影、最后报告」，报告的是最初那个错误。
 *
 * @param registry - 官方 sessionProjections 服务
 * @param face - 读口发布位与释放登记位
 */
export async function mountEditLedgerReader(
  registry: ProjectionsRegistry,
  face: LedgerReadFace,
): Promise<void> {
  let read: EditLedgerReader | undefined;
  let release: (() => void) | undefined;
  let published = false;
  try {
    const ready: unknown = await registry.register(editLedgerProjection);
    if (isDisposer(ready)) {
      read = (session) => readAsLedger(() => registry.stateOf(session, EDIT_LEDGER_KEY));
      release = ready;
    } else if (isProjectionHandle(ready)) {
      read = (session) => readAsLedger(() => ready.stateOf(session));
      // dispose 可能返回 Promise；丢弃它会让拒绝变成未处理 rejection，释放失败也无人可见。
      release = () => {
        void (async (): Promise<void> => {
          try {
            await ready.dispose();
          } catch (error: unknown) {
            face.onError(error);
          }
        })();
      };
    } else {
      throw new TypeError("sessionProjections.register returned neither a disposer nor a handle");
    }
    face.publish(read);
    published = true;
    let released = false;
    face.effect(() => () => {
      // 清理可能被宿主重复调用（重复 unmount / 重放清理）：二次 dispose 同一句柄会抛错。
      if (released) {
        return;
      }
      released = true;
      try {
        face.publish(undefined);
      } finally {
        release?.();
      }
    });
  } catch (error) {
    // 只撤"已经发布出去"的读口；还停在注册阶段时没有读口可撤，也不该凭空发一次
    // publish(undefined)（"失败不发布"是本模块对外的契约）。
    if (published) {
      // 撤读口本身也可能抛；那不该盖掉根因（原始 error 才是要报告的那一条）。
      try {
        face.publish(undefined);
      } catch {
        void 0;
      }
    }
    release?.();
    // 上报失败不得让挂载以 rejection 结束（宿主侧是 void 调用，没有 catch）。
    try {
      face.onError(error);
    } catch {
      // onError 自己抛错时保持"只报告、不发布"的契约。
    }
  }
}
