// test/schema-coverage.ts —— 卡片字段覆盖门禁（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景：host.ts 用 `Schema.object({...})` 声明 N 个设置字段，
// client 卡片只渲染 M 个（M < N）→ 那 N-M 个字段用户无法从 UI 触及，只能改 settings 底层或
// 读源码。踩过的坑：quality-gate 的 `memoryFeedback`（功能性开关——host.ts 的
// `if (isCodeFailure && cfg.memoryFeedback)` 决定是否把门禁失败写入记忆库，且有专门测试）在卡片
// 漏项，审查后才被发现。
//
// 做法：解析 host.ts 的 Schema.object 字段名 + client 源码树（src/** + lib/**）实际绑定的
// 字段名，断言后者 ⊇ 前者。漏项必须显式列入 allowUnbound 并给理由——测试同时校验
// allowUnbound 里的每一项确实未被绑定（防止"挂名豁免"绕过门禁）。
//
// 用法（各包 test/build-client.test.ts 的用例里断言一次；helper 交回**问题清单**，
// 空数组即通过 —— 同 client-freshness.ts 的理由）：
//   assert.deepEqual(schemaCoverageProblems(import.meta.url), []);
//   assert.deepEqual(schemaCoverageProblems(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   }), []);
//
// 两侧的松紧方向相反：**host 侧少读一个字段就是假绿**（漏项不再被拦），所以读不准的形态
// （没有设置 schema、括号不配对、清单读不到）一律交回一条问题，不返回空表；client 侧
// 读宽一点无害（见 boundFieldsIn），只是让门禁更松。

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** 括号配对字符表（`({[` 与 `)}]` 成对）。 */
const CLOSERS: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

/** 跳过空白与注释，返回下一个有效字符的下标（到末尾则回 text.length）。 */
function skipTrivia(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const char = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (/\s/u.test(char)) {
      i += 1;
    } else if (char === "/" && next === "/") {
      const eol = text.indexOf("\n", i);
      i = eol === -1 ? text.length : eol + 1;
    } else if (char === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
    } else {
      return i;
    }
  }
  return i;
}

/** 从引号起跳过整个字符串字面量（含转义），返回收尾引号之后的下标；未闭合即抛。 */
function skipString(text: string, from: number): number {
  const quote = text[from] ?? "";
  let i = from + 1;
  while (i < text.length) {
    const char = text[i] ?? "";
    if (char === "\\") {
      i += 2;
    } else if (char === quote) {
      return i + 1;
    } else {
      i += 1;
    }
  }
  throw new Error(`源码里从下标 ${from} 起的 ${quote} 字面量没有闭合`);
}

/** 扫描栈的一层：`opener` 是开符号（报错时点名），`closer` 是期望的收尾字符。 */
interface ScanLevel {
  opener: string;
  closer: string;
  /** 模板正文段：只认转义、收尾反引号与 `${`，括号字符一律当正文。 */
  template: boolean;
}

/** 推进一格的结果：`closed` 表示这一步弹掉了一层（最外层弹空即扫描结束）。 */
interface Step {
  next: number;
  closed: boolean;
}

/** 模板正文里推进一格；`${` 会压入一个代码层，收尾反引号会弹出当前层。 */
function templateStep(text: string, from: number, levels: ScanLevel[]): Step {
  const char = text[from] ?? "";
  const next = text[from + 1] ?? "";
  if (char === "\\") {
    return { next: from + 2, closed: false };
  }
  if (char === "`") {
    levels.pop();
    return { next: from + 1, closed: true };
  }
  if (char === "$" && next === "{") {
    levels.push({ opener: "${", closer: "}", template: false });
    return { next: from + 2, closed: false };
  }
  return { next: from + 1, closed: false };
}

/** 代码段里推进一格：括号压栈/弹栈，字符串、注释、模板整体跳过。 */
function codeStep(text: string, from: number, levels: ScanLevel[]): Step {
  const char = text[from] ?? "";
  const next = text[from + 1] ?? "";
  if (char === '"' || char === "'") {
    return { next: skipString(text, from), closed: false };
  }
  if (char === "`") {
    levels.push({ opener: "`", closer: "`", template: true });
    return { next: from + 1, closed: false };
  }
  if (char === "/" && (next === "/" || next === "*")) {
    return { next: skipTrivia(text, from), closed: false };
  }
  const nested = CLOSERS[char];
  if (nested !== undefined) {
    levels.push({ opener: char, closer: nested, template: false });
    return { next: from + 1, closed: false };
  }
  if (char !== ")" && char !== "}" && char !== "]") {
    return { next: from + 1, closed: false };
  }
  const top = levels.at(-1);
  if (top === undefined || top.closer !== char) {
    throw new Error(
      `括号不配对：${top?.opener ?? "?"} 对应的是 ${top?.closer ?? "?"}，实得 ${char}（下标 ${from}）`,
    );
  }
  levels.pop();
  return { next: from + 1, closed: true };
}

