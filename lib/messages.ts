// lib/messages.ts —— host 半文案字典（中英双语）。
//
// 只管 host 半：设置卡的 UI 文案走官方 @deepseek-ai/dsh-client-locale
// （client 侧 `ctx.locale.register(ns, dicts)` 一次交齐两语 + `bind`/`t`，见 src/client-entry.ts）。
// host 侧没有官方 i18n 面，回合收口注入给模型的修复指令、门禁没跑成/被拒绝时用户能看到的
// 回显只能自带字典；语言取官方 settings 的 `locale.preference`（shared 的
// resolveLocalePreference），命名空间未注册即中文。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 QualityGateMessages 接口，
// 少键多键在编译期红。console.* 的日志文案不在此列——那是给排障的人看的，不随界面语言切换。
//
// 带变量的整行放 `{name}` 占位符（与卡片侧官方 Translate 同语法），由本文件的
// renderTemplate 渲染：字典仍是扁平字符串表，两种语言可以各自决定变量的语序。
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/** 本包 host 侧产出的全部人读文案（注入给模型的修复指令 + 门禁降级回显）。 */
export interface QualityGateMessages {
  /** 证据被 harness 截断时的说明行（{label} = stdout/stderr，{spill} = 落盘路径或占位）。 */
  readonly evidenceTruncated: string;
  /** 截断但没有落盘文件时 {spill} 的取值。 */
  readonly noSpillFile: string;
  /** 截断且读回头部摘录时的正文（{head} 头部摘录、{text} 留在内存的尾部）。 */
  readonly evidenceHeadTail: string;
  /** 门禁报了代码错误 → 注入给模型的修复指令（{command}/{root}/{output}）。 */
  readonly gateFailed: string;
  /** 门禁没跑成 → 注入的"请手动确认"说明（{command}/{root}/{reason}）。 */
  readonly gateNotRun: string;
  /** 配额耗尽后的放行说明（{attempts}/{command}/{root}，用户可见）。 */
  readonly gaveUp: string;
  /** 预算不足被跳过的门禁清单（{budgetMs}/{list}）。 */
  readonly gatesSkipped: string;
  /** 清单里的一行（{command}/{root}）。 */
  readonly skippedGateItem: string;
  /** 沙箱事实的模式段（{mode}）。 */
  readonly sandboxMode: string;
  /** 沙箱事实的生效度段，仅当宿主上报 enforcement 时拼上（{enforcement}）。 */
  readonly sandboxEnforcement: string;
  /** 沙箱 runner 起不来 = 命令根本没跑（{sandbox}）。 */
  readonly runnerFailed: string;
  /** 沙箱策略拒写 = 命令未获准真正执行（{sandbox}）。 */
  readonly policyDenied: string;
  /** 超时（{seconds} 秒）。 */
  readonly timedOut: string;
  /** 回合被取消。 */
  readonly aborted: string;
  /** exit 127 的成因短语（工具未安装）。 */
  readonly toolMissing: string;
  /** exit 126 的成因短语（不可执行）。 */
  readonly toolNotExecutable: string;
  /** 成因短语 → "门禁没有运行"（{cause}）。 */
  readonly toolNotRun: string;
  /** npx 抓到 stub 包（工具没起来，不是代码问题）。 */
  readonly toolStub: string;
  /** 沙箱策略解析失败（{message} 错误摘要）。 */
  readonly policyUnresolvable: string;
  /** 沙箱在本机不可用（{message}）。 */
  readonly sandboxUnavailable: string;
  /** 门禁进程起不来（{message}）。 */
  readonly gateStartFailed: string;
  /** 门禁失败沉淀进记忆网关的正文（{command}/{root}/{failure}）。 */
  readonly memoryFeedback: string;
}

