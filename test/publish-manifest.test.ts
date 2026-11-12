// test/publish-manifest.test.ts —— 发布形态的门禁：入口声明必须**与用哪个发布器无关**地解析得开。
//
// 为什么值得一条测试：构建与单测都在源码里跑绿，而真实故障发生在装出去之后。两类坑都在那之后：
// 其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——
// pnpm 发布时把它合并到顶层，npm 不合并（npm 会打印
// "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个发布器就发出一个
// import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：**顶层入口自己就
// 完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
//
// 第二组门禁扫注释：日期和轮次编号在写下的当时有用，读的人只会困惑，而且没有人能从中重建
// 当时的上下文。只扫注释行和文档；夹具里的日期（modifiedAfter 这类边界值）是数据，
// 角色文档里的日期是内容，这两种都不在禁止之列。
import { existsSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

/**
 * 注释与文档里禁的指涉：读者无法从中重建上下文、且会随时间失真的东西。
 *
 * - 日期（含只到月份的写法）：写下时有用，读的人只会困惑。
 * - 本机绝对路径与 `.pnpm/`：注释会被打包器原样搬进随包发布的 `host.js`，于是本机用户名
 *   出现在公共 tarball 里。路径段要求以字母数字开头，`<home>` 这类占位写法不命中。
 * - 内部工作项编号（`W4` / `C9` / `M8` 这种「字母+数字」）与 `xxx.md:12` 形态的笔记指针：
 *   编号所属的清单和笔记都不随包发布，读者无从对照。指向**已安装依赖**的那类
 *   `.../lib/types/index.d.ts:52` 不在禁止之列——版本钉住之后人人可查，那是证据不是干扰内容。
 * - 上游源码仓路径（`packages/…`、`vendor/…`）：消费方拿不到那份源码目录树，等价信息在 installed
 *   产物里。
 * - 复核轮次的口吻（`审计` / `复核` / `旧实现` / `先例` / `拍板` …）：留约束本身，
 *   删掉"当初怎么改错的"。
 *
 * 中文的「本轮」刻意不放进这条门禁：本仓的 `本轮` 绝大多数指**会话轮次**这个产品概念
 * （`剩余预算不足，以下门禁本轮未执行` 是随包发布的模型文案），与工作轮次写法相同，机器分不开；
 * 要禁只能逐条人工判断，那不是自动门禁能做到的事。
 */
const FORBIDDEN_IN_COMMENTS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/u,
  /\/(?:Users|home)\/[\w.-]+/u,
  /\.pnpm\//u,
  /\b[WBCMFH]\d{1,2}\b/u,
  /\b[\w-]+\.md:\d+/u,
  /\b(?:packages|vendor)\//u,
  /(?:审计|复核|假话|旧注释|旧实现|旧版|曾写|同批|先例|拍板|口径 [A-Z])/u,
];

/** `publishConfig` 里唯一允许出现的字段：可见性与源，都不是入口字段。 */
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "registry"]);

/** 遍历时跳过的目录：依赖、产物，以及这条门禁刻意不管的范围。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "_env",
  "dist",
  ".git",
  // 夹具里的日期和轮次编号是数据，不是注释里的干扰内容。
  "test",
  "tests",
  "__tests__",
  // 角色文档库：那里的日期是内容（例如下一份威胁报告的时间线）。
  "agents",
]);

/** package.json 里和入口声明有关的那几个字段；其余字段这条门禁不管。 */
interface Manifest {
  readonly version?: string;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly publishConfig?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly engines?: Record<string, string>;
}

/** 一条 `files` 模式的两种形态。 */
type PatternShape =
  /** 目录或后缀模式：列该目录（可递归）下以 `extension` 结尾的文件。 */
  | { readonly kind: "glob"; readonly dir: string; readonly extension: string }
  /** 精确文件名：带点号又无通配的条目是**文件名**（`host.js`），不是后缀过滤。 */
  | { readonly kind: "exact"; readonly file: string };

