// lib/gate-detect.ts —— 项目根 → 质量门禁命令的自动探测（纯函数）。
//
// 两条原则：
//   1. 项目自己声明的检查优先：pnpm check / 用户配置的 pnpmScripts / Makefile 的 check 目标
//      压过一切内置探测。项目最懂自己，内置探测只在它没有声明时兜底。
//   2. 内置探测宁可漏一次检查，也不发明一条会假失败的命令：只有根上出现了该工具自己的
//      配置/清单标记才发命令；只是"看起来像这个语言"不够。
//
// 内置覆盖：JavaScript/TypeScript、Rust、Go、Python、Ruby、Java、C/C++、PHP、C#。
// 同一个根在项目没有声明时可以有**多条**门禁（例如 package.json + Cargo.toml 的混合仓），
// 按 root+command 去重后交给 host 串行执行；一条门禁的失败不会吞掉其它门禁的结果。

/** 在门禁输出里认出来的一条诊断（各语言解析器共用同一形状，路径先按门禁根相对）。 */
export interface TsDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

/** `src/x.ts(12,5): error TS2322: ...`——tsc 默认（非 pretty）输出的形状。 */
const TS_DIAGNOSTIC =
  /^(?<path>[^\s(][^()\n]*)\((?<line>\d+),\d+\): (?:error|warning) TS\d+: (?<message>[^\n]*)$/u;
const DIAGNOSTIC_LIMIT = 20;

/** 单行命名组收集器（组名固定为 path/line/message）：tsc 与各语言解析器共用这一段。 */
export function collectDiagnostics(
  text: string,
  pattern: RegExp,
  options: { readonly messageMax?: number; readonly limit?: number } = {},
): readonly TsDiagnostic[] {
  const messageMax = options.messageMax ?? 200;
  const limit = options.limit ?? DIAGNOSTIC_LIMIT;
  const out: TsDiagnostic[] = [];
  for (const raw of text.split("\n")) {
    if (out.length >= limit) {
      break;
    }
    const groups = pattern.exec(raw.trim())?.groups;
    const file = groups?.["path"];
    const at = groups?.["line"];
    const message = groups?.["message"];
    if (file !== undefined && at !== undefined && message !== undefined) {
      out.push({ path: file, line: Number(at), message: message.slice(0, messageMax) });
    }
  }
  return out;
}

/** 从一段输出里挑出 tsc 形状的诊断；认不出的行直接跳过（不猜路径和行号）。 */
export function parseTsDiagnostics(
  text: string,
  options: { readonly messageMax?: number; readonly limit?: number } = {},
): readonly TsDiagnostic[] {
  return collectDiagnostics(text, TS_DIAGNOSTIC, options);
}

/** 一个项目根，以及它根目录下存在的清单文件（相对名）。 */
export interface ProjectRoot {
  root: string;
  /**
   * 根目录下确实存在的清单或标记文件名（相对名，包括 tsconfig.json）。
   *
   * 也允许 host 追加几个**有界的嵌套标记**：`build/CMakeCache.txt`、
   * `build/CTestTestfile.cmake`、PHPUnit 的本地可执行文件、`tests/`。它们只用于判断"构建目录已经
   * 配置好/测试入口存在"，不会改变向上找根的语义。
   */
  files: readonly string[];
  /**
   * 根 package.json 里已声明的 scripts 名（值是字符串或非空字符串数组才算声明）。
   *
   * **缺失（undefined）表示"没有信息"**：文件读不到、JSON 不合法，或者没有 scripts 字段。
   * 由调用方（host）读文件之后传进来，本函数不碰文件系统，这样它可以直接拿入参测。
   */
  scripts?: readonly string[];
  /** 根 composer.json 里已声明的 scripts 名（形状与 package.json 的 scripts 相同）。 */
  composerScripts?: readonly string[];
  /** 根 pyproject.toml 里是否真的有 ruff 的配置段（`[tool.ruff]` 开头的那几段）。 */
  ruffConfigured?: boolean;
  /** 根上是否显式配置了 ruff 的格式化器（`[tool.ruff.format]` / ruff.toml 的 `[format]`）。 */
  ruffFormatConfigured?: boolean;
  /** 根 pyproject.toml 里是否真的有 pytest 的配置段（`[tool.pytest.ini_options]`）。 */
  pytestConfigured?: boolean;
  /** 根 pyproject.toml 里是否真的有 mypy 的配置段（`[tool.mypy]`）。 */
  mypyConfigured?: boolean;
  /** 根 pyproject.toml / setup.cfg 里是否真的有 pylint 的配置段。 */
  pylintConfigured?: boolean;
  /** 根 pyproject.toml 里是否真的有 black 的配置段（`[tool.black]`）。 */
  blackConfigured?: boolean;
  /** 根 pyproject.toml 里是否真的有 pyright 的配置段（`[tool.pyright]`）。 */
  pyrightConfigured?: boolean;
  /** 根 setup.cfg 里是否真的有 flake8 的配置段（`[flake8]`）。 */
  flake8Configured?: boolean;
  /**
   * 根 tsconfig.json 是否带非空 `references`（project references）。
   *
   * **true = 这个根不适合 `tsc --noEmit`**：TS 的 `--noEmit` 不会构建被引用的子工程，凡跨引用
   * 导入都会报 `TS6305`（输出文件尚未构建），一个本来健康的仓库会被判成红色。
   */
  tsconfigReferences?: boolean;
  /** 根 Makefile 里声明了哪些目标名（host 读取文件后传入；缺失 = 没读到）。 */
  makeTargets?: readonly string[];
  /** 根 Rakefile 里有哪些 check/test 任务（host 读取文件后传入；缺失 = 没读到）。 */
  rakeTargets?: readonly string[];
  /** 根 pom.xml 是否声明了 checkstyle / spotbugs / pmd 插件（true 时 Maven 跑 verify 而不是 test）。 */
  mavenVerifyConfigured?: boolean;
}

/**
 * 门禁命令的白名单：写成字面量元组的联合类型而不是 `string[]`——本包把 command 直接 join
 * 之后交给 shell 执行，用联合类型保证"能进入执行的只有声明过的固定命令"，这是可以在类型层
 * 验证的约束（自己拼一个数组，在类型检查这一步就会被拒）。
 *
 * 两项动态取值：用户配置的 `pnpm run <script>`（脚本名必须已声明在根 package.json 且形状安全）
 * 与 `make check/test`（目标名由 host 从 Makefile 的实际目标表读出）。
 */
export type GateCommand =
  | readonly ["pnpm", "check"]
  | readonly ["pnpm", "run", string]
  | readonly ["cargo", "check"]
  | readonly ["cargo", "test", "--no-run"]
  | readonly ["cargo", "fmt", "--all", "--", "--check"]
  | readonly ["cargo", "clippy", "--all-targets", "--", "-D", "warnings"]
  | readonly ["run-clang-tidy", "-p", "build"]
  | readonly ["cppcheck", "--project=build/compile_commands.json", "--error-exitcode=1"]
  | readonly ["go", "vet", "./..."]
  | readonly ["go", "test", "./..."]
  | readonly ["golangci-lint", "run"]
  | readonly ["staticcheck", "./..."]
  | readonly ["ruff", "check", "."]
  | readonly ["ruff", "format", "--check", "."]
  | readonly ["black", "--check", "."]
  | readonly ["flake8"]
  | readonly ["pyright"]
  | readonly ["pylint", "."]
  | readonly ["pytest", "-q"]
  | readonly ["mypy", "."]
  | readonly ["rubocop"]
  | readonly ["rspec"]
  | readonly ["standardrb"]
  | readonly ["mvn", "-q", "test"]
  | readonly ["./mvnw", "-q", "test"]
  | readonly ["mvn", "-q", "verify"]
  | readonly ["./mvnw", "-q", "verify"]
  | readonly ["gradle", "check"]
  | readonly ["./gradlew", "check"]
  | readonly ["gradlew.bat", "check"]
  | readonly ["dotnet", "build", "--nologo"]
  | readonly ["dotnet", "test", "--nologo"]
  | readonly ["dotnet", "format", "--verify-no-changes", "--nologo"]
  | readonly ["cmake", "--build", "build"]
  | readonly ["ctest", "--test-dir", "build", "--output-on-failure"]
  | readonly ["make", "check"]
  | readonly ["make", "test"]
  | readonly ["make", "format-check"]
  | readonly ["make", "check-format"]
  | readonly ["make", "clang-format-check"]
  | readonly ["bazel", "test", "//..."]
  | readonly ["rake", "check"]
  | readonly ["rake", "test"]
  | readonly ["composer", "validate", "--no-check-publish"]
  | readonly ["composer", "run-script", "test"]
  | readonly ["composer", "audit"]
  | readonly ["detekt", "--config", "detekt.yml"]
  | readonly ["detekt", "--config", "detekt.yaml"]
  | readonly ["detekt", "--config", "config/detekt/detekt.yml"]
  | readonly ["detekt", "--config", "config/detekt/detekt.yaml"]
  | readonly ["ktlint"]
  | readonly ["checkstyle", "-c", "checkstyle.xml", "src/main/java"]
  | readonly ["checkstyle", "-c", "config/checkstyle/checkstyle.xml", "src/main/java"]
  | readonly ["npm", "audit", "--audit-level=high", "--omit=dev"]
  | readonly ["pnpm", "audit", "--audit-level=high", "--prod"]
  | readonly ["cargo", "audit"]
  | readonly ["govulncheck", "./..."]
  | readonly ["pip-audit", "-r", "requirements.txt"]
  | readonly ["bundler-audit", "check", "--update"]
  | readonly ["phpunit"]
  | readonly ["vendor/bin/phpunit"]
  | readonly ["phpstan", "analyse"]
  | readonly ["psalm"]
  | readonly ["php-cs-fixer", "fix", "--dry-run", "--diff"]
  | readonly ["oxlint", "."]
  | readonly ["eslint", "--format", "unix", "."]
  | readonly ["vitest", "run"]
  | readonly ["jest", "--ci"]
  | readonly ["tsc", "--noEmit"]
  | readonly ["prettier", "--check", "."]
  | readonly ["oxfmt", "--check", "."]
  | readonly ["biome", "check", "."];

/**
 * 允许进入 `pnpm run` 的脚本名形状（含 `check:all` 这类带冒号的名字）。
 *
 * 首字符不许是 `-` / `.`：`pnpm run -x` 会被 pnpm 当成自己的选项（`--filter` 之类），
 * `pnpm run .x` 会被当成当前目录，两者都不会跑到脚本，只会以一次看不懂的非零退出收场。
 */
const SCRIPT_NAME_PATTERN = /^(?![-.])[\w:.-]+$/u;

/** 一个根探测出的门禁：要在该根下用 shell 执行的命令参数数组。 */
export interface Gate {
  root: string;
  command: GateCommand;
}

const PKG = "package.json";
const REQUIREMENTS = "requirements.txt";
const WORKSPACE = "pnpm-workspace.yaml";
const CARGO = "Cargo.toml";
const GO = "go.mod";
const PYPROJECT = "pyproject.toml";
const RUBOCOP = ".rubocop.yml";
const RSPEC = ".rspec";
const POM = "pom.xml";
const MVN_WRAPPER = "mvnw";
const DETEKT_CONFIGS = [
  "detekt.yml",
  "detekt.yaml",
  "config/detekt/detekt.yml",
  "config/detekt/detekt.yaml",
] as const;
const KOTLIN_MAIN = "src/main/kotlin";
const JAVA_MAIN = "src/main/java";
const CHECKSTYLE_CONFIGS = ["checkstyle.xml", "config/checkstyle/checkstyle.xml"] as const;
type CheckstyleConfig = (typeof CHECKSTYLE_CONFIGS)[number];
const GRADLE_BUILD = ["build.gradle", "build.gradle.kts"] as const;
const GRADLE_WRAPPER = ["gradlew", "gradlew.bat"] as const;
const CMAKE = "CMakeLists.txt";
const MAKE = "Makefile";
const CLANG_FORMAT = ".clang-format";
const CLANG_FORMAT_TARGETS = ["format-check", "check-format", "clang-format-check"] as const;
const BAZEL_FILES = ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel"] as const;
const COMPOSER = "composer.json";
const PHPUNIT = ["phpunit.xml", "phpunit.xml.dist"] as const;
const TSCONFIG = "tsconfig.json";
/** C# 测试工程的文件名形状：`App.Test.csproj` / `Tests.csproj`，不把 `Contest.csproj` 当成测试。 */
const DOTNET_TEST_PROJECT = /^(?:.*[._-])?(?:test|tests|spec|specs)\.(?:csproj|fsproj|vbproj)$/iu;
const CSHARP_PROJECT_FILE = /\.csproj$/iu;
const DOTNET_SOLUTION_FILE = /\.sln$/iu;
const ESLINT_CONFIGS = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
] as const;
const VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "vitest.config.mts",
  "vitest.config.cts",
] as const;
const JEST_CONFIGS = [
  "jest.config.js",
  "jest.config.ts",
  "jest.config.mjs",
  "jest.config.cjs",
  "jest.config.json",
] as const;
const OXLINT_CONFIGS = [
  ".oxlintrc",
  ".oxlintrc.json",
  ".oxlintrc.jsonc",
  "oxlintrc.json",
  "oxlintrc.jsonc",
] as const;
const OXFMT_CONFIGS = [
  ".oxfmtrc",
  ".oxfmtrc.json",
  ".oxfmtrc.jsonc",
  "oxfmtrc.json",
  "oxfmtrc.jsonc",
] as const;
const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.json5",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
] as const;
const BIOME_CONFIGS = ["biome.json", "biome.jsonc"] as const;
const CLIPPY_CONFIGS = ["clippy.toml", ".clippy.toml"] as const;
const GOLANGCI_CONFIGS = [
  ".golangci.yml",
  ".golangci.yaml",
  ".golangci.json",
  ".golangci.toml",
] as const;
const STATICCHECK_CONFIGS = ["staticcheck.conf"] as const;
const PYRIGHT_CONFIGS = ["pyrightconfig.json"] as const;
const FLAKE8_CONFIGS = [".flake8"] as const;
const STANDARD_CONFIGS = [".standard.yml", ".standard.yaml"] as const;
const PHPSTAN_CONFIGS = ["phpstan.neon", "phpstan.neon.dist"] as const;
const PSALM_CONFIGS = ["psalm.xml", "psalm.xml.dist"] as const;
const PHP_CS_FIXER_CONFIGS = [
  ".php-cs-fixer.php",
  ".php-cs-fixer.dist.php",
  ".php-cs-fixer.cjs",
] as const;
const RUSTFMT_CONFIGS = ["rustfmt.toml", ".rustfmt.toml"] as const;
const PYTEST_CONFIGS = ["pytest.ini", "tox.ini"] as const;
const MYPY_CONFIGS = ["mypy.ini", ".mypy.ini"] as const;
const PYLINT_CONFIGS = [".pylintrc", "pylintrc"] as const;

