// 卡片这边的双语契约（本包不依赖 jsdom/react-dom，所以不渲染 DOM）：
//   1. apply 怎么接上官方 locale——两种语言的文案都注册、bind 到本包命名空间、translator 经
//      slots.register 的 payload 下发成 `t` prop（和样板包 client-card 测试里渲染处补的那个 `t` 是同一个）；
//   2. UI_MESSAGES 两种语言的键集与占位符一致、值非空且互不相同；
//   3. 卡片源码里不再有任何中文字面量（注释除外）——这条门禁用来确认迁移没留尾巴。
/// <reference types="node" />
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import { z } from "zod";
import { apply, inject, CARD_NUMBER_SCHEMAS, projectCardValues } from "../src/client-entry.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { LocaleNs, Translate } from "../src/ui-messages.ts";
import { patchEntryId, profileBundleName } from "./profile-bundle.ts";

/** apply 真正需要的宿主类型（ClientCtx 没有导出，从函数签名取——这样假 ctx 仍然受结构类型检查）。 */
type CardCtx = Parameters<typeof apply>[0];

type Snap = ConfigFormSnapshot<Record<string, unknown>>;

/** 官方 `ConfigFormSnapshot` 的形状（六个字段全部必选）：测试替身必须交出真实宿主需要的字段，
 *  少了 `base`/`user`/`revision`/`mode` 或把 status 写成宽 `string` 都会编译失败。 */
function snap(over: Partial<Snap> = {}): Snap {
  return {
    status: "ready",
    value: { enabled: true },
    base: {},
    user: {},
    revision: 3,
    writable: true,
    ...over,
  };
}

/** 官方 locale 的 `{name}` 插值（宿主是同一个语义）：测试里自己实现一份，不去引宿主内部的实现。 */
function fillTemplate(text: string, params: Record<string, unknown>): string {
  return text.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    if (typeof value === "number") {
      return String(value);
    }
    return typeof value === "string" ? value : "";
  });
}

/**
 * 官方 locale 的取值语义（在测试侧复刻一份）：本包文案命中就用，未命中回落到**键名本身**
 * （官方 `LocaleRuntime.translate` 在 active 链和 common 命名空间都没命中时就是这样）。
 * 表按 `Record<string, string>` 承载而不是 `UiMessages`：merge 进 `LocaleNamespaceMap`
 * 之后 `TranslateNS<NS>` 允许的键是「本包的键 ∪ common 命名空间的键」（官方 `LocaleKeysOf`），
 * 用 `UiMessages` 去索引那个并集会在编译期报错（实测
 * `Property 'back' does not exist on type 'UiMessages'`），而运行时的行为就是回落。
 * 展开成字面量是为了拿到隐式索引签名（`UiMessages` 是 interface，本身给不出）。
 */
function localeText(
  dict: Record<string, string>,
  key: string,
  params: Record<string, unknown>,
): string {
  return fillTemplate(dict[key] ?? key, params);
}

/** 中日韩文字（含扩展 A / 兼容区）+ CJK 标点 + 全角符号：用来判断"这段文本里还有中文"。
 *  只覆盖 U+4E00–U+9FFF 会放行中文标点（：、。「」）、全角符号（！？）和扩展区的生僻字。 */
const CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6]/u;

/** locale 文案 effect 登记时用的 label：必须和 src/client-entry.ts 里传的第二个参数一致。 */
const LOCALE_EFFECT_LABEL = "quality-gate-card: locale dictionaries";

/** 网关地址的样例值：同一个字面量在断言的输入和期望里各出现一次，会被检查重复字符串的规则点名。 */
const GATEWAY_URL = "http://127.0.0.1:8420";

/** 两种语言文案的 `Record<string, string>` 形式：取值的断言和 translator 用的是同一份。 */
const zh: Record<string, string> = { ...UI_MESSAGES.zh };
const en: Record<string, string> = { ...UI_MESSAGES.en };

/** 中文/英文的 translator：这样断言里写的中文串和多语言迁移之前完全一致。 */
const tZh: Translate = (key, params) => localeText(zh, key, params ?? {});
const tEn: Translate = (key, params) => localeText(en, key, params ?? {});

