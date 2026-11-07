#!/usr/bin/env node
/// <reference types="node" />
// 发布产物核对：`pnpm pack` 打出来的 tarball 才是使用者拿到的东西。
//
// 为什么要单独一个脚本：构建和单元测试都在源码侧跑，看不到发布产物里的这三类问题——
//   ①该发的文件没进去（入口指向不存在的文件 = 装载时就 ERR_MODULE_NOT_FOUND）；
//   ②源码或本地状态目录混进去（体积、隐私，以及"装出去的第二份实现"）；
//   ③产物引用了 manifest 没声明的包（类型检查能从 devDependencies 解析到，装载时宿主那边却没有）。
// 三条都在真的 tarball 上验，而不是在工作区的构建产物上验——后者由 test/publish-manifest.test.ts
// 覆盖，两边的判据一致，只是各自看的东西不同。
//
// 顶部那行 node reference：oxlint 对 .mjs 不自动加载 @types/node，缺它整个文件会被误报成 error 类型。
// 取文件内容一律走 execFileSync + stdout：`tar -xzO` 的内容不落临时目录，避免出现"检查器自己往
// 仓库旁边写文件"这类副作用；用同步形态也是为了让整个脚本没有 Promise 层级。
//
// 但这个脚本不是没有副作用：`pnpm pack` 会触发 package.json 的 `prepack`（build:client + build），
// 于是校验开始之前工作区的 client.js / host.js 会被重新生成一遍。有两个后果要记住——
//   ①它验的是"打包那一刻重新构建出来的产物"，不是之前留在磁盘上的那份；
//   ②本地未提交的产物改动会被这次重建覆盖（产物是 gitignored 的生成物，覆盖不会丢源码）。
// 这也是它能同时查出"产物过期"的原因：过期的产物在 pack 时已经被重新构建了。
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { REACT_RUNTIME_MODULES } from "./build-client.mjs";

const maxBuffer = 32 * 1024 * 1024;

/** 发布器无条件附带的文件（实测自 `pnpm pack --dry-run` 的清单）。 */
const ALWAYS_EXPECTED = ["package.json", "LICENSE", "README.md", "README.zh-CN.md"];

/** 绝不该出现在发布产物里的路径前缀：源码目录与本地状态目录。 */
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

/** 对产物内容的禁止项：随包发布的产物会原样保留声明处的 JSDoc（实测在 host.js 里），
 *  注释里多余的内容归 test/publish-manifest.test.ts 的注释门禁管；这里只防跟着数据一起出去的东西。 */
const FORBIDDEN_CONTENT = [
  /\b(?:19|20)\d{2}-\d{2}(?:-\d{2})?\b/u,
  // POSIX（/Users、/home）、Windows（C:\Users、\\Users）与 macOS 临时目录（/private/var/folders）
  // 三种构建机上的路径写法都算泄露：只写 POSIX 那一种的话，Windows runner 上产物里的泄露会被放过，
  // 不报错。
  /\/(?:Users|home|private\/var\/folders)\/[\w.-]+/u,
  /[A-Za-z]:\\Users\\[\w.-]+/u,
  /\\.pnpm\\|\/\.pnpm\//u,
];

/** 随包发布的代码文件。 */
const CODE_ARTIFACTS = ["host.js", "client.js"];

/**
 * 跑一条 tar，取回 stdout 文本。
 *
 * `-f` 与归档文件名由调用方在 argv 里给全：BSD tar 与 GNU tar 都按"第一个非选项是归档文件"解析，
 * 把成员名拼在归档文件之前会让 tar 拿成员名当归档文件读，于是整个脚本去读一个不存在的归档文件。
 * @param {string[]} args
 * @returns {string} stdout
 */
function tar(args) {
  return execFileSync("tar", args, { encoding: "utf8", maxBuffer, timeout: 60_000 });
}

/** 把问题攒起来：一次跑完把所有问题都报出来，而不是碰到第一条就退出。 */
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
 * 把 JSON.parse 出来的 unknown 转成 Record（不是对象时返回空对象），避免出现 any 索引。
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function asRecord(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  /** @type {Record<string, unknown>} */
  const record = {};
  for (const [key, value] of Object.entries(raw)) {
    record[key] = value;
  }
  return record;
}

/**
 * 取 manifest 的字段。
 *
 * `noPropertyAccessFromIndexSignature` 让 `manifest.exports` 这类属性不能用点号访问，
 * 而 `dot-notation` 又不允许写成字面量下标——用变量作下标是两条规则都允许的写法。
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {unknown}
 */
function fieldOf(record, key) {
  return record[key];
}

