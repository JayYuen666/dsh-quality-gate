import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isCredentialSafeUrl } from "../lib/gateway-target.ts";

describe("凭据投递的地址判据", () => {
  it("https 一律允许；http 只允许回环：hosts 名、127.0.0.0/8 整段、::1 与 IPv4-mapped", () => {
    assert.equal(isCredentialSafeUrl("https://gateway.example:8420"), true);
    assert.equal(isCredentialSafeUrl("http://localhost:8420"), true);
    assert.equal(isCredentialSafeUrl("http://[::1]:8420"), true);
    // 127/8 整段都只在本机：只认 127.0.0.1 的实现会把绑在 127.0.0.2 / 127.0.1.1 的网关
    // 误判成不安全、静默停掉反馈，而用户从提示里看不出自己就在本机。
    assert.equal(isCredentialSafeUrl("http://127.0.0.1:8420"), true);
    assert.equal(isCredentialSafeUrl("http://127.0.0.2:8420"), true);
    assert.equal(isCredentialSafeUrl("http://127.0.1.1:8420"), true);
    assert.equal(isCredentialSafeUrl("http://127.255.255.255"), true);
    // URL 把 [::ffff:127.0.0.1] 归一成 [::ffff:7f00:1]：映射写法必须按末 32 位数值判。
    assert.equal(isCredentialSafeUrl("http://[::ffff:127.0.0.1]:8420"), true);
    assert.equal(isCredentialSafeUrl("http://[::ffff:127.0.0.2]:8420"), true);
  });

  it("ipv4-mapped 不是 127/8 的地址一律拒绝（前缀相同不等于回环）", () => {
    // ::ffff:7fa:0 的末 32 位是 0x07fa0000 = 7.250.0.0，只有前 8 位碰巧是 7f；
    // 按字符串前缀 ::ffff:7f 判会把它当成回环，把 Bearer 令牌发往远端明文 http。
    assert.equal(isCredentialSafeUrl("http://[::ffff:7fa:0]:8420"), false);
    assert.equal(isCredentialSafeUrl("http://[::ffff:7f0:0]"), false);
    // 0x8000 高 16 位才是 128.0.0.0；7f80 是 127.128.0.0，属 127/8，必须放行。
    assert.equal(isCredentialSafeUrl("http://[::ffff:7f80:0]"), true);
    assert.equal(isCredentialSafeUrl("http://[::ffff:8000:0]"), false, "128.0.0.0 不是回环");
    // 非规范展开写法判否是 fail-closed（宁可少放行，不能多放行）。
    assert.equal(isCredentialSafeUrl("http://[::ffff:0:7f00:1]"), false);
  });

  it("地址里带 userinfo 一律拒绝（即使 scheme 是 https）", () => {
    assert.equal(isCredentialSafeUrl("https://user:pass@gateway.example"), false);
    assert.equal(isCredentialSafeUrl("https://user@gateway.example"), false);
    assert.equal(isCredentialSafeUrl("http://user@localhost:8420"), false);
  });

  it("明文 http 的远端、其它 scheme 与不成形的地址一律拒绝", () => {
    assert.equal(isCredentialSafeUrl("http://gateway.example:8420"), false);
    assert.equal(isCredentialSafeUrl("http://192.168.1.10:8420"), false);
    assert.equal(isCredentialSafeUrl("http://10.0.0.1:8420"), false);
    assert.equal(isCredentialSafeUrl("ftp://gateway.example"), false);
    assert.equal(isCredentialSafeUrl("gateway.example:8420"), false);
    assert.equal(isCredentialSafeUrl("not a url"), false, "解析不了也按不安全处理");
    assert.equal(isCredentialSafeUrl(""), false);
    // 纯空白、只有协议头、只有 scheme 冒号：new URL 都会抛，函数必须收口成 false（不向上抛）。
    assert.equal(isCredentialSafeUrl("   "), false);
    assert.equal(isCredentialSafeUrl("http://"), false);
    assert.equal(isCredentialSafeUrl("https:"), false);
    // scheme 大小写由 URL 归一：HTTPS:// 与 HTTP://localhost 仍按协议语义判。
    assert.equal(isCredentialSafeUrl("HTTPS://gateway.example"), true);
    assert.equal(isCredentialSafeUrl("HTTP://localhost:8420"), true);
    // 运行期入参可能来自 env/配置（类型面管不到）：null/undefined 按不成形收口。
    assert.equal(isCredentialSafeUrl(null as unknown as string), false);
    assert.equal(isCredentialSafeUrl(undefined as unknown as string), false);
  });

  it("主机名欺骗类写法不得被当成回环（userinfo 伪装、后缀伪装）", () => {
    // 这些地址的真实 host 都不是回环。判据必须是解析出来的 hostname，不是串前缀/includes：
    // 改成朴素字符串判定的实现会在这里当场变红，而不是把凭据投给 evil.com。
    assert.equal(isCredentialSafeUrl("http://localhost.evil.com"), false);
    assert.equal(isCredentialSafeUrl("http://127.0.0.1.evil.com"), false);
    assert.equal(
      isCredentialSafeUrl("http://localhost@evil.com"),
      false,
      "localhost 只是 userinfo",
    );
    assert.equal(isCredentialSafeUrl("http://127.0.0.1:8420@evil.com"), false);
    assert.equal(isCredentialSafeUrl("http://evil.com#@127.0.0.1"), false);
  });
});
