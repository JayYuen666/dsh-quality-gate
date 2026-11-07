// test/setup-logs.ts —— 插件运行日志的记录清单（vitest setupFile）。
//
// 为什么不用 vitest 的 `silent`：那只是不显示，新出现的日志照样没人看。这里把"跑测试时不该有
// 插件日志混进报告"变成一条可以判断的契约：
//   ① 每条 `[<pkg>]` 开头的日志必须含有 test/log-templates.ts 里的某个模板片段，否则当场失败；
//   ② 带别家标签的日志出现在本包测试里也失败（说明装配范围错了）；
//   ③ 生产代码一行都不改：级别、文案、时机全部照旧，这份清单只在测试进程里接管输出。
// 用例要看日志内容时用 logged()/loggedText() 取，断言写在用例里。
import { afterEach, beforeEach } from "vitest";
import assert from "node:assert/strict";

import { LOG_TEMPLATES } from "./log-templates.ts";

/** 本包的标签开头，例如 `[quality-gate]`。 */
const PKG_PREFIX = "[quality-gate]";

/** 匹配"包标签"的形式：只认小写短横线命名空间，免得把测试自己的 `[DEBUG]`、`[vite]` 算成别家的日志。 */
const PKG_TAG = /^\[[a-z][a-z0-9-]*\]/u;

/** 插件会用的四个 console 级别（用联合类型取属性，避免用字符串索引 Console）。 */
export type LogLevel = "info" | "warn" | "error" | "log";
const LEVELS: readonly LogLevel[] = ["info", "warn", "error", "log"];

/** 接管到的一次调用：合并成一行后的第一个参数，加上其余实参（堆栈通常在其余实参里）。 */
export interface LogRecord {
  level: LogLevel;
  text: string;
  extra: unknown[];
}

let records: LogRecord[] = [];
const originals = new Map<LogLevel, (...args: unknown[]) => void>();

/** 接管一个级别：处理器单独写成一个函数，不要在 for 循环里现场创建闭包（no-loop-func 防的就是这种情况）。 */
function spyLevel(level: LogLevel): void {
  originals.set(level, console[level]);
  console[level] = (...args: unknown[]) => {
    const [first, ...rest] = args;
    // 归一化之后再 trim：多行模板字符串常以换行或缩进开头，不 trim 会让 startsWith 的判断不起作用，而且没有提示。
    records.push({ level, text: String(first).replaceAll(/\s+/gu, " ").trim(), extra: rest });
  };
}

function install(): void {
  // 已经接管过就直接返回：重复 install 会把上一轮的替换函数当成原始方法存进 originals，
  // 之后 uninstall 恢复的是那个替换函数自己，console 就再也恢复不回来了。
  if (originals.size > 0) {
    return;
  }
  for (const level of LEVELS) {
    spyLevel(level);
  }
}

function uninstall(): void {
  for (const [level, fn] of originals) {
    console[level] = fn;
  }

  originals.clear();
}

/** 片段长度下限：`includes("")` 对任何日志都成立，太短又通用的片段会让包含相同字符序列的新日志
 *  被误判成"已认领"（断言于是永远成立）。12 比当前清单里最短的那条（"injected at turn"）还低一档：
 *  短于它的片段在这里直接报错，不靠人工约定来保证。 */
const MIN_TEMPLATE_LENGTH = 12;

function assertTemplatesUsable(): void {
  const bad = LOG_TEMPLATES.filter(
    (fragment) => typeof fragment !== "string" || fragment.length < MIN_TEMPLATE_LENGTH,
  );
  if (bad.length > 0) {
    throw new Error(
      `log-templates.ts 里有空/过短的模板片段（${JSON.stringify(bad)}）：它们会让任意日志都算"已认领"，断言随之失效。`,
    );
  }
}

function containsTemplate(text: string): boolean {
  return LOG_TEMPLATES.some((fragment) => text.includes(fragment));
}

/** 失败时把整次调用（包括堆栈所在的其余实参）写进断言消息：只报前 120 个字符会漏掉失败原因。 */
function describeRecord(record: LogRecord): string {
  const extra = record.extra
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
    .join(" ");
  return `${record.level}: ${record.text}${extra === "" ? "" : ` | ${extra}`}`;
}

assertTemplatesUsable();

beforeEach(() => {
  records = [];
  install();
});

afterEach(() => {
  uninstall();
  const ours = records.filter((record) => record.text.startsWith(PKG_PREFIX));
  // 只认"包标签"这种写法：测试自己的 `[DEBUG]`、`[vite]` 一类方括号提示和装配范围无关。
  const strangers = records
    .filter((record) => PKG_TAG.test(record.text) && !record.text.startsWith(PKG_PREFIX))
    .map((record) => describeRecord(record));
  const unclaimed = ours
    .filter((record) => !containsTemplate(record.text))
    .map((record) => describeRecord(record));

  assert.deepEqual(strangers, [], "本包测试里出现了别家插件的日志：装配范围错了");
  assert.deepEqual(
    unclaimed,
    [],
    "这些日志对不上本包源码里的任何模板片段：新增 console.* 没有用例认领，或消息是临时拼的",
  );
});

/** 当前这条用例产生的插件日志，按调用顺序排列。 */
export function logged(): readonly LogRecord[] {
  return records.filter((record) => record.text.startsWith(PKG_PREFIX));
}

/** 合并成一行后的日志正文，方便用 match 这类断言。 */
export function loggedText(): string {
  return logged()
    .map((record) => record.text)
    .join("\n");
}
