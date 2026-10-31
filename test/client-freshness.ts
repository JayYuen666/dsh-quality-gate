// test/client-freshness.ts —— 产物新鲜度指纹门禁（多包共用）。
//
// 背景：src/client-entry.ts 改后忘跑 node build-client.mjs，浏览器一直加载旧
// client.js——已踩过坑（rescue 403 修复没进产物；ctx-observe 字段补齐
// 曾靠人工时间戳核对）。mtime 断言在 git clone / touch 下不稳定，故用
// **内容指纹**：内存构建（buildClient()，纯函数、确定性输出）vs 磁盘
// client.js 逐字节比对。src 任何变更未重建 → 字节必差 → 红。
//
// 用法（各包 test/build-client.test.ts 的用例里断言）：
//   assert.deepEqual(await clientFreshnessProblems(import.meta.url), []);
//   // helper 从用例文件向上定位包根（含 build-client.mjs 的那一层），再读 ../client.js
//
// 为什么交回「问题清单」而不是自己登记用例：登记是收集期动作，只能发生在用例文件的
// describe/用例里 —— vitest(require-hook) 既不收模块根上的裸调用，也不收 describe
// 体内的裸调用；而断言必须写在用例体内才看得见（vitest(expect-expect)）。
// 空数组即门禁通过，非空元素的文本就是原来的报错信息。
//
// 注意：buildClient() 必须是确定性构建（同输入同输出）。各包的
// build-client.mjs 均不含时间戳/随机数（rollup 无 banner hash 变量），
// 逐字节相等成立；若未来构建引入非确定性，改为规范哈希比较并在
// build-client.mjs 里输出 canonical 形态。

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 包名：manifest 解析失败或缺失时回退到目录名（报错文本仍能指出是哪个包）。 */
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

/** 指纹门禁：磁盘 client.js 与最新构建逐字节一致时返回空数组，否则返回说明。 */
export async function clientFreshnessProblems(testFileUrl: string): Promise<string[]> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  // 向上找真正的包根（含 build-client.mjs 的那一层）。固定取测试文件的上一层时，
  // 用例一旦放进 test/ 子目录就会读到错误的 package.json / client.js（甚至上层另一包）。
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
    // 会被当成协议 `c:` 解析而抛 ERR_UNSUPPORTED_ESM_URL_SCHEME；POSIX 的 `/…` 只是恰好能过。
    const { buildClient } = (await import(
      pathToFileURL(path.resolve(pkgDir, "build-client.mjs")).href
    )) as {
      buildClient?: () => Promise<string>;
    };
    if (typeof buildClient !== "function") {
      return [`[${pkgName}] build-client.mjs 未导出可调用的 buildClient()，指纹门禁无法执行`];
    }
    expected = await buildClient();
  } catch (error) {
    // 加载或构建抛错时按「不可判定」收口：让门禁以问题清单的形式红在这一个用例里，
    // 而不是把原始栈丢给调用方（那时报错位置与被测产物无关）。
    return [`[${pkgName}] 无法执行 ${pkgDir} 的内存构建：${String(error)}`];
  }

  const clientPath = path.resolve(pkgDir, "client.js");
  if (!existsSync(clientPath)) {
    // 产物缺失正是最需要给出可操作指引的一档，不要让它变成裸 ENOENT。
    return [`[${pkgName}] client.js 缺失：请在包目录 ${pkgDir} 运行 node build-client.mjs`];
  }
  const onDisk = readFileSync(clientPath, "utf8");
  return onDisk === expected
    ? []
    : [
        // 不写成 `cd <路径> && node …`：路径里可能有空格（Windows 的 C:\Users\… 尤甚）与反斜杠，
        // 复制到 POSIX shell 里跑不了。只说在哪个目录跑哪个脚本，路径单独给。
        `[${pkgName}] client.js 已过期：src/client-entry.ts（或其依赖）变更后未重建。请在包目录 ${pkgDir} 运行 node build-client.mjs`,
      ];
}
