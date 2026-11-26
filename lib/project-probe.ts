// lib/project-probe.ts —— 从磁盘上的一个目录读出 gate-detect 需要的项目画像。
//
// 为什么单列：host.ts 顶着 `eslint/max-lines` 的 2000 行预算，而项目根探测是自成一体的
// 文件系统读取（清单、脚本、Python 配置段、Make 目标、嵌套构建标记），不依赖宿主上下文。
// 这里只如实登记读到的事实，不决定跑哪条门禁——选择策略仍在 lib/gate-detect.ts。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import type { ProjectRoot } from "./gate-detect.ts";
import {
  MANIFESTS,
  PKG_MANIFEST,
  PYPROJECT_MANIFEST,
  ROOT_MARKERS,
  TSCONFIG_MANIFEST,
} from "./project-manifests.ts";

/**
 * scripts 里的一条值算不算"声明了这条脚本"。
 *
 * 字符串（package.json 的常规写法）与**非空字符串数组**（composer 的常规写法）都算；其它
 * 形状（null、数字、空数组、混合类型）一律不算——那种值跑不起来，把它算成声明只会让
 * gate-detect 发出一条注定失败的命令。
 */
function isDeclaredScriptBody(body: unknown): boolean {
  if (typeof body === "string") {
    return body.length > 0;
  }
  return (
    Array.isArray(body) &&
    body.length > 0 &&
    body.every((item: unknown) => typeof item === "string" && item.length > 0)
  );
}

/**
 * 根清单里已声明的 scripts 名（值的形状见 isDeclaredScriptBody）。
 *
 * 读不到、JSON 不合法、没有 scripts 字段 → **undefined（"没有信息"）**，由 gate-detect
 * 按保守的做法处理（不发 pnpm check）。不在这里替项目猜：猜错的代价是注入一次假失败。
 */
function declaredScriptsOf(
  root: string,
  manifest: string = PKG_MANIFEST,
): readonly string[] | undefined {
  let names: readonly string[] | undefined;
  try {
    // JSON.parse 返回 any：先经 unknown，再用守卫取需要的部分（不写 unsafe 断言）
    const raw: unknown = JSON.parse(readFileSync(path.join(root, manifest), "utf8"));
    const scripts = fieldOf(raw, "scripts");
    // scripts 不是对象（缺字段，或者 `"scripts": 42`）和读失败按同一种情况处理：names 保持 undefined，
    // 也就是"没有信息"——不替项目猜一条门禁命令。
    if (isRecord(scripts)) {
      names = Object.entries(scripts)
        .filter(([, body]) => isDeclaredScriptBody(body))
        .map(([name]) => name);
    }
  } catch {
    // 读不到或 JSON 不合法：如实留 undefined，让 gate-detect 走"宁可不给门禁命令"的保守做法
    names = undefined;
  }
  return names;
}

/**
 * pyproject 里 ruff 段头的字面写法：`[tool.ruff]` 或者它的子表 `[tool.ruff.lint]` 等。
 *
 * `^` 加 `m` 旗标限定为行首；`[tool.ruff]` 和 `[tool.ruff.<子表>]` 都要认——只写子表、
 * 不写父表的 pyproject 是常见写法。数组表（`[[tool.ruff...]]`）同样命中段名，一并算声明。
 */
