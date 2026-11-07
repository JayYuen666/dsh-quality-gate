import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { singleEntryChunk } from "../build-client.mjs";
import { clientFreshnessProblems } from "./client-freshness.ts";
import { bundleSlotPinProblems } from "./profile-bundle.ts";
import { schemaCoverageProblems } from "./schema-coverage.ts";

/** 构建产物相对本用例文件的位置（几条只读产物的断言都从这里取路径）。 */
const CLIENT_BUNDLE_REL = "../client.js";
/** 卡片入口源码相对本用例文件的位置（要读源码原文的断言都从这里取路径）。 */
const CLIENT_ENTRY_REL = "../src/client-entry.ts";

/** 读取 client.js 产物正文；读不到时报错点名是哪个文件，而不是让每条用例各自抛出 ENOENT。 */
function readBundle(): string {
  const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL, import.meta.url));
  assert.ok(
    existsSync(clientPath),
    `client.js 未产出：${clientPath}（先跑 node build-client.mjs）`,
  );
  return readFileSync(clientPath, "utf8");
}

// 三条跨包共用的门禁（产物是否最新 / 卡片字段是否覆盖 host schema / 槽位 key 有没有写错标识）：
// helper 返回问题列表，断言写在本文件的用例体内。helper 自己调 it() 的旧写法等于把"声明用例"
// 这段准备工作放到用例文件的所有 hook 之外（vitest/require-hook 在模块根与 describe 体内都判它），
// 挪进 beforeAll 更不行——vitest 不允许在 hook 里定义用例；断言隔了一层 helper 时
// vitest/expect-expect 也看不见。比什么、读哪两侧仍然写在 helper 里：返回空数组即通过，
// 数组里每条文本就是原来报错时给人的那句话。
describe("quality-gate 产物检查（helper 返回问题列表，断言写在这里）", () => {
  it("client.js 与最新构建逐字节一致（改 src 后必须 node build-client.mjs）", async () => {
    assert.deepEqual(await clientFreshnessProblems(import.meta.url), []);
  });

  it("卡片覆盖 host schema 的全部字段（改了 host 字段就要同步卡片，或声明例外）", () => {
    assert.deepEqual(
      schemaCoverageProblems(import.meta.url, {
        allowUnbound: [
          {
            field: "maxRootDepth",
            reason:
              "非 volatile 的部署级设置：设置卡上没有它（宿主只把 volatile 字段投影到卡片），只能在 profile/cordis.yml 的那行 config 里调整",
          },
          {
            field: "gateStdoutMaxBytes",
            reason:
              "非 volatile 的部署级设置：设置卡上没有它（宿主只把 volatile 字段投影到卡片），只能在 profile/cordis.yml 的那行 config 里调整",
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
  it('zod 必须外部化：产物用 require("zod") 拿宿主模块表里的那份，而不是内联第二份', () => {
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
    // 两种语言的文案都要打进产物：缺英文那一份，切到英文后卡片上没有文字。
    assert.ok(text.includes("No unsaved changes"), "英文文案必须随包产出");
  });

  it("卡片 props 的用法正确：读 useCard（框架把注入的 hooks 转成 use* 形式的 prop），不读会崩溃的 props.hooks", () => {
    const text = readBundle();
    // 框架的 InjectFace / PropsHooks（client-runner）把注入的 { hooks: { card } } 映射成 props.useCard。
    // 产物里只断言压缩后仍然存在的形态：属性名和调用括号不会因为标识符改名而消失。
    assert.match(text, /\.useCard\(/u, "必须经 useCard prop 读快照");
    // 反向的断言必须写在**源码**上：产物里的局部标识符会被改名，按字面量 `props.hooks.card`
    // 判断永远成立（改写成 `const { card } = props.hooks` 也照样通过）。
    // 源码才是这段代码真实写出来的样子，逐行读时要单独跳过注释行。
    const src = fileURLToPath(new URL(CLIENT_ENTRY_REL, import.meta.url));
    const code = readFileSync(src, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.match(code, /props\.useCard\(/u, "源码必须经 useCard prop 读快照");
    assert.doesNotMatch(code, /props\.hooks/u, "源码不得直接读 props.hooks（浏览器崩溃的原因）");
  });

  it("数字输入用 shared 的 NumberField（外部值同步由该组件实现，渲染行为由 shared 的测试覆盖）", () => {
    // 外部值同步（useEffect + lastEmitted）写在共享客户端模块的 NumberField 里，本仓只负责选对组件：
    // 源码里出现两处 createElement(NumberField（注入配额与门禁预算）才算这条接线成立。
    // 组件在构建期内联进产物（build-client.mjs 的外置清单只留 react / zod）：对
    // `@jayyuen66/dsh-plugin-shared/client` 的运行期外置要靠另一份包被装载成模块表条目才兑现，
    // 传递依赖安装形状下宿主可能不排进启动图，页面启动时落进 "missed the module table"
    // （dsh-ocr-review 仓 issue #2）。产物里出现这条说明符即外置回流，当场判红。
    const src = fileURLToPath(new URL(CLIENT_ENTRY_REL, import.meta.url));
    const code = readFileSync(src, "utf8");
    assert.match(
      code,
      /import \{[^}]*NumberField[^}]*\} from "@jayyuen66\/dsh-plugin-shared\/client"/u,
    );
    assert.equal(
      code.match(/createElement\(NumberField,/gu)?.length,
      2,
      "两处数字输入都走 NumberField",
    );
    assert.doesNotMatch(
      readBundle(),
      /dsh-plugin-shared\/client/u,
      "共享卡片组件必须内联进本包，产物不得保留对 shared/client 的模块表请求",
    );
  });

  it("清空数字输入走 unset（不留下过期的值），宿主是否接受写入与写入失败都要回到卡片的 save()", () => {
    const text = readBundle();
    // unset 是很常见的子串（注释和解构里都有），在产物里按字面匹配永远成立；
    // 清空这条路径要看源码：writeTouched 遇到 undefined 时调用 unset(key)，NumberField 把空输入返回 undefined。
    const src = fileURLToPath(new URL(CLIENT_ENTRY_REL, import.meta.url));
    const code = readFileSync(src, "utf8");
    assert.match(
      code,
      /val === undefined \? unset\(key\) : set\(key, val\)/u,
      "空输入必须走 unset",
    );
    // 调用方必须用 ConfigForm.set/unset 的返回值（0.1.7 起是 Promise<boolean>）：
    // false 表示宿主拒绝写入 → 显示 saveRejected 的文案且不清掉 touched（宁可留着脏态，也不悄悄丢掉修改）；
    // reject 表示传输失败 → 显示 saveFailed。inject 那侧忽略这个返回值、卡片无条件清掉 touched，
    // 都是这里要防的做法。产物是压缩后的构建：局部标识符不保留，
    // 所以断言两种语言文案里的那句话。
    assert.ok(text.includes("saveRejected"), "宿主拒写必须有可见反馈（saveRejected 文案进产物）");
    assert.ok(
      text.includes("Save rejected by the host"),
      "英文文案里也要收录这条拒绝提示（少一种语言，切过去就没有文字）",
    );
  });

  it("卡片源码的注释不出现 danger-guard（那是另一个插件的名字），host 的 volatile 字段全部绑定到卡片", () => {
    const src = fileURLToPath(new URL(CLIENT_ENTRY_REL, import.meta.url));
    const srcText = readFileSync(src, "utf8");
    assert.ok(!srcText.includes("danger-guard"), "头部注释不得留下 danger-guard 的字样");
    assert.ok(readBundle().includes("useCard"), "仍然通过 useCard 读取快照");
    // 字段清单要和 host Config 里标为 volatile 的那些字段一一对应：少绑一个，设置卡上就有一项永远改不动。
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

/** 测试输出守卫用的最小 chunk 正文。 */
const CHUNK_CODE = "export {};";
/** 测试输出守卫用的产物文件名。 */
const ARTIFACT_FILE = "artifact.js";

/**
 * 构造一个最小的输出项；检查只看 type/fileName/isEntry/code。
 * @param type - rolldown 输出项类型
 * @param fileName - 产物文件名
 * @param extra - 该类型需要的其余字段
 * @returns 可以交给 singleEntryChunk 的输出项
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
  it("输出多个 chunk 时报错：单文件产物不能静默丢掉第二个", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE }),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("输出里有 asset 时报错：单文件产物没有可以写出的 asset 位置", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("asset", "x.css"),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("只有一个 chunk 但它不是 entry 时报错", () => {
    const output = [outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE })];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /entry chunk/u);
  });

  it("entry chunk 的正文为空时报错：空产物写到磁盘后卡片不渲染，也没有任何提示", () => {
    const output = [outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: "  \n " })];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /entry chunk/u);
  });

  it("只有一个 entry chunk 时通过", () => {
    const output = [outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE })];
    const chunk = singleEntryChunk(output, "entry.ts");
    assert.equal(chunk.code, CHUNK_CODE);
  });
});
