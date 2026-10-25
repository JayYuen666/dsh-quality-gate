// 门禁完整性测试（2026-09 审计项 1–8 的回归锚点）。
//
// 唯一问题：**一次没跑成 / 出错的检查，会不会被当成通过？** 本文件逐条钉住：
//   1. 编辑记账按 sessionId 分账（跨会话不互相偷走待复查编辑）；
//   2. 跑检查前按会话解析 sandboxPolicy 并传给 shell（否则沙箱版 executor 用部署级
//      策略、根 = 宿主 cwd → 写沙箱外被拒 → 假的"修这些错"注入 + 污染记忆/lesson-loop）；
//   3. ShellRunResult.sandbox.{denied,runnerFailed,enforcement} 必须被读；
//      SandboxUnavailableError（run 会抛）绝不再落进 catch 报 PASS；
//   4. CollectedOutput.truncated 要标注，并从 spillPath 有界读回**头部**摘录；
//   5. 预算耗尽跳过 → 注入"未执行"说明（host-contract 里另有一条）；
//   6. 准备期抛错（workdir 不存在/spawn 失败）→ 未执行说明，不是通过；
//   7. 只有 ruff.toml 的 Python 工程也要拿到根与门禁；
//   8. 插件卸载后异步门禁闭包不得再注入；会话级 Map 预算淘汰可观测。
import { describe, it, vi, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// 0.1.7 隐式注册的共用桩件：apply 的第二参要的是引用、不是快照。
import { applyGate, schemaDefaults } from "./config-refs.ts";
import { EditAccumulator } from "../lib/accumulator.ts";
import { pushGateFeedback } from "../lib/gateway-feedback.ts";

// 网关推送不触网（真实实现会连 127.0.0.1:8420）；纯函数保留真实现。
vi.mock(import("../lib/gateway-feedback.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/gateway-feedback.ts")>();
  return {
    ...actual,
    // 显式类型参数 = 被替身顶掉的那条真实签名（vitest/require-mock-type-parameters）：
    // 参数面直接从 actual 上取，替身与 lib/gateway-feedback.ts 的入参不会再漂移。
    pushGateFeedback: vi.fn<(...args: Parameters<typeof actual.pushGateFeedback>) => Promise<void>>(
      () => Promise.resolve(),
    ),
  };
});

/** 超过会话预算的额外会话数（配合 s-first 共 > 50 → 触发淘汰）。 */
const SESSION_COUNT = 52;

// 夹具值与期望值（本文件多处复用；host/lib 侧没有导出同名常量，断言不与实现共享字面量）。
/** 项目根下的 npm 清单名。 */
const PKG_JSON = "package.json";
/** 项目根下的 TypeScript 配置名（tsc 门禁的必要条件）。 */
const TSCONFIG = "tsconfig.json";
/** 最小可用的 tsconfig 内容（够 tsc 门禁认它是真 TS 项目）。 */
const MINIMAL_TSCONFIG_JSON = '{"compilerOptions":{}}';
/** 沙箱模式：工作区可写（门禁写盘该走的那一档）。 */
const SANDBOX_MODE_WORKSPACE_WRITE = "workspace-write";
/** lesson 总线里"检查没跑成"那一类的 category 期望值。 */
const BUS_CATEGORY_NOT_RUN = "gate-not-run";

interface SandboxFacts {
  mode: "read-only" | "workspace-write" | "danger-full-access";
  denied: boolean;
  enforcement?: "full" | "partial";
  runnerFailed?: boolean;
}

/** 单流捕获输出：truncated 必填——host 读的是 harness CollectedOutput 的必选字段，
 *  mock 省略会把"未截断"悄悄变成"已截断"（`!undefined === true`），测试会假绿。 */
interface Stream {
  text: string;
  truncated: boolean;
  spillPath?: string;
}

interface RunResult {
  exitCode: number | null;
  signal?: string | null;
  stdout: Stream;
  stderr: Stream;
  timedOut?: boolean;
  aborted?: boolean;
  sandbox?: SandboxFacts;
}

interface Spec {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  signal?: AbortSignal;
  sandboxPolicy?: { mode: string; workspaceRoot: string; sessionId?: string };
}

interface Report {
  category: string;
  detail: string;
  evidence: Record<string, unknown>;
}

/** 本次 fire 交进来的 agent.session（观察面替身的日志来源，见下面 mock 的 on）。 */
let firedSession: unknown;

/**
 * 观察面替身的交付：读 fired session 上夹具挂的那份日志与 fork 切点（**只有测试侧**读
 * snapshotEvents 闭包——生产侧已改走官方 ctx.sessionQuery.observeSession，见 host.ts 的
 * SessionQueryFace）。返回刻意留 unknown，好让被测代码自己的数组判据与"非数组交付"那档
 * 照样喂得进去。
 */
function observationOfFiredSession(): {
  events: unknown;
  inheritedEventCount: number | undefined;
} {
  const session = firedSession as
    | { snapshotEvents?: (from?: number) => unknown; inheritedEventCount?: number | undefined }
    | undefined;
  const raw = typeof session?.snapshotEvents === "function" ? session.snapshotEvents(0) : [];
  // 刻意**不**在这里补默认值：夹具没挂 fork 切点时就此交 undefined，让被测代码自己那句
  // `observation.inheritedEventCount ?? 0` 的兜底分支真的被走到（在本处代它兜底就等于把
  // 那条分支从覆盖率与语义上一起抹掉）。
  const cut = session?.inheritedEventCount;
  return { events: raw, inheritedEventCount: cut };
}

interface MockCtx {
  value: Record<string, unknown>;
  handlers: Record<string, (payload: unknown) => void>;
  followupCalls: { id: string; content: { text: string }[] }[];
  specs: Spec[];
  /** shell.execute().result() 的返回（shellRunError 在则改抛）。 */
  result: RunResult;
  shellRunError: Error | undefined;
  /** settings.describe() 抛出的异常（0.1.7 里插件侧唯一会失败的宿主读）；缺省 = 不抛。 */
  describeError: Error | undefined;
  /** ctx.sandboxPolicy：undefined = 组合里是非沙箱 executor。 */
  sandboxPolicy: ((request: unknown) => unknown) | undefined;
  policyRequests: unknown[];
  /** ctx.credentials：记忆反馈的 key 解析处（undefined = 组合里没装凭据服务）。 */
  credentials: { resolve: (ref: string) => Promise<{ value: string } | undefined> } | undefined;
  reports: Report[];
  /** effect 工厂交回的 disposer（与注册同序）。返回类型收 unknown：W4 起卸载封口
   *  disposer 交回 **Promise**（cordis 卸载会 await 它，fiber.d.ts:36-38）。 */
  effects: (() => unknown)[];
  /** 本插件 fiber 的替身（configure 的 owner 断言用）。 */
  fiber: unknown;
  /** 0.1.7 的 settings 面：register/get 已被宿主移除，只剩页面策略 + 跨命名空间读。 */
  settings: {
    configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void;
    describe: () => { ns: string; value: unknown }[];
  };
  /** ctx.inject(deps, fn)：cordis 立即用带齐依赖的子上下文回调一次。 */
  inject: (deps: readonly string[], attach: (child: unknown) => void) => void;
  get: (name: string) => unknown;
  /**
   * 官方事件读面替身（ctx.sessionQuery.observeSession）。交回 fired session 那份日志切片，
   * 游标由生产侧自己切；模拟"未装配"就 delete ctx.sessionQuery，模拟"拒绝/非数组交付"
   * 就整个换掉本字段。
   */
  sessionQuery?: {
    observeSession: (id: string) => Promise<{
      events: unknown;
      inheritedEventCount: number | undefined;
    }>;
  };
  on: (event: string, handler: (payload: unknown) => void) => void;
  effect: (fn: () => (() => void) | undefined) => void;
  shell: {
    resolve: (spec: Spec) => Spec;
    /** 0.1.7 唯一执行入口：结果走前台投影 handle.result()。 */
    execute: (spec: Spec) => Promise<{ result: () => Promise<RunResult> }>;
  };
}

