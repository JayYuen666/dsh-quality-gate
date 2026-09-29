// quality-gate host 半：回合收口质量门禁（ECC stop-format-typecheck 移植）。
//
// 机制（已在 dsh 宿主源码核实）：
//   - tool/result 事件记账本回合编辑过的代码/配置文件（EditAccumulator，O(1)）；
//   - agent/turn-stopping 事件触发批处理：agent.ts:304-308 在 turn-stopping
//     之后仍检查 inbox.nextStep —— 门禁失败经 followup 注入修复指令即开新轮
//     （followup opens NEW turn，runtime-types.ts:126-130；旧注记"回合物理上
//     不结束"有误，已按官方语义修正）。
//
// 门禁完整性总纲（2026-09 审计后的硬约束）：**一次没有真正跑完的检查，绝不能
// 被记为"通过"**。所有出口都是显式三态（GateOutcome）：
//   - pass        ：门禁真的跑了且 exit 0；
//   - code-failure：门禁跑了且报了代码错误 → 注入"修这些错"（进记忆/lesson-loop）；
//   - not-run     ：门禁没跑成（沙箱策略拒绝/runner 不可用/沙箱整体不可用/准备期抛错/
//                   超时/取消/工具装不上/预算不足被跳过）→ 注入"请手动跑一次"，
//                   且**不**写记忆、**不**以 gate-failure 进 lesson-loop。
//   旧实现在这些场景要么直接报 PASS（catch 兜底、预算耗尽只 warn），要么把沙箱
//   拒绝当代码错误注入"修这些错"并污染记忆与自进化闭环。
//
// 会话边界：
//   - 门禁只对根会话收口（isRootSession：delegationDepth>0 / origin==='subagent' 跳过）。
//     子代理回合收口在宿主侧无完整项目上下文，注入 followup 会进子代理（结算时序不可控），
//     且与父会话门禁对同一项目根重复执行。
//   - out-of-process 子代理（ACP/claude-code/codex）在独立进程运行、不发射 dsh 事件，
//     其编辑天然不在门禁面内（dsh 机制边界，非本插件缺陷）。
//   - plan mode 下 turn-stopping 照常触发：若规划回合修改了代码文件，门禁同样收口
//     （语义正确——plan 模式不豁免代码健康），不做模式特判。
//   - 编辑记账按 sessionId 分账（每会话一个 EditAccumulator）：共用一个累加器会让
//     某会话 drain 拿走另一会话待复查的编辑，而后者的事件游标已前进 → 那批编辑
//     永不复查（静默丢门禁），失败配额与容量淘汰计数也会记到错误的会话上。
//
// 防跑飞（复用 session-rescue 验证过的配额模式）：
//   - 每回合每根至多 N 次门禁注入（默认 2）；循环修不好就放行并提示用户；
//   - 门禁总时长预算封顶（默认 300s），超时/预算耗尽一律按 not-run 注入说明。
//
// 运行方式：dsh cordis Loader 直接 import 本 .ts（Node ≥22.18 类型剥离）。
// 一处例外：@deepseek-ai/dsh-credentials 的 `credentialRef` / `isCredentialRefName` 是值导入
// 且在 dependencies（口径 A，2026-09-26；见下面 import 段的理由）。其余 @deepseek-ai/* 一律 type-only。