/**
 * 从开符号（`(` `{` `[` 或反引号）下标起找配对收尾符号的下标；字符串、模板正文、
 * 注释里的括号不参与计数。
 *
 * 一个循环同时管「代码段」与「模板正文段」，而不是两个函数互递归：模板里的 `${…}`
 * 要把控制权交回代码段，双向递归会让其中一侧永远"先用后定义"，也更容易漏掉一层。
 *
 * 括号计数必须跳过字面量：块里出现 `default(")")` 这类写法时，只数字符会让配对提前
 * 收尾，其后所有字段静默消失——那正是本门禁最怕的假绿。
 */
function closingIndexOf(text: string, from: number): number {
  const opener = text[from] ?? "";
  const isTemplate = opener === "`";
  const expected = isTemplate ? "`" : CLOSERS[opener];
  if (expected === undefined) {
    throw new TypeError(`扫描起点必须是 ( { [ 或反引号之一，实得 ${JSON.stringify(opener)}`);
  }
  const levels: ScanLevel[] = [{ opener, closer: expected, template: isTemplate }];
  let i = from + 1;
  while (i < text.length) {
    const top = levels.at(-1);
    if (top === undefined) {
      break;
    }
    const step = top.template ? templateStep(text, i, levels) : codeStep(text, i, levels);
    if (step.closed && levels.length === 0) {
      return i;
    }
    i = step.next;
  }
  throw new Error(`源码里从下标 ${from} 起的 ${opener} 没有配对的闭合括号`);
}

/** 从反引号起跳过整个模板字面量，返回收尾反引号之后的下标；未闭合即抛。 */
function skipTemplate(text: string, from: number): number {
  return closingIndexOf(text, from) + 1;
}

/** 该位置起若是字符串或模板字面量，返回它之后的下标；否则 `undefined`。 */
function skipLiteralAt(text: string, from: number): number | undefined {
  const char = text[from] ?? "";
  if (char === '"' || char === "'") {
    return skipString(text, from);
  }
  return char === "`" ? skipTemplate(text, from) : undefined;
}

/**
 * 一段源码里所有 `= Schema.object(` 形态的下标（只认赋值形态，避开调用与嵌套声明）。
 *
 * 正则从字符类起笔（`[\s]*=`）：写成 `/=\s*…/` 会被 no-div-regex 判成"看起来像除赋值"。
 */
function schemaObjectSites(hostTs: string): number[] {
  const sites: number[] = [];
  for (const match of hostTs.matchAll(/[\s]*=[\s]*Schema\.object[\s]*\(/gu)) {
    sites.push(match.index);
  }
  return sites;
}

/** 在候选站点里挑出设置 schema：认 `export const Config =`，否则只在候选唯一时采纳。 */
function pickSchemaSite(hostTs: string, sites: number[]): number | undefined {
  const named = sites.filter((site) => /export\s+const\s+Config\s*$/u.test(hostTs.slice(0, site)));
  if (named.length === 1) {
    return named[0];
  }
  return sites.length === 1 ? sites[0] : undefined;
}

/** 顶层键位读取结果：`index` 是冒号之后的下标，`field` 只在值紧跟 `Schema.` 时给出。 */
interface KeyHit {
  index: number;
  field: string | undefined;
}

/** 「键:」前缀（sticky：从指定下标起匹配，不做切片）。 */
const KEY_PREFIX = /(?<key>[A-Za-z_$][\w$]*)\s*:/uy;

/**
 * 在顶层位置上尝试读「键 → Schema.*」字段；不是字段形态时回 `null`。
 *
 * 深度非 0 或不在键位上时直接回 `null`：嵌套子对象里的键属于值，不是设置字段。
 * 用 `null` 而不是 `undefined` 表示"没命中"：本函数另一条出口回对象，混用两种"没有值"
 * 会让 consistent-return 认为存在不回值的路径。
 */
function fieldKeyAt(body: string, from: number, depth: number, expectKey: boolean): KeyHit | null {
  if (depth !== 0 || !expectKey) {
    return null;
  }
  KEY_PREFIX.lastIndex = from;
  const key = KEY_PREFIX.exec(body);
  const name = key?.groups?.["key"];
  if (key === null || name === undefined) {
    return null;
  }
  const afterColon = from + key[0].length;
  const isSchemaValue = body.startsWith("Schema.", skipTrivia(body, afterColon));
  return { index: afterColon, field: isSchemaValue ? name : undefined };
}

/**
 * 抽取对象字面量体里**顶层**的「键 → Schema.* 值」字段名。
 *
 * 只认深度 0 上的属性名，且值经空白后紧跟 `Schema.` 才算字段：多行书写
 * （`foo:\n  Schema.xxx`）照样读到，行内注释、嵌套子对象、字符串里的 `key:` 都不会误读。
 * 不再要求「字段与 Schema. 同一行」，也不再依赖缩进宽度。
 */
function schemaFieldsInBody(body: string): string[] {
  const fields: string[] = [];
  let i = 0;
  let depth = 0;
  let expectKey = true;
  while (i < body.length) {
    i = skipTrivia(body, i);
    if (i >= body.length) {
      break;
    }
    const char = body[i] ?? "";
    const literalEnd = skipLiteralAt(body, i);
    const hit = literalEnd === undefined ? fieldKeyAt(body, i, depth, expectKey) : null;
    if (literalEnd !== undefined) {
      i = literalEnd;
      expectKey = false;
    } else if (char === ",") {
      i += 1;
      expectKey = depth === 0;
    } else if (CLOSERS[char] !== undefined) {
      depth += 1;
      i += 1;
      expectKey = false;
    } else if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      i += 1;
      expectKey = false;
    } else if (hit === null) {
      i += 1;
      expectKey = false;
    } else {
      if (hit.field !== undefined) {
        fields.push(hit.field);
      }
      i = hit.index;
      expectKey = false;
    }
  }
  return fields;
}

