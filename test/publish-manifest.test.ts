// test/publish-manifest.test.ts —— 发布形态门禁：入口面必须**与发布器无关**地可解析。
//
// 为什么值得一条测试：构建与单测都在源码侧跑绿，而真实故障发生在装出去之后。两类坑都在
// 那一侧。其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——
// pnpm 发布时把它合并到顶层，npm 不合并（npm 会打印
// "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个发布器就发出一个
// import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：**顶层入口自己就
// 完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
//
// 第二组门禁扫注释：日期与轮次编号写下时有用，读的人只会困惑，且没有任何读者能从中重建
// 当时的上下文。只扫注释行与文档；测试夹具里的日期（modifiedAfter 之类的边界值）是数据，
// 角色文档里的日期是内容，两者都不在禁面内。
import { existsSync } from "node:fs";
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
 *   `.../lib/types/index.d.ts:52` 不在禁面内——版本钉住之后人人可查，那是证据不是噪音。
 * - 上游源码仓路径（`packages/…`、`vendor/…`）：消费方拿不到那棵树，等价信息在 installed
 *   产物里。
 * - 复核轮次的口吻（`审计` / `复核` / `旧实现` / `先例` / `拍板` …）：留约束本身，
 *   删掉"当初怎么改错的"。
 *
 * 中文的「本轮」刻意不进门禁：本仓的 `本轮` 绝大多数指**会话轮次**这个产品概念
 * （`剩余预算不足，以下门禁本轮未执行` 是随包发布的模型文案），与工作轮次同形，机器分不开；
 * 要禁只能逐条人工判断，那不是门禁能做到的事。
 */
const FORBIDDEN_IN_COMMENTS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/u,
  /\/(?:Users|home)\/[A-Za-z0-9._-]+/u,
  /\.pnpm\//u,
  /\b(?:W|B|C|M|F|H)\d{1,2}\b/u,
  /\b[\w-]+\.md:\d+/u,
  /\b(?:packages|vendor)\//u,
  /(?:审计|复核|假话|旧注释|旧实现|旧版|曾写|同批|先例|拍板|口径 [A-Z])/u,
];

/** `publishConfig` 里唯一允许出现的字段：可见性与源，都不是入口面。 */
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "registry"]);