/** 模板里 {占位符} 的名字集合。 */
function placeholders(template: string): Set<string> {
  // 必须成对（{ 起、} 止）才算占位符：只按花括号切分会把 "Save" 这类没有括号的整串
  // 误当成占位符。这里不用捕获组：prefer-named-capture-group 和 noPropertyAccessFromIndexSignature
  // 对 match.groups 的写法要求互相冲突（同一个坑在 schema-coverage.ts 里写过）。
  const out = new Set<string>();
  for (const part of template.split("{").slice(1)) {
    const name = part.split("}")[0] ?? "";
    if (/^\w+$/u.test(name)) {
      out.add(name);
    }
  }
  return out;
}

/** 两种语言的键列表（上面 zh / en 两个常量给出了它们的 string 形式）。 */
const keys = Object.keys(UI_MESSAGES.zh);

/**
 * 可能是注释或字面量的片段：块注释、行注释、三种引号的字面量（含转义）。
 *
 * 一次扫完全文，字符串整体被收进 token，于是本仓的
 * `placeholder: "http://127.0.0.1:8420"` 里的双斜杠不会被当成注释起点——按行
 * `indexOf("//")` 的做法会把同一行后半段一起切掉，断言从此看不见那半行里的中文字面量。
 */
const COMMENT_TOKEN =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gu;

/**
 * 剥掉注释后的源码（注释按约定保持中文，不参与断言）。
 *
 * 必须按字面量感知来剥：行内块注释里的中文也要被剥掉（旧写法只认行首的块注释开符号，
 * 那会把行内块注释里的中文误判成字面量，报出不该报的失败），字符串里的双斜杠要留在原地
 * （否则该报的失败报不出来）。
 */
function codeOnly(source: string): string {
  return source.replaceAll(COMMENT_TOKEN, (token) =>
    token.startsWith("//") || token.startsWith("/*") ? "" : token,
  );
}

describe("卡片的双语文案（UI_MESSAGES）", () => {
  it("两种语言的键一致、值非空", () => {
    // toSorted 在本包 lint 的 lib 目标下不存在 → 不比较顺序，用 Set + size/has。
    const enKeys = new Set(Object.keys(UI_MESSAGES.en));
    assert.equal(keys.length, enKeys.size, "键数必须相同");
    assert.ok(keys.length >= 20, "卡片文案全部收进两种语言的文案表");
    for (const key of keys) {
      assert.ok(enKeys.has(key), `en 缺键：${key}`);
      assert.ok((zh[key] ?? "").length > 0, `zh 空值：${key}`);
      assert.ok((en[key] ?? "").length > 0, `en 空值：${key}`);
    }
  });

  it("两种语言的文案互不相同，且带变量的整句里占位符名字一致", () => {
    for (const key of keys) {
      assert.notEqual(en[key], zh[key], `${key} 两种语言的文案相同`);
      assert.deepEqual(
        placeholders(en[key] ?? ""),
        placeholders(zh[key] ?? ""),
        `${key} 占位符不一致`,
      );
    }
  });

  it("同一条渲染路径换上别的 translator 就换成另一种语言（状态条与失败提示）", () => {
    assert.equal(tZh("statusClean"), "无未保存的修改");
    assert.equal(tEn("statusClean"), "No unsaved changes");
    assert.equal(tZh("saveFailed", { message: "boom" }), "保存失败：boom");
    assert.equal(tEn("saveFailed", { message: "boom" }), "Save failed: boom");
    assert.equal(tZh("outOfRange"), "超出允许范围，未保存");
    assert.doesNotMatch(tEn("outOfRange"), CJK);
  });

  it("client-entry.ts 的非注释行没有中文字面量（本仓卡片源码只有这一份，文案在 ui-messages.ts）", () => {
    const src = fileURLToPath(new URL("../src/client-entry.ts", import.meta.url));
    assert.doesNotMatch(codeOnly(readFileSync(src, "utf8")), CJK);
  });

  it("剥注释这一步自身：字符串里的双斜杠不算注释起点（否则同一行后半段被切掉，断言就看不见它）", () => {
    // 本仓 client-entry.ts 就有 placeholder: "http://127.0.0.1:8420"：按行 indexOf 找双斜杠
    // 会从那里截断，同一行后面的内容（包括真正该拦住的中文文字面量）整段消失。
    const source = 'const a = "http://127.0.0.1:8420"; const b = "中文";\n';
    assert.match(codeOnly(source), /"中文"/u);
  });

  it("剥注释这一步自身：行尾注释和行内块注释都要剥掉（注释里的中文不算违规）", () => {
    const source = "const a = 1; // 中文注释\nconst b = 2 /* 中文块注释 */ + 3;\n";
    assert.doesNotMatch(codeOnly(source), CJK);
  });
});