/**
 * 从 host.ts 文本抽取设置 schema 的字段名；读不准时回 `problems`（不是静默空表）。
 *
 * 导出是为了让解析面本身能被用例钉住：这一面读错的表现恰好是"门禁通过"（少读字段 =
 * 漏项不再被拦），所以它的期望值必须来自独立写死的夹具，而不是跑一遍真实 host.ts 看结果。
 */
export function hostSchemaFields(hostTs: string): { fields: string[]; problems: string[] } {
  const sites = schemaObjectSites(hostTs);
  if (sites.length === 0) {
    return {
      fields: [],
      problems: ["host.ts 里没有 `= Schema.object(` 的赋值形态，找不到设置 schema"],
    };
  }
  const site = pickSchemaSite(hostTs, sites);
  if (site === undefined) {
    return {
      fields: [],
      problems: [
        `host.ts 里有 ${sites.length} 处 Schema.object 赋值，且没有恰好一处叫 Config：` +
          `无法确定哪个是设置面，请把设置 schema 命名为 Config（认错块会少读字段而假绿）`,
      ],
    };
  }
  const openParen = hostTs.indexOf("(", site);
  const openBrace = skipTrivia(hostTs, openParen + 1);
  if (hostTs[openBrace] !== "{") {
    return { fields: [], problems: [`Schema.object 的第一参不是对象字面量（下标 ${openBrace}）`] };
  }
  const closeBrace = closingIndexOf(hostTs, openBrace);
  return { fields: schemaFieldsInBody(hostTs.slice(openBrace + 1, closeBrace)), problems: [] };
}

/** 捕获组取值（严格模式下 matchAll 捕获为 `string | undefined`，这里收口为 string）。 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
function boundFieldsIn(src: string): Set<string> {
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of src.matchAll(/\bfield\s*:\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(group(match, 1));
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   刻意不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。字段名是否算"绑定"由 schemaCoverageProblems 与 host 字段名交集判定。
  for (const match of src.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(group(match, 1));
  }
  return out;
}

/** client 侧源码形态：卡片/输入组件可能是 .tsx，也与 .mts/.cts/.js(x) 混用。 */
const CLIENT_SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx)$/u;
/** 声明文件不是源码：它的 `foo: Schema.` 形态会把未绑定的字段读成"已绑定"。 */
const DECLARATION = /\.d\.(?:ts|mts|cts)$/u;

/** 递归收集目录下的 client 源码文本（跳过 node_modules 与符号链接）。 */
function walk(dir: string, problems: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) {
    return out;
  }
  let entries;
  try {
    // withFileTypes 一次读类型：既不 statSync（断链会抛 ENOENT），也能跳过符号链接
    // （环状软链会递归到无限深）。
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    problems.push(`读不到目录 ${dir}：${String(error)}`);
    return out;
  }
  for (const entry of entries.filter((item) => !item.isSymbolicLink())) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        out.push(...walk(filePath, problems));
      }
    } else if (CLIENT_SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) {
      try {
        out.push(readFileSync(filePath, "utf8"));
      } catch (error) {
        problems.push(`读不到源码 ${filePath}：${String(error)}`);
      }
    }
  }
  return out;
}

