// lib/gateway-target.ts —— 一次反馈投递的**目标面**：送到哪个网关、报哪个服务名、落进哪个记忆桶。
//
// 为什么从 lib/gateway-feedback.ts 拆出来：这三件东西共同回答同一个问题——「这条反馈交给谁」，
// 答案由设置 + env + cwd 在**调用期**现算，与「HTTP 怎么发」无关；而且它们各自都有本文件之外的
// 生产消费者（host 取基址拼目标，投递侧取服务名与桶键）。此前挤在投递模块里 export，只有投递
// 侧内部用到的那两枚就被 `fallow --production` 判成「只被测试养着的导出面」。
//
// 一律**调用期**解析而不是模块级常量：求值期读 env 会把值冻在 import 那一刻——测试改 env 无效
// （只能 resetModules），使用者的配置也永远追不上第一次 import。旧实现还因此把作者机器上的
// `http://127.0.0.1:8420` 写死成默认地址，别人每次门禁失败都去连一个不存在的服务。

import { deriveProjectKey } from "@jayyuen666/dsh-plugin-shared/lib/project-key";

/** env 值 trim 后非空则用之，否则回到 fallback（保留原 `||` 语义，
 *  又以显式比较规避 prefer-nullish-coalescing 与 strict-boolean-expressions）。 */
function envOr(key: string, fallback: string): string {
  const trimmed = process.env[key]?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : fallback;
}

/**
 * 网关基址：设置值优先，留空时回落到 TDAI_GATEWAY_URL（逃生门），**两处都空则为空串**。
 * 空串即"未配置"——调用方据此不启用记忆反馈。默认值不再是任何人的本机地址
 * （旧实现把作者机器上的 http://127.0.0.1:8420 写死成默认，别人每次门禁失败都去连一个
 * 不存在的服务）。设置优先于 env 的理由：设置卡是用户显式配置面，env 只能兜底，
 * 否则用户改了设置卡仍被一个看不见的环境变量越权。
 */
export function resolveGatewayUrl(settingUrl: string): string {
  const configured = settingUrl.trim();
  const candidate = configured === "" ? envOr("TDAI_GATEWAY_URL", "") : configured;
  // 尾部斜杠剥离：拼出 `//v2/...` 会被多数网关判 404，那是配置手滑而不是功能缺失
  return candidate.replace(/\/+$/u, "");
}

/** x-tdai-service-id：env 可覆盖，默认是网关协议的匿名服务名（不含任何机器信息）。 */
export function resolveServiceId(): string {
  return envOr("TDAI_SERVICE_ID", "default");
}

/**
 * 一次投递的目标（调用方解析完成后传入）。
 * - url：基址（已由 resolveGatewayUrl 归一，非空才会走到这里）；
 * - key：Bearer 令牌明文，由 dsh 凭据通道 resolve 出来——本模块不再读任何本机 key 文件。
 */
export interface GatewayTarget {
  url: string;
  key: string;
}

/** cwd → agent_id：'尾目录名-<cwd 前 8 位 sha256>'（与网关插件 workspace-peer 同分桶语义，
 * 读/写同键，保证反馈沉淀进 auto-recall 同一记忆桶）。
 * 派生本体在 shared/lib/project-key.ts：lesson-loop 的 project 与这里同源一份实现，
 * 此前两处各存一份，改一处漏一处就把"教训 ↔ 记忆"的跨系统对照拆断了。 */
export function deriveAgentId(cwd: unknown): string {
  return deriveProjectKey(cwd);
}
