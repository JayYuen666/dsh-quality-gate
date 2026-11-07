// test/client-freshness.ts —— 产物是否是最新构建的比对（多个包共用）。
//
// 背景：改了 src/client-entry.ts 却忘了跑 node build-client.mjs，浏览器会一直加载旧的
// client.js——以前出过这样的事（rescue 的 403 修复没进产物；ctx-observe 补字段时
// 只能靠人工比较时间戳确认）。用 mtime 判断在 git clone 或 touch 之后不可靠，所以改成比
// **内容**：内存里构建一次（buildClient()，纯函数、输出确定）与磁盘上的
// client.js 按字节比对。src 有任何改动而没重新构建 → 字节一定不同 → 测试失败。
//
// 用法（各包 test/build-client.test.ts 的用例里断言）：
//   assert.deepEqual(await clientFreshnessProblems(import.meta.url), []);
//   // 这个辅助函数从用例文件往上找包根（有 build-client.mjs 的那一层），再读 ../client.js
//
// 为什么返回"问题清单"而不是自己注册测试用例：注册是收集阶段要做的事，只能写在用例文件的
// describe/用例里 —— vitest(require-hook) 既不收模块根上的裸调用，也不收 describe
// 体内的裸调用；而断言必须写在用例体内才看得见（vitest(expect-expect)）。
// 空数组表示比对通过，非空数组里的文本就是原来要报的错误信息。
//
// 注意：buildClient() 必须是确定的构建（同样的输入得到同样的输出）。各包的
// build-client.mjs 都不包含时间戳或随机数（rollup 没有 banner 哈希变量），
// 所以按字节相等这个判断成立；以后构建引入不确定性，就要改成规范化后的哈希比较，并在
// build-client.mjs 里输出规范化的形式。

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 包名：manifest 读不到或者没有 name 时改用目录名（错误文本仍然能指出是哪个包）。 */
function packageNameOf(pkgDir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(path.resolve(pkgDir, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return typeof manifest.name === "string" && manifest.name !== ""
      ? manifest.name
      : path.basename(pkgDir);
  } catch {
    return path.basename(pkgDir);
  }
}

/** 比对产物：磁盘上的 client.js 与最新构建按字节一致时返回空数组，否则返回说明。 */
export async function clientFreshnessProblems(testFileUrl: string): Promise<string[]> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  // 往上找真正的包根（有 build-client.mjs 的那一层）。固定取测试文件的上一层时，
  // 用例一旦放进 test/ 的子目录就会读到错误的 package.json 和 client.js（甚至读到上层另一个包的）。
  let pkgDir = testDir;
  while (!existsSync(path.resolve(pkgDir, "build-client.mjs"))) {
    const parent = path.dirname(pkgDir);
    if (parent === pkgDir) {
      return [`[unknown] 无法从 ${testDir} 向上定位到含 build-client.mjs 的包目录`];
    }
    pkgDir = parent;
  }
  const pkgName = packageNameOf(pkgDir);

  let expected: string;
  try {
    // import() 只收 URL 或说明符，不收裸文件系统路径：Windows 上 `C:\…\build-client.mjs`
    // 会被当成协议 `c:` 解析而抛 ERR_UNSUPPORTED_ESM_URL_SCHEME；POSIX 的 `/…` 只是恰好能通过。
    const { buildClient } = (await import(
      pathToFileURL(path.resolve(pkgDir, "build-client.mjs")).href
    )) as {
      buildClient?: () => Promise<string>;
    };
    if (typeof buildClient !== "function") {
      return [
        `[${pkgName}] build-client.mjs 没有可调用导出的 buildClient()，这条按字节比对的检查无法执行`,
      ];
    }
    expected = await buildClient();
  } catch (error) {
    // 加载或者构建抛错时按"没法判断"处理：让这一项以问题清单的形式在这一个用例里失败，
    // 而不是把原始调用栈丢给调用方（那种情况下报错的位置和被检查的产物没有关系）。
    return [`[${pkgName}] 无法执行 ${pkgDir} 的内存构建：${String(error)}`];
  }

  const clientPath = path.resolve(pkgDir, "client.js");
  if (!existsSync(clientPath)) {
    // 产物缺失正是最需要给出可照做指引的一种情况，不要让它变成一句不带路径信息的 ENOENT。
    return [`[${pkgName}] client.js 缺失：请在包目录 ${pkgDir} 运行 node build-client.mjs`];
  }
  const onDisk = readFileSync(clientPath, "utf8");
  return onDisk === expected
    ? []
    : [
        // 不写成 `cd <路径> && node …`：路径里可能有空格（Windows 的 C:\Users\… 尤其如此）和反斜杠，
        // 复制到 POSIX shell 里跑不起来。只说在哪个目录跑哪个脚本，路径单独给。
        `[${pkgName}] client.js 已过期：src/client-entry.ts（或其依赖）变更后未重建。请在包目录 ${pkgDir} 运行 node build-client.mjs`,
      ];
}
