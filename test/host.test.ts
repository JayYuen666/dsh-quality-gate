// host.ts 单元测试：mock ctx 验证 quality-gate 全链。
// 核心场景：编辑代码文件 → turn-stopping → 门禁失败 → followup 注入修复指令。
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";

import path from "node:path";
import plugin, { shellArg } from "../host.ts";
// 0.1.7 隐式注册共用的测试替身：Config 引用、逐字段默认值、宿主 volatileForm 的复刻。
import {
  applyGate,
  configDict,
  patchEntryId,
  refsOf,
  schemaDefaults,
  volatileFormOf,
} from "./config-refs.ts";
import type { ConfigureCall, DescribeRow, SchemaNode } from "./config-refs.ts";
import { buildFeedbackText } from "../lib/feedback-content.ts";
import { pushGateFeedback } from "../lib/gateway-feedback.ts";
import { deriveAgentId } from "../lib/gateway-target.ts";
import { MESSAGES } from "../lib/messages.ts";
// setup-logs 的日志账本：logger 回退分支的断言用（host 走 console 时账本有记录，
// 走 ctx.logger 时账本必须为空）。
import { logged, loggedText } from "./setup-logs.ts";

// 夹具的值（本文件多处复用）。都是**测试自有**的期望值和输入常量：host 和 lib 没有导出
// 同名常量，故断言不会与实现共享同一份字面量（同义反复）。
/** ctx.credentials.resolve 命中的令牌明文（密钥只该从凭据通道来，不落设置）。 */
const CREDENTIAL_FIXTURE_TOKEN = "tok-from-credentials";
/** 项目根下的 npm 清单名。 */
const PKG_JSON = "package.json";
/** 项目根下的 TypeScript 配置名（给出 tsc 这条门禁的必要条件）。 */
const TSCONFIG = "tsconfig.json";
/** 临时项目里那个真实 TS 源文件的内容。 */
const TS_SOURCE_BODY = "export const x = 1\n";
/** 记忆反馈降级时那条 warn 的行内片段（用来数 warn 是不是只出现了一次）。 */
const MEMORY_SKIP_WARN_TEXT = "memory feedback skipped";

/** 轮询直到条件成立；到期返回 false（由调用方决定那一条红怎么写）。 */
async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const poll = async (): Promise<boolean> => {
    if (condition()) {
      return true;
    }
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await sleep(20);
    return poll();
  };
  return poll();
}
/** 本包的插件 id（logger 具名、patch 条目 id、设置命名空间三处同值）。 */
const PLUGIN_ID = "quality-gate";

// 本文件创建的临时项目根统一登记，各 suite 的 afterEach 显式回收。
// 只靠"系统清理 tmp 目录"不算回收：macOS 的 TMPDIR 清理并不激进，套件跑完的残留会一直
// 堆在盘上，所以这里显式 rmSync。
const scratchRoots: string[] = [];

/** 回收本文件登记的临时项目根（空清单时不动作）。 */
function recycleScratchRoots(): void {
  while (scratchRoots.length > 0) {
    rmSync(scratchRoots.pop()!, { recursive: true, force: true });
  }
}

// 把反馈这条路接上：只替换 pushGateFeedback（不向真实网关发送，也不联网）。正文与分桶键的纯函数现在分别在
// lib/feedback-content.ts / lib/gateway-target.ts，不在这枚 mock 覆盖的模块里 ⇒ 用的仍是真实现。
vi.mock(import("../lib/gateway-feedback.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/gateway-feedback.ts")>();
  // 必须返回 Promise：host 对 pushGateFeedback(...) 链 .catch（默认 undefined 会 TypeError）
  return { ...actual, pushGateFeedback: vi.fn<typeof pushGateFeedback>(() => Promise.resolve()) };
});

/** 沙箱执行事实（与 host 的 SandboxFacts 同形）。 */
interface MockSandboxFacts {
  mode: "read-only" | "workspace-write" | "danger-full-access";
  denied: boolean;
  enforcement?: "full" | "partial";
  runnerFailed?: boolean;
}

interface ShellSpec {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  signal?: AbortSignal;
  sandboxPolicy?: { mode: string; workspaceRoot: string; sessionId?: string };
}

/** ctx.credentials.resolve 的返回形状（与 dsh 凭据通道 ResolvedCredential 同形）。 */
interface CredentialHit {
  value: string;
  source: string;
}

/** ctx.logger(name) 具名 facade 的替身形状（host.ts 的 Log 同形）。 */
interface MockLog {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** 观察接口释放函数的测试替身：本文件的用例不数释放次数，只需要它在位。 */
function noopDispose(): void {
  void 0;
}

/**
 * 观察面替身的交付：读本次 fire 的 session 上夹具自己挂的那份日志与 fork 切点
 * （**只有测试侧**读 snapshotEvents 闭包——生产侧已改走官方的观察接口，见 mock 的 on）。
 * 状态挂在 ctx 上而不是模块级变量：模块级变量会让上一条用例的 session 泄漏到本条，
 * 且文件级 beforeEach 与 vitest 的用例结构规则冲突。
 * 返回类型刻意用 unknown，让被测代码自己那句数组判断生效，这样“交回来的不是数组”那一档也走得到。
 */
function observationOfFiredSession(ctx: MockCtx): {
  events: unknown;
  inheritedEventCount: number | undefined;
  [Symbol.dispose]: () => void;
} {
  const session = ctx.firedSession as
    | {
        snapshotEvents?: (from?: number) => unknown;
        inheritedEventCount?: number | undefined;
      }
    | undefined;
  const raw = typeof session?.snapshotEvents === "function" ? session.snapshotEvents(0) : [];
  // 刻意**不**在这里补默认值：夹具没挂 fork 切点时就这样返回 undefined，让被测代码自己那句
  // `observation.inheritedEventCount ?? 0` 的兜底分支真的被走到（在这里替它补默认值，就等于把
  // 那条分支从覆盖率与语义上一起抹掉）。
  const cut = session?.inheritedEventCount;
  return { events: raw, inheritedEventCount: cut, [Symbol.dispose]: noopDispose };
}

interface MockCtx {
  value: Record<string, unknown>;
  /** 本插件 fiber 的替身：configure 的 owner 必须原样带回它（身份断言用）。 */
  fiber: unknown;
  /** 最近一次 fire 的 agent.session：观察接口的替身据此返回夹具自己挂的日志与 fork 切点。 */
  firedSession?: unknown;
  /** settings.configure 的调用记录（页面策略断言用）。 */
  configureCalls: ConfigureCall[];
  handlers: Record<string, (payload: unknown) => void>;
  followupCalls: unknown[];
  shellCommands: ShellSpec[];
  gateExitCode: number | null;
  gateSignal: string | null;
  gateAborted: boolean;
  gateStderr: string;
  gateStdout: string;
  gateTimedOut: boolean;
  /**门禁结果附带的沙箱事实（undefined = 不是沙箱的执行器）。 */
  gateSandbox: MockSandboxFacts | undefined;
  /** stdout 是否标记为截断（harness CollectedOutput.truncated）。 */
  gateStdoutTruncated: boolean;
  /** 输出被截断时，完整内容写到磁盘的路径（host 会从里有界地读回头部摘录）。 */
  gateSpillPath: string | undefined;
  /** shell.execute 抛错（准备期失败 / SandboxUnavailableError）。 */
  shellRunError: Error | undefined;
  /** ctx.sandboxPolicy 服务（undefined = 组合里是非沙箱 executor）。 */
  sandboxPolicy: { resolve: (request: unknown) => unknown } | undefined;
  /** ctx.credentials 服务（undefined = 组合里没装凭据服务；记忆反馈据此降级不推送）。 */
  credentials: { resolve: (ref: string) => Promise<CredentialHit | undefined> } | undefined;
  /** resolve 的返回（undefined = 该引用未配置凭据）。 */
  credentialHit: CredentialHit | undefined;
  /** 被查过的凭据引用名（断言"非法引用/未启用时不得去查凭据"）。 */
  credentialRequests: string[];
  effects: (() => void)[];
  /** settings.describe() 的返回：跨命名空间读只此一条路（[]= 没有任何条目被投影）。 */
  describeRows: DescribeRow[];
  /** ctx.logger(name) 具名 logger 的调用记录（W4：host 日志走官方 logger 面）。
   *  undefined =测试替身没装 logger（异常的 ctx、旧的形态）：走 host 回退到 console 的那条兼容分支。 */
  logCalls: { name: string; type: "info" | "warn" | "error"; args: unknown[] }[];
  logger?: (name: string) => MockLog;
  settings: {
    /** 页面策略登记（本包自带卡片 → auto:false）。 */
    configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void;
    /** 全部条目的表单投影。 */
    describe: () => DescribeRow[];
  };
  /** ctx.inject(deps, fn)：cordis 立即用带齐依赖的子上下文回调一次。 */
  inject: (deps: readonly string[], attach: (child: unknown) => unknown) => void;
  /** 每条注入的 deps 与回调返回值：宿主靠返回值做子 fiber 的 setup 屏障，所以投影那一条必须是 thenable。 */
  injections: { deps: readonly string[]; result: unknown }[];
  /** 可选服务读取——镜像 cordis ctx.get：命中返回实例，未注册返回 undefined（不抛错）。 */
  get: (name: string) => unknown;
  /**
   * 官方事件读取接口（`ctx.sessionQuery.observeSession`）的替身：返回 fired session 那份日志
   * 切片，游标由生产侧自己切（见 host.ts 的 resolveEventWindow）。要模拟“未装配”就
   * `delete ctx.sessionQuery`，要模拟“拒绝/非数组交付”就整个换掉本字段（见 host-integrity）。
   */
  /** 官方的会话投影注册表（可以选择不注入）：默认 undefined = 精简的组合，门禁改用全量扫描。 */
  sessionProjections?: {
    register: (definition: unknown) => unknown;
    stateOf: (session: unknown, key: string) => unknown;
  };
  sessionQuery?: {
    observeSession: (id: string) => Promise<{
      events: unknown;
      inheritedEventCount: number | undefined;
      [Symbol.dispose]: () => void;
    }>;
  };
  on: (event: string, handler: (payload: unknown) => void) => void;
  effect: (fn: () => (() => void) | undefined) => void;
  shell: {
    resolve: (spec: ShellSpec) => ShellSpec;
    /** 0.1.7 唯一执行入口：结果从前台投影 handle.result() 取。 */
    execute: (spec: ShellSpec) => Promise<{
      result: () => Promise<{
        exitCode: number | null;
        signal?: string | null;
        stdout: { text: string; truncated: boolean; spillPath?: string };
        stderr: { text: string; truncated: boolean };
        timedOut?: boolean;
        aborted?: boolean;
        sandbox?: MockSandboxFacts;
      }>;
    }>;
  };
}

// Config schema 的引用测试替身（refsOf/applyGate/schemaDefaults/volatileFormOf/patchEntryId…）
// 与三个 host 测试共用，见 ./config-refs.ts。

function createMockCtx(): MockCtx {
  const ctx: MockCtx = {
    value: {
      enabled: true,
      maxInjectsPerTurn: 2,
      gateBudgetMs: 60_000,
      // 记忆反馈是"显式配置了才启用"的能力：mock 的运行期设置值给出本机以外的示例地址
      memoryFeedback: true,
      memoryGatewayUrl: "https://gateway.test:8420",
      memoryGatewayKeyRef: "TDAI_GATEWAY_KEY",
      // 非 volatile 的部署级设置：宿主 fork 的 resolve 对它们交普通值（不包 Volatile 引用）
      maxRootDepth: 10,
      gateStdoutMaxBytes: 65_536,
    },
    fiber: { id: "quality-gate-fiber" },
    configureCalls: [],
    handlers: {},
    followupCalls: [],
    shellCommands: [],
    gateExitCode: 0,
    gateSignal: null,
    gateAborted: false,
    gateStderr: "",
    gateStdout: "mock-gate-output\nerror TS2345 at line 12",
    gateTimedOut: false,
    gateSandbox: undefined,
    gateStdoutTruncated: false,
    gateSpillPath: undefined,
    shellRunError: undefined,
    sandboxPolicy: undefined,
    credentialHit: { value: CREDENTIAL_FIXTURE_TOKEN, source: "file" },
    credentialRequests: [],
    credentials: {
      // 和 cordis 的 ctx.get 按同一种契约：命中就返回实例；测试把 ctx.credentials 置成 undefined 就是模拟
      // 组合里没装凭据服务（get 读属性自然返回 undefined）。
      async resolve(ref: string) {
        ctx.credentialRequests.push(ref);
        return ctx.credentialHit;
      },
    },
    effects: [],
    describeRows: [],
    logCalls: [],
    sessionQuery: {
      observeSession: async () => observationOfFiredSession(ctx),
    },
    settings: {
      configure: (presentation: { auto?: boolean }, owner?: unknown) => {
        ctx.configureCalls.push({ presentation, owner });
        return (): void => {
          void 0;
        };
      },
      describe: () => ctx.describeRows,
    },
    inject: (deps, attach) => {
      // cordis 只在依赖齐备时激活子 fiber；替身按 ctx.get 判在位（settings 永远在，
      // sessionProjections 只有在用例显式装配时才注入）。
      if (deps.every((dep) => ctx.get(dep) !== undefined)) {
        ctx.injections.push({ deps, result: attach(ctx) });
      }
    },
    injections: [],
    on(event, handler) {
      // 记下本次 fire 的 agent.session，好让观察接口的替身返回那份夹具自己挂的日志——
      // **只有测试侧代码**去读夹具上的 snapshotEvents 闭包（生产侧已经不读它）。
      ctx.handlers[event] = (payload: unknown) => {
        ctx.firedSession = (payload as { agent?: { session?: unknown } }).agent?.session;
        handler(payload);
      };
    },
    // 镜像 cordis ctx.get：按属性名取服务，缺失返回 undefined（delete ctx.shell 即模拟无 shell 环境）。
    // 必须实现——host.ts 的 getShell() 只走 ctx.get，mock 少了它会把所有门禁都误判成通过。
    get(name) {
      return (ctx as unknown as Record<string, unknown>)[name];
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") {
        ctx.effects.push(cleanup);
      }
    },
    shell: {
      resolve(spec) {
        ctx.shellCommands.push(spec);
        return spec;
      },
      // 0.1.7 execute：准备期失败当场抛（等价旧 run 的抛点），成功才交出手柄；
      // 结果走前台投影 handle.result()。
      async execute(_spec: ShellSpec) {
        if (ctx.shellRunError !== undefined) {
          throw ctx.shellRunError;
        }
        return {
          result: async () => {
            if (ctx.gateTimedOut) {
              return {
                exitCode: null,
                stdout: { text: "", truncated: false },
                stderr: { text: "", truncated: false },
                timedOut: true,
                aborted: false,
              };
            }
            return {
              exitCode: ctx.gateExitCode,
              signal: ctx.gateSignal,
              stdout: {
                text: ctx.gateStdout,
                truncated: ctx.gateStdoutTruncated,
                ...(ctx.gateSpillPath === undefined ? {} : { spillPath: ctx.gateSpillPath }),
              },
              stderr: { text: ctx.gateStderr, truncated: false },
              aborted: ctx.gateAborted,
              timedOut: false,
              ...(ctx.gateSandbox === undefined ? {} : { sandbox: ctx.gateSandbox }),
            };
          },
        };
      },
    },
  };
  return ctx;
}

