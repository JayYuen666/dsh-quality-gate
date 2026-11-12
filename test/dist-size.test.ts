// test/dist-size.test.ts —— 产物体积上限检查。
//
// 为什么要有：本仓 `npm run check` 的顺序是 build 在 test 之前，所以这道检查读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人在构建切面里塞进大对象字面量或整段查表」这类回退——
// 体积不是行为，任何现有用例都不会因此变红，所以必须单独有一道按字节数的检查。
//
// 预算 = 在当前实测值上加约 15%，再向上取整到 500 B；实测值记在对应常量的注释里。
// 留这一档是给正常演进的——加一条规则、改一句文案不该立刻要人改预算；把一枚宿主包的实现
// 整段内联进产物一定会顶穿。真需要突破时，改这些常量并写明理由。
//
// 只有 host.js 与 client.js 两项：本仓没有 build-types.mjs，发布产物里没有类型声明目录可量。
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** host 半产物体积预算（本次扩充时实测 98,917 B）：宿主按包名载入它，这些字节是真实装载成本。
 *  这一档的上一次实测是 75,036 B；rc.2 集成的四条行为路径（可写根登记、具名子代理聚合、
 *  inspectSession 台账读取、工具失败身份）连同它们的证据注释一起进入产物，预算按同一规则重定。 */
const HOST_BUDGET_BYTES = 114_000;
/** client 半产物体积预算（定这一档时实测 40,886 B）：浏览器侧加载，按平台计账。
 *  上一档 40,500 B 对应内联 shared 0.2.6 的产物（已发布 0.1.8 的 client.js 实测 39,845 B）；
 *  shared 0.2.8 的浮层几何自检与修正后的 CSS 进来后实测 40,886 B，按同一规则重定。 */
const CLIENT_BUDGET_BYTES = 47_500;

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