import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
// 0.1.7 设置面要求宿主 fork：只有 @deepseek-ai/schemastery 的 resolve 会把 volatile
// 字段包成 Volatile 引用（vendor/schemastery/src/index.ts:521-526），公共
// schemastery@3.18.0 既没有 .volatile()、解析出来的也仍是普通值。
import Schema from "@deepseek-ai/schemastery";
import type { Context, Events, Fiber, Volatile } from "@deepseek-ai/cordis";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
// shell 执行面绑官方声明（devDependency @deepseek-ai/dsh-shell，与运行宿主同版本）。
// 服务类是 `export declare abstract class ShellExecutor extends Service`
// （@deepseek-ai/dsh-shell/lib/types/index.d.ts:47）：cordis 的
// `abstract class Service` 带 `protected ctx: Context`（@deepseek-ai/cordis/lib/types/
// service.d.ts:9-10），TS 对带 protected/private 成员的类按**名义**比 → 结构替身永远
// 满足不了整个类，故服务成员只取 `Pick<ShellExecutor, "resolve" | "execute">`（本仓既有
// 先例：ocr-review/host.ts:175、zvec-grep/host.ts:169）。被 Pick 的那两个方法的入参与返回
// （ShellExecRequest / ShellExecSpec / ShellExecution / ShellRunResult / ShellSandboxInfo /
// CollectedOutput，官方出口 lib/types/index.d.ts:11）就此由官方给出，本包不再手抄一个字段。
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecutor,
  ShellRunResult,
  ShellSandboxInfo,
} from "@deepseek-ai/dsh-shell";
// sandboxPolicy / session / agent 三面同批绑官方声明（三个 devDependency 与运行宿主同版本）：
// 三个服务/实体类都带私有成员或远多于本包所需的面，故一律 `Pick<官方类, "成员">` 投影，
// 载荷与返回由被 Pick 的成员给出（见下面各自的注释），仍是 type-only。
import type { SandboxPolicyService as HostSandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
// 值导入：`isCredentialRefName` / `credentialRef` 是凭据包自己交出的**官方**校验与品牌构造
// （installed lib/index.js:13 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`、:21-36）。本包原先
// 自己抄了同一条正则当 ref 语法（见下面 resolveFeedbackTarget 前那道判据）——抄一条规则就多
// 一处会跟着宿主漂移的判据，ocr-review 同批换掉。两者都是纯字符串函数，官方品牌没有 type-only
// 的构造方式 ⇒ 按口径 A（2026-09-26）把 dsh-credentials 落在 dependencies，产物留
// `from "@deepseek-ai/dsh-credentials"` 裸说明符；放 devDependencies 会被 rolldown 把函数体
// 内联进 host.js（等于本包各持一份官方实现）。**旧注释曾写"由 test/build-host.test.ts 钉住
// 内联"——实测该文件当时并没有任何 credentials/brand 断言**（SP-D 复核抓出的假话）；本轮起那条钉测是真的：说明符在 + 四枚官方构造器的函数体都不在。
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import type { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import type { Session, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
// 记账事件流的官方读面（`Context.sessionQuery`，installed @deepseek-ai/dsh-session-query/
// lib/types/index.d.ts:23-27）：type-only，运行时由 ctx 注入。见下面 SessionQueryFace。
import type { SessionObservation } from "@deepseek-ai/dsh-session-query";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { EditAccumulator } from "./lib/accumulator.ts";
import { detectGate } from "./lib/gate-detect.ts";
import type { Gate, ProjectRoot } from "./lib/gate-detect.ts";
import { MESSAGES, renderTemplate } from "./lib/messages.ts";
import type { QualityGateMessages } from "./lib/messages.ts";
// host 侧文案语言跟官方 locale 插件的偏好同源：读它拥有的 settings 命名空间（未注册即中文）。
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen666/dsh-plugin-shared/lib/locale";
import { pushGateFeedback } from "./lib/gateway-feedback.ts";
import { resolveGatewayUrl } from "./lib/gateway-target.ts";
import type { GatewayTarget } from "./lib/gateway-target.ts";
import type { GateFeedbackInput } from "./lib/feedback-content.ts";
// 共享记账骨架：事件流 → tool/call+tool/result 两张表 + 编辑路径提取，与 danger-guard
// 证据链共用同一实现。事件形状也取自同一处（SessionEvent）——本包不再自备一份最小
// 投影，避免同一契约两份声明、各自漂移。
import {
  scanToolEvents,
  editPathOf as sharedEditPathOf,
} from "@jayyuen666/dsh-plugin-shared/lib/tool-events";
import type { SessionEvent } from "@jayyuen666/dsh-plugin-shared/lib/tool-events";
// lesson bus 收口：lesson-loop 的 report 已异步落库（返回 Promise），只包一层同步
// try/catch 抓不到 rejection——失败既被静默吞掉又给宿主进程留一枚未处理拒绝。
// 同步抛错与异步拒绝共用这一个出口（三个包的调用点降级口径一致）。
import { settleLessonCall } from "@jayyuen666/dsh-plugin-shared/lib/lesson-bus";
import { fieldOf, isRecord } from "@jayyuen666/dsh-plugin-shared/lib/record";

/**
 * 常见项目根标记文件：向上找最近的含清单目录。
 * ruff.toml 必须在列（审计 LOW-MED 项）：只有 ruff 配置、无 pyproject.toml 的 Python
 * 工程若不在此登记，gate-detect 的 has("ruff.toml") 就是死码——那类工程根本得不到根，
 * 也就永远没有门禁。
 */
const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "pnpm-workspace.yaml",
  "ruff.toml",
];

/**
 * 记账用的事件读面 = 官方 `SessionQueryEngine`（installed
 * @deepseek-ai/dsh-session-query/lib/types/index.d.ts:35 起，cordis `Service` 子类 + private
 * 字段 → 名义比较，整类交不出结构替身）的 `observeSession` 一位（:47）。
 *
 * 它取代的是本包此前的 `Session.snapshotEvents()` 同步读：官方把 `snapshotEvents` / `eventAt`
 * / `ownEvents` 三枚一并标为 `@deprecated`（"new calls are prohibited"，installed
 * @deepseek-ai/dsh-session/lib/types/index.d.ts:176 / :186 / :195，指向 Agent Note
 * 2026-09-09-deprecate-synchronous-session-event-reads）。本仓在这里曾写过一句
 * 「packages/session-query 是检索语料库面、无回合级增量读」——那是**未核实的判断**，实际
 * `observeSession` 就是按 sessionId 的精确读：lib/types/observation.d.ts:7-31 交回一枚不可变
 * 切片，`events: readonly SessionEvent[]`（:19）与 `inheritedEventCount: SessionLogOffset`
 * （:13）一次给全，记账要的两样连 fork 切点都不必再从 session 对象上摸。
 *
 * ⚠ 替代面是**异步**的。本包的读点在 `agent/turn-stopping`（官方 `@mode serial`，installed
 * @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:387-391）监听器内，迁移后那一次读在
 * 监听器里 `await`——靠的正是 serial 分发保持"同一会话的读窗一次只跑一趟"，与迁移前的同步段
 * 等价；门禁执行仍照旧 detached（迁移前那一段本就是并发的）。
 * 原 `SessionRef` 视图（为那条退役读面而存在的 `Partial<Pick<Session, "inheritedEventCount"
 * | "snapshotEvents">>`）随本次迁移一并删除；`header`/`id` 两位仍由 `TurnAgent.session` 上
 * 的官方 `Session` 直接交出，不需要视图。
 *
 * ⚠ 这一位**不**写成 `Pick<SessionQueryEngine, "observeSession">`：官方返回域 `SessionObservation`
 * 把 `inheritedEventCount` 说成必填（observation.d.ts:13），而同一官方包里承载同一位字段的
 * 另一处（@deepseek-ai/dsh-session/lib/types/types.d.ts:109）是**可选**的，cold/prepared 观察
 * 实测也会交回 undefined（resolveEventWindow 里 `?? 0` 的兜底分支由测试钉成真的走到）。
 * 必填位折叠不掉，读点的兜底就会被 typescript(no-unnecessary-condition) 判成冗余守卫，
 * 故按官方签名重述方法、把回包换成下面的 `SessionObservationFace`；运行时那一次读仍由
 * 宿主注入的官方面兑现。
 */
/** 官方回包在本包读面上的形状：`events` 就此取官方那一位，`inheritedEventCount` 按运行时
 *  形状收成可空（类型在说谎，见上方注记）。 */
type SessionObservationFace = Pick<SessionObservation, "events"> & {
  readonly inheritedEventCount: SessionLogOffset | undefined;
};

interface SessionQueryFace {
  observeSession: (sessionId: SessionId) => Promise<SessionObservationFace>;
}

/** 本插件 followup 注入消息的 producer-owned source.kind（session-rescue 的
 *  RESCUE_SOURCE_KIND 同款）。0.1.7 的 V4 准入拒收退役包装
 *  `{ kind: 'plugin', plugin }`（session-format-v3-to-v4/src/message-sources.ts
 *  对每个声明的持久消息位抛 "format v4 message requires a producer-owned source
 *  kind"，followup 经 inbox 落 `agent/inbox/spliced`，正是被拒的持久位）；
 *  迁移表把未知插件名统一加 `plugin:` 前缀（sources.ts producerKind），故本插件
 *  已迁移的历史行读回也是同一个串——发出同一串，新行与历史行才是同一个身份。 */
const GATE_SOURCE_KIND = "plugin:quality-gate";

/** followup 注入的消息形状（harness UserMessage 里门禁实际用到的子集）。
 *  source 只有 producer-owned kind，不再有 `plugin` 身份字段；本包不读回它
 *  （注入是单向的，配额由 injectState 记账），改 kind 只需同步上方常量。 */
interface FollowupMessage {
  id: string;
  role: "user";
  content: { type: "text"; text: string }[];
  source: { kind: typeof GATE_SOURCE_KIND };
}

/** turn-stopping 载荷里 agent 的面＝官方 `Agent` 的本包用到的成员投影 + 本包的注入写路径。
 *  `Agent` 是 **interface**（@deepseek-ai/dsh-agent/lib/types/types.d.ts:11 只声明 `id`，
 *  lib/types/runtime-types.d.ts:138-192 以 `declare module './types.ts'` 官方增强补上
 *  session :143 / inbox :145 / status :147 / ctx 与 cancel/send/followup/steer/…），
 *  不带私有字段，但整面远多于本包所需，故仍按 `Pick` 只取三个：
 *   - `session` 就此是官方 `Session` 类（`SandboxPolicyRequest.session` 要的正是**它**，
 *     不是上面那个 SessionRef 视图）；
 *   - `inbox` 是本包的 `InboxQueues` 视图（官方 `Inbox` 在 runtime-types.d.ts:41-45 把
 *     `nextTurn` :43 / `nextStep` :45 都写成**必填** `readonly UserMessage[]`，那一位不进
 *     Pick 的理由见下面 InboxQueues 的注记）；
 *   - `status` 是官方 `AgentStatus`。本包**不**用它判 idle：turn-stopping 在 running 相内
 *     serial 分发，转 idle 发生在回合结束之后（旧 `status !== 'idle' → return` 让门禁生产
 *     永不执行）。
 *  `followup` 唯独不进 Pick：官方是 `followup(message: UserMessage): void`
 *  （runtime-types.d.ts:192），而官方 `UserMessage`（@deepseek-ai/dsh-llm/lib/types/
 *  message.d.ts:144）的共享 MessageBase :124 要求 `id: MessageId` :126——**字符串** phantom
 *  brand（lib/types/brand.d.ts:14）——与 `source: MessageSource` :132（:122 =
 *  `MessageSourceMap` 的值联合，联合里**没有** `plugin:quality-gate` 这个 kind：各 producer
 *  用自己的 `declare module` 增扩，官方示例见 @deepseek-ai/dsh-agent/lib/types/
 *  model-selection.d.ts:8-12）。编译器原话：`Argument of type 'FollowupMessage' is not
 *  assignable to parameter of type 'UserMessage'. Types of property 'id' are incompatible.
 *  Type 'string' is not assignable to type 'MessageId'`。补上它要值导入 brand 构造器、并替
 *  宿主声明一个官方联合里没有的 producer kind（宿主侧 V4 准入走的是迁移表合成
 *  `plugin:<name>`，见上面 GATE_SOURCE_KIND 的注记），都不是本包该做的裁定 → 注入面按本包
 *  producer-owned 的形状交出去（见 FollowupMessage）。 */
/** 官方 `Inbox` 的两个待办队列在本包读面上的形状。
 *  官方面（@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:43,45）把两位都写成必填
 *  `readonly UserMessage[]`——那是宿主对**自己**的承诺，不是跨进程递来的一份 inbox 的实测
 *  形状：桩件与异常宿主真会只交一个队列（test/host-integrity.test.ts 就把整枚 inbox 换成
 *  `{ nextTurn }`），于是 `inboxHasPending` 在运行时读到过 undefined。类型在说谎 ⇒ 两位
 *  显式改宽成可选，读点的 `?.length ?? 0` 守卫才是必要的，而不是被判成冗余。 */
interface InboxQueues {
  readonly nextTurn?: readonly unknown[];
  readonly nextStep?: readonly unknown[];
}

type TurnAgent = Pick<Agent, "session" | "status"> & {
  inbox: InboxQueues;
  followup: (message: FollowupMessage) => void;
};

/** turn-stopping 载荷＝官方 cordis `Events`（@deepseek-ai/cordis/lib/types/events.d.ts:216）
 *  里 `agent/turn-stopping` 条目的 payload
 *  （@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:387-391 以 `declare module
 *  '@deepseek-ai/cordis'` 官方增强登记，`@mode serial`），
 *  三个字段官方**全部必填**：`{ agent: Agent; turn: number; signal: AbortSignal }`。
 *  本包按"跨进程边界的宿主数据一律可缺失"读，故只把官方 payload 整体 `Partial` 化、
 *  并把 `agent` 换成本包的 `TurnAgent` 面（Pick 投影，见上）——字段一个都不复述，
 *  官方加/删字段或换类型会立刻反映到这里。
 *  agent/turn 由宿主恒带；缺失属异常载荷，见守卫注释。 */
type TurnStoppingPayload = Partial<Omit<Parameters<Events["agent/turn-stopping"]>[0], "agent">> & {
  agent?: TurnAgent;
};

/** 一次能力调用的完整文件效应策略（harness `SandboxExecutionPolicy`）**不再本地声明**：
 *  本包要持有的就是「shell 请求里那个 sandboxPolicy 字段」，它的类型面由官方成员给出——
 *  `ShellExecRequest["sandboxPolicy"]` 的值域就是 `SandboxExecutionPolicy`
 *  （@deepseek-ai/dsh-shell/lib/types/types.d.ts:9 引入、:97 声明），
 *  `SandboxPolicyService.resolve` 的返回也是同一个类型
 *  （@deepseek-ai/dsh-sandbox-policy/lib/types/index.d.ts:88）。dsh-sandbox 不是本包依赖，
 *  故经官方成员取，而不是再抄一遍字段。旧镜像把 `sessionId` 抄成 `string`，官方那是品牌的
 *  `SessionId`（@deepseek-ai/dsh-sandbox/lib/types/index.d.ts:27-40，字段 `sessionId?: SessionId`
 *  在 :39）：本包只整体透传所以没被咬到，抄窄本身即是漂移。
 *  同理不再本地声明的还有 `SandboxMode`（官方 :19 三值联合，与本包旧抄一致）与
 *  `SandboxEnforcement`（官方 :46 `'full' | 'partial'`）——本包只经 `ShellSandboxInfo.mode`
 *  / `.enforcement` 读它们。 */
type SandboxExecutionPolicy = NonNullable<ShellExecRequest["sandboxPolicy"]>;

/** ctx.sandboxPolicy 服务面：官方 `SandboxPolicyService extends Service`
 *  （@deepseek-ai/dsh-sandbox-policy/lib/types/index.d.ts:71）的 `resolve` 方法投影——
 *  类带私有字段（`defaultMode`/`workspaceRoot` 是 public readonly，但 `Service` 基类的
 *  protected ctx 让它按名义比），结构替身满足不了整类，故只取方法面。
 *  请求体就此是官方 `SandboxPolicyRequest`（:50）：`session?: Session` 要的是**真实
 *  Session 类**（本包在 resolvePolicy 处交的是 `TurnAgent.session`，即官方 Session 本身，
 *  不是那个只服务退役读面的 SessionRef 视图——视图交不进去，见 resolvePolicy 的注释），
 *  `mode?: SandboxMode` 是「已批准的显式模式覆盖，优先级高于会话策略」（:53），本包从不传。
 *  返回值即上面的 SandboxExecutionPolicy，两侧字段都不再由本包复述。 */
type SandboxPolicyService = Pick<HostSandboxPolicyService, "resolve">;

/** 一次沙箱化执行的事实＝官方 `ShellSandboxInfo`（@deepseek-ai/dsh-shell/lib/types/
 *  types.d.ts:31-40，与退出码**正交**上报：denied/runnerFailed/enforcement）。本包旧镜像
 *  与其逐字段同形，故不再本地声明；`sandboxNote()` 的参数改绑官方成员。 */

/** 单流捕获输出（截断时保留的是**尾部**）＝官方 `CollectedOutput`：类型由
 *  @deepseek-ai/dsh-subprocess 拥有、由 dsh-shell 原样再导出
 *  （@deepseek-ai/dsh-shell/lib/types/index.d.ts:11、lib/types/types.d.ts:12）：
 *  text 必有、truncated 必有布尔、spillPath 可选（dsh-subprocess/lib/types/types.d.ts:17-24）。 */

/**
 * shell 执行面的方法投影（本包唯一的 shell 类型）。官方 `ShellExecutor` 只有 `resolve` /
 * `execute` 两个抽象方法（@deepseek-ai/dsh-shell/lib/types/index.d.ts:61/:69），且二者
 * **收的不是同一个类型**：`resolve` 收调用方给的 `ShellExecRequest`（workdir/timeoutMs/
 * stdoutMaxBytes/signal/sandboxPolicy 全可选，由实现方补默认并 clamp，types.d.ts:55-98），
 * `execute` 只收 `resolve` 交回的已解析 `ShellExecSpec`（`onExpiry`/`stdoutMaxBytes`/
 * `sandboxPolicy` 都是必填位，types.d.ts:104-130）。返回的 `ShellExecution`（:214）扩展
 * `ShellProcess`：门禁走纯前台路径，只 await 它的 `result()`，进程成员
 * （status/done/kill/readOutput/observed）一个都不读。
 * 0.1.7 唯一的执行入口（0.1.6 的 run/start 已合并到此）。旧镜像把三层的可选性各自手抄，
 * 现已全部由官方决定：`ShellRunResult.signal` 其实是**必填**的 `NodeJS.Signals | null`
 * （types.d.ts:136），另有本包不读的必填 `timeoutMs`（:152）。
 */
type ShellService = Pick<ShellExecutor, "resolve" | "execute">;

/**
 * "门禁跑了且报了代码错误"这一态的 kind 值（注入分流与 lesson 总线 category 都读它）。
 * 判别联合的类型面经 `typeof` 绑同一处，避免字面量两处各自漂移。
 */
const GATE_KIND_CODE_FAILURE = "code-failure";

/** 门禁执行结论（判别联合）：三态里没有任何"没跑成 → 通过"的通路。 */
type GateProblem =
  | { kind: typeof GATE_KIND_CODE_FAILURE; text: string }
  | { kind: "not-run"; text: string };

type GateOutcome = { kind: "pass" } | GateProblem;

/**
 * 沙箱策略解析结果：ok 才允许执行门禁；unavailable（服务在但 resolve 抛错）
 * 一律按 not-run 处理——回落到部署级策略会让门禁写在宿主 cwd 之外，被沙箱拒绝后
 * 产出假的"修这些错"指令（审计 HIGH 项的根因）。
 */
type PolicyResolution =
  | { kind: "ok"; policy: SandboxExecutionPolicy | undefined }
  | { kind: "unavailable"; reason: string };

/**
 * 官方 `SettingsForms`（installed `@deepseek-ai/dsh-settings/lib/types/index.d.ts:62`，
 * `Service` 子类 + private `ownerContext/revisions/closed/scheduled/presentations`
 * （:63/:65/:66/:67/:68）→ 名义比较）的方法面投影：本包只用 `configure`（页面策略，:80）与
 * `describe`（跨命名空间读官方 locale 偏好，:96）。此前这里写的是**整个类**，那是一条对本包
 * 需求的过度声明——它宣称「宿主必须给我一枚完整的 settings 服务」，而本文件其它每个服务面都
 * 只点名自己用到的成员。投影不重述签名：入参（含官方那个可选的 `SettingsDescribeOptions`）
 * 与返回全部由官方成员交出。
 */
type SettingsFormsService = Pick<SettingsForms, "configure" | "describe">;

/** `ctx.inject(deps, callback)` 回调收到的子上下文（本包只用到 settings + effect）。 */
interface InjectedCtx {
  settings: SettingsFormsService;
  /** 官方效应面（`interface Context extends Pick<Fiber, 'effect'>`，installed
   *  `@deepseek-ai/cordis/lib/types/fiber.d.ts`，两条重载）——本地不再重述工厂签名。
   *  官方返回域 `SyncEffect`/`Effect`（fiber.d.ts:49-52）**不收 `undefined`**：「这一趟没有
   *  要清理的东西」在官方契约里是一枚空 disposer，本包的挂载点交回的都是真 disposer。 */
  effect: Context["effect"];
}

/** 行级配置（组合包层/用户层行的 config:）由 cordis 按导出的 `Config` schema 校验并
 *  填默认后传入 apply。0.1.7 起隐式注册：命名空间 = profile 条目 id（`quality-gate`，
 *  见 cordis.patch.yml），可编辑字段由 schema 上的 `.volatile()` 声明，不再有
 *  `settings.register` 的第二层「底座」——原 BUILTIN_BASE 逐字段落成下面的
 *  `.default(...)`，单一来源。volatile 字段以 Volatile 引用形态交进来，读当前值一律 `.get()`。 */
export interface ConfigShape {
  enabled: Volatile<boolean>;
  maxInjectsPerTurn: Volatile<number>;
  gateBudgetMs: Volatile<number>;
  /** 记忆反馈总开关。**默认关**：见 Config schema 的注释。 */
  memoryFeedback: Volatile<boolean>;
  /** 记忆网关基址。空串 = 未配置 = 不启用（与开关构成双保险）；本机用户填自己的地址。 */
  memoryGatewayUrl: Volatile<string>;
  /** 网关鉴权令牌的**凭据引用**（环境变量名形态）：值走 ctx.credentials，不落设置。 */
  memoryGatewayKeyRef: Volatile<string>;
  /** 向上找项目根的最大层数（非 volatile 部署值：普通值形态，不经 .get()，不占设置卡）。 */
  maxRootDepth: number;
  /** 门禁 stdout 捕获上限（字节）（非 volatile 部署值：普通值形态，不占设置卡）。 */
  gateStdoutMaxBytes: number;
}

/** 一次读全的解析后设置快照（旧 scope.get() 的等价物）：门禁按回合现读，纯值往下传，
 *  不必让每个消费方都持有引用。 */
interface ResolvedSettings {
  enabled: boolean;
  maxInjectsPerTurn: number;
  gateBudgetMs: number;
  memoryFeedback: boolean;
  memoryGatewayUrl: string;
  memoryGatewayKeyRef: string;
}

/**
 * lesson-loop 总线最小面（自进化闭环）：可选读——总线缺失只丢报告；
 * report 自身容错，门禁主流程绝不因总线故障失败。全量 detail，不截断。
 * category 二值：gate-failure 是代码失败事实；gate-not-run 是"检查没跑成"事实，
 * 两者必须分开，否则自进化闭环会把环境/策略问题学成代码教训。
 *
 * 返回值按 unknown 收而不是 void：lesson-loop 的 report 已异步落库（返回 Promise），
 * 而 `(input) => void` 的函数类型**恰好允许调用方丢弃返回的 Promise**——TS 不报
 * "游离 Promise"，no-floating-promises 也看不到，失败于是被静默吞掉并留下一枚未处理
 * 拒绝，正是这次修的根因。unknown 保留真实形状，调用方一律经 settleLessonCall 收口。
 */
interface LessonLoopReporter {
  report: (input: {
    source: "quality-gate";
    category: "gate-failure" | "gate-not-run";
    cwd: string | undefined;
    sessionId: string;
    turn: number;
    signature: string;
    detail: string;
    evidence: Record<string, unknown>;
  }) => unknown;
}

/**
 * ctx.credentials 的服务面：官方 `CredentialProvider extends Service`
 * （@deepseek-ai/dsh-credentials/lib/types/index.d.ts:119）的 `resolve` **方法面投影**
 * （:129）——整类带 private 字段是名义比较，结构替身永远满足不了，故只 Pick 用到的那一位；
 * 投影不重述签名，入参（品牌 `CredentialRef`）与返回（`ResolvedCredential | undefined`，
 * :71-76：`value` 非空密钥 + `source` 来源层）全部由官方交出。本包只读 `.value`，来源层
 * 不进任何决策，但也不再本地抄一个只剩 value 的 `CredentialHit`。
 *
 * 入参**不再**由本包放宽成 `string`：幻影品牌没有 type-only 的构造口（编译器原话
 * `Argument of type 'string' is not assignable to parameter of type 'CredentialRef'. Type
 * 'string' is not assignable to type '{ readonly [BRAND]: "CredentialRef"; }'`），而 `as`
 * 被 lint 的 typescript/no-unsafe-type-assertion 禁掉，唯一合法送法是官方值导入
 * `credentialRef(value)`（index.d.ts:18；它先按 REF_PATTERN 校验、不合规即抛 TypeError，再交
 * dsh-brand 的恒等 `brandString`，@deepseek-ai/dsh-brand/lib/index.js:20-22）。本包在调用前
 * 先用官方 `isCredentialRefName`（index.d.ts:28，用法说明 :20-27）问一遍语法——这正是官方对
 * 「名字来自设置字典」这一来源给出的口径：语法外的名字根本没有可 miss 的引用，读作"未配置"
 * 比送去抛错更准，也就绝不会撞上 `credentialRef()` 的抛错路径。
 * 与本文件顶部的发布纪律不冲突：值导入的这两个函数都是纯字符串函数；口径 A（2026-09-26）把
 * dsh-credentials 落在 dependencies，产物因此**新增**一条 `from "@deepseek-ai/dsh-credentials"`
 * 裸说明符（旧写法放 devDependencies 会把函数体内联进产物）。两件事由
 * `test/build-host.test.ts` 成对钉住：说明符在 + 官方构造器的函数体不在。
 */
type CredentialService = Pick<CredentialProvider, "resolve">;

/**
 * 宿主 logger 的本包用面：官方 `ctx.logger(name)` 具名 facade 的方法子集
 * （cordis-api/context.md:131-138；installed @deepseek-ai/cordis/lib/types/logger.d.ts:55-58
 * 的 Logger facade，方法形如 `(format, ...param)`）。结构化最小声明——不 import cordis 的
 * Logger 类型（类类型带 private 字段按名义比，测试桩件给个同形对象即可）。
 */
interface Log {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface HostCtx {
  settings: SettingsFormsService;
  /** 具名 logger 服务（cordis-api/context.md:131-138）。缺席（异常 ctx/测试桩件）→
   *  回退 console——回退是**兼容路径**不是常态路径，测试两条都覆盖。 */
  logger?: (name: string) => Log;
  /** 隐式注册后本包不再持有 scope，只经注入的子上下文挂页面策略（宿主 dsh-client-locale 同款）。 */
  inject: (deps: readonly string[], callback: (child: InjectedCtx) => void) => unknown;
  /** 本插件 fiber：`configure` 的 owner 必须显式传它（缺省是 settings 服务自己的 fiber）。
   *  类型就是官方 `SettingsForms.configure(presentation, owner?: Fiber)`（installed
   *  `@deepseek-ai/dsh-settings/lib/types/index.d.ts:80`）的那位 `Fiber`——旧代码写成 `unknown`
   *  是为了把任何东西塞进 owner，官方面交回来后它才真的受约束。
   *  运行时那道 `isRecord(fiber)` 闸留着（见 `isGateHost`）：官方类型说的是宿主的承诺，
   *  跨进程递来的 ctx 是否兑现由守卫负责。 */
  fiber: Fiber;
  /**
   * 可选服务的读法：命中返回服务实例，未注册返回 undefined——**不抛错**。
   * shell / sandboxPolicy / lessonLoop / credentials 走这个：把它们列进 inject 会让缺失
   * 环境下插件整体不加载。
   * 字面量 name 重载（按服务返回精确类型），其余未知服务名回退 unknown——
   * 由此 getShell/lessonLoop 的取用不再需要 `as` 断言。
   * ⚠ 这一位**不能**换成官方 `Context["get"]`（ctx-observe / ocr-review / zvec-grep 那三包的
   * 读法）：官方那一位是 `get<K extends string & keyof this>(name: K): undefined | this[K]`
   * 加一条 `get(name: string): any` 兜底（installed `@deepseek-ai/cordis/lib/types/reflect.d.ts:14,17`）。
   * `shell` / `sandboxPolicy` / `credentials` 确实都是官方声明进 `Context` 的名字（installed
   * `@deepseek-ai/dsh-shell/lib/types/index.d.ts:15-17` 等），走泛型臂没问题；但
   * `lessonLoop` 是**兄弟插件**（lesson-loop 包）提供的服务，不在官方 `Context` 面上——
   * 换成官方面它就正好落进那条 `any` 兜底，读回来的形状从 `unknown` 退化。三包能换是因为它们
   * 读的名字全在官方 `Context` 上，本包不行，故这里的本地重载交集留着。
   */
  get: ((name: "shell") => ShellService | undefined) &
    ((name: "sandboxPolicy") => SandboxPolicyService | undefined) &
    ((name: "lessonLoop") => LessonLoopReporter | undefined) &
    ((name: "credentials") => CredentialService | undefined) &
    ((name: "sessionQuery") => SessionQueryFace | undefined) &
    ((name: string) => unknown);
  /** 官方效应面（`Context extends Pick<Fiber, 'effect'>`，installed
   *  `@deepseek-ai/cordis/lib/types/fiber.d.ts`）：本地不再重述工厂签名，返回域由官方
   *  `SyncEffect`/`Effect`（:49-52）交出，两者都**不收 `undefined`**。本包两处挂载点交回的
   *  都是真 disposer（`configure` 的撤销句柄 / `ctx.on` 的退订函数），无需空 disposer。 */
  effect: Context["effect"];
  /** 事件接线面：监听器**返回域**就此索引官方事件条目
   *  （`Events["agent/turn-stopping"]: (this: Scoped<Agent>, payload: {...}) =>
   *  Promise<void> | void`，installed @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:387-391，
   *  `@mode serial`）——本包的监听器现在要 await 官方观察面那一次日志读，返回域由官方交出
   *  之后 `Promise<void>` 就是合法实现，不必在本地把它窄成 `void`（窄成 void 会被
   *  `no-misused-promises` / `strict-void-return` 判成"把 Promise 塞进 void 槽"）。
   *  载荷位仍是 `TurnStoppingPayload` 投影，理由写在那位上；⚠ 整位仍不换 `Context["on"]`
   *  （全仓延后项，见 ctx-observe/host.ts 的同一注记）。 */
  on: (
    event: "agent/turn-stopping",
    listener: (payload: TurnStoppingPayload) => ReturnType<Events["agent/turn-stopping"]>,
  ) => unknown;
}

// ── 内置默认（0.1.6 交给 `settings.register(ns, schema, { base })` 的那层「底座」）──
// 0.1.7 把它逐字段搬进下面 schema 的 `.default()`：单一来源，cordis 装载期用同一份
// schema 填默认再交进 apply。声明在 Config 之前是为了避开 const 的 TDZ。

/** 每回合每根的门禁注入上限：循环修不好就放行并提示用户。 */
const DEFAULT_MAX_INJECTS_PER_TURN = 2;

/** 记忆网关密钥的默认凭据引用名（值由凭据服务侧存，本包只登记引用）。 */
const DEFAULT_MEMORY_KEY_REF = "TDAI_GATEWAY_KEY";

// 门禁总预算：大仓库 pnpm check 常超 120s，原默认会让门禁静默放行（形同虚设）。
// 提到 300s 且超时按"失败注入"处理（不再按通过）——用户已确认（300s + 超时报错注入）。
const DEFAULT_GATE_BUDGET_MS = 300_000;

// 向上找项目根的深度上限：深嵌套 monorepo（apps/foo/src/...）6 层不够会静默跳过 → 10 层。
const DEFAULT_MAX_ROOT_DEPTH = 10;

// 门禁 stdout 捕获上限（字节）：超过则 harness 只保留尾部（见 CollectedOutput）。
const DEFAULT_GATE_STDOUT_MAX_BYTES = 64 * 1024;

/** 设置面（= profile 条目 `quality-gate` 的可编辑表单）与 loader 行 config 共用同一份
 *  schema（单源，防漂移）。六个字段**全部** `.volatile()`：没有任何 volatile 字段的条目
 *  会被宿主 describe() 整条跳过（packages/settings/settings/src/index.ts:308-309），
 *  写入则抛 `has no volatile fields`（:386）。
 *  两个策略陷阱（都锁在下面对应的行内注释里，改默认前先读）：
 *   - `memoryGatewayUrl` 的默认是**空串**而不是缺省：`""` + feedback-off = 永不推送，
 *     换成 undefined 会把"未配置"变成"字段不存在"，行为不再等价；
 *   - `memoryGatewayKeyRef` 的 `.role('credential-ref')` 与 `.volatile()` **共存**：role 只
 *     写 meta.role（fork 的 role/volatile 都是 `{...meta, k: v}` 展开，见
 *     vendor/schemastery/src/index.ts:463-482），不会抹掉 meta.volatile。 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  maxInjectsPerTurn: Schema.natural()
    .min(1)
    .max(5)
    .default(DEFAULT_MAX_INJECTS_PER_TURN)
    .volatile(),
  gateBudgetMs: Schema.natural()
    .min(10_000)
    .max(600_000)
    .default(DEFAULT_GATE_BUDGET_MS)
    .volatile(),
  // 记忆反馈默认**关闭**：它连的是"某台机器上的记忆网关"，作者机器的 127.0.0.1:8420
  // 对别人既不存在也无意义——默认开着等于每个失败回合都去连一个不存在的本机服务
  // （白等 5s 超时 + 刷屏 warn）。要用的人在设置卡里打开并填自己的地址。
  memoryFeedback: Schema.boolean().default(false).volatile(),
  // 地址默认"未配置"（空串）：与上面的开关构成双保险，任一为空都不推送。
  memoryGatewayUrl: Schema.string().default("").volatile(),
  // 凭据引用（环境变量名形态）：官方写法 llm-deepseek/src/config.ts 的
  // `apiKeyEnv: z.string().role('credential-ref').default(...).volatile()`。role 让设置面按凭据引用呈现，
  // 存的只是引用名，密钥值由 ctx.credentials 侧管理，永不落进 settings.yaml。
  memoryGatewayKeyRef: Schema.string()
    .role("credential-ref")
    .default(DEFAULT_MEMORY_KEY_REF)
    .volatile(),
  // ── W4（config.md:78-92 判据：部署间可能想配不同值的必须是配置字段）──
  // 以下两项是**部署假定值**：非 volatile → 不进设置卡（宿主只投影 volatile 字段），
  // 以普通值形态交进 apply（不经 .get()）；默认 = 现值，cordis.yml 行 config 可改而不改代码。
  /** 向上找项目根的最大层数（深嵌套 monorepo 的探测深度）。 */
  maxRootDepth: Schema.natural().default(DEFAULT_MAX_ROOT_DEPTH),
  /** 门禁 stdout 捕获上限（字节）：超过则 harness 只保留尾部（见 CollectedOutput）。 */
  gateStdoutMaxBytes: Schema.natural().default(DEFAULT_GATE_STDOUT_MAX_BYTES),
});

/** 总预算尾段的最小可用门预算：低于此值再跑门禁必然超时（假失败），跳过剩余门禁。 */
const MIN_USEFUL_GATE_MS = 5000;
/** 截断证据的头部摘录上限（字节）：从 spill 文件里**有界**读回开头（根因所在）。 */
const EVIDENCE_HEAD_BYTES = 4096;

/** harness SandboxUnavailableError 的错误码（run() 抛出即"命令根本没跑"）。 */
const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE";

/** 每会话的注入配额状态：count=已注入修复次数；gaveUp=是否已发过"放行说明"（防重复发）。 */
interface InjectState {
  count: number;
  gaveUp: boolean;
}

/** 会话级 Map 的条数上限：超限按插入序淘汰最旧（防长期运行进程无界增长）。 */
const SESSION_BUDGET = 50;

/** 从 unknown 安全读字段：字面量键走变量参数，绕开 dot-notation 与
 *  noPropertyAccessFromIndexSignature（tsc 禁索引签名点访问）的互斥。 */
/** 错误摘要（String(error) 对非 Error 会打出 [object Object]，这里显式分类）。 */
function messageOf(error: unknown): string {
  let message = "unknown error";
  if (error instanceof Error) {
    ({ message } = error);
  } else if (typeof error === "string") {
    message = error;
  }
  return message;
}

/**
 * 会话级 Map 淘汰：把 keep 先删后插移到队尾（JS Map 迭代按插入序），再淘汰队首
 * (size - 50) 项 → keep 永不被淘汰，且总大小收敛。泛型复用：注入配额 Map（InjectState）、
 * 事件游标 Map（number）与编辑累加器 Map（EditAccumulator）共用同一策略。
 * keep 不在表内 → 直接返回（inbox-busy 分支的 injectState 就会命中：该会话从未失败过）。
 */
function pruneToSessionBudget<Value>(map: Map<string, Value>, keep: string): void {
  const kept = map.get(keep);
  if (kept === undefined) {
    return;
  }
  map.delete(keep);
  map.set(keep, kept);
  let excess = map.size - SESSION_BUDGET;
  for (const key of map.keys()) {
    if (excess <= 0) {
      break;
    }
    map.delete(key);
    excess -= 1;
  }
}

/**
 * 根会话判定（与 ctx-observe/lesson-loop 同款口径）：子代理会话
 * （delegationDepth>0 或 origin==='subagent'）跳过门禁。
 *
 * agent/turn-stopping 对每个 agent（含 in-process fork/spawn 子代理）都触发，
 * 旧实现未过滤子代理 → ①父会话与子代理对同一项目根各跑一遍门禁（token/耗时翻倍）；
 * ②失败注入文案面向用户，却 followup 进子代理——结算前到达会多拖一轮子代理回合，
 * 结算后到达则滞留 inbox 被丢弃（门禁静默失效）。统一改为只对根会话收口。
 *
 * out-of-process 子代理（ACP/claude-code/codex）
 * 在独立进程运行，不发射 dsh 的 agent 事件，其编辑天然不在任何门禁面内；in-process
 * 子代理经本判定跳过后，其编辑由父会话下一回合的收口门禁在父侧统一核验（未来如需
 * 精确到子代理编辑，可在父会话聚合子会话 tool/call——本插件不做，避免过度设计）。
 */
function isRootSession(agent: TurnAgent): boolean {
  const { header } = agent.session;
  // delegationDepth 在 header 里是可选的（顶层会话省略 = 零），故 ?? 0 而非 Number() 强转
  return !((header.delegationDepth ?? 0) > 0 || header.origin === "subagent");
}

/** Inbox 是否有待处理消息（读面 = `InboxQueues`：两位队列都可能缺席，故 `?.length ?? 0`）。 */
function inboxHasPending(inbox: TurnAgent["inbox"]): boolean {
  return (inbox.nextTurn?.length ?? 0) > 0 || (inbox.nextStep?.length ?? 0) > 0;
}

/**
 * 触发前二次校验：turn-stopping 时 agent.status 恒为 'running'
 * （官方 agent.ts：turn-stopping 在 running 相内 serial 分发，转 idle 发生在回合结束之后），
 * 故绝不能用 status 判 idle。改用数据信号：turn signal 已取消、或 inbox 有待处理
 * （用户接管/已排队工作）→ 不注入（对齐官方 "Data decides" 语义）。
 * 插件卸载的拦截不在这里：W4 起 disposer abort 在飞门禁批次，迟到结果在批次层就地丢弃
 * （见 processGate），到不了注入点——卸载收口比"注入前拦一下"更强。
 */
function preInjectCheck(
  agent: TurnAgent,
  signal: AbortSignal | undefined,
): { ok: boolean; reason: string } {
  if (signal?.aborted === true) {
    return { ok: false, reason: "turn aborted" };
  }
  if (inboxHasPending(agent.inbox)) {
    return { ok: false, reason: "inbox busy" };
  }
  return { ok: true, reason: "ready" };
}

/**
 * 判定门禁失败是否为"工具本身不可用"（而非代码问题）。
 *
 * `npx tsc` 在项目未装 typescript 时会**自动安装**已弃用的 stub 包 `tsc@2.0.4`，
 * 它打印横幅并以 exit 1 退出——不是 126/127，所以只按退出码判定会误报为代码失败。
 * 实测：`npx --no-install` 在本机拦不住 stub（已从 npx 缓存解析），
 * 所以必须在输出侧识别，不能只靠加 flag。
 */
function gateToolUnavailable(stdout: string, stderr: string): boolean {
  const out = `${stdout}\n${stderr}`.toLowerCase();
  // stub 包 `tsc@2.0.4` 的横幅
  if (out.includes("not the tsc command you are looking for")) {
    return true;
  }
  // npx 抓取了 stub 包（deprecation 提示只针对 tsc 这个占位包）
  return out.includes("npm warn deprecated tsc@");
}

/** harness run() 抛出的 SandboxUnavailableError（code 或 name 命中即可）。 */
function isSandboxUnavailable(error: unknown): boolean {
  return (
    fieldOf(error, "code") === SANDBOX_UNAVAILABLE ||
    fieldOf(error, "name") === "SandboxUnavailableError"
  );
}

/**
 * 有界读取截断落盘文件的头部（首个错误通常在开头，而 harness 只把尾部留在内存里；
 * spill 文件可达数 MB，故用 openSync/readSync 只读前 EVIDENCE_HEAD_BYTES）。
 * 不可读（无权限/已回收/非绝对路径）→ undefined：调用方只标注截断，不伪造头部。
 */
function headExcerpt(file: string | undefined): string | undefined {
  let excerpt: string | undefined;
  if (file !== undefined && path.isAbsolute(file)) {
    try {
      const fd = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(EVIDENCE_HEAD_BYTES);
        const bytesRead = readSync(fd, buffer, 0, EVIDENCE_HEAD_BYTES, 0);
        excerpt = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      // 不可读（无权限/已回收/设备错误）→ 只标注截断，不伪造头部摘录
      excerpt = undefined;
    }
  }
  return excerpt;
}

/**
 * 证据文本。
 *
 * tsc/cargo 等错误自顶向下，**首条才是根因**，而 harness CollectedOutput 截断时保留的是
 * **尾部**（packages/subprocess/src/types.ts）——旧实现从不查 truncated，根因错误被静默
 * 丢掉，注入给模型的"修这些错"只剩残尾（审计 MEDIUM 项）。现在：
 *   ①显式标注截断；②从 spillPath 有界读回头部摘录放在最前；③无落盘文件时明确说明
 *   首个错误可能已丢弃，让模型与用户都知道证据不完整。
 * 未截断时不叠加第二层截断（用户拍板"不为省 token 降能力"，上限由 shell 的
 * stdoutMaxBytes 把关）。
 */
function evidenceText(
  messages: QualityGateMessages,
  stream: CollectedOutput,
  label: string,
): string {
  if (!stream.truncated) {
    return `${label}:\n${stream.text}`;
  }
  const head = headExcerpt(stream.spillPath);
  const notice = `${renderTemplate(messages.evidenceTruncated, {
    label,
    spill: stream.spillPath ?? messages.noSpillFile,
  })}\n`;
  let out = `${notice}${stream.text}`;
  if (head !== undefined) {
    out = `${notice}${renderTemplate(messages.evidenceHeadTail, { head, text: stream.text })}`;
  }
  return out;
}

const gateText = (messages: QualityGateMessages, gate: Gate, out: string): string =>
  renderTemplate(messages.gateFailed, {
    command: gate.command.join(" "),
    root: gate.root,
    output: out,
  });

/**
 * "门禁没跑成"文案：与"修这些错"严格分开——没跑成的检查不是代码错误的证据，
 * 让模型去修一个装不上的工具/越不过去的沙箱，只会配着配额环烧 token。
 */
const notRunText = (messages: QualityGateMessages, gate: Gate, reason: string): string =>
  renderTemplate(messages.gateNotRun, {
    command: gate.command.join(" "),
    root: gate.root,
    reason,
  });

/** 配额耗尽后的"放行说明"（用户可见，不再静默 return）。 */
const giveUpText = (messages: QualityGateMessages, gate: Gate, attempts: number): string =>
  renderTemplate(messages.gaveUp, {
    attempts,
    command: gate.command.join(" "),
    root: gate.root,
  });

/** 未执行清单的一行（模块级：不让 renderTemplate 套进 map 再套进 renderTemplate）。 */
const skippedGateLine = (messages: QualityGateMessages, gate: Gate): string =>
  renderTemplate(messages.skippedGateItem, { command: gate.command.join(" "), root: gate.root });

/** 预算耗尽后剩余门禁的"未执行"清单（审计 MEDIUM 项：只 warn = 静默通过）。 */
const skippedText = (messages: QualityGateMessages, gates: readonly Gate[]): string =>
  renderTemplate(messages.gatesSkipped, {
    budgetMs: MIN_USEFUL_GATE_MS,
    list: gates.map((gate) => skippedGateLine(messages, gate)).join("\n"),
  });

/** 沙箱事实 → 可读的模式/完备度说明（策略拒绝与代码失败分开表述的素材）。 */
function sandboxNote(messages: QualityGateMessages, facts: ShellSandboxInfo): string {
  const mode = renderTemplate(messages.sandboxMode, { mode: facts.mode });
  return facts.enforcement === undefined
    ? mode
    : `${mode}${renderTemplate(messages.sandboxEnforcement, { enforcement: facts.enforcement })}`;
}

/**
 * 沙箱面拦截结论（runner 不可用 / 策略拒绝）→ not-run。
 *
 * 两条消息按官方事实的优先级二选一（runnerFailed 先），判定序与旧内联 if 完全一致；
 * 没有拦截返回 undefined，交给退出码阶梯。
 */
function sandboxBlockOutcome(
  messages: QualityGateMessages,
  facts: ShellSandboxInfo,
  stderr: CollectedOutput,
): GateOutcome | undefined {
  let outcome: GateOutcome | undefined;
  if (facts.runnerFailed === true || facts.denied) {
    const sandbox = sandboxNote(messages, facts);
    const reason =
      facts.runnerFailed === true
        ? renderTemplate(messages.runnerFailed, { sandbox })
        : renderTemplate(messages.policyDenied, { sandbox });
    outcome = { kind: "not-run", text: `${reason}\n${evidenceText(messages, stderr, "stderr")}` };
  }
  return outcome;
}

/**
 * 进程没跑完的三种形态：超时 / 取消 / 没有退出码（被信号杀死）。
 *
 * 前两条按 not-run，被信号杀死按代码失败——与旧 ladder 的前三支同序同文案。
 */
function interruptedRunOutcome(
  messages: QualityGateMessages,
  budgetMs: number,
  res: ShellRunResult,
): GateOutcome | undefined {
  let outcome: GateOutcome | undefined;
  if (res.timedOut) {
    outcome = {
      kind: "not-run",
      text:
        `${renderTemplate(messages.timedOut, { seconds: Math.round(budgetMs / 1000) })}\n` +
        `${evidenceText(messages, res.stdout, "stdout")}${evidenceText(messages, res.stderr, "stderr")}`,
    };
  } else if (res.aborted) {
    outcome = { kind: "not-run", text: messages.aborted };
  } else if (res.exitCode === null) {
    const signalName = typeof res.signal === "string" && res.signal.length > 0 ? res.signal : "?";
    outcome = {
      kind: GATE_KIND_CODE_FAILURE,
      text: `exit=signal(${signalName})\n${evidenceText(messages, res.stdout, "stdout")}${evidenceText(messages, res.stderr, "stderr")}`,
    };
  }
  return outcome;
}

/**
 * 门禁工具本身不可用（exit 126/127 = 不可执行/未找到）→ not-run，并 warn 给运维。
 *
 * 环境问题非代码问题：走失败注入会让模型去"修"装不了的工具（配合配额环更糟）。
 * 但它同样是"没跑成的检查"，所以按 not-run 注入"请手动确认"，不再算作通过
 * （审计：没跑成 ≠ 通过）。
 */
function unavailableToolOutcome(
  messages: QualityGateMessages,
  gate: Gate,
  res: ShellRunResult,
  log: Log,
): GateOutcome | undefined {
  let outcome: GateOutcome | undefined;
  if (res.exitCode === 126 || res.exitCode === 127) {
    log.warn(
      `[quality-gate] gate tool unavailable (exit ${res.exitCode}): ${gate.command.join(" ")} — reported as not-run, not as pass`,
    );
    const cause = res.exitCode === 127 ? messages.toolMissing : messages.toolNotExecutable;
    outcome = {
      kind: "not-run",
      text: `${renderTemplate(messages.toolNotRun, { cause })}\n${evidenceText(messages, res.stderr, "stderr")}`,
    };
  }
  return outcome;
}

/**
 * 把一次 shell.execute().result() 结果分类成三态（纯函数：不进 ctx，每条分支都可测）。
 *
 * harness 的 ShellRunResult.sandbox 与退出码**正交**上报（packages/shell/shell/src/types.ts：
 * "Facts are reported independently of process exit status so callers can distinguish
 * command failures from policy denials and runner failures"），旧实现从不读它 →
 * 策略拒绝被当成代码失败注入"修这些错"（审计 HIGH 项）。
 *
 * 判定序（三支各自成函数，顺序与 warn 次数都不变）：沙箱面拦截 → 进程没跑完 →
 * 工具装不上（126/127）→ exit 0（部分生效沙箱只 warn）→ npx stub 横幅 → 代码失败。
 */
function classifyRun(
  messages: QualityGateMessages,
  gate: Gate,
  budgetMs: number,
  res: ShellRunResult,
  log: Log,
): GateOutcome {
  const facts = res.sandbox;
  if (facts !== undefined) {
    const blocked = sandboxBlockOutcome(messages, facts, res.stderr);
    if (blocked !== undefined) {
      return blocked;
    }
  }
  const interrupted = interruptedRunOutcome(messages, budgetMs, res);
  if (interrupted !== undefined) {
    return interrupted;
  }
  const unusable = unavailableToolOutcome(messages, gate, res, log);
  if (unusable !== undefined) {
    return unusable;
  }
  if (res.exitCode === 0) {
    // 部分生效的沙箱下 exit 0 只是"在该边界内没报错"——warn 给运维，判定仍是 pass。
    if (facts?.enforcement === "partial") {
      log.warn(
        `[quality-gate] gate passed under PARTIAL sandbox enforcement (${sandboxNote(messages, facts)}): ${gate.command.join(" ")} @ ${gate.root}`,
      );
    }
    return { kind: "pass" };
  }
  // npx 抓到 stub 包（横幅/弃用警告）也是同一类：工具没起来，不是代码有问题。
  if (gateToolUnavailable(res.stdout.text, res.stderr.text)) {
    log.warn(
      `[quality-gate] gate tool unavailable (npx fetched a stub instead of the real tool): ${gate.command.join(" ")} in ${gate.root} — reported as not-run`,
    );
    return {
      kind: "not-run",
      text: `${messages.toolStub}\n${evidenceText(messages, res.stderr, "stderr")}`,
    };
  }
  return {
    kind: GATE_KIND_CODE_FAILURE,
    text: `exit=${res.exitCode}\n${evidenceText(messages, res.stdout, "stdout")}${evidenceText(messages, res.stderr, "stderr")}`,
  };
}

/** 是否是会被记账的编辑类工具（edit/write + str_replace_editor）。 */
function isEditTool(name: string): boolean {
  return name === "edit" || name === "write" || name === "str_replace_editor";
}

/**
 * 根 package.json 已声明的 scripts 名清单（值是非空字符串才算"声明了这条脚本"）。
 *
 * 读不到 / JSON 非法 / 没有 scripts 字段 → **undefined（"没有信息"）**，由 gate-detect
 * 按保守口径处理（不发 pnpm check）。不在这里替项目猜：猜错的代价是假失败注入。
 */
function declaredScriptsOf(root: string): readonly string[] | undefined {
  let names: readonly string[] | undefined;
  try {
    // JSON.parse 返回 any：先经 unknown 再守卫投影（不经 unsafe 断言）
    const raw: unknown = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
    const scripts = fieldOf(raw, "scripts");
    // scripts 不是对象（缺字段 / `"scripts": 42`）与读失败同一口径：names 保持 undefined，
    // 即"没有信息"——不替项目猜一条门禁。
    if (isRecord(scripts)) {
      names = Object.entries(scripts)
        .filter(([, body]) => typeof body === "string" && body.length > 0)
        .map(([name]) => name);
    }
  } catch {
    // 不可读/坏 JSON：如实留 undefined，让 gate-detect 走"宁可不给门禁"的保守口径
    names = undefined;
  }
  return names;
}

/** 数组性判据（**不是** type predicate，故不产生类型收窄；理由见 resolveEventWindow）。 */
function isArrayDelivery(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * 解析事件游标窗口：fork 切点下限 vs 上次已读 seq 取大，返回起始 seq 与本批事件。
 * 事件流取自官方 `ctx.sessionQuery.observeSession(sessionId)`（见上面 SessionQueryFace：
 * 一次交回 `events` 与 `inheritedEventCount`）。三条降级路径一律 `undefined`（调用方直接
 * 返回，**游标不推进**、不误报）：① `sessionQuery` 未装配（`Context["get"]` 的官方语义即
 * "or `undefined` when not (yet) provided"，installed cordis/lib/types/reflect.d.ts:12）；
 * ② `observeSession` 抛错/拒绝（会话已卸载、存储读不出）；③ 交回的 events 不是数组
 * （契约外交付，由 `isArrayDelivery` 那道**布尔**判据挡——不用 `Array.isArray` 作守卫收窄，
 * 它会把官方 `readonly SessionEvent[]` 塌成 `any[]`，类型面当场作废并把 any 传进下游记账）。
 * 窗口仍由**本地按 from 切片**：观察面给的是自日志开头的连续切片（`seq = log.length`
 * 连续性契约，installed dsh-session/lib/index.js:1285 的注记），而 `from` 是本包游标算出的
 * 裸 number——这样连 `SessionLogOffset` 的品牌都不必造（官方只要 `SessionId`，那一位从
 * `Session.id` 上拿回来就是品牌的）。
 */
async function resolveEventWindow(
  query: SessionQueryFace | undefined,
  sessionId: SessionId,
  lastSeq: ReadonlyMap<string, number>,
): Promise<{ from: number; events: readonly SessionEvent[] } | undefined> {
  // 单 return（consistent-return 与 treatUndefinedAsUnspecified：不混 undefined 与值返回）
  let window: { from: number; events: readonly SessionEvent[] } | undefined;
  if (query !== undefined) {
    try {
      const observation = await query.observeSession(sessionId);
      // 游标下限 = fork 切点（root 会话为 0）：首见会话（含进程重启后）从下限重放
      // 本会话自己的历史编辑——这是有意的，turn-stopping 时本回合编辑已在日志里，
      // 从末尾起步会跳过正在要检查的回合。代价是重启后首轮会多跑几次门禁（预算与
      // maxInjectsPerTurn 兜底）；重放本身不会造成假失败——根必须是真 TS 项目
      // （见 gate-detect B1），历史编辑的根都是真项目。
      const forkCut = observation.inheritedEventCount ?? 0;
      const from = Math.max(forkCut, lastSeq.get(sessionId) ?? forkCut);
      if (isArrayDelivery(observation.events)) {
        window = { from, events: observation.events.slice(from) };
      }
    } catch {
      // 观察面读不出来：与迁移前"snapshotEvents 缺失/非数组"同一档降级——不推进游标。
      window = undefined;
    }
  }
  return window;
}

interface EditRecord {
  name: string;
  path: string | undefined;
}

interface PendingEdits {
  pending: Map<string, EditRecord>;
  noCallId: EditRecord[];
  failed: Set<string>;
}

/** 按有无 callId 分流：无 callId 直记（异常/旧形状/测试 mock 保守直记防漏），有则按 callId 关联。 */
function storeEdit(
  callId: string | undefined,
  record: EditRecord,
  pending: Map<string, EditRecord>,
  noCallId: EditRecord[],
): void {
  if (callId === undefined) {
    noCallId.push(record);
  } else {
    pending.set(callId, record);
  }
}

/**
 * 单扫描事件流 → 编辑记账三表：callId→编辑（成功关联）、无 callId 直记表、失败 callId 集。
 * 只记成功编辑：被 danger-guard 拒绝或执行失败的 tool/result 标记失败 callId，跳过。
 * 记账骨架复用 shared scanToolEvents（事件解析/view 判定/坏参标记），本函数只做
 * 领域过滤（编辑工具集、路径记账语义）——与 danger-guard 不再各有 JSON.parse/view 双实现。
 *
 * 语义对照（与原本地实现等价）：
 *   - 坏参数（JSON 非法/非对象）→ 跳过记账（原 EDIT_SKIP）；
 *   - str_replace_editor view（只读）→ 跳过（原 EDIT_SKIP）；
 *   - 其余编辑调用按 callId 关联，tool/result isError 回填 failed。
 */
function collectEdits(events: readonly SessionEvent[]): PendingEdits {
  const pending = new Map<string, EditRecord>();
  const noCallId: EditRecord[] = [];
  const failed = new Set<string>();
  const { calls, results } = scanToolEvents(events);
  for (const call of calls) {
    // read-view（str_replace_editor view）只读不算编辑；坏参（JSON 非法）与
    // 非编辑工具同样不落地——与名义实现的 EDIT_SKIP 分支严格等价。
    if (call.name !== undefined && isEditTool(call.name) && !call.badArguments) {
      const target = sharedEditPathOf(call);
      if (target.kind === "write") {
        storeEdit(call.callId, { name: call.name, path: target.path }, pending, noCallId);
      }
    }
  }
  for (const result of results) {
    if (result.isError && result.callId !== undefined) {
      failed.add(result.callId);
    }
  }
  return { pending, noCallId, failed };
}

/** 单文件向上找最近的清单根；hitDepthLimit 标记是否因超深而无根（供可观测 warn）。
 *  maxDepth 来自 Config 的 maxRootDepth（W4 非 volatile 部署值）。 */
function findManifestRoot(
  file: string,
  maxDepth: number,
): { root: string | undefined; hitDepthLimit: boolean } {
  let dir = path.dirname(file);
  let found: string | undefined;
  let hitDepthLimit = false;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const manifest of MANIFESTS) {
      if (existsSync(`${dir}/${manifest}`)) {
        found = dir;
        break;
      }
    }
    if (found !== undefined) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
    if (depth === maxDepth - 1) {
      hitDepthLimit = true;
    }
  }
  return { root: found, hitDepthLimit };
}