/**
 * 把 `files` 的一条模式归类。本仓实际用到的只有三种写法：裸文件名、目录名、`dir/*.ext`。
 *
 * 「精确文件名」这一档不能和后缀过滤混为一谈：把 `host.js` 当成 `.js` 后缀过滤，于是
 * `files` 里列的每个构建产物都匹配不上任何条目——`files` 覆盖这道断言的集合会空掉，这条门禁
 * 自己先失效。实测报出来是「main 指向 host.js，但它不在 files 覆盖范围内」。
 *
 * @param entry - `files` 数组里的一项
 * @returns 该模式要列的目录与后缀过滤，或一个精确文件名
 */
function shapeOf(entry: string): PatternShape {
  const dot = entry.lastIndexOf(".");
  const star = entry.indexOf("*");
  if (star !== -1) {
    return {
      kind: "glob",
      dir: entry.slice(0, star).replace(/\/$/u, ""),
      // 点号只在通配符之后（`dir/*.md`）才是后缀过滤；`dist/*` 没有点号，
      // 取 lastIndexOf 会得到 "*"，用它过滤则一条也匹配不到（覆盖断言误红）。
      extension: dot > star ? entry.slice(dot) : "",
    };
  }
  if (!entry.includes(".")) {
    // 无点号条目可能是目录（`docs`）也可能是无扩展名的文件（`LICENSE`）：
    // 一律当目录会把 readdir 打到文件上（ENOTDIR）。
    const full = path.join(pkgDir, entry);
    return existsSync(full) && statSync(full).isDirectory()
      ? { kind: "glob", dir: entry, extension: "" }
      : { kind: "exact", file: entry };
  }
  return { kind: "exact", file: entry };
}

/**
 * 按 `files` 模式列出包内确实存在的文件（相对包根、`/` 分隔）。
 *
 * @param shape - 见 {@link shapeOf}
 * @returns 命中的文件清单
 */
async function expand(shape: PatternShape): Promise<string[]> {
  if (shape.kind === "exact") {
    return existsSync(path.join(pkgDir, shape.file)) ? [shape.file] : [];
  }
  const names = await readdir(path.join(pkgDir, shape.dir), { recursive: shape.dir !== "." });
  return names
    .map((name) => name.split(path.sep).join("/"))
    .filter((name) => shape.extension === "" || name.endsWith(shape.extension))
    .map((name) => path.posix.join(shape.dir, name));
}

/**
 * 递归收集一条 `exports` 值里的目标。通配条目（值含 `*`）保留模式本身，由调用方展开成
 * “至少有一枚随包文件命中”再判——返回空数组会让通配出口完全不被覆盖断言看见。
 *
 * @param value - `exports` 里某一键的值（字符串或条件对象）
 * @returns 该条目要求存在的包内路径（通配条目保留模式）
 */
function filesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((nested) => filesOf(nested));
  }
  return [];
}

/**
 * `exports` 通配目标 → 匹配随包文件名的正则：`*` 展开为任意字符（含 `/`，与发布器语义一致），
 * 其余字符按字面量转义。
 *
 * @param pattern - 去掉 `./` 前缀后的通配目标
 * @returns 用于匹配实际随包文件名的正则
 */
function wildcardPattern(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replaceAll(/[^\w./-]/gu, String.raw`\$&`));
  return new RegExp(`^${escaped.join(".*")}$`, "u");
}

