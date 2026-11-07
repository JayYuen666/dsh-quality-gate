// lib/credential-url.ts —— 凭据可以发往哪些地址。宿主运行期与设置卡共用这一份判据。
//
// 单列成一个文件的原因：设置卡跑在客户端产物里，不能引用 gateway-target 那个会读环境变量的模块；
// 而两边各写一份判据时，会出现卡片接受某个地址、运行期却不发送，用户只看到"保存成功"。
// 本模块只做字符串与 URL 的形状判断，不读环境变量、不碰文件。

/** IPv4 地址里的一段（1 到 3 位数字）。 */
const IPV4_OCTET = /^\d{1,3}$/u;

/** IPv4-mapped IPv6 的字面前缀。 */
const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * 是否为 IPv4-mapped 写法下的 IPv4 回环（`::ffff:127.0.0.0/8`，URL 会把它归一成 `::ffff:7fxx:xxxx`）。
 *
 * 必须按末 32 位的**实际数值**判断，不能按字符串前缀 `::ffff:7f`：前缀命中的
 * `::ffff:7fa:0` 末 32 位是 0x07fa0000 = 7.250.0.0，并不在 127.0.0.0/8 里。按前缀放行
 * 等于把 Bearer 令牌发往远端的明文 http，正是这个函数要拦住的事，而放松判断比不判断更糟。
 * 非规范的展开写法（如 `::ffff:0:7f00:1`）判定为不是回环——宁可不放行，这一条可以接受。
 *
 * @param host - `URL.hostname` 去掉方括号后的主机名
 * @returns 是否为 IPv4 回环的映射写法
 */
export function isIpv4MappedLoopback(host: string): boolean {
  if (!host.startsWith(IPV4_MAPPED_PREFIX)) {
    return false;
  }
  const segments = host.slice(IPV4_MAPPED_PREFIX.length).split(":");
  if (segments.length !== 2) {
    return false;
  }
  // 高 16 位落在 0x7F00–0x7FFF 就是 127.0.0.0/8 的映射写法（末 32 位 = 高 16 位 << 16）。
  // 按数值判断，而不是按字符串前缀 `7f`：`::ffff:7fa:0` 的末 32 位是 7.250.0.0，不在 127.0.0.0/8 里。
  const high = Number.parseInt(String(segments[0]), 16);
  return high >= 32_512 && high <= 32_767;
}

/**
 * 是否为 IPv4 回环（127.0.0.0/8 整段，不只是 127.0.0.1）。
 *
 * @param host - `URL.hostname` 去掉方括号后的主机名
 * @returns 是否落在 127.0.0.0/8
 */
export function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") {
    return false;
  }
  return parts.every((part) => IPV4_OCTET.test(part) && Number(part) <= 255);
}

/**
 * 凭据只允许发往 https 或回环地址：明文 http 发往远端会把 Bearer 令牌暴露给同一网段
 * （设置卡的默认值就是本机 http，这是有意允许的用法）。地址里带 userinfo 一律判定为不安全
 * ——那是另一条会随 URL 一起写进设置文件的凭据形态，与本插件把密钥交给凭据服务的做法冲突。
 *
 * 回环按整段判断，而不是比三个字面量：IPv4 回环是 127.0.0.0/8，网关绑在 127.0.0.2 /
 * 127.0.1.1 时同样只在本机，判成"不安全"会让记忆反馈功能停掉、而且没有任何提示，用户从
 * 界面上看不出自己请求的其实就在本机；IPv6 的 IPv4-mapped 写法（URL 把 `[::ffff:127.0.0.1]`
 * 归一成 `[::ffff:7f00:1]`）同理。
 *
 * `localhost` 这一条是**有意留下的例外**：它依赖 hosts 文件与 DNS 解析，hosts 被指向远端时
 * 本函数仍判定为安全。留下它是为了让设置卡的默认写法可用；要彻底消除这一条风险，只能改成只认
 * IP 字面量，那样"本机网关"这条最常见用法就得用户自己去查 IP。
 *
 * @param url - 待判定的完整 URL
 * @returns 是否可以携带凭据发往该地址
 */
export function isCredentialSafeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  const host = parsed.hostname.replaceAll(/^\[|\]$/gu, "");
  // ::1 是 IPv6 回环；::ffff:7fxx:xxxx 是 127.0.0.0/8 的映射写法（按末 32 位的数值判断）。
  return (
    host === "localhost" || isIpv4Loopback(host) || host === "::1" || isIpv4MappedLoopback(host)
  );
}
