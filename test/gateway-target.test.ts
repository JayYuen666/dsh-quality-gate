import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isCredentialSafeUrl } from "../lib/gateway-target.ts";

describe("凭据投递的地址判据", () => {
  it("https 一律允许；http 只允许回环三种写法", () => {
    assert.equal(isCredentialSafeUrl("https://gateway.example:8420"), true);
    assert.equal(isCredentialSafeUrl("http://127.0.0.1:8420"), true);
    assert.equal(isCredentialSafeUrl("http://localhost:8420"), true);
    assert.equal(isCredentialSafeUrl("http://[::1]:8420"), true);
  });

  it("明文 http 的远端、其它 scheme 与不成形的地址一律拒绝", () => {
    assert.equal(isCredentialSafeUrl("http://gateway.example:8420"), false);
    assert.equal(isCredentialSafeUrl("http://192.168.1.10:8420"), false);
    assert.equal(isCredentialSafeUrl("ftp://gateway.example"), false);
    assert.equal(isCredentialSafeUrl("gateway.example:8420"), false);
    assert.equal(isCredentialSafeUrl("not a url"), false, "解析不了也按不安全处理");
  });
});
