/**
 * `sessionProjections` 的两种返回形态：一种同步给出释放函数，另一种 `await` 之后是句柄。
 * 区分这两种形态必须放在 await 之后——两版的原始返回值都是带 `.then` 的函数。
 */
import type { EditLedgerEntry } from "./edit-ledger.ts";
import { EDIT_LEDGER_KEY, editLedgerProjection } from "./edit-ledger.ts";

/** 官方注册表用到的两个方法（这里只声明用到的这部分）。 */
export interface ProjectionsRegistry {
  register: (definition: typeof editLedgerProjection) => unknown;
  stateOf: (session: unknown, key: typeof EDIT_LEDGER_KEY) => unknown;
}

/** 读取函数：给会话，返回校验过的编辑台账；形状校验不过返回 undefined。 */
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

/** 把原始状态校验成编辑台账：不符合约定形状的历史数据按读不到处理。 */
function asLedger(raw: unknown): readonly EditLedgerEntry[] | undefined {
  const parsed = editLedgerProjection.stateSchema.safeParse(raw);
  return parsed.success ? parsed.data.edits : undefined;
}

/** 读一次 stateOf 并校验台账形状：抛错与形状不符都返回 undefined（宁可不给出数据）。 */
function readAsLedger(stateOf: () => unknown): readonly EditLedgerEntry[] | undefined {
  try {
    return asLedger(stateOf());
  } catch {
    // 读不出来和历史数据形状不符按同一种情况处理；这里不把异常转成调用方的失败。
    return asLedger(null);
  }
}

export interface LedgerReadFace {
  readonly publish: (reader: EditLedgerReader | undefined) => void;
  readonly effect: (factory: () => () => void) => unknown;
  readonly onError: (error: unknown) => void;
}

/**
 * 注册投影并对外提供读取函数；失败（同步抛错或异步拒绝）只报告，不提供读取函数。
 *
 * 发布与登记也写在这一段 try 里：注册成功之后投影已经挂在注册表上，publish 或 effect 只要
 * 抛错又没有释放，投影就会一直挂在注册表上（effect 抛错时，读取函数已经发出去，却没有清理路径）。
 * 因此失败路径统一按"先收回读取函数、再释放投影、最后报告"的顺序走，报告的是最初那个错误。
 *
 * @param registry - 官方 sessionProjections 服务
 * @param face - 交出读取函数的位置，与登记释放逻辑的位置
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
      // dispose 可能返回 Promise；不等待它，拒绝会变成未处理的 rejection，释放失败也就没有任何地方能看到。
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
      // 清理可能被宿主重复调用（重复 unmount、重放清理）：第二次 dispose 同一个句柄会抛错。
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
    // 只收回已经交出去的读取函数；还停在注册阶段时没有读取函数可收回，也不该凭空调用一次
    // publish(undefined)（失败就不提供读取函数，这是本模块对外的契约）。
    if (published) {
      // 收回读取函数这一步本身也可能抛错；那不该盖掉真正的原因——要报告的是原始那个 error。
      try {
        face.publish(undefined);
      } catch {
        void 0;
      }
    }
    release?.();
    // 报告失败本身不能再让这次挂载变成 Promise 拒绝：宿主侧调用它时没有 catch。
    try {
      face.onError(error);
    } catch {
      // onError 自己抛错时，仍然只报告、不提供读取函数。
    }
  }
}
