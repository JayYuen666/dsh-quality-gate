// test/host-freshness.ts —— host 侧产物是否最新的一次比对（多个包共用，每个包一份副本，和 client-freshness.ts 一样）。
// 本包副本的做法：只提供**比对材料**（磁盘上的 host 产物与本次内存构建的产物，加上包名和包根），
// 用例的注册留在 test/build-host.test.ts 的 describe 里。共享的辅助文件一旦自己调用 it()，它就成了
// 一个用例文件，vitest 的结构类规则（require-hook / consistent-test-it / valid-title）就全部落到这个
// 辅助文件上。
//
// 背景：改了 host.ts 或 lib/*.ts 却忘了跑 node build-host.mjs，dsh 载入的还是旧的 host.js。client 那边
// 早就有这一项门禁（test/client-freshness.ts），host 这边此前一份都没有，于是真的漏过一次：
// danger-guard/host.js 的生成时间早于 host.ts 的下一次改动——产物已经过期，而没有任何检查会报出来。
// settings.js 由同一个 builder 的另一个导出产生，同样没人核对，所以它走同一项检查。
// 用 mtime 判断在 git clone 或 touch 之后不可靠，所以改成比**内容**：内存里构建（build-host.mjs 的纯函数
// 导出，不写文件）与磁盘产物按字节比对。源码有任何改动而没重新构建 → 字节一定不同 → 测试失败。
//
// 用法（各包 test/build-host.test.ts 的比对用例里）：
//   const evidence = await hostFreshnessEvidence(import.meta.url)
//   —— 自动定位 ../host.js 与 ../build-host.mjs 里的 buildHost()。第二个参数指明"另一个导出 +
//   另一个产物文件"：danger-guard 的设置那一半用 builder: buildSettings、artifact: settings.js，
//   两个产物各比一次字节。导出的名字不在这里统一，因为改 builder 的导出内容比把选项写清楚代价更大。
//
// 按返回形态自适应：构建函数返回字符串 → 单文件按字节比；返回"写盘路径 → 正文"的 Map（shared 的多
// 入口 dist 产物，它根本不产 host.js，这一项门禁不为它硬造一个）→ 两边都折成按路径排序的
// "相对路径 + 正文摘要"清单再比。摘要只当作字节的身份（摘要相同就是字节相同），换来的是失败时十几行、
// 每行点出一个产物的 diff，而不是几十 KB 正文并排放着。
//
// 注意：构建函数必须是确定的构建（同样的输入得到同样的输出）。各包的 build-host.mjs 实测同一进程内跑两次
// 字节一致（rolldown 的 [hash] 是内容哈希，不含时间戳或随机数），所以按字节相等这个判断成立；以后构建
// 引入不确定性，就要改成规范化后的哈希比较，并在 build-host.mjs 里输出规范化的形式。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 比对需要的两份产物，加上包名和包根（消息里标出是哪个包、该跑哪条修复命令，两边来源一致）。 */
export interface HostFreshnessEvidence {
  readonly pkgName: string;
  readonly pkgDir: string;
  readonly onDisk: string;
  readonly built: string;
}

/** 这一项门禁认哪个导出、比哪个产物（默认 buildHost() 与包根下的 host.js）。 */
export interface HostFreshnessOptions {
  /** build-host.mjs 里的具名导出（danger-guard 设置那一半是 buildSettings）。 */
  readonly builder?: string;
  /** 包根下的产物文件（danger-guard 设置那一半是 settings.js）。 */
  readonly artifact?: string;
}

const DEFAULT_BUILDER = "buildHost";
const DEFAULT_ARTIFACT = "host.js";

/** 磁盘上没有这份产物时用的占位正文：让失败出现在比对里，而不是出现在 ENOENT 的调用栈里。 */
const ABSENT = "[产物缺失：运行 node build-host.mjs]";

/**
 * 读一份文本产物；不存在或者读不了（包括路径是目录时的 EISDIR）就返回缺失占位。
 * @param file - 绝对路径
 * @returns 正文，或者 ABSENT
 */
function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    // 先 existsSync 再读之间存在时间窗口，而且目录能通过存在性检查、随后抛 EISDIR；
    // 统一处理成缺失占位，让失败出现在比对里，而不是出现在文件系统的调用栈里。
    return ABSENT;
  }
}

/**
 * 一份正文的字节身份。
 * @param text - 产物正文
 * @returns sha256 十六进制
 */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 取包名：解析 package.json 顶层的 name；读不到或者形状不对时改用目录名。
 * @param pkgDir - 包根的绝对路径
 * @returns 包名（用来在消息里标出是哪个包）
 */