/** 入口目标的相对形态（去掉 `./` 前缀）。 */
function asRelative(target: string): string {
  return target.replace(/^\.\//u, "");
}

/**
 * manifest 里全部需要落地的入口文件：main、types 与每个 exports 具体目标。
 *
 * @param manifest - 解析后的 package.json
 * @returns 目标清单，每项带来源标签以便失败时点名
 */
function entryFiles(manifest: Manifest): readonly { label: string; file: string }[] {
  const flat = Object.entries(manifest.exports ?? {}).flatMap(([specifier, value]) =>
    filesOf(value).map((file) => ({ label: specifier, file })),
  );
  const scalars = [
    ...(typeof manifest.main === "string" ? [{ label: "main", file: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ label: "types", file: manifest.types }] : []),
  ];
  return [...scalars, ...flat];
}

/**
 * 发布器无条件附带的文件：不受 `files` 约束，实测自 `pnpm pack --dry-run` 的清单。
 *
 * 只有这四枚：`package.json`、`LICENSE` 与根目录下 readme 形态的文件（`README.md`、
 * `README.zh-CN.md` 都按前缀命中）。`CHANGELOG.md` 与 `THIRD_PARTY_NOTICES.md` **不在**
 * 这个范围里——它们不在 `files` 里就发不出去，而"文档写了但没随包发布"正好是读者看不到、
 * 门禁又看不见的坑，所以下面单独有一条「根目录每个 .md 都要出现在发布物清单里」的门禁。
 */
const ALWAYS_SHIPPED = ["package.json", "README.md", "README.zh-CN.md", "LICENSE"];

/**
 * 读 manifest 与它应当发出去的文件清单。
 *
 * @returns manifest 本体与 `files` 展开后的集合（含发布器无条件附带的件）
 */
async function readSurface(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  const manifest = JSON.parse(
    await readFile(path.join(pkgDir, "package.json"), "utf8"),
  ) as unknown as Manifest;
  const groups = await Promise.all((manifest.files ?? []).map((entry) => expand(shapeOf(entry))));
  const attached = ALWAYS_SHIPPED.filter((name) => existsSync(path.join(pkgDir, name)));
  return { manifest, shipped: new Set([...groups.flat(), ...attached]) };
}

/**
 * 递归收集该纳入注释门禁的源文件和文档（相对包根、用 `/` 分隔）。
 *
 * @param dir - 当前目录的绝对路径
 * @param prefix - 相对包根的前缀
 * @returns 命中的文件清单
 */
async function collectSources(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // 每个条目一个 promise 再一起等：顺序无关，而顺序相关的写法（循环里 await）在这里既
  // 慢又没有对应的正确性理由——收集的是文件名集合，先返回谁都一样。
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        const nested = await collectSources(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        return nested;
      }
      if (/\.(?:ts|tsx|mjs|yml|md)$/u.test(entry.name)) {
        return [`${prefix}${entry.name}`];
      }
      return [];
    }),
  );
  return groups.flat();
}

/** 代码里可能是注释或字面量的片段：块注释、行注释、三种引号的字面量（含转义）。
 *  一次扫完全文，按"块注释 → 行注释 → 字符串"的优先序取；字符串整体被收进来，所以
 *  `"http://127.0.0.1"` 里的双斜杠不是注释起点，而 `const x = 1; // 2026-10-30` 的行尾
 *  注释会被收成一条。文档（`.md`）与 YAML 不走这里，见 commentLines 的分支。
 */
const COMMENT_TOKEN =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gu;

/**
 * 取一段文本里属于注释或文档的内容。文档（`.md`）整体算；YAML 只认行首 `#`（值里的 `#`
 * 是数据）；代码只取**真正的注释内容**——行尾的双斜杠注释、行内与跨行的块注释都算，字符串与
 * 模板字面量里的同形片段（`"http://127.0.0.1"`）不算。只认"行首即注释符"会把
 * `const x = 1; // 2026-10-30` 这种行尾注释漏过去，日期照样随包发布而这条门禁全部通过。
 *
 * @param file - 相对包根的文件名，用来决定按哪条规则判断
 * @param text - 文件全文
 * @returns 参与这条门禁的注释和文档行
 */
