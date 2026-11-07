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

import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
// 0.1.7 的设置界面要求宿主 fork 的那个 schemastery：`Schema.prototype.volatile` 只在
// @deepseek-ai/schemastery 这一枚里存在（installed @deepseek-ai/schemastery/src/index.ts:480-482），
// 公共的 schemastery 既没有 .volatile()、解析出来的也仍是普通值。
import Schema from "@deepseek-ai/schemastery";
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
import { EDIT_TOOLS, EditAccumulator } from "./lib/accumulator.ts";
import { detectGate } from "./lib/gate-detect.ts";
import type { Gate, ProjectRoot } from "./lib/gate-detect.ts";
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
// lesson bus 的失败处理：lesson-loop 的 report 是异步写库的（返回 Promise），只包一层同步
// try/catch 抓不到 rejection——失败既没有任何记录，又给宿主进程留下一个未处理的拒绝。
// 同步抛错和异步拒绝共用这一个返回点（三个包调用它时的失败处理做法一致）。
import { settleLessonCall } from "@jayyuen66/dsh-plugin-shared/lib/lesson-bus";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { mountEditLedgerReader } from "./lib/edit-ledger-reader.ts";
import type { EditLedgerReader, ProjectionsRegistry } from "./lib/edit-ledger-reader.ts";

/**
 * 常见的项目根标记文件：向上找最近的、含清单文件的目录。
 * ruff.toml 必须在这一列：只有 ruff 配置、没有 pyproject.toml 的 Python 工程如果不在这儿
 * 登记，gate-detect 里的 has("ruff.toml") 就永远不会被走到——那类工程根本找不到项目根，
 * 也就永远不会有对应的门禁。
 */
const PKG_MANIFEST = "package.json";
const TSCONFIG_MANIFEST = "tsconfig.json";
const PYPROJECT_MANIFEST = "pyproject.toml";

const MANIFESTS = [
  PKG_MANIFEST,
  "Cargo.toml",
  PYPROJECT_MANIFEST,
  "pnpm-workspace.yaml",
  "ruff.toml",
  ".ruff.toml",
];

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
type SessionObservationFace = Pick<SessionObservation, "events" | keyof Disposable> & {
  readonly inheritedEventCount: SessionLogOffset | undefined;
};

/** `options` 在本地接口上是**必填**的：官方的默认值是 `projectionMode: "all"`
 *  （installed @deepseek-ai/dsh-session-query/lib/index.js 的 `projectionMode = "all"`），
 *  那会让宿主为整份日志把所有投影都算一遍 snapshot，而本包只读 events 和 inheritedEventCount。
 *  写成必填，是为了不给"少传一次就白算一遍"留下可用的默认值。 */
