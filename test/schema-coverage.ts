// test/schema-coverage.ts ——门禁卡片有没有漏掉设置字段（多个包共用，每个包一份副本，和 client-freshness.ts 一样）。
//
// 背景：host.ts 用 `Schema.object({...})` 声明了 N 个设置字段，
// client 卡片只渲染 M 个（M < N）→ 剩下的 N-M 个字段用户在界面上碰不到，只能改 settings 底层文件或者
// 读源码。出过这样的事：quality-gate 的 `memoryFeedback`（一个功能开关——host.ts 里的
// `if (isCodeFailure && cfg.memoryFeedback)` 决定要不要把门禁失败写进记忆，而且有专门的测试）在卡片上
// 漏了，人工审查之后才发现。
//
// 做法：解析 host.ts 里 Schema.object 的字段名，再加上 client 源码树（src/** 和 lib/**）里实际绑定用的
// 字段名，断言后者包含前者。确实不绑定的字段必须显式写进 allowUnbound 并给出理由——测试同时检查
// allowUnbound 里的每一项确实没有被绑定（防止用一条对不上号的例外声明绕过这项门禁）。
//
// 用法（各包 test/build-client.test.ts 的用例里断言一次；这个辅助函数返回**问题清单**，
// 空数组表示通过 —— 理由同 client-freshness.ts）：
//   assert.deepEqual(schemaCoverageProblems(import.meta.url), []);
//   assert.deepEqual(schemaCoverageProblems(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   }), []);
// 两边放严的方向不一样：**host 侧少读一个字段就会造成误判通过**（漏掉的字段不再被拦住），所以读不出来的情况
// （没有设置 schema、括号不配对、清单读不到）一律返回一条问题，不返回空列表；client 侧
// 读宽一点没有害处（见 boundFieldsIn），只是让这项检查更松。

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** 成对符号表（`({[` 对应 `)}]`）。 */
const CLOSERS: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

/** 跳过空白和注释，返回下一个有效字符的下标（走到末尾就返回 text.length）。 */
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

/** 从引号开始跳过整个字符串字面量（包括转义），返回结束引号之后的下标；没有闭合就抛。 */
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

/** 扫描栈里的一层：`opener` 是开始符号（报错时用它指出位置），`closer` 是期望的结束字符。 */
interface ScanLevel {
  opener: string;
  closer: string;
  /** 模板正文段：只认转义、结束反引号和 `${`，括号一律按正文处理。 */
  template: boolean;
}

/** 前进一格的结果：`closed` 表示这一步退掉了一层（最外层退空就是扫描结束）。 */
interface Step {
  next: number;
  closed: boolean;
}

/** 在模板正文里前进一格；遇到 `${` 压入一个代码层，遇到结束反引号弹出当前层。 */
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

/** 斜杠前面是这些有实际意义的字符时，它开始的是一个正则字面量，而不是除号。 */
const REGEX_PRECEDERS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "{",
  ";",
  "!",
  "&",
  "|",
  "?",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);

/** 从 from 往前找第一个非空白字符（跳过换行和缩进）；找不到返回 undefined。 */
function previousSignificant(text: string, from: number): string | undefined {
  return /(?<char>\S)(?=\s*$)/u.exec(text.slice(0, from))?.groups?.["char"];
}

/**
 * 这个位置的斜杠是在开始一个正则字面量，还是除号。
 *
 * 不识别正则的后果不是"读得慢一点"：正则里的引号会骗 skipString 把后面的字面量一起吞掉，
 * 正则里的右花括号会让对象块提前结束——两种情况都会让后面的 key: Schema.* 少读掉，而少读字段
 * 正是这项检查最坏的失效方式。判断只能看前一个有效字符：标识符、数字、右括号之后是除号，
 * 运算符或者开始符号之后才可能是正则。
 */
function isRegexStart(text: string, from: number): boolean {
  const previous = previousSignificant(text, from);
  return previous !== undefined && REGEX_PRECEDERS.has(previous);
}

