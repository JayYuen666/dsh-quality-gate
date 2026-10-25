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
 *  （host 侧只对 create/str_replace/insert 记账，view 只读不入这里）。 */
const EDIT_TOOLS = new Set(["edit", "write", "str_replace_editor"]);

const DEFAULT_MAX_FILES = 500;

export interface AccumulatorOptions {
  /** 记忆的最大文件数；超出按插入序淘汰最旧（防超长回合内存膨胀）。 */
  maxFiles?: number;
}

/** 回合内编辑文件累积器：note O(1)，drain 一次性取出并清空。 */
export class EditAccumulator {
  private readonly files = new Set<string>();
  private readonly maxFiles: number;
  /** 容量淘汰累计丢弃数：drain 时清零（C10：500-cap 静默淘汰可观测）。 */
  private dropped = 0;

  public constructor(options: AccumulatorOptions = {}) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
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
    if (this.files.size >= this.maxFiles && !this.files.has(filePath)) {
      this.evictOldest();
    }
    this.files.add(filePath);
  }

  /**
   * 淘汰插入序最旧的一项并计数。调用点已保证集合非空（`size >= maxFiles >= 1`，本包
   * maxFiles 只取默认 500 或测试里的 2），所以原意是**取首项这一次动作**，不是迭代——
   * 旧写法拿 `for…of` + 无条件 `break` 伪装单次取值，那正是 eslint(no-unreachable-loop)
   * 判的「循环体只允许一次迭代」：循环结构在这里没有承载任何语义。改成直接取首个元素，
   * 单次淘汰的行为（删最旧 + 计数）与原样一致。
   */
  private evictOldest(): void {
    const [oldest] = this.files;
    if (oldest === undefined) {
      // 空集 = 无最旧可淘汰，什么都不做（原 for-of 的同一形状）。调用点保证正常配置走不到。
      return;
    }
    this.files.delete(oldest);
    this.dropped += 1;
  }

  /** 自上次 drain 以来容量淘汰丢弃的文件数（C10：>0 时 host 侧 console.warn）。 */
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
