// lib/gate-detect.ts —— 项目根 → 质量门禁命令的自动探测（纯函数）。
//
// 沿用 ECC stop-format-typecheck 的思路：按项目根分组、每个根批处理一次、
// formatter 和 tsc 各只调用一次。dsh 侧按用户机器上的真实项目形态简化成一条优先级：
//   pnpm-workspace（且根 package.json 声明了 check 脚本）> cargo > python > tsc。
// 门禁命令本身用"项目自己声明的 check"优先——项目最懂自己；反过来，项目没声明的
// 命令就不是它的门禁，绝不能因为"这是个 pnpm 工程"替它编一条出来（见 pnpmCheckReady）。

/** 一个项目根，以及它根目录下存在的清单文件（相对名）。 */
export interface ProjectRoot {
  root: string;
  /** 根目录下确实存在的清单或标记文件名（相对名，包括 tsconfig.json）。 */
  files: readonly string[];
  /**
   * 根 package.json 里已声明的 scripts 名（值是非空字符串才算声明）。
   *
   * **缺失（undefined）表示"没有信息"**：文件读不到、JSON 不合法，或者没有 scripts 字段。
   * 由调用方（host）读文件之后传进来，本函数不碰文件系统，这样它可以直接拿入参测。
   */
  scripts?: readonly string[];
  /**
   * 根 pyproject.toml 里是否真的有 ruff 的配置段（`[tool.ruff]` 开头的那几段）。
   *
   * false 和 undefined 的差别只在于知道多少信息，不影响结果：两种都不会给出 ruff门禁命令。
   * 区分出 false 是为了让"读过 pyproject.toml、里面没有 ruff 段"和"根本没有 pyproject.toml"
   * 在入参上能分开——这两种情况在项目里确实不一样，写测试时不用猜。
   */
  ruffConfigured?: boolean;
}

/**
 * 门禁命令的白名单：写成字面量元组的联合类型而不是 `string[]`——本包把 command 直接 join
 * 之后交给 shell 执行，用联合类型保证"能进入执行的只有这四条固定命令"，这是可以在类型层验证的
 * 约束（自己拼一个数组，在类型检查这一步就会被拒）。
 */
export type GateCommand =
  | readonly ["pnpm", "check"]
  | readonly ["cargo", "check"]
  | readonly ["ruff", "check", "."]
  | readonly ["tsc", "--noEmit"];

/** 一个根探测出的门禁：要在该根下用 shell 执行的命令参数数组。 */
export interface Gate {
  root: string;
  command: GateCommand;
}

/**
 * `pnpm check` 能不能用：必须存在已声明的 check 脚本，**信息缺失时一律判定为不能用**。
 *
 * 为什么取保守的一边（宁可不给门禁命令，也不发这条命令）：没声明 `check` 的 pnpm 工程是大多数，
 * `pnpm check` 会以「Command "check" not found」非零退出；而本包把门禁失败当**真实的质量缺陷**
 * 处理——开新回合注入"修这些错"、写 lesson-loop 总线、还可能写记忆。于是对代码本来没问题的
 * 使用者，这是一次每次都会复现的假失败。
 * 另一侧的代价只是"这一轮没有自动核验"（读不到 package.json 的工程本来就少见），使用者可以自己
 * 跑检查。两边比下来：**假失败的代价比漏一次检查大**。
 */
function pnpmCheckReady(scripts: readonly string[] | undefined): boolean {
  return scripts?.includes("check") === true;
}