const has = (files: readonly string[], name: string): boolean => files.includes(name);
const hasAny = (files: readonly string[], names: readonly string[]): boolean =>
  names.some((name) => has(files, name));

/**
 * `pnpm check` 能不能用：必须存在已声明的 check 脚本，**信息缺失时一律判定为不能用**。
 *
 * 为什么取保守的一边：没声明 `check` 的 pnpm 工程是大多数，`pnpm check` 会以
 * 「Command "check" not found」非零退出；而本包把门禁失败当**真实的质量缺陷**处理。
 * 另一侧的代价只是"这一轮没有自动核验"，使用者可以自己跑。两边比下来，假失败更贵。
 */
function pnpmCheckReady(scripts: readonly string[] | undefined): boolean {
  return scripts?.includes("check") === true;
}

/**
 * `ruff check .` 能不能用：必须有 ruff 自己的配置文件，**信息缺失时一律判定为不能用**。
 * 只看 ruff.toml / .ruff.toml / pyproject 的 `[tool.ruff]` 段；bare pyproject 不算声明。
 */
function ruffGateReady(files: readonly string[], ruffConfigured: boolean | undefined): boolean {
  return has(files, "ruff.toml") || has(files, ".ruff.toml") || ruffConfigured === true;
}

/** Python 根：出现 Python 的清单/配置。 */
function pythonRoot(files: readonly string[]): boolean {
  return (
    has(files, PYPROJECT) ||
    has(files, "ruff.toml") ||
    has(files, ".ruff.toml") ||
    hasAny(files, PYTEST_CONFIGS) ||
    has(files, "setup.cfg") ||
    has(files, REQUIREMENTS) ||
    hasAny(files, MYPY_CONFIGS) ||
    hasAny(files, PYRIGHT_CONFIGS) ||
    hasAny(files, FLAKE8_CONFIGS) ||
    hasAny(files, PYLINT_CONFIGS)
  );
}

