// lib/gate-diagnostics.ts —— 从各语言门禁输出里认出行列诊断。
//
// 只认该命令的稳定文本形状（tsc/go/ruff/rubocop/javac/Maven/dotnet/clang/PHP），
// 认不出的行一律跳过：诊断是给 diff 注解用的，猜路径和行号会把注解画到错误的文件上。
// 路径先按门禁根相对，host 再统一换算成仓库根相对（见 lib/repo-diagnostics.ts）。
import { collectDiagnostics, parseTsDiagnostics } from "./gate-detect.ts";
import type { TsDiagnostic } from "./gate-detect.ts";

interface ParseOptions {
  readonly messageMax?: number;
  readonly limit?: number;
}

const DEFAULT_MESSAGE_MAX = 200;
const DEFAULT_LIMIT = 20;

// go vet 是 `file.go:行:列: msg`，go build / go test 的编译错误常常没有列号（`file.go:行: msg`），
// 两种都属于稳定形状；列号因此可选。
const GO_DIAGNOSTIC = /^(?<path>.+\.go):(?<line>\d+)(?::\d+)?: (?<message>[^\n]+)$/u;
const RUFF_DIAGNOSTIC = /^(?<path>.+\.py):(?<line>\d+):\d+: (?<message>[A-Z]+\d+ [^\n]+)$/u;
const RUBOCOP_DIAGNOSTIC = /^(?<path>.+\.rb):(?<line>\d+):\d+: [CWEF]: (?<message>[^\n]+)$/u;
const JAVAC_DIAGNOSTIC =
  /^(?<path>.+\.(?:java|kt|kts)):(?<line>\d+): (?:error|warning): (?<message>[^\n]+)$/u;
const MAVEN_DIAGNOSTIC =
  /^\[(?:ERROR|WARNING)\] (?<path>.+\.(?:java|kt|kts)):\[(?<line>\d+),\d+\] (?<message>[^\n]+)$/u;
const DOTNET_DIAGNOSTIC =
  /^(?<path>.+\.(?:cs|vb|fs))\((?<line>\d+),\d+\): (?:error|warning) [A-Z]+\d+: (?<message>[^\n]+)$/u;
const CPP_DIAGNOSTIC =
  /^(?<path>.+\.(?:c|cc|cpp|cxx|h|hh|hpp)):(?<line>\d+):\d+: (?:error|warning): (?<message>[^\n]+)$/u;
// PHP 有两种稳定形状：Parse/Warning 类（CLI 默认）用 `in <file> on line <n>`，
// Fatal error（以及抛出异常的那一类）用 `in <file>:<n>`。只认前一种会把最需要注解的致命错误整片丢掉。
const PHP_DIAGNOSTIC_ON_LINE =
  /^PHP (?:Parse|Fatal|Warning) error: (?<message>[^\n]+?) in (?<path>[^\n]+) on line (?<line>\d+)$/u;
const PHP_DIAGNOSTIC_AT_LINE =
  /^PHP (?:Parse|Fatal|Warning) error: (?<message>[^\n]+?) in (?<path>[^\n]+):(?<line>\d+)$/u;
const ESLINT_DIAGNOSTIC =
  /^(?<path>.+\.(?:js|jsx|mjs|cjs|ts|tsx)):(?<line>\d+):\d+: (?<message>[^\n]+)$/u;

/** Rust 的 cargo 诊断是两行：`error[E...]: ...` 后面跟 `--> path:line:col`。 */
const RUST_MESSAGE = /^(?:error|warning)(?:\[[^\]]+\])?: (?<message>[^\n]+)$/u;
/** cargo 收尾的汇总行（`error: could not compile ...`、`error: aborting due to ...`）：不是诊断。 */
const RUST_SUMMARY = /^(?:aborting due to|could not compile)/u;
const RUST_LOCATION = /^--> (?<path>.+):(?<line>\d+):\d+$/u;

function parseRust(text: string, options: ParseOptions = {}): readonly TsDiagnostic[] {
  const messageMax = options.messageMax ?? DEFAULT_MESSAGE_MAX;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const out: TsDiagnostic[] = [];
  let message: string | undefined;
  for (const raw of text.split("\n")) {
    if (out.length >= limit) {
      break;
    }
    const line = raw.trim();
    const head = RUST_MESSAGE.exec(line)?.groups;
    if (head?.["message"] === undefined) {
      const location = RUST_LOCATION.exec(line)?.groups;
      if (location !== undefined && message !== undefined) {
        out.push({
          path: String(location["path"]),
          line: Number(location["line"]),
          message: message.slice(0, messageMax),
        });
        message = undefined;
      } else if (line === "") {
        message = undefined;
      }
    } else {
      const { message: found } = head;
      // 汇总行没有自己的 `-->`；若把它当成一条消息，下一个出现的 `-->` 会被挂上这句
      // 「aborting due to 1 previous error」，注解就指向了别处的行号。
      message = RUST_SUMMARY.test(found) ? undefined : found;
    }
  }
  return out;
}

