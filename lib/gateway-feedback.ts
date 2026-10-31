// quality-gate → 记忆网关反馈
//
// 职责：门禁失败确认后，把失败摘要投递进记忆网关的 L0 会话层（session 'dsh-agent'），
// 供 auto-recall 在后续会话注入"上次栽的坑"——让工程质量环的质量反馈回流进记忆环，两环合成大闭环。
// 本文件只做**投递**：目标面（基址 / 服务名 / 记忆桶键）在 lib/gateway-target.ts，
// 正文的写法在 lib/feedback-content.ts，两侧各自也被 host 直接消费——本模块不读设置、不碰 env。
//
// 设计要点：
// - shell-free：Node 内建 fetch（运行时底线见 package.json 的 `engines.node`），无子进程、无 argv——
//   Authorization 头一旦走 argv，进程列表（ps）里瞬间可见；fetch 让 key 只进请求头，
//   顺带没有 EPIPE/孤儿进程两类兜底负担；
// - 不内建任何本机默认值：url 与 Bearer 令牌都由调用方（host）从设置 +
//   dsh 官方凭据通道（ctx.credentials）解析后传进来，这里不拼任何本机文件路径；
// - 尽力而为：5s 超时封顶（AbortSignal.timeout 覆盖含 DNS/connect 全阶段），
//   错误由调用方 catch（绝不阻塞门禁主流程）；
// - 独立自包含：quality-gate 在 dsh 侧，跨项目不 import gateway 插件目录，只依赖 node
//   内建 + 同仓 ../shared/lib（与 lesson-loop 共用一份桶键派生，随 bundle 一起装载）。

import { buildFeedbackText } from "./feedback-content.ts";
import type { GateFeedbackInput } from "./feedback-content.ts";
import { deriveAgentId } from "./gateway-target.ts";
import type { GatewayTarget } from "./gateway-target.ts";
import { isCredentialSafeUrl } from "./credential-url.ts";
import type { QualityGateMessages } from "./messages.ts";

/** 基址末尾斜杠。 */
const TRAILING_SLASHES = /\/+$/u;
/** 协议面字面量：端点与会话名集中在这里，改协议时只动这一处。 */
const FEEDBACK_ENDPOINT = "/v2/conversation/add";
const FEEDBACK_SESSION = "dsh-agent";
const FEEDBACK_ROLE = "assistant";
/** 网关服务名的合法形状（与 gateway-target 的 resolveServiceId 同式）。 */
const SERVICE_ID_RE = /^[\w.-]{1,64}$/u;
/** 只在文本/JSON 响应下把正文带进错误信息；HTML 错误页不整页入日志。 */
const TEXTUAL_CONTENT_TYPE = /^(?:text\/|application\/(?:json|problem\+json))/iu;
const DEFAULT_SERVICE_ID = "default";

/** 反馈尽力而为：5s 封顶，超时/失败只 warn（不吃掉门禁主流程）。 */
const FEEDBACK_TIMEOUT_MS = 5000;

/** 沉淀门禁失败到 L0 记忆（role=assistant：这是 agent 自身行为教训，归顺 assistant 提炼面）。 */
export async function pushGateFeedback(
  input: GateFeedbackInput,
  target: GatewayTarget,
  messages: QualityGateMessages,
): Promise<void> {
  // 目标面在**发请求之前**校验：本函数是导出的公共入口，不能假定调用方已走过
  // resolveGatewayUrl 的归一（空 url 会拼出相对路径、fetch 抛 `Failed to parse URL`；
  // 空 key 会发出 `Authorization: Bearer `，网关侧只会回 401，光看日志分辨不出是配置空）。
  const base = target.url.trim().replace(TRAILING_SLASHES, "");
  const key = target.key.trim();
  if (base === "" || key === "") {
    throw new Error("投递目标不完整：url 与 key 都必须非空（目标面应由调用方解析后传入）");
  }
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("投递目标不完整：url 不是合法的 http(s) 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`投递目标不完整：不支持的协议 ${parsed.protocol}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("投递目标不完整：基址不能带 query/fragment");
  }
  // 与宿主运行期同一份判据：明文 http 只允许回环，带 userinfo 一律拒绝。
  if (!isCredentialSafeUrl(base)) {
    throw new Error("投递目标不安全：凭据只发 https 或回环地址");
  }
  const serviceId = SERVICE_ID_RE.test(target.serviceId) ? target.serviceId : DEFAULT_SERVICE_ID;
  const agentId = deriveAgentId(input.cwd);
  const content = buildFeedbackText(input, messages);
  // 没有证据正文时不投递：空记录只会成为后续会话 auto-recall 的噪音。
  if (content === "") {
    return;
  }
  const payload = JSON.stringify({
    session_id: FEEDBACK_SESSION,
    agent_id: agentId,
    messages: [{ role: FEEDBACK_ROLE, content }],
  });
  const res = await fetch(`${base}${FEEDBACK_ENDPOINT}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "x-tdai-service-id": serviceId,
      "Content-Type": "application/json",
    },
    body: payload,
    signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
  });
  // 先消费 body 再判状态：非 2xx 时直接 throw 会把响应体连同连接一起留在未消费状态，
  // undici 于是不复用该连接（keep-alive 槽位被占着到超时）。读取失败不影响"已送达"结论。
  const drained = await res.arrayBuffer().catch(() => null);
  if (!res.ok) {
    // 只带状态码时调用方（catch 里那条 warn）说不出网关为什么拒：401 与 400 的修法完全不同。
    // 只在文本/JSON 响应下解码，且截断到一小段：HTML 错误页不应把整页内容带进宿主日志。
    const contentType = res.headers.get("content-type") ?? "";
    const textual = TEXTUAL_CONTENT_TYPE.test(contentType);
    const detail =
      drained !== null && textual ? new TextDecoder().decode(drained).trim().slice(0, 200) : "";
    if (detail === "") {
      throw new Error(`gateway feedback HTTP ${res.status}`);
    }
    throw new Error(`gateway feedback HTTP ${res.status}：${detail}`, { cause: detail });
  }
}
