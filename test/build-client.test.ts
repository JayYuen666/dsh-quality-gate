import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { singleEntryChunk } from "../build-client.mjs";
import { clientFreshnessProblems } from "./client-freshness.ts";
import { bundleSlotPinProblems } from "./profile-bundle.ts";
import { schemaCoverageProblems } from "./schema-coverage.ts";

/** 构建产物相对本用例文件的位置（多条产物钉测都读它）。 */
const CLIENT_BUNDLE_REL = "../client.js";
/** 卡片入口源码相对本用例文件的位置（契约面断言都读它）。 */
const CLIENT_ENTRY_REL = "../src/client-entry.ts";

/** 读取 client.js 产物正文；缺失时点名文件失败，而不是让各用例各自抛裸 ENOENT。 */
function readBundle(): string {
  const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL, import.meta.url));
  assert.ok(
    existsSync(clientPath),
    `client.js 未产出：${clientPath}（先跑 node build-client.mjs）`,
  );
  return readFileSync(clientPath, "utf8");
}

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
  it('zod 必须外部化：产物经 require("zod") 取宿主模块表那份，而不是内联第二份', () => {
    const text = readBundle();
    assert.match(text, /require\("zod"\)/u, "zod 应作为宿主模块被 require");
    assert.doesNotMatch(
      text,
      /class ZodError/u,
      "产物里出现 zod 内部实现（class ZodError）说明 zod 被内联，页面会有两份 zod 身份",
    );
  });

  it("client.js 已产出且含卡片文案", () => {
    const text = readBundle();
    assert.ok(text.includes("quality-gate"));
    assert.ok(text.includes("质量门禁"));
    // i18n：两份语言的字典都要打进产物（缺 en 就是切语言后卡片空字）。
    assert.ok(text.includes("No unsaved changes"), "en 字典必须随包产出");
  });

  it("卡片 props 契约正确：读 useCard（框架把注入 hooks 转成 use* prop），不读会崩的 props.hooks", () => {
    const text = readBundle();
    // 框架 InjectFace/PropsHooks（client-runner 1715-1723）：注入的 { hooks: { card } } 被映射为 props.useCard
    // 产物侧只钉能过压缩的形态：属性名与调用括号不随标识符改名消失。
    assert.match(text, /\.useCard\(/u, "必须经 useCard prop 读快照");
    // 负例必须在**源码**上判：产物里的局部标识符会被改名，按字面量 `props.hooks.card` 判是恒真断言
    // （改写成 `const { card } = props.hooks` 也照样绿）。源码是契约面，注释行单独跳过。
    const src = fileURLToPath(new URL(CLIENT_ENTRY_REL, import.meta.url));
    const code = readFileSync(src, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.match(code, /props\.useCard\(/u, "源码必须经 useCard prop 读快照");
    assert.doesNotMatch(code, /props\.hooks/u, "源码不得直读 props.hooks（浏览器崩溃根因）");
  });

  it("数字输入用 shared 的 NumberField（外部值回同步由该组件实现，渲染行为在 shared 用例里钉）", () => {
    // 回同步（useEffect + lastEmitted）住在 @jayyuen66/dsh-plugin-shared/lib/card-ui 的
    // NumberField，本仓只负责选对组件：source 里出现两处 createElement(NumberField
    // （注入配额与门禁预算）才算接线成立。产物含 useEffect 只是"shared 组件被一起打包"的
    // 旁证（minify 之后标识符不可辨），不能单独当作回同步的证据——shared 的
    // test/card-ui.test.ts 用真实挂载与重渲染钉住它。
    const src = fileURLToPath(new URL(CLIENT_ENTRY_REL, import.meta.url));
    const code = readFileSync(src, "utf8");
    assert.match(
      code,
      /import \{[^}]*NumberField[^}]*\} from "@jayyuen66\/dsh-plugin-shared\/lib\/card-ui"/u,
    );
    assert.equal(
      code.match(/createElement\(NumberField,/gu)?.length,
      2,
      "两处数字输入都走 NumberField",
    );
    assert.ok(readBundle().includes("useEffect"), "shared 的 card-ui 组件必须随包打进产物");
  });

  it("清空数字输入走 unset（不留过期值），写通道受理位与拒绝必须回到卡片 save()", () => {
    const text = readBundle();
    // unset 是极常见子串（注释与解构里都有），产物侧按字面判恒真；清空路径的判据落在源码上：
    // writeTouched 对 undefined 走 unset(key)，NumberField 把空输入交回 undefined。
    const src = fileURLToPath(new URL(CLIENT_ENTRY_REL, import.meta.url));
    const code = readFileSync(src, "utf8");
    assert.match(
      code,
      /val === undefined \? unset\(key\) : set\(key, val\)/u,
      "空输入必须走 unset",
    );
    // 受理位消费（0.1.7 ConfigForm.set/unset 回 Promise<boolean>）：
    // false=宿主拒写 → saveRejected 文案且不清 touched（fail-closed，不静默丢修改）；
    // reject=传输失败 → saveFailed。inject 侧 swallow 受理位、卡片盲清 touched 都是这一面要挡的。
    // 产物是压缩构建：局部标识符不保留，钉两门字典里的文案串（缺一门即红）。
    assert.ok(text.includes("saveRejected"), "宿主拒写必须有可见反馈（saveRejected 文案进产物）");
    assert.ok(
      text.includes("Save rejected by the host"),
      "en 字典同步收录拒绝文案（缺一门即切语言空字）",
    );
  });

  it("卡片源码注释不提 danger-guard（归属正确），六个设置字段全部绑进卡片", () => {
    const src = fileURLToPath(new URL(CLIENT_ENTRY_REL, import.meta.url));
    const srcText = readFileSync(src, "utf8");
    assert.ok(!srcText.includes("danger-guard"), "头部注释不得残留 danger-guard 归属");
    assert.ok(readBundle().includes("useCard"), "保持 useCard 读快照");
    // 字段清单与 host Config 的 volatile 面一一对应：少绑一个，设置卡上就有一项永远改不动。
    for (const field of [
      "enabled",
      "maxInjectsPerTurn",
      "gateBudgetMs",
      "memoryFeedback",
      "memoryGatewayUrl",
      "memoryGatewayKeyRef",
    ]) {
      assert.ok(srcText.includes(`field: "${field}"`), `${field} 必须绑进卡片`);
    }
  });
});