/**
 * `ruff check .` 能不能用：必须有 ruff 自己的配置文件，**信息缺失时一律判定为不能用**。
 *
 * 为什么 pyproject.toml 单独不算证据：它不是 ruff 的配置标记，而是 Python 工程最常见的元数据
 * 文件——只写 `[project]`、lint 交给别的工具（flake8、pylint，或者编辑器里的 ruff 集成）的工程
 * 大量存在。对这类工程发 `ruff check .`，只要宿主的 PATH 上有 ruff，就会拿 ruff 的默认规则集去
 * 判断一个从没声明过用 ruff 的项目，产出与使用者意图无关的告警，再经同一条注入通道被当成真实缺陷。
 * 这正是本模块要拦住的假失败，方向和 pnpmCheckReady 一致。
 *
 * 判断只看两处**声明**：`ruff.toml` 与 `.ruff.toml`（ruff 专用的文件名，出现即算声明；两者同时
 * 存在时 ruff 优先读 ruff.toml，但任何一个出现都足以说明这个工程在用 ruff），以及 pyproject.toml
 * 里确实有 `[tool.ruff]` 开头的那些段（由 host 读文件后经 ruffConfigured 传入）。两处都没有就是
 * 没有信息，按同样的保守做法不给门禁命令——代价只是这一轮少一次自动核验，使用者可以自己跑。
 */
function ruffGateReady(files: readonly string[], ruffConfigured: boolean | undefined): boolean {
  return files.includes("ruff.toml") || files.includes(".ruff.toml") || ruffConfigured === true;
}

/** 根据 ProjectRoot（根目录的文件名清单、已声明的脚本、ruff 的配置事实）判断单个根该用哪条门禁命令。 */
function gateForRoot(entry: ProjectRoot): Gate | undefined {
  const { root, files, scripts, ruffConfigured } = entry;
  const has = (name: string): boolean => files.includes(name);
  const workspace = has("pnpm-workspace.yaml");
  // 优先级从高到低：workspace 的 pnpm check > Rust > Python > 只有 TS 的项目
  let gate: Gate | undefined;
  if (workspace && has("package.json") && pnpmCheckReady(scripts)) {
    gate = { root, command: ["pnpm", "check"] as const };
  } else if (has("Cargo.toml")) {
    gate = { root, command: ["cargo", "check"] as const };
  } else if (ruffGateReady(files, ruffConfigured)) {
    gate = { root, command: ["ruff", "check", "."] as const };
  } else if (!workspace && has("package.json") && has("tsconfig.json")) {
    // 必须有 tsconfig.json 才算 TS 项目。只有 package.json 不够——HOME 里 `npm init` 生成的空壳
    // 没有 tsconfig，对它跑 tsc 只会制造假失败。命令里的 `tsc` 是个逻辑名字：真正的入口在 host
    // 执行时才确定（优先用工程本地的 typescript，其次用本包依赖里那一份），不通过 npx 下载。
    //
    // workspace 的根不走这一条退而求其次：那里的 tsconfig 常常是 solution-style（`files: []` 加
    // `references`），`tsc --noEmit` 不会构建被引用的子工程，一个文件都没检查就退 0，检查名义上
    // 门禁名义存在而总是通过；host 的 rootForFile 又会因「外层能产出门禁」升级到这个根，
    // 的门禁命令一并挤掉。workspace 能落地的门禁命令就是它自己声明的 check 脚本；没声明时和
    // pnpmCheckReady 取同一个方向——宁可少一次门禁，也不制造一次假的通过。
    gate = { root, command: ["tsc", "--noEmit"] as const };
  }
  return gate;
}

/** 多个根一起探测：每个根独立判断，没有清单文件的根跳过（那条根返回 undefined）。 */
export function detectGate(roots: readonly ProjectRoot[]): Gate[] {
  const out: Gate[] = [];
  // 同一个 root 重复出现时会重复执行门禁、重复消耗预算和配额；这里按 root 的原值去重，
  // 不假定调用方已经去过重（本函数是导出的公共接口）。
  const seen = new Set<string>();
  for (const entry of roots) {
    if (!seen.has(entry.root)) {
      seen.add(entry.root);
      // 入参类型已经把形状约束住了（root: string、files: readonly string[]），这里不再逐项手写
      // 检查：那种检查的"不合规"分支在类型上到不了，留着只会让覆盖率里出现一个永远补不上的缺口。
      const gate = gateForRoot(entry);
      if (gate !== undefined) {
        out.push(gate);
      }
    }
  }
  return out;
}
