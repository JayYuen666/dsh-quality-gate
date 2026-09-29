// host 契约补充测试（2026-09-18 补齐未覆盖分支）：
// 从「对外行为契约」验证 turn-stopping 门禁批处理的顺序依赖语义：
//   1. 多根归并出多个门禁时，第一个失败注入成功后停止（mustStop 短路），
//      不继续跑剩余门禁（一次只注入一个失败）；
//   2. 门禁总预算耗尽（remaining < 最小可用预算）时跳过剩余门禁并 warn，
//      不制造必超时的假失败注入；
//   3. 所有门禁通过 → 会话配额重置（下一轮重新计数）；
//   4. lesson bus 的 report 异步落库（返回 rejected Promise）时失败同样进日志——
//      旧代码只有同步 catch，异步失败既不留日志又给进程留一枚未处理拒绝。
import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { applyGate } from "./config-refs.ts";

// 记忆反馈是尽力而为：mock pushGateFeedback 必抛错，验证 catch warn 且注入不受影响。
// 注：pushGateFeedback 的网关 env 是模块求值期常量，运行时改 env 无效，只能 mock。
vi.mock(import("../lib/gateway-feedback.ts"), async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/gateway-feedback.ts")>();
  return {
    ...orig,
    pushGateFeedback: async () => {
      throw new Error("gateway unreachable (mock)");
    },
  };
});

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
  /** 本插件 fiber 的替身：configure 的 owner 必须原样带回它（身份断言用）。 */
  fiber: unknown;
  handlers: Record<string, (payload: unknown) => void>;
  followupCalls: unknown[];
  shellCommands: unknown[];
  effects: (() => void)[];
  /** shell.execute 每次调用的耗时（ms），模拟门禁执行时间。 */
  gateDelayMs: number;
  gateExitCode: number;
  /** 凭据服务：记忆反馈的 key 从这里解析（undefined = 组合里没装该服务）。 */
  credentials: { resolve: (ref: string) => Promise<{ value: string } | undefined> } | undefined;
  /** 0.1.7 的 settings 面：register/get 已被宿主移除，只剩页面策略与跨命名空间读。 */
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
    resolve: (spec: unknown) => unknown;
    /** 0.1.7 唯一执行入口：结果从前台投影 handle.result() 取。 */
    execute: (spec: unknown) => Promise<{
      result: () => Promise<{
        exitCode: number | null;
        stdout: { text: string; truncated: boolean };
        stderr?: { text: string; truncated: boolean };
      }>;
    }>;
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): MockCtx {
  const ctx: MockCtx = {
    value: {
      enabled: true,
      maxInjectsPerTurn: 2,
      gateBudgetMs: 300_000,
      memoryFeedback: true,
      // 记忆反馈要"开关 + 地址"两项齐了才启用；mock 给出可用配置，
      // 让"反馈自身失败"的测试真的走到 pushGateFeedback（而不是被前置门禁挡掉）。
      memoryGatewayUrl: "http://gateway.test:8420",
      memoryGatewayKeyRef: "TDAI_GATEWAY_KEY",
      // W4 非 volatile 部署值：resolve 交普通值（refsOf 按 meta.volatile 区分形状）
      maxRootDepth: 10,
      gateStdoutMaxBytes: 65_536,
      ...overrides,
    },
    fiber: { id: "quality-gate-fiber" },
    handlers: {},
    followupCalls: [],
    shellCommands: [],
    effects: [],
    gateDelayMs: 0,
    gateExitCode: 0,
    credentials: {
      async resolve() {
        return { value: "tok-from-credentials" };
      },
    },
    settings: {
      configure: () => () => {
        void 0;
      },
      // 跨命名空间读：本文件的用例都不关心语言 → 空表（= 没有任何条目被投影）。
      describe: () => [],
    },
    inject: (_deps, attach) => {
      attach(ctx);
    },
    sessionQuery: {
      observeSession: async () => observationOfFiredSession(),
    },
    get(name) {
      return (ctx as unknown as Record<string, unknown>)[name];
    },
    on(event, handler) {
      // 记本次 fire 的 agent.session，好让观察面替身交回夹具自己挂的那份日志
      // （**只有测试侧**读它；生产侧已不读 snapshotEvents）。
      ctx.handlers[event] = (payload: unknown) => {
        // 载荷恒为宿主交出的事件对象（每个 fire 点都传字面量对象），故首段不写 `?.`；
        // `agent` 是可缺字段（`{ turn: 1 }` 那类载荷就没有），那一段守卫保留。
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
        ctx.shellCommands.push(spec);
        return spec;
      },
      async execute() {
        return {
          result: async () => {
            if (ctx.gateDelayMs > 0) {
              await sleep(ctx.gateDelayMs);
            }
            return {
              exitCode: ctx.gateExitCode,
              stdout: { text: "output", truncated: false },
              stderr: {
                text: ctx.gateExitCode === 0 ? "" : "TS2345: type error",
                truncated: false,
              },
            };
          },
        };
      },
    },
  };
  return ctx;
}

