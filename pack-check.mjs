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
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

/** 产物内容面的禁令：注释会被打包器剥掉，所以这里防的是随数据出去的东西。 */
const FORBIDDEN_CONTENT = [
  /\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/u,
  /\/(?:Users|home)\/[A-Za-z0-9._-]+/u,
  /\.pnpm\//u,
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
 * @param {unknown} value
 * @returns {string[]}
 */
function exportTargets(value) {
  if (typeof value === "string") {
    return value.includes("*") ? [] : [value];
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

/**
 * 产物文本里引用的裸说明符（node: 内建与相对路径除外）。
 * @param {string} text
 * @returns {string[]}
 */
function bareSpecifiers(text) {
  const out = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*"(?<spec>[^"]+)"/gu)) {
    const specifier = match.groups?.spec ?? "";
    if (specifier !== "" && !specifier.startsWith("node:") && !specifier.startsWith(".")) {
      out.push(specifier);
    }
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
  const targets = [
    ...(typeof manifest.main === "string" ? [manifest.main] : []),
    ...Object.values(asRecord(manifest.exports)).flatMap((value) => exportTargets(value)),
  ];
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
 * @returns {Set<string>} 装载期可解析的包名（dependencies ∪ peerDependencies）
 */
function checkDependencies(manifest) {
  const dependencies = asRecord(manifest.dependencies);
  const peers = asRecord(manifest.peerDependencies);
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith("@deepseek-ai/")) {
      note(`${name} 落进 dependencies，会在宿主进程旁物化第二份宿主类型面`);
    }
  }
  console.info(
    `依赖 ${Object.keys(dependencies).length} 枚 · peer ${Object.keys(peers).length} 枚`,
  );
  return new Set([...Object.keys(dependencies), ...Object.keys(peers)]);
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
