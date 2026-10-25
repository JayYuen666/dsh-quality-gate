// host 半文案字典（lib/messages.ts）的双语契约：
//   1. 两语键集一致、值都是非空串、且不是"把中文抄一遍"；
//   2. 带变量整行的 {占位符} 名字两语一致（漏一个占位符 = 模型收到半句话）；
//   3. renderTemplate 的三条分支（字符串 / 数字 / 字典里没给的名字）。
// 键集一致本来由 tsc 保证（两份都标注同一接口），这里的断言防的是值层面的抄漏。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { MESSAGES, renderTemplate } from "../lib/messages.ts";

/** 两语文典按 string 面取值（interface 无隐式索引签名，测试里一次性投影）。 */
const zh = MESSAGES.zh as unknown as Record<string, string>;
const en = MESSAGES.en as unknown as Record<string, string>;
const keys = Object.keys(MESSAGES.zh);

/** 模板里的 {占位符} 名字集合（不具名捕获组，避开 dot-notation 与 TS4111 的相互要求）。 */
function placeholders(template: string): Set<string> {
  // 必须成对（{ 起、} 止）才算占位符：只按花括号切分会把 "Save" 这类无括号的整串
  // 误当成占位符。不用捕获组：prefer-named-capture-group 与 noPropertyAccessFromIndexSignature
  // 对 match.groups 的写法互斥（同仓 schema-coverage.ts 记过这个坑）。
  const out = new Set<string>();
  for (const part of template.split("{").slice(1)) {
    const name = part.split("}")[0] ?? "";
    if (/^\w+$/u.test(name)) {
      out.add(name);
    }
  }
  return out;
}

describe("host 消息字典（中英双语）", () => {
  it("两语键集一致且值非空（tsc 之外的第二道网：防值抄漏）", () => {
    // toSorted 在本包 lint 的 lib 目标下不存在 → 无序比较用 Set + size/has。
    const enKeys = new Set(Object.keys(MESSAGES.en));
    assert.equal(keys.length, enKeys.size, "键数必须相同");
    assert.ok(keys.length >= 20, "host 侧文案全部收进字典");
    for (const key of keys) {
      assert.ok(enKeys.has(key), `en 缺键：${key}`);
      const zhText = zh[key];
      const enText = en[key];
      assert.ok(typeof zhText === "string" && zhText.length > 0, `zh 空值：${key}`);
      assert.ok(typeof enText === "string" && enText.length > 0, `en 空值：${key}`);
    }
  });

  it("两语文案确实不同（英文是补齐而非中文复读）", () => {
    for (const key of keys) {
      assert.notEqual(en[key], zh[key], `${key} 两语文案相同`);
    }
  });

  it("每条模板的 {占位符} 名字集合两语一致", () => {
    for (const key of keys) {
      assert.deepEqual(
        placeholders(en[key] ?? ""),
        placeholders(zh[key] ?? ""),
        `${key} 占位符不一致`,
      );
    }
  });

  it("注入正文里的变量渲染后不留裸花括号（zh / en 同一入参）", () => {
    const params = {
      command: "pnpm check",
      root: "/w/proj",
      output: "exit=1",
      reason: "exit=1",
      attempts: 2,
      budgetMs: 5000,
      list: "- pnpm check（根 /w/proj）",
      label: "stderr",
      spill: "/tmp/spill",
      head: "head",
      text: "tail",
      mode: "workspace-write",
      enforcement: "partial",
      sandbox: "沙箱模式=workspace-write",
      seconds: 60,
      cause: "命令不存在（工具未安装）",
      message: "boom",
      failure: "TS2345",
    };
    for (const key of keys) {
      for (const dict of [zh, en]) {
        assert.doesNotMatch(renderTemplate(dict[key] ?? "", params), /\{\w+\}/u, `${key} 漏变量`);
      }
    }
  });
});

describe("renderTemplate（{name} 插值）", () => {
  it("字符串与数字值都转成文本；重复占位符逐个替换", () => {
    assert.equal(renderTemplate("{one}+{two}={one}", { one: "x", two: 1 }), "x+1=x");
  });

  it("字典里没有的名字留空串（宁可少一段说明，也不给模型留裸花括号）", () => {
    assert.equal(renderTemplate("前{missing}后", { other: "x" }), "前后");
  });

  it("无占位符的文本原样返回", () => {
    assert.equal(
      renderTemplate("门禁执行被调用方取消（aborted），结果未知。", {}),
      "门禁执行被调用方取消（aborted），结果未知。",
    );
  });
});