/** 明确的“没有项目门禁”返回值；与 `return;` 区分，保证函数的所有出口都带值。 */
const NO_DECLARED_GATE: Gate | undefined = undefined;

/** 项目自己声明的门禁；有它时不再叠加内置语言探测。 */
function declaredProjectGate(
  entry: ProjectRoot,
  extraScripts: readonly string[],
): Gate | undefined {
  const { root, files, scripts, makeTargets, rakeTargets } = entry;
  if (has(files, PKG) && pnpmCheckReady(scripts)) {
    return { root, command: ["pnpm", "check"] as const };
  }
  const declaredExtra = extraScripts.find(
    (name) => SCRIPT_NAME_PATTERN.test(name) && scripts?.includes(name) === true,
  );
  if (declaredExtra !== undefined) {
    return { root, command: ["pnpm", "run", declaredExtra] as const };
  }
  if (has(files, MAKE) && makeTargets?.includes("check") === true) {
    return { root, command: ["make", "check"] as const };
  }
  if (has(files, "Rakefile") && rakeTargets?.includes("check") === true) {
    return { root, command: ["rake", "check"] as const };
  }
  return NO_DECLARED_GATE;
}

/**
 * Makefile 的 `test` 目标：与 Ruby 的 `rake test` 同分工——只追加测试入口，不压掉内置的 lint/格式门禁。
 * （`check` 才承诺“完整检查”，才配当唯一的项目声明。）
 */
