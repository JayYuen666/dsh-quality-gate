// quality-gate → 记忆网关反馈
//
// 职责：确认门禁失败之后，把失败摘要写进记忆网关的 L0 会话层（session 'dsh-agent'），
// 让 auto-recall 在后续会话里带上"上次失败的原因"——检查的失败结果因此能进记忆，而不是只在当场报一次。
// 本文件只做**发送**这一件事：地址（基址、服务名、记忆条目的键）在 lib/gateway-target.ts，
// 正文怎么写在 lib/feedback-content.ts，这两处 host 也各自直接消费——本模块不读设置、不读环境变量。
//
// 设计要点：
// - 不用 shell：用 Node 内建的 fetch（运行时最低版本见 package.json 的 `engines.node`），不起子进程、不拼 argv——
//   Authorization 头一旦出现在 argv 里，`ps` 一眼就能看到；fetch 让 key 只进请求头，
//   也就不用处理 EPIPE 和孤儿进程这两类额外情况；
// - 不内建任何本机默认值：url 与 Bearer 令牌都由调用方（host）从设置与
//   dsh 官方凭据通道（ctx.credentials）解析后传进来，这里不拼任何本机文件路径；
// - 尽力而为：超时上限 5 秒（AbortSignal.timeout 把 DNS 与连接阶段都算在内），
//   错误由调用方 catch（绝不能拖住门禁的主流程）；
// - 不依赖别的插件：quality-gate 在 dsh 侧跨项目时不 import gateway 插件的目录，只依赖 node
//   内建和同仓 ../shared/lib（与 lesson-loop 共用同一个记忆条目键的生成函数，随 bundle 一起装载）。

import { buildFeedbackText } from "./feedback-content.ts";
import type { GateFeedbackInput } from "./feedback-content.ts";
import { deriveAgentId } from "./gateway-target.ts";
import type { GatewayTarget } from "./gateway-target.ts";
import { isCredentialSafeUrl } from "./credential-url.ts";
import type { QualityGateMessages } from "./messages.ts";

/** 匹配基址末尾的斜杠。 */
const TRAILING_SLASHES = /\/+$/u;
/** 协议相关的字面量：端点路径与会话名集中在这里，改协议时只动这一处。 */
const FEEDBACK_ENDPOINT = "/v2/conversation/add";
const FEEDBACK_SESSION = "dsh-agent";
const FEEDBACK_ROLE = "assistant";
/** 网关服务名的合法形状（和 gateway-target 里 resolveServiceId 用的式子相同）。 */
const SERVICE_ID_RE = /^[\w.-]{1,64}$/u;
/** 只在文本或 JSON 响应下把正文带进错误信息；HTML 错误页不把整页写进日志。 */
const TEXTUAL_CONTENT_TYPE = /^(?:text\/|application\/(?:json|problem\+json))/iu;
const DEFAULT_SERVICE_ID = "default";

/** 反馈按尽力而为处理：5 秒上限，超时或失败只 warn（不能挡住门禁的主流程）。 */
const FEEDBACK_TIMEOUT_MS = 5000;

/** 把门禁失败写进 L0 记忆（role=assistant：这是 agent 自己行为上的教训，按 assistant 一侧提炼）。 */
export async function pushGateFeedback(
  input: GateFeedbackInput,
  target: GatewayTarget,
  messages: QualityGateMessages,
): Promise<void> {
  // 发送地址在**发请求之前**校验：本函数是导出的公共入口，不能假定调用方已经走过
  // resolveGatewayUrl 的归一处理（空 url 会拼出相对路径，fetch 抛 `Failed to parse URL`；
  // 空 key 会发出 `Authorization: Bearer `，网关那边只回 401，光看日志分不清是配置为空）。
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
  // 和宿主运行期用同一份判据：明文 http 只允许回环，带 userinfo 一律拒绝。
  if (!isCredentialSafeUrl(base)) {
    throw new Error("投递目标不安全：凭据只发 https 或回环地址");
  }
  const serviceId = SERVICE_ID_RE.test(target.serviceId) ? target.serviceId : DEFAULT_SERVICE_ID;
  const agentId = deriveAgentId(input.cwd);
  const content = buildFeedbackText(input, messages);
  // 没有证据正文时不发送：空记录会被 auto-recall 带进后续会话，成了干扰内容。
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
  // 先读掉 body 再看状态码：非 2xx 时直接 throw 会把响应体和连接一起留在未消费的状态，
  // undici 因此不复用这条连接（keep-alive 的槽位一直被占到超时）。读取失败不影响"已经送达"这个结论。
  const drained = await res.arrayBuffer().catch(() => null);
  if (!res.ok) {
    // 只带状态码时，调用方（catch 里那条 warn）说不出网关为什么拒绝：401 和 400 的修法完全不同。
    // 只在文本或 JSON 响应下解码，并且截成一小段：HTML 错误页不该把整页内容带进宿主日志。
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