interface SessionQueryFace {
  observeSession: (
    sessionId: SessionId,
    options: { readonly projectionMode: "none" },
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
 *  返回值就是上面的 SandboxExecutionPolicy，两侧的字段都不再由本包重写。 */
type SandboxPolicyService = Pick<HostSandboxPolicyService, "resolve">;

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
  | { kind: "ok"; policy: SandboxExecutionPolicy | undefined }
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
  /** 向上找项目根的最大层数（不是 volatile 的部署值：普通值形态，不用 .get()，不占设置卡）。 */
  maxRootDepth: number;
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
  // ── 不同部署可能想配不同值的，就必须是配置字段 ──
  // 下面两项是**部署时的默认值**：不是 volatile → 不进设置卡（宿主只投影 volatile 字段），
  // 以普通值的形态交进 apply（不用 .get()）；默认值 = 现在代码里的值，改 cordis.yml 里的行 config 就能改，不用改代码。
  /** 向上找项目根的最大层数（深嵌套 monorepo 的查找深度）。 */
  maxRootDepth: Schema.natural().default(DEFAULT_MAX_ROOT_DEPTH),
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
/** 取错误的摘要文本（String(error) 对非 Error 会打出 [object Object]，所以在这里分类处理）。 */
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
 * 在独立进程运行，不发射 dsh 的 agent 事件，它们的编辑天然不在任何门禁的范围内；in-process
 * 子代理被这个判断跳过后，它们的编辑由父会话下一回合结束时的门禁在父侧统一核验（以后如果
 * 需要精确到子代理的编辑，可以在父会话里聚合子会话的 tool/call——本插件不做，避免过度设计）。
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

/** 时间预算用完之后，剩下那些门禁的"未执行"清单：只 warn 等于静默通过，所以要注入给模型和用户。 */
const skippedText = (messages: QualityGateMessages, gates: readonly Gate[]): string =>
  renderTemplate(messages.gatesSkipped, {
    budgetMs: MIN_USEFUL_GATE_MS,
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

/**
 * exit 126/127 只有在 stderr 点到门禁命令自己的第一个 token 时才算"工具不可用"：
 * `pnpm check` 的脚本里缺命令 pnpm 同样回 127（`[ELIFECYCLE] Command failed with exit code 127`），
 * 混在一起判会把项目自己写坏的脚本当成环境问题放掉。判断按行做：同一行里既有"不可用"的说法、
 * 又出现这个 token。
 */
function gateToolUnavailable(gate: Gate, res: ShellRunResult): boolean {
  if (res.exitCode !== 126 && res.exitCode !== 127) {
    return false;
  }
  const token = gate.command[0].toLowerCase();
  return res.stderr.text
    .toLowerCase()
    .split("\n")
    .some((line) => line.includes(token) && TOOL_UNAVAILABLE_TEXT.test(line));
}

/**
 * 门禁用的工具本身不可用（exit 126/127 且 stderr 点到门禁命令）→ not-run，并 warn 给运维。
 * 这是环境问题不是代码问题：注入失败指令会逼模型去修一个装不上的工具；但没跑成 ≠ 通过。
 * 脚本内部返回的 126/127 不走这一支（见 gateToolUnavailable），按代码失败处理。
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

/**
 * 根 package.json 里已声明的 scripts 名（值是非空字符串才算"声明了这条脚本"）。
 *
 * 读不到、JSON 不合法、没有 scripts 字段 → **undefined（"没有信息"）**，由 gate-detect
 * 按保守的做法处理（不发 pnpm check）。不在这里替项目猜：猜错的代价是注入一次假失败。
 */
function declaredScriptsOf(root: string): readonly string[] | undefined {
  let names: readonly string[] | undefined;
  try {
    // JSON.parse 返回 any：先经 unknown，再用守卫取需要的部分（不写 unsafe 断言）
    const raw: unknown = JSON.parse(readFileSync(path.join(root, PKG_MANIFEST), "utf8"));
    const scripts = fieldOf(raw, "scripts");
    // scripts 不是对象（缺字段，或者 `"scripts": 42`）和读失败按同一种情况处理：names 保持 undefined，
    // 也就是"没有信息"——不替项目猜一条门禁命令。
    if (isRecord(scripts)) {
      names = Object.entries(scripts)
        .filter(([, body]) => typeof body === "string" && body.length > 0)
        .map(([name]) => name);
    }
  } catch {
    // 读不到或 JSON 不合法：如实留 undefined，让 gate-detect 走"宁可不给门禁命令"的保守做法
    names = undefined;
  }
  return names;
}

/** 判断交回的是不是数组（**不是** type predicate，因此不产生类型收窄；理由见 resolveEventWindow）。 */
function isArrayDelivery(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * pyproject 里 ruff 段头的字面写法：`[tool.ruff]` 或者它的子表 `[tool.ruff.lint]` 等。
 *
 * `^` 加 `m` 旗标限定为行首；`[tool.ruff]` 和 `[tool.ruff.<子表>]` 都要认——只写子表、
 * 不写父表的 pyproject 是常见写法。数组表（`[[tool.ruff...]]`）同样命中段名，一并算声明。
 */
const RUFF_SECTION = /^\[\[?tool\.(?:"ruff"|ruff)[\].]/mu;

/**
 * 根 pyproject.toml 里是否声明了 ruff 的配置段（段头的写法见 RUFF_SECTION）。
 *
 * 只按行首段头做字面匹配，不引入 TOML 解析器：这里只需要回答"有没有这一段"，而段头在
 * TOML 里必须独占一行（行内写法 `[a.b] c = 1` 是非法的），所以行首匹配和解析器的结果一致。
 * 带引号的键写法（`[tool."ruff"]`）在 TOML 里合法且等价，也认。
 *
 * 读不到 / 解码失败 → undefined（"没有信息"），由 gate-detect 按保守的做法处理：不发 ruff
 * 门禁。这里和 declaredScriptsOf 取同一个方向，理由见 gate-detect 的 ruffGateReady。
 */
function ruffConfiguredOf(root: string): boolean | undefined {
  let configured: boolean | undefined;
  try {
    const text = readFileSync(path.join(root, PYPROJECT_MANIFEST), "utf8");
    configured = RUFF_SECTION.test(text);
  } catch {
    configured = undefined;
  }
  return configured;
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
): Promise<{ from: number; events: readonly SessionEvent[] } | undefined> {
  // 只有一处 return（consistent-return 与 treatUndefinedAsUnspecified：不把 undefined 和值返回混在一起）
  let window: { from: number; events: readonly SessionEvent[] } | undefined;
  // 观察结果在 try 外面声明：`observeSession` 自己拒绝时它仍然是 undefined，收尾就不会去调一个
  // 不存在的释放器；一旦拿到了，成功、返回的不是数组、后面抛错这三条路径都由 finally 归还这份 lease。
  let observation: SessionObservationFace | undefined;
  try {
    observation = await query.observeSession(sessionId, { projectionMode: "none" });
    // 游标下限 = fork 的位置（root 会话是 0）：第一次见到的会话（包括进程重启之后）从下限开始重放
    // 本会话自己的历史编辑——这是有意的：turn-stopping 时本回合的编辑已经在日志里，
    // 从末尾起步会跳过正在要检查的回合。代价是重启后首轮会多跑几次门禁（预算与
    // maxInjectsPerTurn 管住）；重放本身不会造成假失败——项目根必须是真正的 TS 项目
    // （见 gate-detect 里 tsc 的判断条件），历史编辑所在的根都是真项目。
    const forkCut = observation.inheritedEventCount ?? 0;
    const from = Math.max(forkCut, lastSeq.get(sessionId) ?? forkCut);
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
  failed: Set<string>;
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
  const failed = new Set<string>();
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
    if (result.isError && result.callId !== undefined) {
      failed.add(result.callId);
    }
  }
  return { records, failed };
}

/** 单个文件向上找最近的、含清单文件的目录；hitDepthLimit 标记是否因为太深而没找到根（供可观察到的 warn）。
 *  maxDepth 来自 Config 的 maxRootDepth（不是 volatile 的部署值）。 */
function findManifestRoot(
  file: string,
  maxDepth: number,
): { root: string | undefined; hitDepthLimit: boolean } {
  let dir = path.dirname(file);
  let found: string | undefined;
  let hitDepthLimit = false;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const manifest of MANIFESTS) {
      // 拼子路径用平台实现：Win32 的路径转换把 `/` 也当分隔符，手工拼的混合写法查得到，但它会和别处
      // 用 path.join 拼出的同一路径成为两个不同的字符串——下面要把 found 当项目根用于比较和缓存键，
      // 两种写法会让同一个目录看起来像是两个根。
      if (existsSync(path.join(dir, manifest))) {
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
 * 找到最近的含清单目录之后继续向上找 pnpm-workspace.yaml —— workspace 根优先。
 * monorepo 的子包（admin/src/x.ts）应该跑整个工作区的 `pnpm check`，而不是退化成只跑子包的 `tsc`。
 */
function workspaceRootUpgrade(root: string, maxDepth: number): string {
  let up = path.dirname(root);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (existsSync(path.join(up, "pnpm-workspace.yaml"))) {
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
 * 读取一个根在磁盘上的实际情况 → 转成 gate-detect 的入参形状（ProjectRoot）。
 *
 * - 清单名：MANIFESTS 里实际存在的项；
 * - tsconfig.json 不作为"根标记"（不进 MANIFESTS，避免改变向上探测根的语义），
 *   但要进清单集合——gate-detect 用它区分"真 TS 项目"和"只有一个 package.json 的空壳"；
 * - scripts：根 package.json 里已声明的脚本名，交给 gate-detect 判断 pnpm check
 *   能不能用。**这里只如实登记，不做选择**（探测策略集中在纯函数里）；
 * - ruffConfigured：根 pyproject.toml 里是不是真的有 `[tool.ruff]` 开头的那些段，交给 gate-detect
 *   判断 ruff门禁能不能用。理由同上——只登记，不选择。
 */
function probeProjectRoot(root: string): ProjectRoot {
  const manifests = MANIFESTS.filter((manifest) => existsSync(path.join(root, manifest)));
  if (existsSync(path.join(root, TSCONFIG_MANIFEST))) {
    manifests.push(TSCONFIG_MANIFEST);
  }
  // 没有 package.json 时不去读脚本清单（那次 IO 没有意义：pnpm 那一支要求 package.json 存在）
  const scripts = manifests.includes("package.json") ? declaredScriptsOf(root) : undefined;
  // 同理：没有 pyproject.toml 时不去读它（ruff 的 pyproject 那一支要求这个文件存在）
  const ruffConfigured = manifests.includes(PYPROJECT_MANIFEST)
    ? ruffConfiguredOf(root)
    : undefined;
  const entry: ProjectRoot = { root, files: manifests };
  if (scripts !== undefined) {
    entry.scripts = scripts;
  }
  if (ruffConfigured !== undefined) {
    entry.ruffConfigured = ruffConfigured;
  }
  return entry;
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
 * 子包自己就能给出 `pnpm check`（自带 `pnpm-workspace.yaml` 且声明了 check）时，它就是离
 * 文件最近、又真能跑起来的那一层门禁；继续往上找外层工作区只会把"改一个子包"放大成
 * workspace 的全套检查」——门禁的作用域应当止步于最近的 workspace 根。
 */
function hasPnpmCheckGate(root: ProjectRoot): boolean {
  return detectGate([root]).some((gate) => gate.command[0] === "pnpm");
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
function rootForFile(useRoot: string, maxDepth: number): ProjectRoot {
  const inner = probeProjectRoot(useRoot);
  if (hasPnpmCheckGate(inner)) {
    return inner;
  }
  const upgraded = workspaceRootUpgrade(useRoot, maxDepth);
  if (upgraded === useRoot) {
    return inner;
  }
  const outer = probeProjectRoot(upgraded);
  if (detectGate([outer]).length > 0) {
    return outer;
  }
  // 外层给不出门禁：退回内层（内层也没有时两者等价，仍然返回外层，保持"没有门禁"这个结论）。
  return detectGate([inner]).length > 0 ? inner : outer;
}

/**
 * 从编辑过的文件路径向上找最近的清单根（层数上限 = Config 的 maxRootDepth，不是 volatile
 * 的部署值），每个根读一次磁盘上的实际情况（清单名 + 已声明的脚本）。找不到清单根的文件跳过
 * （没有对应的门禁）。同一个内层根只读一次盘：一轮改几百个文件时逐文件重复读盘没有意义。
 */
function projectRootsOf(files: readonly string[], maxDepth: number, log: Log): ProjectRoot[] {
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
        chosen = rootForFile(useRoot, maxDepth);
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
  /** 编辑台账投影的读取函数：`sessionProjections` 可用时由 inject 回调装上（没有 ⇒ 退回全量扫描）。 */
  editLedger: { value: EditLedgerReader | undefined };
  /** 插件已卸载（disposer 已执行）：新到的回合结束事件整体放弃——不读事件、不跑门禁、不注入。 */
  disposed: boolean;
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
    result = { kind: "ok", policy: undefined };
  } else {
    try {
      result = { kind: "ok", policy: policy.resolve({ session }) };
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
  const from = rt.lastSeqBySession.get(session.id) ?? 0;
  // 编辑台账有条数上限（EDIT_LEDGER_MAX），超限时旧的条目被丢掉；这时候如果直接把游标推到日志末尾，
  // 被丢掉的那些 seq 就再也读不到了。所以只推进到台账实际覆盖到的末尾，下一回合还能从缺口重读。
  let covered = from;
  for (const entry of ledger) {
    covered = Math.max(covered, entry.seq + 1);
    if (entry.seq >= from && !entry.failed) {
      note(entry.name, entry.path === "" ? undefined : entry.path);
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
  const { cwd } = session.header;
  const note = (name: string, pathValue: string | undefined): void => {
    // 相对路径按会话的 cwd 解析（edit 常常给相对路径；不按 host 进程的 CWD）
    let resolvedPath = pathValue;
    if (resolvedPath !== undefined && cwd !== undefined && !path.isAbsolute(resolvedPath)) {
      resolvedPath = path.resolve(cwd, resolvedPath);
    }
    acc.note(name, resolvedPath);
  };
  if (noteLedgerEdits(rt, session, note)) {
    return;
  }
  const window = await resolveEventWindow(query, sessionId, rt.lastSeqBySession);
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
    // 被拒绝或失败的编辑不记录（以 tool/result 为准）；没有 callId 的条目没有关联依据，保守地直接记录。
    if (entry.callId === undefined || !edits.failed.has(entry.callId)) {
      note(entry.name, entry.path);
    }
  }
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
  /** 会话的 cwd（turn-stopping 载荷里的 header.cwd）：相对路径的解析基准，也是记忆和总线的归属信息。 */
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
function handleGateFailure(scope: TurnScope, target: Gate, problem: GateProblem): boolean {
  const { rt, agent, cfg, messages, sessionId, turn, cwd } = scope;
  const { log, injectState, memoryNotice } = rt;
  const maxInjects = cfg.maxInjectsPerTurn;
  const isCodeFailure = problem.kind === GATE_KIND_CODE_FAILURE;
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
          ? gateText(messages, target, problem.text)
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
}

/** 批次开始之后的派生值与可变状态：`perGate` 和 `started` 在进入异步段时算定，`batch` 见它的注释。 */
interface GateBatchState extends GateBatchInput {
  perGate: number;
  started: number;
  batch: { blocked: boolean };
}

/**
 * 一条接一条地跑门禁（判断之间有顺序依赖：预算封顶 + 每次只注入一个失败），
 * 用尾递归往下走代替 for+await（避开 no-await-in-loop，语义不变）。
 */
async function processGate(state: GateBatchState, left: readonly Gate[]): Promise<void> {
  const { scope, shell, resolved, signal, budget, perGate, started, batch } = state;
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
    handleGateFailure(scope, gate, { kind: "not-run", text: skippedText(scope.messages, left) });
    return;
  }
  // 沙箱策略解析不出来 → 一条都不执行（not-run），绝不退回到部署级策略。
  const outcome: GateOutcome =
    resolved.kind === "unavailable"
      ? { kind: "not-run", text: resolved.reason }
      : await runGate(scope.messages, shell, gate, Math.min(perGate, remaining), {
          policy: resolved.policy,
          signal,
          stdoutMaxBytes: rt.stdoutMaxBytes,
          log: rt.log,
        });
  // 卸载之后：abort 才回来的迟到结果一律就地丢掉——不上报 lesson-loop（被中止的
  // 检查既不是代码失败的事实，也不是"请手动跑一次"的素材）、不注入。只靠 disposed 标记在注入前
  // 拦是不够的：门禁的子进程会活过卸载。
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
 * 一批门禁：按总预算封顶（perGate 最低 10s，可能超支）——跟踪已经花掉的时间，每条
 * 用 min(perGate, remaining)。剩下的时间不够最小可用预算时（真实的 tsc/pnpm 冷启动也要几秒，几百 ms
 * 必然超时 → 注入一条假的"超时失败"）**注入未执行的说明**——只 console.warn 等于静默通过。
 *
 * 两处防御：①整段最外层 try/catch——批次自己出问题只记一条 error，绝不产生
 * unhandledRejection；②批次的 promise 由调用方登记到"正在跑"的集合里，disposer abort 之后 await
 * 到全部结束（卸载必须终止并等待正在跑的工作）。
 */
async function runGateBatch(input: GateBatchInput): Promise<void> {
  const { scope } = input;
  const { rt, sessionId } = scope;
  try {
    const perGate = Math.max(10_000, Math.floor(input.budget / input.gates.length));
    // 计时的基准：每条检查可用的时间 = min(perGate, budget - 已花)。
    const started = Date.now();
    /** 是否有门禁没有给出"通过"的结论（code-failure 和 not-run 都算；只有全部 pass 才重置配额）。
     *  放在可变的持有对象里而不是 `let`：赋值都发生在 `processGate` 里，控制流分析看不见那两次
     *  写，批次结束后的读取点会被钉在初始值 false 上、`!batch.blocked` 就被判成永远成立——而"有检查没给出
     *  通过结论"是真会发生的（是否重置配额就取决于它）。读属性得到的是声明的 boolean，这个判断才是有效的。 */
    const batch: { blocked: boolean } = { blocked: false };
    await processGate({ ...input, perGate, started, batch }, input.gates);
    // 所有门禁都真的跑完并且通过 → 重置会话配额：模型已经修好，下一轮重新计数。
    // 只要有任何一条"没跑成"就不重置：那不等于代码是健康的。
    if (!batch.blocked) {
      rt.injectState.delete(sessionId);
    }
  } catch (error) {
    // 批次的最后一层保护：门禁调度自己出错（比如宿主的行为在执行期间突变）不能往外传——
    // 这一层没有 catch 的话，rejection 会直接变成 unhandledRejection。
    rt.log.error(`[quality-gate] ${sessionId}: gate batch failed: ${messageOf(error)}`);
  }
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
  /** 会话的 cwd（turn-stopping 载荷里的 header.cwd）：相对路径的解析基准，也是记忆和总线的归属信息。 */
  const { cwd } = session.header;
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
  const dropped = acc.droppedCount();
  const files = acc.drain();
  // 累加器到了容量上限而淘汰掉的内容要能看见（drain 已经把计数清零，所以先读再排空）
  if (dropped > 0) {
    rt.log.warn(
      `[quality-gate] ${sessionId}: ${dropped} edited file(s) evicted from accumulator cap; gate may miss their roots`,
    );
  }
  if (files.length === 0) {
    return;
  }

  const { gateBudgetMs: budget } = cfg;

  // 汇总项目根并探测要跑的门禁（一条门禁都没有就直接返回，不动配额）
  const gates = detectGate(projectRootsOf(files, rt.maxRootDepth, rt.log));
  if (gates.length === 0) {
    return;
  }
  // 沙箱策略在**同步段**按会话解析一次（进入异步段之后不再碰 agent.session）。
  const resolved = resolvePolicy(rt, messages, session);

  // 门禁批次的执行信号 = turn signal（回合取消时一起终止）加上 dispose abort（卸载时终止）。
  // AbortSignal.any 不接受 undefined（Node 26 实测抛 TypeError），两种情况先合并——
  // 因此传给 runGate 的 signal 一定有值。
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

  // 把门禁放到后台执行（shell.execute 返回 Promise；turn-stopping 是串行事件，不能占用太久）。
  // 配额按 sessionId 跨回合累计——门禁通过就重置，达到上限时注入一次"放行说明"之后保持静默，
  // 直到出现一次干净通过。这样"失败→注入→新回合又失败"的循环才被 maxInjects 真正约束住。
  const flight = runGateBatch({ scope, gates, shell, resolved, signal: gateSignal, budget });
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
    editLedger: { value: undefined },
    disposed: false,
  };

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
    // allSettled 会同步对 iterable 取快照（这些集合只在异步的收尾里删项，迭代期间不会变）。
    return Promise.allSettled(rt.inFlightGates);
  });
}

export default {
  inject: ["settings"],
  Config,
  apply,
};