function makeTestCommands(entry: ProjectRoot): readonly GateCommand[] {
  return has(entry.files, MAKE) && entry.makeTargets?.includes("test") === true
    ? [["make", "test"] as const]
    : [];
}

/** JavaScript/TypeScript：有 package.json 才谈 JS 生态；eslint/vitest/jest 只认自己的配置。 */
function jsGateCommands(entry: ProjectRoot): readonly GateCommand[] {
  const { files } = entry;
  if (!has(files, PKG)) {
    return [];
  }
  const commands: GateCommand[] = [];
  // oxlint 与 eslint 只跑一条：同时声明就让更快的 oxlint 承担 lint。
  if (hasAny(files, OXLINT_CONFIGS)) {
    commands.push(["oxlint", "."] as const);
  } else if (hasAny(files, ESLINT_CONFIGS)) {
    // 诊断解析器只认 `path:line:col:` 的 unix 形状；eslint 默认的 stylish 报告是缩进树，
    // 按它解析会把所有问题都丢掉（门禁判红、注解却一片空白）。显式要求 unix 格式。
    commands.push(["eslint", "--format", "unix", "."] as const);
  }
  // 格式化器只跑一条：biome 自带 lint+format，oxfmt 是专门格式化器，prettier 兜底。
  if (hasAny(files, BIOME_CONFIGS)) {
    commands.push(["biome", "check", "."] as const);
  } else if (hasAny(files, OXFMT_CONFIGS)) {
    commands.push(["oxfmt", "--check", "."] as const);
  } else if (hasAny(files, PRETTIER_CONFIGS)) {
    commands.push(["prettier", "--check", "."] as const);
  }
  if (hasAny(files, VITEST_CONFIGS)) {
    commands.push(["vitest", "run"] as const);
  }
  if (hasAny(files, JEST_CONFIGS)) {
    commands.push(["jest", "--ci"] as const);
  }
  // workspace 根的 solution-style tsconfig 不会被 --noEmit 构建；这里不发明 tsc。
  if (!has(files, WORKSPACE) && has(files, TSCONFIG) && entry.tsconfigReferences !== true) {
    commands.push(["tsc", "--noEmit"] as const);
  }
  return commands;
}