/** 造一个真实结构的临时项目根（package.json + ts 文件）。登记到 scratchRoots 供 afterEach 回收。 */
function makeProject(name: string): string {
  const root = path.join(
    tmpdir(),
    `qg-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, PKG_JSON), '{"name":"t","scripts":{"check":"tsc"}}');
  // tsconfig.json 必须存在——tsc 这条门禁要求那是真的 TS 项目（对应的回归断言见 gate.test.ts）
  writeFileSync(path.join(root, TSCONFIG), '{"compilerOptions":{},"include":["a.ts"]}');
  writeFileSync(path.join(root, "a.ts"), TS_SOURCE_BODY);
  scratchRoots.push(root);
  return root;
}

/** 编辑 a.ts 的 tool/call 事件（模块级复用，避免 describe 内重复创建）。 */
const gateEvt = (project: string): unknown[] => [
  {
    type: "tool/call",
    data: { name: "edit", arguments: JSON.stringify({ file_path: path.join(project, "a.ts") }) },
  },
];

/** 模块级 agent 构造（不捕获 describe 状态；agentFor 与 agentWith 同型，
 *  后者捕获测试 ctx 故留在各自 describe 内）。 */
function agentFor(events: unknown[]): {
  session: {
    id: string;
    header: Record<string, unknown>;
    snapshotEvents: (from?: number) => unknown[];
  };
  status: string;
  inbox: { nextTurn?: unknown[]; nextStep?: unknown[] };
  followup: (message: unknown) => void;
} {
  return {
    session: {
      id: "s-ws",
      header: {},
      snapshotEvents: (from?: number) => events.slice(from ?? 0),
    },
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    followup() {
      // 断言只看 shellCommands——注入内容不关心
    },
  };
}

/** 跑一个"本回合编辑过代码 + 回合结束"的回合（注入成功之后才可能推送记忆）。 */
async function runTurn(env: MockCtx, sessionId: string, log: unknown[]): Promise<void> {
  const agent = {
    session: {
      id: sessionId,
      header: {},
      snapshotEvents: (from?: number) => log.slice(from ?? 0),
    },
    status: "running",
    inbox: { nextTurn: [], nextStep: [] },
    followup(message: unknown) {
      env.followupCalls.push(message);
    },
  };
  env.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
  await sleep(30);
}

/** 收集 console.warn（记忆反馈的降级必须可观测，但绝不刷屏）。 */
async function collectWarns(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return lines;
}

/** 记忆反馈的跳过 warn 条数（同一环境的降级只该说一次）。 */
function skipWarnCount(lines: string[]): number {
  return lines.filter((line) => line.includes(MEMORY_SKIP_WARN_TEXT)).length;
}

describe("quality-gate host 接线", () => {
  let ctx: MockCtx;
  let project: string;
  beforeEach(() => {
    ctx = createMockCtx();
    project = makeProject("proj");
    applyGate(ctx, ctx.value);
  });

  afterEach(recycleScratchRoots);

  /** 指定文件名的编辑事件（project 是本 describe 的 beforeEach 状态，故留在这层）。 */
  const editEvtFor = (filename: string): unknown => ({
    type: "tool/call",
    data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/${filename}` }) },
  });

  function agentWith(
    _turn: number,
    events: unknown[],
  ): {
    session: {
      id: string;
      header: Record<string, unknown>;
      snapshotEvents: (from?: number) => unknown[];
    };
    status: string;
    inbox: { nextTurn?: unknown[]; nextStep?: unknown[] };
    followup: (message: unknown) => void;
  } {
    return {
      // 按真实 snapshotEvents(fromSeq) 语义 honor 增量游标（传空游标就是全量重读）
      session: { id: "s1", header: {}, snapshotEvents: (from?: number) => events.slice(from ?? 0) },
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg) {
        ctx.followupCalls.push(msg);
      },
    };
  }

  it("apply_patch 影响的多个文件会记入本回合并触发门禁", async () => {
    ctx.gateExitCode = 1;
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${path.join(project, "a.ts")}`,
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const events = [
      {
        type: "tool/call",
        data: { name: "apply_patch", arguments: JSON.stringify({ input: patch }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.ok(ctx.shellCommands.length > 0, "apply_patch 涉及的文件夹应触发项目的门禁");
  });

  it("隐式注册：只声明页面策略 configure({ auto: false })，owner 是本插件 fiber", () => {
    // 0.1.7 没有 settings.register：命名空间 = profile 条目 id，插件侧只剩页面策略。
    // owner 缺省是 settings 服务自己的 fiber —— 传错就等于给别人的页面定了策略。
    assert.equal(ctx.configureCalls.length, 1, "本包应只登记一次页面策略");
    assert.deepEqual(ctx.configureCalls[0]?.presentation, { auto: false });
    // 上一行的 strict deepEqual 是断言函数，已把首条记录收窄为非空，这里再写 `?.` 就是死守卫。
    assert.equal(ctx.configureCalls[0].owner, ctx.fiber);
  });

  it("内置默认逐字段落在 schema 上（0.1.6 交给 register 的 base 的等价迁移）", () => {
    assert.deepEqual(schemaDefaults(), {
      enabled: true,
      maxInjectsPerTurn: 2,
      // 预算是 300 秒（原来 120 秒时，大仓库会超时，然后静默放行）
      gateBudgetMs: 300_000,
      // 记忆反馈默认关闭 + 地址默认"未配置"：别人机器上没有作者那台本机网关
      memoryFeedback: false,
      memoryGatewayUrl: "",
      memoryGatewayKeyRef: "TDAI_GATEWAY_KEY",
      // 非 volatile 的部署级设置：默认值 = 迁移前硬编码的那个现值，cordis.yml 行 config 可改
      maxRootDepth: 10,
      gateStdoutMaxBytes: 65_536,
    });
  });

  it("部署假定值不标 volatile：不占设置卡，以普通值形态交进 apply", () => {
    // 宿主只投影 volatile 字段进表单；这两项是部署假定值，标了 volatile 反而会
    // 挤进设置卡。普通值形态（不经 .get()）由 applyGate/refsOf 的混合复刻保证——
    // 若误标 volatile，这里的 meta.volatile 断言当场红。
    for (const key of ["maxRootDepth", "gateStdoutMaxBytes"]) {
      const field = configDict()[key];
      assert.ok(field !== undefined, `schema 缺 ${key} 字段`);
      assert.notEqual(field.meta?.["volatile"], true, `${key} 必须保持非 volatile`);
      assert.ok(field.meta?.["default"] !== undefined, `${key} 必须带默认值（= 迁移前现值）`);
    }
  });

  it("本回合有编辑且门禁失败 → 注入修复指令（followup）", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1);
    const msg = ctx.followupCalls[0] as { content: { text: string }[] };
    assert.match(msg.content[0]!.text, /quality-gate/u);
    assert.match(msg.content[0]!.text, /tsc/u);
    assert.match(msg.content[0]!.text, /mock-gate-output/u);
    // 门禁在项目根执行
    assert.equal(ctx.shellCommands[0]?.workdir, project);
  });

  it("ctx.logger 在场时日志走具名 logger（quality-gate），不落 console", async () => {
    const env = createMockCtx();
    env.gateExitCode = 1;
    const loggerProject = makeProject("logger");
    env.logger = (name: string) => ({
      info: (...args: unknown[]) => {
        env.logCalls.push({ name, type: "info", args });
      },
      warn: (...args: unknown[]) => {
        env.logCalls.push({ name, type: "warn", args });
      },
      error: (...args: unknown[]) => {
        env.logCalls.push({ name, type: "error", args });
      },
    });
    // logger 必须在 apply 之前就位：host 在装载期取一次具名 logger（官方 ctx.logger(name)）。
    applyGate(env, env.value);
    await runTurn(env, "s-logger", gateEvt(loggerProject));
    const injected = env.logCalls.find(
      (call) => call.type === "info" && String(call.args[0]).includes("injected at turn"),
    );
    assert.ok(injected !== undefined, "注入事件要落具名 logger");
    assert.equal(injected.name, PLUGIN_ID, "ctx.logger(name) 取的是本包具名 logger");
    assert.equal(env.logCalls.length, 1, "正常失败回合只落注入这一条 info（其余面不刷日志）");
    // logger 在场时不得再落 console：setup-logs 账本（只收 console.*）必须为空。
    assert.equal(logged().length, 0, "回退 console 的兼容分支不得在 logger 在场时被走到");
  });

  it("注入 source 必须是 producer-owned kind（不得回退到 'plugin'）", async () => {
    // 0.1.7 的 V4 准入（session-format-v3-to-v4/src/message-sources.ts）对每个
    // 持久消息位拒收退役包装 `{ kind: 'plugin', plugin }`：followup 经 inbox 落
    // `agent/inbox/spliced`（agent-loop/src/inbox.ts 的 inserted 数组）正是被拒的
    // 持久位——这样的一条注入会让整个会话写不到磁盘。
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1);
    const msg = ctx.followupCalls[0] as { id: string; source: Record<string, unknown> };
    assert.notEqual(msg.source["kind"], "plugin");
    assert.equal(msg.source["kind"], "plugin:quality-gate", "须是 producer-owned 串");
    assert.equal(msg.source["plugin"], undefined, "退役包装的 plugin 字段不得再出现");
    assert.match(msg.id, /^quality-gate-/u, "身份迁移不动 id 前缀");
  });

  it("门禁通过 → 不注入（正常的回合结束）", async () => {
    ctx.gateExitCode = 0;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("门禁超时 → 注入超时的失败指令（不再静默放行）", async () => {
    ctx.gateTimedOut = true;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1, "超时必须注入，不能静默放过");
    const msg = ctx.followupCalls[0] as { content: { text: string }[] };
    assert.match(msg.content[0]!.text, /timeout|超时/u);
    assert.match(msg.content[0]!.text, /手动运行/u);
  });

  it("本回合没有编辑 → 不跑门禁（回合结束时零开销）", async () => {
    ctx.gateExitCode = 1;
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, []), turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 0);
  });

  it("子代理会话（origin=subagent）即使有编辑也不跑门禁", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    const subagent = {
      session: {
        id: "s-sub",
        header: { cwd: project, origin: "subagent", delegationDepth: 1 },
        snapshotEvents: (from?: number) => events.slice(from ?? 0),
      },
      status: "running",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    ctx.handlers["agent/turn-stopping"]!({ agent: subagent, turn: 1 });
    await sleep(20);
    // 子代理：不读编辑、不跑门禁、不注入——零副作用（不跳过就会重复跑门禁、followup 错位）
    assert.equal(ctx.shellCommands.length, 0, "子代理会话不得执行门禁命令");
    assert.equal(ctx.followupCalls.length, 0, "子代理会话不得注入修复指令");
  });

  it("delegationDepth>0 的子代理同样跳过（与 origin 判定构成双通道）", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    const subagent = {
      session: {
        id: "s-sub2",
        header: { cwd: project, delegationDepth: 2 },
        snapshotEvents: (from?: number) => events.slice(from ?? 0),
      },
      status: "running",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    ctx.handlers["agent/turn-stopping"]!({ agent: subagent, turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 0, "delegationDepth>0 的子代理不跑门禁");
    assert.equal(ctx.followupCalls.length, 0, "delegationDepth>0 子代理不注入");
  });

  it("注入配额按会话跨回合累计：到达上限时注入一次放行说明，之后不再出声（防止无休止地反复注入）", async () => {
    ctx.gateExitCode = 1;
    // 真实流程：每次 followup 注入都开新回合（turn+1）；配额必须按 session 跨回合累计，
    // 否则每回合都是新键、配额永不触顶 → "失败→注入→新回合又失败" 无限烧 token。
    const log: unknown[] = [];
    const agent = {
      session: { id: "s1", header: {}, snapshotEvents: (from?: number) => log.slice(from ?? 0) },
      // turn-stopping 时官方状态恒为 running
      status: "running",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    // 事件形状出自本 describe 的 editEvtFor（同一枚 push 闭包抄两遍会判在
    // sonarjs/no-identical-functions）；log 仍是用例自己的，跨用例不共享。
    const pushEdit = (): void => {
      log.push(editEvtFor("a.ts"));
    };
    // turn 1、2：两次修复注入（maxInjectsPerTurn=2）
    pushEdit();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
    await sleep(30);
    pushEdit();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 2 });
    await sleep(30);
    assert.equal(ctx.followupCalls.length, 2, "前两回合各注入一次修复指令");
    for (const message of ctx.followupCalls as { content: { text: string }[] }[]) {
      assert.match(message.content[0]!.text, /修复/u, "前两次是修复指令");
    }
    // 第 3 回合：配额用完 → 注入一次用户看得见的"放行说明"（不再静默 return）
    pushEdit();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 3 });
    await sleep(30);
    assert.equal(ctx.followupCalls.length, 3, "达上限注入一次放行说明");
    const giveUp = ctx.followupCalls[2] as { content: { text: string }[] };
    assert.match(giveUp.content[0]!.text, /停止自动修复|放行/u, "第三次是放行说明");
    // 第 4、5 回合：已经放行 → 不再出声，也不再注入（反复注入被真正管住了）
    pushEdit();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 4 });
    await sleep(30);
    pushEdit();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 5 });
    await sleep(30);
    assert.equal(ctx.followupCalls.length, 3, "放行之后不再出声：不会无限注入");
  });

  it("一次干净通过后注入配额重置并重新计数（不误伤后续修复）", async () => {
    const log: unknown[] = [];
    const agent = {
      session: { id: "s1", header: {}, snapshotEvents: (from?: number) => log.slice(from ?? 0) },
      status: "running",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    const pushEdit = (): void => {
      log.push(editEvtFor("a.ts"));
    };
    ctx.gateExitCode = 1;
    pushEdit();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
    await sleep(30);
    pushEdit();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 2 });
    await sleep(30);
    assert.equal(ctx.followupCalls.length, 2, "两次失败注入配额到顶");
    ctx.gateExitCode = 0;
    pushEdit();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 3 });
    await sleep(30);
    assert.equal(ctx.followupCalls.length, 2, "通过不注入");
    ctx.gateExitCode = 1;
    pushEdit();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 4 });
    await sleep(30);
    assert.equal(ctx.followupCalls.length, 3, "干净通过后配额重置，可重新注入");
  });

  it("通过或没有门禁的回合不消耗配额（quota 只在确认失败、准备注入之前扣）", async () => {
    // turn 5 先通过一次：配额不得动；随后同 turn 两次失败都应注入（2 次满额）
    const log: unknown[] = [];
    const agent = {
      session: { id: "s1", header: {}, snapshotEvents: (from?: number) => log.slice(from ?? 0) },
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    const pushEdit = (filename: string): void => {
      log.push(editEvtFor(filename));
    };
    ctx.gateExitCode = 0;
    pushEdit("a.ts");
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 5 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 0, "通过不注入");
    ctx.gateExitCode = 1;
    pushEdit("a.ts");
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 5 });
    await sleep(20);
    pushEdit("a.ts");
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 5 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 2, "通过的回合不得占用配额：同 turn 两次失败都应注入");
  });

  it("enabled=false → 不跑门禁", async () => {
    ctx.value["enabled"] = false;
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 0);
  });

  it("status=running（turn-stopping 时官方一直是 running）仍然照常执行门禁", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    // 官方 agent.ts：turn-stopping 在 running 相内 serial 分发，status getter 恒返回 'running'。
    // 按 status 提前返回会让门禁在真实使用里永远不执行。这里断言 running 状态能走到 gate。
    const running = { ...agentWith(1, events), status: "running" };
    ctx.handlers["agent/turn-stopping"]!({ agent: running, turn: 1 });
    await sleep(20);
    assert.ok(ctx.shellCommands.length > 0, "status=running 必须仍然跑门禁");
    assert.equal(ctx.followupCalls.length, 1, "门禁失败应该注入");
  });

  it("inbox 有待处理 → 跳过（不与用户排队工作抢话）", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    const busy = { ...agentWith(1, events), inbox: { nextTurn: [{ id: "queued" }], nextStep: [] } };
    ctx.handlers["agent/turn-stopping"]!({ agent: busy, turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 0, "inbox 忙时不跑门禁");
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("turn signal 已取消 → 不注入（preInjectCheck 数据信号）", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    const ctrl = new AbortController();
    ctrl.abort();
    const agent = { ...agentWith(1, events), status: "running" };
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1, signal: ctrl.signal });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 0, "turn 已取消不得注入");
  });

  it("exitCode null（信号杀死）失败注入 exit=signal(<name>)（不得通过）", async () => {
    ctx.gateExitCode = null;
    ctx.gateSignal = "SIGKILL";
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1, "信号已经失效时必须注入，不能静默放过");
    const msg = ctx.followupCalls[0] as { content: { text: string }[] };
    assert.match(msg.content[0]!.text, /exit=signal\(SIGKILL\)/u);
  });

  it("exitCode null 且 signal 缺失时注入 exit=signal(?) 失败", async () => {
    ctx.gateExitCode = null;
    ctx.gateSignal = null;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1, "信号已经失效时必须注入，不能静默放过");
    const msg = ctx.followupCalls[0] as { content: { text: string }[] };
    assert.match(msg.content[0]!.text, /exit=signal\(\?\)/u);
  });

  it("aborted=true 同样按失败注入（调用方取消时不能静默放过）", async () => {
    ctx.gateExitCode = null;
    ctx.gateAborted = true;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1, "取消时必须注入，不能静默放过");
    const msg = ctx.followupCalls[0] as { content: { text: string }[] };
    assert.match(msg.content[0]!.text, /abort|取消/iu);
  });

  it("失败证据含 stderr 尾部（不止 stdout）", async () => {
    ctx.gateExitCode = 1;
    ctx.gateStderr = "cargo-stderr-line-1\ncargo-stderr-line-2";
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1);
    const msg = ctx.followupCalls[0] as { content: { text: string }[] };
    assert.match(msg.content[0]!.text, /cargo-stderr-line-2/u);
  });

  it("连续两次 turn-stopping、无新 tool/call 时第二次零文件（增量游标不重读）", async () => {
    ctx.gateExitCode = 1;
    const events = [editEvtFor("a.ts")];
    // 真实会话语义：snapshotEvents(fromSeq) 按 seq 窗返回；同一 log 数组追加新事件
    const log: unknown[] = [...events];
    const agent = {
      session: { id: "s1", header: {}, snapshotEvents: (from?: number) => log.slice(from ?? 0) },
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
    await sleep(20);
    const afterFirst = ctx.shellCommands.length;
    assert.ok(afterFirst > 0, "第一次应该跑门禁");
    // 没有新的 tool/call：第二次 turn-stopping 应该读到零个新文件 → 不再跑门禁
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 2 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, afterFirst, "没有新编辑时第二次不得再跑门禁");
  });

  it("三条门禁共用很小的预算时总耗时有上限（每条取 min(perGate, remaining)，用完就停）", async () => {
    ctx.gateExitCode = 1;
    ctx.value["gateBudgetMs"] = 10_000;
    // 3 个项目根 → 3 gates：默认 ctx mock 无 projectRootsOf 注入点，
    // 用 3 个真实临时根各放一个 edit 事件（复用文件顶部的静态导入，别在用例里再 import 一次）
    const roots: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const root = path.join(tmpdir(), `qg-test-budget-${i}-${Date.now()}-${i}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, PKG_JSON), '{"name":"t"}');
      // tsconfig.json 必须存在——只有 package.json 的空壳不会给出 tsc 这条门禁
      writeFileSync(path.join(root, TSCONFIG), '{"compilerOptions":{}}');
      roots.push(root);
      scratchRoots.push(root);
    }
    const log: unknown[] = roots.map((root) => ({
      type: "tool/call",
      data: { name: "edit", arguments: JSON.stringify({ file_path: `${root}/a.ts` }) },
    }));
    const budgets: (number | undefined)[] = [];
    const origResolve = ctx.shell.resolve.bind(ctx.shell);
    ctx.shell.resolve = (spec) => {
      budgets.push(spec.timeoutMs);
      return origResolve(spec);
    };
    // shell.execute/result 睡 1s：前两门通过（循环继续）、第三门失败（注入后返回）——
    // 这样三门的 per-gate 都被记录，可断言收缩；无界实现会跑满 3×perGate(10s+)
    let runs = 0;
    ctx.shell.execute = async (_spec: ShellSpec) => {
      runs += 1;
      return {
        result: async () => {
          await sleep(1000);
          if (runs < 3) {
            return {
              exitCode: 0,
              stdout: { text: "ok", truncated: false },
              stderr: { text: "", truncated: false },
              aborted: false,
            };
          }
          return {
            exitCode: 1,
            stdout: { text: "slow-fail", truncated: false },
            stderr: { text: "", truncated: false },
            aborted: false,
          };
        },
      };
    };
    const agent = {
      session: { id: "s1", header: {}, snapshotEvents: (from?: number) => log.slice(from ?? 0) },
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    const t0 = Date.now();
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 9 });
    // 轮询等注入落定，而不是固定 sleep：固定等待会把「正确实现 ~3s 跑完」与「无界实现跑满」
    // 压成同一段 14 秒，紧跟其后的耗时断言就永远成立。到了时间还没注入，正是实现没有上限时该红的那一条。
    const settled = await waitUntil(() => ctx.followupCalls.length > 0, 14_000);
    const elapsed = Date.now() - t0;
    assert.ok(settled, `3 条门禁在小预算下没能在 14 秒内注入（实测 ${elapsed}ms）：总耗时没有上限`);
    assert.ok(elapsed < 10_000, `3 gates 小预算总耗时必须有界（实测 ${elapsed}ms）`);
    for (const budget of budgets) {
      assert.ok((budget ?? 0) <= 10_000, `per-gate 不得超总预算（实测 ${budget}）`);
    }
    assert.ok(
      budgets.length >= 2 && (budgets[1] ?? 0) < (budgets[0] ?? 0),
      `后门 per-gate 必须随剩余预算收缩（实测 ${JSON.stringify(budgets)}），否则总时长无界`,
    );
    // 注入恰好一次：等待条件已保证“至少一次”，等值断言才真正排除了“每次都注入”。
    assert.equal(ctx.followupCalls.length, 1, "一次只注入一个失败");
  });

  it("相对 file_path 沿 header.cwd 螺纹传递解析（不按 host CWD）", async () => {
    ctx.gateExitCode = 1;
    // 会话 cwd 就是临时项目根；事件给相对路径 a.ts（真实 edit 工具常报相对路径）
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: "a.ts" }) },
      },
    ];
    const agent = {
      ...agentWith(1, events),
      session: {
        id: "s1",
        header: { cwd: project },
        snapshotEvents: (from?: number) => (events as unknown[]).slice(from ?? 0),
      },
    };
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1, "相对路径应按 header.cwd 解析并命中门禁");
    assert.equal(ctx.shellCommands[0]?.workdir, project, "门禁应在解析出来的项目根执行");
  });

  it("turn-stopping 的 signal 透传给 shell（回合取消时门禁同命，不跑孤儿门禁）", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    const ctrl = new AbortController();
    const agent = {
      ...agentWith(1, events),
      session: {
        id: "s1",
        header: {},
        snapshotEvents: (from?: number) => (events as unknown[]).slice(from ?? 0),
      },
    };
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1, signal: ctrl.signal });
    await sleep(20);
    const spec = ctx.shellCommands[0] as { signal?: AbortSignal };
    // W4：spec 携带的是组合信号（turn signal ∪ dispose abort）——不是 turn signal 本体，
    // 但**跟着它一起取消**（AbortSignal.any 的语义），回合取消时门禁也一起取消。
    assert.notEqual(spec.signal, undefined, "resolve spec 必须携带信号");
    assert.notEqual(spec.signal, ctrl.signal, "组合信号是 AbortSignal.any 的新信号");
    ctrl.abort();
    assert.equal(spec.signal?.aborted, true, "turn signal 取消 → 组合信号同命");
    assert.equal(ctx.followupCalls.length, 1);
  });

  it("注入消息 id 为 randomUUID 形态（唯一、非 Date.now 碰撞）", async () => {
    ctx.gateExitCode = 1;
    const ids: string[] = [];
    // id = quality-gate-<randomUUID>：前缀命名空间 + 密码学随机后缀（同 ms 多次注入不碰撞）
    const uuidRe = /^quality-gate-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    // 会话日志追加写：三回合共享同一 log（游标语义下每回合读到各自的新事件）
    const log: unknown[] = [];
    const agent = {
      session: { id: "s1", header: {}, snapshotEvents: (from?: number) => log.slice(from ?? 0) },
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    {
      log.push({
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      });
      ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
      await sleep(20);
      ids.push((ctx.followupCalls.at(-1) as { id: string }).id);
      log.push({
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      });
      ctx.handlers["agent/turn-stopping"]!({ agent, turn: 2 });
      await sleep(20);
      ids.push((ctx.followupCalls.at(-1) as { id: string }).id);
      log.push({
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      });
      ctx.handlers["agent/turn-stopping"]!({ agent, turn: 3 });
      await sleep(20);
      ids.push((ctx.followupCalls.at(-1) as { id: string }).id);
    }
    assert.equal(new Set(ids).size, 3, "三次注入 id 必须唯一");
    for (const id of ids) {
      assert.match(id, uuidRe, `id 必须 randomUUID 形态（实测 ${id}）`);
    }
  });

  it("payload.turn 缺失或非数字时直接返回（不与 -1 共享配额键）", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
      },
    ];
    // turn 缺失：官方的 dispatch 总是带 turn；缺了它属于异常的载荷，直接放行、不跑门禁
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events) });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 0, "turn 不是数字时不得跑门禁");
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("shell 服务缺失时 warn 一次（静默放过也要能被观察到，且不刷屏）", async () => {
    const warns: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };
    try {
      const noShell = createMockCtx();
      // apply 不读 shell（只在回合里 getShell()），故先装载再摘掉服务：
      // 设置值必须仍然指向 noShell.value（enabled=true），否则这条测试会因为"门禁被
      // enabled=false 挡掉"而误判通过，而不是因为"没有 shell"。
      plugin.apply(noShell as never, refsOf(noShell.value) as never);
      delete (noShell as unknown as Record<string, unknown>)["shell"];
      const handler = noShell.handlers["agent/turn-stopping"]!;
      const events = [
        {
          type: "tool/call",
          data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
        },
      ];
      const mkAgent = (): unknown => ({
        session: {
          id: "s1",
          header: {},
          snapshotEvents: (from?: number) => (events as unknown[]).slice(from ?? 0),
        },
        status: "idle",
        inbox: { nextTurn: [], nextStep: [] },
        followup() {
          assert.fail("shell 缺失时不得注入");
        },
      });
      handler({ agent: mkAgent(), turn: 1 });
      handler({ agent: mkAgent(), turn: 2 });
      await sleep(20);
      const shellWarns = warns.filter((a) => String(a[0]).includes("shell"));
      assert.equal(shellWarns.length, 1, `shell 缺失只 warn 一次（实测 ${shellWarns.length} 次）`);
    } finally {
      console.warn = origWarn;
    }
  });

  it("ctx 是 cordis 的 Proxy（读没有 inject 的属性就抛错）时静默放行，不得抛错", () => {
    // 回归锚点：真实故障。cordis 的 ctx 是 Proxy，读未列入 inject 的属性抛
    // `cannot get property "shell" without inject`。createMockCtx 是普通对象，
    // 读不到就返回 undefined——正好掩盖了"代码写 svc.shell"这类 bug。
    // 本测试用 Proxy 复现真实语义：shell 直接属性访问抛错、ctx.get('shell') 返回 undefined。
    const warns: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };
    try {
      const base = createMockCtx();
      const proxy = new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === "shell") {
            throw new Error('cannot get property "shell" without inject');
          }
          if (prop === "get") {
            return (): undefined => undefined;
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      plugin.apply(proxy as never, refsOf(base.value) as never);
      const handler = (base.handlers as Record<string, (payload: unknown) => void>)[
        "agent/turn-stopping"
      ]!;
      const events = [
        {
          type: "tool/call",
          data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
        },
      ];
      const mkAgent = (): unknown => ({
        session: {
          id: "s1",
          header: {},
          snapshotEvents: (from?: number) => (events as unknown[]).slice(from ?? 0),
        },
        status: "running",
        inbox: { nextTurn: [], nextStep: [] },
        followup() {
          assert.fail("shell 缺失时不得注入");
        },
      });
      // 不抛即通过（旧实现 svc.shell 在此会抛，直接炸掉 turn）
      handler({ agent: mkAgent(), turn: 1 });
      assert.equal(
        warns.filter((a) => String(a[0]).includes("shell")).length,
        1,
        "shell 缺失应经 ctx.get 落到 C9 并 warn 一次",
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("exit 127（命令不存在）→ 未执行说明，不是通过也不是代码错误", async () => {
    const warns: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };
    try {
      ctx.gateExitCode = 127;
      // 127 只有 stderr 点名门禁命令自己（tsc）时才算"工具缺失"；这条用例验的就是那一支。
      ctx.gateStderr = "sh: tsc: command not found";
      ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, gateEvt(project)), turn: 1 });
      await sleep(20);
      assert.equal(ctx.followupCalls.length, 1, "没跑成的门禁不得静默放过");
      const msg = ctx.followupCalls[0] as { content: { text: string }[] };
      assert.match(msg.content.map((chunk) => chunk.text).join(""), /命令不存在/u);
      assert.ok(
        warns.some((a) => String(a[0]).includes("not-run")),
        "126/127 仍要打 warn 供运维排查",
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("真类型错误（exit 1 + TS 诊断，无 stub 横幅）仍报失败", async () => {
    ctx.gateExitCode = 1;
    ctx.gateStderr = "";
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, gateEvt(project)), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1, "真类型错误必须注入失败证据");
    const msg = ctx.followupCalls[0] as { content: { text: string }[] };
    assert.match(msg.content.map((chunk) => chunk.text).join(""), /TS2345/u);
  });

  it('首见会话重放历史是有意行为：不得改成"游标从末尾起步"（会跳过本回合编辑）', async () => {
    // 设计锚点（实测）：turn-stopping 时**本回合的编辑已在日志里**，
    // 若首次见到会话就把游标 seed 到 `snapshotEvents(0).length`，会跳过正在要检查的
    // 回合——门禁对真实的编辑悄悄失效（当时有一批既有测试因此全挂）。重启后重放历史只是
    // 多跑几次门禁，不会造成假失败：根必须是真正的 TS 项目（见 gate.test.ts 里那条回归）。
    const ctx2 = createMockCtx();
    applyGate(ctx2, ctx2.value);
    const events: unknown[] = gateEvt(project);
    const agent = {
      session: {
        id: "s-first-seen",
        header: {},
        snapshotEvents: (from?: number) => events.slice(from ?? 0),
      },
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      followup() {
        // 本测试不关心注入内容
      },
    };
    ctx2.gateExitCode = 0;
    (ctx2.handlers as Record<string, (payload: unknown) => void>)["agent/turn-stopping"]!({
      agent,
      turn: 1,
    });
    await sleep(20);
    assert.equal(ctx2.shellCommands.length, 1, "第一次见到的会话，本回合的编辑必须跑门禁");
  });

  it("md 文件的编辑不走门禁（不是代码）", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/README.md` }) },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 0);
  });

  it("被拒绝或失败的编辑不记录（按 tool/result 的 isError 过滤，以结果为准）", async () => {
    ctx.gateExitCode = 1;
    // 唯一那次编辑被拒绝（tool/result isError）→ 没有成功的编辑 → 不跑门禁
    const log: unknown[] = [
      {
        type: "tool/call",
        data: {
          name: "edit",
          callId: "c1",
          arguments: JSON.stringify({ file_path: `${project}/a.ts` }),
        },
      },
      {
        type: "tool/result",
        data: { message: { source: { callId: "c1" }, isError: true } },
      },
    ];
    const agent = {
      session: { id: "s1", header: {}, snapshotEvents: (from?: number) => log.slice(from ?? 0) },
      status: "running",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 0, "被拒绝的编辑不触发门禁");
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("成功的编辑（tool/result 不是 isError）照常记录并触发门禁", async () => {
    ctx.gateExitCode = 1;
    const log: unknown[] = [
      {
        type: "tool/call",
        data: {
          name: "edit",
          callId: "c2",
          arguments: JSON.stringify({ file_path: `${project}/a.ts` }),
        },
      },
      {
        type: "tool/result",
        data: { message: { source: { callId: "c2" }, isError: false } },
      },
    ];
    const agent = {
      session: { id: "s1", header: {}, snapshotEvents: (from?: number) => log.slice(from ?? 0) },
      status: "running",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
    await sleep(20);
    assert.ok(ctx.shellCommands.length > 0, "成功的编辑会触发门禁");
    assert.equal(ctx.followupCalls.length, 1);
  });

  it("str_replace_editor 的写命令记入门禁面（审查修复：并存编辑器不逃过门禁）", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: {
          name: "str_replace_editor",
          arguments: JSON.stringify({
            command: "str_replace",
            path: `${project}/a.ts`,
            old_str: "a",
            new_str: "b",
          }),
        },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 1, "str_replace_editor 的写操作触发门禁");
    assert.equal(ctx.shellCommands[0]?.workdir, project);
  });

  it("str_replace_editor 的 view（只读）不计入待门禁的文件", async () => {
    ctx.gateExitCode = 1;
    const events = [
      {
        type: "tool/call",
        data: {
          name: "str_replace_editor",
          arguments: JSON.stringify({ command: "view", path: `${project}/a.ts` }),
        },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 0, "view 是只读的，不触发门禁");
    assert.equal(ctx.shellCommands.length, 0);
  });

  it("缺 name 的 tool/call 不计入待门禁的文件（没有名字的调用连分桶键都算不出来）", async () => {
    ctx.gateExitCode = 1;
    // 参数形状与上面那条 str_replace_editor 一字不差，唯一区别是 data 里没有 name。共享层
    // 自 0.1.2 起在扫描阶段就把这种调用整条滤掉（本地 node_modules 装的就是那一版）；即便
    // 哪天真混了进来，isEditTool 也是拿空名去比三个工具名，不可能命中。两道都不放行，
    // 这里把它写成用例固定下来——免得日后有人把"滤掉"改成"静默补一个默认名字"而没人发现。
    const events = [
      {
        type: "tool/call",
        data: {
          arguments: JSON.stringify({
            command: "str_replace",
            path: `${project}/a.ts`,
            old_str: "a",
            new_str: "b",
          }),
        },
      },
    ];
    ctx.handlers["agent/turn-stopping"]!({ agent: agentWith(1, events), turn: 1 });
    await sleep(20);
    assert.equal(ctx.followupCalls.length, 0, "没有名字的调用不得触发门禁");
    assert.equal(ctx.shellCommands.length, 0);
  });

  it("fork 会话从 inheritedEventCount 切点起步（源码核对改进）", async () => {
    ctx.gateExitCode = 1;
    // 父会话前缀里的编辑落在另一个项目根——如果被算进来就会多跑一次门禁
    const parentRoot = makeProject("fork-parent");
    const parentEdit = {
      type: "tool/call",
      data: { name: "edit", arguments: JSON.stringify({ file_path: `${parentRoot}/a.ts` }) },
    };
    const ownEdit = {
      type: "tool/call",
      data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
    };
    const agent = {
      session: {
        id: "s-fork",
        header: {},
        inheritedEventCount: 1,
        snapshotEvents: (from?: number) => [parentEdit, ownEdit].slice(from ?? 0),
      },
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 1, "父前缀编辑不计入（切点起步）");
    assert.equal(ctx.shellCommands[0]?.workdir, project, "门禁只落在自己的根");
    // 游标推进正确：再次结束回合（没有新事件）不重放、不重复跑门禁
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 2 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 1, "游标已推进到末尾，没有重复的门禁");
  });

  it("session 缺 inheritedEventCount（旧形状）→ 退回从 0 起步的旧行为", async () => {
    ctx.gateExitCode = 1;
    const parentRoot = makeProject("nofork-parent");
    const parentEdit = {
      type: "tool/call",
      data: { name: "edit", arguments: JSON.stringify({ file_path: `${parentRoot}/a.ts` }) },
    };
    const ownEdit = {
      type: "tool/call",
      data: { name: "edit", arguments: JSON.stringify({ file_path: `${project}/a.ts` }) },
    };
    const agent = {
      session: {
        id: "s-nofork",
        header: {},
        snapshotEvents: (from?: number) => [parentEdit, ownEdit].slice(from ?? 0),
      },
      status: "idle",
      inbox: { nextTurn: [], nextStep: [] },
      followup(msg: unknown) {
        ctx.followupCalls.push(msg);
      },
    };
    ctx.handlers["agent/turn-stopping"]!({ agent, turn: 1 });
    await sleep(20);
    // 防御性的回退（宁可多跑也不漏）：父前缀的编辑也被算进来 →门禁落在父根（第一个失败注入之后就返回，
    // 所以恰好一条命令，但 workdir 是父根——与切点行为落在自己根形成对照）
    assert.equal(ctx.shellCommands.length, 1);
    assert.equal(ctx.shellCommands[0]?.workdir, parentRoot);
  });
});

// ══ ④ pnpm check 假失败防线 + create 编辑器 ════════════
/** 造一个带 pnpm-workspace.yaml 的临时根；checkScript 控制是否声明 check。 */
function makeWsProject(name: string, opts: { checkScript: boolean }): string {
  const root = path.join(
    tmpdir(),
    `qg-ws-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  const pkg = opts.checkScript
    ? '{"name":"t","scripts":{"check":"tsc"}}'
    : '{"name":"t","scripts":{"build":"tsc"}}';
  writeFileSync(path.join(root, PKG_JSON), pkg);
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");
  writeFileSync(path.join(root, TSCONFIG), '{"compilerOptions":{},"include":["a.ts"]}');
  writeFileSync(path.join(root, "a.ts"), TS_SOURCE_BODY);
  scratchRoots.push(root);
  return root;
}

describe("quality-gate: pnpm check script 探测", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyGate(ctx, ctx.value);
  });

  afterEach(recycleScratchRoots);

  it("workspace 根没有声明 check 脚本 → 不给门禁命令（workspace 根不降级到 tsc）", async () => {
    ctx.gateExitCode = 1;
    const ws = makeWsProject("nocheck", { checkScript: false });
    ctx.handlers["agent/turn-stopping"]!({ agent: agentFor(gateEvt(ws)), turn: 1 });
    await sleep(20);
    // 这种根的 tsconfig 多为 solution-style：`tsc --noEmit` 不检查子工程就退 0，
    // 给它就等于发一条永远通过的门禁。没有声明 check 就按"没有门禁"处理。
    assert.equal(ctx.shellCommands.length, 0, "不发 pnpm check，也不退化为 tsc");
    assert.equal(ctx.followupCalls.length, 0, "没有门禁就没有注入");
  });

  it("workspace 根声明了 check script → 仍发 pnpm check（作者同款工程行为不变）", async () => {
    ctx.gateExitCode = 1;
    const ws = makeWsProject("withcheck", { checkScript: true });
    ctx.handlers["agent/turn-stopping"]!({ agent: agentFor(gateEvt(ws)), turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 1);
    assert.equal(ctx.shellCommands[0]?.command, "pnpm check");
  });

  it("scripts 值为空字符串 → 不算声明了 check（也不退化为 tsc）", async () => {
    ctx.gateExitCode = 1;
    const ws = makeWsProject("emptyscript", { checkScript: false });
    writeFileSync(path.join(ws, PKG_JSON), '{"name":"t","scripts":{"check":""}}');
    ctx.handlers["agent/turn-stopping"]!({ agent: agentFor(gateEvt(ws)), turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 0, "空脚本 → 不给 pnpm check，也没有 tsc 可以改用");
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("package.json 不是合法 JSON（scripts 读不出来）→ 保守起见不给门禁", async () => {
    ctx.gateExitCode = 1;
    const ws = makeWsProject("badjson", { checkScript: true });
    writeFileSync(path.join(ws, PKG_JSON), "{not-json");
    ctx.handlers["agent/turn-stopping"]!({ agent: agentFor(gateEvt(ws)), turn: 1 });
    await sleep(20);
    // 信息缺失时连 tsc 都不给：这是防假失败那条一贯的取向（宁可不给门禁，也不猜）。
    assert.equal(ctx.shellCommands.length, 0, "读不到脚本清单时不猜");
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("package.json 根本读不到（不可读的路径）→ 同样不给门禁", async () => {
    ctx.gateExitCode = 1;
    const ws = makeWsProject("unreadable", { checkScript: true });
    // 「存在但读不出内容」的确定性形态：把 package.json 换成同名目录 → existsSync 命中、
    // readFileSync 抛 EISDIR（不依赖 chmod 权限位，root 下也稳定）。
    rmSync(path.join(ws, PKG_JSON), { force: true });
    mkdirSync(path.join(ws, PKG_JSON));
    ctx.handlers["agent/turn-stopping"]!({ agent: agentFor(gateEvt(ws)), turn: 1 });
    await sleep(20);
    assert.equal(ctx.shellCommands.length, 0);
    assert.equal(ctx.followupCalls.length, 0);
  });
});

// ══ 把门禁失败的反馈回流到记忆（默认关闭；地址和凭据都齐备才推送）══════
describe("quality-gate: memoryFeedback 反馈", () => {
  beforeEach(() => {
    vi.mocked(pushGateFeedback).mockReset();
  });

  afterEach(recycleScratchRoots);

  interface EnvPatch {
    gateExitCode?: number;
    memoryFeedback?: boolean;
    memoryGatewayUrl?: string;
    memoryGatewayKeyRef?: string;
    /** true = 模拟组合里没装凭据服务（ctx.get('credentials') → undefined）。 */
    noCredentials?: boolean;
    /** resolve 抛错（凭据服务自身故障）。 */
    credentialsThrow?: boolean;
    /** true = 该引用没配凭据（resolve 返回 undefined）。 */
    credentialMissing?: boolean;
  }

  /** 组装一个"门禁失败"的宿主环境（设置项和可插拔服务按 patch 覆盖）。 */
  function mkEnv(patch: EnvPatch = {}): MockCtx {
    const env = createMockCtx();
    const { value } = env;
    if (patch.memoryFeedback !== undefined) {
      value["memoryFeedback"] = patch.memoryFeedback;
    }
    if (patch.memoryGatewayUrl !== undefined) {
      value["memoryGatewayUrl"] = patch.memoryGatewayUrl;
    }
    if (patch.memoryGatewayKeyRef !== undefined) {
      value["memoryGatewayKeyRef"] = patch.memoryGatewayKeyRef;
    }
    if (patch.noCredentials === true) {
      env.credentials = undefined;
    }
    if (patch.credentialMissing === true) {
      env.credentialHit = undefined;
    }
    if (patch.credentialsThrow === true) {
      env.credentials = {
        async resolve() {
          throw new Error("credential store unreadable");
        },
      };
    }
    env.gateExitCode = patch.gateExitCode ?? 1;
    applyGate(env, env.value);
    return env;
  }

  it("确认门禁失败后写入反馈（发送目标 = 设置里的地址 + 凭据通道解析出来的 key）", async () => {
    const project = makeProject("fb1");
    const env = mkEnv();
    await runTurn(env, "s-fb1", gateEvt(project));
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 1);
    const [input, target] = vi.mocked(pushGateFeedback).mock.calls[0]! as [
      { command: readonly string[]; root: string; failure: string },
      { url: string; key: string; serviceId: string },
      unknown,
    ];
    assert.deepEqual(input.command, ["tsc", "--noEmit"]);
    assert.equal(input.root, project);
    assert.ok(input.failure.includes("mock-gate-output"), "失败证据随反馈一起写入记忆");
    assert.deepEqual(target, {
      url: "https://gateway.test:8420",
      key: CREDENTIAL_FIXTURE_TOKEN,
      // 默认服务名：本用例没设 TDAI_SERVICE_ID，宿主在解析目标时一次定值往下传，
      // 发送方不再自己读 env（否则服务名和 url/key 会来自两个不同的地方）。
      serviceId: "default",
    });
    assert.deepEqual(env.credentialRequests, ["TDAI_GATEWAY_KEY"], "key 走凭据通道，不拼文件路径");
  });

  it("memoryFeedback=false：既不写记忆也不查凭据（这个开关是第一道条件）", async () => {
    const project = makeProject("fb2");
    const env = mkEnv({ memoryFeedback: false });
    await runTurn(env, "s-fb2", gateEvt(project));
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0, "关闭时不写记忆");
    assert.deepEqual(env.credentialRequests, [], "关闭时不该去碰凭据服务");
  });

  it("memoryFeedback=true 但网关地址留空 → 不启用（双保险），且不去查凭据", async () => {
    const project = makeProject("fb-url");
    const env = mkEnv({ memoryGatewayUrl: "   " });
    const warns = await collectWarns(() => runTurn(env, "s-fb-url", gateEvt(project)));
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0);
    assert.deepEqual(env.credentialRequests, []);
    assert.equal(skipWarnCount(warns), 1, "未配置要可观测（一次即可）");
    assert.match(
      warns.find((line) => line.includes(MEMORY_SKIP_WARN_TEXT)) ?? "",
      /memoryGatewayUrl/u,
      "提示要说清缺的是哪一项",
    );
    assert.equal(env.followupCalls.length, 1, "记忆反馈缺失不影响修复注入");
  });

  it("凭据服务缺席 → 降级成不推送并 warn，绝不抛错（回合照常结束）", async () => {
    const project = makeProject("fb-nocred");
    const env = mkEnv({ noCredentials: true });
    const warns = await collectWarns(() => runTurn(env, "s-fb-nocred", gateEvt(project)));
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0);
    assert.match(warns.find((line) => line.includes(MEMORY_SKIP_WARN_TEXT)) ?? "", /credentials/u);
    assert.equal(env.followupCalls.length, 1, "缺凭据服务不得影响门禁的主流程");
  });

  it("同一环境反复降级 → 只 warn 一次（不刷屏）", async () => {
    const project = makeProject("fb-once");
    const env = mkEnv({ noCredentials: true });
    const log = gateEvt(project);
    const warns = await collectWarns(async () => {
      await runTurn(env, "s-fb-once", log);
      log.push(...gateEvt(project));
      await runTurn(env, "s-fb-once", log);
    });
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0);
    assert.equal(env.followupCalls.length, 2, "两个回合各自注入修复指令");
    assert.equal(skipWarnCount(warns), 1, `降级说明只发一次，实际：${warns.join(" | ")}`);
  });

  it("凭据引用名不合语法（含连字符）→ 不查凭据服务、不推送", async () => {
    const project = makeProject("fb-badref");
    const env = mkEnv({ memoryGatewayKeyRef: "tdai-gateway-key" });
    const warns = await collectWarns(() => runTurn(env, "s-fb-badref", gateEvt(project)));
    assert.deepEqual(env.credentialRequests, [], "坏名字没有引用可miss，不该送去 resolve");
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0);
    assert.match(
      warns.find((line) => line.includes(MEMORY_SKIP_WARN_TEXT)) ?? "",
      /memoryGatewayKeyRef/u,
    );
  });

  it("凭据引用未配置（resolve 返回 undefined）→ 不推送，warn 点出引用名", async () => {
    const project = makeProject("fb-missing");
    const env = mkEnv({ credentialMissing: true });
    const warns = await collectWarns(() => runTurn(env, "s-fb-missing", gateEvt(project)));
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0);
    assert.deepEqual(env.credentialRequests, ["TDAI_GATEWAY_KEY"]);
    assert.match(
      warns.find((line) => line.includes(MEMORY_SKIP_WARN_TEXT)) ?? "",
      /TDAI_GATEWAY_KEY/u,
    );
  });

  it("明文 http 的远端网关 → 凭据不解析、不发送，warn 点明只发 https 或本机", async () => {
    const project = makeProject("fb-plain-http");
    const env = mkEnv({ memoryGatewayUrl: "http://gateway.test:8420" });
    const warns = await collectWarns(() => runTurn(env, "s-fb-plain-http", gateEvt(project)));
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0, "明文连到远端时不发送");
    assert.deepEqual(env.credentialRequests, [], "拒绝发生在解析凭据之前");
    assert.match(warns.find((line) => line.includes(MEMORY_SKIP_WARN_TEXT)) ?? "", /明文 http/u);
  });

  it("凭据服务自身抛错 → 只 warn 注入照常（尽力而为）", async () => {
    const project = makeProject("fb-throw");
    const env = mkEnv({ credentialsThrow: true });
    const warns = await collectWarns(() => runTurn(env, "s-fb-throw", gateEvt(project)));
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0);
    assert.ok(
      warns.some((line) => line.includes("credential store unreadable")),
      "resolve 抛错要落到 warn 而不是崩回合",
    );
    assert.equal(env.followupCalls.length, 1);
  });

  it("门禁通过时不写记忆", async () => {
    const project = makeProject("fb3");
    const env = mkEnv({ gateExitCode: 0 });
    await runTurn(env, "s-fb3", gateEvt(project));
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0, "通过时不写记忆");
    assert.deepEqual(env.credentialRequests, [], "通过时不该查凭据");
  });

  it("buildFeedbackText：单行化 + 摘要（正文卫生，无换行噪音）", () => {
    const text = buildFeedbackText(
      {
        command: ["pnpm", "check"],
        root: "/r",
        failure: "exit=1\nline1\nline2\n\n\t more",
      },
      MESSAGES.zh,
    );
    assert.ok(text.startsWith("[quality-gate 反馈]"));
    assert.ok(text.includes("exit=1 line1 line2 more"));
    // 正文保持一段，第二行是固定的证据边界标注（来自仓库的失败文本不得以指令身份被召回）。
    assert.equal(text.split("\n").length, 2, "反馈正文一段 + 一行固定边界标注");
    assert.ok(text.endsWith(MESSAGES.zh.memoryEvidenceNotice), "带数据边界标注");
  });

  it("deriveAgentId：与网关插件同分桶语义（尾目录名-8位哈希）", () => {
    const id = deriveAgentId("/Users/x/work/proj dir/");
    assert.ok(id.startsWith("proj_dir-"), "尾目录名，空白换成 _");
    assert.match(id, /^proj_dir-[0-9a-f]{8}$/u);
    assert.equal(deriveAgentId(undefined), "default");
    assert.equal(deriveAgentId("/"), "default");
  });
});

