// 忽略 **/*.md 与 **/*.jsonc：文档与带注释的 JSON 由写作的人排版，不该被格式化器重排。
//
// `satisfies OxfmtConfig` 只拦值层面的错（把 ignorePatterns 写成字符串会报 TS2322），
// **拦不住键名拼错**：Oxfmtrc 带 `[k: string]: unknown` 索引签名，拼错的键被当成合法的
// 未知键放过，oxfmt 随后静默忽略它。所以本文件进 tsconfig.json 的 include 是判据的一半，
// 另一半是改键名时自己对照 oxfmt 的 Oxfmtrc 定义。
import type { OxfmtConfig } from "oxfmt";

export default {
  ignorePatterns: ["**/*.md", "**/*.jsonc"],
  // 与 .gitattributes 的 `* text=auto eol=lf` 成对：一侧改另一侧不改，Windows runner 上
  // 每个文件都会被 fmt:check 判成未格式化（内容一字不差）。这里写死而不是吃默认值，
  // 是因为「默认就是 lf」是一条会随升级变化的默认值，不是本仓的约定。
  endOfLine: "lf",
} satisfies OxfmtConfig;
