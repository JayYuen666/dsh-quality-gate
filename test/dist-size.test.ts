// test/dist-size.test.ts —— 产物体积上限检查。
//
// 为什么要有：本仓 `npm run check` 的顺序是 build 在 test 之前，所以这道检查读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人在构建切面里塞进大对象字面量或整段查表」这类回退——
// 体积不是行为，任何现有用例都不会因此变红，所以必须单独有一道按字节数的检查。
//
// 预算 = 在当前实测值上加约 15%，再向上取整到 500 B。实测值不写死在注释里：它随每次构建
// 变动，写下的数字第二天就失真；超限报错会打印实际字节，改预算时以那一次的现量为准，
// 并在 CHANGELOG 里写明理由。
//
// 只有 host.js 与 client.js 两项：本仓没有 build-types.mjs，发布产物里没有类型声明目录可量。
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** host 半产物体积预算：宿主按包名载入它，这些字节是真实装载成本。
 *  0.1.14 的增量来自环境性失败判定、`pnpmScripts`、队友台账冷读的异步切分、回合判据、
 *  客户端读面与诊断路径换算；按「实测 + 约 15% 取整」的同一规则定档——体积仍是约束，不是配额。 */
// 0.1.14 加入九种语言的门禁矩阵与按命令分派的诊断解析后，实测 138,158 B；
// 预算按本文件写明的「实测 + 约 15% 再向上取整到 500 B」抬到 159,000 B。
// 该轮收尾的审查修复（Makefile 目标表、诊断共用收集器、策略重解析、错误摘要分类）把实测推到
// 159,349 B，按同一规则抬到 183,500 B。
const HOST_BUDGET_BYTES = 183_500;
/** client 半产物体积预算：在会话侧栏、forge 注解与右键门禁之后，再加入供应链扫描开关；
 *  实测 20,410 B，按本文件「实测 + 约 15% 再向上取整到 500 B」的规则定档。
 *  浏览器侧加载；shared card-ui 的字节不计入本产物。 */
const CLIENT_BUDGET_BYTES = 23_500;

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  ["host.js", HOST_BUDGET_BYTES],
  ["client.js", CLIENT_BUDGET_BYTES],
];

describe("产物体积", () => {
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    const artifact = path.join(pkgDir, file);
    // 单独跑这个文件（没先 build）时，产物缺失必须给出可操作的说明，而不是裸 ENOENT。
    assert.ok(
      existsSync(artifact),
      `找不到产物 ${file}：请先执行 pnpm run build:client && pnpm run build（这条检查读的是当轮产物）。`,
    );
    const bytes = readFileSync(artifact).byteLength;
    // 上界只能挡住超出上界的情况；0 字节的文件和占位文件都在上界以下，会让这条检查永远通过。
    assert.ok(bytes > 0, `${file} 为 0 字节：构建没有真正产出内容，体积上限无从判定。`);
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${budget.toLocaleString("en-US")} B：多半是某个切面塞进了大查表或字面量。` +
        `确属正常演进就改 test/dist-size.test.ts 里对应的预算常量，并写明理由。`,
    );
  });
});
