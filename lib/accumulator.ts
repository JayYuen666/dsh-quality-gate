// lib/accumulator.ts —— 本回合编辑文件记账器（ECC post-edit-accumulator 移植）。
//
// ECC 的精髓：不逐文件跑门禁（太贵），而是回合收口时"一次算总账"——
// post-edit 只记账（O(1)），Stop 时按项目根分组批量执行。
// dsh 侧对应：tool/result 事件记账，agent/turn-stopping 时 drain 批处理。

/**
 * 需要过门禁的扩展名（代码与配置；md/txt/图片等免检）。
 *
 * **不含 `.sh`**：四种门禁命令（tsc / ruff / cargo / pnpm check）没有一个能校验 shell
 * 脚本，`.sh` 只会把根解析到最近的 package.json——`~/.dsh/run-all-tests.sh` 因此把门禁
 * 拖到用户主目录那个 `npm init` 空壳上跑出假失败（本机实测）。
 */
const GATED_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|py|json|ya?ml|toml)$/iu;

/** 编辑类工具名。str_replace_editor 是 dsh-base 并存的另一套编辑器
 *  （host 侧只对 create/str_replace/insert 记账，view 只读不入这里）。
 *
 *  这是**唯一真源**：host 侧的同名判定（isEditTool）也用这一份，两边各写一份时新增
 *  编辑器工具只改一侧就会静默分叉——只改 host 则累加器静默丢弃记账，只改这里则 host
 *  根本不会调用 note。 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "str_replace_editor"]);

const DEFAULT_MAX_FILES = 500;

export interface AccumulatorOptions {
  /** 记忆的最大文件数；非法值（NaN / 负数 / 0 / 小数）一律回退默认值。 */
  maxFiles?: number;
}

/** 回合内编辑文件累积器：note O(1)，drain 一次性取出并清空。 */
export class EditAccumulator {
  private readonly files = new Set<string>();
  private readonly maxFiles: number;
  /** 容量淘汰累计丢弃数：drain 时清零（静默淘汰要可观测）。 */
  private dropped = 0;

  public constructor(options: AccumulatorOptions = {}) {
    // 容量契约必须对任意入参成立：NaN 会让 `size >= NaN` 恒假（永不淘汰、Set 无限增长），
    // 负数会让每次 note 都淘汰一项，0 会让容量实际变成 1（比上限 1 还多收一个）——
    // 三种都按"没给"处理，回退默认值。
    const configured = options.maxFiles;
    this.maxFiles =
      configured !== undefined && Number.isInteger(configured) && configured > 0
        ? configured
        : DEFAULT_MAX_FILES;
  }

  /** 记一笔：编辑类工具 + 代码/配置扩展名 + 非空路径才收；容量淘汰时计数。 */
  public note(name: string | undefined, filePath: string | undefined | null): void {
    if (name === undefined || !EDIT_TOOLS.has(name)) {
      return;
    }
    if (typeof filePath !== "string" || filePath.length === 0) {
      return;
    }
    if (!GATED_EXT.test(filePath)) {
      return;
    }
    // 重复编辑要把顺序刷到最近：`Set.add` 对已存在元素不改变顺序，否则"整回合被反复编辑、
    // 也最可能触发门禁失败"的那个文件会因为最早插入而最先被淘汰（淘汰即漏检该根）。
    this.files.delete(filePath);
    if (this.files.size >= this.maxFiles) {
      this.evictOldest();
    }
    this.files.add(filePath);
  }

  /**
   * 淘汰顺序最旧的一项并计数。
   *
   * 归一化后 `maxFiles >= 1`，而调用点只在 `size >= maxFiles` 时进来，所以集合必有可取首项。
   */
  private evictOldest(): void {
    const [oldest] = this.files;
    /* v8 ignore next 3 —— 上面那条不变量的直接推论：这一支只为类型收窄而写，正常配置下不可达。 */
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

  /** 取出全部去重文件并清空（Stop 批处理后调用；重复调用得空表；同时清零淘汰计数）。 */
  public drain(): string[] {
    const out = [...this.files];
    this.files.clear();
    this.dropped = 0;
    return out;
  }
}