describe("卡片取值的 zod 区间", () => {
  it("数值字段按 host schema 的闭区间取整数：边界接受，越界和小数变成未设置", () => {
    assert.equal(projectCardValues({ maxInjectsPerTurn: 1 }).maxInjectsPerTurn, 1);
    assert.equal(projectCardValues({ maxInjectsPerTurn: 5 }).maxInjectsPerTurn, 5);
    assert.equal(projectCardValues({ maxInjectsPerTurn: 6 }).maxInjectsPerTurn, undefined);
    assert.equal(projectCardValues({ maxInjectsPerTurn: 1.5 }).maxInjectsPerTurn, undefined);
    assert.equal(projectCardValues({ gateBudgetMs: 10_000 }).gateBudgetMs, 10_000);
    assert.equal(projectCardValues({ gateBudgetMs: 600_000 }).gateBudgetMs, 600_000);
    assert.equal(projectCardValues({ gateBudgetMs: 9999 }).gateBudgetMs, undefined);
    assert.equal(projectCardValues({ gateBudgetMs: 600_001 }).gateBudgetMs, undefined);
  });

  it("区间同时能从 schema 元数据与 JSON Schema 读出", () => {
    const injects = CARD_NUMBER_SCHEMAS.maxInjectsPerTurn;
    const budget = CARD_NUMBER_SCHEMAS.gateBudgetMs;
    assert.equal(injects.minValue, 1);
    assert.equal(injects.maxValue, 5);
    assert.equal(budget.minValue, 10_000);
    assert.equal(budget.maxValue, 600_000);
    const injectsJson = z.toJSONSchema(injects);
    assert.equal(injectsJson.minimum, 1);
    assert.equal(injectsJson.maximum, 5);
    const budgetJson = z.toJSONSchema(budget);
    assert.equal(budgetJson.minimum, 10_000);
    assert.equal(budgetJson.maximum, 600_000);
  });

  it("网关地址按 URL 判断：接受 http(s) 与本地回环，缺 scheme 或别的协议算作未设置", () => {
    assert.equal(
      projectCardValues({ memoryGatewayUrl: GATEWAY_URL }).memoryGatewayUrl,
      GATEWAY_URL,
    );
    assert.equal(
      projectCardValues({ memoryGatewayUrl: "https://example.com/gateway" }).memoryGatewayUrl,
      "https://example.com/gateway",
    );
    assert.equal(
      projectCardValues({ memoryGatewayUrl: "127.0.0.1:8420" }).memoryGatewayUrl,
      undefined,
    );
    assert.equal(
      projectCardValues({ memoryGatewayUrl: "ftp://example.com" }).memoryGatewayUrl,
      undefined,
    );
    assert.equal(
      projectCardValues({ memoryGatewayUrl: "https://user:pass@example.com" }).memoryGatewayUrl,
      undefined,
      "带 userinfo 的地址不算已配置",
    );
    assert.equal(
      projectCardValues({ memoryGatewayUrl: "http://192.168.1.10:8420" }).memoryGatewayUrl,
      undefined,
      "远端明文 http 不算已配置",
    );
  });

  it("一个字段越界不影响同一份快照里的其余字段", () => {
    const values = projectCardValues({
      maxInjectsPerTurn: 99,
      enabled: true,
      memoryGatewayUrl: GATEWAY_URL,
    });
    assert.equal(values.maxInjectsPerTurn, undefined, "越界的数值只影响自己这一项");
    assert.equal(values.enabled, true, "同一份快照里的布尔字段不受影响");
    assert.equal(values.memoryGatewayUrl, GATEWAY_URL, "同一份快照里的字符串字段不受影响");
  });
});