/**
 * 命中最近清单后继续向上探测 pnpm-workspace.yaml —— workspace 根优先。
 * monorepo 子包（admin/src/x.ts）编辑应跑工作区全套 `pnpm check`，而非退化为子包 `tsc`。
 */
function workspaceRootUpgrade(root: string, maxDepth: number): string {
  let up = path.dirname(root);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (existsSync(`${up}/pnpm-workspace.yaml`)) {
      return up;
    }
    const parent = path.dirname(up);
    if (parent === up) {
      break;
    }
    up = parent;
  }
  return root;
}

/**
 * 探测一个根的真实盘上事实 → gate-detect 的入参形状（ProjectRoot）。
 *
 * - 清单名：MANIFESTS 里实际存在的项；
 * - tsconfig.json 不作为"根标记"（不进 MANIFESTS，避免改动根向上探测的语义），
 *   但要进清单集合——gate-detect 用它区分"真 TS 项目"与"只有 package.json 的空壳"；
 * - scripts：根 package.json 已声明的脚本名清单，交给 gate-detect 判定 pnpm check
 *   是否可用。**这里只做如实登记，不做取舍**（探测策略集中在纯函数里）。
 */
function probeProjectRoot(root: string): ProjectRoot {
  const manifests = MANIFESTS.filter((manifest) => existsSync(`${root}/${manifest}`));
  if (existsSync(`${root}/tsconfig.json`)) {
    manifests.push("tsconfig.json");
  }
  // 没有 package.json 时不读脚本清单（那次 IO 无意义：pnpm 分支要求 package.json 在场）
  const scripts = manifests.includes("package.json") ? declaredScriptsOf(root) : undefined;
  return scripts === undefined ? { root, files: manifests } : { root, files: manifests, scripts };
}