function commentLines(file: string, text: string): string[] {
  if (file.endsWith(".md")) {
    return text.split("\n");
  }
  if (file.endsWith(".yml") || file.endsWith(".yaml")) {
    return text.split("\n").filter((line) => /^\s*#/u.test(line));
  }
  const found: string[] = [];
  for (const match of text.matchAll(COMMENT_TOKEN)) {
    const [token] = match;
    if (token.startsWith("//")) {
      found.push(token.slice(2));
    } else if (token.startsWith("/*")) {
      found.push(...token.slice(2, -2).split("\n"));
    }
  }
  return found.filter((line) => line.trim() !== "");
}

describe("发布形态", () => {
  it("files 覆盖全部入口目标（换个发布器也不会发出悬空入口）", async () => {
    const { manifest, shipped } = await readSurface();
    const targets = entryFiles(manifest);
    expect(targets.length, "入口面不该是空的").toBeGreaterThan(0);
    for (const target of targets) {
      const relative = asRelative(target.file);
      // 通配出口没有固定文件名：要求至少一枚随包文件命中，否则“新增通配出口指向的文件”
      // 可以绕过 files 覆盖断言（package.json 的 `./locale/*.json` 就是这一档）。
      const covered = relative.includes("*")
        ? [...shipped].some((name) => wildcardPattern(relative).test(name))
        : shipped.has(relative);
      expect(covered, `${target.label} 指向 ${target.file}，但它不在 files 覆盖范围内`).toBe(true);
    }
  });

  it("入口一律指向构建产物，源码目录不参与发布", async () => {
    const { manifest } = await readSurface();
    for (const target of entryFiles(manifest)) {
      expect(target.file, `${target.label} 不该指源码`).not.toMatch(/\.tsx?$/u);
    }
  });

  it("publishConfig 只留可见性与源，不留入口覆盖", async () => {
    const { manifest } = await readSurface();
    for (const key of Object.keys(manifest.publishConfig ?? {})) {
      expect(ALLOWED_PUBLISH_CONFIG.has(key), `publishConfig.${key} 会被 npm 忽略`).toBe(true);
    }
  });

  it("根目录每个 .md 都在发布名单里（写了却没发出去 = 读者看不见）", async () => {
    // 只有 readme 形态的文件靠发布器无条件附带；CHANGELOG 与许可证之外的文档都得自己写进
    // `files`，否则"文档在仓库里、不在包里"这种状态没有任何读者能发现。
    const { shipped } = await readSurface();
    const entries = await readdir(pkgDir, { withFileTypes: true });
    const docs = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .toSorted();
    expect(docs.length, "至少要扫到 README").toBeGreaterThan(0);
    const missing = docs.filter((name) => !shipped.has(name));
    expect(missing, "这些文档不会随包发布：把它们加进 package.json 的 files").toStrictEqual([]);
  });
});

/**
 * 随包发布的构建产物要扫这一组：注释会被打包器剥掉，所以产物里真正会漏出去的是
 * **数据**——日期、本机路径、包管理器的 store 目录名。
 *
 * 刻意不含工作项编号：产物里有 `"M3 5l4 4 4-4"` 这样的 SVG path 数据，「字母+数字」的正则
 * 会把图形指令当编号。编号是注释里的噪音，不是发布物的泄漏。
 */
const FORBIDDEN_IN_ARTIFACTS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/u,
  /\/(?:Users|home)\/[\w.-]+/u,
  /\.pnpm\//u,
];

/** 产物扫描覆盖的文件：这两个就是发布物里全部的代码。 */
const SHIPPED_ARTIFACTS = ["host.js", "client.js"];

/**
 * 读一个发布产物。
 * @param name - 包内文件名
 * @returns 文件全文
 */
async function readArtifact(name: string): Promise<string> {
  const file = path.join(pkgDir, name);
  expect(existsSync(file), `${name} 不在盘上：先跑 pnpm run build && pnpm run build:client`).toBe(
    true,
  );
  return readFile(file, "utf8");
}

/** 说明符的包名段：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。 */
function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

/**
 * 读全部发布产物。
 *
 * 一次并发读完，而不是在循环里逐个 await：这一组的顺序无关，并发版既快又没有"半途失败留下
 * 半个集合"的形态。
 * @returns 文件名与全文
 */
