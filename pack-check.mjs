#!/usr/bin/env node
/// <reference types="node" />
// 发布物体检：`pnpm pack` 出来的 tarball 才是消费方拿到的东西。
//
// 为什么值得单独一个脚本：构建与单测都在源码侧跑，看不见发布面这三类坑——
//   ①该发的文件没进去（入口悬空 = 装载即 ERR_MODULE_NOT_FOUND）；
//   ②源码或本地状态目录混进去（体积、隐私，以及"装出去的第二份实现"）；
//   ③产物引用了 manifest 没声明的包（类型检查从 devDependencies 解析得到，装载期宿主却没有）。
// 三条都在真 tarball 上验，而不是在工作区的构建产物上验——后者由 test/publish-manifest.test.ts
// 覆盖，两边口径一致，取证对象不同。
//
// 顶部 node reference：oxlint 对 .mjs 不自动加载 @types/node，缺它整文件按 error 类型误报。
// 取全文一律走 execFileSync + stdout：`tar -xzO` 的内容不落到临时目录，避免"检查器自己往
// 仓库旁边写文件"这类副作用；同步形态也让整脚本没有 Promise 层。
//
// 但本脚本不是零副作用：`pnpm pack` 会触发 package.json 的 `prepack`（build:client + build），
// 于是校验开始前工作区的 client.js / host.js 被重新生成一遍。带来的两个后果要记住——
//   ①它验的是"打包那一刻重新构建出来的产物"，不是此前留在盘上的那份；
//   ②本地未提交的产物改动会被这次重建覆盖（产物是 gitignored 的生成物，覆盖不丢源码）。
// 这也是它同时能查"产物过期"的原因：过期产物在 pack 时就被 rebuild 掉了。
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REACT_RUNTIME_MODULES } from "./build-client.mjs";

const maxBuffer = 32 * 1024 * 1024;

/** 发布器无条件附带的文件（实测自 `pnpm pack --dry-run` 的清单）。 */
const ALWAYS_EXPECTED = ["package.json", "LICENSE", "README.md", "README.zh-CN.md"];

/** 绝不该出现在发布物里的路径前缀：源码面与本地状态面。 */
const FORBIDDEN_ENTRIES = [
  "package/host.ts",
  "package/src/",
  "package/lib/",
  "package/test/",
  "package/node_modules/",
  "package/coverage/",
  "package/pnpm-lock.yaml",
  "package/pnpm-workspace.yaml",
];

/** 产物内容面的禁令：随包发布的产物会原样保留声明处的 JSDoc（实测在 host.js 里），
 *  注释面的噪音由 test/publish-manifest.test.ts 的注释门禁负责；这一面只防随数据出去的东西。 */
const FORBIDDEN_CONTENT = [
  /\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/u,
  // POSIX（/Users、/home）、Windows（C:\Users、\\Users）与 macOS 临时目录（/private/var/folders）
  // 三种构建机路径形态都算泄露：只列 POSIX 那种时，Windows runner 上的产物会静默通过。
  /\/(?:Users|home|private\/var\/folders)\/[A-Za-z0-9._-]+/u,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/u,
  /\\.pnpm\\|\/\.pnpm\//u,
];

/** 随包发布的代码面。 */
const CODE_ARTIFACTS = ["host.js", "client.js"];

/**
 * 跑一条 tar，取回 stdout 文本。
 *
 * `-f` 与档案名由调用方在 argv 里给全：BSD tar 与 GNU tar 都按"第一个非选项是档案"解析，
 * 把成员名拼在档案之前会让 tar 拿成员名当档案读，于是整脚本去读一条不存在的档案。
 * @param {string[]} args
 * @returns {string} stdout
 */
function tar(args) {
  return execFileSync("tar", args, { encoding: "utf8", maxBuffer, timeout: 60_000 });
}

/** 攒问题：一次跑完把所有坑都报出来，而不是撞到第一条就退出。 */
const problems = [];

/**
 * 记一条问题。
 * @param {string} message
 * @returns {void}
 */
