// lib/credential-url.ts —— 凭据可以发往哪些地址。宿主运行期与设置卡共用这一份判据。
//
// 单列的原因：设置卡在客户端产物里跑，不能从 gateway-target 那条带 env 读面的模块里取；
// 而两处各写一份判据时，卡片接受一个地址、运行期却静默不投递，用户看到"保存成功"。
// 本模块只做纯字符串/URL 判定，不读 env、不碰文件。

/** IPv4 单段。 */
const IPV4_OCTET = /^\d{1,3}$/u;

/** IPv4-mapped IPv6 的字面前缀。 */
const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * 是否为 IPv4-mapped 的 IPv4 回环（`::ffff:127.0.0.0/8`，URL 会归一成 `::ffff:7fxx:xxxx`）。
 *
 * 必须按末 32 位的**实际数值**判，不能按字符串前缀 `::ffff:7f`：前缀命中的
 * `::ffff:7fa:0` 末 32 位是 0x07fa0000 = 7.250.0.0，并不在 127.0.0.0/8 里。按前缀放行
 * 等于把 Bearer 令牌发往远端明文 http，与本函数的安全承诺相反（fail-open 比不判更糟）。
 * 非规范的展开写法（如 `::ffff:0:7f00:1`）判否——fail-closed，可接受。
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
  // 按数值判而不是按字符串前缀 `7f`：`::ffff:7fa:0` 的末 32 位是 7.250.0.0，不在 127.0.0.0/8 里。
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
 * 凭据只允许发往 https 或回环地址：明文 http 到远端会把 Bearer 令牌暴露给同网段
 * （设置卡默认值就是本机 http，属有意用法）。地址里带 userinfo 一律判否——那是另一条
 * 会随 URL 一起写进设置文件的凭据形态，与本插件把密钥交给凭据服务的设计冲突。
 *
 * 回环按整段判定而不是三个字面量：IPv4 回环是 127.0.0.0/8，网关绑在 127.0.0.2 /
 * 127.0.1.1 时同样只在本机，判成"不安全"会让记忆反馈静默停掉、而用户从提示里看不出
 * 自己其实就在本机；IPv6 的 IPv4-mapped 写法（URL 把 `[::ffff:127.0.0.1]` 归一成
 * `[::ffff:7f00:1]`）同理。
 *
 * `localhost` 这一支是**有意保留的 fail-open**：它依赖 hosts/DNS 解析，hosts 被指向远端时
 * 本函数仍判安全。保留它是为了让设置卡的默认写法可用；要彻底关掉这个口子只能改成只认 IP
 * 字面量，那会让"本机网关"这条最常见用法需要用户自己去查 IP。
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
  // ::1 是 IPv6 回环；::ffff:7fxx:xxxx 是 127.0.0.0/8 的映射写法（按末 32 位数值判）。
  return (
    host === "localhost" || isIpv4Loopback(host) || host === "::1" || isIpv4MappedLoopback(host)
  );
}