/** 注入载荷组装（id 唯一，同一毫秒多次注入也不碰撞）。 */
const injectMessage = (text: string): FollowupMessage => ({
  id: `quality-gate-${randomUUID()}`,
  role: "user",
  content: [{ type: "text", text }],
  source: { kind: GATE_SOURCE_KIND },
});

/**
 * 总线上报（自进化闭环）：门禁失败是事实，无论注入与否都要沉淀
 * ——修复环里同一门禁反复失败会形成 violation 序列，度量"提醒有没有用"。
 * 但"没跑成"以 gate-not-run 单独上报：环境/策略问题不得被学成代码教训（审计 HIGH 项
 * 的第二半——假的失败指令曾经既进注入又进记忆/lesson-loop）。
 * report 自身容错（同步抛错与异步拒绝经 settleLessonCall 落进同一条 warn）；
 * 总线缺失（未装 lesson-loop）时 get 返回 undefined 直接跳过。
 */
function reportProblemToBus(
  get: HostCtx["get"],
  attribution: { sessionId: string; turn: number; cwd: string | undefined },
  gate: Gate,
  problem: GateProblem,
  log: Log,
): void {
  settleLessonCall(
    () =>
      get("lessonLoop")?.report({
        source: "quality-gate",
        category: problem.kind === GATE_KIND_CODE_FAILURE ? "gate-failure" : "gate-not-run",
        cwd: attribution.cwd,
        sessionId: attribution.sessionId,
        turn: attribution.turn,
        signature: gate.command.join(" "),
        detail: problem.text,
        evidence: { root: gate.root, command: gate.command, kind: problem.kind },
      }),
    (reason) => {
      log.warn(`[quality-gate] lessonLoop report failed: ${messageOf(reason)}`);
    },
  );
}