/** Rust：cargo check 是编译门禁；test --no-run 额外编译测试目标；fmt 只在有配置时。 */
function rustGateCommands(files: readonly string[]): readonly GateCommand[] {
  if (!has(files, CARGO)) {
    return [];
  }
  const commands: GateCommand[] = [["cargo", "check"] as const];
  if (hasAny(files, CLIPPY_CONFIGS)) {
    commands.push(["cargo", "clippy", "--all-targets", "--", "-D", "warnings"] as const);
  }
  if (hasAny(files, RUSTFMT_CONFIGS)) {
    commands.push(["cargo", "fmt", "--all", "--", "--check"] as const);
  }
  commands.push(["cargo", "test", "--no-run"] as const);
  return commands;
}

/** Go：vet 做静态检查，test 编译并运行测试。 */
function goGateCommands(files: readonly string[]): readonly GateCommand[] {
  if (!has(files, GO)) {
    return [];
  }
  const commands: GateCommand[] = [["go", "vet", "./..."] as const];
  if (hasAny(files, GOLANGCI_CONFIGS)) {
    commands.push(["golangci-lint", "run"] as const);
  }
  if (hasAny(files, STATICCHECK_CONFIGS)) {
    commands.push(["staticcheck", "./..."] as const);
  }
  commands.push(["go", "test", "./..."] as const);
  return commands;
}