function note(message) {
  problems.push(message);
  console.error(`✕ ${message}`);
}

/**
 * 从 JSON.parse 的 unknown 投影为 Record（非对象 → 空对象兜底），避免 any 索引。
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function asRecord(raw) {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  return {};
}

/**
 * 取 exports 值里的具体目标文件（条件对象递归展开；含 `*` 的通配项没有固定文件）。
 *
 * 数组是 Node 的**回退目标**语法（`"exports": { ".": [{ "import": "./host.js" }, "./host.cjs"] }`），
 * 每一项都要收；`asRecord` 对数组返回空对象，靠它递归会把整段目标静默丢掉。
 * @param {unknown} value
 * @returns {string[]}
 */
function exportTargets(value) {
  if (typeof value === "string") {
    return value.includes("*") ? [] : [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((nested) => exportTargets(nested));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(asRecord(value)).flatMap((nested) => exportTargets(nested));
  }
  return [];
}

/** 说明符的包名段：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。 */
function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/** Node 内建模块名（无 `node:` 前缀的写法同样不是包依赖）。 */
const BUILTIN_MODULES = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "string_decoder",
  "timers",
  "tty",
  "url",
  "util",
  "worker_threads",
  "zlib",
]);

/**
 * 产物文本里引用的裸说明符（node: 内建、无前缀内建、相对路径、`#` 子路径导入除外）。
 *
 * 三种引号都要认：rolldown 按源码原样输出引号风格，单引号或模板字面量的 import 在只认
 * `"` 的正则下会被整条漏掉，依赖声明检查于是变成假阴性。`require(...)` 同样要收——
 * client.js 是 CJS 外壳，注入的 require 正是它拿宿主模块的唯一通道。
 * @param {string} text
 * @returns {string[]}
 */
function bareSpecifiers(text) {
  const out = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(?<quote>["'`])(?<spec>[^"'`\n]+)\k<quote>/gu;
  for (const match of text.matchAll(pattern)) {
    const specifier = match.groups?.spec ?? "";
    if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("#")) {
      continue;
    }
    if (specifier.startsWith("node:") || BUILTIN_MODULES.has(packageNameOf(specifier))) {
      continue;
    }
    out.push(specifier);
  }
  return out;
}

/**
 * 清单条目形状：入口都落地、无条件附带项齐、没有不该发的路径。
 * @param {Set<string>} shipped
 * @param {Record<string, unknown>} manifest
 * @returns {void}
 */
function checkSurface(shipped, manifest) {
  // `"exports": "./host.js"`（字符串简写）与 `"exports": ["./a.js", "./b.js"]` 都是合法形态，
  // 只按对象展开会把它们当成空集合，于是 `入口 0 项` 静默通过。
  const exportsValue =
    typeof manifest.exports === "string" || Array.isArray(manifest.exports)
      ? exportTargets(manifest.exports)
      : Object.values(asRecord(manifest.exports)).flatMap((value) => exportTargets(value));
  const targets = [...(typeof manifest.main === "string" ? [manifest.main] : []), ...exportsValue];
  for (const target of targets) {
    const relative = target.replace(/^\.\//u, "");
    if (relative !== "package.json" && !shipped.has(`package/${relative}`)) {
      note(`入口 ${target} 不在发布物里：装载即 ERR_MODULE_NOT_FOUND`);
    }
  }
  for (const name of ALWAYS_EXPECTED) {
    if (!shipped.has(`package/${name}`)) {
      note(`发布器应当无条件附带 ${name}，但它不在清单里`);
    }
  }
  for (const entry of shipped) {
    if (FORBIDDEN_ENTRIES.some((prefix) => entry.startsWith(prefix))) {
      note(`发布物里混进了不该发的路径：${entry}`);
    }
  }
  console.info(`入口 ${targets.length} 项`);
}

/**
 * 依赖形状：宿主包一律不进 dependencies（进了就在宿主进程旁物化第二份类型面）。
 * @param {Record<string, unknown>} manifest
 * @returns {Set<string>} 装载期可解析的包名（dependencies ∪ peerDependencies ∪ 宿主 client 模块表）
 */
function checkDependencies(manifest) {
  const dependencies = asRecord(manifest.dependencies);
  const peers = asRecord(manifest.peerDependencies);
  // tarball 里的 manifest 必须是**已解析**的版本范围：`catalog:` / `workspace:` 是包管理器的
  // 私有协议，pnpm publish 会改写、npm publish 不会（实测 npm pack 把 `catalog:` 原样写进
  // 发布物），消费者装到就是 `EUNSUPPORTEDPROTOCOL`。分发路径不止一条，所以在这里判而不
  // 只靠"记得用 pnpm 发"。
  for (const section of ["dependencies", "peerDependencies"]) {
    const record = section === "dependencies" ? dependencies : peers;
    for (const [name, value] of Object.entries(record)) {
      if (typeof value === "string" && /^(?:catalog|workspace):/u.test(value)) {
        note(`${section}.${name} 在发布物里仍是 ${value}：这个范围没被解析，消费者装不上`);
      }
    }
  }
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith("@deepseek-ai/")) {
      note(`${name} 落进 dependencies，会在宿主进程旁物化第二份宿主类型面`);
    }
  }
  console.info(
    `依赖 ${Object.keys(dependencies).length} 枚 · peer ${Object.keys(peers).length} 枚`,
  );
  // react 家族由宿主的 client 模块表在装载期提供，既不在 dependencies 也不在
  // peerDependencies——外部化之后产物里就是这几条裸 require。不并入这一组的话，
  // 「产物引用了 manifest 没声明的包」这条判据会对着一条正确的 require 报红。
  return new Set([...Object.keys(dependencies), ...Object.keys(peers), ...REACT_RUNTIME_MODULES]);
}

