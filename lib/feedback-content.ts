// lib/feedback-content.ts —— 沉淀进记忆网关的那**一行正文**：门禁失败证据 → 后续会话召回的教训。
//
// 为什么从 lib/gateway-feedback.ts 拆出来：正文怎么写（单行化、不截断、语言随官方 locale 偏好）
// 与「HTTP 怎么发」是两件事，两侧各有消费者——host 在门禁失败确认后组这份载荷，投递侧把它原样
// 装进 body。留在投递模块里 export 时，只有投递侧内部用到的它就被 `fallow --production`
// 判成「只被测试养着的导出面」。

import { renderTemplate } from "./messages.ts";
import type { QualityGateMessages } from "./messages.ts";

export interface GateFeedbackInput {
  /** 会话 cwd（记忆桶定位；缺失回退 'default'）。 */
  cwd?: unknown;
  /** 门禁命令参数表（g.command；只读——联合字面量元组直接可用）。 */
  command: readonly string[];
  /** 门禁项目根（g.root）。 */
  root: string;
  /** 门禁失败证据文本（runGate 返回的 failure）。 */
  failure: string;
}

/** 门禁失败 → 记忆正文：单行化（防换行噪音）。
 *  去截断（用户拍板"不为省 token 降能力"）：旧实现 400 字符截尾会把
 *  多根错误的中间根因吃掉；记忆网关的入库限额由网关侧把关，这里送全文。
 *  正文语言随官方 locale 偏好走（messages 由调用方按回合取出后传进来）——这条文本会被
 *  auto-recall 注入后续会话的上下文，是模型读的，不是日志。 */
export function buildFeedbackText(
  { command, root, failure }: GateFeedbackInput,
  messages: QualityGateMessages,
): string {
  const cmd = command.join(" ");
  const tail = failure.replaceAll(/\s+/gu, " ").trim();
  return renderTemplate(messages.memoryFeedback, { command: cmd, root, failure: tail });
}