/** 一次记忆反馈投递目标的解析结论（判别联合：每条降级原因都可被测试单独钉住）。 */
type FeedbackResolution = { ok: true; target: GatewayTarget } | { ok: false; reason: string };

/** 记忆反馈降级的可观测状态（每次 apply 一份：插件重载即重新计数，不跨代累计）。
 *  log 随行：本包具名 logger（宿主未装则回退 console），降级路径的唯一出口。 */
interface MemorySkipNotice {
  warned: boolean;
  log: Log;
}

/**
 * 设置 + dsh 凭据通道 → 一次投递目标；任一环节缺失只返回降级原因，**不抛**。
 *
 * 为什么不抛：记忆反馈是尽力而为的补强。别人机器上没有那台网关、没配凭据、甚至没装
 * 凭据服务都是**常态**，抛错会把一次正常的门禁失败升级成回合错误（且缺配置本就是
 * 用户要看见的信息，不是异常）。
 *
 * 密钥改走 ctx.credentials 后不再有 gateway.key 文件路径拼接：网关地址与令牌都是
 * "某台机器上的事实"，只能由使用者显式配置（设置项 + 凭据），不能被插件替所有人认定。
 */
async function resolveFeedbackTarget(
  cfg: ResolvedSettings,
  credentials: CredentialService | undefined,
): Promise<FeedbackResolution> {
  const url = resolveGatewayUrl(cfg.memoryGatewayUrl);
  if (url === "") {
    return { ok: false, reason: "memoryGatewayUrl 未配置（留空 = 不启用记忆反馈）" };
  }
  if (!isCredentialRefName(cfg.memoryGatewayKeyRef)) {
    return {
      ok: false,
      reason: `memoryGatewayKeyRef "${cfg.memoryGatewayKeyRef}" 不是合法凭据引用名`,
    };
  }
  if (credentials === undefined) {
    return { ok: false, reason: "credentials 服务未注册，网关密钥无从解析" };
  }
  // 上面那道 isCredentialRefName 已保证语法，故 credentialRef() 的校验必过（不会抛）。
  const hit = await credentials.resolve(credentialRef(cfg.memoryGatewayKeyRef));
  // 凭据侧的口径是"空值即不存在"（resolve 只会返回真值），故这里只判 undefined。
  if (hit === undefined) {
    return { ok: false, reason: `凭据 ${cfg.memoryGatewayKeyRef} 未配置（值不落在设置里）` };
  }
  return { ok: true, target: { url, key: hit.value } };
}