// ══ 0.1.7 隐式注册验收：schema 默认 = 旧 base、volatileForm = 可编辑字段集 ══
//
// 为什么单独要这一条：0.1.7 的命名空间与可编辑字段都是**从 schema 反推**的，漏写一个
// `.volatile()` 不会报错，只会让那一项从设置卡上**静默消失**（宿主的 describe() 只投影
// volatileForm 的结果）；全漏则整条被跳过（settings/index.ts:308-309）、写入抛
// `has no volatile fields`。这类退化的单元测试全部通过，只有按宿主的同一条判据回头看
// schema 才拦得住。
describe("quality-gate 0.1.7 隐式注册验收", () => {
  afterEach(recycleScratchRoots);

  /** 设置卡该能编辑的字段（本包六项全是实时项，一个都不该漏）。 */
  const EDITABLE = [
    "enabled",
    "gateBudgetMs",
    "maxInjectsPerTurn",
    "memoryFeedback",
    "memoryGatewayKeyRef",
    "memoryGatewayUrl",
  ];

  it("命名空间 = cordis.patch.yml 的条目 id", () => {
    assert.equal(patchEntryId(), PLUGIN_ID);
  });

  it("volatileForm(Config) 的字段集恰为六项可编辑字段", () => {
    const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
    assert.ok(form !== null, "没有任何 volatile 字段 → 宿主 describe() 整条跳过本条目");
    assert.deepEqual(form.toSorted(), EDITABLE, "投影字段集与设置卡预期可编辑项不一致");
    assert.deepEqual(
      Object.keys(configDict()).toSorted(),
      [...EDITABLE, "gateStdoutMaxBytes", "maxRootDepth"].toSorted(),
      "schema 字段全集 = 六项可编辑字段 + 两项非 volatile 部署值（maxRootDepth / " +
        "gateStdoutMaxBytes，W4）：多了要同步这张清单，少了说明字段被误删",
    );
  });

  it("memoryGatewayUrl 的默认是空串（不是缺省）：双保险语义靠它承载", () => {
    // "" + memoryFeedback=false = 永不推送；改成 undefined 会把"未配置"变成"字段不存在"，
    // 读侧形状与 resolveGatewayUrl 的降级判定都不再等价。
    assert.equal(configDict()["memoryGatewayUrl"]?.meta?.["default"], "");
  });

  it("凭据引用字段：role('credential-ref') 与 volatile 同时成立", () => {
    // role 只往 meta 里加键（fork 的 role/volatile 都是 {...meta, k:v} 展开），顺序不该
    // 抹掉 volatile；一旦抹掉，这一项就从设置卡上消失，用户再没法改密钥引用名。
    const field = configDict()["memoryGatewayKeyRef"];
    assert.equal(field?.meta?.["role"], "credential-ref", "设置卡上要按凭据引用呈现");
    // 上一行的 strict assert 已把 field 与 field.meta 一起收窄为非空（缺任何一环它自己先红），
    // 这两行再写 `?.` 就是死守卫。
    assert.equal(field.meta["volatile"], true, "role 不许吃掉 volatile");
    assert.equal(field.meta["default"], "TDAI_GATEWAY_KEY");
  });
});