const RUFF_SECTION = /^\[\[?tool\.(?:"ruff"|ruff)[\].]/mu;

/**
 * 根 pyproject.toml 里是否声明了 ruff 的配置段（段头的写法见 RUFF_SECTION）。
 *
 * 只按行首段头做字面匹配，不引入 TOML 解析器：这里只需要回答"有没有这一段"，而段头在
 * TOML 里必须独占一行（行内写法 `[a.b] c = 1` 是非法的），所以行首匹配和解析器的结果一致。
 * 带引号的键写法（`[tool."ruff"]`）在 TOML 里合法且等价，也认。
 *
 * 读不到 / 解码失败 → undefined（"没有信息"），由 gate-detect 按保守的做法处理：不发 ruff
 * 门禁。这里和 declaredScriptsOf 取同一个方向，理由见 gate-detect 的 ruffGateReady。
 */
function ruffConfiguredOf(root: string): boolean | undefined {
  let configured: boolean | undefined;
  try {
    const text = readFileSync(path.join(root, PYPROJECT_MANIFEST), "utf8");
    configured = RUFF_SECTION.test(text);
  } catch {
    configured = undefined;
  }
  return configured;
}

/**
 * ruff.toml / .ruff.toml 里的 `[format]` 段（ruff 的格式化配置载体）。
 *
 * pyproject 用 `[tool.ruff.format]`；独立 ruff.toml 用顶层 `[format]`（也允许子表
 * `[format.<子表>]`）。两种写法都只做行首段头匹配，理由同 RUFF_SECTION。
 */
const RUFF_FORMAT_PYPROJECT = /^\[\[?tool\.(?:"ruff"|ruff)\.format[\].]/mu;
const RUFF_FORMAT_TOOL = /^\[format[\].]/mu;

/** 读一个可选文件；读不到（不存在/是目录）就返回 undefined，不抛错。 */
function readIfPresent(file: string): string | undefined {
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = undefined;
  }
  return text;
}

/**
 * 根上是否显式配置了 ruff 的格式化器（`[tool.ruff.format]` / `[format]`）。
 *
 * 为什么要单独登记：`ruff check` 与 `ruff format --check` 是两条门禁，配了 lint 段不等于
 * 用了格式化器。只凭"有 ruff 段"就追加 `ruff format --check .`，会把一个从没启用格式化、
 * 却声明了 lint 配置的项目整片判红——那是本包明令禁止的假失败。缺信息时返回 undefined，
 * gate-detect 按"不确定就不发"处理。
 */
function ruffFormatConfiguredOf(root: string): boolean | undefined {
  const texts = [
    readIfPresent(path.join(root, PYPROJECT_MANIFEST)),
    readIfPresent(path.join(root, "ruff.toml")),
    readIfPresent(path.join(root, ".ruff.toml")),
  ].filter((text) => text !== undefined);
  return texts.length === 0
    ? undefined
    : texts.some((text) => RUFF_FORMAT_PYPROJECT.test(text) || RUFF_FORMAT_TOOL.test(text));
}

/** JSONC 文本开头的 BOM；只在入口剥一次，避免把 BOM 带进 JSON.parse。 */
const JSONC_BOM = /^\uFEFF/u;
/** JSONC 的空白字符（不含逗号/括号）；用来判断“逗号后面还有没有实际值”。 */
const JSONC_WHITESPACE = /[\t\n\r ]/u;

/** 扫描器状态：输出缓冲、字符串上下文、转义标记、最近一个尚未闭合的逗号位置。 */
interface JsoncScanState {
  out: string;
  inString: boolean;
  escaped: boolean;
  pendingComma: number;
}

/** 跳过 `//` 行注释，返回下一段起点（换行符本身留给外层复制）。 */
function skipLineComment(source: string, at: number): number {
  let next = at + 2;
  while (next < source.length && source.charAt(next) !== "\n") {
    next += 1;
  }
  return next;
}

/** 跳过块注释，返回下一段起点；未闭合时走到末尾，让 JSON.parse 判错。 */
function skipBlockComment(source: string, at: number): number {
  let next = at + 2;
  while (
    next < source.length &&
    !(source.charAt(next) === "*" && source.charAt(next + 1) === "/")
  ) {
    next += 1;
  }
  return next + 1;
}

/** 复制字符串里的一个字符（含转义）；引号只在未转义时结束字符串。 */
function consumeStringChar(state: JsoncScanState, ch: string): void {
  state.out += ch;
  if (state.escaped) {
    state.escaped = false;
  } else if (ch === "\\") {
    state.escaped = true;
  } else if (ch === '"') {
    state.inString = false;
  }
}

/** 复制字符串外的一个字符；合法 JSON 的逗号只在这里处理，闭合括号前丢掉尾逗号。 */
function consumePlainChar(state: JsoncScanState, ch: string): void {
  if (ch === ",") {
    state.out += ch;
    state.pendingComma = state.out.length - 1;
    return;
  }
  if (ch === "}" || ch === "]") {
    if (state.pendingComma >= 0) {
      state.out = `${state.out.slice(0, state.pendingComma)}${state.out.slice(state.pendingComma + 1)}`;
    }
    state.pendingComma = -1;
    state.out += ch;
    return;
  }
  if (!JSONC_WHITESPACE.test(ch)) {
    state.pendingComma = -1;
  }
  state.out += ch;
}

/**
 * 把 JSONC（tsconfig 允许注释与尾逗号）整理成 `JSON.parse` 能吃的 JSON。
 *
 * 不能只用正则剥注释：行注释与块注释的起始符也可能出现在字符串值里，盲目替换会把合法
 * 配置改成坏 JSON；反过来，注释里出现 `"references": [` 又会被字面匹配当成真实配置。
 * 这里逐字符扫描：字符串里原样保留（含转义），字符串外的行/块注释替换成空白，尾逗号在闭合括号前删掉。
 *
 * @param text - 原始 JSONC
 * @returns 可交给 JSON.parse 的 JSON 文本；原文件本身不合法时仍由 JSON.parse 判错
 */
function stripJsonc(text: string): string {
  const source = text.replace(JSONC_BOM, "");
  const state: JsoncScanState = {
    out: "",
    inString: false,
    escaped: false,
    pendingComma: -1,
  };
  for (let at = 0; at < source.length; at += 1) {
    const ch = source.charAt(at);
    if (state.inString) {
      consumeStringChar(state, ch);
    } else if (ch === '"') {
      state.inString = true;
      state.pendingComma = -1;
      state.out += ch;
    } else if (ch === "/" && source.charAt(at + 1) === "/") {
      at = skipLineComment(source, at);
      state.out += "\n";
    } else if (ch === "/" && source.charAt(at + 1) === "*") {
      at = skipBlockComment(source, at);
      state.out += " ";
    } else {
      consumePlainChar(state, ch);
    }
  }
  return state.out;
}

/**
 * tsconfig.json 是否带非空 `references`（project references）。
 *
 * 用 JSONC 解析而不是正则：tsconfig 允许注释与尾逗号，`JSON.parse` 直接读会整份失败；
 * 只看字面又会被字符串/注释里的 `"references"` 误导。解析失败（坏 JSON）与读不到文件都
 * 返回 undefined，调用方按"没有信息"处理，行为与未加这一判据时一致。
 *
 * @param root - 项目根
 * @returns true/false；读不到或解析不了时 undefined
 */
function tsconfigReferencesOf(root: string): boolean | undefined {
  let references: boolean | undefined;
  try {
    const text = readFileSync(path.join(root, TSCONFIG_MANIFEST), "utf8");
    const parsed: unknown = JSON.parse(stripJsonc(text));
    const refs = isRecord(parsed) ? parsed["references"] : undefined;
    references =
      Array.isArray(refs) &&
      refs.some(
        (entry: unknown) =>
          isRecord(entry) && typeof entry["path"] === "string" && entry["path"].length > 0,
      );
  } catch {
    references = undefined;
  }
  return references;
}

/** Maven 里常见的静态分析插件：pom 出现这些 plugin 时 verify 阶段才会跑到它们。 */
const MAVEN_QUALITY_PLUGIN =
  /<artifactId>(?:maven-checkstyle-plugin|spotbugs-maven-plugin|maven-pmd-plugin|pmd-maven-plugin)</u;

function mavenVerifyConfiguredOf(root: string): boolean | undefined {
  let configured: boolean | undefined;
  try {
    configured = MAVEN_QUALITY_PLUGIN.test(readFileSync(path.join(root, "pom.xml"), "utf8"));
  } catch {
    configured = undefined;
  }
  return configured;
}

/** .NET 的工程文件是通配名（Foo.csproj / Bar.sln），不能写进 MANIFESTS 的精确名表。 */
const DOTNET_PROJECT_FILE = /^.+?\.(?:sln|csproj|fsproj|vbproj)$/iu;

/** 根目录名清单；读不到（权限/不是目录）返回空表（按“没有额外标记”处理）。 */
function rootFileNames(root: string): readonly string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

const ROOT_MARKER_SET: ReadonlySet<string> = new Set(ROOT_MARKERS);

/**
 * 这个目录是不是项目根：`ROOT_MARKERS` 命中，或者里面有 .NET 的 sln/csproj。
 *
 * 用一次 readdir 的名字集做精确匹配，而不是对一百多个清单名逐个 `existsSync`：向上探测每层
 * 都要问一次，逐名 stat 会让"改一个文件"的成本随清单表长度线性增长。名字按目录现量精确
 * 比较（大小写敏感）——与 `existsSync` 在大小写不敏感文件系统上的宽松行为不同，这类
 * "`Package.json` 也当清单"的目录本来就不该被当成项目根。
 */
function hasRootMarker(root: string): boolean {
  return rootFileNames(root).some(
    (name) => ROOT_MARKER_SET.has(name) || DOTNET_PROJECT_FILE.test(name),
  );
}

/** 单个文件向上找最近的、含清单文件的目录；hitDepthLimit 标记是否因为太深而没找到根（供可观察到的 warn）。
 *  maxDepth 来自 Config 的 maxRootDepth（不是 volatile 的部署值）。 */
export function findManifestRoot(
  file: string,
  maxDepth: number,
): { root: string | undefined; hitDepthLimit: boolean } {
  let dir = path.dirname(file);
  let found: string | undefined;
  // 层数上限 <=0 时循环一次都不转：不能静默返回"没找到"，调用方要靠这个标记打 warn。
  let hitDepthLimit = maxDepth <= 0;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (hasRootMarker(dir)) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
    if (depth === maxDepth - 1) {
      hitDepthLimit = true;
    }
  }
  return { root: found, hitDepthLimit };
}