/** 输出守卫测试用的最小 chunk 正文。 */
const CHUNK_CODE = "export {};";
/** 输出守卫测试用的产物文件名。 */
const ARTIFACT_FILE = "artifact.js";

/**
 * 造一个最小输出项；判据只看 type/fileName/isEntry/code。
 * @param type - rolldown 输出项类型
 * @param fileName - 产物文件名
 * @param extra - 该类型需要的其余字段
 * @returns 可交给 singleEntryChunk 的输出项
 */
type OutputItem =
  | {
      type: "chunk";
      fileName: string;
      code: string;
      isEntry?: boolean;
      moduleIds?: readonly string[];
    }
  | { type: "asset"; fileName: string };

function outputItem(
  type: "chunk" | "asset",
  fileName: string,
  extra: Partial<{ isEntry: boolean; code: string }> = {},
): OutputItem {
  if (type === "asset") {
    return { type, fileName };
  }
  return {
    type,
    fileName,
    code: extra.code ?? "",
    ...(extra.isEntry === undefined ? {} : { isEntry: extra.isEntry }),
  };
}

describe("单文件产物的输出守卫", () => {
  it("拒绝多个 chunk：单文件产物不能静默丢掉第二个", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE }),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("拒绝 asset：单文件产物没有落盘 asset 的位置", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("asset", "x.css"),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("拒绝非 entry 的单个 chunk", () => {
    const output = [outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE })];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /entry chunk/u);
  });

  it("拒绝空正文的 entry chunk：空产物落盘后卡片静默不渲染", () => {
    const output = [outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: "  \n " })];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /entry chunk/u);
  });

  it("接受唯一的 entry chunk", () => {
    const output = [outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE })];
    const chunk = singleEntryChunk(output, "entry.ts");
    assert.equal(chunk.code, CHUNK_CODE);
  });
});