function parseGo(text: string, options: ParseOptions = {}): readonly TsDiagnostic[] {
  return collectDiagnostics(text, GO_DIAGNOSTIC, options);
}

function parseRuff(text: string, options: ParseOptions = {}): readonly TsDiagnostic[] {
  return collectDiagnostics(text, RUFF_DIAGNOSTIC, options);
}

function parseRubocop(text: string, options: ParseOptions = {}): readonly TsDiagnostic[] {
  return collectDiagnostics(text, RUBOCOP_DIAGNOSTIC, options);
}

function parseJava(text: string, options: ParseOptions = {}): readonly TsDiagnostic[] {
  const messageMax = options.messageMax ?? DEFAULT_MESSAGE_MAX;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const out: TsDiagnostic[] = [];
  for (const raw of text.split("\n")) {
    if (out.length >= limit) {
      break;
    }
    const line = raw.trim();
    const maven = MAVEN_DIAGNOSTIC.exec(line)?.groups;
    if (maven === undefined) {
      const javac = JAVAC_DIAGNOSTIC.exec(line)?.groups;
      if (javac !== undefined) {
        out.push({
          path: String(javac["path"]),
          line: Number(javac["line"]),
          message: String(javac["message"]).slice(0, messageMax),
        });
      }
    } else {
      out.push({
        path: String(maven["path"]),
        line: Number(maven["line"]),
        message: String(maven["message"]).slice(0, messageMax),
      });
    }
  }
  return out;
}

function parseDotnet(text: string, options: ParseOptions = {}): readonly TsDiagnostic[] {
  return collectDiagnostics(text, DOTNET_DIAGNOSTIC, options);
}

function parseCpp(text: string, options: ParseOptions = {}): readonly TsDiagnostic[] {
  return collectDiagnostics(text, CPP_DIAGNOSTIC, options);
}

function parsePhp(text: string, options: ParseOptions = {}): readonly TsDiagnostic[] {
  const messageMax = options.messageMax ?? DEFAULT_MESSAGE_MAX;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const onLine = collectDiagnostics(text, PHP_DIAGNOSTIC_ON_LINE, { messageMax, limit });
  if (onLine.length >= limit) {
    return onLine;
  }
  const atLine = collectDiagnostics(text, PHP_DIAGNOSTIC_AT_LINE, {
    messageMax,
    limit: limit - onLine.length,
  });
  return [...onLine, ...atLine];
}

function parseEslint(text: string, options: ParseOptions = {}): readonly TsDiagnostic[] {
  return collectDiagnostics(text, ESLINT_DIAGNOSTIC, options);
}

type Parser = (text: string, options?: ParseOptions) => readonly TsDiagnostic[];

const PARSERS: Readonly<Record<string, Parser>> = {
  tsc: parseTsDiagnostics,
  go: parseGo,
  cargo: parseRust,
  ruff: parseRuff,
  rubocop: parseRubocop,
  mvn: parseJava,
  "./mvnw": parseJava,
  gradle: parseJava,
  "./gradlew": parseJava,
  "gradlew.bat": parseJava,
  dotnet: parseDotnet,
  cmake: parseCpp,
  ctest: parseCpp,
  make: parseCpp,
  phpunit: parsePhp,
  "vendor/bin/phpunit": parsePhp,
  composer: parsePhp,
  eslint: parseEslint,
};

/**
 * 按门禁命令选择解析器。未知命令返回空表，不影响门禁结果本身。
 *
 * `cargo fmt` 只输出 diff、没有行列诊断；`composer validate`/`vitest`/`jest` 的输出也不是
 * 稳定的“文件:行:列”形状，这几条走空表或各自的最简形状。
 */
export function diagnosticsFor(
  command: readonly string[],
  text: string,
  options: ParseOptions = {},
): readonly TsDiagnostic[] {
  const parser = PARSERS[command[0] ?? ""];
  return parser === undefined ? [] : parser(text, options);
}