/**
 * 记忆反馈的降级说明只说一次：默认关闭之后仍把它打开的人，多半正是"少配了一项"的状态
 * （地址填了、凭据没配）。每个失败回合重复刷屏只会淹掉门禁日志。
 */
function warnMemorySkip(notice: MemorySkipNotice, reason: string): void {
  if (notice.warned) {
    return;
  }
  notice.warned = true;
  notice.log.warn(`[quality-gate] memory feedback skipped: ${reason}`);
}

/** 尽力而为的记忆反馈（内部消化错误，绝不阻塞门禁主流程）。 */
async function pushFeedbackToMemory(
  get: HostCtx["get"],
  notice: MemorySkipNotice,
  cfg: ResolvedSettings,
  messages: QualityGateMessages,
  input: GateFeedbackInput,
): Promise<void> {
  try {
    const resolution = await resolveFeedbackTarget(cfg, get("credentials"));
    if (!resolution.ok) {
      warnMemorySkip(notice, resolution.reason);
      return;
    }
    await pushGateFeedback(input, resolution.target, messages);
  } catch (error) {
    notice.log.warn(`[quality-gate] memory feedback skipped: ${messageOf(error)}`);
  }
}

/** 一次读全的解析后设置快照（旧 scope.get() 的等价物）：门禁按回合现读，纯值往下传，
 *  不必让每个消费方都持有引用。官方同款读法见 harness
 *  packages/llm/llm-deepseek/src/config.ts 的 `plainOptions(config)`。 */
function settingsOf(config: ConfigShape): ResolvedSettings {
  return {
    enabled: config.enabled.get(),
    maxInjectsPerTurn: config.maxInjectsPerTurn.get(),
    gateBudgetMs: config.gateBudgetMs.get(),
    memoryFeedback: config.memoryFeedback.get(),
    memoryGatewayUrl: config.memoryGatewayUrl.get(),
    memoryGatewayKeyRef: config.memoryGatewayKeyRef.get(),
  };
}

/**
 * ctx 的本包服务面守卫（替代 `ctx as unknown as HostCtx` 断言：严格档下豁免注释
 * 不是合法手段）。cordis 的 ctx 是运行期代理，成员是否齐备只能按实际调用面核验。
 * 核验的是 **0.1.7 的实际面**：`settings.configure`（页面策略）+ `settings.describe`
 * （跨命名空间读）+ `inject` + `fiber` + `get`/`on`/`effect`。
 * ⚠ 不能再探 `settings.register`：0.1.7 已把它连同 get/installSection 一起移除，
 * 拿它当硬前置会让**每一条真宿主**都判成"服务面不齐"，`gate not armed` 于是成为
 * 唯一可能的失败模式（本包设置面失效就是这么静默掉下去的）。
 * 缺任一项一律 fail-closed：不注册监听、不写游标，只记一条 error，避免带着半截服务面
 * 在首个回合才崩（且崩溃会被折叠成 turn kind:error 直接甩给用户）。
 */
function isGateHost(value: unknown): value is Context & HostCtx {
  if (!isRecord(value)) {
    return false;
  }
  const { effect, fiber, get, inject, on, settings } = value;
  return (
    typeof get === "function" &&
    typeof on === "function" &&
    typeof effect === "function" &&
    typeof inject === "function" &&
    isRecord(fiber) &&
    typeof fieldOf(settings, "describe") === "function" &&
    typeof fieldOf(settings, "configure") === "function"
  );
}

/**
 * 从编辑文件路径向上找最近的清单根（层数上限 = Config 的 maxRootDepth，W4 非 volatile
 * 部署值），每个根探一次真实盘上事实（清单名 + 已声明脚本）。找不到清单根的文件跳过
 * （无门禁面）。
 */
function projectRootsOf(files: readonly string[], maxDepth: number, log: Log): ProjectRoot[] {
  const roots = new Map<string, ProjectRoot>();
  for (const file of files) {
    const hit = findManifestRoot(file, maxDepth);
    const useRoot = hit.root;
    if (useRoot === undefined) {
      // 低危可观测：深仓（超层数无清单）静默跳过会让门禁漏面。
      if (hit.hitDepthLimit) {
        log.warn(
          `[quality-gate] no manifest within ${maxDepth} levels of ${file}; gate skipped for it`,
        );
      }
    } else {
      const upgraded = workspaceRootUpgrade(useRoot, maxDepth);
      // 同根只探一次盘：一轮改几百个文件时逐文件重复 existsSync + 读 package.json 没意义。
      if (!roots.has(upgraded)) {
        roots.set(upgraded, probeProjectRoot(upgraded));
      }
    }
  }
  return [...roots.values()];
}

/**
 * 执行一个门禁：只有 exitCode 0 才是 pass。
 * 超时/取消/信号/策略拒绝/工具装不上都走 classifyRun 的显式三态；
 * **catch 不再报通过**（审计 MEDIUM 项：workdir 不存在、spawn 失败、
 * SandboxUnavailableError 都曾落进 catch 被当 PASS）。
 */
async function runGate(
  messages: QualityGateMessages,
  shell: ShellService,
  gate: Gate,
  budgetMs: number,
  /** 本趟门禁的运行面：策略按会话解析一次；signal 是 turn signal ∪ dispose abort 的组合
   *  信号（**恒有值**——批次起步前已与 gateAbort.signal 归一）；stdoutMaxBytes 来自
   *  Config 的非 volatile 部署值；log 是具名 logger（回退 console）。 */
  context: {
    policy: SandboxExecutionPolicy | undefined;
    signal: AbortSignal;
    stdoutMaxBytes: number;
    log: Log;
  },
): Promise<GateOutcome> {
  const { policy, signal, stdoutMaxBytes, log } = context;
  let outcome: GateOutcome;
  try {
    const spec = shell.resolve({
      // command 数组来自 gate-detect 白名单（pnpm/cargo/ruff/tsc 固定词），无注入面。
      command: gate.command.join(" "),
      workdir: gate.root,
      stdoutMaxBytes,
      timeoutMs: budgetMs,
      // C6 + W4：信号恒透传（回合取消门禁同命；disposer abort 时在飞门禁同命，
      // 不跑孤儿门禁）。
      signal,
      // 审计 HIGH：不带 sandboxPolicy 时，沙箱版 executor 会回落到**部署级**策略
      // （根 = 宿主 process.cwd()，且忽略本会话的 sandbox/mode 覆盖），门禁于是写在
      // 沙箱外 → 被拒 → 假的失败指令。必须按会话解析后传入。
      ...(policy === undefined ? {} : { sandboxPolicy: policy }),
    });
    const exec = await shell.execute(spec);
    outcome = classifyRun(messages, gate, budgetMs, await exec.result(), log);
  } catch (error) {
    log.error(
      `[quality-gate] gate did not run: ${gate.command.join(" ")} @ ${gate.root} — ${messageOf(error)}`,
    );
    const cause = messageOf(error);
    outcome = isSandboxUnavailable(error)
      ? { kind: "not-run", text: renderTemplate(messages.sandboxUnavailable, { message: cause }) }
      : {
          // 准备期失败（workdir 不存在、spawn 失败等）——同样是"没跑成"，不是通过。
          kind: "not-run",
          text: renderTemplate(messages.gateStartFailed, { message: cause }),
        };
  }
  return outcome;
}

/** apply 装载期核验过的宿主服务面（`isGateHost` 的窄化结果）：门禁体提成模块作用域的
 *  具名函数后由 {@link GateRuntime} 携带这一面，交集写法不再散在多处重抄。 */
type GateHost = Context & HostCtx;

/**
 * 一次装载（apply）的运行时账本：这些位原本全是 apply 的闭包变量，turn-stopping 的门禁体
 * 按 `eslint/max-lines-per-function` 的判据拆成模块作用域具名函数后，收成一个显式依赖对象——
 * 一次 apply 造一份，生命周期与原闭包一致（各字段注释就是原声明位上的注释）。
 * `shellWarned`/`disposed` 原本是 apply 里的两枚 `let` 旗，这里是对应的可写位。
 */
interface GateRuntime {
  svc: GateHost;
  config: ConfigShape;
  log: Log;
  maxRootDepth: number;
  stdoutMaxBytes: number;
  /** 注入文案的语言随官方 locale 偏好走：按回合现读，改语言后下一次收口就是新文案。 */
  messages: () => QualityGateMessages;
  /** sessionId → 该会话自己的编辑累加器（审计 HIGH：跨会话共用会互相偷走待复查编辑）。 */
  accumulators: Map<string, EditAccumulator>;
  /** sessionId → 跨回合累计的注入配额状态（followup 每注入一次即开新回合，
   *  旧的 `sessionId:turn` 键每回合重置 → 配额永不累计 → 失败环无限烧 token）。 */
  injectState: Map<string, InjectState>;
  /** sessionId → 上次 rescan 已读到的事件 seq（C2 增量窗：只读新 tool/call，不重读旧事件）。 */
  lastSeqBySession: Map<string, number>;
  /** 本次装载的记忆反馈降级状态（只说一次；见 warnMemorySkip）。 */
  memoryNotice: MemorySkipNotice;
  /**
   * 在飞门禁的中止源（W4 防御收口，defensive-patterns.md:19-23 quiescence）：disposer
   * abort 之 → 组合信号（turn signal ∪ 本信号）终止 shell 执行，批次就地收口。
   * 旧实现只置 disposed 旗：门禁子进程活过卸载、结果被静默丢弃。
   */
  gateAbort: AbortController;
  /** 在飞门禁批次账本：每趟 detached 闭包登记其 settle promise，disposer abort 后
   *  await 全部收敛（Promise.allSettled 快照）才真正离场。 */
  inFlightGates: Set<Promise<void>>;
  /** shell 缺失警告只发一次（C9：无 shell 静默通过可观测，但不刷屏）。 */
  shellWarned: boolean;
  /** 插件已卸载（disposer 已跑）：新到的收口整体放弃——不读事件、不开门禁、不注入。 */
  disposed: boolean;
}

/**
 * 软依赖 shell 的唯一入口——用 ctx.get（可选服务官方读法，未注册返回 undefined）。
 *
 * **不可写成 `svc.shell`**：cordis ctx 的 Proxy get 陷阱对未列入 `inject` 的属性
 * 直接抛 `cannot get property "shell" without inject`（见 cordis reflect.ts 的
 * `ReflectService.handler.get`），于是下面的 `=== undefined` 判定永远走不到，
 * C9 静默放行分支形同虚设，且每回合结束都冒一个 turn 错误卡。
 * shell 服务由 host 组合（@deepseek-ai/dsh-shell 的 Service 构造即注册），
 * 正常环境下 get 命中；异常环境才落 C9。
 *
 * **也不加 `?? svc.shell` 兜底**：shell 真缺失时右值会重新触发同一个抛错，
 * 兜底反而把 C9 再打断。mock 需实现 get() 才有意义。
 */
function getShell(rt: GateRuntime): ShellService | undefined {
  // get 字面量重载已把 "shell" 键返回 ShellService | undefined，无需断言
  return rt.svc.get("shell");
}

/** 取本会话的解析后沙箱策略（审计 HIGH 项）。`session` 交官方 `Session` 类本身：
 *  官方 `SandboxPolicyRequest.session` 就是这个类（@deepseek-ai/dsh-sandbox-policy/lib/
 *  types/index.d.ts:52），而 `Session` 带私有字段、按名义比 —— 本包那个只服务退役中同步
 *  读面的 SessionRef 视图交不进去，编译器原话：`Type 'SessionRef' is missing the following
 *  properties from type 'Session': log, surfaceManager, surface, firstLiveSeq, and 18 more`。
 *  这里要的是 turn-stopping 载荷里那一个真实 Session，故用官方类型而不是视图。 */
