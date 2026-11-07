// lib/feedback-content.ts —— 写进记忆网关的那**一行正文**：把门禁失败的证据存下来，供后续会话召回成教训。
//
// 为什么从 lib/gateway-feedback.ts 拆出来：正文怎么写（折成一行、不截断、语言跟随官方 locale 偏好）
// 和"HTTP 怎么发"是两件事，各有各的用法——host 在确认门禁失败后组装这份数据，发送方把它原样
// 放进 body。写在同一个模块里时，看不出这层内容是两边共用的。

import { renderTemplate } from "./messages.ts";
import type { QualityGateMessages } from "./messages.ts";

export interface GateFeedbackInput {
  /** 会话的 cwd（决定这条记忆挂在哪个会话下；缺失时按 'default' 处理）。 */
  cwd?: unknown;
  /**门禁命令的参数数组（g.command；只读——联合字面量元组可以直接用）。 */
  command: readonly string[];
  /** 被门禁的项目根（g.root）。 */
  root: string;
  /**门禁失败的证据文本（runGate 返回的 failure）。 */
  failure: string;
}

/** 把连续空白替换成一个空格并去掉首尾，让这段文本始终是一行。
 *  参数类型写成 `unknown` 而不是 `string`：这里是运行时边界（门禁的执行结果由 spawn 与上游
 *  传回的数据拼出来），类型声明拦不住 undefined 和 null。原先直接调用 `text.replaceAll` 时，
 *  异常会落到 pushFeedbackToMemory 的 catch 里，结果是"门禁失败却一条记忆都没写"，而日志里
 *  只有 "memory feedback skipped" 一句，看起来像网关出了问题。 */
function oneLine(text: unknown): string {
  return typeof text === "string" ? text.replaceAll(/\s+/gu, " ").trim() : "";
}

/**门禁失败 → 记忆正文：正文里的空白先换成单个空格，整段只剩一行（避免换行把一条记录拆成多段）。
 *  三处插值都要过这一步：`failure` 来自被检查仓库的自由文本，`command` 来自配置里的自定义命令，
 *  `root` 可以是任何路径——任何一处带换行或制表符，这条记忆正文就会被 auto-recall 拆成多段。
 *  不截断：截尾会吃掉多根错误里的中间根因；记忆网关的入库限额由网关侧把关，这里送全文。
 *  网关那边控制，这里送完整文本。
 *  正文语言跟随官方 locale 偏好（messages 由调用方按回合取出后传进来）——这段文本会被
 *  auto-recall 注入后续会话的上下文，是给模型读的，不是日志。 */
export function buildFeedbackText(
  { command, root, failure }: GateFeedbackInput,
  messages: QualityGateMessages,
): string {
  // command 来自配置或上游传回的数据，运行期不保证是数组；join 抛错会落到发送方的 catch，
  // 结果是"门禁失败却一条记忆都没写"。
  const args = Array.isArray(command) ? command : [];
  const failureText = oneLine(failure);
  const rootText = oneLine(root);
  // 没有证据正文时不用入库：只剩模板文字的记录会被 auto-recall 带进后续会话，成了干扰内容。
  if (failureText === "") {
    return "";
  }
  const rendered = renderTemplate(messages.memoryFeedback, {
    command: oneLine(args.join(" ")),
    root: rootText,
    failure: failureText,
  });
  // 失败正文来自被检查的仓库，里面可能出现"忽略上述指令"这类文本；入库之后会被 auto-recall
  // 带进别的会话，所以明确标出它是证据、不是指令。
  return `${rendered}\n${messages.memoryEvidenceNotice}`;
}