/**
 * 找到最近的含清单目录之后继续向上找 pnpm-workspace.yaml —— workspace 根优先。
 * monorepo 的子包（admin/src/x.ts）应该跑整个工作区的 `pnpm check`，而不是退化成只跑子包的 `tsc`。
 */
export function workspaceRootUpgrade(root: string, maxDepth: number): string {
  let up = path.dirname(root);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (existsSync(path.join(up, "pnpm-workspace.yaml"))) {
      return up;
    }
    const parent = path.dirname(up);
    if (parent === up) {
      break;
    }
    up = parent;
  }
  return root;
}

/** Makefile 里实际声明的目标（只看行首目标名，不解析菜谱；`:=`/`::=`/`=` 是变量赋值，不是目标）。 */
const MAKE_TARGET = /^\s*(?<name>[^\s:#=]+)\s*(?:::(?!=)|:(?![=:]))/gmu;
/** Rakefile 里实际声明的 check/test 任务（只认常见的 task 写法，不执行 Ruby）。 */
const RAKE_TASK = /^\s*task\s+[:'"]?(?<name>check|test)\b[:'"]?/gmu;

function makeTargetsOf(root: string): readonly string[] | undefined {
  let targets: readonly string[] | undefined;
  try {
    const text = readFileSync(path.join(root, "Makefile"), "utf8");
    // 收全部目标名而不是只收 check/test：clang-format 的检查目标（format-check /
    // check-format / clang-format-check）不在那两个字面量里，只收 check/test 会让整条
    // C/C++ 格式门禁永远不可达。
    targets = Array.from(text.matchAll(MAKE_TARGET), (match) => String(match.groups?.["name"]));
  } catch {
    targets = undefined;
  }
  return targets;
}

function rakeTargetsOf(root: string): readonly string[] | undefined {
  let targets: readonly string[] | undefined;
  try {
    const text = readFileSync(path.join(root, "Rakefile"), "utf8");
    targets = Array.from(text.matchAll(RAKE_TASK), (match) => String(match.groups?.["name"]));
  } catch {
    targets = undefined;
  }
  return targets;
}

/** pyproject/setup.cfg/tox.ini 里的 pytest 配置段；pytest.ini 本身就是声明。 */
const PYTEST_PYPROJECT = /^\[tool\.pytest\.ini_options\]/mu;
const PYTEST_SETUP = /^\[tool:pytest\]/mu;
const PYTEST_TOX = /^\[pytest\]/mu;
const MYPY_PYPROJECT = /^\[tool\.mypy\]/mu;
const MYPY_SETUP = /^\[mypy\]/mu;
const BLACK_PYPROJECT = /^\[tool\.black\]/mu;
const PYRIGHT_PYPROJECT = /^\[tool\.pyright\]/mu;
const FLAKE8_SETUP = /^\[flake8\]/mu;
const PYLINT_PYPROJECT = /^\[tool\.pylint\./mu;
/** setup.cfg 的段头：`[pylint]`、`[pylint:xxx]` 等；pyproject 的 `[tool.pylint.…]` 不是这种形状。 */
const PYLINT_SETUP = /^\[pylint[:\].]/mu;

function pytestConfiguredOf(root: string): boolean | undefined {
  let configured: boolean | undefined;
  if (existsSync(path.join(root, "pytest.ini"))) {
    configured = true;
  } else {
    const pyproject = readIfPresent(path.join(root, PYPROJECT_MANIFEST));
    const setup = readIfPresent(path.join(root, "setup.cfg"));
    const tox = readIfPresent(path.join(root, "tox.ini"));
    if (pyproject !== undefined || setup !== undefined || tox !== undefined) {
      configured =
        (pyproject !== undefined && PYTEST_PYPROJECT.test(pyproject)) ||
        (setup !== undefined && PYTEST_SETUP.test(setup)) ||
        (tox !== undefined && PYTEST_TOX.test(tox));
    }
  }
  return configured;
}

/** 「只读 pyproject.toml，按段头正则判有没有配置」的公共形态（black/pyright 及后续同类都走它）。 */
function pyprojectConfiguredOf(root: string, pattern: RegExp): boolean | undefined {
  const pyproject = readIfPresent(path.join(root, PYPROJECT_MANIFEST));
  return pyproject === undefined ? undefined : pattern.test(pyproject);
}

function blackConfiguredOf(root: string): boolean | undefined {
  return pyprojectConfiguredOf(root, BLACK_PYPROJECT);
}

function pyrightConfiguredOf(root: string): boolean | undefined {
  return pyprojectConfiguredOf(root, PYRIGHT_PYPROJECT);
}

function flake8ConfiguredOf(root: string): boolean | undefined {
  const texts = [
    readIfPresent(path.join(root, "setup.cfg")),
    readIfPresent(path.join(root, "tox.ini")),
  ].filter((text) => text !== undefined);
  return texts.length === 0 ? undefined : texts.some((text) => FLAKE8_SETUP.test(text));
}

function pylintConfiguredOf(root: string): boolean | undefined {
  // 两个载体用各自的段头：pyproject 是 `[tool.pylint.…]`，setup.cfg 是 `[pylint]`。
  // 拿 pyproject 的正则去测 setup.cfg 会让后者永远判成"没配置"（pylint 门禁静默消失）。
  const pyproject = readIfPresent(path.join(root, "pyproject.toml"));
  const setup = readIfPresent(path.join(root, "setup.cfg"));
  const pyprojectHit = pyproject !== undefined && PYLINT_PYPROJECT.test(pyproject);
  const setupHit = setup !== undefined && PYLINT_SETUP.test(setup);
  return pyproject === undefined && setup === undefined ? undefined : pyprojectHit || setupHit;
}

function mypyConfiguredOf(root: string): boolean | undefined {
  let configured: boolean | undefined;
  if (existsSync(path.join(root, "mypy.ini")) || existsSync(path.join(root, ".mypy.ini"))) {
    configured = true;
  } else {
    const pyproject = readIfPresent(path.join(root, PYPROJECT_MANIFEST));
    const setup = readIfPresent(path.join(root, "setup.cfg"));
    if (pyproject !== undefined || setup !== undefined) {
      configured =
        (pyproject !== undefined && MYPY_PYPROJECT.test(pyproject)) ||
        (setup !== undefined && MYPY_SETUP.test(setup));
    }
  }
  return configured;
}

/** 根目录上的清单标记：MANIFESTS 命中项 + .NET 通配工程 + 嵌套构建标记 + tsconfig。 */
function rootMarkersOf(root: string): string[] {
  const manifests = MANIFESTS.filter((manifest) => existsSync(path.join(root, manifest)));
  for (const name of rootFileNames(root)) {
    if (DOTNET_PROJECT_FILE.test(name)) {
      manifests.push(name);
    }
  }
  for (const marker of [
    "build/CMakeCache.txt",
    "build/CTestTestfile.cmake",
    "build/compile_commands.json",
    "vendor/bin/phpunit",
    "tests/",
    "test/",
    "src/main/java",
    "src/main/kotlin",
    "config/checkstyle/checkstyle.xml",
    "config/detekt/detekt.yml",
    "config/detekt/detekt.yaml",
  ]) {
    if (existsSync(path.join(root, marker))) {
      manifests.push(marker);
    }
  }
  if (existsSync(path.join(root, TSCONFIG_MANIFEST))) {
    manifests.push(TSCONFIG_MANIFEST);
  }
  return manifests;
}

/** 只在对应清单存在时读取 Python 生态的配置段；缺文件就是“没有配置”，不是 false。 */
function hasAnyManifest(manifests: readonly string[], names: readonly string[]): boolean {
  return names.some((name) => manifests.includes(name));
}

/** 只保留值已确定的字段：缺信息（undefined）的键不进 ProjectRoot，调用方按"未知"处理。 */
function onlyDefined(fields: Record<string, boolean | undefined>): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function pythonConfigOf(
  root: string,
  manifests: readonly string[],
): Pick<
  ProjectRoot,
  | "ruffConfigured"
  | "ruffFormatConfigured"
  | "pytestConfigured"
  | "mypyConfigured"
  | "blackConfigured"
  | "pyrightConfigured"
  | "flake8Configured"
  | "pylintConfigured"
> {
  const ruff = manifests.includes(PYPROJECT_MANIFEST) ? ruffConfiguredOf(root) : undefined;
  const ruffFormat = hasAnyManifest(manifests, [PYPROJECT_MANIFEST, "ruff.toml", ".ruff.toml"])
    ? ruffFormatConfiguredOf(root)
    : undefined;
  const pytest = hasAnyManifest(manifests, [
    PYPROJECT_MANIFEST,
    "setup.cfg",
    "tox.ini",
    "pytest.ini",
  ])
    ? pytestConfiguredOf(root)
    : undefined;
  const mypy = hasAnyManifest(manifests, [PYPROJECT_MANIFEST, "setup.cfg", "mypy.ini", ".mypy.ini"])
    ? mypyConfiguredOf(root)
    : undefined;
  const black = manifests.includes(PYPROJECT_MANIFEST) ? blackConfiguredOf(root) : undefined;
  const pyright = manifests.includes(PYPROJECT_MANIFEST) ? pyrightConfiguredOf(root) : undefined;
  const flake8 = hasAnyManifest(manifests, ["setup.cfg", "tox.ini"])
    ? flake8ConfiguredOf(root)
    : undefined;
  const pylint = hasAnyManifest(manifests, [PYPROJECT_MANIFEST, "setup.cfg"])
    ? pylintConfiguredOf(root)
    : undefined;
  return onlyDefined({
    ruffConfigured: ruff,
    ruffFormatConfigured: ruffFormat,
    pytestConfigured: pytest,
    mypyConfigured: mypy,
    blackConfigured: black,
    pyrightConfigured: pyright,
    flake8Configured: flake8,
    pylintConfigured: pylint,
  });
}

/**
 * 读取一个根在磁盘上的实际情况 → 转成 gate-detect 的入参形状（ProjectRoot）。
 *
 * - 清单名：MANIFESTS 里实际存在的项；
 * - tsconfig.json 不作为"根标记"（不进 MANIFESTS，避免改变向上探测根的语义），
 *   但要进清单集合——gate-detect 用它区分"真 TS 项目"和"只有一个 package.json 的空壳"；
 * - scripts：根 package.json 里已声明的脚本名，交给 gate-detect 判断 pnpm check
 *   能不能用。**这里只如实登记，不做选择**（探测策略集中在纯函数里）；
 * - ruffConfigured：根 pyproject.toml 里是不是真的有 `[tool.ruff]` 开头的那些段，交给 gate-detect
 *   判断 ruff 门禁能不能用。理由同上——只登记，不选择；
 * - ruffFormatConfigured：根上是否显式配置了 ruff 的格式化器（`[tool.ruff.format]` / `[format]`），
 *   它只决定要不要追加 `ruff format --check`，不决定 `ruff check` 那一条。
 */
export function probeProjectRoot(root: string): ProjectRoot {
  const manifests = rootMarkersOf(root);
  // 没有对应清单时不去读脚本/配置（那次 IO 没有意义），缺字段就是“信息未知”。
  const scripts = manifests.includes(PKG_MANIFEST) ? declaredScriptsOf(root) : undefined;
  const composerScripts = manifests.includes("composer.json")
    ? declaredScriptsOf(root, "composer.json")
    : undefined;
  const makeTargets = manifests.includes("Makefile") ? makeTargetsOf(root) : undefined;
  const rakeTargets = manifests.includes("Rakefile") ? rakeTargetsOf(root) : undefined;
  const mavenVerify = manifests.includes("pom.xml") ? mavenVerifyConfiguredOf(root) : undefined;
  const python = pythonConfigOf(root, manifests);
  // 只有存在 tsconfig.json 时才读 references：这条信息只用于决定"要不要发 tsc"。
  const tsconfigReferences = manifests.includes(TSCONFIG_MANIFEST)
    ? tsconfigReferencesOf(root)
    : undefined;
  return {
    root,
    files: manifests,
    ...(scripts === undefined ? {} : { scripts }),
    ...(composerScripts === undefined ? {} : { composerScripts }),
    ...(makeTargets === undefined ? {} : { makeTargets }),
    ...(rakeTargets === undefined ? {} : { rakeTargets }),
    ...(mavenVerify === undefined ? {} : { mavenVerifyConfigured: mavenVerify }),
    ...python,
    ...(tsconfigReferences === undefined ? {} : { tsconfigReferences }),
  };
}