/** client 侧实际绑定的字段名集合（src/** + lib/**）。 */
function clientBoundFields(pkgDir: string, problems: string[]): Set<string> {
  const out = new Set<string>();
  for (const src of [
    ...walk(path.join(pkgDir, "src"), problems),
    ...walk(path.join(pkgDir, "lib"), problems),
  ]) {
    for (const field of boundFieldsIn(src)) {
      out.add(field);
    }
  }
  return out;
}

/**
 * 从测试文件位置向上找最近的含 package.json 的目录；找到根也没有时回 `null`。
 *
 * 不写死 `testDir/..`：helper 被放到 `test/unit/` 或 `test/helpers/` 之后，硬编码的父目录
 * 会指到 `test/` 自己，于是 `package.json` 读不到、门禁红在一条与真实原因无关的读盘失败上。
 *
 * 用 `null` 而不是 `undefined` 表示"没找到"：本函数另一条出口回字符串，混用两种
 * "没有值"会让 consistent-return 与调用方的 `=== undefined` 判据各说一套。
 */
function packageDirOf(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** 读一份文件文本；读不到时回 `null` 并记一条点名文件的问题。 */
function readSource(file: string, label: string, problems: string[]): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    problems.push(`[${label}] 读不到 ${file}：${String(error)}`);
    return null;
  }
}

/**
 * 「卡片字段覆盖 host schema」门禁的问题清单（空数组即通过）。
 *
 * 交回清单而不是自己登记用例：登记只能发生在用例文件的 describe/用例体内，
 * 且断言得写在那个体内才看得见（vitest require-hook + expect-expect）。
 * 调用点写法见本文件头。
 */
export function schemaCoverageProblems(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): string[] {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const foundDir = packageDirOf(testDir);
  if (foundDir === null) {
    return [`从 ${testDir} 向上找不到 package.json：门禁的包根无从确定`];
  }
  const pkgDir = realpathSync(foundDir);
  const problems: string[] = [];
  const manifest = readSource(path.join(pkgDir, "package.json"), pkgDir, problems);
  const pkgName =
    manifest === null
      ? pkgDir
      : (/"name":\s*"(?<name>[^"]+)"/u.exec(manifest)?.groups?.["name"] ?? "unknown");
  const hostTs = readSource(path.join(pkgDir, "host.ts"), pkgName, problems);
  if (hostTs === null) {
    return problems;
  }

  const parsed = hostSchemaFields(hostTs);
  problems.push(...parsed.problems);
  const hostFields = parsed.fields;
  const bound = clientBoundFields(pkgDir, problems);
  const exemptions = new Map((opts.allowUnbound ?? []).map((item) => [item.field, item.reason]));

  if (hostFields.length === 0) {
    problems.push(
      `[${pkgName}] host.ts 未解析出任何 Schema.object 设置字段（解析失败或该包无设置）`,
    );
  }
  const missing = hostFields.filter((field) => !bound.has(field));
  const unexempted = missing.filter((field) => !exemptions.has(field));
  if (unexempted.length > 0) {
    problems.push(
      `[${pkgName}] 以下 host 设置字段卡片未暴露：${unexempted.join(", ")}\n` +
        `host 字段全集：${hostFields.join(", ")}\n` +
        `卡片已绑定：${[...bound].join(", ")}\n` +
        `→ 补卡片控件；若确实不该有 UI 入口，在 schemaCoverageProblems 的 allowUnbound 里\n` +
        `  显式声明 { field, reason }（测试会校验被豁免项确实未绑定，防止挂名豁免）。`,
    );
  }
  // 反向校验：豁免项若其实已绑定，说明豁免过时——删除即可，留着会让门禁失效。
  const stale = [...exemptions].filter(([field]) => bound.has(field));
  if (stale.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 已过时——这些字段其实已绑定，请删除豁免声明：${stale.map(([field, reason]) => `${field}（${reason}）`).join(", ")}`,
    );
  }
  // 豁免必须有理由，否则等于无门禁。
  const noReason = [...exemptions].filter(
    ([, reason]) => typeof reason !== "string" || reason.trim().length === 0,
  );
  if (noReason.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 项缺少 reason：${noReason.map(([field]) => field).join(", ")}`,
    );
  }
  return problems;
}