function resolvePolicy(
  rt: GateRuntime,
  messages: QualityGateMessages,
  session: Session,
): PolicyResolution {
  const policy = rt.svc.get("sandboxPolicy");
  let result: PolicyResolution;
  if (policy === undefined) {
    // 没有策略服务 = 组合里是**非沙箱**的本地 executor（沙箱版必须 inject sandboxPolicy），
    // 此时不传策略才是正确的：让执行器按自己的未约束语义跑。
    result = { kind: "ok", policy: undefined };
  } else {
    try {
      result = { kind: "ok", policy: policy.resolve({ session }) };
    } catch (error) {
      // 解析失败**绝不**回落到"不传策略"：那会让 harness 用部署级策略（根 = 宿主
      // process.cwd()，且忽略本会话的 sandbox/mode 覆盖）跑门禁 → 写沙箱外被拒 →
      // exit≠0 → 假的"修这些错"注入 + 污染记忆/lesson-loop。改为 not-run。
      result = {
        kind: "unavailable",
        reason: renderTemplate(messages.policyUnresolvable, { message: messageOf(error) }),
      };
    }
  }
  return result;
}

/**
 * 会话自己的累加器（缺失即建；建完按会话预算淘汰最旧的其他会话）。
 * 条目**不随 drain 释放**：保留下来才让"本会话自己"这条账连续（下一回合复用同一实例，
 * 容量淘汰计数也不会串到别的会话上），总大小由 SESSION_BUDGET 收敛。
 */
function accumulatorOf(rt: GateRuntime, sessionId: string): EditAccumulator {
  let acc = rt.accumulators.get(sessionId);
  if (acc === undefined) {
    acc = new EditAccumulator();
    rt.accumulators.set(sessionId, acc);
    pruneToSessionBudget(rt.accumulators, sessionId);
  }
  return acc;
}

/**
 * 从事件流读本回合**成功**编辑的文件（按官方观察面给的增量窗），记进本会话的账。
 * 低危修复（authoritative 记账）：被 danger-guard 拒绝或执行失败的编辑，其 tool/call
 * 仍在事件流里——旧实现照记，会对未真正改动的文件（若落在独立项目根）多跑一次门禁。
 * 改为：tool/call 建 callId→{name,path}，tool/result 的 isError 标记失败 callId，只记成功的。
 * turn-stopping 时本回合 call+result 同处一个增量窗，单次扫描即可关联；无 callId 的事件
 * （异常/旧形状/测试 mock）保守直记，避免漏门禁。
 * fork 前缀修复（源码核对 0.1.3 后落地）：子代理会话 fork 自父会话时，
 * 事件流含父事件前缀，游标从 0 首读会把父会话的历史编辑一并计入、多跑门禁。
 * Session.inheritedEventCount（0.1.2-rc.1 起公开只读）给出 fork 切点——首读下限
 * 取切点而非 0，父前缀天然跳过；缺属性退回 0（旧行为，保守不漏门禁）。
 */
async function readEditedFiles(
  rt: GateRuntime,
  agent: TurnAgent,
  acc: EditAccumulator,
): Promise<void> {
  const { session } = agent;
  const sessionId = session.id;
  const window = await resolveEventWindow(
    rt.svc.get("sessionQuery"),
    sessionId,
    rt.lastSeqBySession,
  );
  if (window === undefined) {
    return;
  }
  // 游标按"起始 seq + 本次返回数"推进（seq 自 0 连续，见 resolveEventWindow 的切片注记）。
  rt.lastSeqBySession.set(sessionId, window.from + window.events.length);
  // 游标 Map 越界时按插入序淘汰最旧的其他会话（不整体清空 → 避免全量重读历史）。
  pruneToSessionBudget(rt.lastSeqBySession, sessionId);
  const edits = collectEdits(window.events);
  const { cwd } = session.header;
  const note = (name: string, pathValue: string | undefined): void => {
    // C5：相对路径按会话 cwd 解析（edit 常报相对路径；不按 host 进程 CWD）
    let resolvedPath = pathValue;
    if (resolvedPath !== undefined && cwd !== undefined && !path.isAbsolute(resolvedPath)) {
      resolvedPath = path.resolve(cwd, resolvedPath);
    }
    acc.note(name, resolvedPath);
  };
  for (const entry of edits.noCallId) {
    note(entry.name, entry.path);
  }
  for (const [callId, entry] of edits.pending) {
    // 被拒/失败的编辑不记账（authoritative）
    if (!edits.failed.has(callId)) {
      note(entry.name, entry.path);
    }
  }
}

/**
 * 一趟收口（turn-stopping）在起步段解析出的回合级上下文：失败处理与批次执行都要读它。
 * 逐个传参会超 `eslint/max-params` 的上限，故收成一份显式依赖；取值时机与原闭包一致
 * （`settingsOf` / `localeMessages` 各读一次，回合内不再重读）。
 */
interface TurnScope {
  rt: GateRuntime;
  agent: TurnAgent;
  /** 本回合一次读全的设置快照。 */
  cfg: ResolvedSettings;
  messages: QualityGateMessages;
  sessionId: string;
  turn: number;
  /** 会话 cwd（turn-stopping 载荷 header.cwd）：相对路径解析基准 + 记忆/总线归因。 */
  cwd: string | undefined;
  /** turn 自己的取消信号（载荷位可缺席，缺席时门禁只随 dispose abort）。 */
  signal: AbortSignal | undefined;
}

/**
 * 处理一次门禁问题（代码失败或没跑成）：上报 + 二次校验 + 配额 + 注入；返回是否停止剩余门禁。
 * **同步**：整段体（bus 上报、二次校验、配额记账、followup 注入、日志）都就地完成，没有任何
 * 该等的 await——`memoryFeedback` 那笔是刻意 detached 的补强（在下面 `void` 掉：它失败不得
 * 回滚一次已成功的注入，更不能拖住回合），把它 await 进来会改变语义。留着 `async` 只是给
 * 调用点多塞一个微任务，故按实际形状收成同步（eslint/typescript require-await 同判）。
 */
function handleGateFailure(scope: TurnScope, target: Gate, problem: GateProblem): boolean {
  const { rt, agent, cfg, messages, sessionId, turn, cwd } = scope;
  const { log, injectState, memoryNotice } = rt;
  const maxInjects = cfg.maxInjectsPerTurn;
  const isCodeFailure = problem.kind === GATE_KIND_CODE_FAILURE;
  reportProblemToBus(rt.svc.get, { sessionId, turn, cwd }, target, problem, log);
  // 触发前二次校验（H4：不再静默——被拦截时打日志，便于排查"门禁没注入"）
  const check = preInjectCheck(agent, scope.signal);
  if (!check.ok) {
    log.warn(`[quality-gate] ${sessionId}: injection skipped (${check.reason}) at turn ${turn}`);
    return true;
  }
  const st = injectState.get(sessionId) ?? { count: 0, gaveUp: false };
  // 配额耗尽：注入一次用户可见的放行说明，之后静默直到干净通过重置（F2）。
  if (st.count >= maxInjects) {
    if (!st.gaveUp) {
      st.gaveUp = true;
      injectState.set(sessionId, st);
      try {
        agent.followup(injectMessage(giveUpText(messages, target, st.count)));
        log.warn(
          `[quality-gate] ${sessionId}: giving up after ${st.count} repair attempts (gate still failing)`,
        );
      } catch (error) {
        log.error(`[quality-gate] ${sessionId}: give-up followup failed: ${messageOf(error)}`);
      }
    }
    return true;
  }
  // 失败确认 + 二次校验通过后才扣配额（与 followup 同步段内完成，无 await 间隙）
  st.count += 1;
  injectState.set(sessionId, st);
  pruneToSessionBudget(injectState, sessionId);
  try {
    agent.followup(
      injectMessage(
        isCodeFailure
          ? gateText(messages, target, problem.text)
          : notRunText(messages, target, problem.text),
      ),
    );
    log.info(
      `[quality-gate] ${sessionId}: ${isCodeFailure ? "gate failure" : "gate not-run"} injected at turn ${turn} (attempt ${st.count}/${maxInjects})`,
    );
    // memoryFeedback 移到 followup 成功之后——followup 抛错时不写记忆
    // （避免"记忆已写而注入未发生"，也避免重复失败刷记忆库）。
    // 且只写"代码失败"：没跑成的检查不是工程教训，写进去就是污染记忆环。
    if (isCodeFailure && cfg.memoryFeedback) {
      void pushFeedbackToMemory(rt.svc.get, memoryNotice, cfg, messages, {
        cwd,
        command: target.command,
        root: target.root,
        failure: problem.text,
      });
    }
    // 一次只注入一个失败（修完一个再见下一个）
    return true;
  } catch (error) {
    // followup 失败：回滚配额计数（这次注入没发生），不写记忆（M8）。
    st.count -= 1;
    injectState.set(sessionId, st);
    log.error(`[quality-gate] ${sessionId}: followup failed: ${messageOf(error)}`);
    return false;
  }
}

/** 卸载收口的读法：两次判读之间隔着 `await runGate(...)`，那期间 disposer 的 abort() 是真会
 *  发生的（W4 收口由测试钉住）；直接读 `gateAbort.signal.aborted` 会被控制流分析钉在前一次
 *  判读的 false 上（属性窄不跨 await 复位），后一处守卫就被判成恒假。经函数取值 ⇒ 每读都按
 *  声明的 boolean 算，守卫才是必要的。 */
function gateAborted(rt: GateRuntime): boolean {
  return rt.gateAbort.signal.aborted;
}

/** 一趟门禁批次的输入：handleTurnGate 探测完门禁、解析完策略、归一完信号后交下来的全部依赖。 */
interface GateBatchInput {
  scope: TurnScope;
  gates: readonly Gate[];
  shell: ShellService;
  resolved: PolicyResolution;
  /** 批次执行信号：turn signal（回合取消同命，C6）∪ dispose abort（卸载收口，W4）的归一结果。 */
  signal: AbortSignal;
  /** 门禁总时长预算（Config 的 `gateBudgetMs`，本回合读定的值）。 */
  budget: number;
}

/** 批次起步后的派生与可变状态：`perGate`/`started` 在进入异步段时算定，`batch` 见其注释。 */
interface GateBatchState extends GateBatchInput {
  perGate: number;
  started: number;
  batch: { blocked: boolean };
}

/**
 * 顺序执行门禁（决策是顺序依赖的：预算封顶 + 每次只注入一个失败），
 * 用尾递归推进代替 for+await（规避 no-await-in-loop，语义不变）。
 */
async function processGate(state: GateBatchState, left: readonly Gate[]): Promise<void> {
  const { scope, shell, resolved, signal, budget, perGate, started, batch } = state;
  const { rt } = scope;
  const [gate] = left;
  if (gate === undefined) {
    return;
  }
  // 卸载收口（disposer 已 abort）：不再开新门——在飞那门由组合信号终止。
  if (gateAborted(rt)) {
    return;
  }
  const remaining = budget - (Date.now() - started);
  if (remaining < MIN_USEFUL_GATE_MS) {
    batch.blocked = true;
    handleGateFailure(scope, gate, { kind: "not-run", text: skippedText(scope.messages, left) });
    return;
  }
  // 沙箱策略解析不出来 → 一门都不执行（not-run），绝不回落到部署级策略。
  const outcome: GateOutcome =
    resolved.kind === "unavailable"
      ? { kind: "not-run", text: resolved.reason }
      : await runGate(scope.messages, shell, gate, Math.min(perGate, remaining), {
          policy: resolved.policy,
          signal,
          stdoutMaxBytes: rt.stdoutMaxBytes,
          log: rt.log,
        });
  // 卸载收口：abort 后迟到的门禁结果一律就地丢弃——不上报 lesson-loop（被中止的
  // 检查既不是代码失败事实也不是"请手动跑"素材）、不注入。旧实现这里继续处理，
  // 结果被 disposed 旗在注入前拦下，而门禁进程仍活过卸载（quiescence 缺陷）。
  if (gateAborted(rt)) {
    return;
  }
  if (outcome.kind === "pass") {
    await processGate(state, left.slice(1));
    return;
  }
  batch.blocked = true;
  const mustStop = handleGateFailure(scope, gate, outcome);
  if (!mustStop) {
    await processGate(state, left.slice(1));
  }
}

/**
 * 一趟门禁批次：C4 按总预算封顶（perGate 保底 10s 会超支）——跟踪已花时间，每门
 * min(perGate, remaining)。尾段不足最小可用预算（真实 tsc/pnpm 冷启动也要数秒，几百 ms
 * 必超时 → 假"超时失败"注入）时**注入未执行说明**——旧实现只 console.warn，那等于静默
 * 通过（审计 MEDIUM 项）。
 *
 * W4 防御收口：①整段顶层 try/catch——批次自身故障只记一条 error，绝不产生
 * unhandledRejection；②批次 promise 由调用方登记进在飞账本，disposer abort 后 await 收敛
 * （defensive-patterns.md:19-23：dispose 必须终止并等待在飞工作）。
 */