/** 从正则字面量的开始斜杠跳到结束斜杠和修饰符之后；没有闭合就抛（不猜）。 */
function skipRegexLiteral(text: string, from: number): number {
  let i = from + 1;
  let inClass = false;
  while (i < text.length && text[i] !== "\n") {
    const char = text[i] ?? "";
    if (char === "\\") {
      i += 2;
    } else if (char === "[") {
      inClass = true;
      i += 1;
    } else if (char === "]") {
      inClass = false;
      i += 1;
    } else if (char === "/" && !inClass) {
      i += 1;
      while (i < text.length && /[a-z]/iu.test(text[i] ?? "")) {
        i += 1;
      }
      return i;
    } else {
      i += 1;
    }
  }
  throw new Error(`源码里从下标 ${from} 起的正则字面量没有闭合的斜杠`);
}

/**
 * 字符串、注释和正则字面量（模板字面量由 codeStep 另外压栈处理）：命中时返回它之后的下标。
 *
 * 单独抽成一个函数是为了让 codeStep 的分支数量保持在复杂度上限之内——它本来就是一个字符一个分支。
 */
function stepOpaque(text: string, from: number): number | undefined {
  const char = text[from] ?? "";
  const next = text[from + 1] ?? "";
  if (char === '"' || char === "'") {
    return skipString(text, from);
  }
  if (char === "/" && (next === "/" || next === "*")) {
    return skipTrivia(text, from);
  }
  return char === "/" && isRegexStart(text, from) ? skipRegexLiteral(text, from) : undefined;
}

/** 弹出与 char 配对的那一层；不配对就抛（宁可抛错也不交出括号数错一半的结果）。 */
function closeLevel(from: number, char: string, levels: ScanLevel[]): Step {
  const top = levels.at(-1);
  if (top === undefined || top.closer !== char) {
    throw new Error(
      `括号不配对：${top?.opener ?? "?"} 对应的是 ${top?.closer ?? "?"}，实得 ${char}（下标 ${from}）`,
    );
  }
  levels.pop();
  return { next: from + 1, closed: true };
}

/** 在代码段里前进一格：括号进栈出栈，字符串、注释、模板、正则整体跳过。 */
function codeStep(text: string, from: number, levels: ScanLevel[]): Step {
  const char = text[from] ?? "";
  const opaqueEnd = stepOpaque(text, from);
  if (opaqueEnd !== undefined) {
    return { next: opaqueEnd, closed: false };
  }
  if (char === "`") {
    levels.push({ opener: "`", closer: "`", template: true });
    return { next: from + 1, closed: false };
  }
  const nested = CLOSERS[char];
  if (nested !== undefined) {
    levels.push({ opener: char, closer: nested, template: false });
    return { next: from + 1, closed: false };
  }
  if (char !== ")" && char !== "}" && char !== "]") {
    return { next: from + 1, closed: false };
  }
  return closeLevel(from, char, levels);
}

/**
 * 从开始符号（`(`、`{`、`[` 或反引号）的下标起找配对的结束符号下标；字符串、模板正文和
 * 注释里的括号不计入。
 *
 * 用一个循环同时处理"代码段"和"模板正文段"，而不是两个函数互相递归：模板里的 `${…}`
 * 要把控制权交回代码段，双向递归会让其中一侧一直"先用后定义"，也更容易漏掉一层。
 *
 * 数括号必须跳过字面量：块里出现 `default(")")` 这种写法时，只数字符会让配对提前结束，
 * 后面所有字段都不见了——那正是这项门禁最怕的失效方式。
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

/** 从反引号开始跳过整个模板字面量，返回结束反引号之后的下标；没有闭合就抛。 */
function skipTemplate(text: string, from: number): number {
  return closingIndexOf(text, from) + 1;
}

/** 这个位置如果开始的是字符串或模板字面量，返回它之后的下标；否则返回 `undefined`。 */
function skipLiteralAt(text: string, from: number): number | undefined {
  const char = text[from] ?? "";
  if (char === '"' || char === "'") {
    return skipString(text, from);
  }
  return char === "`" ? skipTemplate(text, from) : undefined;
}

