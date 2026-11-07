// 端到端：真的起一个 tsc 进程来验这条门禁。host.test.ts 里那几条门禁用 mock shell 回放退出码；
// 这一层用官方本地执行器（LocalSubprocessRuntime + LocalBashExecutor，与宿主同一对）
// 真 spawn TypeScript 编译器，验证「门禁命令的探测 → 命令执行 → 退出码分类」在真实进程上
// 成立：坏工程非零退出（code-failure 语义），干净工程退 0（pass）。
import { afterEach, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { Context } from "@deepseek-ai/cordis";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { detectGate } from "../../lib/gate-detect.ts";
import { shellArg } from "../../host.ts";

const require = createRequire(import.meta.url);

interface Rig {
  ctx: Context;
  dir: string;
}

let rig: Rig | undefined;

async function boot(): Promise<Rig> {
  const made = await mkdtemp(path.join(os.tmpdir(), "qg-e2e-"));
  const dir = await realpath(made);
  const ctx = new Context();
  try {
    await ctx.plugin(LocalSubprocessRuntime);
    const spillDir = path.join(dir, ".spill");
    (ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir };
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 60_000, graceMs: 300 });
    return { ctx, dir };
  } catch (error) {
    await ctx.fiber.dispose().catch(() => null);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** 铺一个真 TS 工程（tsconfig 严格模式 + 一枚入口文件），可选注入一处类型错误。 */
async function makeProject(root: string, broken: boolean): Promise<void> {
  await mkdir(root, { recursive: true });
  const tsconfigPath = path.join(root, "tsconfig.json");
  await writeFile(
    tsconfigPath,
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
    "utf8",
  );
  const entry = broken ? "const value: number = '这不是数字';\n" : "const value: number = 1;\n";
  const entryPath = path.join(root, "entry.ts");
  await writeFile(entryPath, entry, "utf8");
}

/** 用官方执行器真跑一条命令，取回退出码（分类所用的数据来源）。 */
async function runIn(ctx: Context, command: string, workdir: string): Promise<number> {
  const shell = ctx.shell as unknown as {
    resolve: (request: { command: string; workdir: string }) => unknown;
    execute: (spec: unknown) => Promise<{ result: () => Promise<{ exitCode: number }> }>;
  };
  const spec = shell.resolve({ command, workdir });
  const execution = await shell.execute(spec);
  const result = await execution.result();
  return result.exitCode;
}

describe("真实 tsc门禁进程", () => {
  afterEach(async () => {
    const current = rig;
    rig = undefined;
    if (current !== undefined) {
      await current.ctx.fiber.dispose();
      await rm(current.dir, { recursive: true, force: true });
    }
  });

  it("探测认出非 workspace 的 TS 工程；有错误的工程真跑返回非零（code-failure），干净的工程退 0（pass）", async () => {
    rig = await boot();
    const { ctx, dir } = rig;
    // 探测：非 workspace + package.json + tsconfig.json ⇒ tsc 门禁（假失败比漏检查更贵的
    // 取向在单测钉过，这里只证探测在真实文件形状上认得出）。
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "proj" }), "utf8");
    const gates = detectGate([{ root: dir, files: ["package.json", "tsconfig.json"] }]);
    assert.equal(gates.length, 1);
    assert.deepEqual(gates[0]?.command, ["tsc", "--noEmit"]);

    // 命令执行串：host 的 tscEntry 解析工程本地/依赖树里的 typescript；e2e 用依赖树里
    // 那份（与本包 dependencies 同源），经 shellArg 走同一引号规则。
    const tscEntry = path.join(
      path.dirname(require.resolve("typescript/package.json")),
      "bin",
      "tsc",
    );
    const runCommand = `${shellArg(process.execPath)} ${shellArg(tscEntry)} --noEmit`;

    const broken = path.join(dir, "broken");
    const clean = path.join(dir, "clean");
    await makeProject(broken, true);
    await makeProject(clean, false);

    const brokenExit = await runIn(ctx, runCommand, broken);
    assert.notEqual(brokenExit, 0, "真 tsc 必须抓到注入的类型错误");

    const cleanExit = await runIn(ctx, runCommand, clean);
    assert.equal(cleanExit, 0, "干净工程必须真退 0");
  }, 120_000);
});