function packageNameOf(pkgDir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(path.resolve(pkgDir, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return typeof manifest.name === "string" && manifest.name !== ""
      ? manifest.name
      : path.basename(pkgDir);
  } catch {
    // 用正则抠第一个 "name" 会命中子对象里的同名键；解析失败时用目录名，至少不会是一个无意义的 [unknown]。
    return path.basename(pkgDir);
  }
}

/**
 * 多个产物的形态：把清单折成按路径排序的"相对路径 + 正文摘要"文本，两边用同一个排序。
 * @param pkgName - 包名（消息里标身份）
 * @param pkgDir - 包根的绝对路径（转成相对路径是为了让清单不绑定某台机器的安装位置）
 * @param files - 构建函数返回的"写盘绝对路径 → 正文"
 * @param fromDisk - 为 true 时逐个读盘算摘要（文件缺失时摘要自然不同，行里已经点出是哪个产物）
 * @returns 可以直接和另一边按字节相等的清单文本
 */
function manifestOf(
  pkgName: string,
  pkgDir: string,
  files: ReadonlyMap<unknown, unknown>,
  fromDisk: boolean,
): string {
  const rows: string[] = [];
  const entries = Array.from(files.entries(), ([file, code]): [string, string] => [
    String(file),
    typeof code === "string" ? code : String(code),
  ]);
  for (const [file, code] of entries.toSorted(([left], [right]) => left.localeCompare(right))) {
    const identity = fromDisk ? digestOf(readText(file)) : digestOf(code);
    rows.push(`${path.relative(pkgDir, file)}\t${identity}`);
  }
  // 一条都没有时两边都折成 "\n"，按字节相等 —— 空清单会被读成"是最新的"。构建函数返回空 Map
  // （入口配错，或者打包器没产出 chunk）恰恰是产物坏了的表现，必须当场失败而不是放过。
  if (rows.length === 0) {
    throw new TypeError(
      `[${pkgName}] 构建函数交回了空的产物清单：两侧都为空会逐字节相等而漏报，这项门禁无从比对。`,
    );
  }
  return `${rows.join("\n")}\n`;
}

/**
 * 取比对需要的材料：磁盘上的 host 产物与本次内存构建的产物（构建只在内存里跑，不写文件）。
 * @param testFileUrl - 调用方用例文件的 import.meta.url
 * @param options - 指明 builder 和 artifact（默认 buildHost() 与包根下的 host.js）
 * @returns 两份产物的文本，加上包名与包根
 */
export async function hostFreshnessEvidence(
  testFileUrl: string,
  options: HostFreshnessOptions = {},
): Promise<HostFreshnessEvidence> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const builder = options.builder ?? DEFAULT_BUILDER;
  const artifact = options.artifact ?? DEFAULT_ARTIFACT;
  const pkgName = packageNameOf(pkgDir);
  // 动态导入 .mjs 在 TS 里是 any，先收窄成可调用形式再 await（避免 no-unsafe-*）。
  // import() 只收 URL 或说明符：Windows 上裸 `C:\…` 会被当成协议 `c:` 解析而抛
  // ERR_UNSUPPORTED_ESM_URL_SCHEME，所以一律经 pathToFileURL。
  const mod = (await import(
    pathToFileURL(path.resolve(pkgDir, "build-host.mjs")).href
  )) as unknown as Record<string, unknown>;
  // 用 Object.hasOwn：动态导入得到的对象在 mock 或代理下可能带原型成员，直接用下标会取到
  // toString 之类可调用的值，绕过下面"没有可调用的导出"这个判断。
  const build = Object.hasOwn(mod, builder) ? mod[builder] : undefined;
  if (typeof build !== "function") {
    throw new TypeError(
      `[${pkgName}] build-host.mjs 没有可调用导出 ${builder}：门禁的 builder 选项必须指它真实导出的名字。`,
    );
  }
  // 动态导入得到的类型被收窄成 any：调用前把签名写回来，返回值仍然要在运行期校验形状。
  const built: unknown = await (build as () => Promise<unknown>)();
  if (typeof built === "string") {
    // builder 返回空串、磁盘上又恰好是个空文件时，两边按字节相等——那不是"最新"，是没有产出。
    if (built === "") {
      throw new Error(`[${pkgName}] 构建函数交回了空串产物：空产物与空文件相等，门禁无从比对。`);
    }
    return { pkgName, pkgDir, onDisk: readText(path.resolve(pkgDir, artifact)), built };
  }
  // 类型在这里写成 Map，但构建脚本是动态导入的，运行时的形状不受 TS 约束：
  // undefined、数组、普通对象都会被下面的 entries() 和 toSorted 当成清单来用，得出没有意义的结论。
  if (!(built instanceof Map)) {
    throw new TypeError(
      `[${pkgName}] 构建函数 ${builder} 的返回值既不是字符串也不是 Map：门禁无法把 ${typeof built} 当作产物比对。`,
    );
  }
  // 多产物的分支：由 builder 自己决定写哪些文件、用什么路径，这时候 `artifact` 没有意义。
  // 还传进来就是配置错误（常见于从单文件形态改过来却忘了删掉），静默忽略会让调用方以为
  // 在比某个具体产物。默认值放过，不是默认值就当场报错。
  if (artifact !== DEFAULT_ARTIFACT) {
    throw new TypeError(
      `[${pkgName}] builder ${builder} 返回的是多产物清单，此时 artifact 选项（${artifact}）不适用：` +
        "要比哪个产物请直接用单文件 builder，或从清单里自己挑。",
    );
  }
  // 磁盘侧的清单用构建返回的 Map 的 key 反着生成 —— 只管"这次构建会产出的那些文件"。
  // 磁盘上多出来的旧产物（builder 已经删掉的入口）不在这份名单里，这一项检查看不见它们；
  // 清理残留由 pack-check 的发布产物清单负责，不在这里。
  return {
    pkgName,
    pkgDir,
    onDisk: manifestOf(pkgName, pkgDir, built, true),
    built: manifestOf(pkgName, pkgDir, built, false),
  };
}