/** Python：ruff / pytest / mypy 各自只在有配置或测试入口时启用。 */
function pythonGateCommands(entry: ProjectRoot): readonly GateCommand[] {
  const {
    files,
    ruffConfigured,
    ruffFormatConfigured,
    pytestConfigured,
    mypyConfigured,
    blackConfigured,
    pyrightConfigured,
    flake8Configured,
    pylintConfigured,
  } = entry;
  if (!pythonRoot(files)) {
    return [];
  }
  const commands: GateCommand[] = [];
  if (ruffGateReady(files, ruffConfigured)) {
    commands.push(["ruff", "check", "."] as const);
    // 格式化门禁必须有显式的格式化器声明才发：`[tool.ruff]` 只说明用了 ruff 的 lint，
    // 不代表项目用 ruff format 排版。声明了 black 时也不叠加 ruff format——同一份代码
    // 被两套格式化规则互相判红，是比"没跑格式化"更坏的失败形态。
    if (ruffFormatConfigured === true && blackConfigured !== true) {
      commands.push(["ruff", "format", "--check", "."] as const);
    }
  }
  if (blackConfigured === true) {
    commands.push(["black", "--check", "."] as const);
  }
  if (flake8Configured === true || hasAny(files, FLAKE8_CONFIGS)) {
    commands.push(["flake8"] as const);
  }
  if (pyrightConfigured === true || hasAny(files, PYRIGHT_CONFIGS)) {
    commands.push(["pyright"] as const);
  }
  if (pylintConfigured === true || hasAny(files, PYLINT_CONFIGS)) {
    commands.push(["pylint", "."] as const);
  }
  // pytest.ini 本身就是 pytest 的声明；tox.ini/setup.cfg 里可能只是 tox/打包配置，
  // 必须有真正的 [pytest] 段（host 读成 pytestConfigured）才算。**不拿 tests/ 目录当判据**：
  // 目录存在但里面没有用例时 `pytest -q` 退 5（"no tests collected"），那是配置错误不是检查失败。
  if (pytestConfigured === true || has(files, "pytest.ini")) {
    commands.push(["pytest", "-q"] as const);
  }
  if (mypyConfigured === true || hasAny(files, MYPY_CONFIGS)) {
    commands.push(["mypy", "."] as const);
  }
  return commands;
}

/** Ruby：rubocop 只认自己的配置；rspec 只认 .rspec。 */
function rubyGateCommands(
  files: readonly string[],
  rakeTargets: readonly string[] | undefined,
): readonly GateCommand[] {
  const commands: GateCommand[] = [];
  const standard = hasAny(files, STANDARD_CONFIGS);
  // standardrb 本身就是 rubocop 的封装；声明了 standard 时不再叠加一条 rubocop。
  if (has(files, RUBOCOP) && !standard) {
    commands.push(["rubocop"] as const);
  }
  if (has(files, RSPEC)) {
    commands.push(["rspec"] as const);
  }
  if (standard) {
    commands.push(["standardrb"] as const);
  }
  // Rake 的 test 任务是测试入口，不是完整的 lint/format 检查；它只追加测试，
  // 不压掉上面的 rubocop / rspec / standardrb（Rake 的 check 任务仍走项目门禁）。
  if (rakeTargets?.includes("test") === true) {
    commands.push(["rake", "test"] as const);
  }
  return commands;
}

/** 没有 Maven/Gradle 的项目才走独立 Checkstyle：有构建工具时它的插件/任务才是项目
 * 自己的声明，再叠一条 CLI 会造成同一套规则跑两遍、报告两份。 */
function standaloneCheckstyleConfig(files: readonly string[]): CheckstyleConfig | null {
  if (has(files, POM) || hasAny(files, GRADLE_BUILD) || !has(files, JAVA_MAIN)) {
    return null;
  }
  return CHECKSTYLE_CONFIGS.find((candidate) => has(files, candidate)) ?? null;
}

/** Java/Kotlin：Maven/Gradle 的 test/check 都是"编译 + 测试"；wrapper 优先。 */
function javaGateCommands(entry: ProjectRoot): readonly GateCommand[] {
  const { files, mavenVerifyConfigured } = entry;
  const commands: GateCommand[] = [];
  if (has(files, POM)) {
    const phase = mavenVerifyConfigured === true ? "verify" : "test";
    const maven = has(files, MVN_WRAPPER) ? "./mvnw" : "mvn";
    commands.push([maven, "-q", phase] as const);
  }
  if (hasAny(files, GRADLE_BUILD)) {
    if (has(files, GRADLE_WRAPPER[0])) {
      commands.push(["./gradlew", "check"] as const);
    } else if (has(files, GRADLE_WRAPPER[1])) {
      commands.push(["gradlew.bat", "check"] as const);
    } else {
      commands.push(["gradle", "check"] as const);
    }
  }
  // Kotlin 的独立静态分析：detekt 只认自己的配置；ktlint 只在有 Kotlin 源目录且项目
  // 自带 .editorconfig（ktlint 的配置载体）时跑，避免在纯 Java 工程上发一条空扫描。
  const detektConfig = DETEKT_CONFIGS.find((config) => has(files, config));
  if (detektConfig !== undefined) {
    commands.push(["detekt", "--config", detektConfig] as const);
  }
  if (has(files, ".editorconfig") && has(files, KOTLIN_MAIN)) {
    commands.push(["ktlint"] as const);
  }
  const checkstyleConfig = standaloneCheckstyleConfig(files);
  if (checkstyleConfig !== null) {
    commands.push(["checkstyle", "-c", checkstyleConfig, JAVA_MAIN] as const);
  }
  return commands;
}