export const MESSAGES: MessagesCatalog<QualityGateMessages> = {
  zh: {
    evidenceTruncated:
      "[证据截断] {label} 内存里只保留尾部（首个错误可能在被丢弃的头部）。完整输出：{spill}",
    noSpillFile: "无落盘文件",
    evidenceHeadTail: "—— 头部摘录（根因多在此）——\n{head}\n—— 尾部 ——\n{text}",
    gateFailed:
      "[quality-gate] 回合收口门禁未通过（{command}，根 {root}）：\n{output}\n" +
      "请修复上述问题后结束回合。不要重做已完成的工作，只修门禁报出的错误。",
    gateNotRun:
      "[quality-gate] 回合收口门禁**未能执行**（{command}，根 {root}）：\n{reason}\n" +
      "这不是代码错误的证据：**不要为此修改代码**，也不要把它当成已通过。" +
      "请在结束本回合前手动运行该命令确认代码健康，或向用户说明门禁无法执行的原因。",
    gaveUp:
      "[quality-gate] 已自动注入 {attempts} 次修复指令，门禁（{command}，根 {root}）仍未通过。" +
      "为避免无限消耗 token，本轮停止自动修复并放行。" +
      "请手动运行该命令确认代码健康；若确需修复，请明确告知用户需要人工介入，不要反复重试同一门禁。",
    gatesSkipped:
      "剩余预算不足 {budgetMs}ms，以下门禁本轮未执行：\n{list}\n" +
      "这些根的代码健康**尚未核验**，不要把它们当已通过。",
    skippedGateItem: "- {command}（根 {root}）",
    sandboxMode: "沙箱模式={mode}",
    sandboxEnforcement: "，enforcement={enforcement}",
    runnerFailed: "沙箱 runner 启动失败，命令根本没跑（{sandbox}）。",
    policyDenied: "沙箱策略拒绝了对门禁工作目录的写入（{sandbox}）：命令未获准真正执行。",
    timedOut: "exit=timeout（{seconds}s 预算内未完成），门禁未得到结果。",
    aborted: "门禁执行被调用方取消（aborted），结果未知。",
    toolMissing: "命令不存在（工具未安装）",
    toolNotExecutable: "命令不可执行",
    toolNotRun: "{cause}，门禁没有运行。",
    toolStub: "门禁工具本身不可用（npx 抓到的是 stub 包，不是真工具）。",
    policyUnresolvable: "沙箱策略无法解析（{message}），门禁拒绝在未确认的沙箱边界下执行。",
    sandboxUnavailable: "沙箱在本机不可用（{message}）：命令被拒绝执行，未做任何检查。",
    gateStartFailed: "门禁未能启动（{message}）。",
    memoryFeedback: "[quality-gate 反馈] 门禁失败 {command}（根 {root}）：{failure}",
  },
  en: {
    evidenceTruncated:
      "[evidence truncated] only the tail of {label} is kept in memory (the first error may be in " +
      "the dropped head). Full output: {spill}",
    noSpillFile: "no spill file",
    evidenceHeadTail: "—— head excerpt (root cause usually here) ——\n{head}\n—— tail ——\n{text}",
    gateFailed:
      "[quality-gate] the turn-end quality gate did not pass ({command}, root {root}):\n{output}\n" +
      "Fix the problems above before ending the turn. Do not redo work that is already done — " +
      "fix only what the gate reported.",
    gateNotRun:
      "[quality-gate] the turn-end quality gate **could not run** ({command}, root {root}):\n" +
      "{reason}\nThis is not evidence of a code error: **do not change code because of it**, and " +
      "do not treat it as passed. Run that command manually before ending the turn to confirm the " +
      "code is healthy, or tell the user why the gate could not run.",
    gaveUp:
      "[quality-gate] {attempts} repair instructions were injected automatically and the gate " +
      "({command}, root {root}) still does not pass. To avoid burning tokens forever, automatic " +
      "repair stops here and this turn is released. Run the command manually to confirm the code is " +
      "healthy; if a fix really is needed, tell the user explicitly that human intervention is " +
      "required instead of retrying the same gate.",
    gatesSkipped:
      "Less than {budgetMs}ms of budget remains, so these gates did not run this turn:\n{list}\n" +
      "The code health of these roots **has not been verified** — do not treat them as passed.",
    skippedGateItem: "- {command} (root {root})",
    sandboxMode: "sandbox mode={mode}",
    sandboxEnforcement: ", enforcement={enforcement}",
    runnerFailed: "The sandbox runner failed to start, so the command never ran ({sandbox}).",
    policyDenied:
      "The sandbox policy denied writes to the gate's working directory ({sandbox}): the command " +
      "was never allowed to actually run.",
    timedOut: "exit=timeout (not finished within the {seconds}s budget), the gate got no result.",
    aborted: "Gate execution was cancelled by the caller (aborted); the result is unknown.",
    toolMissing: "command not found (tool not installed)",
    toolNotExecutable: "command not executable",
    toolNotRun: "{cause} — the gate did not run.",
    toolStub:
      "The gate tool itself is unavailable (npx fetched a stub package, not the real tool).",
    policyUnresolvable:
      "The sandbox policy could not be resolved ({message}); the gate refuses to run under an " +
      "unconfirmed sandbox boundary.",
    sandboxUnavailable:
      "The sandbox is unavailable on this machine ({message}): the command was denied and no check " +
      "was performed.",
    gateStartFailed: "The gate failed to start ({message}).",
    memoryFeedback: "[quality-gate feedback] gate failure {command} (root {root}): {failure}",
  },
};

/** 渲染模板里的 {name} 占位符；未提供的名字留空串（宁可少一段说明，也不给模型留裸花括号）。
 *  与 client 半官方 `@deepseek-ai/dsh-client-locale` 的 Translate 插值同语义（宿主同规则）。
 *  @param text - 字典里的整行模板。
 *  @param params - 占位符名 → 值（数字会转成字符串）。
 *  @returns 替换后的文本。
 */
export function renderTemplate(text: string, params: Record<string, string | number>): string {
  return text.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    return value === undefined ? "" : String(value);
  });
}
