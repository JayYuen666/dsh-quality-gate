// test/dist-size.test.ts —— 产物体积闸门。
//
// 为什么要有：本仓 `npm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人在切面里塞进大对象字面量或整段查表」这类回退——
// 体积不是行为，任何现有用例都不会因此变红，所以必须有一把单独的尺子。
//
// 预算怎么定的：取当前实测值上浮约 15%，再向上取整到 500 B。留这一档是给正常演进的——加一条规则、
// 改一句文案不该立刻要人改预算；把一枚宿主包的实现整段内联进产物一定会顶穿。真需要突破时，改这些
// 常量并写明理由。
//
// 只有 host.js 与 client.js 两项：本仓没有 build-types.mjs，发布面里没有类型声明目录可量。
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** host 半产物体积预算（实测 75,036 B）：宿主按包名载入它，这些字节是真实装载成本。
 *  本轮新增编辑台账投影（折叠 + 双协议读口 + zod 状态校验）后按实测值上浮约 15% 取 86,500 B。 */
const HOST_BUDGET_BYTES = 86_500;
/** client 半产物体积预算（实测 34,895 B）：浏览器侧加载，按平台计账。
 *  设置卡改用 shared card-ui 后曾按 28,650 B 实测取 33,000 B；本轮数值字段改用
 *  zod 区间声明（`.int().min().max()`，NumberField 的 min/max 读 schema 的
 *  `.minValue`/`.maxValue`），网关地址改用 `z.url()`，按 34,895 B 实测上浮约 15%
 *  取 40,500 B。 */
const CLIENT_BUDGET_BYTES = 40_500;

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  ["host.js", HOST_BUDGET_BYTES],
  ["client.js", CLIENT_BUDGET_BYTES],
];

describe("产物体积", () => {
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    const bytes = readFileSync(path.join(pkgDir, file)).byteLength;
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${budget.toLocaleString("en-US")} B：多半是某个切面塞进了大查表或字面量。` +
        `确属正常演进就改 test/dist-size.test.ts 里对应的预算常量，并写明理由。`,
    );
  });
});
