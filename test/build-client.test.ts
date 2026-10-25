import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { clientFreshnessProblems } from "./client-freshness.ts";
import { bundleSlotPinProblems } from "./profile-bundle.ts";
import { schemaCoverageProblems } from "./schema-coverage.ts";

/** 构建产物相对本用例文件的位置（多条产物钉测都读它）。 */
const CLIENT_BUNDLE_REL = "../client.js";

// 三条跨包共用的门禁（产物新鲜度 / 卡片字段覆盖 / 槽位 key 漂移针）：helper 交回**问题清单**，
// 断言写在本文件的用例体内。helper 自己调 it() 的旧写法等于把「声明用例」这段 setup 放到
// 用例文件的所有 hook 之外（vitest/require-hook 模块根与 describe 体内都判它），挪进 beforeAll
// 更不行——vitest 不允许在 hook 里定义用例；断言隔一层 helper 时 vitest/expect-expect 也看不见。
// 判据本体（读哪两侧、比什么）仍在 helper 里，空数组即门禁通过，元素文本就是原来的报错信息。
describe("quality-gate 产物门禁（helper 交回问题清单，断言写在这里）", () => {
  it("client.js 与最新构建逐字节一致（改 src 后必须 node build-client.mjs）", async () => {
    assert.deepEqual(await clientFreshnessProblems(import.meta.url), []);
  });

  it("卡片覆盖 host schema 全部字段（改 host 字段必须同步卡片或声明豁免）", () => {
    assert.deepEqual(
      schemaCoverageProblems(import.meta.url, {
        allowUnbound: [
          {
            field: "maxRootDepth",
            reason:
              "W4 非 volatile 部署值：不占设置卡（宿主只投影 volatile 字段），只经 profile/cordis.yml 行 config 调整",
          },
          {
            field: "gateStdoutMaxBytes",
            reason:
              "W4 非 volatile 部署值：不占设置卡（宿主只投影 volatile 字段），只经 profile/cordis.yml 行 config 调整",
          },
        ],
      }),
      [],
    );
  });

  it("漂移针：槽位 key = profile 的 bundle 包名，configForms 入参 = patch 裸条目 id", async () => {
    assert.deepEqual(await bundleSlotPinProblems(), []);
  });
});

describe("quality-gate client 构建", () => {
  it("client.js 已产出且含卡片文案", () => {
    const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL, import.meta.url));
    assert.ok(existsSync(clientPath));
    const text = readFileSync(clientPath, "utf8");
    assert.ok(text.includes("quality-gate"));
    assert.ok(text.includes("质量门禁"));
    // i18n：两份语言的字典都要打进产物（缺 en 就是切语言后卡片空字）。
    assert.ok(text.includes("turn-end quality gate"), "en 字典必须随包产出");
  });

  it("卡片 props 契约正确：读 useCard（框架把注入 hooks 转成 use* prop），不读会崩的 props.hooks", () => {
    const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL, import.meta.url));
    const text = readFileSync(clientPath, "utf8");
    // 框架 InjectFace/PropsHooks（client-runner 1715-1723）：注入的 { hooks: { card } } 被映射为 props.useCard
    assert.ok(text.includes("useCard"), "必须用 useCard 读快照");
    assert.ok(!text.includes("props.hooks.card"), "不得读 props.hooks.card（浏览器崩溃根因）");
  });

  it("数字输入行随外部变更回同步（useEffect resync，不过期快照）", () => {
    const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL, import.meta.url));
    const text = readFileSync(clientPath, "utf8");
    assert.ok(text.includes("useEffect"), "NumberInputRow 必须 useEffect 回同步外部值");
  });

  it("清空数字输入走 unset（不留过期值），写通道受理位与拒绝必须回到卡片 save()", () => {
    const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL, import.meta.url));
    const text = readFileSync(clientPath, "utf8");
    assert.ok(text.includes("unset"), "空输入必须走 unset（恢复默认）");
    // 受理位消费（0.1.7 ConfigForm.set/unset 回 Promise<boolean>）：
    // false=宿主拒写 → saveRejected 文案且不清 touched（fail-closed，不静默丢修改）；
    // reject=传输失败 → saveFailed。旧版 inject 侧 swallow + 卡片盲目清 touched 已退役。
    // 产物是压缩构建：局部标识符不保留，钉两门字典里的文案串（缺一门即红）。
    assert.ok(text.includes("saveRejected"), "宿主拒写必须有可见反馈（saveRejected 文案进产物）");
    assert.ok(
      text.includes("Save rejected by the host"),
      "en 字典同步收录拒绝文案（缺一门即切语言空字）",
    );
  });

  it("卡片源码注释不提 danger-guard（归属正确），构建产物保持 useCard + 3 字段可配", () => {
    const src = fileURLToPath(new URL("../src/client-entry.ts", import.meta.url));
    const srcText = readFileSync(src, "utf8");
    assert.ok(!srcText.includes("danger-guard"), "头部注释不得残留 danger-guard 归属");
    const built = fileURLToPath(new URL(CLIENT_BUNDLE_REL, import.meta.url));
    const text = readFileSync(built, "utf8");
    assert.ok(text.includes("useCard"), "保持 useCard 读快照");
    assert.ok(
      text.includes("maxInjectsPerTurn") && text.includes("gateBudgetMs"),
      "保持 3 字段可配",
    );
  });
});