// ══ 行级 config（cordis 按 schema 填过默认的引用 → apply）──────────
/** 复刻 cordis 交给 apply 的那份 config：行 config 覆盖 schema 默认（合并发生在宿主侧）。 */
function rowValue(row: Record<string, unknown>): Record<string, unknown> {
  return { ...schemaDefaults(), ...row };
}

/** 官方 locale 条目在 describe() 里的那一行。 */
function localeRow(value: unknown): DescribeRow {
  return { ns: "locale", value };
}

describe("quality-gate 行级 config", () => {
  afterEach(recycleScratchRoots);

  it("config 那一行的 enabled=false 生效：一条门禁都不下发", async () => {
    const ctx = createMockCtx();
    const project = makeProject("row-off");
    applyGate(ctx, rowValue({ enabled: false, gateBudgetMs: 30_000 }));
    await runTurn(ctx, "s-row-off", gateEvt(project));
    assert.equal(ctx.shellCommands.length, 0, "enabled=false 时不该跑门禁");
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("读的是引用不是快照：把 enabled 改回 true，下一回合门禁就恢复（不需要重新挂载）", async () => {
    const ctx = createMockCtx();
    const project = makeProject("row-live");
    const value = rowValue({ enabled: false });
    applyGate(ctx, value);
    await runTurn(ctx, "s-row-live", gateEvt(project));
    assert.equal(ctx.shellCommands.length, 0, "先确认关着");
    // 设置卡写入：宿主把新值提交进**同一枚**引用（`loader/volatile-update`），引用不变。
    value["enabled"] = true;
    await runTurn(ctx, "s-row-live", gateEvt(project));
    assert.equal(ctx.shellCommands.length, 1, "同一枚引用改值即生效");
  });

  it("组合包层行 config 可为作者本机打开记忆反馈并填自己的网关地址", async () => {
    vi.mocked(pushGateFeedback).mockReset();
    const ctx = createMockCtx();
    const project = makeProject("row-memory");
    ctx.gateExitCode = 1;
    applyGate(
      ctx,
      rowValue({
        memoryFeedback: true,
        memoryGatewayUrl: "http://127.0.0.1:8420",
        memoryGatewayKeyRef: "TDAI_GATEWAY_KEY",
      }),
    );
    await runTurn(ctx, "s-row-memory", gateEvt(project));
    assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 1, "行 config 开了就要推送");
    // 第二参才是 GatewayTarget（第一参是反馈载荷），按下标取会被 prefer-destructuring 拦下。
    const [, target] = vi.mocked(pushGateFeedback).mock.calls[0]!;
    assert.equal(target.url, "http://127.0.0.1:8420");
    assert.equal(target.key, CREDENTIAL_FIXTURE_TOKEN, "密钥只从凭据通道解析，不落设置");
  });

  it("行级 config 的 gateStdoutMaxBytes 直达 shell.resolve 的 spec（部署值下传）", async () => {
    const ctx = createMockCtx();
    ctx.gateExitCode = 1;
    const project = makeProject("row-stdout");
    applyGate(ctx, rowValue({ gateStdoutMaxBytes: 1024 }));
    await runTurn(ctx, "s-stdout", gateEvt(project));
    assert.equal(ctx.shellCommands.length, 1);
    assert.equal(
      ctx.shellCommands[0]?.stdoutMaxBytes,
      1024,
      "stdout 的捕获上限不再是硬编码的 64KiB：改 cordis.yml 里的值就生效（判据见 config.md 里 volatile 字段那一段）",
    );
  });

  it("行级 config 收紧 maxRootDepth 后深度不够即截断并 warn（不再硬编码 10 层）", async () => {
    const ctx = createMockCtx();
    ctx.gateExitCode = 1;
    const deep = makeProject("row-depth");
    const sub = path.join(deep, "nested");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "a.ts"), TS_SOURCE_BODY);
    // 深度=1：文件在清单根的下一层目录 → 往上只有一步、到不了根 → 没有任何门禁。
    // 对照：默认 10 层时同样布局能命中（其余用例即走默认路径）。
    applyGate(ctx, rowValue({ maxRootDepth: 1 }));
    const events = [
      {
        type: "tool/call",
        data: { name: "edit", arguments: JSON.stringify({ file_path: path.join(sub, "a.ts") }) },
      },
    ];
    await runTurn(ctx, "s-depth", events);
    assert.equal(ctx.shellCommands.length, 0, "深度=1 找不到上一层的清单根 → 没有任何门禁");
    assert.match(
      loggedText(),
      /no manifest within 1 levels/u,
      "深度截断必须可观测，且数字来自 Config（不是旧常量 10）",
    );
  });
});

