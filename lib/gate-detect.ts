// lib/gate-detect.ts —— 项目根 → 质量门禁命令的自动探测（纯函数）。
//
// ECC stop-format-typecheck 的思想：按项目根分组、每根一次批处理、
// 单一 formatter/tsc 调用。dsh 侧按用户机器上的真实项目形态简化：
//   pnpm-workspace（且根 package.json 声明了 check 脚本）> cargo > python > tsc。
// 门禁命令本身用"项目自己声明的 check"优先——项目最懂自己；反过来，项目没声明的
// 命令就不是它的门禁，绝不能凭"这是个 pnpm 工程"替它发明一条（见 pnpmCheckReady）。

/** 一个项目根及其根目录下存在的清单文件（相对名）。 */
export interface ProjectRoot {
  root: string;
  /** 根目录下真实存在的清单/标记文件名（相对名，含 tsconfig.json）。 */
  files: readonly string[];
  /**
   * 根 package.json 已声明的 scripts 名清单（值非空字符串才算声明）。
   *
   * **缺失（undefined）表示"没有信息"**：文件读不到 / JSON 非法 / 没有 scripts 字段。
   * 调用方（host）读盘后传入，本函数不碰 fs——保持纯函数可测性。
   */
  scripts?: readonly string[];
}

/**
 * 门禁命令白名单：字面量元组联合而非 `string[]`——本包把 command 直接 join 后交给
 * shell 执行，联合类型是"只有这四条固定命令能进执行面"的可验证约束（手搓数组
 * 在类型层就被拒）。
 */
export type GateCommand =
  | readonly ["pnpm", "check"]
  | readonly ["cargo", "check"]
  | readonly ["ruff", "check", "."]
  | readonly ["npx", "tsc", "--noEmit"];

/** 一个根探测出的门禁：在该根下用 shell 执行的命令参数表。 */
export interface Gate {
  root: string;
  command: GateCommand;
}

/**
 * `pnpm check` 是否可用：必须有已声明的 check 脚本，**信息缺失时一律判否**。
 *
 * 为什么取保守方向（宁可不给门禁，也不发这条命令）：没有声明 `check` 的 pnpm 工程
 * 是绝大多数，`pnpm check` 会以「Command "check" not found」非零退出；而本包把门禁
 * 失败当**真实质量缺陷**处理——开新回合注入"修这些错"、写 lesson-loop 总线、可选写
 * 记忆环。于是对一个代码本来就没问题的使用者，这是一条稳定复现的假失败注入。
 * 反方向的代价只是"这个根本轮没有自动核验"（读不到 package.json 的工程本就少见），
 * 用户可以自己跑检查。两害相权：**假失败比漏检查更贵**。
 */
function pnpmCheckReady(scripts: readonly string[] | undefined): boolean {
  return scripts?.includes("check") === true;
}

/** 从 ProjectRoot（根目录相对名清单 + 已声明脚本）判定单根门禁。 */
function gateForRoot(entry: ProjectRoot): Gate | undefined {
  const { root, files, scripts } = entry;
  const has = (name: string): boolean => files.includes(name);
  // 优先级从高到低：workspace 全套 > Rust > Python > 裸 TS
  let gate: Gate | undefined;
  if (has("pnpm-workspace.yaml") && has("package.json") && pnpmCheckReady(scripts)) {
    gate = { root, command: ["pnpm", "check"] as const };
  } else if (has("Cargo.toml")) {
    gate = { root, command: ["cargo", "check"] as const };
  } else if (has("pyproject.toml") || has("ruff.toml")) {
    // ruff.toml 分支不是死码：host 的 MANIFESTS 已登记 ruff.toml，只有 ruff 配置的
    // Python 工程也能拿到根并落到这里（审计 LOW-MED 项）。
    gate = { root, command: ["ruff", "check", "."] as const };
  } else if (has("package.json") && has("tsconfig.json")) {
    // 必须有 tsconfig.json 才算 TS 项目。裸 package.json 不够——HOME 里 `npm init` 的空壳
    // （无 tsconfig、无 typescript）也会被发 tsc 门禁，而 `npx tsc` 在无 typescript 时会自动
    // 安装已弃用的 stub 包 `tsc@2.0.4`，打印横幅并 exit 1 → 假失败注入。
    gate = { root, command: ["npx", "tsc", "--noEmit"] as const };
  }
  return gate;
}

/** 多根归并探测：每个根独立判定，无清单的根跳过（返回 undefined）。 */
export function detectGate(roots: readonly ProjectRoot[]): Gate[] {
  const out: Gate[] = [];
  for (const entry of roots) {
    // 入参类型已约束形状（root: string、files: readonly string[]），不再逐项手搓守卫：
    // 守卫的"不合规"分支在类型面上不可达，留着只会让覆盖率假性缺口长存。
    const gate = gateForRoot(entry);
    if (gate !== undefined) {
      out.push(gate);
    }
  }
  return out;
}
