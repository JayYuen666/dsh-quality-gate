// quality-gate → 记忆网关反馈（闭环补环③，改 fetch 实现）
//
// 职责：门禁失败确认后，把失败摘要投递进记忆网关的 L0 会话层（session 'dsh-agent'），
// 供 auto-recall 在后续会话注入"上次栽的坑"——让工程质量环的质量反馈回流进记忆环，两环合成大闭环。
// 本文件只做**投递**：目标面（基址 / 服务名 / 记忆桶键）在 lib/gateway-target.ts，
// 正文的写法在 lib/feedback-content.ts，两侧各自也被 host 直接消费——本模块不读设置、不碰 env。
//
// 设计要点：
// - shell-free：Node 内建 fetch（运行时底线 Node ≥22.18），无子进程、无 argv——
//   旧 execFile('curl') 把 Authorization 头放 argv，进程列表（ps）瞬间可见；
//   改 fetch 后 key 只进请求头，顺带消除 EPIPE/孤儿进程两类兜底负担；
// - 不持有任何"作者机器事实"：url 与 Bearer 令牌都由调用方（host）从设置 +
//   dsh 官方凭据通道（ctx.credentials）解析后传进来，这里不拼任何本机文件路径；
// - 尽力而为：5s 超时封顶（AbortSignal.timeout 覆盖含 DNS/connect 全阶段），
//   错误由调用方 catch（绝不阻塞门禁主流程）；
// - 独立自包含：quality-gate 在 dsh 侧，跨项目不 import gateway 插件目录，只依赖 node
//   内建 + 同仓 ../shared/lib（与 lesson-loop 共用一份桶键派生，随 bundle 一起装载）。

import { buildFeedbackText } from "./feedback-content.ts";
import type { GateFeedbackInput } from "./feedback-content.ts";
import { deriveAgentId, resolveServiceId } from "./gateway-target.ts";
import type { GatewayTarget } from "./gateway-target.ts";
import type { QualityGateMessages } from "./messages.ts";

/** 反馈尽力而为：5s 封顶，超时/失败只 warn（不吃掉门禁主流程）。 */
const FEEDBACK_TIMEOUT_MS = 5000;

/** 沉淀门禁失败到 L0 记忆（role=assistant：这是 agent 自身行为教训，归顺 assistant 提炼面）。 */
export async function pushGateFeedback(
  input: GateFeedbackInput,
  target: GatewayTarget,
  messages: QualityGateMessages,
): Promise<void> {
  const agentId = deriveAgentId(input.cwd);
  const content = buildFeedbackText(input, messages);
  const payload = JSON.stringify({
    session_id: "dsh-agent",
    agent_id: agentId,
    messages: [{ role: "assistant", content }],
  });
  const res = await fetch(`${target.url}/v2/conversation/add`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.key}`,
      "x-tdai-service-id": resolveServiceId(),
      "Content-Type": "application/json",
    },
    body: payload,
    signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gateway feedback HTTP ${res.status}`);
  }
  // 消费 body（连接可复用；body 读取失败不影响"已送达"结论）
  await res.arrayBuffer().catch(() => null);
}
