// lib/gateway-target.ts —— 一次反馈投递的**目标面**：送到哪个网关、报哪个服务名、落进哪个记忆桶。
//
// 为什么从 lib/gateway-feedback.ts 拆出来：这几件东西共同回答同一个问题——「这条反馈交给谁」，
// 答案由设置 + env + cwd 在**调用期**现算，与「HTTP 怎么发」无关；而且它们各自都有本文件之外的
// 生产消费者（host 取基址拼目标，投递侧取服务名与桶键）。此前挤在投递模块里 export，只有投递
// 侧内部用到的那两枚就从导出面上看不出它们其实面向生产。
//
// 一律**调用期**解析而不是模块级常量：求值期读 env 会把值冻在 import 那一刻——测试改 env 无效
// （只能 resetModules），使用者的配置也永远追不上第一次 import。

import { deriveProjectKey } from "@jayyuen66/dsh-plugin-shared/lib/project-key";

/** env 值 trim 后非空则用之，否则回到 fallback（保留原 `||` 语义，
 *  又以显式比较规避 prefer-nullish-coalescing 与 strict-boolean-expressions）。 */
function envOr(key: string, fallback: string): string {
  const trimmed = process.env[key]?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : fallback;
}

/**
 * 网关基址：设置值优先，留空时回落到 TDAI_GATEWAY_URL（逃生门），**两处都空则为空串**。
 * 空串即"未配置"——调用方据此不启用记忆反馈。默认值不是任何本机地址：把某个开发机的
 * 端口写死成默认，等于让别人的每次门禁失败都去连一个不存在的服务。设置优先于 env 的理由：
 * 设置卡是用户显式配置面，env 只能兜底，
 * 否则用户改了设置卡仍被一个看不见的环境变量越权。
 *
 * 解析不出合法 URL 时同样返回空串（按"未配置"处理）：`http://` 这类半截串裁掉斜杠后剩
 * `http:`，如果原样透给调用方，凭据安全判据会把它报成"明文 http 且非回环"——把配置写错
 * 误报成协议不安全，用户照提示改成 https 也修不好。
 */
export function resolveGatewayUrl(settingUrl: string): string {
  const configured = settingUrl.trim();
  const candidate = configured === "" ? envOr("TDAI_GATEWAY_URL", "") : configured;
  if (candidate === "") {
    return "";
  }
  // 尾部斜杠剥离：拼出 `//v2/...` 会被多数网关判 404，那是配置手滑而不是功能缺失
  const normalized = candidate.replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return "";
  }
  // `new URL()` 对任意 scheme 都照收：`gateway.internal:8420` 会被解析成 scheme
  // `gateway.internal:` 加路径 `8420`。本函数的返回值只往下拼 `/v2/conversation/add`，
  // 所以协议必须是 http(s)——否则拼出一条 fetch 必然拒收的地址，用户看到的是一条
  // 与真实成因（基址写残）无关的报错。
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }
  return normalized;
}

/** 是否为 IPv4 回环（127.0.0.0/8 整段，不只是 127.0.0.1）。 */
function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") {
    return false;
  }
  return parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

/**
 * 凭据只允许发往 https 或回环地址：明文 http 到远端会把 Bearer 令牌暴露给同网段
 * （设置卡默认值就是本机 http，属有意用法）。返回 false 时调用方按"未配置"处理，
 * 不解析、不发送凭据。
 *
 * 回环按整段判定而不是三个字面量：IPv4 回环是 127.0.0.0/8，网关绑在 127.0.0.2 /
 * 127.0.1.1 时同样只在本机，判成"不安全"会让记忆反馈静默停掉、而用户从提示里看不出
 * 自己其实就在本机；IPv6 的 IPv4-mapped 写法（URL 把 `[::ffff:127.0.0.1]` 归一成
 * `[::ffff:7f00:1]`）同理。
 *
 * `localhost` 这一支是**有意保留的 fail-open**：它依赖 hosts/DNS 解析，hosts 被指向远端时
 * 本函数仍判安全。保留它是为了让设置卡的默认写法可用；要彻底关掉这个口子只能改成只认 IP
 * 字面量，那会让"本机网关"这条最常见用法需要用户自己去查 IP。
 */
export function isCredentialSafeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  const host = parsed.hostname.replaceAll(/^\[|\]$/gu, "");
  // ::1 是 IPv6 回环；::ffff:7fxx:xxxx 的第三、四字节是 0x7f，即 127.0.0.0/8 的映射写法。
  return (
    host === "localhost" || isIpv4Loopback(host) || host === "::1" || host.startsWith("::ffff:7f")
  );
}

/** `x-tdai-service-id` 的合法形状：网关侧按服务名路由，空白与控制字符会让请求头
 *  在 fetch 处直接抛 TypeError（undici 拒收含换行的头值），把一次投递变成一条异常。
 *  不合规的值一律回落到默认服务名，而不是把用户的笔误送上网关。 */
const SERVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/u;

/** 默认服务名：网关协议的匿名服务名（不含任何机器信息）。 */
const DEFAULT_SERVICE_ID = "default";

/** x-tdai-service-id：env 可覆盖，形状不合规时回落默认值。 */
export function resolveServiceId(): string {
  const configured = envOr("TDAI_SERVICE_ID", "");
  return SERVICE_ID_RE.test(configured) ? configured : DEFAULT_SERVICE_ID;
}

/**
 * 一次投递的目标（调用方解析完成后传入）。
 * - url：基址（已由 resolveGatewayUrl 归一，非空才会走到这里）；
 * - key：Bearer 令牌明文，由 dsh 凭据通道 resolve 出来——本模块不再读任何本机 key 文件；
 * - serviceId：`x-tdai-service-id`。由调用方与 url/key 在**同一处**解析后传进来，投递模块
 *   因此真的不读 env——否则目标面拆成两条通道，服务名与网关不同源时反馈会落进错误的服务面，
 *   而 `GatewayTarget` 的签名上看不出这层隐式依赖。
 */
export interface GatewayTarget {
  url: string;
  key: string;
  serviceId: string;
}

/**
 * 作用：cwd → agent_id，'尾目录名-<cwd 前 8 位 sha256>'（与网关插件 workspace-peer 同分桶
 * 语义，读/写同键，保证反馈沉淀进 auto-recall 同一记忆桶）。
 *
 * 条件：派生本体在 shared/lib/project-key.ts —— lesson-loop 的 project 与这里同源一份实现，
 * 两处各存一份时改一处漏一处，把"教训 ↔ 记忆"的跨系统对照拆断而不报错。
 *
 * 子功能：参数保留 `unknown`（调用方的 cwd 来自会话事件，形状不由本包保证）；非字符串、
 * 空串、根路径一律回落 'default'。
 *
 * 执行：直接委托 deriveProjectKey。
 *
 * 验证方式：test/gateway-feedback.test.ts 的 deriveAgentId 组逐条钉住回落面，并有一例
 * 断言它与 deriveProjectKey 逐值同源。
 *
 * 不适用条件：'default' 是所有项目共享的记忆桶 —— 回落因此**可能**把反馈混进别人的桶。
 * 这里不为此加日志：本模块被 host 的 catch 包着、失败只 warn 一次，再往 lib 里塞一条
 * console 会污染测试日志账本（test/setup-logs.ts 要求每条日志都有模板认领）；而实际
 * 调用点传的是会话 cwd（host.ts 里由事件流给出，必为字符串），回落是给未来调用方的护栏。
 */
export function deriveAgentId(cwd: unknown): string {
  return deriveProjectKey(cwd);
}