/** clang-format 的 CLI 要显式文件列表（不接受目录），所以不替项目拼 glob；
 *  只认 Makefile 里显式声明的检查目标，且必须同时有 `.clang-format`。 */
function clangFormatTargetCommand(
  files: readonly string[],
  makeTargets: readonly string[] | undefined,
): readonly GateCommand[] {
  if (!has(files, CLANG_FORMAT)) {
    return [];
  }
  const target = CLANG_FORMAT_TARGETS.find((name) => makeTargets?.includes(name) === true);
  return target === undefined ? [] : [["make", target] as const];
}

/** C/C++：只跑已经配置好的构建树；Makefile 的 check/test 目标已在项目门禁里优先处理。 */
function cppGateCommands(
  files: readonly string[],
  makeTargets: readonly string[] | undefined,
): readonly GateCommand[] {
  const commands: GateCommand[] = [];
  if (!has(files, CMAKE)) {
    return clangFormatTargetCommand(files, makeTargets);
  }
  if (has(files, "build/CMakeCache.txt")) {
    commands.push(["cmake", "--build", "build"] as const);
  }
  if (has(files, "build/CTestTestfile.cmake")) {
    commands.push(["ctest", "--test-dir", "build", "--output-on-failure"] as const);
  }
  // 静态分析需要编译数据库；没有 compile_commands.json 时这两条命令没有可分析的目标。
  if (has(files, "build/compile_commands.json")) {
    if (has(files, ".clang-tidy")) {
      commands.push(["run-clang-tidy", "-p", "build"] as const);
    }
    if (has(files, ".cppcheck")) {
      commands.push([
        "cppcheck",
        "--project=build/compile_commands.json",
        "--error-exitcode=1",
      ] as const);
    }
  }
  commands.push(...clangFormatTargetCommand(files, makeTargets));
  return commands;
}

/** Bazel：根上有 MODULE.bazel / WORKSPACE 才发命令；这是项目显式声明的构建入口。 */
function bazelGateCommands(files: readonly string[]): readonly GateCommand[] {
  return hasAny(files, BAZEL_FILES) ? [["bazel", "test", "//..."] as const] : [];
}

/** C#：有测试工程就 dotnet test（顺带构建）；否则构建 solution 或唯一的 csproj。 */
function csharpGateCommands(files: readonly string[]): readonly GateCommand[] {
  const csproj = files.filter((name) => CSHARP_PROJECT_FILE.test(name));
  const hasProject = files.some((name) => DOTNET_SOLUTION_FILE.test(name)) || csproj.length === 1;
  const commands: GateCommand[] = [];
  if (has(files, ".editorconfig") && hasProject) {
    commands.push(["dotnet", "format", "--verify-no-changes", "--nologo"] as const);
  }
  if (csproj.some((name) => DOTNET_TEST_PROJECT.test(name))) {
    commands.push(["dotnet", "test", "--nologo"] as const);
  } else if (hasProject) {
    commands.push(["dotnet", "build", "--nologo"] as const);
  }
  return commands;
}

/** PHP：有 composer 的 test 脚本时优先跑脚本；否则 composer validate 保底；phpunit 只认配置。 */
function phpGateCommands(entry: ProjectRoot): readonly GateCommand[] {
  const { files, composerScripts } = entry;
  const commands: GateCommand[] = [];
  if (has(files, COMPOSER)) {
    if (composerScripts?.includes("test") === true) {
      commands.push(["composer", "run-script", "test"] as const);
    } else {
      commands.push(["composer", "validate", "--no-check-publish"] as const);
    }
  }
  if (hasAny(files, PHP_CS_FIXER_CONFIGS)) {
    commands.push(["php-cs-fixer", "fix", "--dry-run", "--diff"] as const);
  }
  if (hasAny(files, PHPSTAN_CONFIGS)) {
    commands.push(["phpstan", "analyse"] as const);
  }
  if (hasAny(files, PSALM_CONFIGS)) {
    commands.push(["psalm"] as const);
  }
  if (hasAny(files, PHPUNIT)) {
    commands.push(
      has(files, "vendor/bin/phpunit") ? (["vendor/bin/phpunit"] as const) : (["phpunit"] as const),
    );
  }
  return commands;
}

