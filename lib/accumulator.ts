// lib/accumulator.ts —— 收集本次会话回合内被编辑的文件（ECC post-edit-accumulator 移植）。
//
// ECC 的做法是：每编辑一个文件就跑一次门禁太慢，所以编辑时只把路径存下来（O(1)），
// 等回合结束时按项目根分组，一次批量执行检查。
// dsh 侧对应：在 tool/result 事件里存路径，在 agent/turn-stopping 时取出并批量执行。

import path from "node:path";

/**
 * 需要过门禁的扩展名（代码与配置；md/txt/图片等免检）。
 *
 * **不含 `.sh`**：四条门禁命令（tsc / ruff / cargo / pnpm check）没有一条能校验 shell
 * 脚本，而 `.sh` 会把项目根解析到最近的 package.json——`~/.dsh/run-all-tests.sh` 因此
 * 把检查落到用户主目录那个 `npm init` 空壳上，报出一次假失败（本机实测）。
 */
const GATED_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|py|json|ya?ml|toml)$/iu;

/** 编辑类工具名。str_replace_editor 是 dsh-base 并存的另一套编辑器
 *  （host 侧只对 create/str_replace/insert 收集路径，view 是只读的，不进这里）；apply_patch 是
 *  多文件补丁，路径由 `editPathsOf` 逐个展开，`note` 仍按单个路径去重后收集。
 *
 *  这是**唯一来源**：host 侧的同名判定（isEditTool）也用这一份。两边各写一份时，新增编辑器
 *  工具只改一边就会悄悄不一致——只改 host 则累加器把要收集的路径丢掉，只改这里则 host
 *  根本不会调用 note。 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "str_replace_editor",
  "apply_patch",
]);

const DEFAULT_MAX_FILES = 500;

export interface AccumulatorOptions {
  /** 最多记住多少个文件；非法值（NaN / 负数 / 0 / 小数）一律改用默认值。 */
  maxFiles?: number;
}

/** 回合内编辑文件的累积器：note O(1)，drain 一次取出全部并清空。 */
export class EditAccumulator {
  private readonly files = new Set<string>();
  private readonly maxFiles: number;
  /** 因为超出容量而被丢掉的文件累计数：drain 时清零（不记这个数，淘汰发生时就没有任何信号）。 */
  private dropped = 0;

  public constructor(options: AccumulatorOptions = {}) {
    // 容量上限必须对任意入参都成立：NaN 会让 `size >= NaN` 永远不成立（永不淘汰、Set 无限增长），
    // 负数会让每次 note 都淘汰一项，0 会让容量实际变成 1（比上限 1 还多收一个）——
    // 三种都按"没给"处理，改用默认值。
    const configured = options.maxFiles;
    this.maxFiles =
      configured !== undefined && Number.isInteger(configured) && configured > 0
        ? configured
        : DEFAULT_MAX_FILES;
  }

  /** 收集一个路径：编辑类工具、代码或配置扩展名、且路径非空时才记；因容量上限淘汰时累加计数。 */
  public note(name: string | undefined, filePath: string | undefined | null): void {
    if (name === undefined || !EDIT_TOOLS.has(name)) {
      return;
    }
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      return;
    }
    // 先 trim 再判扩展名：`$` 只匹配串末，带尾随空格或换行的路径会被判成不检查的扩展名而悄悄丢掉。
    // 归一化同时把 `a/../b.ts`、`a//b.ts` 收成同一个键，避免重复项白占容量、把真正需要门禁的文件
    // 挤到被淘汰。
    const normalized = path.normalize(filePath.trim());
    if (!GATED_EXT.test(normalized)) {
      return;
    }
    // 重复编辑要把顺序挪到最近：`Set.add` 对已存在元素不改变顺序，否则"整回合被反复编辑、
    // 也最可能触发门禁失败"的那个文件会因为最早插入而最先被淘汰（淘汰即漏检该根）。
    this.files.delete(normalized);
    if (this.files.size >= this.maxFiles) {
      this.evictOldest();
    }
    this.files.add(normalized);
  }

  /**
   * 淘汰顺序最旧的一项并累加计数。
   *
   * 归一化后 `maxFiles >= 1`，而调用点只在 `size >= maxFiles` 时进来，所以集合里一定取得到第一项。
   */
  private evictOldest(): void {
    const [oldest] = this.files;
    /* v8 ignore next 3 —— 上面那句话的直接推论：这个分支只是为了让类型收窄，正常配置下走不到。 */
    if (oldest === undefined) {
      return;
    }
    this.files.delete(oldest);
    this.dropped += 1;
  }

  /** 自上次 drain 以来容量淘汰丢弃的文件数（>0 时 host 侧 console.warn）。 */
  public droppedCount(): number {
    return this.dropped;
  }

  /** 取出全部去重文件并清空（Stop 批处理后调用；再次调用返回空数组；同时清零淘汰计数）。 */
  public drain(): string[] {
    const out = [...this.files];
    this.files.clear();
    this.dropped = 0;
    return out;
  }
}
