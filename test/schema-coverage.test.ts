// test/schema-coverage.test.ts —— 卡片字段覆盖这项门禁里，负责解析的那一部分的单元测试。
//
// 为什么要单独测这一部分：`schemaCoverageProblems` 少读字段时的表现是"这项门禁通过"——
// 它返回空数组就算通过，漏掉的字段再也不会被拦住。所以解析器的期望值必须来自本文件里独立
// 写死的夹具文本，不能拿真实 host.ts 跑一遍、把它当时的输出抄成期望（那样实现与期望会
// 一起出错、一起通过）。

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hostSchemaFields, schemaCoverageProblems } from "./schema-coverage.ts";

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

  it("值里的右括号不会让块提前收尾（不区分引号、按括号本身数深度会少读后续字段）", () => {
    // beta 的 default("x)") 若不计引号、只按括号本身数深度，块在那一处就闭合，gamma/delta 全丢。
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

  it("候选唯一但名称不是 Config 时交回问题，而不是猜一个", () => {
    // 唯一候选不等于那就是设置：别的 `Schema.object` 赋值（子 schema、默认值）也会命中。
    // 静默采纳会把别的对象的键当成卡片的字段全集，这项门禁就按错误的字段清单判断覆盖。
    const { fields, problems } = hostSchemaFields(
      `const Tool = Schema.object({ x: Schema.string() });\n`,
    );
    assert.deepEqual(fields, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /没有恰好一处叫 Config/u);
  });

  it("schema.object 的第一参不是对象字面量时交回问题，而不是空表", () => {
    const { fields, problems } = hostSchemaFields("export const Config = Schema.object(Base);\n");
    assert.deepEqual(fields, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /第一参不是对象字面量/u);
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

  it("块注释和字符串里的左花括号不参与计数（否则对象块延后收尾、字段静默丢失）", () => {
    const escaped = `export const Config = Schema.object({
  alpha: Schema.string().default("a{").volatile(),
  /* } */
  beta: Schema.string().volatile(),
  gamma: Schema.natural().default(1),
});`;
    const { fields, problems } = hostSchemaFields(escaped);
    assert.deepEqual(problems, []);
    assert.deepEqual(fields, ["alpha", "beta", "gamma"]);
  });

  it("正则字面量里的引号和括号不参与计数（否则其后的字段被静默丢掉）", () => {
    // 两个已知坏形态：正则里的 " 会被 skipString 当成字符串起点、正则里的 } 会让对象块提前收尾。
    // 两种情况的表现都是"后一个字段少读"，而少读字段正是这项门禁会漏报的那种形态，所以各钉一条断言。
    const regexed = `export const Config = Schema.object({
  alpha: Schema.string().default(/["}]/u.source),
  beta: Schema.boolean(),
  gamma: Schema.string().default(/\\}/u.source),
});`;
    const { fields, problems } = hostSchemaFields(regexed);
    assert.deepEqual(problems, []);
    assert.deepEqual(fields, ["alpha", "beta", "gamma"]);
  });

  it("除号不被当成正则起点（前一个实义字符是数字/标识符/右括号时）", () => {
    const division = `export const Config = Schema.object({
  alpha: Schema.natural().default(6 / 2),
  beta: Schema.natural().default((3) / 1),
  gamma: Schema.boolean(),
});`;
    const { fields, problems } = hostSchemaFields(division);
    assert.deepEqual(problems, []);
    assert.deepEqual(fields, ["alpha", "beta", "gamma"]);
  });

  it("解析器抛错时 schemaCoverageProblems 交回一条问题，而不是把堆栈甩给调用方", async () => {
    // 两层的分工：hostSchemaFields 遇到畸形源码宁可抛（不返回半截字段），门禁的入口负责把异常
    // 转成能读的问题描述。用临时包根造一份解析不了的 host.ts，跑真正的入口函数。
    const dir = await mkdtemp(path.join(tmpdir(), "schema-coverage-"));
    try {
      await writeFile(path.join(dir, "package.json"), '{"name": "fixture-pkg"}', "utf8");
      await writeFile(
        path.join(dir, "host.ts"),
        "export const Config = Schema.object({\n  alpha: Schema.string(),\n",
        "utf8",
      );
      const problems = schemaCoverageProblems(
        pathToFileURL(path.join(dir, "test", "gate.test.ts")).href,
      );
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? "", /fixture-pkg/u);
      assert.match(problems[0] ?? "", /设置字段列表解析失败/u);
      assert.match(problems[0] ?? "", /没有配对的闭合括号/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** 最小包根：host.ts 有 alpha/beta 两个设置字段，src/card.ts 只绑定 alpha。 */
async function makeExemptFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "schema-exempt-"));
  await writeFile(path.join(dir, "package.json"), '{"name":"fixture-exempt"}', "utf8");
  await writeFile(
    path.join(dir, "host.ts"),
    "export const Config = Schema.object({\n  alpha: Schema.string(),\n  beta: Schema.string(),\n});\n",
    "utf8",
  );
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "card.ts"), 'field: "alpha"\n', "utf8");
  return dir;
}

/** 在夹具包根上跑门禁入口。 */
async function checkExemptFixture(
  dir: string,
  allowUnbound?: { field: string; reason: string }[],
): Promise<string[]> {
  return schemaCoverageProblems(
    pathToFileURL(path.join(dir, "test", "gate.test.ts")).href,
    allowUnbound === undefined ? {} : { allowUnbound },
  );
}

describe("schema-coverage：allowUnbound 校验", () => {
  it("未绑定字段没豁免 → 点名为「卡片未暴露」", async () => {
    const dir = await makeExemptFixture();
    try {
      const problems = await checkExemptFixture(dir);
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? "", /beta/u);
      assert.match(problems[0] ?? "", /卡片未暴露/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("带理由的豁免 → 通过", async () => {
    const dir = await makeExemptFixture();
    try {
      assert.deepEqual(
        await checkExemptFixture(dir, [{ field: "beta", reason: "仅部署侧使用，卡片无入口" }]),
        [],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("例外声明指向 host 里不存在的字段 → 这条对不上号的例外当场失败", async () => {
    const dir = await makeExemptFixture();
    try {
      const problems = await checkExemptFixture(dir, [
        { field: "beta", reason: "仅部署侧使用" },
        { field: "gamma", reason: "拼写错误的字段" },
      ]);
      assert.equal(problems.length, 1, "未知豁免只报一条，不是被当成已豁免");
      assert.match(problems[0] ?? "", /不存在的字段/u);
      assert.match(problems[0] ?? "", /gamma/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("同一字段重复声明例外 → 点名重复声明（Map 也不许静默合并）", async () => {
    const dir = await makeExemptFixture();
    try {
      const problems = await checkExemptFixture(dir, [
        { field: "beta", reason: "第一条理由" },
        { field: "beta", reason: "第二条理由" },
      ]);
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? "", /重复声明/u);
      assert.match(problems[0] ?? "", /beta/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("豁免已绑定的字段 → 报「已过时」", async () => {
    const dir = await makeExemptFixture();
    try {
      // beta 仍然带着理由声明例外，否则"未暴露"也会各占一条——这里只留"已过时"这一条判据。
      const problems = await checkExemptFixture(dir, [
        { field: "alpha", reason: "已经不用的理由" },
        { field: "beta", reason: "仅部署侧使用" },
      ]);
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? "", /已过时/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("例外声明没有理由 → 等于没有这项门禁，当场失败", async () => {
    const dir = await makeExemptFixture();
    try {
      const problems = await checkExemptFixture(dir, [{ field: "beta", reason: "   " }]);
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? "", /缺少 reason/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