/**
 * 一段源码里所有 `= Schema.object(` 出现的下标（只认赋值这种写法，避开函数调用和嵌套声明）。
 *
 * 正则从字符类开始写（`[\s]*=`）：写成 `/=\s*…/` 会被 no-div-regex 判成"看起来像除号赋值"。
 */
function schemaObjectSites(hostTs: string): number[] {
  const sites: number[] = [];
  for (const match of hostTs.matchAll(/\s*=\s*Schema\.object\s*\(/gu)) {
    sites.push(match.index);
  }
  return sites;
}

/** 在候选位置里挑出设置用的 schema：只认 `export const Config =`（只有一个候选时也得是它）。
 *  只按"候选只有一个"来采纳时，任何一处无关的 `xxx = Schema.object(...)` 都会被当成设置对象，
 *  读出来的字段全集其实是别的对象的键——这项门禁会按错的字段集合判断覆盖情况（要么误判通过要么报错）。 */
function pickSchemaSite(hostTs: string, sites: number[]): number | undefined {
  const named = sites.filter((site) => /export\s+const\s+Config\s*$/u.test(hostTs.slice(0, site)));
  return named.length === 1 ? named[0] : undefined;
}

/** 读顶层键的结果：`index` 是冒号之后的下标，`field` 只在值紧跟 `Schema.` 时才给出。 */
interface KeyHit {
  index: number;
  field: string | undefined;
}

/** "键:" 这个前缀（sticky 模式：从指定下标开始匹配，不做切片）。 */
const KEY_PREFIX = /(?<key>[A-Za-z_$][\w$]*)\s*:/uy;

/**
 * 处在顶层位置时尝试读"键 → Schema.*"的字段；不是这种写法就返回 `null`。
 *
 * 深度不为 0，或者当前位置不可能是键时直接返回 `null`：嵌套子对象里的键属于值，不是设置字段。
 * 用 `null` 而不是 `undefined` 表示"没匹配上"：本函数另一条出口返回对象，两种"没有值"混着用
 * 会让 consistent-return 认为存在不返回值的路径。
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
 * 取出对象字面量内容里**顶层**的"键 → Schema. 开头的值"的字段名。
 *
 * 只认深度 0 上的属性名，而且值去掉空白之后必须紧跟 `Schema.` 才算字段：多行写法
 * （`foo:\n  Schema.xxx`）照样读得到，行内注释、嵌套子对象和字符串里的 `key:` 都不会被误读。
 * 不再要求"字段和 Schema. 写在同一行"，也不再依赖缩进的空格数。
 */
/** 扫描对象内容的状态：当前下标、括号深度、下一个位置是否可能是键。 */
interface BodyScan {
  i: number;
  depth: number;
  expectKey: boolean;
}

/** 既不是字段、也不是字符串/注释这类整体跳过的内容时，按分隔符前进一格。 */
function advanceDelimiter(char: string, scan: BodyScan): void {
  if (char === ",") {
    scan.i += 1;
    scan.expectKey = scan.depth === 0;
  } else if (CLOSERS[char] !== undefined) {
    scan.depth += 1;
    scan.i += 1;
    scan.expectKey = false;
  } else if (char === ")" || char === "}" || char === "]") {
    scan.depth -= 1;
    scan.i += 1;
    scan.expectKey = false;
  } else {
    scan.i += 1;
    scan.expectKey = false;
  }
}

/**
 * 在对象内容里前进一格：跳过空白和注释，字符串字面量与正则整体跳过（正则里的 [ { } 会改变 depth，
 * 深度一旦错位，其后的 key: Schema.* 就全被当成"嵌套值里的键"丢掉而且没有提示，检查于是看起来通过），
 * 处在顶层键的位置上能读到字段名就收下，其余情况按分隔符前进。
 *
 * @param body - 对象字面量的内容（开始括号之后到与之配对的结束括号之前的源码）
 * @param scan - 扫描状态，原地推进
 * @param fields - 已经读到的字段名，命中时追加
 * @returns 是否还能继续扫（扫到末尾就是 false）
 */
function bodyStep(body: string, scan: BodyScan, fields: string[]): boolean {
  scan.i = skipTrivia(body, scan.i);
  if (scan.i >= body.length) {
    return false;
  }
  const char = body[scan.i] ?? "";
  const opaqueEnd = skipLiteralAt(body, scan.i) ?? stepOpaque(body, scan.i);
  if (opaqueEnd !== undefined) {
    scan.i = opaqueEnd;
    scan.expectKey = false;
    return true;
  }
  const hit = fieldKeyAt(body, scan.i, scan.depth, scan.expectKey);
  if (hit === null) {
    advanceDelimiter(char, scan);
    return true;
  }
  if (hit.field !== undefined) {
    fields.push(hit.field);
  }
  scan.i = hit.index;
  scan.expectKey = false;
  return true;
}

function schemaFieldsInBody(body: string): string[] {
  const fields: string[] = [];
  const scan: BodyScan = { i: 0, depth: 0, expectKey: true };
  while (bodyStep(body, scan, fields)) {
    // 全部推进都在 bodyStep 里完成，循环只负责"扫到尾部即停"。
  }
  return fields;
}

/**
 * 从 host.ts 文本里取出设置 schema 的字段名；读不出来的时候返回在 `problems` 里（静默返回空表是不行的）。
 *
 * 导出是为了让解析这件事本身能被用例钉住：这里读错的表象恰好就是"门禁通过"（少读字段 =
 * 漏掉的字段不再被拦住），所以它的期望值必须来自单独写死的夹具，而不是跑一遍真实 host.ts 看结果。
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
          `无法确定哪个是设置对象，请把设置 schema 命名为 Config（认错对象会少读字段而误判通过）`,
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

/** 取捕获组的值（严格模式下 matchAll 的捕获是 `string | undefined`，这里统一成 string）。 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

/** 把注释替换成等长的空白（行注释和块注释都算，块注释的起止符号在这段说明里省去不写），
 *  字符串、模板和正则原样保留。`boundFieldsIn` 要匹配的内容里有 `field: 'x'` 这种带引号的写法，
 *  所以不能把字面量一起清掉；但注释必须清掉：被注释掉的旧绑定（`// props.set('x', v)`）
 *  不能算"卡片已经暴露了这个字段"。 */
function codeWithoutComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const char = src[i] ?? "";
    if (char === '"' || char === "'") {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (char === "`") {
      const end = skipTemplate(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (char === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const end = skipTrivia(src, i);
      out += " ".repeat(end - i);
      i = end;
    } else if (char === "/" && isRegexStart(src, i)) {
      const end = skipRegexLiteral(src, i);
      out += src.slice(i, end);
      i = end;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/** 扫描一个 client 源文件，收集作为"设置写入的第一个参数"出现的字段名字面量。 */
function boundFieldsIn(src: string): Set<string> {
  const code = codeWithoutComments(src);
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of code.matchAll(/\bfield\s*:\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(group(match, 1));
  }
  // 几种写入写法：props.set('x'、set('x'、unset('x'、fireAndForget('x'、writeSet('x'
  //   刻意不要求前面的对象名——各包的写法不同（props.set、fireAndForget、writer.set），
  //   收得太紧会漏判。某个字段名算不算"已绑定"，由 schemaCoverageProblems 与 host 字段名取交集决定。
  for (const match of code.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(group(match, 1));
  }
  return out;
}

/** 客户端源码的文件名形式：卡片和输入组件可能是 .tsx，也会和 .mts/.cts/.js(x) 混着用。 */
const CLIENT_SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx)$/u;
/** 声明文件不是源码：它的 `foo: Schema.` 写法会把没绑定的字段读成"已绑定"。 */
const DECLARATION = /\.d\.(?:ts|mts|cts)$/u;

/** 递归收集目录下的客户端源码文本（跳过 node_modules 和符号链接）。 */
function walk(dir: string, problems: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) {
    return out;
  }
  let entries;
  try {
    // 用 withFileTypes 一次读到类型：既不用逐个 statSync（断掉的软链会抛 ENOENT），也能跳过符号链接
    // （成环的软链会递归到无限深）。
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

/** 客户端实际绑定了哪些字段名（src/** 加 lib/**）。 */
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
 * 从测试文件所在位置往上找最近的、含 package.json 的目录；一路找到根都没有时返回 `null`。
 *
 * 不写死 `testDir/..`：这个辅助文件被放到 `test/unit/` 或 `test/helpers/` 之后，写死的父目录
 * 会指到 `test/` 自己，于是 `package.json` 读不到、门禁失败在一个和真实原因无关的读文件错误上。
 *
 * 用 `null` 而不是 `undefined` 表示"没找到"：本函数另一条出口返回字符串，两种"没有值"混着用
 * 会让 consistent-return 和调用方的 `=== undefined` 判断各说一套。
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

/** 读一份文件的文本；读不到时返回 `null`，并记下点名是哪个文件的问题。 */
function readSource(file: string, label: string, problems: string[]): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    problems.push(`[${label}] 读不到 ${file}：${String(error)}`);
    return null;
  }
}

/**
 * "卡片字段是否覆盖 host schema"这项门禁的问题清单（空数组表示通过）。
 *
 * 返回清单而不是自己注册用例：注册只能发生在用例文件的 describe 或用例体内，
 * 而且断言要写在那个体内才看得见（vitest 的 require-hook 和 expect-expect）。
 * 调用点的写法见本文件开头。
 */
export function schemaCoverageProblems(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): string[] {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const foundDir = packageDirOf(testDir);
  if (foundDir === null) {
    return [`从 ${testDir} 向上找不到 package.json：无法确定包根`];
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

  // hostSchemaFields 遇到不合法的源码是抛错，而不是返回问题清单（解析器的契约：宁可抛错也不交出读了一半的字段）。
  // 但本函数对外承诺的是"返回问题清单"：不在这里接住的话，失败表现就是一张调用栈，调用方
  // assert.deepEqual(schemaCoverageProblems(...), []) 拿到的就不是能看懂的原因了。仍然按"读不出来就算失败"处理：
  // 换成一条点名 host.ts 的问题并立即返回（字段列表都不可信，后面的绑定和豁免检查没有意义）。
  let parsed: ReturnType<typeof hostSchemaFields>;
  try {
    parsed = hostSchemaFields(hostTs);
  } catch (error) {
    problems.push(
      `[${pkgName}] host.ts 的设置字段列表解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return problems;
  }
  problems.push(...parsed.problems);
  const hostFields = parsed.fields;
  const bound = clientBoundFields(pkgDir, problems);
  const exemptionItems = opts.allowUnbound ?? [];
  const duplicateExempt = exemptionItems
    .map((item) => item.field)
    .filter((field, index, all) => all.indexOf(field) !== index);
  if (duplicateExempt.length > 0) {
    // 用 Map 会让后一条悄悄覆盖前一条：重复声明意味着至少一条 reason 永远不会被读到。
    problems.push(
      `[${pkgName}] allowUnbound 重复声明了字段（后者覆盖前者）：${duplicateExempt.join(", ")}`,
    );
  }
  const unknownExempt = exemptionItems
    .map((item) => item.field)
    .filter((field) => !hostFields.includes(field));
  if (unknownExempt.length > 0) {
    // 不在 host schema 里的豁免项既不会出现在 missing 也不会出现在 stale 里，等于挂个名字糊过去。
    problems.push(
      `[${pkgName}] allowUnbound 含 host schema 里不存在的字段（拼写错误或 host 已删除）：${unknownExempt.join(", ")}`,
    );
  }
  const exemptions = new Map(exemptionItems.map((item) => [item.field, item.reason]));

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
        `  显式声明 { field, reason }（测试会校验被声明成例外的字段确实未绑定，防止对不上号的空声明）。`,
    );
  }
  // 反向校验：豁免项若其实已绑定，说明豁免过时——删除即可，留着会让门禁失效。
  const stale = [...exemptions].filter(([field]) => bound.has(field));
  if (stale.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 已过时——这些字段其实已绑定，请删除豁免声明：${stale.map(([field, reason]) => `${field}（${reason}）`).join(", ")}`,
    );
  }
  // 豁免必须写理由，否则等于没有这项门禁。
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