function makeProject(name: string, scratch: string[]): string {
  const root = path.join(
    tmpdir(),
    `qg-contract-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"name":"t","scripts":{"check":"tsc"}}');
  writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{},"include":["a.ts"]}');
  writeFileSync(path.join(root, "a.ts"), "export const x = 1\n");
  scratch.push(root);
  return root;
}

const editEvent = (file: string): unknown => ({
  type: "tool/call",
  data: { name: "edit", arguments: JSON.stringify({ file_path: file }) },
});

function agentOf(
  ctx: MockCtx,
  events: unknown[],
  followupThrows = false,
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
    session: { id: "s-c", header: {}, snapshotEvents: (from?: number) => events.slice(from ?? 0) },
    status: "running",
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) {
      ctx.followupCalls.push(message);
      if (followupThrows) {
        throw new Error("followup transport failed");
      }
    },
  };
}

/** 换掉 ctx.get：lessonLoop 只给一个自定义 report 的总线，其余服务走原实现。 */
function overrideLessonBus(ctx: MockCtx, report: () => unknown): void {
  ctx.get = (name: string): unknown =>
    name === "lessonLoop" ? { report } : (ctx as unknown as Record<string, unknown>)[name];
}

/** 捕获 console.warn 的全部实参（降级日志要连失败原因一起断言，只收首参等于没验）。 */
function warnCapture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore() {
      console.warn = original;
    },
  };
}

/**
 * 未处理拒绝探针：装一枚 process 级监听，把漏网的 rejection 收进数组。
 * `stop` 必须进 finally——worker 进程被所有用例共用，残留监听会把别人的
 * rejection 也算到本用例头上。
 */
function rejectionProbe(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const record = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", record);
  return {
    reasons,
    stop() {
      process.off("unhandledRejection", record);
    },
  };
}

describe("turn-stopping 批处理的顺序依赖语义", () => {
  it("多根多门禁：第一个失败注入成功后停止（mustStop 短路，不跑剩余门禁）", async () => {
    const scratch: string[] = [];
    const ctx = makeCtx();
    // 第一个门禁失败
    ctx.gateExitCode = 1;
    const projectA = makeProject("a", scratch);
    const projectB = makeProject("b", scratch);
    try {
      applyGate(ctx, ctx.value);
      const events = [
        editEvent(path.join(projectA, "a.ts")),
        editEvent(path.join(projectB, "a.ts")),
      ];
      ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(ctx, events), turn: 1 });
      await sleep(50);
      // 契约：一次只注入一个失败——第一个失败注入后，剩余门禁不执行
      assert.equal(ctx.shellCommands.length, 1, "mustStop 后不应再跑剩余门禁");
      assert.equal(ctx.followupCalls.length, 1, "只注入一次修复指令");
    } finally {
      for (const root of scratch) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("总预算耗尽 → 跳过剩余门禁并**注入未执行说明**（不再只 warn = 静默通过）", async () => {
    const scratch: string[] = [];
    // 预算 6s：第一个门禁 sleep 1.5s 后剩余 4.5s < MIN_USEFUL_GATE_MS(5s) → 第二个被跳过
    const ctx = makeCtx({ gateBudgetMs: 6000 });
    ctx.gateDelayMs = 1500;
    // 门禁都通过（验证注入不是因为代码失败，而是"没跑成"）
    ctx.gateExitCode = 0;
    const projectA = makeProject("a", scratch);
    const projectB = makeProject("b", scratch);
    try {
      applyGate(ctx, ctx.value);
      const events = [
        editEvent(path.join(projectA, "a.ts")),
        editEvent(path.join(projectB, "a.ts")),
      ];
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: unknown) => {
        warns.push(String(msg));
      };
      const origInfo = console.info;
      const infos: string[] = [];
      console.info = (msg: unknown) => {
        infos.push(String(msg));
      };
      try {
        ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(ctx, events), turn: 1 });
        await sleep(3000);
      } finally {
        console.warn = origWarn;
        console.info = origInfo;
      }
      // 契约：第一个 gate 跑了；第二个因预算耗尽被跳过
      assert.equal(ctx.shellCommands.length, 1, "剩余门禁应被预算耗尽跳过");
      // 审计 MEDIUM 项：跳过的检查不得静默算通过——必须注入"未执行"说明
      assert.equal(ctx.followupCalls.length, 1, "被跳过的门禁必须注入未执行说明");
      const injected = ctx.followupCalls[0] as { content: { text: string }[] };
      const text = injected.content.map((chunk) => chunk.text).join("");
      assert.match(text, /未能执行/u, "文案是未执行说明，不是修复指令");
      assert.match(text, /不要为此修改代码/u, "不得让模型去修一个没跑成的检查");
      assert.match(text, new RegExp(path.basename(projectB), "u"), "未执行的根要列进文案");
      assert.ok(!text.includes("请修复上述问题"), "不得复用代码失败模板");
      assert.ok(
        infos.some((infoText) => infoText.includes("gate not-run")),
        "未执行注入要可观测（console.info 计数）",
      );
      assert.equal(warns.length, 0, "跳过不是告警，而是注入给用户的未执行说明");
    } finally {
      for (const root of scratch) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("全部门禁通过 → 会话配额重置（下一轮同 turn 重新计数）", async () => {
    const scratch: string[] = [];
    const ctx = makeCtx();
    // 通过
    ctx.gateExitCode = 0;
    const projectA = makeProject("a", scratch);
    try {
      applyGate(ctx, ctx.value);
      const events = [editEvent(path.join(projectA, "a.ts"))];
      // 第 1 轮：通过 → 无注入
      ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(ctx, events), turn: 1 });
      await sleep(50);
      assert.equal(ctx.followupCalls.length, 0, "通过不注入");
      // 第 2 轮：模拟真实累积事件流（同一会话，游标从上次位置继续读）。
      // snapshotEvents(from) 必须基于同一累积数组，否则新数组会让游标越界 → 无编辑。
      events.push(editEvent(path.join(projectA, "a2.ts")));
      ctx.gateExitCode = 1;
      ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(ctx, events), turn: 2 });
      await sleep(50);
      assert.equal(ctx.followupCalls.length, 1, "干净回合后配额应重置，能注入修复");
    } finally {
      for (const root of scratch) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("followup 抛错 → 回滚配额计数并继续剩余门禁（注入未发生则不短路）", async () => {
    const scratch: string[] = [];
    const ctx = makeCtx();
    ctx.gateExitCode = 1;
    const projectA = makeProject("a", scratch);
    const projectB = makeProject("b", scratch);
    try {
      applyGate(ctx, ctx.value);
      const events = [
        editEvent(path.join(projectA, "a.ts")),
        editEvent(path.join(projectB, "a.ts")),
      ];
      const errors: string[] = [];
      const origError = console.error;
      console.error = (msg: unknown) => {
        errors.push(String(msg));
      };
      try {
        ctx.handlers["agent/turn-stopping"]!({
          agent: agentOf(ctx, events, true),
          turn: 1,
        });
        await sleep(80);
      } finally {
        console.error = origError;
      }
      // 契约：第一个注入失败 → 不短路（mustStop=false）→ 第二个门禁继续执行；
      // 配额回滚（count 恢复），不会因"没注入成功"占用注入次数。
      assert.equal(ctx.shellCommands.length, 2, "注入失败后应继续剩余门禁");
      assert.ok(
        errors.some((errorText) => errorText.includes("followup failed")),
        "followup 失败应记录 error",
      );
    } finally {
      for (const root of scratch) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("lessonLoop.report 抛错 → 失败注入照常发生（总线容错）", async () => {
    const scratch: string[] = [];
    const ctx = makeCtx();
    ctx.gateExitCode = 1;
    const projectA = makeProject("a", scratch);
    // 总线 report 抛错：守卫不得被总线故障拖垮
    overrideLessonBus(ctx, () => {
      throw new Error("lesson bus down");
    });
    const logs = warnCapture();
    try {
      applyGate(ctx, ctx.value);
      const events = [editEvent(path.join(projectA, "a.ts"))];
      ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(ctx, events), turn: 1 });
      await sleep(50);
      assert.equal(ctx.followupCalls.length, 1, "总线故障不影响修复注入");
      assert.ok(
        logs.lines.some(
          (warnText) =>
            warnText.includes("lessonLoop report failed:") && warnText.includes("lesson bus down"),
        ),
        "同步抛错必须留下降级日志（老路径的日志面，异步化后不许退化）",
      );
    } finally {
      logs.restore();
      for (const root of scratch) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("lessonLoop.report 返回 rejected Promise → 同一降级日志照记，且不产生未处理拒绝", async () => {
    const scratch: string[] = [];
    const ctx = makeCtx();
    ctx.gateExitCode = 1;
    const projectA = makeProject("a", scratch);
    overrideLessonBus(ctx, (): Promise<never> =>
      Promise.reject(new Error("lesson bus async down")),
    );
    const logs = warnCapture();
    const probe = rejectionProbe();
    try {
      applyGate(ctx, ctx.value);
      const events = [editEvent(path.join(projectA, "a.ts"))];
      ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(ctx, events), turn: 1 });
      // 50ms 既覆盖注入链，也让 rejection 的微任务与 Node 的宏任务判定边界走完。
      await sleep(50);
      assert.equal(ctx.followupCalls.length, 1, "总线异步故障同样不影响修复注入");
      assert.ok(
        logs.lines.some(
          (warnText) =>
            warnText.includes("lessonLoop report failed:") &&
            warnText.includes("lesson bus async down"),
        ),
        "异步失败必须与同步抛错落进同一条日志（否则被静默吞掉）",
      );
      assert.deepEqual(probe.reasons, [], "rejection 必须被接住：漏出去会污染整个宿主进程");
    } finally {
      logs.restore();
      probe.stop();
      for (const root of scratch) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("记忆反馈失败 → warn 但注入不受影响（memory feedback 尽力而为）", async () => {
    const scratch: string[] = [];
    const ctx = makeCtx();
    ctx.gateExitCode = 1;
    const projectA = makeProject("a", scratch);
    // pushGateFeedback 已被 vi.mock 为必抛 → 走 catch warn
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => {
      warns.push(String(msg));
    };
    try {
      applyGate(ctx, ctx.value);
      const events = [editEvent(path.join(projectA, "a.ts"))];
      ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(ctx, events), turn: 1 });
      await sleep(200);
      assert.equal(ctx.followupCalls.length, 1, "记忆反馈失败不影响注入");
      assert.ok(
        warns.some(
          (warnText) =>
            warnText.includes("memory feedback skipped") &&
            warnText.includes("gateway unreachable (mock)"),
        ),
        "记忆反馈失败应有 warn（且必须真的走到 pushGateFeedback 才失败，不是被前置门禁挡掉）",
      );
    } finally {
      console.warn = origWarn;
      for (const root of scratch) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("配额耗尽后 giveUp 的 followup 也抛错 → catch 记录 error 不崩溃", async () => {
    const scratch: string[] = [];
    const ctx = makeCtx({ maxInjectsPerTurn: 1 });
    ctx.gateExitCode = 1;
    const projectA = makeProject("a", scratch);
    try {
      applyGate(ctx, ctx.value);
      const events = [editEvent(path.join(projectA, "a.ts"))];
      // 第 1 轮：失败注入（count 0→1）
      ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(ctx, events), turn: 1 });
      await sleep(50);
      assert.equal(ctx.followupCalls.length, 1);
      // 第 2 轮：count>=maxInjects → giveUp 分支；followup（give-up 说明）抛错
      const errors: string[] = [];
      const origError = console.error;
      console.error = (msg: unknown) => {
        errors.push(String(msg));
      };
      try {
        events.push(editEvent(path.join(projectA, "a2.ts")));
        ctx.handlers["agent/turn-stopping"]!({ agent: agentOf(ctx, events, true), turn: 2 });
        await sleep(50);
      } finally {
        console.error = origError;
      }
      assert.ok(
        errors.some((errorText) => errorText.includes("give-up followup failed")),
        "giveUp followup 失败应记录 error",
      );
    } finally {
      for (const root of scratch) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