/** 可选的供应链扫描：只在配置打开 securityAudit 时追加，默认不碰网络。 */
function securityGateCommands(files: readonly string[]): readonly GateCommand[] {
  const commands: GateCommand[] = [];
  if (has(files, PKG)) {
    if (has(files, "package-lock.json") || has(files, "npm-shrinkwrap.json")) {
      commands.push(["npm", "audit", "--audit-level=high", "--omit=dev"] as const);
    } else if (has(files, "pnpm-lock.yaml")) {
      commands.push(["pnpm", "audit", "--audit-level=high", "--prod"] as const);
    }
  }
  if (has(files, CARGO) && has(files, "Cargo.lock")) {
    commands.push(["cargo", "audit"] as const);
  }
  if (has(files, GO)) {
    commands.push(["govulncheck", "./..."] as const);
  }
  if (has(files, REQUIREMENTS)) {
    commands.push(["pip-audit", "-r", REQUIREMENTS] as const);
  }
  if (has(files, "Gemfile.lock")) {
    commands.push(["bundler-audit", "check", "--update"] as const);
  }
  if (has(files, "composer.lock")) {
    commands.push(["composer", "audit"] as const);
  }
  return commands;
}

/** 内置语言门禁；只在项目没有声明门禁时调用。供应链扫描不在这里，见 gatesForRoot。 */
function builtinGates(entry: ProjectRoot): readonly Gate[] {
  const { root, files } = entry;
  const commands = [
    ...jsGateCommands(entry),
    ...rustGateCommands(files),
    ...goGateCommands(files),
    ...pythonGateCommands(entry),
    ...rubyGateCommands(files, entry.rakeTargets),
    ...javaGateCommands(entry),
    ...cppGateCommands(files, entry.makeTargets),
    ...bazelGateCommands(files),
    ...csharpGateCommands(files),
    ...phpGateCommands(entry),
    ...makeTestCommands(entry),
  ];
  // 单个根内部的命令按上面的分支构造，天然不重复；跨根/重复根的 root+command 去重
  // 统一由 detectGate 负责（一个来源，避免两处各去重一遍）。
  return commands.map((command) => ({ root, command }));
}

/** 根据 ProjectRoot 判断该根要跑的门禁（项目声明最多一条；否则内置可多条）。 */
function gatesForRoot(
  entry: ProjectRoot,
  extraScripts: readonly string[],
  options: DetectOptions,
): readonly Gate[] {
  const declared = declaredProjectGate(entry, extraScripts);
  const base = declared === undefined ? builtinGates(entry) : [declared];
  // 供应链扫描是独立的一层，不跟着项目声明被压掉：声明通常只覆盖 lint/测试，
  // 不附带依赖漏洞扫描，所以 securityAudit 打开后即便有声明也照跑。
  const audits =
    options.securityAudit === true
      ? securityGateCommands(entry.files).map((command) => ({ root: entry.root, command }))
      : [];
  return [...base, ...audits];
}

/** `detectGate` 的选配。 */
export interface DetectOptions {
  /** 打开后追加供应链扫描（npm/pnpm audit、cargo audit、govulncheck、pip-audit 等），默认关闭。 */
  readonly securityAudit?: boolean;
}

/**
 * 多个根一起探测：每个根独立判断，没有清单文件的根跳过。
 *
 * 项目自己声明了 check 的根只产出一条项目门禁；没有声明时，同一个根可以产出多条语言门禁
 * （例如 package.json + Cargo.toml 的混合仓），按 root+command 去重。
 *
 * @param roots - 候选项目根
 * @param extraScripts - 用户配置的额外脚本名（只会匹配到本根 package.json 真声明过的那些）
 * @param options - 内置探测的选配（目前只有供应链扫描开关）
 */
export function detectGate(
  roots: readonly ProjectRoot[],
  extraScripts: readonly string[] = [],
  options: DetectOptions = {},
): Gate[] {
  const out: Gate[] = [];
  // 同一个 root 重复出现时按 root+command 去重，不假定调用方已经去过重（本函数是导出的公共接口）。
  const seen = new Set<string>();
  for (const entry of roots) {
    for (const gate of gatesForRoot(entry, extraScripts, options)) {
      const key = `${gate.root}\u0000${gate.command.join("\u0000")}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(gate);
      }
    }
  }
  return out;
}
