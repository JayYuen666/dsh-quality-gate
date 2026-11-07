// 忽略 **/*.md 与 **/*.jsonc：文档和带注释的 JSON 由写的人排版，不该被格式化工具重排。
//
// `satisfies OxfmtConfig` 只拦得住值层面的错误（把 ignorePatterns 写成字符串会报 TS2322），
// **拦不住键名拼错**：Oxfmtrc 带 `[k: string]: unknown` 索引签名，拼错的键被当成合法的
// 未知键放过，oxfmt 随后不提示地忽略它。所以本文件进 tsconfig.json 的 include 是这项检查的一半，
// 另一半是改键名时自己对照 oxfmt 的 Oxfmtrc 定义。
import type { OxfmtConfig } from "oxfmt";

export default {
  ignorePatterns: ["**/*.md", "**/*.jsonc"],
  // 和 .gitattributes 的 `* text=auto eol=lf` 是一对：只改一边，Windows runner 上
  // 每个文件都会被 fmt:check 判成未格式化（内容一个字都没差）。这里写死而不是用默认值，
  // 是因为"默认就是 lf"会随版本升级变化，不是本仓自己定下的约定。
  endOfLine: "lf",
} satisfies OxfmtConfig;