function makeCtx(): MockCtx {
  const ctx: MockCtx = {
    value: {
      enabled: true,
      maxInjectsPerTurn: 2,
      gateBudgetMs: 60_000,
      memoryFeedback: true,
      // 记忆反馈配置齐备：这样"不得污染记忆环"的断言是真的在拦推送，而不是被
      // "地址未配置"的前置降级顺手挡掉（那种绿是假的）。
      memoryGatewayUrl: "http://gateway.test:8420",
      memoryGatewayKeyRef: "TDAI_GATEWAY_KEY",
      // W4 非 volatile 部署值：resolve 交普通值（refsOf 按 meta.volatile 区分形状）
      maxRootDepth: 10,
      gateStdoutMaxBytes: 65_536,
    },
    handlers: {},
    followupCalls: [],
    specs: [],
    result: {
      exitCode: 1,
      stdout: { text: "error TS2345: first is the root cause", truncated: false },
      stderr: { text: "", truncated: false },
    },
    shellRunError: undefined,
    describeError: undefined,
    sandboxPolicy: undefined,
    policyRequests: [],
    credentials: {
      async resolve() {
        return { value: "tok-from-credentials" };
      },
    },
    reports: [],
    effects: [],
    fiber: { id: "quality-gate-fiber" },
    settings: {
      configure: () => () => {
        void 0;
      },
      // 跨命名空间读（语言）：本文件的用例都不关心语言 → 空表 = 没有任何条目被投影。
      describe: () => {
        if (ctx.describeError !== undefined) {
          throw ctx.describeError;
        }
        return [];
      },
    },
    inject: (_deps, attach) => {
      attach(ctx);
    },
    sessionQuery: {
      observeSession: async () => observationOfFiredSession(),
    },
    get(name) {
      // 单一 return（consistent-return）：默认取属性即覆盖 shell / 未注册服务的 undefined。
      let service: unknown = (ctx as unknown as Record<string, unknown>)[name];
      if (name === "sandboxPolicy" && ctx.sandboxPolicy !== undefined) {
        const resolve = ctx.sandboxPolicy;
        service = {
          resolve: (request: unknown): unknown => {
            ctx.policyRequests.push(request);
            return resolve(request);
          },
        };
      } else if (name === "lessonLoop") {
        service = {
          report: (input: Report): void => {
            ctx.reports.push(input);
          },
        };
      }
      return service;
    },
    on(event, handler) {
      // 记本次 fire 的 agent.session，好让观察面替身交回夹具自己挂的那份日志
      // （**只有测试侧**读它；生产侧已不读 snapshotEvents）。
      ctx.handlers[event] = (payload: unknown) => {
        // 载荷必是宿主交出的事件对象（类型面已投影为非空），故首段不加 `?.`；
        // `agent` 是可缺字段，那一段守卫保留。
        firedSession = (payload as { agent?: { session?: unknown } }).agent?.session;
        handler(payload);
      };
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") {
        ctx.effects.push(cleanup);
      }
    },
    shell: {
      resolve(spec) {
        ctx.specs.push(spec);
        return spec;
      },
      async execute() {
        if (ctx.shellRunError !== undefined) {
          throw ctx.shellRunError;
        }
        return { result: async () => ctx.result };
      },
    },
  };
  return ctx;
}

const scratch: string[] = [];

/** 真 TS 项目根（package.json + tsconfig.json + a.ts）。 */
function makeProject(name: string): string {
  const root = path.join(
    tmpdir(),
    `qg-int-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, PKG_JSON), '{"name":"t","scripts":{"check":"tsc"}}');
  writeFileSync(path.join(root, TSCONFIG), '{"compilerOptions":{},"include":["a.ts"]}');
  writeFileSync(path.join(root, "a.ts"), "export const x = 1\n");
  scratch.push(root);
  return root;
}

/** 只有 ruff.toml 的 Python 根（审计 LOW-MED 项：它此前拿不到根）。 */
function makeRuffProject(name: string): string {
  const root = path.join(
    tmpdir(),
    `qg-ruff-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "ruff.toml"), "line-length = 100\n");
  writeFileSync(path.join(root, "a.py"), "x = 1\n");
  scratch.push(root);
  return root;
}

const editEvent = (file: string): unknown => ({
  type: "tool/call",
  data: { name: "edit", arguments: JSON.stringify({ file_path: file }) },
});

const fileIn = (root: string, name = "a.ts"): string => path.join(root, name);

/** 往某会话的事件日志追加一条编辑事件（日志数组由用例给，故不捕外层状态）。 */
const pushEdit = (log: unknown[], file: string): void => {
  log.push(editEvent(file));
};

/** 当前生效的 ctx（makeAgent 造的 followup 要知道该往哪个 ctx 记）。 */
let active: MockCtx | undefined;

function applyWith(ctx: MockCtx): void {
  active = ctx;
  applyGate(ctx, ctx.value);
}

/** 根会话 agent mock：header 由宿主保证存在（本包按必读取用）。 */
function makeAgent(
  sessionId: string,
  log: unknown[],
  header: Record<string, unknown> = {},
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
    session: {
      id: sessionId,
      header,
      snapshotEvents: (from?: number) => log.slice(from ?? 0),
    },
    status: "running",
    inbox: { nextTurn: [], nextStep: [] },
    followup(message: unknown) {
      (active as unknown as MockCtx).followupCalls.push(
        message as { id: string; content: { text: string }[] },
      );
    },
  };
}

function stop(ctx: MockCtx, agent: unknown, turn = 1, signal?: AbortSignal): void {
  const payload: Record<string, unknown> = { agent, turn };
  if (signal !== undefined) {
    payload["signal"] = signal;
  }
  ctx.handlers["agent/turn-stopping"]!(payload);
}

/** 一次收口：会话 + 若干编辑事件（拆开设参，避免四层嵌套调用）。 */
function stopEdits(
  ctx: MockCtx,
  sessionId: string,
  files: string[],
  header: Record<string, unknown> = {},
  turn = 1,
): ReturnType<typeof makeAgent> {
  const log = files.map((file) => editEvent(file));
  const agent = makeAgent(sessionId, log, header);
  stop(ctx, agent, turn);
  return agent;
}

function injectedText(ctx: MockCtx, index = 0): string {
  const chunks = ctx.followupCalls[index]?.content ?? [];
  return chunks.map((chunk) => chunk.text).join("");
}

/** 收集 console.warn/info/error（断言可观测性，且不刷屏真实输出）。 */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.join(" "));
  };
  const originals = { warn: console.warn, info: console.info, error: console.error };
  console.warn = record;
  console.info = record;
  console.error = record;
  return {
    lines,
    restore: () => {
      console.warn = originals.warn;
      console.info = originals.info;
      console.error = originals.error;
    },
  };
}

