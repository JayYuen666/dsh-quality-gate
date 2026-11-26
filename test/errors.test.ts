// test/errors.test.ts —— 错误摘要的分类口径（注入文案与日志都直接用它，空摘要会让排查断线）。
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { messageOf } from "../lib/errors.ts";

/** `messageOf` 读不到成因时统一回落的字面量。 */
const UNKNOWN = "unknown error";

describe("messageOf", () => {
  it("error 用 message；空 message 退回 String(error) 至少留下 name", () => {
    assert.equal(messageOf(new Error("boom")), "boom");
    const blank = new Error("placeholder");
    blank.message = "";
    assert.equal(messageOf(blank), "Error");
  });

  it("字符串原样；空串与其它类型走 unknown error", () => {
    assert.equal(messageOf("plain"), "plain");
    assert.equal(messageOf(""), UNKNOWN);
    assert.equal(messageOf(undefined), UNKNOWN);
    assert.equal(messageOf(42), UNKNOWN);
  });

  it("非 Error 对象读字符串型 message，读不到才算 unknown", () => {
    assert.equal(messageOf({ message: "host said no", code: "X" }), "host said no");
    assert.equal(messageOf({ message: "" }), UNKNOWN);
    assert.equal(messageOf({ message: 7 }), UNKNOWN);
    assert.equal(messageOf(null), UNKNOWN);
  });
});