/**
 * 代码面：每个裸说明符都要由本包声明或宿主提供，内容里不许出现日期与本机路径。
 * @param {string} tgz
 * @param {Set<string>} shipped
 * @param {Set<string>} provides
 * @returns {void}
 */
function checkArtifacts(tgz, shipped, provides) {
  let checked = 0;
  for (const name of CODE_ARTIFACTS) {
    if (!shipped.has(`package/${name}`)) {
      continue;
    }
    checked += 1;
    const text = tar(["-xzOf", tgz, `package/${name}`]);
    for (const specifier of bareSpecifiers(text)) {
      if (!provides.has(packageNameOf(specifier))) {
        note(`${name} 引用 ${specifier}，它既不在 dependencies 也不在 peerDependencies`);
      }
    }
    for (const pattern of FORBIDDEN_CONTENT) {
      if (pattern.test(text)) {
        note(`${name} 的发布内容命中 ${pattern}`);
      }
    }
  }
  console.info(`代码面 ${checked} 件`);
}

/**
 * 检一个 tarball。
 * @param {string} tgz
 * @returns {void}
 */
function inspect(tgz) {
  const listed = tar(["-tzf", tgz]);
  const shipped = new Set(listed.split("\n").filter((line) => line !== ""));
  console.info(`发布物：${path.basename(tgz)}（${shipped.size} 项）`);
  const manifest = asRecord(JSON.parse(tar(["-xzOf", tgz, "package/package.json"])));
  checkSurface(shipped, manifest);
  checkArtifacts(tgz, shipped, checkDependencies(manifest));
}

const workDir = await mkdtemp(path.join(tmpdir(), "quality-gate-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", workDir], {
    cwd: import.meta.dirname,
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer,
    timeout: 300_000,
  });
  const packed = await readdir(workDir);
  const tarballName = packed.find((name) => name.endsWith(".tgz"));
  if (tarballName === undefined) {
    note("pnpm pack 没有产出 .tgz");
  } else {
    inspect(path.join(workDir, tarballName));
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}

process.exitCode = problems.length > 0 ? 1 : 0;
if (problems.length === 0) {
  console.info("✓ 发布物体检通过");
}
