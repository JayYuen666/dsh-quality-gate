// lib/gateway-target.ts —— 一次反馈的**发送目标**：送到哪个网关、报哪个服务名、存进哪个记忆条目。
//
// 为什么从 lib/gateway-feedback.ts 拆出来：这几样东西回答的是同一个问题——"这条反馈交给谁"，
// 答案由设置、环境变量和 cwd 在**调用时**算出来，和"HTTP 怎么发"无关；而且它们在本文件之外也各有
// 正式用法（host 取基址拼目标，发送侧取服务名和记忆键）。以前和发送代码写在同一个模块里 export 时，
// 只有模块内部用到的那两个函数，从导出关系上看不出它们其实也给外面用。
//
// 一律在**调用时**解析，不做成模块级常量：在模块求值时读环境变量会把值定在 import 那一刻——测试改
// 环境变量无效（只能 resetModules），使用者的配置也永远赶不上第一次 import。

import { deriveProjectKey } from "@jayyuen66/dsh-plugin-shared/lib/project-key";

/** 匹配基址末尾的斜杠。 */
const TRAILING_SLASHES = /\/+$/u;

/** 环境变量 trim 后非空就用它，否则用 fallback（行为与原来的 `||` 相同，
 *  写成显式比较是为了同时满足 prefer-nullish-coalescing 与 strict-boolean-expressions）。 */
function envOr(key: string, fallback: string): string {
  const trimmed = process.env[key]?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : fallback;
}

/**
 * 网关基址：设置值优先，留空时改用 TDAI_GATEWAY_URL（预留的退路），**两处都空则返回空串**。
 * 空串就是"未配置"——调用方据此不启用记忆反馈。默认值不是任何本机地址：把某台开发机的
 * 端口写死成默认，等于让别人的每一次门禁失败都去连一个不存在的服务。设置优先于环境变量的理由是：
 * 设置卡是用户明确配置的地方，环境变量只能补充，否则用户改了设置卡，仍被一个看不见的环境变量覆盖。
 *
 * 解析不出合法 URL 时同样返回空串（按"未配置"处理）：`http://` 这种写了一半的串去掉斜杠后只剩
 * `http:`，原样交给调用方的话，凭据安全检查会把它报成"明文 http 且不是回环"——配置写错误报成协议
 * 不安全，用户照着提示改成 https 也修不好。
 *
 * 只接受"基址"：带 query 或 fragment 的串一律返回空串。调用方把返回值当基址去拼
 * `/v2/conversation/add`，如果原样保留 `?token=...` 或 `#frag`，拼出来的路径会落在 query
 * 之后（实测 `https://gw/api?x=1` → `https://gw/api?x=1/v2/conversation/add`），请求打到
 * 错误的位置，而不是报配置错——配置里的一处笔误就被伪装成网关 404。
 *
 * 带 userinfo（`https://user:secret@gw`）同样返回空串：基址不是放密钥的地方（密钥走凭据
 * 引用名），而且这个返回值会写进失败时的日志，原样传下去等于把密码打进日志和错误提示。
 */
export function resolveGatewayUrl(settingUrl: string): string {
  const configured = settingUrl.trim();
  const candidate = configured === "" ? envOr("TDAI_GATEWAY_URL", "") : configured;
  if (candidate === "") {
    return "";
  }
  // 去掉尾部斜杠：拼出 `//v2/...` 会被多数网关判成 404，那是配置里的一处笔误，不是功能缺失
  const normalized = candidate.replace(TRAILING_SLASHES, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return "";
  }
  // `new URL()` 对任意 scheme 都照收：`gateway.internal:8420` 会被解析成 scheme
  // `gateway.internal:` 加路径 `8420`。本函数的返回值只用来往下拼 `/v2/conversation/add`，所以
  // 协议必须是 http(s)——否则拼出一条 fetch 一定拒收的地址，用户看到的报错和真实原因
  // 无关，真实原因是基址只写了一半。
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return "";
  }
  return normalized;
}

/** 判断凭据可以发往哪些地址的代码在 lib/credential-url.ts：设置卡用的是同一份。 */
export { isCredentialSafeUrl } from "./credential-url.ts";

/** `x-tdai-service-id` 的合法形状：网关按服务名路由，空白与控制字符会让请求头
 *  在 fetch 处直接抛 TypeError（undici 拒收含换行的头值），把一次发送变成一条异常。
 *  不合规的值一律改用默认服务名，而不是把用户的笔误送上网关。 */
const SERVICE_ID_RE = /^[\w.-]{1,64}$/u;

/** 默认服务名：网关协议里的匿名服务名（不含任何机器信息）。 */
const DEFAULT_SERVICE_ID = "default";

/** x-tdai-service-id：可以由环境变量覆盖，形状不合规时改用默认值。 */
export function resolveServiceId(): string {
  const configured = envOr("TDAI_SERVICE_ID", "");
  return SERVICE_ID_RE.test(configured) ? configured : DEFAULT_SERVICE_ID;
}

/**
 * 一次发送的目标（调用方解析完成后传进来）。
 * - url：基址（已经由 resolveGatewayUrl 归一，非空才会走到这里）；
 * - key：Bearer 令牌明文，由 dsh 凭据通道 resolve 出来——本模块不再读任何本机 key 文件；
 * - serviceId：`x-tdai-service-id`。由调用方和 url、key 在**同一处**解析后传进来，发送模块
 *   因此真的不读环境变量——否则目标要分两条通道去取，服务名和网关不是同一个来源时，反馈会存进
 *   错误的服务下面，而从 `GatewayTarget` 的签名上看不出这层依赖关系。
 */
export interface GatewayTarget {
  url: string;
  key: string;
  serviceId: string;
}

/**
 * 做什么：cwd → agent_id，形如 '尾目录名-<cwd 前 8 位 sha256>'（与网关插件 workspace-peer
 *  的分键语义一致，读和写用同一个键，这样反馈存进去的位置正是 auto-recall 会读的那个记忆条目）。
 *
 * 前提：键的生成实现在 shared/lib/project-key.ts——lesson-loop 的 project 和这里用的是同一份。
 * 两边各存一份实现时改一处漏一处，"教训 ↔ 记忆"的跨系统对照就断了，而且不会报错。
 *
 * 细节：参数类型保留 `unknown`（调用方给的 cwd 来自会话事件，形状不由本包保证）；非字符串、
 * 空串、根路径一律改用 'default'。
 *
 * 实现：直接委托 deriveProjectKey。
 *
 * 怎么验证：test/gateway-feedback.test.ts 的 deriveAgentId 组逐条钉住了各种改用默认值的情况，
 * 另有一例断言它与 deriveProjectKey 每个取值都同源。
 *
 * 不覆盖的情况：'default' 是所有项目共用的记忆条目——落到这一条因此**可能**把反馈混进别人的条目。
 * 这里不为此加日志：本模块被 host 的 catch 包着、失败只 warn 一次，再往 lib 里加一条
 * console 会污染测试的日志登记（test/setup-logs.ts 要求每条日志都有模板认领）；而实际
 * 调用点传的是会话 cwd（host.ts 里由事件流给出，一定是字符串），这条默认值是给以后的调用方
 * 准备的保护。
 */
export function deriveAgentId(cwd: unknown): string {
  return deriveProjectKey(cwd);
}