describe("卡片 apply 怎么接上官方 locale", () => {
  /** 一次装载记录下来的宿主调用轨迹。 */
  interface Trace {
    /** label → effect 工厂（样式那个会读 document，用例只跑 locale 那个）。
     *  类型直接取官方 `Context["effect"]` 的第一个参数（cordis 的 `Effect` 联合：一个
     *  disposer 或一组 disposer），不在这里重抄签名。 */
    effects: Map<string, Parameters<Context["effect"]>[0]>;
    /** 注册进官方 locale 的入参（命名空间 + 一次交齐的两种语言文案）。
     *  形状就是官方 `LocaleRuntime.register` 带类型那个重载的两个参数。 */
    registrations: {
      ns: string;
      dicts: Record<BuiltInLocaleId, LocaleDictOf<LocaleNs>>;
    }[];
    /** disposer 回收掉的 locale id（官方实现按 `Object.entries(dicts)` 逐个摘除）。 */
    disposedLocales: string[];
    /** apply 向 `configForms.get()` 要过哪些条目 id（对应 0.1.6 里的 scopeBindNs）。 */
    formEntryIds: string[];
    /** 卡片写入落到表单上的 (field, value) 序列。 */
    setCalls: [string, unknown][];
    unsetCalls: string[];
    localeBindNs: string[];
    slots: string[];
    slotCleanups: (() => void)[];
    desc: { name: string; key: string | undefined } | null;
    payload: Record<string, unknown> | null;
    view: unknown;
    /** 表单被 dispose 的次数：0.1.7 的 `ConfigForm` 声明里没有 dispose，所以这里应该一直是空的。 */
    disposeCalls: number[];
    /** 官方 `ConfigForm.mutate`（按路径原子写入）的调用记录：这张卡只用 set/unset，应该一直是空的。 */
    mutateCalls: unknown[][];
  }

  function makeHost(t: Translate): { ctx: CardCtx; trace: Trace } {
    const trace: Trace = {
      effects: new Map(),
      registrations: [],
      disposedLocales: [],
      formEntryIds: [],
      setCalls: [],
      unsetCalls: [],
      localeBindNs: [],
      slots: [],
      slotCleanups: [],
      desc: null,
      payload: null,
      view: null,
      disposeCalls: [],
      mutateCalls: [],
    };
    // 本条目共享表单的测试替身：直接按官方 `ConfigForm<Record<string, unknown>>` 写
    // （dsh-client-ui-settings 的 config-form-types.d.ts 里那个 ConfigForm），
    // 快照用同一个文件的 `ConfigFormSnapshot`（六个字段全部必选）——见上面的 snap()。
    // set/unset 返回「宿主是否受理」这个 boolean，只有传输失败才 reject。mutate 是官方第五个方法
    // （按路径原子写入），这张卡不走它，但类型要求它在位。dispose 不在官方声明里，留在这里
    // 只是为了把行为暴露出来：卡片若再试图销毁 provider 持有的表单，disposeCalls 就会非空，
    // 用例当场失败。
    const scope = {
      getSnapshot: () => snap(),
      subscribe: () => () => {
        void 0;
      },
      set: (field: string, value: unknown) => {
        trace.setCalls.push([field, value]);
        return Promise.resolve(true);
      },
      unset: (field: string) => {
        trace.unsetCalls.push(field);
        return Promise.resolve(true);
      },
      mutate: async (ops: readonly unknown[]) => {
        trace.mutateCalls.push([...ops]);
        return true;
      },
      dispose: () => {
        trace.disposeCalls.push(1);
        return Promise.resolve();
      },
    };
    const ctx: CardCtx = {
      // 只登记工厂不执行：本包没有 jsdom，样式 effect 里读的 document 不存在。
      // `effect` / `slots` 在 ClientCtx 里已经是官方服务的类型投影（cordis `Context["effect"]`
      // 与 `Pick<SlotRegistry, "inject" | "register">`），真实实现一改签名就会在编译期报错。
      // 两处不得不显式标注：
      //  - `effect`：官方有**两**个重载（同步的 `Disposable<Promise<void>>` 与可以 await 的
      //    `AsyncDisposable<Promise<void>>`，后者还是 PromiseLike），单个箭头的签名同时满足
      //    不了两边，所以一次性投影到官方的类型上；cordis 的入参形状一改，这个 `as` 的源类型就先报错。
      //  - `register`：官方是**两个重载**（`inject?: undefined` 与 `inject: (…) => I`），
      //    从重载目标推不出上下文参数类型（TS7006），所以按 `unknown` 收、在替身里一次性投影
      //    回这张卡实际传的那个重载。
      effect: ((factory, label) => {
        trace.effects.set(label ?? "", factory);
      }) as Context["effect"],
      slots: {
        inject: (slot, factory) => {
          trace.slots.push(slot);
          // 官方 `SlotInjectionEffect`：一个 disposer 或一组 disposer（这张卡是前者）。
          const teardown = factory();
          if (typeof teardown === "function") {
            trace.slotCleanups.push(teardown);
          }
          return () => {
            void 0;
          };
        },
        register: (options: unknown, component: unknown): (() => void) => {
          const desc = options as {
            name: string;
            key?: string;
            inject: () => Record<string, unknown>;
          };
          trace.desc = { name: desc.name, key: desc.key };
          trace.payload = desc.inject();
          trace.view = component;
          return () => {
            void 0;
          };
        },
      },
      configForms: {
        get: (entryId) => {
          trace.formEntryIds.push(entryId);
          return scope;
        },
      },
      locale: {
        // 官方带类型的重载：一次交齐两种语言，返回**一个**能把这些 locale 全部回收的 disposer
        // （dsh-client-locale 的 client.js 里 LocaleRuntime.register 正是这个形状）。
        register: (ns, dicts) => {
          trace.registrations.push({ ns, dicts });
          return () => {
            trace.disposedLocales.push(...Object.keys(dicts));
          };
        },
        bind: (ns) => {
          trace.localeBindNs.push(ns);
          return t;
        },
      },
    };
    return { ctx, trace };
  }

  it("inject 列出 configForms + locale；表单按条目 id 取；两种语言的文案按命名空间注册；bind 一次；payload 下发 t", async () => {
    // configForms 取代 0.1.6 的 settingsScope（那个服务在 0.1.7 的已安装树里已经找不到，
    // 继续注入它等于整条 client 入口装载不上）。声明来源是 dsh-client-ui-settings 的
    // config-form.d.ts：它对 Context 的增强里有 `get<T>(entryId): ConfigForm<T>`。
    // 这里仍然要求数组精确相等，不放宽成「包含即可」。
    assert.deepEqual(inject, ["slots", "configForms", "locale"], "locale 必须列进 inject");
    const { ctx, trace } = makeHost(tEn);
    apply(ctx);
    // 0.1.7 起 settings 的命名空间就是 profile 条目 id（本包 cordis.patch.yml 里那行的条目 id
    // `quality-gate`），所以 get() 的入参和旧 bind({namespace}) 的取值仍是同一个字符串。
    assert.deepEqual(
      trace.formEntryIds,
      [patchEntryId()],
      "只取本条目那张共享表单（裸条目 id），且只取一次",
    );
    assert.deepEqual(trace.slots, ["plugins.bundle.config"]);
    // 只按 label 断言本包关心的 effect 存在，不按 effect 总数设限：新增样式或清理用的 effect 是允许的。
    const localeEffect = trace.effects.get(LOCALE_EFFECT_LABEL);
    assert.ok(localeEffect !== undefined, "locale 文案的 effect 已登记");
    const teardown = localeEffect();
    assert.deepEqual(
      trace.registrations.map((row) => [row.ns, Object.keys(row.dicts)]),
      [["quality-gate", ["zh", "en"]]],
      "两种语言的文案按本包命名空间一次性注册进官方 locale，且只注册一次",
    );
    assert.equal(trace.registrations[0]?.dicts.zh.statusClean, UI_MESSAGES.zh.statusClean);
    assert.equal(trace.registrations[0]?.dicts.en.statusClean, UI_MESSAGES.en.statusClean);
    assert.equal(typeof teardown, "function", "官方带类型的 register 返回一个 disposer");
    if (typeof teardown === "function") {
      teardown();
    }
    assert.deepEqual(trace.disposedLocales, ["zh", "en"], "两种语言随那一个 disposer 一起回收");
    assert.deepEqual(
      trace.localeBindNs,
      ["quality-gate"],
      "bind 只调一次（translator 的身份保持稳定）",
    );
    assert.ok(trace.desc !== null && trace.payload !== null, "slots.register 已调用");
    assert.equal(trace.desc.name, "plugins.bundle.config");
    // 登记时收到的第二个参数就是卡片本体：传 undefined 或参数错位时，槽位里没有可渲染的组件。
    assert.equal(typeof trace.view, "function", "卡片组件必须交给 slots.register");
    // 槽位 key 与条目 id 是**两个**标识：key = profile 里那条 bundle 的包名（宿主按包名
    // 派发 plugins.bundle.config，证据链见 test/profile-bundle.ts），裸条目 id 只喂
    // configForms.get()（上面那条断言）。两处都去各自的来源读、不抄常量，改错任何一边都会失败。
    assert.notEqual(
      profileBundleName(),
      patchEntryId(),
      "bundle 包名与裸条目 id 同名 → 钉不住混用",
    );
    assert.equal(
      trace.desc.key,
      profileBundleName(),
      "槽位按 bundle 包名 keyed，写成裸条目 id 就永不出卡",
    );
    const payload = trace.payload as {
      t: Translate;
      hooks: { card: unknown };
      set: (field: string, value: unknown) => Promise<boolean>;
      unset: (field: string) => Promise<boolean>;
    };
    assert.equal(payload.t, tEn, "bind 出的 translator 经 payload 下发成 t prop");
    assert.notEqual(payload.hooks.card, undefined, "hooks.card 仍在");
    // 写入仍然落到 configForms.get() 返回的那张表单上（set 存值 / unset 恢复默认），
    // 且 0.1.7 返回的 Promise<boolean> 原样传给卡片（由 save() 使用）：
    // 写入这条路径不再忽略返回值——宿主拒写（false）与传输失败（reject）都必须回到卡片。
    assert.equal(await payload.set("gateBudgetMs", 30_000), true, "set 的返回值原样传给卡片");
    assert.equal(await payload.unset("memoryGatewayUrl"), true, "unset 的返回值原样传给卡片");
    assert.deepEqual(trace.setCalls, [["gateBudgetMs", 30_000]], "payload.set 必须写进本条目表单");
    assert.deepEqual(
      trace.unsetCalls,
      ["memoryGatewayUrl"],
      "payload.unset 必须清空本条目表单上的字段",
    );
    assert.deepEqual(
      trace.mutateCalls,
      [],
      "写入只用 set/unset，不用官方 mutate（按路径原子写入的那个第五个方法，这张卡用不上）",
    );
    // slot 的清理回调：只注销登记，**绝不 dispose 表单**——0.1.7 的 ConfigForm 声明里没有
    // dispose（见 config-form-types.d.ts 的 ConfigForm），表单归 provider 长期持有；销毁它正是
    // 旧 settingsScope 那个「收起插件页后每次保存都被静默丢掉」的缺陷来源。
    assert.equal(trace.slotCleanups.length, 1);
    trace.slotCleanups[0]?.();
    assert.deepEqual(trace.disposeCalls, [], "disposer 不得销毁 provider 持有的共享表单");
  });

  it("一次注册里的 zh / en 两份文案指向本包那两份对象（切语言 = 官方 locale 换 translator）", () => {
    const { ctx, trace } = makeHost(tZh);
    apply(ctx);
    const disposeDictionaries = trace.effects.get(LOCALE_EFFECT_LABEL)?.();
    assert.ok(typeof disposeDictionaries === "function");
    disposeDictionaries();
    assert.equal(trace.registrations[0]?.dicts.zh, UI_MESSAGES.zh);
    assert.equal(trace.registrations[0]?.dicts.en, UI_MESSAGES.en);
    assert.equal((trace.payload as { t: Translate }).t("statusClean"), UI_MESSAGES.zh.statusClean);
  });
});
