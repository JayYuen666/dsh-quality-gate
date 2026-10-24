// test/schema-coverage.test.ts —— 卡片字段覆盖门禁的**解析面**单元测试。
//
// 为什么单独钉这一面：`schemaCoverageProblems` 读少字段的表现是"门禁通过"——
// 它交回空数组就是绿，漏掉的字段再也不会被拦。所以解析器的期望值必须来自本文件里独立
// 写死的夹具文本，不能拿真实 host.ts 跑一遍、把它当时的输出抄成期望（那样实现与期望会
// 一起错、一起绿）。

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { hostSchemaFields } from "./schema-coverage.ts";

/** 覆盖「同一行」「换行」两种字段写法 + 行内注释 + 值里带括号。 */
const FIXTURE_HOST = `import { Schema } from "@deepseek-ai/cordis";

const DEFAULTS = { nested: 1 };

export const Other = Schema.object({
  notASettingField: Schema.string(),
});

export const Config = Schema.object({
  alpha: Schema.boolean().default(true).volatile(),
  beta: Schema.string()
    .default("x)")
    .volatile(),
  // 注释里的 dummy: Schema.string() 不是字段
  gamma: Schema.natural().default(3).volatile(),
  delta: Schema.object({ nested: Schema.string() }).volatile(),
  helper: DEFAULTS.nested,
});
`;

describe("schema-coverage：host schema 解析", () => {
  it("读到全部顶层字段，含换行书写、跳过注释与嵌套子对象", () => {
    const { fields, problems } = hostSchemaFields(FIXTURE_HOST);
    assert.deepEqual(problems, []);
    assert.deepEqual(fields, ["alpha", "beta", "gamma", "delta"]);
  });

  it("值里的右括号不会让块提前收尾（按裸字符计数会少读后续字段）", () => {
    // beta 的 default("x)") 若按裸字符深度匹配，块在那一处就闭合，gamma/delta 全丢。
    const { fields } = hostSchemaFields(FIXTURE_HOST);
    assert.ok(fields.includes("gamma"), "gamma 必须被读到：右括号出现在字符串里不该提前收尾");
    assert.ok(fields.includes("delta"), "delta 必须被读到：右括号出现在字符串里不该提前收尾");
  });

  it("候选不唯一且没有一处叫 Config 时交回问题，而不是猜一个", () => {
    const ambiguous = `const A = Schema.object({ x: Schema.string() });
const B = Schema.object({ y: Schema.string() });`;
    const { fields, problems } = hostSchemaFields(ambiguous);
    assert.deepEqual(fields, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /没有恰好一处叫 Config/u);
  });

  it("找不到 Schema.object 赋值时交回问题，而不是空表", () => {
    const { fields, problems } = hostSchemaFields("const x = 1;\n");
    assert.deepEqual(fields, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /没有 `= Schema\.object\(` 的赋值形态/u);
  });

  it("括号始终不闭合时抛，而不是交回半截字段清单", () => {
    const broken = "export const Config = Schema.object({\n  alpha: Schema.string(),\n";
    assert.throws(() => hostSchemaFields(broken), /没有配对的闭合括号/u);
  });

  it("模板字面量里的括号同样不参与计数", () => {
    const templated = `export const Config = Schema.object({
  alpha: Schema.string().default(\`a)\${"b)"}\`).volatile(),
  beta: Schema.string().volatile(),
});`;
    const { fields } = hostSchemaFields(templated);
    assert.deepEqual(fields, ["alpha", "beta"]);
  });
});