/** 遍历时跳过的目录：依赖、产物、以及本门禁刻意不管的面。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "_env",
  "dist",
  ".git",
  // 测试夹具里的日期与轮次编号是数据，不是注释噪音。
  "test",
  "tests",
  "__tests__",
  // 角色文档库：那里的日期是内容（例如下一份威胁报告的时间线）。
  "agents",
]);

/** package.json 里与入口面有关的形状；其余字段本门禁不关心。 */
interface Manifest {
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
 * `files` 里列的每个构建产物都匹配不上任何条目——`files` 覆盖这道断言的集合会空掉，门禁
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
      extension: entry.slice(dot),
    };
  }
  if (!entry.includes(".")) {
    return { kind: "glob", dir: entry, extension: "" };
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
 * 递归收集一条 `exports` 值里的具体目标文件。通配条目（值含 `*`）没有可验证的固定文件。
 *
 * @param value - `exports` 里某一键的值（字符串或条件对象）
 * @returns 该条目要求存在的包内路径
 */
function filesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes("*") ? [] : [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((nested) => filesOf(nested));
  }
  return [];
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
 * 这一面内——它们不在 `files` 里就发不出去，而"文档写了但没随包发布"正好是读者看不到、
 * 门禁又看不见的坑，于是下面单独有一条「根目录每个 .md 都要出现在发布面里」的门禁。
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
 * 递归收集该纳入注释门禁的源文件与文档（相对包根、`/` 分隔）。
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

/**
 * 取一段文本里属于注释或文档的行。文档（`.md`）整体算；代码只取注释行，免得把字符串
 * 字面量里的数据（日期夹具、示例路径）误判成注释噪音。
 *
 * @param file - 相对包根的文件名，用于决定判定口径
 * @param text - 文件全文
 * @returns 参与门禁的行
 */
function commentLines(file: string, text: string): string[] {
  if (file.endsWith(".md")) {
    return text.split("\n");
  }
  return text.split("\n").filter((line) => /^\s*(?:\/\/|\/\*|\*|#)/u.test(line));
}

describe("发布形态", () => {
  it("files 覆盖全部入口目标（换个发布器也不会发出悬空入口）", async () => {
    const { manifest, shipped } = await readSurface();
    const targets = entryFiles(manifest);
    expect(targets.length, "入口面不该是空的").toBeGreaterThan(0);
    for (const target of targets) {
      expect(
        shipped.has(asRelative(target.file)),
        `${target.label} 指向 ${target.file}，但它不在 files 覆盖范围内`,
      ).toBe(true);
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

  it("根目录每个 .md 都在发布面里（写了却没发出去 = 读者看不见）", async () => {
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
 * 随包发布的构建产物扫的这一组：注释会被打包器剥掉，所以产物面上真正会漏出去的是
 * **数据**——日期、本机路径、包管理器的 store 目录名。
 *
 * 刻意不含工作项编号：产物里有 `"M3 5l4 4 4-4"` 这样的 SVG path 数据，「字母+数字」的正则
 * 会把图形指令当编号。编号是注释面的噪音，不是发布物的泄漏。
 */
const FORBIDDEN_IN_ARTIFACTS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/u,
  /\/(?:Users|home)\/[A-Za-z0-9._-]+/u,
  /\.pnpm\//u,
];

/** 产物面扫描覆盖的文件：这两个就是发布物的全部代码面。 */
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
 * 产物文本里引用的裸说明符。
 * @param text - 产物全文
 * @returns 去掉 node: 内建与相对路径后的说明符
 */
function bareSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*"(?<spec>[^"]+)"/gu)) {
    const specifier = match.groups?.["spec"] ?? "";
    if (specifier !== "" && !specifier.startsWith("node:") && !specifier.startsWith(".")) {
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

/**
 * 宿主包在 peer 与 dev 两张表里的并集。`dependencies` 是禁区（见下面那条门禁）：peer 记录
 * 「运行期由宿主提供」，dev 记录「本包编译与测试要用它」，两者都不会被消费方的 profile 安装。
 * 同名键以 peer 表为准，那才是消费方环境里真正提供的那一枚。
 * @param manifest - 解析后的 package.json
 * @returns 宿主包名到版本区间
 */
function hostRanges(manifest: Manifest): Record<string, string> {
  return { ...manifest.devDependencies, ...manifest.peerDependencies };
}

describe("宿主依赖的版本形状（升级防线）", () => {
  it("@deepseek-ai/* 一律不进 dependencies：装出去会在宿主进程里物化第二份", async () => {
    // 钉的是「全绿但宿主瘫痪」这一类坑。本包只要把 @deepseek-ai/* 声明成普通依赖，消费方
    // profile 的 hoisted 安装（`nodeLinker: hoisted`、`autoInstallPeers: false`）就会把这批宿主包
    // 落成**真实目录**，与宿主进程里已加载的那份并存在一起。而 `@deepseek-ai/dsh-tools` 的
    // TOOL_RUNTIME_SCHEDULER 是普通 Symbol（不是 Symbol.for），符号身份按模块实例计算：宿主的
    // dsh-agent-loop 用自己那份的 Symbol 去读由副本挂载出来的 ToolRuntime，拿到 undefined，于是
    // 每一次原生工具调用都抛 "Cannot read properties of undefined (reading 'prepare')"，整个
    // profile 的工具一起失效。构建、类型检查与本包测试在此之前全部照绿，判据只能落在 manifest
    // 面上——所以这条读的就是 `dependencies` 本身，不是 peer ∪ dev：那张表才是被钉的对象。
    const { manifest } = await readSurface();
    const leaked = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@deepseek-ai/"),
    );
    expect(leaked, "这些宿主包会随消费方装进 profile，物化出第二份实例").toStrictEqual([]);
  });

  it("dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不可能发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让消费方在没有测试的
    // 情况下换掉宿主类型面。
    const { manifest } = await readSurface();
    // 过滤出违规项再一次性断言，而不是在循环里按条件 expect：失败时 diff 直接列出
    // 「哪个包钉成了什么」，比逐条抛错更好读。
    const ranged = Object.entries(hostRanges(manifest)).filter(
      ([name, range]) => name.startsWith("@deepseek-ai/dsh-") && !/^\d+\.\d+\.\d+-/u.test(range),
    );
    expect(ranged, "这些 dsh-* 依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("dsh-* 全部与 peer 的 dsh 同版本（不许装出第二份宿主类型）", async () => {
    // 宿主类型面被这些包以 type-only 方式消费；同一个会话里出现两个 dsh-session 的拷贝，
    // nominal 类型（品牌串、投影状态）会开始互相不认，而那不报编译错、只报运行期
    // 「认不出这个 callId」。同版本是让这件事不发生的最小条件。
    const { manifest } = await readSurface();
    const peer = manifest.peerDependencies?.["@deepseek-ai/dsh"];
    expect(peer, "peer 依赖缺失：宿主版本就失去基准了").toBeDefined();
    const hostVersion = (peer ?? "").replace(/^[\^~]/u, "");
    const drifted = Object.entries(hostRanges(manifest)).filter(
      ([name, range]) => name.startsWith("@deepseek-ai/dsh-") && range !== hostVersion,
    );
    expect(drifted, "这些 dsh-* 与宿主 dsh 不同版本").toStrictEqual([]);
  });

  it("engines 与 peer 同基准：dsh 下界即编译目标，node 底线不低于宿主发布线", async () => {
    // engines.dsh 低于编译目标 = 在一个从没跑过的宿主版本上承诺能装；`>=` 与 peer 的
    // 区间算子在这里必须同值，因为要钉的是"最低可装载"，不是"可升级"。
    const { manifest } = await readSurface();
    const peer = manifest.peerDependencies?.["@deepseek-ai/dsh"] ?? "";
    expect(peer, "peer 的 @deepseek-ai/dsh 缺失，engines 失去基准").not.toBe("");
    expect(manifest.engines?.["dsh"], "engines.dsh 缺失").toBe(`>=${peer.replace(/^[\^~]/u, "")}`);
    // 运行时底线取宿主发布线的那一档：产物用到 AbortSignal.any 这类较新 API，声明得比宿主
    // 还低等于承诺一个没人测过的执行环境。
    const node = manifest.engines?.["node"] ?? "";
    const floor = /(?<major>\d+)\.(?<minor>\d+)/u.exec(node);
    expect(
      floor,
      `engines.node 缺失或不含版本号：${node === "" ? "(未声明)" : node}`,
    ).not.toBeNull();
    const major = Number(floor?.groups?.["major"] ?? "0");
    const minor = Number(floor?.groups?.["minor"] ?? "0");
    expect(
      major > 22 || (major === 22 && minor >= 12),
      `engines.node 低于宿主发布线 22.12：${node}`,
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