async function runGateBatch(input: GateBatchInput): Promise<void> {
  const { scope } = input;
  const { rt, sessionId } = scope;
  try {
    const perGate = Math.max(10_000, Math.floor(input.budget / input.gates.length));
    // C4 的计时基准：每门可用预算 = min(perGate, budget - 已花)。
    const started = Date.now();
    /** 是否有门禁未给出"通过"结论（code-failure 与 not-run 都算；只有全 pass 才重置配额）。
     *  放进可变持有对象而不是 `let`：赋值全在 `processGate` 里，控制流分析看不见那两次
     *  写，批次结束后的读点会被钉在初值 false 上、`!batch.blocked` 就被判成恒真——而「有门没给出
     *  通过结论」是真会发生的（配额重置与否由它决定）。属性读保留声明的 boolean，守卫才是真的。 */
    const batch: { blocked: boolean } = { blocked: false };
    await processGate({ ...input, perGate, started, batch }, input.gates);
    // 所有门禁都真的跑完并通过 → 重置会话配额：模型已修好，下一轮重新计数（F2）。
    // 有任何"没跑成"都不重置：那不等于代码健康。
    if (!batch.blocked) {
      rt.injectState.delete(sessionId);
    }
  } catch (error) {
    // 批次兜底：门禁调度自身异常（如宿主面在飞期间行为突变）不得外溢——
    // 旧实现这一层没有 catch，rejection 会直奔 unhandledRejection。
    rt.log.error(`[quality-gate] ${sessionId}: gate batch failed: ${messageOf(error)}`);
  }
}

/**
 * 一次回合收口（原 turn-stopping 监听器里的匿名 `run`）：守卫 → 记账 → 探测门禁 →
 * detached 跑批次。整段仍是同一条同步/异步切分——门禁执行 detached（不拖回合收尾），
 * 事件读那一次 await 留在回合内（`@mode serial` 派发下与原形状等价）。
 */
async function handleTurnGate(rt: GateRuntime, payload: TurnStoppingPayload): Promise<void> {
  const { agent } = payload;
  // 载荷边界守卫：agent 由宿主恒带，缺失属异常载荷（宁可漏一次门禁也不带半截状态记账）。
  if (agent === undefined) {
    return;
  }
  // 插件已卸载（disposer 已跑）：收口整体放弃——旧实现还会读事件、跑门禁，只在
  // 注入前被 disposed 旗拦下；W4 起 abort + 就地收口，这里连起步都免了。
  if (rt.disposed) {
    return;
  }
  const cfg = settingsOf(rt.config);
  if (!cfg.enabled) {
    return;
  }
  // 子代理会话跳过门禁（根会话判定；见 isRootSession 注释的根因与边界）。
  if (!isRootSession(agent)) {
    return;
  }
  // 本回合的注入文案语言（官方 locale 偏好，按回合读一次 → 改语言下一回合即生效，不重启）。
  const messages = rt.messages();
  const { session } = agent;
  const { id: sessionId } = session;
  /** 会话 cwd（turn-stopping 载荷 header.cwd）：相对路径解析基准 + 记忆/总线归因。 */
  const { cwd } = session.header;
  // turn-stopping 时 agent.status 恒为 'running'（官方在 running 相内 serial
  // 分发 turn-stopping，转 idle 发生在回合结束之后）。旧 `status !== 'idle' → return`
  // 使门禁在生产永不执行（测试 mock status:'idle' 掩盖了此 bug）。只用数据信号判定：
  // inbox 有待处理（用户已排队工作）→ 不跑门禁（不抢话），顺带淘汰旧会话配额。
  if (inboxHasPending(agent.inbox)) {
    pruneToSessionBudget(rt.injectState, sessionId);
    return;
  }
  // turn 缺失/非数字直接返回（官方 dispatch 恒带 turn）：它是上报与日志的归因字段，
  // 不允许带着 undefined 去记账。
  if (typeof payload.turn !== "number") {
    return;
  }
  const { turn } = payload;
  // 无 shell 时 warn 一次（整个门禁面失活，属部署事实；局部 flag 防刷屏）。
  // 必须走 getShell()：svc.shell 在 shell 未列入 inject 时是抛错而非 undefined。
  const shell = getShell(rt);
  if (shell === undefined) {
    if (!rt.shellWarned) {
      rt.shellWarned = true;
      rt.log.warn("[quality-gate] shell service unavailable; gates skipped (pass-through)");
    }
    return;
  }

  // 记账本回合编辑文件（事件流经官方观察面读 tool/call + tool/result）；账按会话分，
  // drain 只取自己那份。这一读是 async，而本监听器按官方 `@mode serial` 串行分发——
  // 在监听器内 await 它，等价于迁移前"读窗 + drain 处在同步段"的互斥性（同一会话
  // 一次只有一趟在读游标）；下面的门禁执行照旧 detached，不拖回合收尾。
  const acc = accumulatorOf(rt, sessionId);
  await readEditedFiles(rt, agent, acc);
  const dropped = acc.droppedCount();
  const files = acc.drain();
  // C10：500-cap 淘汰可观测（drain 已清零计数，先读后排）
  if (dropped > 0) {
    rt.log.warn(
      `[quality-gate] ${sessionId}: ${dropped} edited file(s) evicted from accumulator cap; gate may miss their roots`,
    );
  }
  if (files.length === 0) {
    return;
  }

  const { gateBudgetMs: budget } = cfg;

  // 归并项目根并探测门禁（无门禁面直接返回，不碰配额）
  const gates = detectGate(projectRootsOf(files, rt.maxRootDepth, rt.log));
  if (gates.length === 0) {
    return;
  }
  // 沙箱策略在**同步段**按会话解析一次（异步段不再触碰 agent.session）。
  const resolved = resolvePolicy(rt, messages, session);

  // 门禁批次的执行信号 = turn signal（回合取消同命，C6）∪ dispose abort（卸载收口，
  // W4）。AbortSignal.any 不收 undefined（Node 26 实测抛 TypeError），两态先归一——
  // 由此 runGate 的 signal 恒有值。
  const gateSignal =
    payload.signal === undefined
      ? rt.gateAbort.signal
      : AbortSignal.any([payload.signal, rt.gateAbort.signal]);

  const scope: TurnScope = {
    rt,
    agent,
    cfg,
    messages,
    sessionId,
    turn,
    cwd,
    signal: payload.signal,
  };

  // 异步执行门禁（shell.execute 是 Promise；turn-stopping 串行事件里不能阻塞太久）。
  // 配额按 sessionId 跨回合累计——门禁通过则重置，达上限注入一次"放行说明"后静默，
  // 直到出现一次干净通过。这样"失败→注入→新回合又失败"的环被 maxInjects 真正约束。
  const flight = runGateBatch({ scope, gates, shell, resolved, signal: gateSignal, budget });
  rt.inFlightGates.add(flight);
  // settle 后自动离账：disposer 的 await 快照因此总是"还没收敛的全部批次"。
  // await 形态而非 `.finally()`（promise/prefer-await-to-then）：runGateBatch 的整段体已在
  // 自己的 try/catch 里（批次兜底，永不 reject），故 settle 后直接删项与 .finally 等价；
  // 继续 detached（不 await 这个跟踪任务，回合不被离账拖住）与原语义一致。
  void (async (): Promise<void> => {
    await flight;
    rt.inFlightGates.delete(flight);
  })();
}

export function apply(ctx: Context, config: ConfigShape): void {
  if (!isGateHost(ctx)) {
    // 兜底日志：此时 logger 面是否存在未知，直接 console（fail-closed 路径只此一条）。
    console.error(
      "[quality-gate] ctx is missing the settings.describe/configure + inject/fiber surface; gate not armed",
    );
    return;
  }
  const svc = ctx;

  // 具名 logger（官方 ctx.logger(name)，cordis-api/context.md:131-138）；宿主未装
  // （异常 ctx/测试桩件）回退 console——回退是兼容路径，测试两条都覆盖。
  // ⚠ 这一位从显式「可缺席」的视图上读，而不是直接 `svc.logger`：`svc` 被 `isGateHost` 窄成
  // `Context & HostCtx`，官方 `Context.logger` 是必填（@deepseek-ai/cordis/lib/types/context.d.ts:27），
  // 交集时 `A & (A | undefined)` 折叠成 `A`——本地 `HostCtx.logger?:` 的可缺席声明被官方那一位
  // 抹平，缺席在类型面上变成不可能（运行时却是真的）。apply 的形参位由官方 Plugin 契约钉死、
  // 交不进更宽的类型，故在唯一的读点上把这一位按运行时形状收回可空，`?.`/`??` 才是必要的守卫。
  const loggerSlot: { readonly logger?: (name: string) => Log } = svc;
  const log: Log = loggerSlot.logger?.("quality-gate") ?? console;

  // 非 volatile 部署值（W4）：普通值形态（不经 .get()），装载期读一次，cordis.yml 行 config 可改。
  const { maxRootDepth, gateStdoutMaxBytes: stdoutMaxBytes } = config;

  // 0.1.7 起命名空间是**隐式**的：宿主把本条目导出的 Config 里标了 `.volatile()` 的字段
  // 投影成设置表单，ns = profile 条目 id（`quality-gate`，见 cordis.patch.yml），行 config
  // 由同一份 schema 校验并填默认后交进 apply —— 插件侧不再有 register，也没有第二层底座。
  // 只剩页面策略要声明：本包自带卡片，别让宿主再生成一份自动表单页。owner 必须显式传
  // 本插件 fiber（缺省是 settings 服务自己的 fiber，传错等于给别人的页面定策略），且经
  // child.effect 挂载以便随注入子上下文回收——宿主 dsh-client-locale 同款写法。
  svc.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, svc.fiber));
  });

  // 注入文案的语言随官方 locale 偏好走：用户在「设置 → 常规」改语言后，下一次回合收口
  // 就是新文案（不重启、不加插件自己的 locale 设置项）。
  // 跨命名空间读在 0.1.7 只有 describe() 一条路：挑出 ns === 'locale' 那条的 value
  // （未装 client-locale / 该条目没有 volatile 字段 → 宿主不投影它 → undefined → 中文默认）。
  const localeMessages = (): QualityGateMessages =>
    messagesFor(
      MESSAGES,
      resolveLocalePreference(
        svc.settings.describe().find((row) => row.ns === LOCALE_SETTINGS_NAMESPACE)?.value,
      ),
    );

  // 设置卡改完下一个回合即生效：每次收口都重新 `.get()` 一遍引用的当前值（见 settingsOf）。
  // 会话级账本（累加器/配额/事件游标）、记忆降级旗与在飞门禁的中止源都在 rt 上，
  // 逐个字段的原注释见 GateRuntime 声明。
  const rt: GateRuntime = {
    svc,
    config,
    log,
    maxRootDepth,
    stdoutMaxBytes,
    messages: localeMessages,
    accumulators: new Map<string, EditAccumulator>(),
    injectState: new Map<string, InjectState>(),
    lastSeqBySession: new Map<string, number>(),
    memoryNotice: { warned: false, log },
    gateAbort: new AbortController(),
    inFlightGates: new Set<Promise<void>>(),
    shellWarned: false,
    disposed: false,
  };

  svc.on("agent/turn-stopping", async (payload) => {
    // 门禁是增强能力，绝不能因自身异常杀死整轮对话：turn-stopping 走
    // dispatch.serial 派发（agent-loop/src/agent.ts:317），监听器抛错会被
    // agent-loop 折叠成 turn/end kind:error code=UNKNOWN（用户看到「本轮运行失败」）。
    // 整段包 try/catch：门禁自身故障只记日志并显式说明，与 runGate 的
    // "没跑成不得算通过" 同一原则。
    try {
      // `await handleTurnGate(...)`：本包的事件读现在经官方观察面（异步），而这段 try/catch 是
      // "门禁自身异常不得杀死回合"的兜底——不 await 的话读面 rejection 会绕过它变成
      // 游离 Promise（no-floating-promises 之外，更是把兜底逻辑作废）。监听器已按官方
      // `Promise<void> | void` 的签名改成 async（installed dsh-agent/lib/types/
      // runtime-types.d.ts:387-391），且 turn-stopping 是 `@mode serial` 派发：await 的
      // 只有那一次本地日志读，门禁本体仍在下面 detached，不拖回合收尾。
      await handleTurnGate(rt, payload);
    } catch (error) {
      // 兜底：门禁自身异常（事件读取/路径探测/门禁调度）不得杀死回合。
      rt.log.error(
        `[quality-gate] turn-stopping handler failed (gate skipped): ${messageOf(error)}`,
      );
    }
  });

  // 卸载即收口（defensive-patterns.md:19-23 dispose quiescence）：先置旗（新到收口整体
  // 放弃），再 abort 在飞门禁（shell 执行随组合信号终止、迟到结果就地丢弃），最后 await
  // 全部批次闭包收敛才真正离场——旧实现只置 disposed 旗，门禁子进程活过卸载、结果被静默
  // 丢弃。返回 Promise 合法：cordis 的 disposer 允许 async（"they may be async, in which
  // case unloading awaits them"，installed @deepseek-ai/cordis/lib/types/fiber.d.ts:36-38）。
  // 会话级记账（配额/游标/累加器）随之废弃，不留跨代残留。
  svc.effect(() => () => {
    rt.disposed = true;
    rt.gateAbort.abort();
    rt.injectState.clear();
    rt.lastSeqBySession.clear();
    rt.accumulators.clear();
    // allSettled 对 iterable 同步取快照（账本只在异步 finally 里删项，迭代期不会变）。
    return Promise.allSettled(rt.inFlightGates);
  });
}

export default {
  inject: ["settings"],
  Config,
  apply,
};