/**
 * 取 exports 值里的具体目标文件（条件对象递归展开；含 `*` 的通配项没有固定文件）。
 *
 * 数组是 Node 的**备选目标**写法（`"exports": { ".": [{ "import": "./host.js" }, "./host.cjs"] }`），
 * 每一项都要收进来；`asRecord` 对数组返回空对象，用它递归会把整段目标丢掉而不报错。
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

/** 说明符的包名段：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。
 * @param {string} specifier
 * @returns {string} */
function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
}

/** Node 内建模块名（不写 `node:` 前缀的同样不算包依赖）。
 *  直接用官方的 `builtinModules`：自己写一份名单会漏掉 perf_hooks、tls、v8 这些条目，
 *  把正确的引用报成"未声明的第三方包"；有些条目带 `node:` 前缀，统一去掉之后再比。 */
const BUILTIN_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

/**
 * 产物文本里引用的裸说明符（node: 内建、无前缀内建、相对路径、`#` 子路径导入都除外）。
 *
 * 三种引号都要认：rolldown 按源码原样输出引号风格，单引号或模板字面量的 import 在只认
 * `"` 的正则下会被整条漏掉，依赖声明检查于是变成漏报。`require(...)` 同样要收——
 * client.js 是 CJS 外壳，注入的 require 正是它取宿主模块的唯一通道。
 * @param {string} text
 * @returns {string[]}
 */