/** 服务面守卫用例：记录 ctx 成员被调用的顺序（守卫为假时必须为空）。 */
const guardCalls: string[] = [];

/** settledWithin 的定时器哨兵：race 先落地的是它 ⇒ target 仍在飞。模块级唯一 symbol，
 *  任何被测 promise 的 fulfilled 值都不可能与它全等。 */
const STILL_PENDING = Symbol("settledWithin: 时限内未收敛");

/** 在 15ms 时限内 promise 是否已收敛（false = 仍在飞）：quiescence 断言的探针。 */
async function settledWithin(target: Promise<unknown>): Promise<boolean> {
  // 直接 race target 本体，而不是 `target.then(() => true)` 的中转：
  //  - target 先 fulfilled → await 拿到它的值（非哨兵）→ true；定时器先落地 → false；
  //  - target **拒绝**时 await 就地抛出**同一个 rejection**，与 Promise.race 的旧行为逐位一致
  //    （用例正是靠这条通路看到卸载/批次里冒出来的拒绝原因，不能被 catch 吞成 false）。
  const winner = await Promise.race([target, sleep(15, STILL_PENDING)]);
  return winner !== STILL_PENDING;
}

/**
 * 齐备服务面的最小 ctx 模板（模块级：不捕获外层变量，且每例现造避免互相污染）。
 * 形状 = 0.1.7 实际调用面：inject → (子上下文)effect → settings.configure，然后
 * on 注册回合监听，最后 effect 挂卸载封口。
 */
function armedCtx(): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    fiber: { id: "quality-gate-fiber" },
    settings: {
      configure: () => {
        guardCalls.push("configure");
        return () => {
          void 0;
        };
      },
      describe: () => {
        guardCalls.push("describe");
        return [];
      },
    },
    inject: (_deps: readonly string[], attach: (child: unknown) => void) => {
      guardCalls.push("inject");
      attach(ctx);
    },
    get: () => {
      guardCalls.push("get");
    },
    on: () => {
      guardCalls.push("on");
    },
    effect: (fn: () => (() => void) | undefined) => {
      guardCalls.push("effect");
      fn();
    },
  };
  return ctx;
}