// ══ i18n：注入给模型的文案语言与官方 locale 偏好同源 ──────────────────────
/**
 * 跑一次"门禁失败"的回合结束并返回注入的正文。变量是 settings.describe() 的返回值：
 * 0.1.7 的跨命名空间读只有它一条路（`register`/`get` 都已被宿主移除）。
 */
async function injectedText(rows: DescribeRow[]): Promise<string> {
  const project = makeProject("i18n");
  const env = createMockCtx();
  env.gateExitCode = 1;
  env.describeRows = rows;
  applyGate(env, env.value);
  await runTurn(env, "s-i18n", gateEvt(project));
  assert.equal(env.followupCalls.length, 1, "门禁失败必须注入一次修复指令");
  const message = env.followupCalls[0] as { content: { text: string }[] };
  return message.content[0]?.text ?? "";
}

describe("quality-gate 注入文案双语（@deepseek-ai/dsh-client-locale 的 settings 偏好）", () => {
  afterEach(recycleScratchRoots);

  it("locale 条目没被投影（describe() 空表）→ 中文默认（与迁移前逐字一致），不抛", async () => {
    const text = await injectedText([]);
    assert.match(text, /回合收口门禁未通过/u, "中文标题行");
    assert.match(text, /请修复上述问题后结束回合/u, "中文修复指令");
  });

  it("describe() 里只有别的命名空间 → 不把别人的 value 当 locale 读，仍中文默认", async () => {
    // 迁移前靠 `settings.get('locale')` 精确取；现在是"在整张表里挑 ns==='locale'"，
    // 这里钉住的就是那个 find 用的键，写成 rows[0] 也会在这里失败。
    const text = await injectedText([{ ns: PLUGIN_ID, value: { preference: "en-US" } }]);
    assert.match(text, /请修复上述问题后结束回合/u);
    assert.equal(text.includes("{"), false, "模板变量不得漏进正文");
  });

  it("官方偏好为 en-US 时，注入的修复指令是英文且不残留中文", async () => {
    const text = await injectedText([localeRow({ preference: "en-US" })]);
    assert.match(text, /did not pass/u, "英文标题行");
    assert.match(text, /Fix the problems above/u, "英文修复指令");
    assert.doesNotMatch(text, /修复|门禁|回合/u, "整条正文不该混进中文");
    assert.equal(text.includes("{"), false, "模板变量不得漏进正文");
  });

  it("官方偏好为非法值（连主语言子标签都不是）→ 中文默认", async () => {
    const text = await injectedText([localeRow({ preference: "fr-CA" })]);
    assert.match(text, /请修复上述问题后结束回合/u);
  });

  it("没跑成的检查也按语言注入（en 偏好下 not-run 说明是英文）", async () => {
    const project = makeProject("i18n-notrun");
    const env = createMockCtx();
    env.gateExitCode = 127;
    // 127 只有 stderr 点名门禁命令（tsc）时才算「工具装不上」；这里验证按语言渲染 not-run 的文案。
    env.gateStderr = "sh: tsc: command not found";
    env.describeRows = [localeRow({ preference: "en" })];
    applyGate(env, env.value);
    await runTurn(env, "s-i18n-notrun", gateEvt(project));
    assert.equal(env.followupCalls.length, 1, "工具装不上按未执行注入");
    const message = env.followupCalls[0] as { content: { text: string }[] };
    const text = message.content[0]?.text ?? "";
    assert.match(text, /could not run/u, "英文未执行说明");
    assert.match(text, /command not found/u, "英文成因短语");
    assert.doesNotMatch(text, /未能执行|命令不存在/u, "不残留中文");
  });
});