function bareSpecifiers(text) {
  const out = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\.\s*resolve\s*\(\s*|\brequire\s*\(\s*)(?<quote>["'`])(?<spec>[^"'`\n]+)\k<quote>/gu;
  for (const match of text.matchAll(pattern)) {
    const { spec: specifier = "" } = match.groups ?? {};
    // 模板字面量里的 `${...}` 是插值而不是说明符：整段收下会产生误报。
    if (
      specifier === "" ||
      specifier.startsWith(".") ||
      specifier.startsWith("#") ||
      specifier.includes("${")
    ) {
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
 * 清单条目的形状：入口文件都在、发布器必附带的文件齐、没有不该发布的路径。
 * @param {Set<string>} shipped
 * @param {Record<string, unknown>} manifest
 * @returns {void}
 */
function checkSurface(shipped, manifest) {
  // `"exports": "./host.js"`（字符串简写）与 `"exports": ["./a.js", "./b.js"]` 都是合法写法，
  // 只按对象展开会把它们当成空集合，于是打印"入口 0 项"却不报错。
  const exportsField = fieldOf(manifest, "exports");
  const mainField = fieldOf(manifest, "main");
  const exportsValue =
    typeof exportsField === "string" || Array.isArray(exportsField)
      ? exportTargets(exportsField)
      : Object.values(asRecord(exportsField)).flatMap((value) => exportTargets(value));
  const targets = [...(typeof mainField === "string" ? [mainField] : []), ...exportsValue];
  if (targets.length === 0) {
    note("manifest 没有可解析的入口（main/exports 缺失或全是通配映射）");
  }
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
 * 依赖的形状：宿主的包一律不进 dependencies（进去了就会在宿主进程旁边再装一份实现）。
 * @param {Record<string, unknown>} manifest
 * @returns {Set<string>} 装载时可以解析的包名（dependencies ∪ peerDependencies ∪ 宿主 client 模块表）
 */
function checkDependencies(manifest) {
  const dependencies = asRecord(fieldOf(manifest, "dependencies"));
  const peers = asRecord(fieldOf(manifest, "peerDependencies"));
  // 宿主那一族按 peer 的 scope 推出来，不写死 @deepseek-ai/：宿主换了 scope 或新增同族依赖时，
  // 这条检查仍然按 manifest 自己声明的内容来判断。
  const peerScopes = new Set(
    Object.keys(peers)
      .filter((name) => name.startsWith("@"))
      .map((name) => packageNameOf(name)),
  );
  // tarball 里的 manifest 必须是**已经解析过**的版本范围：`catalog:` 和 `workspace:` 是包管理器的
  // 私有写法，pnpm publish 会改写、npm publish 不会（实测 npm pack 把 `catalog:` 原样写进
  // 发布产物），使用者装到就是 `EUNSUPPORTEDPROTOCOL`。发出去的路径不止一条，所以在这里判，而不是
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
    if ([...peerScopes].some((scope) => name.startsWith(`${scope}/`))) {
      note(`${name} 落进 dependencies，会在宿主进程旁物化第二份宿主类型面`);
    }
  }
  console.info(
    `依赖 ${Object.keys(dependencies).length} 枚 · peer ${Object.keys(peers).length} 枚`,
  );
  // react 那一组由宿主的 client 模块表在装载时提供，既不在 dependencies 也不在
  // peerDependencies——外部化之后产物里就是这几条裸 require。不并入这一组的话，
  // "产物引用了 manifest 没声明的包"这条检查会对着一行本来正确的 require 报错。
  return new Set([...Object.keys(dependencies), ...Object.keys(peers), ...REACT_RUNTIME_MODULES]);
}

/**
 * 代码文件：每个裸说明符都要由本包声明或者由宿主提供，内容里不许出现日期和本机路径。
 * @param {string} tgz
 * @param {Set<string>} shipped
 * @param {Set<string>} provides
 * @returns {void}
 */
function checkArtifacts(tgz, shipped, provides) {
  let checked = 0;
  for (const name of CODE_ARTIFACTS) {
    if (!shipped.has(`package/${name}`)) {
      // 两件产物都缺席时整段检查会 0 件通过：入口改名/漏发必须在门禁里显形，
      // 否则依赖声明和敏感内容两项检查同时失效。
      note(`产物 ${name} 不在发布物里，依赖声明与内容检查对它失效`);
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
 * 检查一个 tarball。
 * @param {string} tgz
 * @returns {void}
 */
function inspect(tgz) {
  const listed = tar(["-tzf", tgz]);
  // Windows 的 tar 可能输出用反斜杠分隔的条目；清单的比较统一按包内的 `/` 路径写法进行。
  const shipped = new Set(
    listed
      .split(/\r?\n/u)
      .filter((line) => line !== "")
      .map((line) => line.replaceAll("\\", "/")),
  );
  console.info(`发布物：${path.basename(tgz)}（${shipped.size} 项）`);
  const manifest = asRecord(JSON.parse(tar(["-xzOf", tgz, "package/package.json"])));
  checkSurface(shipped, manifest);
  checkArtifacts(tgz, shipped, checkDependencies(manifest));
}

// 输出目录用**本包目录下的相对路径**，不用系统临时目录的绝对路径：Windows 这一支要经
// ComSpec 的 `/c`，cmd 会把命令串里的双引号连同参数一起交给 pnpm，pnpm 于是把
// `"C:\Users\…\Temp\…"` 当成相对路径拼到 cwd 上，报 `Failed to create directory
// D:\a\…\"C:\Users\…"`（os error 123）。自己建的这一段目录名既没有空格也没有引号，参数里就
// 没有需要保护的字符，两个平台可以用同一种写法。
const packDirName = `.pack-tmp-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`;
const packDir = path.join(import.meta.dirname, packDirName);
await mkdir(packDir, { recursive: true });
try {
  /** @type {["ignore", "ignore", "pipe"]} */
  const packStdio = ["ignore", "ignore", "pipe"];
  /** @type {import("node:child_process").ExecFileSyncOptions} */
  const packOptions = {
    cwd: import.meta.dirname,
    stdio: packStdio,
    maxBuffer,
    timeout: 300_000,
  };
  if (process.platform === "win32") {
    // pnpm 在 Windows 上是个 .cmd 包装脚本，execFileSync 不按 PATHEXT 解析（CI 实测报 ENOENT）。
    // 这里显式调用 ComSpec，并把整条命令作为一个参数交给 /c：不走 shell:true 的字符串拼接路径，
    // 也避开 DEP0190。命令串里不再有引号——原因见上面 packDirName 那段说明。
    const { ComSpec } = process.env;
    const comspec = ComSpec ?? "cmd.exe";
    execFileSync(
      comspec,
      ["/d", "/s", "/c", `pnpm pack --pack-destination ${packDirName}`],
      packOptions,
    );
  } else {
    execFileSync("pnpm", ["pack", "--pack-destination", packDirName], packOptions);
  }
  const packed = await readdir(packDir);
  const tarballName = packed.find((name) => name.endsWith(".tgz"));
  if (tarballName === undefined) {
    note("pnpm pack 没有产出 .tgz");
  } else {
    inspect(path.join(packDir, tarballName));
  }
} catch (error) {
  // pack、tar、JSON.parse 任何一步抛错也要走到最后的汇总：除了原始栈还要给出 stderr，
  // 否则 CI 里只剩一句 Command failed。
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
  note(
    `发布物体检执行失败：${error instanceof Error ? error.message : String(error)}${stderr === "" ? "" : `\n${stderr}`}`,
  );
} finally {
  await rm(packDir, { recursive: true, force: true });
}

process.exitCode = problems.length > 0 ? 1 : 0;
if (problems.length === 0) {
  console.info("✓ 发布物体检通过");
}