describe("quality-gate 门禁完整性", () => {
  // 全文件共用的收尾（临时项目根清理 + 网关推送计数清零）：本文件所有用例都在这个
  // describe 里，故 hook 放在它的第一行——生命周期与放在模块顶层逐位一致
  // （afterEach 对每条用例生效），但满足了「hook 必须在 describe 内」的结构判据。
  afterEach(() => {
    while (scratch.length > 0) {
      rmSync(scratch.pop()!, { recursive: true, force: true });
    }
    vi.mocked(pushGateFeedback).mockClear();
  });

  // ── 审计 1：编辑记账按会话分账 ──────────────────────────────
  describe("每会话独立累加器", () => {
    it("两会话各自收口：只检自己的根，配额互不占用", async () => {
      const ctx = makeCtx();
      const rootA = makeProject("a");
      const rootB = makeProject("b");
      applyWith(ctx);
      stopEdits(ctx, "s-a", [fileIn(rootA)]);
      await sleep(20);
      stopEdits(ctx, "s-b", [fileIn(rootB)]);
      await sleep(20);

      assert.equal(ctx.specs.length, 2, "两会话各跑一次门禁");
      assert.equal(ctx.specs.at(0)?.workdir, rootA, "A 只检 A 的根");
      assert.equal(ctx.specs.at(1)?.workdir, rootB, "B 只检 B 的根");
      assert.equal(ctx.followupCalls.length, 2, "两会话各注入一次（配额独立）");
      assert.match(injectedText(ctx, 0), new RegExp(path.basename(rootA), "u"));
      assert.match(injectedText(ctx, 1), new RegExp(path.basename(rootB), "u"));
      assert.match(injectedText(ctx, 1), /请修复上述问题/u, "两次的结论都来自真跑完的门禁");
    });

    it("会话 A 的异步门禁在飞时会话 B 收口：B 不拿走 A 的账，A 也不二次吃掉 B 的账", async () => {
      const ctx = makeCtx();
      const rootA = makeProject("fly-a");
      const rootB = makeProject("fly-b");
      ctx.shell.execute = async () => ({
        result: async () => {
          await sleep(40);
          return ctx.result;
        },
      });
      applyWith(ctx);
      stopEdits(ctx, "s-a", [fileIn(rootA)]);
      await sleep(5);
      // A 的门禁还在 await 中，此时 B 收口
      stopEdits(ctx, "s-b", [fileIn(rootB)]);
      await sleep(60);

      assert.deepEqual(
        ctx.specs.map((spec) => spec.workdir),
        [rootA, rootB],
        "每会话的门禁只覆盖自己的根，顺序与注入互不串台",
      );
      assert.equal(ctx.followupCalls.length, 2);
    });

    it("同一文件被两会话编辑：各会话都过一遍门禁（账不共享即不吞）", async () => {
      const ctx = makeCtx();
      const shared = makeProject("shared");
      const file = fileIn(shared);
      applyWith(ctx);
      stopEdits(ctx, "s-1", [file]);
      await sleep(20);
      stopEdits(ctx, "s-2", [file]);
      await sleep(20);
      assert.equal(ctx.specs.length, 2, "两会话各自为同一根跑一次门禁");
    });

    it("会话 A 的 drain 中途失败也不把它的账混进会话 B 的门禁（共用实例即串台）", async () => {
      // 钉住的性质：**一个会话的未复查编辑永不进入另一个会话的门禁**。
      // 累加器若为全局单例，note/drain 之间任何一次异常（本测试注入）都会把 A 的
      // 待复查文件留在同一实例里，被 B 的 drain 整批拿走 → 为 A 的根跑门禁、
      // 修复指令与配额记到 B 名下，而 A 的游标已前进 → A 永不复查（静默丢门禁）。
      const ctx = makeCtx();
      const rootA = makeProject("leak-a");
      const rootB = makeProject("leak-b");
      const spy = vi.spyOn(EditAccumulator.prototype, "drain").mockImplementationOnce(() => {
        throw new Error("injected: drain failed mid-turn");
      });
      const log = capture();
      try {
        applyWith(ctx);
        stopEdits(ctx, "s-leak-a", [fileIn(rootA)]);
        await sleep(20);
        assert.equal(ctx.specs.length, 0, "A 的 drain 抛错 → A 本轮不跑门禁（外层兜底）");
        stopEdits(ctx, "s-leak-b", [fileIn(rootB)]);
        await sleep(20);
      } finally {
        log.restore();
        spy.mockRestore();
      }
      assert.equal(ctx.specs.length, 1, "B 只跑自己那一个门禁");
      assert.equal(ctx.specs.at(0)?.workdir, rootB, "B 绝不为 A 的根跑门禁");
      assert.equal(ctx.followupCalls.length, 1);
      const text = injectedText(ctx);
      assert.match(text, new RegExp(path.basename(rootB), "u"));
      assert.ok(!text.includes(path.basename(rootA)), "注入文案不得夹带另一个会话的根（会话串台）");
    });

    it("两会话的配额彼此独立：B 的失败不消耗 A 的注入次数", async () => {
      const ctx = makeCtx();
      const rootA = makeProject("quota-a");
      const rootB = makeProject("quota-b");
      applyWith(ctx);
      // 真实会话语义：每会话一条持续追加的事件日志（游标按 seq 增量读）
      const logA: unknown[] = [];
      const logB: unknown[] = [];
      const agentA = makeAgent("s-a", logA);
      const agentB = makeAgent("s-b", logB);
      // A 用满配额（maxInjectsPerTurn=2）
      pushEdit(logA, fileIn(rootA));
      stop(ctx, agentA, 1);
      await sleep(20);
      pushEdit(logA, fileIn(rootA, "b.ts"));
      stop(ctx, agentA, 2);
      await sleep(20);
      const afterA = ctx.followupCalls.length;
      // B 第一次失败仍应拿到修复指令（不共享配额）
      pushEdit(logB, fileIn(rootB));
      stop(ctx, agentB, 1);
      await sleep(20);
      assert.equal(afterA, 2, "A 注入两次后到顶");
      assert.equal(ctx.followupCalls.length, 3, "B 的配额独立");
      assert.match(injectedText(ctx, 2), new RegExp(path.basename(rootB), "u"));
    });
  });

  // ── 审计 2：sandboxPolicy 按会话解析并传入执行 ──────────────
  describe("sandboxPolicy 线程", () => {
    it("shell.resolve 收到按会话解析出的策略（不是部署级回落）", async () => {
      const ctx = makeCtx();
      const root = makeProject("pol");
      ctx.sandboxPolicy = () => ({ mode: SANDBOX_MODE_WORKSPACE_WRITE, workspaceRoot: root });
      applyWith(ctx);
      const agent = stopEdits(ctx, "s-pol", [fileIn(root)]);
      await sleep(20);

      assert.equal(ctx.policyRequests.length, 1, "策略按会话解析一次");
      const [request] = ctx.policyRequests;
      assert.equal(
        (request as { session?: unknown }).session,
        agent.session,
        "resolve({ session }) 必须带真实会话对象（否则忽略会话 sandbox/mode 覆盖）",
      );
      assert.equal(ctx.specs.at(0)?.sandboxPolicy?.mode, SANDBOX_MODE_WORKSPACE_WRITE);
      assert.equal(ctx.specs.at(0)?.sandboxPolicy?.workspaceRoot, root);
      assert.equal(ctx.followupCalls.length, 1, "策略齐备时代禁照常按结果判定");
      assert.match(injectedText(ctx), /请修复上述问题/u, "策略齐备 → 结论是代码失败");
    });

    it("策略服务缺失（非沙箱 executor）→ 不传 sandboxPolicy，门禁仍执行", async () => {
      const ctx = makeCtx();
      const root = makeProject("pol-none");
      applyWith(ctx);
      stopEdits(ctx, "s-none", [fileIn(root)]);
      await sleep(20);
      assert.equal(ctx.specs.length, 1);
      assert.equal(ctx.specs.at(0)?.sandboxPolicy, undefined);
    });

    it("策略 resolve 抛错 → 一门不跑，注入「未执行」（绝不回落到部署级策略）", async () => {
      const ctx = makeCtx();
      const root = makeProject("pol-bad");
      ctx.sandboxPolicy = () => {
        throw new Error("projection store unavailable");
      };
      const log = capture();
      applyWith(ctx);
      try {
        stopEdits(ctx, "s-bad", [fileIn(root)]);
        await sleep(30);
      } finally {
        log.restore();
      }
      assert.equal(ctx.specs.length, 0, "策略未知时不得执行任何门禁命令");
      assert.equal(ctx.followupCalls.length, 1, "必须注入未执行说明，不能静默通过");
      const text = injectedText(ctx);
      assert.match(text, /未能执行/u);
      assert.match(text, /沙箱策略无法解析/u);
      assert.ok(!text.includes("请修复上述问题"), "不得产出假的「修这些错」指令");
      assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0, "不得污染记忆环");
      assert.equal(ctx.reports.at(0)?.category, BUS_CATEGORY_NOT_RUN, "总线按 not-run 上报");
    });
  });

  // ── 审计 3：ShellRunResult.sandbox 三字段 + SandboxUnavailableError ──
  describe("沙箱事实读取", () => {
    it("sandbox.denied → 未执行说明（策略拒绝 ≠ 代码失败），不写记忆", async () => {
      const ctx = makeCtx();
      const root = makeProject("deny");
      ctx.result = {
        exitCode: 1,
        stdout: { text: "bwrap: creating pivot_root failed", truncated: false },
        stderr: { text: "Operation not permitted", truncated: false },
        sandbox: { mode: "read-only", denied: true, enforcement: "full" },
      };
      applyWith(ctx);
      stopEdits(ctx, "s-deny", [fileIn(root)]);
      await sleep(20);
      assert.equal(ctx.followupCalls.length, 1, "策略拒绝必须让用户知情，不能算通过");
      const text = injectedText(ctx);
      assert.match(text, /沙箱策略拒绝/u);
      assert.match(text, /read-only/u, "文案要带实际沙箱模式");
      assert.ok(!text.includes("请修复上述问题"), "策略拒绝不得复用代码失败模板");
      assert.equal(vi.mocked(pushGateFeedback).mock.calls.length, 0);
      assert.equal(ctx.reports.at(0)?.category, BUS_CATEGORY_NOT_RUN);
    });

    it("sandbox.runnerFailed → 未执行说明（runner 挂了根本没跑）", async () => {
      const ctx = makeCtx();
      const root = makeProject("runner");
      ctx.result = {
        exitCode: 1,
        stdout: { text: "", truncated: false },
        stderr: { text: "acl-runner: token creation failed", truncated: false },
        sandbox: { mode: SANDBOX_MODE_WORKSPACE_WRITE, denied: false, runnerFailed: true },
      };
      applyWith(ctx);
      stopEdits(ctx, "s-run", [fileIn(root)]);
      await sleep(20);
      assert.match(injectedText(ctx), /runner 启动失败/u);
    });

    it("exit 0 + enforcement=partial → 仍算通过，但打 warn（边界不完整要可观测）", async () => {
      const ctx = makeCtx();
      const root = makeProject("partial");
      ctx.result = {
        exitCode: 0,
        stdout: { text: "", truncated: false },
        stderr: { text: "", truncated: false },
        sandbox: { mode: SANDBOX_MODE_WORKSPACE_WRITE, denied: false, enforcement: "partial" },
      };
      const log = capture();
      applyWith(ctx);
      try {
        stopEdits(ctx, "s-part", [fileIn(root)]);
        await sleep(20);
      } finally {
        log.restore();
      }
      assert.equal(ctx.followupCalls.length, 0, "部分生效不是失败，判通过");
      assert.ok(
        log.lines.some((line) => line.includes("PARTIAL")),
        "partial enforcement 必须 warn",
      );
    });

    it("run 抛 SandboxUnavailableError → 未执行说明，不再是 PASS", async () => {
      const ctx = makeCtx();
      const root = makeProject("unavail");
      const error = new Error('sandbox mode "read-only" is requested but no backend is usable');
      (error as unknown as { code: string }).code = "SANDBOX_UNAVAILABLE";
      ctx.shellRunError = error;
      const log = capture();
      applyWith(ctx);
      try {
        stopEdits(ctx, "s-un", [fileIn(root)]);
        await sleep(20);
      } finally {
        log.restore();
      }
      assert.equal(ctx.followupCalls.length, 1, "沙箱不可用不得算通过（旧实现报 PASS）");
      assert.match(injectedText(ctx), /沙箱在本机不可用/u);
      assert.ok(
        log.lines.some((line) => line.includes("gate did not run")),
        "抛错要落 error 日志",
      );
    });

    it("run 抛普通错（准备期失败：workdir 不存在/spawn 失败）→ 未执行说明", async () => {
      const ctx = makeCtx();
      const root = makeProject("spawn");
      ctx.shellRunError = new Error("spawn pnpm ENOENT");
      const log = capture();
      applyWith(ctx);
      try {
        stopEdits(ctx, "s-spawn", [fileIn(root)]);
        await sleep(20);
      } finally {
        log.restore();
      }
      assert.equal(ctx.followupCalls.length, 1, "准备期失败不得静默通过");
      assert.match(injectedText(ctx), /门禁未能启动（spawn pnpm ENOENT）/u);
      assert.equal(ctx.reports.at(0)?.category, BUS_CATEGORY_NOT_RUN);
    });

    it("run 抛非 Error（字符串 / 对象）→ 摘要仍可读且判未执行", async () => {
      const ctx = makeCtx();
      const root = makeProject("throwstring");
      // 故意抛非 Error（类型上伪装）：宿主侧兜底必须给出可读摘要而不是 [object Object]
      ctx.shellRunError = "boom-not-an-error" as unknown as Error;
      const log = capture();
      applyWith(ctx);
      try {
        stopEdits(ctx, "s-str", [fileIn(root)]);
        await sleep(20);
      } finally {
        log.restore();
      }
      assert.match(injectedText(ctx), /boom-not-an-error/u);

      const odd = makeCtx();
      odd.shellRunError = { weird: true } as unknown as Error;
      applyWith(odd);
      stopEdits(odd, "s-obj", [fileIn(root)]);
      await sleep(20);
      assert.match(injectedText(odd), /门禁未能启动（unknown error）/u, "非 Error 抛出也有摘要");
    });
  });

  // ── 审计 4：CollectedOutput 截断（内存里保留的是尾部）───────
  describe("截断证据", () => {
    it("truncated + 可读 spillPath → 标注截断并补回头部摘录", async () => {
      const ctx = makeCtx();
      const root = makeProject("spill");
      const spill = path.join(root, "stdout-spill.log");
      writeFileSync(spill, "error TS1005: THE ROOT CAUSE IS THE FIRST LINE\nrest of output\n");
      ctx.result = {
        exitCode: 1,
        stdout: { text: "error TS9999: tail noise", truncated: true, spillPath: spill },
        stderr: { text: "", truncated: false },
      };
      applyWith(ctx);
      stopEdits(ctx, "s-spill", [fileIn(root)]);
      await sleep(20);
      const text = injectedText(ctx);
      assert.match(text, /证据截断/u, "必须标注证据被截断");
      assert.match(text, /THE ROOT CAUSE IS THE FIRST LINE/u, "头部根因要从 spill 里读回来");
      assert.match(text, /tail noise/u, "尾部原文保留");
    });

    it("truncated 无 spillPath → 标注「无落盘文件」，只送尾部", async () => {
      const ctx = makeCtx();
      const root = makeProject("spill2");
      ctx.result = {
        exitCode: 1,
        stdout: { text: "tail only", truncated: true },
        stderr: { text: "", truncated: false },
      };
      applyWith(ctx);
      stopEdits(ctx, "s-spill2", [fileIn(root)]);
      await sleep(20);
      const text = injectedText(ctx);
      assert.match(text, /无落盘文件/u);
      assert.match(text, /tail only/u);
      assert.ok(!text.includes("头部摘录"), "读不到头部时不伪造摘录");
    });

    it("spillPath 不可读 → 只标注截断", async () => {
      const ctx = makeCtx();
      const root = makeProject("spill3");
      ctx.result = {
        exitCode: 1,
        stdout: {
          text: "tail",
          truncated: true,
          spillPath: fileIn(root, "gone.log"),
        },
        stderr: { text: "", truncated: false },
      };
      applyWith(ctx);
      stopEdits(ctx, "s-spill3", [fileIn(root)]);
      await sleep(20);
      assert.match(injectedText(ctx), /证据截断/u);
      assert.ok(!injectedText(ctx).includes("头部摘录"), "读不到就不伪造头部");
    });

    it("spillPath 非绝对路径 → 不去读（防越界读任意文件）", async () => {
      const ctx = makeCtx();
      const root = makeProject("spill4");
      ctx.result = {
        exitCode: 1,
        stdout: { text: "tail", truncated: true, spillPath: "relative/spill.log" },
        stderr: { text: "", truncated: false },
      };
      applyWith(ctx);
      stopEdits(ctx, "s-spill4", [fileIn(root)]);
      await sleep(20);
      assert.match(injectedText(ctx), /证据截断/u);
      assert.ok(!injectedText(ctx).includes("头部摘录"));
    });
  });

  // ── 装载边界：ctx 服务面守卫（无断言、无豁免注释的 fail-closed）──
  describe("ctx 服务面守卫", () => {
    /** 逐成员缺一例：守卫的每个 && 分支都要真的走到（fail-closed 不能只测第一道）。
     *  顺序与 isGateHost 的短路序一致（get→on→effect→inject→fiber→describe→configure）。 */
    const broken: { label: string; ctx: unknown }[] = [
      { label: "非对象 ctx", ctx: undefined },
      { label: "缺 get", ctx: { ...armedCtx(), get: undefined } },
      { label: "缺 on", ctx: { ...armedCtx(), on: "not-a-function" } },
      { label: "缺 effect", ctx: { ...armedCtx(), effect: undefined } },
      { label: "缺 inject", ctx: { ...armedCtx(), inject: undefined } },
      { label: "缺 fiber", ctx: { ...armedCtx(), fiber: undefined } },
      { label: "settings.describe 非函数", ctx: { ...armedCtx(), settings: {} } },
      {
        label: "settings.configure 非函数",
        ctx: { ...armedCtx(), settings: { describe: () => [] } },
      },
    ];

    // 表驱动：每一行的 label 进标题（`$label`），所以八档缺件的用例各自有名可寻。
    it.each(broken)("$label → 不调用任何 ctx 成员、只记一条 error", (item) => {
      guardCalls.length = 0;
      const log = capture();
      try {
        applyGate(item.ctx, {});
      } finally {
        log.restore();
      }
      assert.ok(
        log.lines.some((line) => line.includes("gate not armed")),
        "必须显式说明未装载",
      );
      assert.deepEqual(guardCalls, [], "服务面不齐时不得调用 ctx 的任何成员");
      assert.ok(
        !log.lines.some((line) => line.includes("Cannot read")),
        "不得靠抛错来失败（异常会被宿主折叠成 turn kind:error）",
      );
    });

    it("服务面齐备 → 正常注册监听（守卫不误拦好 ctx）", () => {
      guardCalls.length = 0;
      const ctx = armedCtx();
      applyGate(ctx, schemaDefaults());
      assert.deepEqual(
        guardCalls,
        ["inject", "effect", "configure", "on", "effect"],
        "装载只走 inject→(子上下文)effect→configure、on 注册监听、effect 挂卸载封口；" +
          "不注入也不跑门禁（describe 只在回合里读语言时才走）",
      );
    });

    it("0.1.7 的宿主没有 settings.register → 缺它照样装载（守卫不得退回旧判据）", () => {
      // 这条钉住 2026-09-22 的 P0：register 被宿主移除后，拿它当硬前置会让每条真宿主
      // 都判成"服务面不齐"，`gate not armed` 成为唯一失败模式且没有任何设置面。
      guardCalls.length = 0;
      const ctx = armedCtx();
      applyGate(ctx, schemaDefaults());
      assert.ok(
        !guardCalls.includes("register"),
        "装载路径不得再调 settings.register（它已不存在）",
      );
      assert.ok(guardCalls.includes("configure"), "改走 configure 登记页面策略");
    });

    it("服务面齐备的门禁照常工作（回归锚点：守卫不得拦掉真 ctx）", async () => {
      const ctx = makeCtx();
      const root = makeProject("guard-ok");
      applyWith(ctx);
      stopEdits(ctx, "s-guard", [fileIn(root)]);
      await sleep(20);
      assert.equal(ctx.specs.length, 1, "齐备 ctx 未被守卫误拦");
    });
  });

  // ── 审计 6/8：载荷与卸载边界 ───────────────────────────────
  describe("载荷与卸载边界", () => {
    it("agent 缺失 → 直接返回（不记账、不跑门禁、不抛错）", async () => {
      const ctx = makeCtx();
      applyWith(ctx);
      ctx.handlers["agent/turn-stopping"]!({ turn: 1 });
      await sleep(20);
      assert.equal(ctx.specs.length, 0);
      assert.equal(ctx.followupCalls.length, 0);
    });

    it("handler 内部抛错 → 外层兜底记日志，不炸回合", async () => {
      const ctx = makeCtx();
      applyWith(ctx);
      const log = capture();
      try {
        // session 缺失（异常载荷）→ 读取 header 抛 TypeError → 被兜底接住
        ctx.handlers["agent/turn-stopping"]!({ agent: { status: "running" }, turn: 1 });
        await sleep(20);
      } finally {
        log.restore();
      }
      assert.ok(
        log.lines.some((line) => line.includes("turn-stopping handler failed")),
        "兜底日志必须出现",
      );
      assert.equal(ctx.specs.length, 0);
    });

    it("sessionQuery 未装配（官方观察面缺席）→ 无窗可判，门禁不跑也不误报", async () => {
      const ctx = makeCtx();
      const root = makeProject("noreader");
      // 迁移前这一档是「session 上没有 snapshotEvents」；记账改走官方 ctx.sessionQuery 之后，
      // 同一档降级的新形态就是该服务未装配（精简 profile / 尚未 provide）。
      Reflect.deleteProperty(ctx, "sessionQuery");
      applyWith(ctx);
      stop(ctx, {
        session: { id: "s-nr", header: { cwd: root } },
        status: "running",
        inbox: { nextTurn: [], nextStep: [] },
        followup: () => {
          assert.fail("无事件窗时不得注入");
        },
      });
      await sleep(20);
      assert.equal(ctx.specs.length, 0);
      assert.equal(ctx.followupCalls.length, 0);
    });

    it("observeSession 拒绝（会话已卸载/存储读不出）→ 游标不推进、不误报", async () => {
      const ctx = makeCtx();
      const root = makeProject("rejects");
      applyWith(ctx);
      const log: unknown[] = [editEvent(fileIn(root))];
      const agent = makeAgent("s-rej", log, { cwd: root });
      const working = ctx.sessionQuery;
      ctx.sessionQuery = {
        observeSession: async (): Promise<never> => {
          throw new Error("session log unreadable");
        },
      };
      stop(ctx, agent, 1);
      await sleep(20);
      assert.equal(ctx.specs.length, 0, "观察面抛错：既不跑门禁也不误报通过");
      assert.equal(ctx.followupCalls.length, 0);
      // 游标必须没被这次失败污染：读法恢复后，同一批编辑照样查到（不静默丢门禁）。
      // exactOptionalPropertyTypes：替身字段是可选的，恢复只在拿得到时写回。
      if (working !== undefined) {
        ctx.sessionQuery = working;
      }
      stop(ctx, agent, 2);
      await sleep(20);
      assert.equal(ctx.specs.length, 1, "游标未被污染 → 下一趟照样查到");
      assert.equal(ctx.followupCalls.length, 1);
    });

    it("snapshotEvents 返回非数组 → 游标不推进、不误报通过", async () => {
      const ctx = makeCtx();
      const root = makeProject("badarr");
      applyWith(ctx);
      const log: unknown[] = [editEvent(fileIn(root))];
      const agent = makeAgent("s-badarr", log, { cwd: root });
      const session = agent.session as unknown as { snapshotEvents: (from?: number) => unknown };
      session.snapshotEvents = () => ({ not: "an array" });
      stop(ctx, agent, 1);
      await sleep(20);
      assert.equal(ctx.specs.length, 0, "非数组事件窗：读不出编辑，不误跑也不误报");
      assert.equal(ctx.followupCalls.length, 0);
      // 游标必须没被非数组结果污染：恢复正常读法后，同一批编辑照样被查到
      session.snapshotEvents = (from?: number) => log.slice(from ?? 0);
      stop(ctx, agent, 2);
      await sleep(20);
      assert.equal(ctx.specs.length, 1, "游标未被污染 → 不静默丢门禁");
      assert.equal(ctx.followupCalls.length, 1, "结论是代码失败（exit 1），不是通过");
      assert.match(injectedText(ctx), /请修复上述问题/u);
    });

    it("插件卸载收口：abort 在飞门禁 + await 收敛 + 迟到结果就地丢弃（不注入不落总线）", async () => {
      const ctx = makeCtx();
      const root = makeProject("dispose");
      // 受控门禁：结果释放前一直在飞（deferred，Promise.withResolvers 免 new Promise）
      const gate = Promise.withResolvers<unknown>();
      ctx.shell.execute = async () => ({
        // 结果释放前一直在飞；await 版与旧的 `gate.promise.then(...)` 逐位同形：
        // 只有在 result() 被调用时才开始等 gate，gate 若拒绝仍从 result() 抛出。
        result: async () => {
          await gate.promise;
          return ctx.result;
        },
      });
      applyWith(ctx);
      stopEdits(ctx, "s-disp", [fileIn(root)]);
      await sleep(5);
      assert.equal(ctx.specs.length, 1, "门禁已起飞");
      // 卸载：disposer 交回 Promise——cordis 卸载会 await 它（installed fiber.d.ts:36-38
      // "they may be async, in which case unloading awaits them"）。
      const disposer = ctx.effects.at(-1)!;
      const unload = disposer() as Promise<void>;
      assert.equal(
        await settledWithin(unload),
        false,
        "在飞门禁收敛前，卸载不得完成（defensive-patterns.md:19-23 quiescence）",
      );
      assert.equal(
        ctx.specs.at(0)?.signal?.aborted,
        true,
        "disposer 必须 abort 在飞门禁的执行信号（旧实现只置 disposed 旗，进程活过卸载）",
      );
      // 被中止的执行迟到返回（mock 不真杀进程，等价 abort 后的结果到位）
      gate.resolve(undefined);
      await unload;
      assert.equal(await settledWithin(unload), true, "门禁收敛后卸载完成");
      assert.equal(ctx.followupCalls.length, 0, "卸载后不得再向会话注入");
      assert.equal(
        ctx.reports.length,
        0,
        "被中止的门禁结果就地丢弃：既不是代码失败事实，也不是'请手动跑'素材，不落 lesson-loop",
      );
    });

    it("卸载发生在读账窗口时批次起步前就地收口，一门都不开", async () => {
      const ctx = makeCtx();
      const root = makeProject("dispose-read");
      const read = Promise.withResolvers<{
        events: unknown[];
        inheritedEventCount: number | undefined;
      }>();
      ctx.sessionQuery = {
        observeSession: () => read.promise,
      };
      applyWith(ctx);
      stopEdits(ctx, "s-disp-read", [fileIn(root)]);
      await sleep(5);
      const disposer = ctx.effects.at(-1)!;
      const unload = disposer() as Promise<void>;
      await sleep(5);
      read.resolve({ events: [editEvent(fileIn(root))], inheritedEventCount: undefined });
      await unload;
      await sleep(20);
      assert.equal(ctx.specs.length, 0, "abort 后批次起步即收口：不开任何门禁");
      assert.equal(ctx.followupCalls.length, 0, "也不注入");
    });

    it("卸载之后新到的收口整体放弃（不读账、不开门禁、不注入）", async () => {
      const ctx = makeCtx();
      const root = makeProject("dispose-new");
      applyWith(ctx);
      for (const cleanup of ctx.effects) {
        cleanup();
      }
      stopEdits(ctx, "s-disp-new", [fileIn(root)]);
      await sleep(20);
      assert.equal(ctx.specs.length, 0, "卸载后的收口不再起步");
      assert.equal(ctx.followupCalls.length, 0, "更不会注入");
    });

    it("门禁批次自身故障时由顶层 catch 记 error，不产生 unhandledRejection", async () => {
      const ctx = makeCtx();
      const root = makeProject("batch-fail");
      const gate = Promise.withResolvers<unknown>();
      ctx.shell.execute = async () => ({
        // 结果释放前一直在飞；await 版与旧的 `gate.promise.then(...)` 逐位同形：
        // 只有在 result() 被调用时才开始等 gate，gate 若拒绝仍从 result() 抛出。
        result: async () => {
          await gate.promise;
          return ctx.result;
        },
      });
      applyWith(ctx);
      const agent = makeAgent("s-batch", [editEvent(fileIn(root))]);
      // 门禁在飞期间把 inbox 换成抛错 getter：结果处理时 preInjectCheck 读它炸——
      // 旧实现这一层没有 catch，rejection 直奔 unhandledRejection。
      const log = capture();
      try {
        stop(ctx, agent, 1);
        await sleep(5);
        Object.defineProperty(agent, "inbox", {
          get() {
            throw new Error("hostile inbox (mock)");
          },
        });
        // 门禁返回 → 处理结果 → 二次校验读 inbox → 抛错 → 批次兜底
        gate.resolve(undefined);
        await sleep(40);
      } finally {
        log.restore();
      }
      assert.ok(
        log.lines.some((line) => line.includes("gate batch failed")),
        "批次故障必须落一条 error（宿主面突变只记日志，不外溢）",
      );
      assert.equal(ctx.followupCalls.length, 0, "故障发生在注入前，不得注入");
    });

    it("turn signal 已取消 → 不注入（数据信号优先）", async () => {
      const ctx = makeCtx();
      const root = makeProject("cancelled");
      const ctrl = new AbortController();
      ctrl.abort();
      const log = capture();
      applyWith(ctx);
      try {
        const cancelAgent = makeAgent("s-cancel", [editEvent(fileIn(root))]);
        stop(ctx, cancelAgent, 1, ctrl.signal);
        await sleep(30);
      } finally {
        log.restore();
      }
      assert.equal(ctx.followupCalls.length, 0);
      assert.ok(log.lines.some((line) => line.includes("injection skipped (turn aborted)")));
    });
  });

  // ── 审计 7：ruff.toml 根 ───────────────────────────────────
  it("只有 ruff.toml 的 Python 工程也拿到根与 ruff 门禁", async () => {
    const ctx = makeCtx();
    const root = makeRuffProject("py");
    ctx.result = {
      exitCode: 1,
      stdout: { text: "F401 unused import", truncated: false },
      stderr: { text: "", truncated: false },
    };
    applyWith(ctx);
    stopEdits(ctx, "s-py", [fileIn(root, "a.py")]);
    await sleep(20);
    assert.equal(ctx.specs.at(0)?.command, "ruff check .");
    assert.equal(ctx.specs.at(0)?.workdir, root);
  });

  // ── 会话预算淘汰边界（pruneToSessionBudget）─────────────────
  describe("会话级 Map 预算", () => {
    it("超过 50 个会话后淘汰最旧：被淘汰会话重放历史、不漏门禁", async () => {
      const ctx = makeCtx();
      ctx.result = {
        exitCode: 0,
        stdout: { text: "", truncated: false },
        stderr: { text: "", truncated: false },
      };
      applyWith(ctx);
      const root = makeProject("budget");
      const first = [editEvent(fileIn(root))];
      stop(ctx, makeAgent("s-first", first), 1);
      await sleep(5);
      const others: unknown[] = [editEvent(fileIn(root))];
      for (let idx = 0; idx < SESSION_COUNT; idx += 1) {
        stop(ctx, makeAgent(`s-other-${idx}`, others), 1);
      }
      await sleep(300);
      const before = ctx.specs.length;
      // s-first 的游标已被淘汰 → 再收口时从 forkCut 重放，本会话历史编辑被重新检查
      stop(ctx, makeAgent("s-first", first), 2);
      await sleep(20);
      assert.ok(ctx.specs.length > before, "被淘汰会话重放自己的历史（不漏门禁）");
    });

    it("inbox 忙时的配额剪枝：该会话从未失败过 → 无条目可剪，直接返回", async () => {
      const ctx = makeCtx();
      const root = makeProject("prune-idle");
      applyWith(ctx);
      const agent = makeAgent("s-never-failed", [editEvent(fileIn(root))]);
      (agent as unknown as { inbox: { nextTurn: unknown[] } }).inbox = {
        nextTurn: [{ id: "queued" }],
      };
      stop(ctx, agent, 1);
      await sleep(20);
      assert.equal(ctx.specs.length, 0, "inbox 忙不跑门禁");
      assert.equal(ctx.followupCalls.length, 0);
    });
  });

  // ── 深仓无根可观测（hitDepthLimit）──────────────────────────
  it(">10 层无清单的文件：warn 说明该文件的门禁面被跳过", async () => {
    const ctx = makeCtx();
    applyWith(ctx);
    const deep = `qg-deep-${Date.now()}`;
    const nested = path.join(tmpdir(), deep, ...Array.from({ length: 9 }, (_v, idx) => `d${idx}`));
    const log = capture();
    try {
      stopEdits(ctx, "s-deep", [path.join(nested, "x.ts")]);
      await sleep(20);
    } finally {
      log.restore();
      rmSync(path.join(tmpdir(), deep), { recursive: true, force: true });
    }
    assert.ok(
      log.lines.some((line) => line.includes("no manifest within 10 levels")),
      "深仓跳过必须可观测",
    );
    assert.equal(ctx.specs.length, 0);
  });

  // ── 跨命名空间读异常：不得炸掉回合，也不得静默当成"没有编辑要检查" ──
  it("settings.describe() 抛错 → 外层兜底记录，回合不受影响", async () => {
    // 0.1.7 里插件侧唯一会失败的宿主调用就是 describe()（取语言）：设置值本身是 cordis
    // 解析好的引用，读一份已冻结的快照不存在"读不到"这条路径（旧 scope.get() 那个入口
    // 已随 register 一起消失）。
    const ctx = makeCtx();
    ctx.describeError = new Error("settings provider down");
    const log = capture();
    applyWith(ctx);
    try {
      stopEdits(ctx, "s-cfg", [fileIn(makeProject("cfg"))]);
      await sleep(20);
    } finally {
      log.restore();
    }
    assert.ok(log.lines.some((line) => line.includes("handler failed")));
    assert.equal(ctx.followupCalls.length, 0, "取语言失败时不注入（回合由宿主照常收尾）");
  });

  // ── 剩余分支：形状与边界（覆盖率 100% 的硬条件）─────────────
  describe("边界形状", () => {
    it("inbox 两个待办队列都缺省 → 视为无待处理，门禁照常执行", async () => {
      const ctx = makeCtx();
      const root = makeProject("emptyinbox");
      applyWith(ctx);
      const agent = makeAgent("s-empty-inbox", [editEvent(fileIn(root))]);
      (agent as unknown as { inbox: Record<string, unknown> }).inbox = {};
      stop(ctx, agent, 1);
      await sleep(20);
      assert.equal(ctx.specs.length, 1, "队列缺省 = 零长度，不得当成'有待处理'");
    });

    it("门禁跑完后 inbox 才被占用 → 注入前二次校验拦下（不抢话）", async () => {
      const ctx = makeCtx();
      const root = makeProject("racetobusy");
      ctx.shell.execute = async () => ({
        result: async () => {
          await sleep(40);
          return ctx.result;
        },
      });
      const log = capture();
      applyWith(ctx);
      let agent: ReturnType<typeof makeAgent> | undefined;
      try {
        agent = stopEdits(ctx, "s-race", [fileIn(root)]);
        await sleep(5);
        (agent as unknown as { inbox: { nextTurn: unknown[] } }).inbox = {
          nextTurn: [{ id: "queued" }],
        };
        await sleep(60);
      } finally {
        log.restore();
      }
      assert.equal(ctx.followupCalls.length, 0, "用户已排队 → 不注入");
      assert.ok(
        log.lines.some((line) => line.includes("injection skipped (inbox busy)")),
        "拦截原因要进日志（H4）",
      );
    });

    it("exit 126（命令不可执行）→ 未执行说明", async () => {
      const ctx = makeCtx();
      const root = makeProject("e126");
      ctx.result = {
        exitCode: 126,
        stdout: { text: "", truncated: false },
        stderr: { text: "permission denied", truncated: false },
      };
      const log = capture();
      applyWith(ctx);
      try {
        stopEdits(ctx, "s-126", [fileIn(root)]);
        await sleep(20);
      } finally {
        log.restore();
      }
      assert.match(injectedText(ctx), /命令不可执行/u);
      assert.ok(log.lines.some((line) => line.includes("gate tool unavailable")));
    });

    it("workspace 根 package.json 的 scripts 非对象 → 没有脚本信息 → 不发 pnpm check", async () => {
      const ctx = makeCtx();
      const root = path.join(
        tmpdir(),
        `qg-badscripts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, PKG_JSON), '{"name":"t","scripts":42}');
      writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");
      writeFileSync(path.join(root, TSCONFIG), MINIMAL_TSCONFIG_JSON);
      scratch.push(root);
      applyWith(ctx);
      stopEdits(ctx, "s-scripts", [fileIn(root)]);
      await sleep(20);
      assert.equal(
        ctx.specs.at(0)?.command,
        "npx tsc --noEmit",
        "scripts 不是对象 = 拿不到清单 → 保守不发 pnpm check",
      );
    });

    it("文件系统根：向上探测到 / 即停（既不越界也不误报深仓）", async () => {
      const ctx = makeCtx();
      applyWith(ctx);
      const gateableAtRoot = existsSync("/package.json") && existsSync("/tsconfig.json");
      stopEdits(ctx, "s-rootfile", ["/x.ts"]);
      await sleep(20);
      assert.equal(
        ctx.specs.length,
        gateableAtRoot ? 1 : 0,
        "根目录无清单时不该有门禁（walk 在 / 处停止）",
      );
    });

    it("清单根紧邻文件系统根：workspace 上溯到 / 后停止，门禁仍落在自己根", async () => {
      const ctx = makeCtx();
      const root = `/tmp/qg-shallow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, PKG_JSON), '{"name":"t","scripts":{"check":"tsc"}}');
      writeFileSync(path.join(root, TSCONFIG), MINIMAL_TSCONFIG_JSON);
      scratch.push(root);
      applyWith(ctx);
      stopEdits(ctx, "s-shallow", [fileIn(root)]);
      await sleep(20);
      assert.equal(ctx.specs.at(0)?.workdir, root, "上溯未命中 workspace → 保持自己的根");
    });

    it("monorepo 子包编辑 → 上溯到 pnpm-workspace 根并跑全套 pnpm check", async () => {
      const ctx = makeCtx();
      const ws = path.join(
        tmpdir(),
        `qg-wsroot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const sub = path.join(ws, "packages", "admin");
      mkdirSync(sub, { recursive: true });
      writeFileSync(path.join(ws, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      writeFileSync(path.join(ws, PKG_JSON), '{"name":"ws","scripts":{"check":"tsc"}}');
      writeFileSync(path.join(sub, PKG_JSON), '{"name":"admin"}');
      writeFileSync(path.join(sub, TSCONFIG), MINIMAL_TSCONFIG_JSON);
      scratch.push(ws);
      applyWith(ctx);
      stopEdits(ctx, "s-ws", [fileIn(sub)]);
      await sleep(20);
      assert.equal(ctx.specs.at(0)?.workdir, ws, "门禁升级到 workspace 根");
      assert.equal(ctx.specs.at(0)?.command, "pnpm check");
    });

    it("非编辑类 tool/call（read/grep）不记入累加器", async () => {
      const ctx = makeCtx();
      const root = makeProject("nonedit");
      applyWith(ctx);
      const log: unknown[] = [
        { type: "tool/call", data: { name: "read", arguments: '{"file_path":"/w/a.ts"}' } },
        { type: "tool/call", data: { name: "grep", arguments: "not-json" } },
        editEvent(fileIn(root)),
      ];
      stop(ctx, makeAgent("s-nonedit", log), 1);
      await sleep(20);
      assert.equal(ctx.specs.length, 1, "只有真编辑事件触发门禁");
      assert.equal(ctx.specs.at(0)?.workdir, root);
    });

    it("单回合编辑数超过累加器上限：淘汰数按会话可观测", async () => {
      const ctx = makeCtx();
      const root = makeProject("cap");
      applyWith(ctx);
      const many: string[] = [];
      for (let idx = 0; idx < 502; idx += 1) {
        many.push(fileIn(root, `f${idx}.ts`));
      }
      const log = capture();
      try {
        stopEdits(ctx, "s-cap", many);
        await sleep(60);
      } finally {
        log.restore();
      }
      assert.ok(
        log.lines.some((line) => line.includes("evicted from accumulator cap")),
        "容量淘汰必须可观测（旧实现静默丢根）",
      );
      assert.ok(
        log.lines.some((line) => line.includes("s-cap")),
        "计数归到本会话名下",
      );
    });
  });
});