async function readArtifacts(): Promise<readonly { file: string; text: string }[]> {
  return Promise.all(
    SHIPPED_ARTIFACTS.map(async (name) => ({ file: name, text: await readArtifact(name) })),
  );
}

/**
 * 由宿主运行时提供的冻结模块（宿主的 PLATFORM_MODULES 表）：卡片产物只留 `require("react")`，
 * 运行期由宿主进程给同一份实例。它们不算"漏声明"——写进 dependencies 反而会让消费方
 * profile 物化出第二份 react、产生两枚模块身份（与 @deepseek-ai/* 物化同一类坑）。
 */
const HOST_PROVIDED_MODULES = new Set(["react"]);

/**
 * 产物文本里引用的裸说明符。
 *
 * 入口形态不止 `from "x"`：`require("x")`、`import("x")`、单引号与模板字面量都合法，只认
 * 双引号 from/import 会让另外那些写法**一个都收不到**，于是"产物引用了未声明的包"这条断言
 * 对着空数组永远通过。这里把三种引导词和两种引号都收进来。
 *
 * @param text - 产物全文
 * @returns 去掉 node: 内建与相对路径后的说明符
 */
function bareSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(
    /(?:from|import|require)\s*\(?\s*(?<quote>["'])(?<spec>[^"']+)\k<quote>/gu,
  )) {
    const specifier = match.groups?.["spec"] ?? "";
    if (
      specifier !== "" &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith(".") &&
      !HOST_PROVIDED_MODULES.has(specifier)
    ) {
      out.push(specifier);
    }
  }
  return out;
}

describe("发布产物的内容面", () => {
  it("构建产物里没有日期、本机路径与 store 目录名", async () => {
    const artifacts = await readArtifacts();
    const hits = artifacts.flatMap((artifact) =>
      artifact.text
        .split("\n")
        .flatMap((line, index) =>
          FORBIDDEN_IN_ARTIFACTS.filter((pattern) => pattern.test(line)).map(
            (pattern) =>
              `${artifact.file}:${index + 1} 命中 ${pattern}：${line.trim().slice(0, 80)}`,
          ),
        ),
    );
    expect(hits, "发布产物里出现了随时间失真的指涉").toStrictEqual([]);
  });

  it("产物里每个裸说明符都在 manifest 里有着落", async () => {
    // 装载期失败长这样：产物 import 了一枚包，而本包既没声明依赖也没声明 peer，宿主 profile
    // 里于是没有它——构建与源码侧的类型检查都不会红（源码侧从 devDependencies 解析得到）。
    // node: 内建除外，其余都必须落在 dependencies ∪ peerDependencies 的某一名下。
    const { manifest } = await readSurface();
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const artifacts = await readArtifacts();
    const dangling = artifacts.flatMap((artifact) =>
      bareSpecifiers(artifact.text)
        .filter((specifier) => !declared.has(packageNameOf(specifier)))
        .map((specifier) => `${artifact.file}: ${specifier} 没有对应的依赖声明`),
    );
    expect(dangling, "产物引用了 manifest 里不存在的包").toStrictEqual([]);
  });
});

/** 宿主 dsh 家族的包名前缀（这一组三条判断都要按它筛，所以收成常量）。 */
const DSH_PREFIX = "@deepseek-ai/dsh-";

describe("宿主依赖的版本形状（升级防线）", () => {
  it("@deepseek-ai/* 一律不进 dependencies：装出去会在宿主进程里物化第二份", async () => {
    // 钉的是「全绿但宿主瘫痪」这一类坑。本包只要把 @deepseek-ai/* 声明成普通依赖，消费方
    // profile 的 hoisted 安装（`nodeLinker: hoisted`、`autoInstallPeers: false`）就会把这批宿主包
    // 落成**真实目录**，与宿主进程里已加载的那份并存在一起。而 `@deepseek-ai/dsh-tools` 的
    // TOOL_RUNTIME_SCHEDULER 是普通 Symbol（不是 Symbol.for），符号身份按模块实例计算：宿主的
    // dsh-agent-loop 用自己那份的 Symbol 去读由副本挂载出来的 ToolRuntime，拿到 undefined，于是
    // 每一次原生工具调用都抛 "Cannot read properties of undefined (reading 'prepare')"，整个
    // profile 的工具一起失效。构建、类型检查和本包测试在此之前全部通过，判断依据只能落在 manifest
    // 上——所以这条读的就是 `dependencies` 本身，不是 peer ∪ dev：那张表才是被固定下来的对象。
    const { manifest } = await readSurface();
    const leaked = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@deepseek-ai/"),
    );
    expect(leaked, "这些宿主包会随消费方装进 profile，物化出第二份实例").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让本包在没有测试的
    // 情况下换掉编译用的宿主类型声明。
    // 只判 dev这一侧 段：它才是本包真正装下来的那一份。peer 记的是「运行期由宿主提供」，
    // 装什么版本由宿主决定，判据在下面那条。
    const { manifest } = await readSurface();
    // 过滤出违规项再一次性断言，而不是在循环里按条件 expect：失败时 diff 直接列出
    // 「哪个包钉成了什么」，比逐条抛错更好读。
    const ranged = Object.entries(manifest.devDependencies ?? {}).filter(
      ([name, range]) =>
        name.startsWith(DSH_PREFIX) &&
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(range),
    );
    expect(ranged, "这些 dsh-* 开发依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 全部同版本（不许装出第二份宿主类型）", async () => {
    // 宿主类型被这些包以 type-only 方式消费；同一次安装里出现两枚 dsh-session 的拷贝，
    // nominal 类型（带类型品牌的串、投影状态）会开始互相不认，而那不报编译错、只报运行期
    // 「认不出这个 callId」。同版本是让这件事不发生的最小条件。
    const { manifest } = await readSurface();
    const dshDev = Object.entries(manifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    expect(
      dshDev.length,
      "至少要有一个固定版本的 dsh-* 开发依赖，否则这条断言没有实际校验作用",
    ).toBeGreaterThan(0);
    const baseline = dshDev[0]?.[1];
    const drifted = dshDev.filter(([, range]) => range !== baseline);
    expect(drifted, `这些 dsh-* 与 ${baseline} 不同版本`).toStrictEqual([]);
  });

  it("peerDependencies 里的 dsh 家族写支持窗口范围，与裸 dsh 逐条同一条", async () => {
    // peer 由宿主拿自己安装的那版去满足：钉成精确版本等于要求两者版本号完全相等，而滚动支持
    // 窗口本来就含三个版本。宿主侧只在 manifest 没有 engines.dsh 时才读 peer（app-boot 的
    // plugin-compatibility 里 engines.dsh 存在即独判），所以这一位是发布元数据的含义问题。
    const { manifest } = await readSurface();
    const bare = manifest.peerDependencies?.["@deepseek-ai/dsh"] ?? "";
    expect(bare, "裸 dsh 的 peer 缺失：支持窗口就失去基准了").toMatch(/^\^/u);
    const offPolicy = Object.entries(manifest.peerDependencies ?? {}).filter(
      ([name, range]) => name.startsWith(DSH_PREFIX) && range !== bare,
    );
    expect(offPolicy, "这些 dsh-* peer 与裸 dsh 不是同一条范围").toStrictEqual([]);
  });

  it("engines 与 peer 同基准：dsh 下界即编译目标，node 底线不低于宿主发布线", async () => {
    // engines.dsh 低于编译目标 = 在一个从没跑过的宿主版本上承诺能装。根表把 peer 与 engines.dsh
    // 写成同一份插入符范围，所以这里要求逐字相等：算子一分叉，宿主装载时的版本判据和编译目标就各说各话。
    const { manifest } = await readSurface();
    const peer = manifest.peerDependencies?.["@deepseek-ai/dsh"] ?? "";
    expect(peer, "peer 的 @deepseek-ai/dsh 缺失，engines 失去基准").not.toBe("");
    expect(manifest.engines?.["dsh"], "engines.dsh 必须与 peer 同一份范围，不能各说各话").toBe(
      peer,
    );
    // 运行时底线取宿主发布线的那一档：宿主自 0.2.2-alpha.2 起声明 `>=24.9.0`，插件声明得比宿主
    // 还低等于承诺一个宿主起不来的执行环境。
    const node = manifest.engines?.["node"] ?? "";
    const floor = /(?<major>\d+)\.(?<minor>\d+)/u.exec(node);
    expect(
      floor,
      `engines.node 缺失或不含版本号：${node === "" ? "(未声明)" : node}`,
    ).not.toBeNull();
    const major = Number(floor?.groups?.["major"] ?? "0");
    const minor = Number(floor?.groups?.["minor"] ?? "0");
    expect(
      major > 24 || (major === 24 && minor >= 9),
      `engines.node 低于宿主发布线 24.9：${node}`,
    ).toBe(true);
  });
});

describe("注释与文档没有内部指涉", () => {
  it("源码与文档的注释里没有日期", async () => {
    const collected = await collectSources(pkgDir, "");
    const sources = collected.toSorted();
    expect(sources.length, "至少要扫到源码文件").toBeGreaterThan(0);
    const texts = await Promise.all(
      sources.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, file), "utf8"),
      })),
    );
    for (const entry of texts) {
      for (const line of commentLines(entry.file, entry.text)) {
        for (const pattern of FORBIDDEN_IN_COMMENTS) {
          expect(
            pattern.test(line),
            `${entry.file} 的注释命中内部指涉 ${pattern}：${line.trim().slice(0, 80)}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("注释扫描器自身", () => {
  const nl = "\n";

  it("行尾的双斜杠注释也参与门禁：日期写在行尾也要被看见", () => {
    const date = "2026-10-30";
    const sample = `const value = 1; // ${date}${nl}const other = 2;`;
    expect(commentLines("probe.ts", sample)).toStrictEqual([` ${date}`]);
  });

  it("字符串字面量里的双斜杠不是注释起点", () => {
    const sample = `const url = "http://127.0.0.1:8420";${nl}const next = 1; // real-comment`;
    expect(commentLines("probe.ts", sample)).toStrictEqual([" real-comment"]);
  });

  it("正则字面量里的引号不影响行尾注释识别", () => {
    const quotes = "\u0022\u0027\u0060";
    const sample = `const re = /[${quotes}]/u;${nl}const after = 1; // trailing-comment`;
    expect(commentLines("probe.ts", sample)).toStrictEqual([" trailing-comment"]);
  });

  it("行内的块注释参与门禁，跨行的块注释按行拆开", () => {
    const sample = ["const a = 1; /* first */", "/* second", " third */", "const b = 2;"].join(nl);
    expect(commentLines("probe.ts", sample)).toStrictEqual([" first ", " second", " third "]);
  });
});

describe("版本与变更记录", () => {
  it("变更记录顶部版本与 package.json 的 version 一致", async () => {
    // 只抬 version 不写条目时，发出去的新版本没有变更记录，而其余门禁全绿。
    const { manifest } = await readSurface();
    if (manifest.version === undefined) {
      throw new Error("package.json 没有 version");
    }
    const changelog = await readFile(path.join(pkgDir, "CHANGELOG.md"), "utf8");
    const top = /^## (?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/mu.exec(changelog)?.groups?.[
      "version"
    ];
    if (top === undefined) {
      throw new Error("CHANGELOG.md 里没有任何版本标题");
    }
    expect(top, "CHANGELOG 顶部版本必须与 package.json 的 version 一致").toBe(manifest.version);
  });
});
