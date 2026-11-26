// quality-gate 的 host 侧：回合结束时的质量门禁（ECC stop-format-typecheck 移植）。
//
// 机制（已在 dsh 宿主源码核实）：
//   - tool/result 事件里记下本回合编辑过的代码/配置文件（EditAccumulator，O(1)）；
//   - agent/turn-stopping 事件触发批处理：宿主在 turn-stopping 之后仍会检查
//     inbox.nextStep ——门禁失败时经 followup 注入修复指令就会开新一轮
//     （followup opens NEW turn）。
//
// 门禁完整性总纲：**一次没有真正跑完的检查，绝不能
// 被记为"通过"**。所有出口都是显式三态（GateOutcome）：
//   - pass        ：门禁真的跑了且 exit 0；
//   - code-failure：门禁跑了且报了代码错误 → 注入"修这些错"（进记忆/lesson-loop）；
//   - not-run     ：门禁没跑成（沙箱策略拒绝/runner 不可用/沙箱整体不可用/准备期抛错/
//                   超时/取消/工具装不上/预算不足被跳过）→ 注入"请手动跑一次"，
//                   且**不**写记忆、**不**以 gate-failure 进 lesson-loop。
//   最容易混过去的两类情况各有对应的硬性出口：由 catch 接住的情况与时间用完时不许报 PASS，沙箱
//   拒绝不许当代码错误注入（那会把环境或策略问题当成代码缺陷写进记忆、也报给 lesson-loop）。
//
// 会话边界：
//   - 回合结束时只对根会话做门禁（isRootSession：delegationDepth>0 / origin==='subagent' 跳过）。
//     子代理在回合结束时，宿主侧没有完整的项目上下文，注入 followup 会进到子代理里（结算时序不可控），
//     而且会和父会话的门禁对同一个项目根重复执行。
//   - out-of-process 子代理（ACP/claude-code/codex）在独立进程运行、不发射 dsh 事件，
//     它们的编辑天然不在门禁范围内（这是 dsh 的机制边界，不是本插件的缺陷）。
//   - plan mode 下 turn-stopping 照常触发：如果规划回合修改了代码文件，回合结束时同样门禁
//     （语义正确——plan 模式不豁免代码健康），不按模式特判。
//   - 编辑记录按 sessionId 分会话累积（每个会话一个 EditAccumulator）：共用一个累加器会让
//     某个会话 drain 时拿走另一个会话待复查的编辑，而后者的事件游标已经前进 → 那批编辑
//     永远不会再复查（少跑一次门禁也不报错），失败配额和容量淘汰计数也会记到错误的会话上。
//
// 防止无休止循环（复用 session-rescue 验证过的配额做法）：
//   - 每个会话最多注入 N 次修复指令（默认 2）：配额按 sessionId 跨回合累计、所有项目根共用一份，
//     全部门禁都干净通过之后才重置；循环修不好就放行并提示用户；
//   - 所有门禁的总时长设上限（默认 300s），超时或预算用完一律按 not-run 注入说明。
//
// 本文件只以 host.js 形态被宿主载入（入口清单由 test/publish-manifest.test.ts 钉住）。
// 一处例外：@deepseek-ai/dsh-credentials 的 `credentialRef` / `isCredentialRefName` 是值导入，
// 因此必须进 peerDependencies（见下面 import 段的理由）。其余 @deepseek-ai/* 一律 type-only。

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
// 0.1.7 的设置界面要求宿主 fork 的那个 schemastery：`Schema.prototype.volatile` 只在
// @deepseek-ai/schemastery 这一枚里存在（installed @deepseek-ai/schemastery/src/index.ts:480-482），
// 公共的 schemastery 既没有 .volatile()、解析出来的也仍是普通值。
import Schema from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { markRemote } from "@jayyuen66/dsh-plugin-shared/lib/remote-marker";
import type { Context, Events, Fiber, Volatile } from "@deepseek-ai/cordis";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
// shell 执行的类型绑官方声明（devDependency @deepseek-ai/dsh-shell，与运行的宿主同版本）。
// 服务类是 `export declare abstract class ShellExecutor extends Service`
// （@deepseek-ai/dsh-shell/lib/types/index.d.ts:47）：cordis 的
// `abstract class Service` 带 `protected ctx: Context`（@deepseek-ai/cordis/lib/types/
// service.d.ts:9-10），TS 对带 protected/private 成员的类按**名义**比较 → 结构替身永远
// 满足不了整个类，所以服务成员只取 `Pick<ShellExecutor, "resolve" | "execute">`。
// 被 Pick 的那两个方法的入参与返回
// （ShellExecRequest / ShellExecSpec / ShellExecution / ShellRunResult / ShellSandboxInfo /
// CollectedOutput，官方出口 lib/types/index.d.ts:11）就此由官方给出，本包不再照抄一个字段。
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecutor,
  ShellRunResult,
  ShellSandboxInfo,
} from "@deepseek-ai/dsh-shell";
// sandboxPolicy / session / agent 这三处同样绑官方声明（三个 devDependency 与运行的宿主同版本）：
// 三个服务/实体类都带私有成员，或者官方类型里包含的内容远多于本包要用的，所以一律
// `Pick<官方类, "成员">` 只取要用的成员（载荷与返回由被 Pick 的成员给出，见下面各自的注释），
// 仍然是 type-only。
import type { SandboxPolicyService as HostSandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
// 值导入：`isCredentialRefName` 和 `credentialRef` 是凭据包自己交出的**官方**校验函数与
// 带类型品牌的构造函数（installed @deepseek-ai/dsh-credentials/lib/index.js:13 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`、
// :21 / :34）。自己抄一条正则当 ref 的语法（见下面 resolveFeedbackTarget 前那条判断的位置）就多
// 一处会跟着宿主变化的判据，所以不抄。两个函数都只处理字符串，而官方的类型品牌没有
// "只用类型"的写法 ⇒ dsh-credentials 落在 peerDependencies：build-host.mjs 的外部化范围是
// dependencies ∪ peerDependencies，产物因此留
// `from "@deepseek-ai/dsh-credentials"` 裸说明符；只放 devDependencies 会被 rolldown 把函数体
// 内联进 host.js（等于本包自己另存一份官方实现）。这两件事由 `test/build-host.test.ts`
// 成对钉住：说明符在，四枚官方构造器的函数体都不在。
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import type { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import type { Session, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
// 读事件流的官方接口（`Context.sessionQuery`，installed @deepseek-ai/dsh-session-query/
// lib/types/index.d.ts:23-27）：type-only，运行时由 ctx 注入。见下面 SessionQueryFace。
import type { SessionObservation } from "@deepseek-ai/dsh-session-query";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { WorkingDirectoryService } from "@deepseek-ai/dsh-working-directory";
import { EDIT_TOOLS, EditAccumulator } from "./lib/accumulator.ts";
import { detectGate } from "./lib/gate-detect.ts";
import type { Gate, ProjectRoot } from "./lib/gate-detect.ts";
import { appendResultRow, RESULT_DETAIL_MAX, trimSessionResults } from "./lib/gate-results.ts";
import type { GateResultRow } from "./lib/gate-results.ts";
import { releaseGateRoot } from "./lib/gate-roots.ts";
import { repoRelativeDiagnostics } from "./lib/repo-diagnostics.ts";
import { PKG_MANIFEST } from "./lib/project-manifests.ts";
import { findManifestRoot, probeProjectRoot, workspaceRootUpgrade } from "./lib/project-probe.ts";
import { messageOf } from "./lib/errors.ts";
import { MESSAGES, renderTemplate } from "./lib/messages.ts";
import type { QualityGateMessages } from "./lib/messages.ts";
// host 侧文案语言跟官方 locale 插件的偏好同源：读它拥有的 settings 命名空间（没注册时用中文）。
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { pushGateFeedback } from "./lib/gateway-feedback.ts";
import { isCredentialSafeUrl, resolveGatewayUrl, resolveServiceId } from "./lib/gateway-target.ts";
import type { GatewayTarget } from "./lib/gateway-target.ts";
import type { GateFeedbackInput } from "./lib/feedback-content.ts";
// 共享的编辑记录骨架：事件流 → tool/call 与 tool/result 两张表 + 编辑路径提取，与 danger-guard
// 的证据链共用同一实现。事件类型也取自同一处（SessionEvent）——本包不再自备一份最小的
// 声明，避免同一个契约写两处、各改各的。
import {
  scanToolEvents,
  editPathOf as sharedEditPathOf,
  editPathsOf as sharedEditPathsOf,
} from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import type { SessionEvent, ToolCallRecord } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
// 编辑语义（成功/被拒绝/已派发中止/普通失败）只有一处实现：投影与回合扫描共用。
import {
  countsAsEdit,
  editLedgerProjection,
  editOutcomeOf,
  type EditLedgerEntry,
  type EditLedgerState,
  type EditOutcome,
} from "./lib/edit-ledger.ts";
// lesson bus 的失败处理：lesson-loop 的 report 是异步写库的（返回 Promise），只包一层同步
// try/catch 抓不到 rejection——失败既没有任何记录，又给宿主进程留下一个未处理的拒绝。
// 同步抛错和异步拒绝共用这一个返回点（三个包调用它时的失败处理做法一致）。
import { settleLessonCall } from "@jayyuen66/dsh-plugin-shared/lib/lesson-bus";
import { claimInstance } from "@jayyuen66/dsh-plugin-shared/lib/instance-lock";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { mountEditLedgerReader } from "./lib/edit-ledger-reader.ts";
import type { EditLedgerReader, ProjectionsRegistry } from "./lib/edit-ledger-reader.ts";

/**
 * 常见的项目根标记文件：向上找最近的、含清单文件的目录。
 * ruff.toml 必须在这一列：只有 ruff 配置、没有 pyproject.toml 的 Python 工程如果不在这儿
 * 登记，gate-detect 里的 has("ruff.toml") 就永远不会被走到——那类工程根本找不到项目根，
 * 也就永远不会有对应的门禁。
 */

/**
 * 记录编辑时要用的事件读取接口 = 官方 `SessionQueryEngine`（installed
 * @deepseek-ai/dsh-session-query/lib/types/index.d.ts:35 起，cordis `Service` 子类 + private
 * 字段 → 名义比较，整个类拿不出结构等价物）里的 `observeSession` 这一个方法（:47）。
 *
 * 它替代的是 `Session.snapshotEvents()` 这一类同步读：官方把 `snapshotEvents`、`eventAt`
 * 和 `ownEvents` 三个方法一起标了 `@deprecated`（"new calls are prohibited"，installed
 * dsh-session 的类型声明里那三个废弃标记，指向 Agent Note
 * "Deprecate synchronous session event reads"）。增量读取官方给的就是 `observeSession`——它按
 * sessionId 精确读：lib/types/observation.d.ts 的 SessionObservation 返回一个不可变切片，
 * `events: readonly SessionEvent[]` 和 `inheritedEventCount: SessionLogOffset`
 * 一次给全，记录编辑要用的这两样都不必再从 session 对象上找。
 *
 * ⚠ 替代接口是**异步**的。本包的读取点在 `agent/turn-stopping`（官方 `@mode serial`，installed
 * @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts 的 AgentEvents 声明）的监听器里，迁移后那一次读要在
 * 监听器里 `await`——靠的就是 serial 分发保证"同一个会话的读窗一次只跑一趟"，和迁移前的同步段
 * 等价；门禁的执行仍然照旧 detached（迁移前那一段本来就是并发的）。
 * 原来的 `SessionRef` 视图（为那个已退役的读取接口准备的 `Partial<Pick<Session, "inheritedEventCount"
 * | "snapshotEvents">>`）不再需要；`header` 和 `id` 两位仍由 `TurnAgent.session` 上的官方
 * `Session` 直接给出，不需要视图。
 *
 * ⚠ 这个方法**不**写成 `Pick<SessionQueryEngine, "observeSession">`：官方的返回类型
 * `SessionObservation` 把 `inheritedEventCount` 声明成必填（observation.d.ts:13），而同一个官方包里
 * 放着同一个字段的另一处（@deepseek-ai/dsh-session/lib/types/types.d.ts:109）是**可选**的，
 * cold/prepared 的观察实测也会返回 undefined（resolveEventWindow 里 `?? 0` 那条回退分支由测试
 * 证明真的会走到）。必填的字段去不掉，读取点上的回退就会被 typescript(no-unnecessary-condition)
 * 判成多余的守卫，所以按官方签名重写这个方法、把返回类型换成下面的 `SessionObservationFace`；
 * 运行时那一次读仍然由宿主注入的官方实现完成。
 */
/** 官方返回结果在本包里用到的那部分：`events` 直接取官方那个字段，`inheritedEventCount` 按
 *  运行时的实际形状改成可以为空（官方类型和运行结果不一致，见上面的说明）。`Disposable` 也一起收下：官方
 *  `SessionObservation extends Disposable`，冷读返回的是 prepared lease，它按引用计数固定住
 *  上游缓存条目，refs 归零之后才允许被容量驱逐。窄接口不收这个字段，就等于认定"上游不需要释放"——
 *  漏释放就是这么来的。 */
type SessionObservationFace = Pick<
  SessionObservation,
  "events" | "header" | "cursor" | "projections" | keyof Disposable
> & {
  readonly inheritedEventCount: SessionLogOffset | undefined;
};

/** `options` 在本地接口上是**必填**的：官方的默认值是 `projectionMode: "all"`
 *  （installed @deepseek-ai/dsh-session-query/lib/index.js 的 `projectionMode = "all"`），
 *  那会让宿主为整份日志把所有投影都算一遍 snapshot，而本包只读 events 和 inheritedEventCount。
 *  写成必填，是为了不给"少传一次就白算一遍"留下可用的默认值。
 *
 *  子代理台账读取需要 `projectionMode: "all"`：`workingDirectory` 是带 `wire` 的投影，
 *  而根会话事件窗不需要任何投影。两种读取点必须显式给出自己的选择。 */
interface SessionQueryFace {
  observeSession: (
    sessionId: SessionId,
    options: { readonly projectionMode: "none" | "all"; readonly signal?: AbortSignal },
  ) => Promise<SessionObservationFace>;
}

/** 本插件 followup 注入消息的 producer-owned source.kind（和 session-rescue 的
 *  RESCUE_SOURCE_KIND 是同一种写法）。0.1.7 的 V4 准入不再接受已经废弃的包装形式
 *  `{ kind: 'plugin', plugin }`（session-format-v3-to-v4/src/message-sources.ts
 *  对每个声明的持久消息位抛 "format v4 message requires a producer-owned source
 *  kind"，followup 经 inbox 落到 `agent/inbox/spliced`，正是被拒的那类持久位）；
 *  迁移表把不认识的插件名统一加上 `plugin:` 前缀（sources.ts producerKind），所以本插件
 *  已经迁移过的历史行读回来也是同一个串——发出去的是同一个串，新行和历史行才是同一个来源。 */
const GATE_SOURCE_KIND = "plugin:quality-gate";

/** followup 注入的消息形状（harness UserMessage 里本插件实际用到的那部分）。
 *  source 只有 producer-owned kind，不再有 `plugin` 这个身份字段；本包不会把它读回来
 *  （注入是单向的，配额由 injectState 记录），改 kind 只需要同步上面那个常量。 */
interface FollowupMessage {
  id: string;
  role: "user";
  content: { type: "text"; text: string }[];
  source: { kind: typeof GATE_SOURCE_KIND };
}

/** turn-stopping 载荷里 agent 的那部分 = 官方 `Agent` 里本包要用的那几个成员 + 本包的注入写入路径。
 *  `Agent` 是 **interface**（@deepseek-ai/dsh-agent/lib/types/types.d.ts:11 只声明 `id`，
 *  lib/types/runtime-types.d.ts:138-192 以 `declare module './types.ts'` 官方增强补上
 *  session :143 / inbox :145 / status :147 / ctx 与 cancel/send/followup/steer/…），
 *  没有私有字段，但整个接口远多于本包需要的，所以仍然用 `Pick` 只取三个：
 *   - `session` 到这里就是官方 `Session` 类（`SandboxPolicyRequest.session` 要的正是**它**，
 *     不是上面那个 SessionRef 视图）；
 *   - `inbox` 是本包的 `InboxQueues` 视图（官方 `Inbox` 在 runtime-types.d.ts:41-45 把
 *     `nextTurn` :43 和 `nextStep` :45 都写成**必填**的 `readonly UserMessage[]`，不进
 *     Pick 的理由见下面 InboxQueues 的说明）；
 *   - `status` 是官方 `AgentStatus`。本包**不**用它判断 idle：turn-stopping 在 running 阶段内
 *     serial 分发，转到 idle 发生在回合结束之后（旧的 `status !== 'idle' → return` 会让门禁
 *     永远不执行）。
 *  `followup` 唯独不进 Pick：官方是 `followup(message: UserMessage): void`
 *  （runtime-types.d.ts:192），而官方 `UserMessage`（@deepseek-ai/dsh-llm/lib/types/
 *  message.d.ts:144）的共享 MessageBase :124 要求 `id: MessageId` :126——那是**字符串**上的 phantom
 *  brand（lib/types/brand.d.ts:14）——还要求 `source: MessageSource` :132（:122 =
 *  `MessageSourceMap` 的值联合，联合里**没有** `plugin:quality-gate` 这个 kind：各 producer
 *  用自己的 `declare module` 增扩，官方示例见 @deepseek-ai/dsh-agent/lib/types/
 *  model-selection.d.ts:8-12）。编译器原话：`Argument of type 'FollowupMessage' is not
 *  assignable to parameter of type 'UserMessage'. Types of property 'id' are incompatible.
 *  Type 'string' is not assignable to type 'MessageId'`。要满足它就得值导入 brand 的构造器，并且替
 *  宿主声明一个官方联合里没有的 producer kind（宿主侧的 V4 准入走的是迁移表合成
 *  `plugin:<name>`，见上面 GATE_SOURCE_KIND 的说明），这两件都不是本包该做的决定 → 注入用的接口按本包
 *  producer-owned 的形状交出去（见 FollowupMessage）。 */
/** 官方 `Inbox` 的两个待办队列，在本包里用到的那部分。
 *  官方的声明（@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:43,45）把两位都写成必填的
 *  `readonly UserMessage[]`——那是宿主对**自己**的保证，不是一份递过来的 inbox 的实测
 *  形状：测试假对象和有问题的宿主真的会只给一个队列（test/host-integrity.test.ts 就把整个 inbox 换成
 *  `{ nextTurn }`），于是 `inboxHasPending` 在运行时读到过 undefined。声明和运行结果不一致 ⇒ 两位
 *  显式改成可选，读取点上的 `?.length ?? 0` 才是必要的守卫，而不是被判成多余。 */
interface InboxQueues {
  readonly nextTurn?: readonly unknown[];
  readonly nextStep?: readonly unknown[];
}

type TurnAgent = Pick<Agent, "session" | "status"> & {
  /** 官方 Agent 的插件上下文：只用来读 `workingDirectory` 服务（替身可以缺席）。 */
  ctx?: Agent["ctx"];
  inbox: InboxQueues;
  followup: (message: FollowupMessage) => void;
};

/** turn-stopping 载荷 = 官方 cordis `Events`（@deepseek-ai/cordis/lib/types/events.d.ts:216）
 *  里 `agent/turn-stopping` 条目的 payload
 *  （@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:387-391 以 `declare module
 *  '@deepseek-ai/cordis'` 官方增强登记，`@mode serial`），
 *  三个字段官方**全部必填**：`{ agent: Agent; turn: number; signal: AbortSignal }`。
 *  本包按"跨进程边界送来的宿主数据都可能缺失"来读，所以只把官方 payload 整体 `Partial` 化、
 *  并把 `agent` 换成本包的 `TurnAgent`（用 Pick 只取要用的成员，见上）——字段一个都不重写，
 *  官方加、删字段或换类型会立刻反映到这里。
 *  agent 和 turn 由宿主总是带上；缺失属于异常载荷，见守卫处的注释。 */
type TurnStoppingPayload = Partial<Omit<Parameters<Events["agent/turn-stopping"]>[0], "agent">> & {
  agent?: TurnAgent;
};

/** 一次能力调用的完整文件效应策略（harness `SandboxExecutionPolicy`）**不再本地声明**：
 *  本包要持有的就是"shell 请求里那个 sandboxPolicy 字段"，它的类型由官方成员给出——
 *  `ShellExecRequest["sandboxPolicy"]` 的取值范围就是 `SandboxExecutionPolicy`
 *  （@deepseek-ai/dsh-shell/lib/types/types.d.ts:9 引入、:97 声明），
 *  `SandboxPolicyService.resolve` 返回的也是同一个类型
 *  （@deepseek-ai/dsh-sandbox-policy/lib/types/index.d.ts:88）。dsh-sandbox 不是本包依赖，
 *  所以经官方成员取类型，而不是再抄一遍字段。以前的本地声明把 `sessionId` 抄成 `string`，官方那是带 `brand` 标记的
 *  `SessionId`（@deepseek-ai/dsh-sandbox/lib/types/index.d.ts:27-40，字段 `sessionId?: SessionId`
 *  在 :39）：本包只是整体传过去所以没出问题，但抄窄本身就是一次不一致。
 *  同样不再本地声明的还有 `SandboxMode`（官方 :19 三值联合，与本包旧抄一致）和
 *  `SandboxEnforcement`（官方 :46 `'full' | 'partial'`）——本包只经 `ShellSandboxInfo.mode`
 *  和 `.enforcement` 读它们。 */
type SandboxExecutionPolicy = NonNullable<ShellExecRequest["sandboxPolicy"]>;

/** ctx.sandboxPolicy 服务：官方 `SandboxPolicyService extends Service`
 *  （@deepseek-ai/dsh-sandbox-policy/lib/types/index.d.ts:71）里 `resolve` 这一个方法的投影——
 *  这个类带私有字段（`defaultMode` 和 `workspaceRoot` 是 public readonly，但 `Service` 基类的
 *  protected ctx 让它按名义类型比较），结构替身满足不了整个类，所以只取方法。
 *  请求体到这里是官方的 `SandboxPolicyRequest`（:50）：`session?: Session` 要的是**真实的
 *  Session 类**（本包在 resolvePolicy 处交的是 `TurnAgent.session`，也就是官方 Session 本身，
 *  不是那个只服务于已退役读取接口的 SessionRef 视图——视图传不进去，见 resolvePolicy 的注释），
 *  `mode?: SandboxMode` 的意思是"已批准的显式模式覆盖，优先级高于会话策略"（:53），本包从不传。
 *  返回值就是上面的 SandboxExecutionPolicy，两侧的字段都不再由本包重写。
 *  rc.2 新增的 `registerWritableRoot(session, directory)` 也在这里：门禁根可能落在会话
 *  工作区**之上**（会话开在 monorepo 子包，检查要在仓库根跑），`workspace-write` 下它
 *  不在本会话的可写边界内——不登记的话构建产物写不出去，命令非零退出，变成假失败。 */
type SandboxPolicyService = Pick<HostSandboxPolicyService, "resolve" | "registerWritableRoot">;

/** 一次沙箱化执行的实际情况 = 官方 `ShellSandboxInfo`（@deepseek-ai/dsh-shell/lib/types/
 *  types.d.ts:31-40，与退出码**各自独立**上报：denied/runnerFailed/enforcement）。本包旧的本地声明
 *  与它逐字段相同，所以不再本地声明；`sandboxNote()` 的参数类型改绑官方成员。 */

/** 单条流的捕获输出（截断时保留的是**尾部**）= 官方 `CollectedOutput`：类型由
 *  @deepseek-ai/dsh-subprocess 拥有、由 dsh-shell 原样再导出
 *  （@deepseek-ai/dsh-shell/lib/types/index.d.ts:11、lib/types/types.d.ts:12）：
 *  text 必有、truncated 必有布尔、spillPath 可选（dsh-subprocess/lib/types/types.d.ts:17-24）。 */

/**
 * shell 执行接口里本包要用的方法（本包唯一的 shell 类型）。官方 `ShellExecutor` 只有 `resolve`
 * 和 `execute` 两个抽象方法（@deepseek-ai/dsh-shell/lib/types/index.d.ts:61/:69），而且二者
 * **收的不是同一个类型**：`resolve` 收调用方给的 `ShellExecRequest`（workdir/timeoutMs/
 * stdoutMaxBytes/signal/sandboxPolicy 全可选，由实现方补默认值并限制范围，types.d.ts:55-98），
 * `execute` 只收 `resolve` 返回的已解析 `ShellExecSpec`（`onExpiry`、`stdoutMaxBytes`
 * 和 `sandboxPolicy` 都是必填，types.d.ts:104-130）。返回的 `ShellExecution`（:214）扩展
 * `ShellProcess`：本包走纯前台路径，只 await 它的 `result()`，进程成员
 * （status/done/kill/readOutput/observed）一个都不读。
 * 0.1.7 唯一的执行入口（0.1.6 的 run/start 已合并到这里）。旧的本地声明把三层的可选性各自抄了一份，
 * 现在全部由官方决定：`ShellRunResult.signal` 其实是**必填**的 `NodeJS.Signals | null`
 * （types.d.ts:136），另外还有一个本包不读的必填 `timeoutMs`（:152）。
 */
type ShellService = Pick<ShellExecutor, "resolve" | "execute">;

/**
 * "门禁跑了且报了代码错误"这一态的 kind 值（注入时走哪条分支和 lesson 总线的 category 都读它）。
 * 判别联合的类型通过 `typeof` 绑到同一个地方，避免这个字面量在两处各写一份、慢慢不一致。
 */
const GATE_KIND_CODE_FAILURE = "code-failure";

/** 一次门禁的结论（判别联合）：三种状态里没有任何"没跑成 → 通过"的通路。 */
type GateProblem =
  | { kind: typeof GATE_KIND_CODE_FAILURE; text: string }
  | { kind: "not-run"; text: string };

type GateOutcome = { kind: "pass" } | GateProblem;

/**
 * 沙箱策略的解析结果：只有 ok 才允许执行门禁；unavailable（服务在，但 resolve 抛错）
 * 一律按 not-run 处理——改用部署级的策略会让门禁跑到宿主 cwd 之外，被沙箱拒绝后
 * 产出一条假的"修这些错"指令。
 */
type PolicyResolution =
  | {
      kind: "ok";
      /** 可用的沙箱绑定；组合里没有 `sandboxPolicy` 服务时为 undefined（非沙箱 executor）。 */
      binding:
        | { readonly service: SandboxPolicyService; readonly policy: SandboxExecutionPolicy }
        | undefined;
    }
  | { kind: "unavailable"; reason: string };

/**
 * 官方 `SettingsForms`（installed `@deepseek-ai/dsh-settings/lib/types/index.d.ts:62`，
 * `Service` 子类 + private `ownerContext/revisions/closed/scheduled/presentations`
 * （:63/:65/:66/:67/:68）→ 名义比较）里本包要用的那几个方法：只用 `configure`（页面策略，:80）与
 * `describe`（跨命名空间读官方 locale 偏好，:96）。此前这里写的是**整个类**，那是对本包
 * 需求的过度声明——它等于说"宿主必须给我一枚完整的 settings 服务"，而本文件其它每个服务都
 * 只写明自己用到的成员。用投影就不重写签名：入参（包括官方那个可选的 `SettingsDescribeOptions`）
 * 与返回全部由官方成员给出。
 */
type SettingsFormsService = Pick<SettingsForms, "configure" | "describe">;

/** `ctx.inject(deps, callback)` 回调收到的子上下文（本包只用到 settings 和 effect）。 */
interface InjectedCtx {
  settings: SettingsFormsService;
  /** 官方的会话投影注册表（可选注入：写了 `inject(["sessionProjections"], …)` 才会拿到）。 */
  sessionProjections: ProjectionsRegistry;
  /** 官方效应面（`interface Context extends Pick<Fiber, 'effect'>`，installed
   *  `@deepseek-ai/cordis/lib/types/fiber.d.ts`，两条重载）——本地不再重写工厂签名。
   *  官方的返回类型 `SyncEffect`/`Effect`（fiber.d.ts:49-52）**不接受 `undefined`**："这一趟没有
   *  要清理的东西"在官方的契约里是交回一个空的 disposer，本包的挂载点交回的都是真正的 disposer。 */
  effect: Context["effect"];
}

/** 行级配置（组合包的层和用户层那些行的 config:）由 cordis 按导出的 `Config` schema 校验并
 *  填好默认值后传入 apply。0.1.7 起是隐式注册：命名空间 = profile 条目 id（`quality-gate`，
 *  见 cordis.patch.yml），可编辑字段由 schema 上的 `.volatile()` 声明，不再有
 *  `settings.register` 的第二层"底座"——原来的 BUILTIN_BASE 逐字段落成下面的
 *  `.default(...)`，只有一处。volatile 字段以 Volatile 的引用形态交进来，读当前值一律用 `.get()`。 */
export interface ConfigShape {
  enabled: Volatile<boolean>;
  maxInjectsPerTurn: Volatile<number>;
  gateBudgetMs: Volatile<number>;
  /** 记忆反馈总开关。**默认关**：见 Config schema 的注释。 */
  memoryFeedback: Volatile<boolean>;
  /** 记忆网关基址。空串 = 未配置 = 不启用（和开关构成两道保险）；本机用户填自己的地址。 */
  memoryGatewayUrl: Volatile<string>;
  /** 网关鉴权令牌的**凭据引用**（环境变量名的形态）：值走 ctx.credentials，不写进设置。 */
  memoryGatewayKeyRef: Volatile<string>;
  /** 额外门禁脚本（逗号或空白分隔的脚本名）：只在根 package.json 真声明时执行 `pnpm run <script>`。 */
  pnpmScripts: Volatile<string>;
  /** 向上找项目根的最大层数（不是 volatile 的部署值：普通值形态，不用 .get()，不占设置卡）。 */
  maxRootDepth: number;
  /** 供应链扫描开关：默认关，打开后跑 npm/pnpm/cargo audit 等联网检查；设置卡可改，下一回合生效。 */
  securityAudit: Volatile<boolean>;
  /**门禁命令 stdout 的捕获上限（字节）（不是 volatile 的部署值：普通值形态，不占设置卡）。 */
  gateStdoutMaxBytes: number;
}

/** 一次读全的、解析后的设置快照（原来 scope.get() 的等价写法）：门禁在每次回合结束时现读，
 *  往下传的是纯值，不必让每个用到的地方都持有引用。 */
interface ResolvedSettings {
  enabled: boolean;
  maxInjectsPerTurn: number;
  gateBudgetMs: number;
  memoryFeedback: boolean;
  memoryGatewayUrl: string;
  memoryGatewayKeyRef: string;
  /** 用户配置的额外脚本名（已拆分、去空、去重；是否真的可用仍由 gate-detect 按 package.json 核对）。 */
  pnpmScripts: readonly string[];
  /** 是否追加联网的供应链扫描。 */
  securityAudit: boolean;
}

/**
 * lesson-loop 总线要用的最小接口：读取是可选的——总线不存在时只丢一次报告；
 * report 自己容错，门禁的主流程绝不因为总线故障而失败。detail 送全文，不截断。
 * category 只有两个值：gate-failure 是代码失败这个事实，gate-not-run 是"检查没跑成"这个事实，
 * 两者必须分开，否则 lesson-loop 会把环境或策略问题当成代码缺陷记录下来。
 *
 * 返回值类型写成 unknown 而不是 void：lesson-loop 的 report 是异步写库的（返回 Promise），
 * 而 `(input) => void` 这种函数类型**正好允许调用方把返回的 Promise 丢掉**——TS 不报
 * "游离 Promise"，no-floating-promises 也看不到，失败于是没有任何记录，还留下一个未处理的
 * 拒绝。unknown 保留了真实的返回类型，调用方一律经 settleLessonCall 处理。
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
 * ctx.credentials 这个服务：官方 `CredentialProvider extends Service`
 * （@deepseek-ai/dsh-credentials/lib/types/index.d.ts:120）里 `resolve` **这一个方法**
 * （:130）——整个类带 private 字段，是名义类型比较，结构替身永远满足不了，所以只 Pick 用到的那个方法；
 * 用投影就不重写签名，入参（带 `brand` 标记的 `CredentialRef`）与返回（`ResolvedCredential | undefined`，
 * :71-76：`value` 是非空密钥，`source` 是来源层）全部由官方给出。本包只读 `.value`，来源层
 * 不参与任何判断，但也不再本地抄一个只剩 value 的 `CredentialHit`。
 *
 * 入参**不再**由本包放宽成 `string`：phantom brand 没有"只用类型"的构造写法（编译器原话
 * `Argument of type 'string' is not assignable to parameter of type 'CredentialRef'. Type
 * 'string' is not assignable to type '{ readonly [BRAND]: "CredentialRef"; }'`），而 `as`
 * 被 lint 的 typescript/no-unsafe-type-assertion 禁掉，唯一合法的传法是值导入官方的
 * `credentialRef(value)`（index.d.ts:18；它先按 REF_PATTERN 校验、不合规就抛 TypeError，再交
 * dsh-brand 的恒等函数 `brandString`，@deepseek-ai/dsh-brand/lib/index.js:20-22）。本包在调用之前
 * 先用官方的 `isCredentialRefName`（index.d.ts:28，用法说明 :20-27）判断一次语法——这正是官方对
 * "名字来自设置字典"这种来源给出的做法：语法不合格的名字本来就不可能有对应的引用，读成"未配置"
 * 比送进去让它抛错更准确，也就绝不会撞上 `credentialRef()` 的抛错路径。
 * 与本文件开头的发布要求不冲突：值导入的这两个函数都只处理字符串；dsh-credentials
 * 落在 peerDependencies，产物因此**新增**一条 `from "@deepseek-ai/dsh-credentials"`
 * 裸说明符（只放 devDependencies 会把函数体内联进产物）。这两件事由
 * `test/build-host.test.ts` 成对钉住：说明符在，官方构造器的函数体不在。
 */
type CredentialService = Pick<CredentialProvider, "resolve">;

/**
 * 宿主 logger 里本包用到的那几个方法：官方 `ctx.logger(name)` 返回的具名 facade 的方法子集
 * （installed @deepseek-ai/cordis/lib/types/logger.d.ts:55-58
 * 的 Logger facade，方法形如 `(format, ...param)`）。这里只声明结构上最小的一份——不 import cordis 的
 * Logger 类型（类类型带 private 字段要按名义类型比较，测试假对象给一个同形状的对象就行）。
 */
interface Log {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface HostCtx {
  settings: SettingsFormsService;
  /** 具名 logger 服务（官方 `ctx.logger(name)`）。没有这个服务时（异常的 ctx、测试假对象）→
   *  改用 console——这条回退是**兼容路径**，不是正常路径，测试把两条都覆盖。 */
  logger?: (name: string) => Log;
  /** 隐式注册之后本包不再持有 scope，只通过注入进来的子上下文挂页面策略（和宿主 dsh-client-locale 一样）。
   *  回调的返回类型跟官方 `Plugin.Function`（返回 `any`）而不是 `void`：cordis 把返回值当作子 fiber 的
   *  setup 屏障，投影那一条要把注册的 promise 传回去。 */
  inject: (
    deps: readonly string[],
    callback: (child: InjectedCtx) => void | Promise<void>,
  ) => unknown;
  /** 本插件的 fiber：`configure` 的 owner 必须显式传它（不传时默认是 settings 服务自己的 fiber）。
   *  类型就是官方 `SettingsForms.configure(presentation, owner?: Fiber)`（installed
   *  `@deepseek-ai/dsh-settings/lib/types/index.d.ts:80`）里的那个 `Fiber`——旧代码写成 `unknown`
   *  是为了把任何东西塞进 owner，换成官方类型之后它才真的受约束。
   *  运行时那道 `isRecord(fiber)` 检查留着（见 `isGateHost`）：官方类型说的是宿主的保证，
   *  跨进程递过来的 ctx 是否满足由守卫负责。 */
  fiber: Fiber;
  /**
   * 可选服务的取法：命中返回服务实例，没注册返回 undefined——**不抛错**。
   * shell、sandboxPolicy、lessonLoop、credentials 都走这个：把它们写进 inject 会让这些服务
   * 缺失的环境里整个插件不加载。
   * 按字面量 name 的重载（每个服务返回准确的类型），其他不认识的服务名退成 unknown——
   * 因此 getShell、lessonLoop 取用时的 `as` 断言不再需要。
   * ⚠ 这个方法**不能**换成官方 `Context["get"]`：官方那一位是
   * `get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]`
   * 加一条 `get(name: string, strict?: boolean): any` 作为兜底（cordis 的 lib/types/reflect.d.ts 里 Context 增强的 get）。
   * `shell`、`sandboxPolicy`、`credentials` 确实都是官方声明进 `Context` 的名字（installed
   * dsh-shell 的 lib/types/index.d.ts 对 Context 的声明等），走泛型那条没问题；但
   * `lessonLoop` 是**兄弟插件**（lesson-loop 包）提供的服务，不在官方 `Context` 的类型里——
   * 换成官方那一条，它正好落进 `any` 那条兜底，读回来的类型从 `unknown` 退化。
   * 只要还有一个服务名落在官方类型之外，这里的本地重载交集就得留着。
   */
  get: ((name: "shell") => ShellService | undefined) &
    ((name: "sandboxPolicy") => SandboxPolicyService | undefined) &
    ((name: "lessonLoop") => LessonLoopReporter | undefined) &
    ((name: "credentials") => CredentialService | undefined) &
    ((name: "sessionQuery") => SessionQueryFace | undefined) &
    ((name: string) => unknown);
  /** 官方效应面（`Context extends Pick<Fiber, 'effect'>`，installed
   *  `@deepseek-ai/cordis/lib/types/fiber.d.ts`）：本地不再重写工厂签名，返回类型由官方
   *  `SyncEffect`/`Effect`（:49-52）给出，两者都**不接受 `undefined`**。本包两处挂载点返回的
   *  都是真正的 disposer（`configure` 的撤销句柄 / `ctx.on` 的退订函数），不需要空 disposer。 */
  effect: Context["effect"];
  /** 注册口（单实例锁要用）。可选：本包其余部分从不碰它，缺了就是「能力缺席」，
   *  锁按放行处理（见 shared 的 lib/instance-lock 头注释）。取值时**直接交对象本身**，
   *  不要再包一层 `{ provide }` —— 包出来的箭头恒是函数，会让「没有注册口」伪装成
   *  「有注册口但 provide 抛错」，让路判据据此误判而把整份插件关掉。 */
  reflect?:
    | { readonly provide?: ((name: string, value?: unknown) => unknown) | undefined }
    | undefined;
  /** 事件接线的地方：监听器的**返回类型**这里直接取官方事件条目
   *  （`Events["agent/turn-stopping"]: (this: Scoped<Agent>, payload: {...}) =>
   *  Promise<void> | void`，installed @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:387-391，
   *  `@mode serial`）——本包的监听器现在要 await 官方观察接口那一次日志读，返回类型由官方给出
   *  之后 `Promise<void>` 就是合法实现，不必在本地把它收窄成 `void`（写成 void 会被
   *  `no-misused-promises` / `strict-void-return` 判成"把 Promise 塞进 void 槽"）。
   *  载荷那一位仍然是 `TurnStoppingPayload` 投影，理由写在那一位上；⚠ 整个方法仍然不换成 `Context["on"]`。 */
  on: (
    event: "agent/turn-stopping",
    listener: (payload: TurnStoppingPayload) => ReturnType<Events["agent/turn-stopping"]>,
  ) => unknown;
}

// ── 内置默认值：就是下面 schema 各字段的 `.default()`（只有一处，没有第二层"底座"）──
// cordis 装载时用同一份 schema 填好默认值再交进 apply。声明放在 Config 之前是为了避开 const 的 TDZ。

/** 注入配额：按 **sessionId 跨回合累计**，门禁全部通过之后才重置（不是每个回合每个根各一份）。 */
const DEFAULT_MAX_INJECTS_PER_TURN = 2;

/** 记忆网关密钥的默认凭据引用名（值由凭据服务那边存，本包只登记引用名）。 */
const DEFAULT_MEMORY_KEY_REF = "TDAI_GATEWAY_KEY";

// 门禁的总时长预算：大仓库的 pnpm check 会耗尽较短的预算，预算不够就等于门禁没有提示地放行（等于没有这项功能）。
// 超时一律按"未执行"注入说明，不按通过。
const DEFAULT_GATE_BUDGET_MS = 300_000;

// 向上找项目根的层数上限：深嵌套的 monorepo（apps/foo/src/...）在上限太浅时会直接跳过（不门禁）。
const DEFAULT_MAX_ROOT_DEPTH = 10;

// 门禁命令 stdout 的捕获上限（字节）：超过之后 harness 只保留尾部（见 CollectedOutput）。
const DEFAULT_GATE_STDOUT_MAX_BYTES = 64 * 1024;

/** 设置界面（= profile 条目 `quality-gate` 的可编辑表单）与 loader 行的 config 共用同一份
 *  schema（只有一处，防止两边不一致）。六个字段**全部** `.volatile()`：一个 volatile 字段都没有的条目
 *  会被宿主的 describe() 整条跳过（installed @deepseek-ai/dsh-settings/lib/index.js:413-418
 *  只在 volatileForm(schema) 有值时才登记条目），写入则抛
 *  `has no volatile fields`（:505-506）。
 *  两个容易踩的策略约定（都锁在下面对应的行内注释里，改默认值之前先读）：
 *   - `memoryGatewayUrl` 的默认值是**空串**而不是不给：`""` + feedback-off = 永不推送，
 *     换成 undefined 会把"未配置"变成"字段不存在"，行为不再等价；
 *   - `memoryGatewayKeyRef` 的 `.role('credential-ref')` 与 `.volatile()` **共存**：role 只
 *     写 meta.role（fork 的 role 和 volatile 都走 `extra`＝`{...meta, k: v}` 展开，见
 *     installed @deepseek-ai/schemastery/src/index.ts:385-389），不会抹掉 meta.volatile。 */
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
  // 记忆反馈默认**关闭**：它连的是"某台机器上的记忆网关"，一台开发机的 127.0.0.1 端口
  // 对别人既不存在也没有意义——默认开着等于每个失败的回合都去连一个不存在的本机服务
  // （白等 5s 超时 + 刷屏的 warn）。要用的人在设置卡里打开并填自己的地址。
  memoryFeedback: Schema.boolean().default(false).volatile(),
  // 地址默认"未配置"（空串）：和上面的开关一起构成两道保险，任一为空都不推送。
  memoryGatewayUrl: Schema.string().default("").volatile(),
  // 凭据引用（环境变量名的形态）：官方的写法是让 `.role('credential-ref')` 与 `.default(...).volatile()`
  // 共存。role 让设置界面按凭据引用的形式呈现，
  // 存的只是引用名，密钥值由 ctx.credentials 那边管理，永远不会写进 settings.yaml。
  memoryGatewayKeyRef: Schema.string()
    .role("credential-ref")
    .default(DEFAULT_MEMORY_KEY_REF)
    .volatile(),
  // 额外门禁脚本：空串 = 不启用（默认）。用户填 `check:all` 这类**项目自己声明**的脚本后，
  // 根 package.json 里真有这一条才会发 `pnpm run <script>`；名字形状与声明两道校验都在 gate-detect。
  pnpmScripts: Schema.string().default("").volatile(),
  // ── 不同部署可能想配不同值的，就必须是配置字段 ──
  // 其中 maxRootDepth 与 gateStdoutMaxBytes 是**部署时的默认值**：不是 volatile → 不进设置卡
  // （宿主只投影 volatile 字段），以普通值的形态交进 apply（不用 .get()）；默认值 = 现在代码里的值，
  // 改 cordis.yml 里的行 config 就能改，不用改代码。securityAudit 是 volatile，不在此列。
  /** 向上找项目根的最大层数（深嵌套 monorepo 的查找深度）。 */
  maxRootDepth: Schema.natural().default(DEFAULT_MAX_ROOT_DEPTH),
  /** 供应链扫描默认关：它要联网、要额外工具，不能在每个编辑回合替用户决定；设置卡可打开。 */
  securityAudit: Schema.boolean().default(false).volatile(),
  /**门禁命令 stdout 的捕获上限（字节）：超过之后 harness 只保留尾部（见 CollectedOutput）。 */
  gateStdoutMaxBytes: Schema.natural().default(DEFAULT_GATE_STDOUT_MAX_BYTES),
});

/** 总预算剩下的那段里，单个门禁至少要有这么多时间才有意义：低于这个值再跑门禁必然超时（假失败），
 *  所以跳过剩下的检查。 */
const MIN_USEFUL_GATE_MS = 5000;
/** 截断证据时头部摘录的字节上限：从 spill 文件里**限量**读回开头（真正的原因通常在开头）。 */
const EVIDENCE_HEAD_BYTES = 4096;

/** harness SandboxUnavailableError 的错误码（run() 抛出它就等于"命令根本没跑"）。 */
const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE";

/** 每个会话的注入配额状态：count = 已注入修复的次数；gaveUp = 是否已经发过"放行说明"（防止重复发）。 */
interface InjectState {
  count: number;
  gaveUp: boolean;
}

/** 按会话存的 Map 的条数上限：超过就按插入顺序淘汰最旧的（防止长时间运行的进程无限增长）。 */
const SESSION_BUDGET = 50;

/** 从 unknown 安全地读字段：字面量键通过参数传进去，绕开 dot-notation 与
 *  noPropertyAccessFromIndexSignature（tsc 禁止对索引签名用点号）之间的冲突。 */
/**
 * 会话级 Map 的淘汰：把 keep 先删后插移到队尾（JS Map 的迭代顺序就是插入顺序），再淘汰队首超出
 * `SESSION_BUDGET` 的那些项 → keep 永远不会被淘汰，总大小收敛。三种 Map 复用同一个函数：注入配额
 * Map（InjectState）、事件游标 Map（number）和编辑累加器 Map（EditAccumulator）。
 * keep 不在表里 → 直接返回（inbox-busy 分支的 injectState 就会走到这里：那个会话从没失败过）。
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
 * 根会话的判断：子代理会话（delegationDepth>0 或 origin==='subagent'）不做回合结束时的门禁。
 *
 * agent/turn-stopping 对每个 agent（包括 in-process 的 fork/spawn 子代理）都会触发，不筛选的后果有
 * 两条：①父会话和子代理对同一个项目根各跑一遍门禁（token 和耗时翻倍）；
 * ②失败的注入文案是面向用户的，followup 却进了子代理——在结算之前到达会多拖一轮子代理回合，
 * 在结算之后到达则滞留在 inbox 被丢弃（门禁没有提示地失效）。所以只在根会话上做。
 *
 * out-of-process 子代理（ACP/claude-code/codex）
 * 在独立进程运行，不发射 dsh 的 agent 事件，它们的编辑天然不在任何门禁的范围内。in-process
 * 的具名子代理被这个判断跳过后，编辑并没有丢：根会话在回合结束时把这些子代理的台账按游标并入
 * 本回合（{@link collectTeamEdits}），队友仍在执行则推迟本轮（{@link mergeTeamLedgers}）。
 */
function isRootSession(agent: TurnAgent): boolean {
  const { header } = agent.session;
  // delegationDepth 在 header 里是可选的（顶层会话省略 = 零），故 ?? 0 而非 Number() 强转
  return !((header.delegationDepth ?? 0) > 0 || header.origin === "subagent");
}

/** Inbox 里是否有待处理消息（读的是 `InboxQueues`：两个队列都可能没有，所以用 `?.length ?? 0`）。 */
function inboxHasPending(inbox: TurnAgent["inbox"]): boolean {
  return (inbox.nextTurn?.length ?? 0) > 0 || (inbox.nextStep?.length ?? 0) > 0;
}

/**
 * 注入之前的第二次确认：turn-stopping 时 agent.status 一直是 'running'
 * （官方 agent.ts：turn-stopping 在 running 阶段内 serial 分发，转到 idle 发生在回合结束之后），
 * 所以绝不能用 status 判断 idle。改看数据信号：turn 的 signal 已取消，或者 inbox 有待处理消息
 * （用户接管／已排队的后续工作）→ 不注入（和官方 "Data decides" 的语义一致）。
 * 插件卸载时的拦截不放在这里：disposer 会中止正在跑的门禁批次，迟到的结果在批次里就地丢弃
 * （见 processGate），到不了注入点——卸载时的处理比"注入前再检查一次"更严格。
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
 * 本次门禁要跑的 tsc 入口：优先用工程自己装的 typescript（和工程惯用的编译器版本一致），
 * 装不到时改用本包依赖里那一份（随包安装，运行时不联网）。两处都解析不到时改用 PATH 上的
 * `tsc`，由 126/127 那条"工具不可用"的出口报成未执行——绝不走 `npx` 的自动下载。
 */
function tscEntry(root: string): string | undefined {
  let entry: string | undefined;
  for (const from of [path.join(root, PKG_MANIFEST), import.meta.url]) {
    try {
      const manifest = createRequire(from).resolve("typescript/package.json");
      entry = path.join(path.dirname(manifest), "bin", "tsc");
      break;
    } catch {
      // 这个解析起点上没有 typescript：换下一个
    }
  }
  return entry;
}

/** 门禁命令的实际 argv：tsc 的门禁只带逻辑名，入口在运行时按工程根解析。 */
function gateCommandArgs(gate: Gate): readonly string[] {
  if (gate.command[0] !== "tsc") {
    return gate.command;
  }
  /* v8 ignore next 1 —— 本包自己的 typescript 也解析不到（安装坏了）时才走 PATH 那条回退；
     正常安装走不到，而那一路径由 126/127 报成未执行。 */
  return [tscEntry(gate.root) ?? "tsc", "--noEmit"];
}

/** shell 里不需要加引号的参数形状。 */
const SHELL_SAFE_ARG = /^[\w./:=@+-]+$/u;

/** 拼 shell 用的串：路径可能带空格，含空白或 shell 元字符的参数加单引号。
 *  导出只是为了直接测这段引号处理：tsc 入口是绝对路径，它所在的目录未必没有空格。 */
export function shellArg(part: string): string {
  return SHELL_SAFE_ARG.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`;
}

/**门禁命令展示与执行时用的串（和 gateCommandArgs 同一个来源）。 */
function gateCommandText(gate: Gate): string {
  return gateCommandArgs(gate)
    .map((part) => shellArg(part))
    .join(" ");
}

/** harness run() 抛出的 SandboxUnavailableError（code 或 name 命中任意一个即可）。 */
function isSandboxUnavailable(error: unknown): boolean {
  return (
    fieldOf(error, "code") === SANDBOX_UNAVAILABLE ||
    fieldOf(error, "name") === "SandboxUnavailableError"
  );
}

/**
 * 限量读取因截断而写到文件里的那份输出的开头（第一个错误通常在开头，而 harness 内存里只留尾部；
 * spill 文件可能有几 MB，所以用 openSync/readSync 只读前 EVIDENCE_HEAD_BYTES 个字节）。
 * 读不到（没权限/文件已被回收/不是绝对路径）→ undefined：调用方只标注被截断，不编一段头部内容。
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
      // 读不到（没权限/已被回收/设备错误）→ 只标注被截断，不编一段头部摘录
      excerpt = undefined;
    }
  }
  return excerpt;
}

/**
 * 证据文本。
 *
 * tsc、cargo 这些工具的错误是自上而下排的，**第一条才是真正的原因**，而 harness 的 CollectedOutput
 * 截断时保留的是**尾部**（installed @deepseek-ai/dsh-subprocess/lib/types/types.d.ts:18-23）——
 * 于是不看 `truncated` 就会把原因丢掉，注入给模型的"修这些错"只剩下无关的尾巴。必须：
 *   ①明确标出被截断；②从 spillPath 限量读回开头放在最前；③没有写出文件时明确说明
 *   第一个错误可能已经被丢掉，让模型和用户都知道证据不完整。
 * 没有截断时不再叠加第二层截断（不为了省 token 削弱能力，上限由 shell 的
 * stdoutMaxBytes 控制）。
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
    command: gateCommandText(gate),
    root: gate.root,
    output: out,
  });

/**
 * "门禁没跑成"文案：与"修这些错"严格分开——没跑成的检查不是代码错误的证据，
 * 让模型去修一个装不上的工具、或者绕不过去的沙箱，只会陪着配额把 token 花完。
 */
const notRunText = (messages: QualityGateMessages, gate: Gate, reason: string): string =>
  renderTemplate(messages.gateNotRun, {
    command: gateCommandText(gate),
    root: gate.root,
    reason,
  });

/** 配额用完之后的"放行说明"（用户可见，不再静默 return）。 */
const giveUpText = (messages: QualityGateMessages, gate: Gate, attempts: number): string =>
  renderTemplate(messages.gaveUp, {
    attempts,
    command: gateCommandText(gate),
    root: gate.root,
  });

/** 未执行清单里的一行（写在模块级：不让 renderTemplate 套进 map 再套进 renderTemplate）。 */
const skippedGateLine = (messages: QualityGateMessages, gate: Gate): string =>
  renderTemplate(messages.skippedGateItem, { command: gateCommandText(gate), root: gate.root });

/** 时间预算用完之后，剩下那些门禁的"未执行"清单：只 warn 等于静默通过，所以要注入给模型和用户。
 *  `remainingMs` 是**当时真的还剩多少**：文案写的是"本轮剩余预算 {budgetMs}ms"，印成最小可用阈值
 *  （5000）就成了一个与事实无关的固定数字，用户无法据此判断该调多少预算。 */
const skippedText = (
  messages: QualityGateMessages,
  gates: readonly Gate[],
  remainingMs: number,
): string =>
  renderTemplate(messages.gatesSkipped, {
    budgetMs: Math.max(0, remainingMs),
    list: gates.map((gate) => skippedGateLine(messages, gate)).join("\n"),
  });

/** 沙箱的实际情况 → 可以读出来的模式与完备度说明（用来把策略拒绝和代码失败分开表述）。 */
function sandboxNote(messages: QualityGateMessages, facts: ShellSandboxInfo): string {
  const mode = renderTemplate(messages.sandboxMode, { mode: facts.mode });
  return facts.enforcement === undefined
    ? mode
    : `${mode}${renderTemplate(messages.sandboxEnforcement, { enforcement: facts.enforcement })}`;
}

/**
 * 被沙箱拦下的结论（runner 不可用 / 策略拒绝）→ not-run。
 *
 * 两条消息按官方事实的优先级选一条（runnerFailed 在前），判断顺序和以前内联的 if 完全一致；
 * 没有被拦下时返回 undefined，交给按退出码排的阶梯。
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
 * 进程没跑完的三种情况：超时 / 取消 / 没有退出码（被信号杀死）。
 *
 * 前两条按 not-run，被信号杀死按代码失败——和旧代码里那串 if 的前三支顺序与文案都一致。
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

/** 工具不可用时，stderr 里会出现的说法。 */
const TOOL_UNAVAILABLE_TEXT =
  /command not found|not recognised|not recognized|permission denied|not executable/u;
const CARGO_AUDIT_MISSING = /no such command/u;
const COMPOSER_AUDIT_MISSING = /command\s+"[^"]+"\s+is not defined/iu;

/**
 * exit 126/127 且 stderr 出现"不可用"这类说法时，判为**工具/环境不可用**（not-run）。
 *
 * 0.1.14 起不再要求同一行里出现门禁命令的首个 token。旧的合取条件漏掉了一整类真实故障：
 * `pnpm check` 的脚本在 `node_modules` 缺失时自己回 127（`[ELIFECYCLE] ... exit code 127`
 * 加 `sh: oxlint: command not found`），首 token 是 `pnpm` 而报错行里只有 `oxlint`，于是被判成
 * 代码失败，模型被要求去"修"一个根本没跑起来的检查。现在任何一行命中都算环境问题：
 * 脚本里真的缺一个命令仍是环境（依赖没装/工具没装），不是这段代码的错。
 */
export function gateToolUnavailable(gate: Gate, res: ShellRunResult): boolean {
  if (res.exitCode === 126 || res.exitCode === 127) {
    return res.stderr.text
      .toLowerCase()
      .split("\n")
      .some((line) => TOOL_UNAVAILABLE_TEXT.test(line));
  }
  // 子命令形式的工具没有 shell 层 127 可看：cargo audit 缺失是 exit 101 + "no such command"，
  // 较老的 Composer 的 audit 缺失是 exit 1 + 'Command "audit" is not defined.'。这两种都不是代码缺陷。
  if (gate.command[0] === "cargo" && gate.command[1] === "audit" && res.exitCode === 101) {
    return CARGO_AUDIT_MISSING.test(res.stderr.text);
  }
  if (gate.command[0] === "composer" && gate.command[1] === "audit" && res.exitCode === 1) {
    return COMPOSER_AUDIT_MISSING.test(res.stderr.text);
  }
  return false;
}

/** tsc 在"类型依赖/工程引用没就绪"时给出的错误码（都不是代码错误）。 */
const TYPE_ENVIRONMENT_ERRORS = /\bTS(?:2688|6305|6306|6307)\b/u;

/**
 * tsc 门禁的**环境性失败**：`TS2688`（找不到类型定义）、`TS6305/6306/6307`（project references
 * 的产物未构建/不在预期目录）。这些错误说明的是"这个包单独跑 tsc 的前提不成立"，而不是它写的
 * 代码有错：宿主仓库 393/412 个包带 `references`，包级 `tsc --noEmit` 必然 TS6305（已实测）。
 *
 * 只在 `tsc` 门禁上判：其它门禁的输出里偶然出现这些字样不算。**stdout 与 stderr 都要看**：
 * tsc 默认把诊断打到 stdout（本机 TS 7.0.2 实测 `--noEmit` 的 stderr 为空、TS6305 在 stdout），
 * 只看 stderr 会把这一整类真实环境问题继续误判成代码失败。
 */
function environmentFailureOutcome(
  messages: QualityGateMessages,
  gate: Gate,
  res: ShellRunResult,
  log: Log,
): GateOutcome | undefined {
  let outcome: GateOutcome | undefined;
  if (
    gate.command[0] === "tsc" &&
    res.exitCode !== 0 &&
    TYPE_ENVIRONMENT_ERRORS.test(`${res.stdout.text}\n${res.stderr.text}`)
  ) {
    log.warn(
      `[quality-gate] tsc gate hit an environment error (TS2688/63xx): ${gateCommandText(gate)} @ ${gate.root} — reported as not-run`,
    );
    outcome = {
      kind: "not-run",
      text: `${renderTemplate(messages.toolNotRun, { cause: messages.typeEnvironmentUnready })}\n${evidenceText(messages, res.stdout, "stdout")}${evidenceText(messages, res.stderr, "stderr")}`,
    };
  }
  return outcome;
}

/**
 * pnpm 门禁的**依赖预检**：根上有 lockfile 但没有 `node_modules` 时不发命令。
 *
 * 理由（实测）：`pnpm run` 在缺依赖时会**先自动安装再执行**（有 lockfile 时），这会在一回合的
 * 收尾阶段静默联网、写盘、耗时几十秒；而没有 lockfile 的树会直接 `command not found` 退 127。
 * 两种都不是"这次改动有问题"。本插件不知道用户此刻是否想安装，所以把结论降级为 not-run
 * 并明确提示"先安装依赖"，由人或模型显式跑一次安装。
 */
function dependencyPrecheckOutcome(
  messages: QualityGateMessages,
  gate: Gate,
  log: Log,
  exists: (target: string) => boolean = existsSync,
): GateOutcome | undefined {
  let outcome: GateOutcome | undefined;
  if (
    gate.command[0] === "pnpm" &&
    // `pnpm audit` 只读 lockfile，不需要 node_modules；按脚本类门禁的预检处理它会把漏洞扫描静默跳掉。
    gate.command[1] !== "audit" &&
    exists(path.join(gate.root, "pnpm-lock.yaml")) &&
    !exists(path.join(gate.root, "node_modules"))
  ) {
    log.warn(
      `[quality-gate] pnpm gate skipped: dependencies not installed in ${gate.root} (pnpm install first)`,
    );
    outcome = { kind: "not-run", text: messages.depsNotInstalled };
  }
  return outcome;
}

/**
 * 门禁用的工具本身不可用（exit 126/127 且 stderr 出现"不可用"的说法）→ not-run，并 warn 给运维。
 * 这是环境问题不是代码问题：注入失败指令会逼模型去修一个装不上的工具；但没跑成 ≠ 通过。
 */
function unavailableToolOutcome(
  messages: QualityGateMessages,
  gate: Gate,
  res: ShellRunResult,
  log: Log,
): GateOutcome | undefined {
  let outcome: GateOutcome | undefined;
  if (gateToolUnavailable(gate, res)) {
    log.warn(
      `[quality-gate] gate tool unavailable (exit ${res.exitCode}): ${gateCommandText(gate)} — reported as not-run, not as pass`,
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
 * 把一次 shell.execute().result() 的结果分成三种状态（纯函数：不读 ctx，每条分支都能测）。
 *
 * harness 的 ShellRunResult.sandbox 与退出码是**各自独立**上报的（installed
 * @deepseek-ai/dsh-shell/lib/types/types.d.ts:28：
 * "Facts are reported independently of process exit status so callers can distinguish
 * command failures from policy denials and runner failures"），所以必须读它——不读就会把
 * 策略拒绝当成代码失败注入"修这些错"。
 *
 * 判断顺序（三支各自成一个函数，顺序和 warn 次数都不变）：沙箱拦下 → 进程没跑完 →
 * 工具装不上（126/127）→ exit 0（只部分生效的沙箱额外 warn）→ 代码失败。
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
  const environment = environmentFailureOutcome(messages, gate, res, log);
  if (environment !== undefined) {
    return environment;
  }
  if (res.exitCode === 0) {
    // 只部分生效的沙箱里，exit 0 只说明"在这个边界内没报错"——warn 给运维，判断仍然是 pass。
    if (facts?.enforcement === "partial") {
      log.warn(
        `[quality-gate] gate passed under PARTIAL sandbox enforcement (${sandboxNote(messages, facts)}): ${gateCommandText(gate)} @ ${gate.root}`,
      );
    }
    return { kind: "pass" };
  }
  return {
    kind: GATE_KIND_CODE_FAILURE,
    text: `exit=${res.exitCode}\n${evidenceText(messages, res.stdout, "stdout")}${evidenceText(messages, res.stderr, "stderr")}`,
  };
}

/** 是否是应当记录的编辑类工具（edit/write 加 str_replace_editor）。名单的唯一来源在
 *  lib/accumulator.ts 的 EDIT_TOOLS：host 先用它筛一遍、累加器再用同一个集合筛一遍，
 *  两边各写一份时，新增编辑器工具只改一边就会悄悄不一致。 */
function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}

/** 判断交回的是不是数组（**不是** type predicate，因此不产生类型收窄；理由见 resolveEventWindow）。 */
function isArrayDelivery(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * 算事件游标的读取窗口：取 fork 位置下限和上次已读到的 seq 中较大的那个，返回起始 seq 与这一批事件。
 * 事件流取自官方的 `ctx.sessionQuery.observeSession(sessionId)`（见上面 SessionQueryFace：
 * 一次返回 `events` 和 `inheritedEventCount`）。两条退路一律返回 `undefined`（调用方直接
 * 返回，**游标不推进**、也不误报）：① `observeSession` 抛错或拒绝（会话已卸载、存储读不出来）；
 * ② 返回的 events 不是数组（不符合契约的交付，由 `isArrayDelivery` 这个**布尔**判断挡住——不用
 * `Array.isArray` 做守卫收窄类型，它会把官方 `readonly SessionEvent[]` 塌成 `any[]`，类型立刻失效，
 * 还把 any 传进后面的记录逻辑）。`sessionQuery` 服务本身不存在是第三条退路，判断写在
 * `readEditedFiles`（只有那里能发只提示一次的 warn）。
 * 窗口仍然**由本地按 from 切片**：观察接口给的是从日志开头连续的切片（`seq = log.length`
 * 这个连续性契约，installed dsh-session/lib/index.js:1476 的注记），而 `from` 是本包游标算出来的
 * 裸 number——这样连 `SessionLogOffset` 的品牌都不必造（官方只要 `SessionId`，那一位从
 * `Session.id` 上拿回来时就带 `brand` 标记）。
 */
async function resolveEventWindow(
  query: SessionQueryFace,
  sessionId: SessionId,
  lastSeq: ReadonlyMap<string, number>,
  firstFrom: number,
): Promise<{ from: number; events: readonly SessionEvent[] } | undefined> {
  // 只有一处 return（consistent-return 与 treatUndefinedAsUnspecified：不把 undefined 和值返回混在一起）
  let window: { from: number; events: readonly SessionEvent[] } | undefined;
  // 观察结果在 try 外面声明：`observeSession` 自己拒绝时它仍然是 undefined，收尾就不会去调一个
  // 不存在的释放器；一旦拿到了，成功、返回的不是数组、后面抛错这三条路径都由 finally 归还这份 lease。
  let observation: SessionObservationFace | undefined;
  try {
    observation = await query.observeSession(sessionId, { projectionMode: "none" });
    // 游标下限 = fork 的位置（root 会话是 0）；**第一次见到的会话**再用本回合起点兜底：
    // 从 fork 位置起步会把本会话的全部历史编辑重放一遍（重启后首轮尤其多），而从回合起点起步
    // 正好覆盖"turn-stopping 时本回合的编辑已经在日志里"这一事实，也不跳过正在要检查的回合。
    // 两者取较大值：fork 边界永远不被越过，回合起点只在它之上收紧。
    const forkCut = observation.inheritedEventCount ?? 0;
    const seen = lastSeq.get(sessionId);
    const from = Math.max(forkCut, seen ?? Math.max(forkCut, firstFrom));
    if (isArrayDelivery(observation.events)) {
      window = { from, events: observation.events.slice(from) };
    }
  } catch {
    // 观察接口读不出来：和迁移前"snapshotEvents 缺失或不是数组"按同一种退路处理——不推进游标。
    window = undefined;
  } finally {
    // 窗口里是 `slice` 出来的独立数组，归还 lease 不会影响它；释放属于尽力而为：
    // 旧宿主可能没有 Symbol.dispose，释放器自己也可能抛错——这两种情况都不该把一次读窗
    // 变成 reject，否则本回合的门禁会被整条跳过。
    try {
      observation?.[Symbol.dispose]();
    } catch {
      // 释放失败不改变本次读窗的结论。
    }
  }
  return window;
}

interface EditRecord {
  callId: string | undefined;
  name: string;
  path: string | undefined;
}

interface PendingEdits {
  records: EditRecord[];
  /** callId → 结算状态（成功、审批被拒、已派发中止、普通失败）。 */
  outcomes: Map<string, EditOutcome>;
}

/**
 * 一次扫描事件流 → 编辑记录的三张表：callId→编辑（成功时的关联）、没有 callId 的直接记录、
 * 失败的 callId 集合。
 * 只记成功的编辑：被 danger-guard 拒绝或执行失败的 tool/result 会把对应的 callId 标为失败，跳过。
 * 记录的骨架复用 shared 的 scanToolEvents（事件解析、view 判定、无效参数标记），本函数只做
 * 领域内的筛选（编辑工具集合、路径的记录语义）——不再和 danger-guard 各写一份 JSON.parse 和 view 判断。
 *
 * 语义对照（和原本地的实现等价）：
 *   - 参数不合法（JSON 不合法、不是对象）→ 不记录（原来的 EDIT_SKIP）；
 *   - str_replace_editor 的 view（只读）→ 跳过（原来的 EDIT_SKIP）；
 *   - 其余编辑调用按 callId 关联，tool/result 的 isError 回填失败标记。
 */
/** 一次编辑调用要记录的全部路径。apply_patch 按每个操作展开（含 move 的目的地）；普通编辑器只有
 *  写操作成一条，view 是只读的证据；写了但没给路径时保留一条 undefined（沿用原来的语义）。 */
function editPathsFor(call: ToolCallRecord): readonly (string | undefined)[] {
  if (call.name === "apply_patch") {
    return sharedEditPathsOf(call);
  }
  const target = sharedEditPathOf(call);
  return target.kind === "write" ? [target.path] : [];
}

function collectEdits(events: readonly SessionEvent[]): PendingEdits {
  const records: EditRecord[] = [];
  const outcomes = new Map<string, EditOutcome>();
  const { calls, results } = scanToolEvents(events);
  for (const call of calls) {
    // read-view（str_replace_editor 的 view）是只读，不算编辑；参数不合法（JSON 不合法）与
    // 不是编辑工具同样不记录——和原来本地实现的 EDIT_SKIP 分支严格等价。
    if (isEditTool(call.name) && !call.badArguments) {
      for (const filePath of editPathsFor(call)) {
        records.push({ callId: call.callId, name: call.name, path: filePath });
      }
    }
  }
  for (const result of results) {
    if (result.callId !== undefined) {
      outcomes.set(result.callId, editOutcomeOf(result));
    }
  }
  return { records, outcomes };
}

/** 组装注入用的消息（id 唯一，同一毫秒内多次注入也不会撞车）。 */
const injectMessage = (text: string): FollowupMessage => ({
  id: `quality-gate-${randomUUID()}`,
  role: "user",
  content: [{ type: "text", text }],
  source: { kind: GATE_SOURCE_KIND },
});

/**
 * 上报给 lesson-loop 总线：门禁失败是一个事实，无论是否注入修复都要报
 * ——修复环节里同一条门禁反复失败会形成一串 violation，可以看出"提醒有没有用"。
 * 但"没跑成"用 gate-not-run 单独上报：环境和策略问题不能被当成代码缺陷记录——假的失败指令
 * 一旦既被注入又被写进记忆和 lesson-loop，后面学到的就是错的东西。
 * report 自己容错（同步抛错和异步拒绝都经 settleLessonCall 落到同一条 warn）；
 * 总线不存在（没装 lesson-loop）时 get 返回 undefined，直接跳过。
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
        signature: gateCommandText(gate),
        detail: problem.text,
        evidence: { root: gate.root, command: gate.command, kind: problem.kind },
      }),
    (reason) => {
      log.warn(`[quality-gate] lessonLoop report failed: ${messageOf(reason)}`);
    },
  );
}

/** 一次记忆反馈发送目标的解析结果（判别联合：每一条退出的原因都能被测试单独钉住）。 */
type FeedbackResolution = { ok: true; target: GatewayTarget } | { ok: false; reason: string };

/** 记忆反馈退出了时的可观察状态（每次 apply 一份：插件重载就重新计数，不跨代累计）。
 *  log 随行：本包的具名 logger（宿主没装就用 console），是不发送时唯一的出口。 */
interface MemorySkipNotice {
  warned: boolean;
  log: Log;
}

/**
 * 设置 + dsh 凭据通道 → 一次发送的目标；任何一环缺失只返回不发送的原因，**不抛错**。
 *
 * 为什么不抛：记忆反馈是尽力而为的补充。别人机器上没有那台网关、没配凭据，甚至没装
 * 凭据服务都是**常态**，抛错会把一次正常的门禁失败升级成回合错误（而且缺配置本来就是
 * 用户要看见的信息，不是异常情况）。
 *
 * 密钥改走 ctx.credentials 之后不再有 gateway.key 的文件路径拼接：网关地址和令牌都是
 * "某台机器上的情况"，只能由使用者明确配置（设置项 + 凭据），不能被插件替所有人认定。
 */
async function resolveFeedbackTarget(
  cfg: ResolvedSettings,
  credentials: CredentialService | undefined,
): Promise<FeedbackResolution> {
  const url = resolveGatewayUrl(cfg.memoryGatewayUrl);
  if (url === "") {
    return { ok: false, reason: "memoryGatewayUrl 未配置（留空 = 不启用记忆反馈）" };
  }
  if (!isCredentialSafeUrl(url)) {
    return {
      ok: false,
      reason: `memoryGatewayUrl ${url} 是明文 http 且非回环：Bearer 凭据只发往 https 或本机`,
    };
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
  // 上面那道 isCredentialRefName 已经保证语法合格，所以 credentialRef() 的校验一定通过（不会抛）。
  const hit = await credentials.resolve(credentialRef(cfg.memoryGatewayKeyRef));
  // 凭据那边的约定是"空值就等于不存在"（resolve 只会返回真值），所以这里只判 undefined。
  if (hit === undefined) {
    return { ok: false, reason: `凭据 ${cfg.memoryGatewayKeyRef} 未配置（值不落在设置里）` };
  }
  // 服务名在这一层和 url、key 一起解析：发送模块只发它拿到的目标，不再自己去读环境变量。
  return { ok: true, target: { url, key: hit.value, serviceId: resolveServiceId() } };
}

/**
 * 记忆反馈不发送的说明只说一次：在默认关闭之后还把它打开的人，多半正是"少配了一项"的状态
 * （地址填了、凭据没配）。每个失败的回合都重复打印只会把门禁的日志淹掉。
 */
function warnMemorySkip(notice: MemorySkipNotice, reason: string): void {
  if (notice.warned) {
    return;
  }
  notice.warned = true;
  notice.log.warn(`[quality-gate] memory feedback skipped: ${reason}`);
}

/** 尽力而为的记忆反馈（错误在这里内部处理掉，绝不拖住门禁的主流程）。 */
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

/** `pnpmScripts` 的分隔符（逗号或空白）。 */
const SCRIPT_SPLIT = /[\s,]+/u;

/**
 * 把 `pnpmScripts` 的原始文本拆成脚本名。
 *
 * @param raw - 用户填写的值（逗号或空白分隔）
 * @returns 去空、去重后的脚本名串（顺序保留：同一优先级里先命中先执行）
 */
function splitScriptNames(raw: string): string[] {
  const names = raw
    .split(SCRIPT_SPLIT)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return [...new Set(names)];
}

/** 一次读全的、解析后的设置快照（`scope.get()` 的等价写法）：门禁在每次回合结束时现读，
 *  往下传的是纯值，不必让每个用到的地方都持有引用——所有 `.volatile()` 的引用一次 `.get()` 成普通值。 */
function settingsOf(config: ConfigShape): ResolvedSettings {
  return {
    enabled: config.enabled.get(),
    maxInjectsPerTurn: config.maxInjectsPerTurn.get(),
    gateBudgetMs: config.gateBudgetMs.get(),
    memoryFeedback: config.memoryFeedback.get(),
    memoryGatewayUrl: config.memoryGatewayUrl.get(),
    memoryGatewayKeyRef: config.memoryGatewayKeyRef.get(),
    pnpmScripts: splitScriptNames(config.pnpmScripts.get()),
    securityAudit: config.securityAudit.get(),
  };
}

/**
 * 对 ctx 里本包要用的那几个服务做存在性检查（替代 `ctx as unknown as HostCtx` 断言：严格档下
 * 加豁免注释不是合法手段）。cordis 的 ctx 是运行时的代理，成员齐不齐只能按实际要调的东西核对。
 * 核对的是 **0.1.7 的实际接口**：`settings.configure`（页面策略）+ `settings.describe`
 * （跨命名空间读）+ `inject` + `fiber` + `get`/`on`/`effect`。
 * ⚠ 不能再探 `settings.register`：0.1.7 已经把它连同 get/installSection 一起移除了，
 * 还拿它当硬性前提会让**每一台真宿主**都判成"服务不全"，`gate not armed` 于是成为
 * 唯一可能出现的失败（本包设置界面失效就是这么发生的）。
 * 缺任何一项一律按失败处理（宁可什么都不做）：不注册监听、不写游标，只记一条 error，
 * 避免带着不完整的服务跑到第一个回合才崩（而且崩溃会被折成 turn kind:error 直接甩给用户）。
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
 * 子包自己就能给出 pnpm 门禁（项目声明的 `check`，或 `pnpmScripts` 里点名且真声明的脚本）
 * 时，它就是离文件最近、又真能跑起来的那一层门禁；继续往上找外层工作区只会把"改一个子包"
 * 放大成 workspace 的全套检查」——门禁的作用域应当止步于最近的 workspace 根。
 *
 * `securityAudit` 刻意**不**参与这个判断：它是选完根之后追加的独立供应链扫描层，不是项目
 * 自己的门禁；把它算进 pnpm 命中会让一个只有 lockfile 的子包截停向上探测，或让只有 lockfile
 * 的外层 workspace 把子包真正的 tsc 抹掉。
 */
function hasPnpmCheckGate(root: ProjectRoot, extraScripts: readonly string[]): boolean {
  return detectGate([root], extraScripts).some((gate) => gate.command[0] === "pnpm");
}

/**
 * 一个文件的最近清单根 → 实际要跑的根：最近的 workspace 根优先，**但只在外层真能产出门禁时**才升级。
 *
 * 只判断"上面有没有 pnpm-workspace.yaml"就升级，是漏掉门禁的一条路径：外层如果是一个"有 workspace
 * 清单、却既没有 check 脚本也没有 tsconfig"的根，gate-detect 对它返回空表，子包本来有的
 * `npx tsc --noEmit` 或 `ruff check` 会被这次上移抹掉，而且没有任何输出。
 *
 * 反方向也一样：子包自己就是 workspace 根、也能给出门禁时不再往上——否则"本仓自己的门禁"
 * 会被外层伞工作区的全套 `pnpm check` 挤掉，改一个仓要等着跑九个仓。
 */
function rootForFile(
  useRoot: string,
  maxDepth: number,
  extraScripts: readonly string[],
): ProjectRoot {
  const inner = probeProjectRoot(useRoot);
  if (hasPnpmCheckGate(inner, extraScripts)) {
    return inner;
  }
  const upgraded = workspaceRootUpgrade(useRoot, maxDepth);
  if (upgraded === useRoot) {
    return inner;
  }
  const outer = probeProjectRoot(upgraded);
  if (detectGate([outer], extraScripts).length > 0) {
    return outer;
  }
  // 外层给不出门禁：退回内层（内层也没有时两者等价，仍然返回外层，保持"没有门禁"这个结论）。
  return detectGate([inner], extraScripts).length > 0 ? inner : outer;
}

/**
 * 从编辑过的文件路径向上找最近的清单根（层数上限 = Config 的 maxRootDepth，不是 volatile
 * 的部署值），每个根读一次磁盘上的实际情况（清单名 + 已声明的脚本）。找不到清单根的文件跳过
 * （没有对应的门禁）。同一个内层根只读一次盘：一轮改几百个文件时逐文件重复读盘没有意义。
 */
function projectRootsOf(
  files: readonly string[],
  maxDepth: number,
  log: Log,
  extraScripts: readonly string[],
): ProjectRoot[] {
  const roots = new Map<string, ProjectRoot>();
  const chosenByInner = new Map<string, ProjectRoot>();
  for (const file of files) {
    const hit = findManifestRoot(file, maxDepth);
    const useRoot = hit.root;
    if (useRoot === undefined) {
      // 留下可见的记录：仓库太深（超出层数仍没有清单）静默跳过，等于漏掉门禁。
      if (hit.hitDepthLimit) {
        log.warn(
          `[quality-gate] no manifest within ${maxDepth} levels of ${file}; gate skipped for it`,
        );
      }
    } else {
      let chosen = chosenByInner.get(useRoot);
      if (chosen === undefined) {
        chosen = rootForFile(useRoot, maxDepth, extraScripts);
        chosenByInner.set(useRoot, chosen);
      }
      // 同一个根只登记一次：结果里一个根只出现一次。
      if (!roots.has(chosen.root)) {
        roots.set(chosen.root, chosen);
      }
    }
  }
  return [...roots.values()];
}

/**
 * 执行一次门禁：只有 exitCode 0 才算通过。
 * 超时、取消、被信号杀死、策略拒绝、工具装不上都走 classifyRun 的显式三态；
 * **catch 一律不报通过**：workdir 不存在、spawn 失败、SandboxUnavailableError
 * 都会落进 catch，把这些当 PASS 就是漏掉一次门禁。
 */
async function runGate(
  messages: QualityGateMessages,
  shell: ShellService,
  gate: Gate,
  budgetMs: number,
  /** 这一次门禁的运行条件：策略按会话解析一次；signal 是 turn signal 与 dispose abort 合成的
   *  信号（**一定有值**——批次开始之前已经和 gateAbort.signal 合并）；stdoutMaxBytes 来自
   *  Config 里那个非 volatile 的部署值；log 是具名 logger（没有就回退 console）。 */
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
      // command 数组来自 gate-detect 的白名单（pnpm/cargo/ruff/tsc 固定词），没有注入。
      command: gateCommandText(gate),
      workdir: gate.root,
      stdoutMaxBytes,
      timeoutMs: budgetMs,
      // 信号总是传下去（回合取消时门禁一起终止；disposer abort 时正在跑的门禁一起终止，
      // 不会留下没人收的门禁进程）。
      signal,
      // 不传 sandboxPolicy 时，沙箱版的 executor 会退到**部署级**策略
      // （根 = 宿主 process.cwd()，并且忽略本会话的 sandbox/mode 覆盖），门禁于是写在
      // 沙箱之外 → 被拒绝 → 产出假的失败指令。必须按会话解析之后再传。
      ...(policy === undefined ? {} : { sandboxPolicy: policy }),
    });
    const exec = await shell.execute(spec);
    outcome = classifyRun(messages, gate, budgetMs, await exec.result(), log);
  } catch (error) {
    log.error(
      `[quality-gate] gate did not run: ${gateCommandText(gate)} @ ${gate.root} — ${messageOf(error)}`,
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

/** apply 在装载时核对过的宿主服务（`isGateHost` 收窄后的结果）：门禁的主体提成模块作用域的
 *  具名函数之后，由 {@link GateRuntime} 带上这一份，交叉类型不必在多处重抄。 */
type GateHost = Context & HostCtx;

/** 记一条门禁结果。detail 压成单行并截断：这是给人看的摘要，不是完整输出。 */
function recordGateResult(
  rt: GateRuntime,
  sessionId: string,
  gate: Gate,
  outcome: GateOutcome,
): void {
  const detail = (outcome.kind === "pass" ? "pass" : outcome.text)
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, RESULT_DETAIL_MAX);
  const rows = rt.recentResults.get(sessionId) ?? [];
  const diagnostics =
    outcome.kind === GATE_KIND_CODE_FAILURE
      ? repoRelativeDiagnostics(gate.root, gate.command, outcome.text, RESULT_DETAIL_MAX)
      : [];
  appendResultRow(rows, {
    at: Date.now(),
    gate: gateCommandText(gate),
    root: gate.root,
    outcome: outcome.kind,
    detail,
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  });
  rt.recentResults.set(sessionId, rows);
  trimSessionResults(rt.recentResults);
}

/**
 * 一次装载（apply）期间的运行时记录：这些字段原本全是 apply 的闭包变量，turn-stopping 的门禁主体
 * 按 `eslint/max-lines-per-function` 的要求拆成模块作用域的具名函数之后，收成一个显式的依赖对象——
 * 一次 apply 建一份，生命周期和原来的闭包一致（每个字段的注释就是原来声明处的注释）。
 * `shellWarned` 和 `disposed` 原本是 apply 里的两个 `let` 标记，在这里是对应的可写字段。
 */
interface GateRuntime {
  svc: GateHost;
  config: ConfigShape;
  log: Log;
  maxRootDepth: number;
  stdoutMaxBytes: number;
  /** 注入文案的语言跟随官方 locale 偏好：每次回合结束时现读，改了语言之后下一次注入就是新的文案。 */
  messages: () => QualityGateMessages;
  /** sessionId → 这个会话自己的编辑累加器（跨会话共用会互相拿走待复查的编辑）。 */
  accumulators: Map<string, EditAccumulator>;
  /** sessionId → 跨回合累计的注入配额状态（followup 每注入一次就开一个新回合，
   *  用 `sessionId:turn` 做键会每回合重置 → 配额永远累计不起来 → 失败循环无限烧 token）。 */
  injectState: Map<string, InjectState>;
  /** sessionId → 上一次 rescan 已经读到的事件 seq（增量窗口：只读新的 tool/call，不重读旧事件）。 */
  lastSeqBySession: Map<string, number>;
  /** 本次装载的记忆反馈不发送的状态（只说一次；见 warnMemorySkip）。 */
  memoryNotice: MemorySkipNotice;
  /**
   * 正在跑的门禁的取消来源（卸载时必须终止并等待正在跑的工作）：disposer
   * abort 它 → 组合信号（turn signal 加上本信号）终止 shell 执行，批次就地结束。
   * 只把 disposed 置成 true 不够：门禁的子进程会活过卸载，结果被没有提示地丢弃。
   */
  gateAbort: AbortController;
  /** 正在跑的门禁批次记录：每一趟后台执行的闭包登记自己的 settle promise，disposer abort 之后
   *  等全部结束（Promise.allSettled 的快照）才真正退出。 */
  inFlightGates: Set<Promise<void>>;
  /** shell 缺失的警告只发一次（没有 shell 时静默通过要留下可见的记录，但别刷屏）。 */
  shellWarned: boolean;
  /** 事件读取接口不存在、读取失败，各只警告一次（整套门禁静默失效必须能看见，但别每回合刷屏）。 */
  queryMissingWarned: boolean;
  queryReadWarned: boolean;
  /** 子代理目录列不出来、个别子代理台账读不出来，各只警告一次（聚合退场不能刷屏）。 */
  teamListWarned: boolean;
  teamReadWarned: boolean;
  /** 编辑台账投影的读取函数：`sessionProjections` 可用时由 inject 回调装上（没有 ⇒ 退回全量扫描）。 */
  editLedger: { value: EditLedgerReader | undefined };
  /** 每个会话最近的门禁结果（环形截断；会话侧栏经官方 Remote 读它）。 */
  recentResults: Map<string, GateResultRow[]>;
  /** 正在跑门禁的根（引用计数）：右键手动跑时据此拒绝与自动批次在同一根上并发。 */
  activeGateRoots: Map<string, number>;
  /** 插件已卸载（disposer 已执行）：新到的回合结束事件整体放弃——不读事件、不跑门禁、不注入。 */
  disposed: boolean;
}

/** 手动门禁从会话 cwd 起找清单根：findManifestRoot 从 dirname 起步，所以补一个不存在的文件名。 */
const MANUAL_PROBE_FILE = "__quality_gate_probe__";

/** 请求里的 sessionId；缺失或不是字符串时给空串。 */
function sessionIdOf(request: unknown): string {
  return isRecord(request) && typeof request["sessionId"] === "string" ? request["sessionId"] : "";
}

/** `agents.get()` 交回的是官方 Agent：只收本包 TurnAgent 要用的那几位。
 *  `status` 与 `inbox` 也要收：手动入口直接读 `status`、注入前判 `inboxHasPending`，
 *  只校验 session + followup 时，一个形状不全的替身会让这两处读到 undefined 而不是被拦下。 */
function isTurnAgent(value: unknown): value is TurnAgent {
  return (
    isRecord(value) &&
    isRecord(value["session"]) &&
    typeof value["status"] === "string" &&
    isRecord(value["inbox"]) &&
    typeof value["followup"] === "function"
  );
}

/** 读"是否已卸载"这个标记：包成函数是为了阻断 TS 对属性的收窄，异步段恢复后才能重新看到 dispose 之后的真实值。 */
function runtimeDisposed(rt: GateRuntime): boolean {
  return rt.disposed;
}

/**
 * 可选依赖 shell 的唯一入口——用 ctx.get（官方的可选服务取法，没注册返回 undefined）。
 *
 * **不能写成 `svc.shell`**：cordis ctx 的 Proxy get 陷阱对没写进 `inject` 的属性
 * 直接抛 `cannot get property "shell" without inject`（见 cordis reflect.ts 的
 * `ReflectService.handler.get`），于是下面的 `=== undefined` 判断永远走不到，
 * 没有 shell 时的放行分支等于不存在，而且每次回合结束都会冒出一个 turn 错误卡。
 * shell 服务由宿主组合（@deepseek-ai/dsh-shell 的 Service 构造时就注册），
 * 正常环境下 get 能命中；只有环境不正常才走放行。
 *
 * **也不加 `?? svc.shell` 回退**：shell 真的缺失时右边的表达式会再次触发同一个抛错，
 * 回退反而把放行打断。测试假对象必须实现 get() 才有意义。
 */
function getShell(rt: GateRuntime): ShellService | undefined {
  // get 的字面量重载已经把 "shell" 这个键的返回类型写成 ShellService | undefined，不需要断言
  return rt.svc.get("shell");
}

/** 取本会话解析后的沙箱策略。`session` 传官方的 `Session` 类本身：
 *  官方 `SandboxPolicyRequest.session` 要的就是这个类（@deepseek-ai/dsh-sandbox-policy/lib/
 *  types/index.d.ts:52），而 `Session` 带私有字段、按名义类型比较 —— 本包那个只为已退役的同步
 *  读取接口存在的 SessionRef 视图传不进去，编译器原话：`Type 'SessionRef' is missing the following
 *  properties from type 'Session': log, surfaceManager, surface, firstLiveSeq, and 18 more`。
 *  这里要的是 turn-stopping 载荷里那个真实的 Session，所以用官方类型而不是视图。 */
function resolvePolicy(
  rt: GateRuntime,
  messages: QualityGateMessages,
  session: Session,
): PolicyResolution {
  const policy = rt.svc.get("sandboxPolicy");
  let result: PolicyResolution;
  if (policy === undefined) {
    // 没有策略服务 = 组合里用的是**不带沙箱**的本地 executor（沙箱版必须 inject sandboxPolicy），
    // 这时候不传策略才是对的：让执行器按它自己不受约束的语义跑。
    result = { kind: "ok", binding: undefined };
  } else {
    try {
      result = {
        kind: "ok",
        binding: { service: policy, policy: policy.resolve({ session }) },
      };
    } catch (error) {
      // 解析失败**绝不**退回到"不传策略"：那会让 harness 用部署级策略（根 = 宿主
      // process.cwd()，并且忽略本会话的 sandbox/mode 覆盖）跑门禁→ 写到沙箱外被拒 →
      // exit≠0 → 假的"修这些错"注入，还会污染记忆和 lesson-loop。改成 not-run。
      result = {
        kind: "unavailable",
        reason: renderTemplate(messages.policyUnresolvable, { message: messageOf(error) }),
      };
    }
  }
  return result;
}

/** 一个绝对路径是否落在某个目录之下（等于该目录也算；`..` 前缀与跨盘符都不算）。 */
function isUnderDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 为这一批门禁临时登记额外可写根（rc.2 的 `sandboxPolicy.registerWritableRoot`）。
 *
 * 触发条件是"`workspace-write` + 门禁根不在本会话的可写边界内"：典型形态是会话开在 monorepo
 * 子包里，而 `pnpm check` / `cargo check` / `tsc` 必须回到仓库根执行——构建产物（`target/`、
 * `.tsbuildinfo`、缓存）写在根下，不在会话 cwd 里。不登记时沙箱拒绝写入 → 命令非零退出 →
 * 假的"修这些错"注入。`read-only` 不登记（那是用户明确选择的只读边界，插件不得提权），
 * `danger-full-access` 不需要登记。Windows 上额外授权只作用于文件工具、不扩大进程权限，
 * 所以那里的登记不会改变门禁进程的结果（宿主语义，不是本包的降级）。
 *
 * 登记返回的是 sandboxPolicy 服务自己的 effect disposer（授权随该服务卸载一起回收）；
 * 本包在批次结束时显式调用它，即使释放失败也只是警告——把已完成的检查结论丢掉才是更糟的结果。
 * @param rt - 装载期运行时
 * @param session - 本次门禁所属的会话（授权只影响这个会话）
 * @param gates - 本回合要跑的门禁（按根去重后登记）
 * @param binding - 解析出来的沙箱绑定；没有沙箱服务时为 undefined
 * @returns 登记得到的释放函数（按登记顺序）
 */
function grantGateRoots(
  rt: GateRuntime,
  session: Session,
  gates: readonly Gate[],
  binding:
    | { readonly service: SandboxPolicyService; readonly policy: SandboxExecutionPolicy }
    | undefined,
): readonly (() => void)[] {
  const releases: (() => void)[] = [];
  if (binding === undefined) {
    return releases;
  }
  const { service, policy } = binding;
  if (policy.mode !== "workspace-write") {
    return releases;
  }
  const covered = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])];
  const registered = new Set<string>();
  for (const gate of gates) {
    if (
      !registered.has(gate.root) &&
      !covered.some((grant) => isUnderDirectory(grant, gate.root))
    ) {
      registered.add(gate.root);
      try {
        releases.push(service.registerWritableRoot(session, gate.root));
      } catch (error) {
        // 登记失败不阻断门禁：命令仍会跑，最坏情况是产物写不出去而报成失败——但这条警告
        // 让人能区分"代码有问题"和"授权没登记上"。
        rt.log.warn(
          `[quality-gate] writable-root registration failed for ${gate.root}: ${messageOf(error)}`,
        );
      }
    }
  }
  return releases;
}

/**
 * 会话自己的累加器（没有就建；建完按会话预算淘汰最旧的其他会话）。
 * 条目**不会因为 drain 就释放**：留着才让"本会话自己"这条记录是连续的（下一回合复用同一个实例，
 * 容量淘汰的计数也不会跑到别的会话上），总大小由 SESSION_BUDGET 收住。
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

/** 把一条编辑并入累加器：相对路径按**该编辑所属会话**的 cwd 解析（edit 常常给相对路径；
 *  不按宿主进程的 CWD）。根会话与子代理共用这一处，避免两套解析规则各改各的。 */
function noteEdit(
  acc: EditAccumulator,
  cwd: string | undefined,
  name: string,
  pathValue: string | undefined,
): void {
  let resolvedPath = pathValue;
  if (resolvedPath !== undefined && cwd !== undefined && !path.isAbsolute(resolvedPath)) {
    resolvedPath = path.resolve(cwd, resolvedPath);
  }
  acc.note(name, resolvedPath);
}

/**
 * 台账条目 → 可解析的路径。
 *
 * 承重细节（v3 台账的 `EditLedgerEntry.cwd`）：相对 `path` **必须按条目自己的 cwd 解析**，
 * 不能一律用会话当前目录——换目录之后，历史条目记的是当时的目录，按现在的目录解析会把
 * 文件指到别处（甚至别的项目根）。条目 cwd 为空（旧数据/事件里没有工作目录）时才回落到
 * 调用方给的当前目录。返回绝对路径后，下游的 `noteEdit` 不会再解析一次。
 *
 * @param entry - 台账条目
 * @param fallbackCwd - 条目没有 cwd 时的兜底目录
 * @returns 绝对路径、原样绝对路径，或 undefined（路径为空）
 */
function ledgerPathOf(entry: EditLedgerEntry, fallbackCwd: string | undefined): string | undefined {
  let resolved: string | undefined;
  const rawPath = entry.path;
  if (rawPath.length > 0) {
    const base = entry.cwd === "" ? fallbackCwd : entry.cwd;
    resolved =
      base !== undefined && !path.isAbsolute(rawPath) ? path.resolve(base, rawPath) : rawPath;
  }
  return resolved;
}

/**
 * 只用投影出来的编辑台账来记本回合的编辑。返回 false = 走不了投影（读取函数没有、fork 会话、
 * 读到的数不可信，或者会话给不出日志长度），调用方改用观察接口。
 *
 * fork 会话（isSeeded）不走这条路：继承前缀的确切长度只有观察接口的 `inheritedEventCount`
 * 给得出，投影的 `apply` 看不到那条边界。读取函数返回 undefined 时同样改用观察接口，而且**不推进游标**——
 * 把一次读不到当成"没有编辑"，会静默跳过本回合的门禁。
 */
function noteLedgerEdits(
  rt: GateRuntime,
  session: TurnAgent["session"],
  note: (name: string, pathValue: string | undefined) => void,
  fallbackCwd: string | undefined,
  firstFrom: number,
): boolean {
  const reader = rt.editLedger.value;
  const directSeq = session.seq;
  if (reader === undefined || session.header.isSeeded || typeof directSeq !== "number") {
    return false;
  }
  const ledger = reader(session);
  if (ledger === undefined) {
    return false;
  }
  const from = rt.lastSeqBySession.get(session.id) ?? firstFrom;
  // 编辑台账有条数上限（EDIT_LEDGER_MAX），超限时旧的条目被丢掉；这时候如果直接把游标推到日志末尾，
  // 被丢掉的那些 seq 就再也读不到了。所以只推进到台账实际覆盖到的末尾，下一回合还能从缺口重读。
  let covered = from;
  for (const entry of ledger) {
    covered = Math.max(covered, entry.seq + 1);
    if (entry.seq >= from && countsAsEdit(entry.outcome)) {
      note(entry.name, ledgerPathOf(entry, fallbackCwd));
    }
  }
  rt.lastSeqBySession.set(session.id, Math.min(directSeq, covered));
  pruneToSessionBudget(rt.lastSeqBySession, session.id);
  return true;
}

/**
 * 从事件流读本回合**成功**编辑的文件（按官方观察接口给的增量窗口），记进本会话的记录。
 * 被 danger-guard 拒绝或执行失败的编辑，它的 tool/call 仍在事件流里——照记就会对没有真正
 * 改动的文件（如果它在另一个项目根）多跑一次门禁。所以 tool/call 先建 callId→{name,path}，
 * tool/result 的 isError 把对应的 callId 标为失败，只记成功的。
 * turn-stopping 时本回合的 call 和 result 在同一个增量窗口里，扫一次就能关联；没有 callId 的事件
 * （异常、旧形状、测试 mock）保守地直接记录，避免漏掉门禁。
 * fork 前缀：子代理会话从父会话 fork 时，
 * 事件流里带着父事件的前缀，游标从 0 开始首读会把父会话的历史编辑一起算进来、多跑门禁。
 * Session.inheritedEventCount（0.1.2-rc.1 起公开的只读属性）给出 fork 的位置——首读的下限
 * 取这个位置而不是 0，父会话的前缀自然跳过；属性缺失时退回 0（和旧行为一样，保守地不漏门禁）。
 */
/** 官方工作目录服务的最小读取形状（`WorkingDirectoryService.get(session)` 同步、无 fs I/O）。 */
interface WorkingDirectoryFace {
  get?: WorkingDirectoryService["get"];
}

function isWorkingDirectory(value: unknown): value is WorkingDirectoryFace {
  if (!isRecord(value)) {
    return false;
  }
  return value["get"] === undefined || typeof value["get"] === "function";
}

/** 会话**当前**工作目录：`ctx.workingDirectory.get(session)` 优先，服务缺席或给不出非空串时
 *  回落 `session.header.cwd`（创建期快照）。`header.cwd` 在换目录后仍是建会话时的旧值，门禁的
 *  相对路径解析、记忆归属与总线载荷都必须用活目录。 */
function liveSessionCwdOf(agent: TurnAgent): string | undefined {
  const service: unknown = agent.ctx?.get("workingDirectory");
  if (isWorkingDirectory(service)) {
    const live: unknown = service.get?.(agent.session);
    if (typeof live === "string" && live.length > 0) {
      return live;
    }
  }
  const raw: unknown = agent.session.header.cwd;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** 官方 `AgentRegistry.turnBoundaryOf(session)` 里本包用到的两位。 */
interface TurnBoundaryFace {
  /** 当前未结束回合的起始 seq；`turn/end` 之后清空（null/undefined）。 */
  readonly openTurnStartSeq?: number | null;
  /** 最近一次 `turn/start` 的回合号。 */
  readonly lastTurn?: number;
}

/**
 * 读一次官方回合边界（`ctx.agents.turnBoundaryOf`）。
 *
 * 用途两处：① 首次见到某个会话时，把事件窗下限收在本回合起点，而不是盲目从 0 重放整份历史；
 * ② 门禁批次跑完时确认"这个结果仍属于发起它的回合"，跨回合的迟到结果不能注入到新回合里。
 * 服务缺席或形状不符时返回 undefined——两个调用点都按"没有信息就不加判据"处理，行为与未加这一判据时一致。
 *
 * @param rt - 装载期运行时
 * @param session - 官方 Session
 * @returns 边界的窄视图，或 undefined
 */
function turnBoundaryOf(rt: GateRuntime, session: unknown): TurnBoundaryFace | undefined {
  let boundary: TurnBoundaryFace | undefined;
  const service: unknown = rt.svc.get("agents");
  if (isRecord(service) && typeof service["turnBoundaryOf"] === "function") {
    const raw: unknown = Reflect.apply(service["turnBoundaryOf"], service, [session]);
    if (isRecord(raw)) {
      const open = raw["openTurnStartSeq"];
      const last = raw["lastTurn"];
      const openSeq = typeof open === "number" ? open : null;
      boundary =
        typeof last === "number"
          ? { openTurnStartSeq: openSeq, lastTurn: last }
          : { openTurnStartSeq: openSeq };
    }
  }
  return boundary;
}

/**
 * 门禁结果是否属于已经过去的回合：`lastTurn` 已前进时返回当前回合号（调用方据此丢弃结果）。
 *
 * @param rt - 装载期运行时
 * @param session - 发起批次的会话
 * @param turn - 发起批次的回合号
 * @returns 当前回合号（结果过期），或 undefined（仍属于本回合 / 读不到边界）
 */
function staleTurnOf(rt: GateRuntime, session: unknown, turn: number): number | undefined {
  const boundary = turnBoundaryOf(rt, session);
  return boundary?.lastTurn !== undefined && boundary.lastTurn !== turn
    ? boundary.lastTurn
    : undefined;
}

async function readEditedFiles(
  rt: GateRuntime,
  agent: TurnAgent,
  acc: EditAccumulator,
): Promise<void> {
  const { session } = agent;
  const sessionId = session.id;
  // 没有事件读取接口 = 整套门禁都不工作（不是"这一回合没有编辑"）：和没有 shell 属于同一类事实，
  // 所以同样只 warn 一次，而不是静默 return。读取失败（会话已卸载/存储读不出/不符合契约的交付）
  // 可能只是个别会话的瞬时状态，也只说一次——否则每个回合刷一行。
  const query = rt.svc.get("sessionQuery");
  if (query === undefined) {
    if (!rt.queryMissingWarned) {
      rt.queryMissingWarned = true;
      rt.log.warn(
        "[quality-gate] sessionQuery service unavailable; edit accounting is off, so no gate will run",
      );
    }
    return;
  }
  const cwd = liveSessionCwdOf(agent);
  const note = (name: string, pathValue: string | undefined): void => {
    noteEdit(acc, cwd, name, pathValue);
  };
  const firstFrom = turnBoundaryOf(rt, session)?.openTurnStartSeq ?? 0;
  if (noteLedgerEdits(rt, session, note, cwd, firstFrom)) {
    return;
  }
  const window = await resolveEventWindow(query, sessionId, rt.lastSeqBySession, firstFrom);
  if (window === undefined) {
    if (!rt.queryReadWarned) {
      rt.queryReadWarned = true;
      rt.log.warn(
        "[quality-gate] session event read returned no window; this turn's gate is skipped (further read failures stay silent)",
      );
    }
    return;
  }
  // 游标按"起始 seq + 本次返回的条数"推进（seq 从 0 连续，见 resolveEventWindow 里关于切片的说明）。
  rt.lastSeqBySession.set(sessionId, window.from + window.events.length);
  // 游标 Map 超出预算时按插入顺序淘汰最旧的其他会话（不整个清空 → 避免全量重读历史）。
  pruneToSessionBudget(rt.lastSeqBySession, sessionId);
  const edits = collectEdits(window.events);
  for (const entry of edits.records) {
    // 审批被拒、派发前取消与普通失败不记录（以 tool/result 的结算身份为准）；
    // 没有 callId 的条目没有关联依据，保守地直接记录。
    const outcome = entry.callId === undefined ? undefined : edits.outcomes.get(entry.callId);
    if (outcome === undefined || countsAsEdit(outcome)) {
      note(entry.name, entry.path);
    }
  }
}

/** 子代理台账快照：台账本体、继承前缀长度、cwd 与日志末尾。
 *  全部从一次 observation 的不可变切面读出，出参是脱离 Session 的普通值。 */
interface ChildLedgerSnapshot {
  readonly entries: readonly EditLedgerEntry[];
  readonly inherited: number;
  readonly cwd: string | undefined;
  readonly end: number | undefined;
}

/**
 * 从 observation 的不可变事件窗重放本包自己的编辑台账。
 *
 * `editLedgerProjection` 是 host-only 投影（没有 `wire`），`ProjectionSnapshot.snapshot()`
 * 只收集带 `wire` 的投影，所以不能从 `projections.values[EDIT_LEDGER_KEY]` 读。这里按官方
 * 的同一套 `init/apply` 折叠规则在本地重放：fork 前缀不重放，剩余事件逐条交给投影。
 * `workingDirectory` 是带 `wire` 的投影，优先读它；缺失时回落 header.cwd（创建期快照）。
 * @param observation - `observeSession(id, { projectionMode: "all" })` 的切面
 * @returns 脱离 observation 的普通值
 */
function childLedgerSnapshot(observation: SessionObservationFace): ChildLedgerSnapshot {
  const inherited = observation.inheritedEventCount ?? 0;
  const headerCwd = isRecord(observation.header) ? observation.header.cwd : undefined;
  let state: EditLedgerState = {
    cwd: typeof headerCwd === "string" ? headerCwd : "",
    edits: [],
  };
  for (const event of observation.events) {
    const seq = fieldOf(event, "seq");
    if (typeof seq === "number" && seq >= inherited) {
      state = editLedgerProjection.apply(state, event);
    }
  }
  const projectedCwd: unknown =
    observation.projections === undefined
      ? undefined
      : Reflect.get(observation.projections.values, "workingDirectory");
  let cwd: unknown = state.cwd;
  if (cwd === "") {
    cwd = typeof projectedCwd === "string" ? projectedCwd : headerCwd;
  }
  return {
    entries: state.edits,
    inherited,
    cwd: typeof cwd === "string" ? cwd : undefined,
    end: typeof observation.cursor === "number" ? observation.cursor + 1 : undefined,
  };
}
/** 子代理台账聚合的结果：`文件 → 改过它的子代理名`（推迟本轮由 `teamInputFor` 用
 *  `undefined` 表达，不再在这个结果里带一次恒为 false 的标记）。 */
interface TeamEdits {
  readonly namesByPath: ReadonlyMap<string, ReadonlySet<string>>;
}

/** 没有队友台账可聚合时的结果（subagents/agents/sessionQuery 缺失、列不出目录）。 */
const NO_TEAM_EDITS: TeamEdits = { namesByPath: new Map() };

/** 从一行 catalog 条目里读出的子代理信息（`{ kind: 'child', id, path?, activity }`）。 */
interface TeamMember {
  readonly id: SessionId;
  readonly name: string;
}

/** catalog 行的 id 在官方契约里就是 `SessionId`（phantom brand，运行期是非空字符串）。
 *  这里把"非空字符串"的校验结果直接收窄成官方标识类型——不再引入 dsh-brand 的值导入。 */
function isSessionId(value: string): value is SessionId {
  return value !== "";
}

/**
 * 子代理行的坏形状一律跳过：官方 `listDescendants` 交回 `kind: 'diagnostic'` 的诊断行
 * （catalog 损坏/不可读/模式未知），以及跨版本可能缺位的字段。诊断行不代表没有这个子代理，
 * 但也不足以读它的台账——跳过比猜一个 id 更安全。
 * @param row - `listDescendants` 的一行
 * @returns 子代理的 id 与展示名；不是可用的 child 行时 undefined
 */
function teamMemberOf(row: unknown): TeamMember | undefined {
  let member: TeamMember | undefined;
  if (isRecord(row) && row["kind"] === "child") {
    const { id, path: rowPath, label } = row;
    if (typeof id === "string" && isSessionId(id)) {
      // 展示名优先级 path > label > id：`path` 已包含 `name` 与层级（list-children 只在有 name 时
      // 拼 path），比单取 name 更能说明"哪个子代理"；label 是 continuable 的资源标签。
      const name =
        (typeof rowPath === "string" && rowPath !== "" ? rowPath : undefined) ??
        (typeof label === "string" && label !== "" ? label : undefined) ??
        id;
      member = { id, name };
    }
  }
  return member;
}

/** `ctx.subagents` 里本包用到的方法（服务由 @deepseek-ai/dsh-subagent 提供，本包不依赖它，
 *  所以按运行时形状读取：`listDescendants(rootId, signal)` 递归列出本树子代理）。 */
interface SubagentFace {
  readonly listDescendants: (
    rootSessionId: SessionId,
    signal?: AbortSignal,
  ) => Promise<readonly unknown[]>;
}

/**
 * 取 `ctx.subagents` 的结构视图。本包的 Context 里没有这个服务的类型（没装 subagent 包），
 * `get` 的字符串重载因此返回 any；直接使用会踩 `no-unsafe-*` 系列规则，而且会在服务形态
 * 变化时静默出错。这里按"对象 + 可调用的 listDescendants"校验一次，之后只经这个窄视图调用。
 * @param rt - 装载期运行时
 * @returns 可用的服务视图，或 null（组合里没有、形态不符）
 */
function subagentsOf(rt: GateRuntime): SubagentFace | null {
  const service: unknown = rt.svc.get("subagents");
  if (!isRecord(service)) {
    return null;
  }
  const { listDescendants } = service;
  if (typeof listDescendants !== "function") {
    return null;
  }
  return {
    listDescendants: async (rootSessionId, signal) => {
      const rows: unknown = await Reflect.apply(listDescendants, service, [rootSessionId, signal]);
      // Array.isArray 收窄出来的是 any[]：逐项搬进 unknown[]，避免把 any 扩散给调用方。
      const parsed: unknown[] = [];
      if (Array.isArray(rows)) {
        for (const row of rows) {
          parsed.push(row);
        }
      }
      return parsed;
    },
  };
}

/** live agent 的 id → status 表；没有 agents 服务或形态不符时 null。 */
function agentStatusesOf(rt: GateRuntime): ReadonlyMap<string, unknown> | null {
  const service: unknown = rt.svc.get("agents");
  if (!isRecord(service)) {
    return null;
  }
  const { list } = service;
  if (typeof list !== "function") {
    return null;
  }
  const rows: unknown = Reflect.apply(list, service, []);
  if (!Array.isArray(rows)) {
    return null;
  }
  const statuses = new Map<string, unknown>();
  for (const agent of rows) {
    if (isRecord(agent) && typeof agent["id"] === "string") {
      statuses.set(agent["id"], agent["status"]);
    }
  }
  return statuses;
}

/** 本树里正在执行回合的子代理（`activity` 只说明是否驻留，真正要看 Agent 的 status）。
 *  没有 agents 服务时返回 null——调用方据此整体放弃聚合：读不到运行状态就分不清
 *  "队友正在改这棵树"和"队友已经停手"，此时跑门禁会产出假失败。 */
function runningTeammates(
  rt: GateRuntime,
  members: readonly TeamMember[],
): readonly TeamMember[] | null {
  const statuses = agentStatusesOf(rt);
  return statuses === null
    ? null
    : members.filter((member) => statuses.get(member.id) === "running");
}

/** 子代理台账里本回合新增的编辑 → 会话累加器，并记下"哪个文件被哪个子代理改过"。 */
function absorbChildLedger(
  rt: GateRuntime,
  member: TeamMember,
  snapshot: ChildLedgerSnapshot,
  note: (name: string, pathValue: string | undefined) => void,
  namesByPath: Map<string, Set<string>>,
): void {
  const from = Math.max(
    snapshot.inherited,
    rt.lastSeqBySession.get(member.id) ?? snapshot.inherited,
  );
  let covered = from;
  for (const entry of snapshot.entries) {
    covered = Math.max(covered, entry.seq + 1);
    if (entry.seq >= from && countsAsEdit(entry.outcome) && entry.path !== "") {
      // 相对路径按**该编辑发生时会话的 cwd** 解析：条目自带的 cwd 比快照级 cwd 更准
      // （子代理可能在同一回合里换过目录）；条目没有记录时回落快照级值。
      const entryCwd = entry.cwd === "" ? snapshot.cwd : entry.cwd;
      const resolved =
        entryCwd !== undefined && !path.isAbsolute(entry.path)
          ? path.resolve(entryCwd, entry.path)
          : entry.path;
      note(entry.name, resolved);
      const names = namesByPath.get(resolved) ?? new Set<string>();
      names.add(member.name);
      namesByPath.set(resolved, names);
    }
  }
  const next = snapshot.end === undefined ? covered : Math.min(snapshot.end, covered);
  rt.lastSeqBySession.set(member.id, next);
  pruneToSessionBudget(rt.lastSeqBySession, member.id);
}

/**
 * 列出本树的具名子代理（经 {@link subagentsOf} 的运行时视图）。
 * @returns 可用的成员；服务缺失时为 null（调用方直接退场），列目录失败时为 null 并警告一次
 */
async function listTeamMembers(
  rt: GateRuntime,
  session: TurnAgent["session"],
  signal: AbortSignal | undefined,
): Promise<readonly TeamMember[] | null> {
  const subagents = subagentsOf(rt);
  if (subagents === null) {
    return null;
  }
  let rows: readonly unknown[];
  try {
    rows = await subagents.listDescendants(session.id, signal);
  } catch (error) {
    if (!rt.teamListWarned) {
      rt.teamListWarned = true;
      rt.log.warn(
        `[quality-gate] subagent listing unavailable; teammate edits are not aggregated: ${messageOf(error)}`,
      );
    }
    return null;
  }
  const members: TeamMember[] = [];
  for (const row of rows) {
    const member = teamMemberOf(row);
    if (member !== undefined) {
      members.push(member);
    }
  }
  return members;
}

/** 冷会话读的硬上限：队友台账只是"补充归因"，不值得让一回合的收尾等它太久。 */
const COLD_READ_TIMEOUT_MS = 15_000;

/**
 * 冷读用的组合信号：回合取消 + 超时。`sessionQuery.observeSession` 官方支持 `signal`（冷读可取消），
 * 此前未传 signal，队友会话读得慢时整批门禁会被拖住。超时按"读不到"处理（每份台账独立退场），
 * 不影响根会话自己的门禁。
 *
 * @param signal - 回合信号（可能没有）
 * @returns 一定非空的组合信号
 */
function coldReadSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(COLD_READ_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * 队友是否仍在跑（决定本轮门禁推迟与否）。
 *
 * 拆出来的原因：`listDescendants` + `agents.list` 都是廉价调用，可以在 serial 的 turn-stopping 里
 * await；而**冷会话台账重放**（observeSession）可能很慢，必须放进后台批次。两者混在一个
 * `collectTeamEdits` 里时，串行监听器会被冷读拖到十几秒——注释里"只 await 一次本地日志读取"
 * 的说法也就不成立了。
 *
 * @returns true=推迟；false=可以聚合；null=读不到运行状态（不聚合、不推迟）
 */
function teamGateDeferred(
  rt: GateRuntime,
  session: TurnAgent["session"],
  members: readonly TeamMember[],
): boolean | null {
  const running = runningTeammates(rt, members);
  if (running === null) {
    if (!rt.teamListWarned) {
      rt.teamListWarned = true;
      rt.log.warn(
        "[quality-gate] agents service unavailable; teammate edits are not aggregated and the gate is not deferred",
      );
    }
    return null;
  }
  const deferred = running.length > 0;
  if (deferred) {
    rt.log.info(
      `[quality-gate] ${session.id}: gate deferred; teammate(s) still running: ${running.map((member) => member.name).join(", ")}`,
    );
  }
  return deferred;
}

/**
 * 聚合队友台账（调用方已确认没有队友在跑）：经 `observeSession` 读各自的编辑台账事件窗
 * （按游标增量重放）并记下归因。任何一次读失败或超时只让那一份退场。
 */
async function mergeTeamLedgers(
  rt: GateRuntime,
  members: readonly TeamMember[],
  note: (name: string, pathValue: string | undefined) => void,
  signal: AbortSignal | undefined,
): Promise<TeamEdits> {
  const query = rt.svc.get("sessionQuery");
  if (query === undefined) {
    // 没有 query 服务就不聚合：子代理的事件窗不是本包的领域状态，退回全量扫描会让根会话
    // 的游标语义分叉。
    return NO_TEAM_EDITS;
  }
  const namesByPath = new Map<string, Set<string>>();
  const cold = coldReadSignal(signal);
  await Promise.all(
    members.map(async (member) => {
      let observation: SessionObservationFace | undefined;
      try {
        observation = await query.observeSession(member.id, {
          projectionMode: "all",
          signal: cold,
        });
        const snapshot = childLedgerSnapshot(observation);
        absorbChildLedger(rt, member, snapshot, note, namesByPath);
      } catch (error) {
        if (!rt.teamReadWarned) {
          rt.teamReadWarned = true;
          rt.log.warn(
            `[quality-gate] teammate edit read failed; its files are not aggregated: ${messageOf(error)}`,
          );
        }
      } finally {
        try {
          observation?.[Symbol.dispose]();
        } catch {
          // 释放失败不改变本次读取的结论。
        }
      }
    }),
  );
  return { namesByPath };
}

/** 把"文件 → 子代理名"折叠成"门禁根 → 子代理名"（只保留真正有门禁的根，名字排序后去重）。 */
function teammatesByRoot(
  gates: readonly Gate[],
  namesByPath: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, readonly string[]> {
  const byRoot = new Map<string, Set<string>>();
  for (const [file, names] of namesByPath) {
    for (const gate of gates) {
      if (isUnderDirectory(gate.root, file)) {
        const collected = byRoot.get(gate.root) ?? new Set<string>();
        for (const name of names) {
          collected.add(name);
        }
        byRoot.set(gate.root, collected);
      }
    }
  }
  return new Map(Array.from(byRoot, ([root, names]) => [root, [...names].toSorted()] as const));
}

/**
 * 一次回合结束（turn-stopping）在开始阶段解析出的回合级上下文：失败处理和批次执行都要读它。
 * 一个个当参数传会超过 `eslint/max-params` 的上限，所以收成一个显式的依赖对象；取值的时机
 * 和原来的闭包一致（`settingsOf` 和 `localeMessages` 各读一次，回合内不再重读）。
 */
interface TurnScope {
  rt: GateRuntime;
  agent: TurnAgent;
  /** 本回合一次读全的设置快照。 */
  cfg: ResolvedSettings;
  messages: QualityGateMessages;
  sessionId: string;
  turn: number;
  /** 会话的**项目** cwd（`session.header.cwd` 的建会话快照）：只用于记忆与总线的项目归属。
   *  相对路径解析与门禁工作目录走的是活目录，见 handleTurnGate 里的 `resolveCwd`。 */
  cwd: string | undefined;
  /** 这个 turn 自己的取消信号（载荷里可能没有，没有时门禁只随 dispose abort 终止）。 */
  signal: AbortSignal | undefined;
}

/**
 * 处理一次门禁失败（代码错误或者没跑成）：上报 + 第二次确认 + 配额 + 注入；返回是否停止剩余的门禁。
 * **同步**：整段（bus 上报、第二次确认、配额记录、followup 注入、日志）都在原地完成，没有任何
 * 需要等待的 await——`memoryFeedback` 那一笔是刻意放到后台的补充（在下面 `void` 掉：它失败不得
 * 回滚一次已经成功的注入，更不能拖住回合），把它 await 进来会改变语义。留着 `async` 只会给
 * 调用点多塞一个微任务，所以按实际的形状改成同步（eslint/typescript require-await 同样是这个判断）。
 */
function handleGateFailure(
  scope: TurnScope,
  target: Gate,
  problem: GateProblem,
  teammates: readonly string[] = [],
): boolean {
  const { rt, agent, cfg, messages, sessionId, turn, cwd } = scope;
  const { log, injectState, memoryNotice } = rt;
  // 回合判据：批次是 detached 的，可能在回合已经收口之后才拿到结果。turn signal 从不 abort
  // （宿主开下一回合只换 controller、不 abort 上一个），所以只靠 signal 拦不住"上一回合的门禁把
  // 失败注入进下一回合"。这里以官方边界为准：`lastTurn` 已经不是发起批次的那个回合就丢弃。
  const staleTurn = staleTurnOf(rt, agent.session, turn);
  if (staleTurn !== undefined) {
    log.warn(
      `[quality-gate] ${sessionId}: stale gate result for turn ${turn} dropped (current turn ${staleTurn})`,
    );
    return true;
  }
  const maxInjects = cfg.maxInjectsPerTurn;
  const isCodeFailure = problem.kind === GATE_KIND_CODE_FAILURE;
  // 归因只进"给模型的修复指令"：总线/记忆记的是失败事实本身，不能掺入会随队友变化的描述。
  const injectText =
    isCodeFailure && teammates.length > 0
      ? `${problem.text}\n${renderTemplate(messages.teammatesEdited, { names: teammates.join(", ") })}`
      : problem.text;
  reportProblemToBus(rt.svc.get, { sessionId, turn, cwd }, target, problem, log);
  // 注入之前的第二次确认：被拦下时打日志，方便排查"门禁失败却没有注入"
  const check = preInjectCheck(agent, scope.signal);
  if (!check.ok) {
    log.warn(`[quality-gate] ${sessionId}: injection skipped (${check.reason}) at turn ${turn}`);
    return true;
  }
  const st = injectState.get(sessionId) ?? { count: 0, gaveUp: false };
  // 配额用完：注入一次用户可见的放行说明，之后保持静默，直到干净通过才重置。
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
  // 确认失败、第二次检查也通过之后才扣配额（和 followup 在同一个同步段里完成，中间没有 await）
  st.count += 1;
  injectState.set(sessionId, st);
  pruneToSessionBudget(injectState, sessionId);
  try {
    agent.followup(
      injectMessage(
        isCodeFailure
          ? gateText(messages, target, injectText)
          : notRunText(messages, target, problem.text),
      ),
    );
    log.info(
      `[quality-gate] ${sessionId}: ${isCodeFailure ? "gate failure" : "gate not-run"} injected at turn ${turn} (attempt ${st.count}/${maxInjects})`,
    );
    // memoryFeedback 挪到 followup 成功之后——followup 抛错时不写记忆
    // （避免"记忆已写而注入没发生"，也避免重复失败把记忆库刷满）。
    // 而且只写"代码失败"：没跑成的检查不是工程教训，写进去就是污染记忆。
    if (isCodeFailure && cfg.memoryFeedback) {
      void pushFeedbackToMemory(rt.svc.get, memoryNotice, cfg, messages, {
        cwd,
        command: target.command,
        root: target.root,
        failure: problem.text,
      });
    }
    // 一次只注入一个失败（修完一个再看下一个）
    return true;
  } catch (error) {
    // followup 失败：把配额计数退回去（这次注入没有发生），也不写记忆。
    st.count -= 1;
    injectState.set(sessionId, st);
    log.error(`[quality-gate] ${sessionId}: followup failed: ${messageOf(error)}`);
    return false;
  }
}

/** 卸载之后怎么读这个标记：两次判断之间隔着 `await runGate(...)`，那期间 disposer 的 abort() 是真会
 *  发生的（卸载后的处理由测试钉住）；直接读 `gateAbort.signal.aborted` 会被控制流分析钉在上一次
 *  判断的 false 上（属性的收窄不会跨过 await 复位），后一处判断就被判成永远不成立。改成函数取值 ⇒ 每次读都按
 *  声明的 boolean 算，这个判断才是必要的。 */
function gateAborted(rt: GateRuntime): boolean {
  return rt.gateAbort.signal.aborted;
}

/** 一批门禁的输入：handleTurnGate 探测完要跑的门禁、解析完策略、合并完信号之后交下来的全部依赖。 */
interface GateBatchInput {
  scope: TurnScope;
  gates: readonly Gate[];
  shell: ShellService;
  resolved: PolicyResolution;
  /** 批次的执行信号：turn signal（回合取消时一起终止）与 dispose abort（卸载时终止）合并后的结果。 */
  signal: AbortSignal;
  /** 所有门禁的总时长预算（Config 的 `gateBudgetMs`，本回合读定的值）。 */
  budget: number;
  /** 本批临时登记的额外可写根释放函数（`grantGateRoots`；没有登记时为空）。 */
  grants: readonly (() => void)[];
  /** 门禁根 → 也改过该根下文件的具名子代理（注入失败说明时归因用）。 */
  collaborators: ReadonlyMap<string, readonly string[]>;
}

/** 批次开始之后的派生值与可变状态：`started` 在进入异步段时算定，`batch` 见它的注释。 */
interface GateBatchState extends GateBatchInput {
  started: number;
  batch: { blocked: boolean };
}

/**
 * 单条门禁这一趟能拿到的窗口：**从共享池里先到先得，但要给后面的门禁留出最小可用份额**。
 *
 * 均分（`budget / gates.length`）在真实仓库上是错的：一条 `pnpm check` 在伞工作区根上串行跑
 * 十几个仓，实测 240s（`node scripts/check-all.mjs`：`real 240.68`，十个仓逐个跑完），而单仓
 * `pnpm check` 也要 64s。按条数均分时（600s / 10 条 = 60s）每一条的窗口都**短于一次门禁的固有耗时**，
 * 于是必然全部超时——报出来的却是「60s 预算内未完成」，看起来像配置没设置，实际是分配规则注定跑不完。
 *
 * 改成共享池：第一条先拿 `remaining - 后面每条的保底`。后面没有门禁时它就能用掉整个剩余预算；
 * 有 N 条待跑时给它们各留 `MIN_USEFUL_GATE_MS`（低于这个值跑门禁只会得到假超时，`processGate`
 * 本来就会跳过并注入"未执行"）。这样"一条长门禁 + 若干短门禁"的组合不会因为均分而被一起掐死。
 */
function windowFor(remaining: number, laterGates: number): number {
  const reserved = laterGates * MIN_USEFUL_GATE_MS;
  return Math.max(MIN_USEFUL_GATE_MS, remaining - reserved);
}

/**
 * 一条接一条地跑门禁（判断之间有顺序依赖：预算封顶 + 每次只注入一个失败），
 * 用尾递归往下走代替 for+await（避开 no-await-in-loop，语义不变）。
 */
async function processGate(state: GateBatchState, left: readonly Gate[]): Promise<void> {
  const { scope, shell, resolved, signal, budget, started, batch, collaborators } = state;
  const { rt } = scope;
  const [gate] = left;
  if (gate === undefined) {
    return;
  }
  // 卸载后的处理由调用方在批次开始之前（handleTurnGate 的 runtimeDisposed）和每条检查结果出来之后
  // （下面的 gateAborted）各判一次；这里不再重复判一遍——两处已经覆盖"开始时就已卸载"和
  // "执行期间卸载"，中间只剩同步段，没有可以插入卸载的 await。
  const remaining = budget - (Date.now() - started);
  if (remaining < MIN_USEFUL_GATE_MS) {
    batch.blocked = true;
    const skipped: GateOutcome = {
      kind: "not-run",
      text: skippedText(scope.messages, left, remaining),
    };
    recordGateResult(rt, scope.sessionId, gate, skipped);
    handleGateFailure(scope, gate, skipped);
    return;
  }
  // 沙箱策略解析不出来 → 一条都不执行（not-run），绝不退回到部署级策略。
  // 这一条能用多少：剩余预算扣掉后面每条的最小可用份额（见 windowFor：均分在真实仓库上注定不够）。
  const window = windowFor(remaining, left.length - 1);
  const precheck = dependencyPrecheckOutcome(scope.messages, gate, rt.log);
  const outcome: GateOutcome =
    resolved.kind === "unavailable"
      ? { kind: "not-run", text: resolved.reason }
      : (precheck ??
        (await runGate(scope.messages, shell, gate, window, {
          policy: resolved.binding?.policy,
          signal,
          stdoutMaxBytes: rt.stdoutMaxBytes,
          log: rt.log,
        })));
  // 卸载之后：abort 才回来的迟到结果一律就地丢掉——不上报 lesson-loop（被中止的
  // 检查既不是代码失败的事实，也不是"请手动跑一次"的素材）、不注入。只靠 disposed 标记在注入前
  // 拦是不够的：门禁的子进程会活过卸载。
  if (gateAborted(rt)) {
    return;
  }
  recordGateResult(rt, scope.sessionId, gate, outcome);
  if (outcome.kind === "pass") {
    await processGate(state, left.slice(1));
    return;
  }
  batch.blocked = true;
  const mustStop = handleGateFailure(scope, gate, outcome, collaborators.get(gate.root) ?? []);
  if (!mustStop) {
    await processGate(state, left.slice(1));
  }
}

/** 释放本批登记的额外可写根；单个释放失败只警告，不能把已完成的门禁结论丢掉。 */
function releaseGrants(rt: GateRuntime, grants: readonly (() => void)[]): void {
  for (const release of grants) {
    try {
      release();
    } catch (error) {
      rt.log.warn(`[quality-gate] writable-root release failed: ${messageOf(error)}`);
    }
  }
}

/**
 * 一批门禁：总预算封顶、按上面的共享池逐条取窗口——跟踪已经花掉的时间，每条最多用完剩余预算
 * （扣掉后面每条的保底份额）。剩下的时间不够最小可用预算时（真实的 tsc/pnpm 冷启动也要几秒，几百 ms
 * 必然超时 → 注入一条假的"超时失败"）**注入未执行的说明**——只 console.warn 等于静默通过。
 *
 * 两处防御：①整段最外层 try/catch——批次自己出问题只记一条 error，绝不产生
 * unhandledRejection；②批次的 promise 由调用方登记到"正在跑"的集合里，disposer abort 之后 await
 * 到全部结束（卸载必须终止并等待正在跑的工作）。临时登记的可写根在 finally 里释放：无论通过、
 * 失败、被跳过还是批次自己抛错，授权都不会留到下一回合。
 */
async function runGateBatch(input: GateBatchInput): Promise<void> {
  const { scope } = input;
  const { rt, sessionId } = scope;
  try {
    // 计时的基准：每条检查可用的时间由 processGate 按「剩余预算 − 后面各条的保底」现算。
    const started = Date.now();
    /** 是否有门禁没有给出"通过"的结论（code-failure 和 not-run 都算；只有全部 pass 才重置配额）。
     *  放在可变的持有对象里而不是 `let`：赋值都发生在 `processGate` 里，控制流分析看不见那两次
     *  写，批次结束后的读取点会被钉在初始值 false 上、`!batch.blocked` 就被判成永远成立——而"有检查没给出
     *  通过结论"是真会发生的（是否重置配额就取决于它）。读属性得到的是声明的 boolean，这个判断才是有效的。 */
    const batch: { blocked: boolean } = { blocked: false };
    for (const gate of input.gates) {
      rt.activeGateRoots.set(gate.root, (rt.activeGateRoots.get(gate.root) ?? 0) + 1);
    }
    await processGate({ ...input, started, batch }, input.gates);
    // 所有门禁都真的跑完并且通过 → 重置会话配额：模型已经修好，下一轮重新计数。
    // 只要有任何一条"没跑成"就不重置：那不等于代码是健康的。
    if (!batch.blocked) {
      rt.injectState.delete(sessionId);
    }
  } catch (error) {
    // 批次的最后一层保护：门禁调度自己出错（比如宿主的行为在执行期间突变）不能往外传——
    // 这一层没有 catch 的话，rejection 会直接变成 unhandledRejection。
    rt.log.error(`[quality-gate] ${sessionId}: gate batch failed: ${messageOf(error)}`);
  } finally {
    for (const gate of input.gates) {
      releaseGateRoot(rt, gate.root);
    }
    releaseGrants(rt, input.grants);
  }
}

/** 排空累加器、探测门禁并交给 `runGateBatch`（此时队友台账已经并入）。 */
function scheduleReadyGates(
  scope: TurnScope,
  shell: ShellService,
  files: readonly string[],
  dropped: number,
  team: TeamEdits,
): void {
  const { rt, agent, cfg, messages, sessionId, signal: turnSignal } = scope;
  /* v8 ignore next 3 —— 这道判据只兜「handleTurnGate 通过之后、后台 await 队友冷读期间卸载」的竞态：
     两者之间没有可控的 await 插入点，单线程下测试无法确定性复现（确定性卸载由 handleTurnGate 的
     runtimeDisposed 与每条结果后的 gateAborted 各判一次）。放在这里是为了让"卸载发生在等待途中"
     也不把一批门禁发出去。 */
  if (runtimeDisposed(rt)) {
    return;
  }
  // 累加器到了容量上限而淘汰掉的内容要能看见（drain 已经把计数清零，所以调用方先读再排空）
  if (dropped > 0) {
    rt.log.warn(
      `[quality-gate] ${sessionId}: ${dropped} edited file(s) evicted from accumulator cap; gate may miss their roots`,
    );
  }
  if (files.length === 0) {
    return;
  }
  // 汇总项目根并探测要跑的门禁（一条门禁都没有就直接返回，不动配额）
  const gates = detectGate(
    projectRootsOf(files, rt.maxRootDepth, rt.log, cfg.pnpmScripts),
    cfg.pnpmScripts,
    { securityAudit: cfg.securityAudit },
  );
  if (gates.length === 0) {
    return;
  }
  const { session } = agent;
  // 沙箱策略在**同步段**按会话解析一次（进入异步段之后不再碰 agent.session）。
  const resolved = resolvePolicy(rt, messages, session);
  // workspace-write 下，门禁根可能落在会话可写边界之外（monorepo 子包 → 仓库根）：
  // 先按 rc.2 的 registerWritableRoot 临时登记，再重新解析一次，让额外可写根进入策略快照。
  const grants = resolved.kind === "ok" ? grantGateRoots(rt, session, gates, resolved.binding) : [];
  const effective = grants.length === 0 ? resolved : resolvePolicy(rt, messages, session);

  // 门禁批次的执行信号 = turn signal（回合取消时一起终止）加上 dispose abort（卸载时终止）。
  // AbortSignal.any 不接受 undefined（Node 26 实测抛 TypeError），两种情况先合并——
  // 因此传给 runGate 的 signal 一定有值。
  const gateSignal =
    turnSignal === undefined
      ? rt.gateAbort.signal
      : AbortSignal.any([turnSignal, rt.gateAbort.signal]);

  // 把门禁放到后台执行（shell.execute 返回 Promise；turn-stopping 是串行事件，不能占用太久）。
  // 配额按 sessionId 跨回合累计——门禁通过就重置，达到上限时注入一次"放行说明"之后保持静默，
  // 直到出现一次干净通过。这样"失败→注入→新回合又失败"的循环才被 maxInjects 真正约束住。
  const flight = runGateBatch({
    scope,
    gates,
    shell,
    resolved: effective,
    signal: gateSignal,
    budget: cfg.gateBudgetMs,
    grants,
    collaborators: teammatesByRoot(gates, team.namesByPath),
  });
  rt.inFlightGates.add(flight);
  // 结束之后自动从集合里移除：disposer 那次 await 拿到的快照因此总是"还没结束的全部批次"。
  // 用 await 而不是 `.finally()`（promise/prefer-await-to-then）：runGateBatch 的整个函数体已经在
  // 自己的 try/catch 里（批次的最后一层保护，永远不会 reject），所以结束之后删掉这一项和 .finally 等价；
  // 仍然放后台（不 await 这个跟踪任务，回合不会被它拖住）和原来的语义一致。
  void (async (): Promise<void> => {
    await flight;
    rt.inFlightGates.delete(flight);
  })();
}

/** 探测项目根、解析沙箱策略、调度一批门禁（同步段完成探测与解析，批次本身放后台）。 */
function scheduleTurnGates(
  scope: TurnScope,
  shell: ShellService,
  acc: EditAccumulator,
  teamAcc: EditAccumulator,
  team: () => Promise<TeamEdits>,
): void {
  const { rt } = scope;
  // 根会话的文件**当场排空**：后台只等队友的冷读，不等根累加器。否则监听器返回后宿主就能开
  // 下一回合，而下一回合的编辑会进入同一个累加器，被上一回合的后台批次 drain 走——上一批误检、
  // 下一批漏检。队友文件放各自的累加器，等冷读完成后再并进同一次探测。
  const dropped = acc.droppedCount();
  const files = acc.drain();
  const flight = (async (): Promise<void> => {
    let mergedFiles: readonly string[];
    let mergedDropped: number;
    let resolvedTeam: TeamEdits;
    try {
      resolvedTeam = await team();
      mergedDropped = dropped;
      const teamDropped = teamAcc.droppedCount();
      const teamFiles = teamAcc.drain();
      mergedFiles = [...files, ...teamFiles];
      mergedDropped += teamDropped;
    } catch (error) {
      // 冷读失败不能让根会话已经排空的编辑消失：放回累加器，等下一个回合再检查。
      for (const file of files) {
        acc.note("edit", file);
      }
      throw error;
    }
    scheduleReadyGates(scope, shell, mergedFiles, mergedDropped, resolvedTeam);
  })();
  rt.inFlightGates.add(flight);
  // 结束之后自动从集合里移除：disposer 那次 await 拿到的快照因此总是"还没结束的全部批次"。
  void (async (): Promise<void> => {
    try {
      await flight;
    } catch (error) {
      // 冷读/探测自己抛错时只记一条，绝不产生 unhandledRejection（disposer 仍会等这一趟结束）。
      rt.log.error(
        `[quality-gate] ${scope.sessionId}: gate scheduling failed: ${messageOf(error)}`,
      );
    } finally {
      rt.inFlightGates.delete(flight);
    }
  })();
}

/** 没有队友输入时的懒加载结果（与 `teamInputFor` 的返回值同形）。 */
const NO_TEAM_INPUT = (): Promise<TeamEdits> => Promise.resolve(NO_TEAM_EDITS);

/**
 * 决定本轮门禁的队友输入：列出队友 + 读运行状态（廉价，留在串行段），冷读台账交给后台批次。
 *
 * @param rt - 装载期运行时
 * @param session - 根会话
 * @param note - 把一条编辑并入累加器
 * @param signal - 本回合信号（也用于冷读的组合信号）
 * @returns 队友台账的懒加载函数；undefined = 队友仍在跑，本轮推迟
 */
async function teamInputFor(
  rt: GateRuntime,
  session: TurnAgent["session"],
  note: (name: string, pathValue: string | undefined) => void,
  signal: AbortSignal | undefined,
): Promise<(() => Promise<TeamEdits>) | undefined> {
  const members = await listTeamMembers(rt, session, signal);
  let input: (() => Promise<TeamEdits>) | undefined = NO_TEAM_INPUT;
  if (members !== null && members.length > 0) {
    const deferred = teamGateDeferred(rt, session, members);
    if (deferred === true) {
      input = undefined;
    } else if (deferred === false) {
      // 只交一个 thunk：串行段不启动 observeSession，真正冷读在后台批次里发生（失败也能被
      // scheduleTurnGates 的 catch 接住，根会话已排空的文件才放得回去）。
      input = () => mergeTeamLedgers(rt, members, note, signal);
    }
  }
  return input;
}

/**
 * 一次回合结束的处理（原来写在 turn-stopping 监听器里的匿名 `run`）：守卫 → 记录编辑 → 探测要跑的
 * detached 跑批次。整段仍是同一条同步/异步切分——门禁执行 detached（不拖回合收尾），
 * 读事件那一次 await 留在回合内（`@mode serial` 派发下和原来的形状等价）。
 */
async function handleTurnGate(rt: GateRuntime, payload: TurnStoppingPayload): Promise<void> {
  const { agent } = payload;
  // 载荷边界守卫：agent 由宿主恒带，缺失属异常载荷（宁可漏一次门禁也不带半截状态记录）。
  if (agent === undefined) {
    return;
  }
  // 插件已卸载（disposer 已执行）：整个处理放弃——放在最前面，卸载之后连读事件、跑门禁
  // 都不必开始。
  if (rt.disposed) {
    return;
  }
  const cfg = settingsOf(rt.config);
  if (!cfg.enabled) {
    return;
  }
  // 子代理会话跳过门禁（根会话的判断；原因和边界见 isRootSession 的注释）。
  if (!isRootSession(agent)) {
    return;
  }
  // 本回合注入文案的语言（官方 locale 偏好，每个回合读一次 → 改了语言下一回合就生效，不用重启）。
  const messages = rt.messages();
  const { session } = agent;
  const { id: sessionId } = session;
  /** 会话的**项目** cwd：记忆与总线的归属用建会话快照，worktree 仍属于同一个原始项目。 */
  const projectCwd =
    typeof session.header.cwd === "string" && session.header.cwd.length > 0
      ? session.header.cwd
      : undefined;
  /** 相对路径解析与门禁工作目录用**活目录**（`workingDirectory` 投影，服务缺席回落 header）。 */
  const resolveCwd = liveSessionCwdOf(agent);
  // turn-stopping 时 agent.status 一直是 'running'（官方在 running 阶段内 serial
  // 分发 turn-stopping，转到 idle 发生在回合结束之后）。旧的 `status !== 'idle' → return`
  // 让门禁在真实宿主里永远不执行（测试 mock 了 status:'idle'，把这个 bug 盖住了）。只用数据信号判断：
  // inbox 有待处理消息（用户已经排了后续工作）→ 不跑门禁（不抢话），顺带淘汰旧会话的配额。
  if (inboxHasPending(agent.inbox)) {
    pruneToSessionBudget(rt.injectState, sessionId);
    return;
  }
  // turn 缺失或不是数字就直接返回（官方 dispatch 总是带 turn）：它是上报和日志的归属字段，
  // 不允许带着 undefined 去记录。
  if (typeof payload.turn !== "number") {
    return;
  }
  const { turn } = payload;
  // 没有 shell 时 warn 一次（整套门禁都不工作，属于部署情况；用局部标记防止刷屏）。
  // 必须走 getShell()：shell 没写进 inject 时，读 svc.shell 是抛错而不是 undefined。
  const shell = getShell(rt);
  if (shell === undefined) {
    if (!rt.shellWarned) {
      rt.shellWarned = true;
      rt.log.warn("[quality-gate] shell service unavailable; gates skipped (pass-through)");
    }
    return;
  }

  // 记录本回合编辑过的文件（事件流经官方的观察接口读 tool/call 和 tool/result）；记录按会话分开，
  // drain 只取自己那一份。这一读是 async，而本监听器按官方 `@mode serial` 串行分发——
  // 在监听器里 await 它，和迁移前"读窗 + drain 处在同一个同步段"的互斥性等价（同一个会话
  // 一次只有一趟在读游标）；下面的门禁执行照旧放后台，不拖回合收尾。
  const acc = accumulatorOf(rt, sessionId);
  await readEditedFiles(rt, agent, acc);
  // 卸载可能发生在这一趟异步读取期间：恢复之后不要再开始门禁，否则会在 dispose 的
  // allSettled 快照之后新建一个在跑的任务、并且把已经清理掉的游标又写回去。
  if (runtimeDisposed(rt)) {
    return;
  }
  // 具名子代理的编辑也属于这棵工作树（Team 不建隔离工作区）：队友还在跑就推迟本轮门禁，
  // 否则检查的是正在被并发改写的树；空闲/冷队友的台账经 observeSession 事件窗增量重放并入。
  // 串行段只做两件廉价事：列出队友 + 读运行状态；冷会话重放交给下面的后台批次（teamInput 是 promise）。
  // 队友文件单独收：根会话的累加器要在本监听器返回前排空（见 scheduleTurnGates）。
  const teamAcc = new EditAccumulator();
  const note = (name: string, pathValue: string | undefined): void => {
    noteEdit(teamAcc, resolveCwd, name, pathValue);
  };
  const teamInput = await teamInputFor(rt, session, note, payload.signal);
  if (runtimeDisposed(rt) || teamInput === undefined) {
    // undefined = 队友仍在跑（推迟）：本轮文件留在累加器里，等队友完成开启的下一回合一起检查。
    return;
  }
  scheduleTurnGates(
    { rt, agent, cfg, messages, sessionId, turn, cwd: projectCwd, signal: payload.signal },
    shell,
    acc,
    teamAcc,
    teamInput,
  );
}

/** 官方 Typert Remote 的服务键（= 线上命名空间；client 半的常量在 src/remote.ts，取值必须一致）。 */
export const QUALITY_GATE_NAMESPACE = "qualityGate";

/**
 * 会话侧栏的宿主侧读取面（官方 Typert Remote）：按 sessionId 交出最近的门禁结果。
 * 本包不自建 HTTP 端点，认证与分派由宿主 /api 网关负责。
 */
export class QualityGateRemoteService extends TypertRemoteService {
  private readonly results: Map<string, GateResultRow[]>;
  public constructor(ctx: Context, rt: GateRuntime) {
    super(ctx, QUALITY_GATE_NAMESPACE);
    this.rt = rt;
    this.results = rt.recentResults;
  }

  private readonly rt: GateRuntime;

  /** 最近一次门禁（跨会话取最新一条）：会话面板不知道自己的 sessionId 时读它。 */
  public latest(): { readonly row: GateResultRow | undefined } {
    let row: GateResultRow | undefined;
    for (const rows of this.results.values()) {
      const candidate = rows.at(-1);
      if (candidate !== undefined && (row === undefined || candidate.at > row.at)) {
        row = candidate;
      }
    }
    return { row };
  }

  /**
   * 立即跑一次本会话项目的门禁（右键入口）：只在 agent 空闲时执行，失败走与回合收口相同的
   * 注入路径（配额、记忆反馈、lesson-loop 都不跳过）。返回状态给客户端做反馈，不抛错误。
   */
  public async run(request: unknown): Promise<{ readonly status: string }> {
    const sessionId = sessionIdOf(request);
    if (sessionId.length === 0) {
      return { status: "invalid" };
    }
    const agents: unknown = this.rt.svc.get("agents");
    const agent: unknown =
      isRecord(agents) && typeof agents["get"] === "function"
        ? Reflect.apply(agents["get"], agents, [sessionId])
        : undefined;
    if (!isTurnAgent(agent)) {
      return { status: "no-agent" };
    }
    if (agent.status === "running") {
      return { status: "busy" };
    }
    const cfg = settingsOf(this.rt.config);
    if (!cfg.enabled) {
      return { status: "disabled" };
    }
    const cwd = liveSessionCwdOf(agent);
    if (cwd === undefined) {
      return { status: "no-cwd" };
    }
    const shell = getShell(this.rt);
    if (shell === undefined) {
      return { status: "no-shell" };
    }
    const root = rootForFile(
      findManifestRoot(path.join(cwd, MANUAL_PROBE_FILE), this.rt.maxRootDepth).root ?? cwd,
      this.rt.maxRootDepth,
      cfg.pnpmScripts,
    );
    const gates = detectGate([root], cfg.pnpmScripts, { securityAudit: cfg.securityAudit });
    if (gates.length === 0) {
      return { status: "no-gate" };
    }
    // 同一根上已经有一条门禁在跑（自动批次可能已在回合结束后 detached 运行）时不再并发一条。
    if (gates.some((gate) => this.rt.activeGateRoots.has(gate.root))) {
      return { status: "busy" };
    }
    const messages = this.rt.messages();
    const resolved = resolvePolicy(this.rt, messages, agent.session);
    const grants = grantGateRoots(
      this.rt,
      agent.session,
      gates,
      resolved.kind === "ok" ? resolved.binding : undefined,
    );
    // 与自动批次同一条理由：临时登记的可写根要进入策略快照，否则门禁在会话可写边界之外
    // 执行时仍按旧策略裁决——手动入口会静默地跑一条注定被拒的门禁。
    const effective =
      grants.length === 0 ? resolved : resolvePolicy(this.rt, messages, agent.session);
    const signal = AbortSignal.any([
      this.rt.gateAbort.signal,
      AbortSignal.timeout(cfg.gateBudgetMs),
    ]);
    const scope: TurnScope = {
      rt: this.rt,
      agent,
      cfg,
      messages,
      sessionId,
      turn: turnBoundaryOf(this.rt, agent.session)?.lastTurn ?? 0,
      cwd,
      signal,
    };
    // grants 归 runGateBatch 所有：它在 finally 里释放；这里再释放一次会把同一个可写根撤两遍。
    // 批次登记进 inFlightGates：dispose 的 allSettled 要等到它结束，否则门禁子进程会活过卸载。
    const flight = runGateBatch({
      scope,
      gates,
      shell,
      resolved: effective,
      signal,
      budget: cfg.gateBudgetMs,
      grants,
      collaborators: new Map(),
    });
    this.rt.inFlightGates.add(flight);
    try {
      await flight;
    } finally {
      this.rt.inFlightGates.delete(flight);
    }
    return { status: "done" };
  }

  /** 读某个会话最近的结果；sessionId 缺失或不是字符串时交空表（不是错误）。 */
  public state(request: unknown): { readonly rows: readonly GateResultRow[] } {
    return { rows: this.results.get(sessionIdOf(request)) ?? [] };
  }
}

markRemote(QualityGateRemoteService.prototype, "latest");
markRemote(QualityGateRemoteService.prototype, "run");
markRemote(QualityGateRemoteService.prototype, "state");

/** 注册读面（构造即注册）。替身/精简上下文没有反射口时返回 false，侧栏只少结果那一栏。 */
/** 装上官方 Remote 服务；读面缺席（精简上下文/替身）时安静跳过。
 *  返回值原先只有"装上/没装上"两种，调用点从未读过它——缺反射口与重复装载在行为上同义
 *  （侧栏少一栏），所以这里只做副作用，不记账。 */
function installQualityGateRemote(svc: GateHost, rt: GateRuntime): void {
  if (isRecord(svc) && isRecord(svc.reflect) && typeof svc.reflect.provide === "function") {
    try {
      // oxlint-disable-next-line eslint/no-new -- 构造即注册；Service 构造只读 reflect/provide
      new QualityGateRemoteService(svc, rt);
    } catch {
      /* v8 ignore next 1 —— 构造抛出的唯一现实成因是同一作用域里这个服务键已被另一份占用
         （重复装载/热挂），此时"没装上"与缺反射口同义，侧栏照旧只少一栏；单测用真实
         Context 构造的是成功分支，故意造重复实例去覆盖它只会把测试写成对 cordis 报错的断言。 */
    }
  }
}

export function apply(ctx: Context, config: ConfigShape): void {
  if (!isGateHost(ctx)) {
    // 最后的日志：此时能不能用宿主的 logger 还不一定，直接 console（这条失败路径只有这一处日志）。
    console.error(
      "[quality-gate] ctx is missing the settings.describe/configure + inject/fiber surface; gate not armed",
    );
    return;
  }
  const svc = ctx;

  // 具名 logger（官方 ctx.logger(name)）；宿主没有装
  // （异常的 ctx、测试假对象）时改用 console——这条回退是兼容路径，测试把两条都覆盖。
  // ⚠ 这一位是从**明确写了可以缺席**的类型上读，而不是直接读 `svc.logger`：`svc` 被 `isGateHost`
  // 收窄成 `Context & HostCtx`，而官方 `Context.logger` 是必填的（cordis 的 lib/types/context.d.ts），
  // 取交集时 `A & (A | undefined)` 的结果就是 `A`——本地 `HostCtx.logger?:` 的"可以没有"被官方那一位
  // 抹平，缺席在类型上变成不可能（运行时却是真的会没有）。apply 的参数类型由官方 Plugin 的声明固定、
  // 不能改成更宽的类型，所以在唯一的读取点上把这一位按运行时的形状收回可以为空，`?.` 和 `??` 才是必要的判断。
  const loggerSlot: { readonly logger?: (name: string) => Log } = svc;
  const log: Log = loggerSlot.logger?.("quality-gate") ?? console;

  // 0. 单实例锁：market 的热挂子树（`mkt-*`，走 `file://…/host.js`）与 profile 的 bundle 层
  //    解析到同一份模块，却各起一个 fiber、各跑一次 apply。本包的注册面（事件监听、两处
  //    `svc.inject` 挂的投影与设置页策略）都不去重也不抛错，第二份会静默各挂一份——同一个
  //    回合的门禁判定与台账写入都会跑两遍。让路的那一份不提供任何东西。
  if (
    !claimInstance(
      { get: (name: string): unknown => svc.get(name), reflect: svc.reflect },
      "@jayyuen66/dsh-quality-gate/instance",
    )
  ) {
    log.warn(
      "[quality-gate] 检测到本插件已在同一作用域内装载：本次装配让路，门禁与台账由在册的那一份提供。",
    );
    return;
  }

  // 非 volatile 的部署值：普通值的形态（不用 .get()），装载时读一次，改 cordis.yml 里的行 config 就能改。
  const { maxRootDepth, gateStdoutMaxBytes: stdoutMaxBytes } = config;

  // 0.1.7 起命名空间是**隐式**的：宿主把本条目导出的 Config 里标了 `.volatile()` 的字段
  // 投影成设置表单，ns = profile 条目 id（`quality-gate`，见 cordis.patch.yml），行 config
  // 由同一份 schema 校验并填好默认值之后交进 apply —— 插件侧不再有 register，也没有第二层底座。
  // 只剩页面策略要声明：本包自带卡片，别让宿主再生成一份自动表单页。owner 必须显式传
  // 本插件的 fiber（不传时默认是 settings 服务自己的 fiber，传错等于给别人的页面定策略），并且经
  // child.effect 挂载，好随注入的子上下文一起回收——和宿主 dsh-client-locale 的写法一样。
  svc.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, svc.fiber));
  });

  // 注入文案的语言跟随官方 locale 偏好：用户在"设置 → 常规"改了语言之后，下一个回合结束
  // 用的就是新文案（不用重启，也不加插件自己的语言设置项）。
  // 跨命名空间读在 0.1.7 只有 describe() 这一条路：挑出 ns === 'locale' 那一行的 value
  // （没装 client-locale，或者那个条目没有 volatile 字段 → 宿主不投影它 → undefined → 用中文默认）。
  const localeMessages = (): QualityGateMessages =>
    messagesFor(
      MESSAGES,
      resolveLocalePreference(
        svc.settings.describe().find((row) => row.ns === LOCALE_SETTINGS_NAMESPACE)?.value,
      ),
    );

  // 设置卡改完下一个回合就生效：每次回合结束都重新 `.get()` 一遍各引用的当前值（见 settingsOf）。
  // 会话级的记录（累加器、配额、事件游标）、记忆反馈不发送的标记，以及正在跑的门禁的取消来源
  // 都挂在 rt 上，每个字段的原注释见 GateRuntime 的声明。
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
    queryMissingWarned: false,
    queryReadWarned: false,
    teamListWarned: false,
    teamReadWarned: false,
    editLedger: { value: undefined },
    recentResults: new Map<string, GateResultRow[]>(),
    activeGateRoots: new Map<string, number>(),
    disposed: false,
  };

  // 读面缺席（精简上下文/替身）只意味着侧栏少一栏数据，不是缺陷：安静地跳过，不刷日志。
  installQualityGateRemote(svc, rt);

  // 用编辑台账投影是**可选**的增强：注册表不在（精简的组合、旧宿主）时整条退回全量扫描，
  // 门禁本身不受影响。注册失败只警告一次：读不到编辑记录是性能问题，不是少了什么判断。
  // 回调把注册那一段的 promise 交回出去：cordis 把插件回调的返回值当作子 fiber 的 setup
  // 屏障来等待，所以读取函数在这条注入就绪之前就已经装好。在这里直接 `void` 掉就等于让注册在后台跑完。
  svc.inject(["sessionProjections"], (child) =>
    mountEditLedgerReader(child.sessionProjections, {
      publish: (reader) => {
        rt.editLedger.value = reader;
      },
      effect: (factory) => child.effect(factory),
      onError: (error) => {
        log.warn(
          `[quality-gate] sessionProjections register failed, falling back to full scan: ${String(error)}`,
        );
      },
    }),
  );

  svc.on("agent/turn-stopping", async (payload) => {
    // 门禁是附加能力，绝不能因为它自己出错就把整轮对话弄失败：turn-stopping 走
    // dispatch.serial 派发（agent-loop/src/agent.ts:317），监听器抛错会被
    // agent-loop 折成 turn/end kind:error code=UNKNOWN（用户看到"本轮运行失败"）。
    // 整段包 try/catch：门禁自己出问题只记日志并明确说明，和 runGate 的
    // "没跑成不得算通过"是同一条原则。
    try {
      // `await handleTurnGate(...)`：本包读事件现在走官方的观察接口（异步），而这段 try/catch 是
      // "门禁自己的异常不能把回合弄失败"的最后保护——不 await 的话读取的 rejection 会绕过它变成
      // 游离的 Promise（除了 no-floating-promises，更是把这层保护作废）。监听器已按官方
      // `Promise<void> | void` 的签名改成 async（installed dsh-agent/lib/types/
      // runtime-types.d.ts:387-391），而 turn-stopping 是 `@mode serial` 派发：await 等的
      // 只有那一次本地日志读取，门禁的主体仍在下面放后台，不拖回合收尾。
      await handleTurnGate(rt, payload);
    } catch (error) {
      // 最后保护：门禁自己的异常（读事件、找路径、调度门禁）不能把回合弄失败。
      rt.log.error(
        `[quality-gate] turn-stopping handler failed (gate skipped): ${messageOf(error)}`,
      );
    }
  });

  // 卸载时要做完的事：先置标记（新到的回合结束整体
  // 放弃），再 abort 正在跑的门禁（shell 执行随组合信号终止、迟到的结果就地丢弃），最后 await
  // 全部批次结束才真正退出——只把 disposed 置成 true 不够：门禁的子进程会活过卸载、结果被静默
  // 丢掉。返回 Promise 是合法的：cordis 的 disposer 允许 async（"they may be async, in which
  // case unloading awaits them"，installed @deepseek-ai/cordis/lib/types/fiber.d.ts:36-40）。
  // 会话级的记录（配额、游标、累加器）一起废弃，不留给下一装载周期。
  svc.effect(() => () => {
    rt.disposed = true;
    rt.gateAbort.abort();
    rt.injectState.clear();
    rt.lastSeqBySession.clear();
    rt.accumulators.clear();
    // 侧栏读的是最近结果；卸载后不清会让下一装载周期读到上一周期的结果（同一 sessionId 可能复用）。
    rt.recentResults.clear();
    // allSettled 会同步对 iterable 取快照（这些集合只在异步的收尾里删项，迭代期间不会变）。
    return Promise.allSettled(rt.inFlightGates);
  });
}

export default {
  inject: ["settings"],
  Config,
  apply,
};
