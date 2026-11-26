// lib/repo-diagnostics.ts —— 把门禁诊断从「门禁根相对」换算成「仓库根相对」。
//
// forge 的 diff 路径按仓库根给；门禁根可能是 monorepo 子包，直接拿工具输出的路径当 diff 路径
// 会画到不存在的文件上。这里只做路径换算，不碰命令、不猜行号；具体语言的输出形状由
// lib/gate-diagnostics.ts 解析。
import { existsSync } from "node:fs";
import path from "node:path";
import { diagnosticsFor } from "./gate-diagnostics.ts";
import type { TsDiagnostic } from "./gate-detect.ts";

/** 从 start 向上找第一个带 `.git` 的目录；找不到就返回 start。 */
export function repositoryRootOf(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

/** 诊断路径 → 相对仓库根、用 `/` 分隔（forge 的 diff 路径形状）。 */
export function repoRelativeDiagnostics(
  root: string,
  command: readonly string[],
  text: string,
  messageMax: number,
): readonly TsDiagnostic[] {
  const repoRoot = repositoryRootOf(root);
  return diagnosticsFor(command, text, { messageMax }).map((diagnostic) => {
    // Maven 等工具会直接打绝对路径（`/abs/A.java`）；path.resolve 对它是个恒等变换，
    // 但 path.relative 会算出 `../../..` 这种 forge 无法落到 diff 的文件路径。
    const absolute = path.isAbsolute(diagnostic.path)
      ? diagnostic.path
      : path.resolve(root, diagnostic.path);
    const relative = path.relative(repoRoot, absolute);
    const insideRepo = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    return {
      path: insideRepo ? relative.split(path.sep).join("/") : diagnostic.path,
      line: diagnostic.line,
      message: diagnostic.message,
    };
  });
}