describe("门禁命令拼接时的引号处理", () => {
  it("无元字符的路径原样，含空白或单引号的路径加单引号", () => {
    assert.equal(shellArg("/usr/local/bin/tsc"), "/usr/local/bin/tsc");
    assert.equal(shellArg("/opt/my tools/tsc"), "'/opt/my tools/tsc'");
    assert.equal(shellArg("/opt/it's/tsc"), String.raw`'/opt/it'\''s/tsc'`);
  });
});

// ── 编辑台账投影的读取路径 ────────────────────────────────────────────────
// 投影只是性能优化，不是判断的前提：读取函数缺席、形状不对、或者 fork 出来的会话，一律回退到用观察接口全量扫描。
describe("编辑台账投影的读取路径", () => {
  let ctx: MockCtx;
  let project: string;
  let observed: number;

  /** 装配一台带 sessionProjections 的样子：state 现取（用例可中途换形状/换代）。 */
  async function armProjection(state: () => unknown): Promise<void> {
    ctx.sessionProjections = {
      register: () => (): void => {
        void 0;
      },
      stateOf: () => state(),
    };
    const original = ctx.sessionQuery;
    assert.ok(original !== undefined, "默认的夹具应该带上观察接口");
    observed = 0;
    ctx.sessionQuery = {
      observeSession: (id: string) => {
        observed += 1;
        return original.observeSession(id);
      },
    };
    applyGate(ctx, ctx.value);
    // 挂载是异步的（register 的返回值只能在 await 之后判别）：等一拍再发回合。
    await sleep(0);
  }

  const agentOf = (seq: number | undefined, isSeeded = false): unknown => ({
    session: {
      id: "s-proj",
      header: { cwd: project, isSeeded },
      ...(seq === undefined ? {} : { seq }),
      snapshotEvents: () => [],
    },
    status: "running",
    inbox: { nextTurn: [], nextStep: [] },
    followup(msg: unknown) {
      ctx.followupCalls.push(msg);
    },
  });

  const validLedger = (): unknown => ({
    edits: [{ seq: 0, callId: "c1", name: "edit", path: `${project}/a.ts`, failed: false }],
  });

  beforeEach(() => {
    ctx = createMockCtx();
    project = makeProject("proj");
    ctx.gateExitCode = 1;
  });

  afterEach(recycleScratchRoots);

  it("注入的回调把注册结果返回成 thenable，兑现之后读取函数就就位", async () => {
    // 钉两件事：①回调返回的是这次挂载的 promise（`void` 写法回潮时这一格红）；②await 它
    // 就够了——不靠多等几轮，读取函数随着回调兑现一起装上（返回一个空的 promise 时第二条会失败）。
    let released = 0;
    ctx.sessionProjections = {
      register: () =>
        Promise.resolve({
          stateOf: (): unknown => ({
            edits: [
              { seq: 0, callId: "c1", name: "edit", path: `${project}/a.ts`, failed: false },
              { seq: 1, callId: "c2", name: "edit", path: `${project}/b.ts`, failed: false },
            ],
          }),
          dispose: (): void => {
            released += 1;
          },
        }),
      stateOf: (): unknown => undefined,
    };
    const original = ctx.sessionQuery;
    assert.ok(original !== undefined, "默认的夹具应该带上观察接口");
    observed = 0;
    ctx.sessionQuery = {
      observeSession: (id: string) => {
        observed += 1;
        return original.observeSession(id);
      },
    };
    applyGate(ctx, ctx.value);
    const setup = ctx.injections.find((entry) => entry.deps.includes("sessionProjections"))?.result;
    assert.ok(
      ctx.injections.some((entry) => entry.deps.includes("sessionProjections")),
      "夹具要记下投影那一条注入，否则下面的断言是在对着空集合判断",
    );
    assert.equal(
      typeof (setup as { then?: unknown } | undefined)?.then,
      "function",
      "注入回调必须把这次挂载交回给宿主——cordis 按子 fiber 的 setup 屏障等待它",
    );
    await setup;
    ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(1), turn: 1 });
    await sleep(20);
    assert.equal(observed, 0, "兑现之后本回合走投影的读取函数，不扫整份日志");
    assert.equal(released, 0, "没卸载就不该释放这次注册");
  });

  it("投影在位：读台账、不碰整日志观察面，编辑照常触发门禁", async () => {
    // 第二条没有路径（空串）→ 记进台账但不会被解析成项目根；门禁仍由有路径的那条触发。
    await armProjection(() => ({
      edits: [
        { seq: 0, callId: "c1", name: "edit", path: `${project}/a.ts`, failed: false },
        { seq: 1, callId: "c2", name: "edit", path: "", failed: false },
      ],
    }));
    ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(1), turn: 1 });
    await sleep(20);
    assert.equal(observed, 0, "编辑台账可读时不调 observeSession");
    assert.equal(ctx.shellCommands.length, 1, "台账里的编辑触发门禁");
    assert.equal(ctx.shellCommands[0]?.workdir, project);
  });

  it("失败的条目被跳过：只剩失败的编辑时门禁不跑", async () => {
    await armProjection(() => ({
      edits: [{ seq: 0, callId: "c1", name: "edit", path: `${project}/a.ts`, failed: true }],
    }));
    ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(1), turn: 1 });
    await sleep(20);
    assert.equal(observed, 0);
    assert.equal(ctx.shellCommands.length, 0, "被失败结果否定的编辑不记录");
  });

  it("fork 出来的会话（isSeeded）→ 回退到观察接口：继承前缀的切点只有观察接口给得出", async () => {
    await armProjection(validLedger);
    ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(1, true), turn: 1 });
    await sleep(20);
    assert.equal(observed, 1);
  });

  it("编辑台账不可读（形状不对）→ 回退到观察接口", async () => {
    await armProjection(() => ({ edits: "not-an-array" }));
    ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(1), turn: 1 });
    await sleep(20);
    assert.equal(observed, 1, "坏状态按不可读处理，不当作没有编辑");
  });

  it("会话没有 seq → 回退到观察接口", async () => {
    await armProjection(validLedger);
    ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(undefined), turn: 1 });
    await sleep(20);
    assert.equal(observed, 1, "推不动游标就不该走投影");
  });
});
