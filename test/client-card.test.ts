// 卡片半的双语契约（本包无 jsdom/react-dom 依赖，故不渲染 DOM）：
//   1. apply 的官方 locale 接线——两语字典都注册、bind 到本包命名空间、translator 经
//      slots.register 的 payload 下发成 `t` prop（= 样板包 client-card 测试里渲染点补的 `t`）；
//   2. UI_MESSAGES 两语键集/占位符一致、值非空且互不相同；
//   3. 卡片源码里不再有任何中文字面量（注释除外）——迁移完整性的硬门禁。
/// <reference types="node" />
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import { apply, inject } from "../src/client-entry.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { LocaleNs, Translate } from "../src/ui-messages.ts";
import { patchEntryId, profileBundleName } from "./profile-bundle.ts";

/** apply 的真实宿主面（ClientCtx 未导出，从函数签名取——假 ctx 因此仍受结构类型检查）。 */
type CardCtx = Parameters<typeof apply>[0];

type Snap = ConfigFormSnapshot<Record<string, unknown>>;

/** 官方 `ConfigFormSnapshot` 的合法形状（7 位全必选）：桩件必须交得出真宿主的面，
 *  少了 `base`/`user`/`revision`/`mode` 或把 status 写成宽 `string` 都会编译失败。 */
function snap(over: Partial<Snap> = {}): Snap {
  return {
    status: "ready",
    value: { enabled: true },
    base: {},
    user: {},
    revision: 3,
    writable: true,
    mode: "host",
    ...over,
  };
}

/** 官方 locale 的 `{name}` 插值（宿主同语义）：测试里自己实现，不引宿主内部实现。 */
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
 * 官方 locale 的取值语义（测试侧复刻）：本包字典命中即用，未命中回落**键名本身**
 * （官方 `LocaleRuntime.translate` 在 active 链与 common 命名空间都 miss 后的行为，
 * installed dsh-client-locale/lib/client.js:1415-1417）。
 * 表按 `Record<string, string>` 承载而不是 `UiMessages`：merge 进 `LocaleNamespaceMap`
 * 之后 `TranslateNS<NS>` 的键域是「本包键 ∪ common 命名空间键」（官方 `LocaleKeysOf`），
 * 按 `UiMessages` 索引那条并集会在编译期红（实测
 * `Property 'back' does not exist on type 'UiMessages'`），而运行时真相就是回落。
 * 展开成字面量是为了拿到隐式索引签名（`UiMessages` 是 interface，本身给不出）。
 */
function localeText(
  dict: Record<string, string>,
  key: string,
  params: Record<string, unknown>,
): string {
  return fillTemplate(dict[key] ?? key, params);
}

/** 中日韩统一表意文字区段：判"这段文本里还有中文"。 */
const CJK = /[\u4E00-\u9FFF]/u;

/** 两语字典的 `Record<string, string>` 面：取值断言与 translator 共用同一份投影。 */
const zh: Record<string, string> = { ...UI_MESSAGES.zh };
const en: Record<string, string> = { ...UI_MESSAGES.en };

/** 中文/英文 translator：断言里的中文串因此与 i18n 迁移前完全一致。 */
const tZh: Translate = (key, params) => localeText(zh, key, params ?? {});
const tEn: Translate = (key, params) => localeText(en, key, params ?? {});

/** 模板里的 {占位符} 名字集合。 */
function placeholders(template: string): Set<string> {
  // 必须成对（{ 起、} 止）才算占位符：只按花括号切分会把 "Save" 这类无括号的整串
  // 误当成占位符。不用捕获组：prefer-named-capture-group 与 noPropertyAccessFromIndexSignature
  // 对 match.groups 的写法互斥（同仓 schema-coverage.ts 记过这个坑）。
  const out = new Set<string>();
  for (const part of template.split("{").slice(1)) {
    const name = part.split("}")[0] ?? "";
    if (/^\w+$/u.test(name)) {
      out.add(name);
    }
  }
  return out;
}

/** 两语键清单（`zh` / `en` 的 string 面投影见上面两处常量）。 */
const keys = Object.keys(UI_MESSAGES.zh);

/** 剥掉注释后的源码（整行注释 + 行尾注释；注释按约定保持中文，不参与断言）。 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        return "";
      }
      const commentStart = line.indexOf("//");
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join("\n");
}

describe("卡片双语字典（UI_MESSAGES）", () => {
  it("两语键集一致、值非空", () => {
    // toSorted 在本包 lint 的 lib 目标下不存在 → 无序比较用 Set + size/has。
    const enKeys = new Set(Object.keys(UI_MESSAGES.en));
    assert.equal(keys.length, enKeys.size, "键数必须相同");
    assert.ok(keys.length >= 20, "卡片文案全部收进字典");
    for (const key of keys) {
      assert.ok(enKeys.has(key), `en 缺键：${key}`);
      assert.ok((zh[key] ?? "").length > 0, `zh 空值：${key}`);
      assert.ok((en[key] ?? "").length > 0, `en 空值：${key}`);
    }
  });

  it("两语文案互不相同，且带变量的整行占位符名字一致", () => {
    for (const key of keys) {
      assert.notEqual(en[key], zh[key], `${key} 两语文案相同`);
      assert.deepEqual(
        placeholders(en[key] ?? ""),
        placeholders(zh[key] ?? ""),
        `${key} 占位符不一致`,
      );
    }
  });

  it("同一渲染路径换 translator 即换语言（保存条三态 + 失败整行）", () => {
    assert.equal(tZh("statusDirty"), "有未保存的修改，点「保存」生效");
    assert.equal(tEn("statusDirty"), "Unsaved changes — press Save to apply");
    assert.equal(tZh("saveFailed", { message: "boom" }), "保存失败：boom");
    assert.equal(tEn("saveFailed", { message: "boom" }), "Save failed: boom");
    assert.equal(tZh("outOfRange"), "超出允许范围，未保存");
    assert.doesNotMatch(tEn("outOfRange"), CJK);
  });

  it("卡片源码的非注释行不再有中文字面量（文案全在字典里）", () => {
    const src = fileURLToPath(new URL("../src/client-entry.ts", import.meta.url));
    assert.doesNotMatch(codeOnly(readFileSync(src, "utf8")), CJK);
  });
});

describe("卡片 apply 的官方 locale 接线", () => {
  /** 一次装载登记下来的宿主调用轨迹。 */
  interface Trace {
    /** label → effect 工厂（样式那个会碰 document，用例只跑 locale 那个）。
     *  工厂面直接取官方 `Context["effect"]` 的第一参（cordis 的 `Effect` 联合：一个
     *  disposer 或一组 disposer），不在这里重抄签名。 */
    effects: Map<string, Parameters<Context["effect"]>[0]>;
    /** 注册进官方 locale 的入参（命名空间 + 一次交齐的两语字典）。
     *  形状就是官方 `LocaleRuntime.register` 类型化重载的两个参数。 */
    registrations: {
      ns: string;
      dicts: Record<BuiltInLocaleId, LocaleDictOf<LocaleNs>>;
    }[];
    /** disposer 回收掉的 locale id（官方实现按 `Object.entries(dicts)` 逐个摘除）。 */
    disposedLocales: string[];
    /** apply 向 `configForms.get()` 要过哪些条目 id（0.1.6 的 scopeBindNs 对应物）。 */
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
    /** 表单被 dispose 的次数：0.1.7 的 `ConfigForm` 契约里没有 dispose，恒应为空。 */
    disposeCalls: number[];
    /** 官方 `ConfigForm.mutate`（路径级原子写入）的调用留痕：本卡只走 set/unset，恒应为空。 */
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
    // 本条目共享表单的假面：直接绑官方 `ConfigForm<Record<string, unknown>>`
    // （installed dsh-client-ui-settings/lib/types/client/config-form-types.d.ts:36-74），
    // 快照走同文件 `ConfigFormSnapshot`（:6-32，7 位全必选）——见上面的 snap() 工厂。
    // set/unset 回「宿主是否受理」的 boolean，只有传输失败才 reject。mutate 是官方第五位
    // （路径级原子写入），本卡不走它，但类型面要求它在位。dispose 不在契约里，留在这里
    // 只作 tripwire：卡片若再试图销毁 provider 持有的表单，disposeCalls 就会非空 → 用例红。
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
      // 只登记工厂不执行：本包无 jsdom，样式 effect 里的 document 不存在。
      // `effect` / `slots` 在 ClientCtx 里已是**官方**服务投影（cordis `Context["effect"]`
      // 与 `Pick<SlotRegistry, "inject" | "register">`），生产侧签名一漂移就红在编译期。
      // 两处不得已的显式标注：
      //  - `effect`：官方是**两**个重载（同步 `Disposable<Promise<void>>` 与可 await 的
      //    `AsyncDisposable<Promise<void>>`，后者还是 PromiseLike），单个箭头签名同时满足
      //    不了两边，故一次性投影到官方面；cordis 的入参形状一改，这个 `as` 的源类型就先红。
      //  - `register`：官方是**双重载**（`inject?: undefined` 与 `inject: (…) => I`），
      //    重载目标推不出上下文参数类型（TS7006），故按 `unknown` 收、在桩内一次性投影
      //    回本卡实际传的那一重载。
      effect: ((factory, label) => {
        trace.effects.set(label ?? "", factory);
      }) as Context["effect"],
      slots: {
        inject: (slot, factory) => {
          trace.slots.push(slot);
          // 官方 `SlotInjectionEffect`：一个 disposer 或一组 disposer（本卡是前者）。
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
        // 官方类型化重载：一次交齐两语，返回**一个**回收全部 locale 的 disposer
        // （installed dsh-client-locale/lib/client.js:1379-1405 正是这个形状）。
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

  it("inject 列出 configForms + locale；表单按条目 id 取；两语字典按命名空间注册；bind 一次；payload 下发 t", async () => {
    // configForms 取代 0.1.6 的 settingsScope（该服务在 installed 0.1.7 全树零命中，
    // 继续注入它 = 整条 client 入口挂不上）：契约源 installed
    // dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98（Context 增强）
    // 与 :142（get<T>(entryId): ConfigForm<T>）。仍是**精确全等**清单，不放宽为包含判定。
    assert.deepEqual(inject, ["slots", "configForms", "locale"], "locale 必须列进 inject");
    const { ctx, trace } = makeHost(tEn);
    apply(ctx);
    // 0.1.7 起 settings 命名空间 = profile 条目 id（本包 cordis.patch.yml 的裸
    // `quality-gate`），故 get() 的入参与旧 bind({namespace}) 的取值仍是同一个串。
    assert.deepEqual(
      trace.formEntryIds,
      [patchEntryId()],
      "只取本条目那张共享表单（裸条目 id），且只取一次",
    );
    assert.deepEqual(trace.slots, ["plugins.bundle.config"]);
    assert.equal(trace.effects.size, 2, "样式 effect + locale 字典 effect 各一个");
    // 跑 locale 那个 effect：两语字典一次性进注册表，返回的清理函数回收这一份注册。
    const localeEffect = trace.effects.get("quality-gate-card: locale dictionaries");
    assert.ok(localeEffect !== undefined, "locale 字典 effect 已登记");
    const teardown = localeEffect();
    assert.deepEqual(
      trace.registrations.map((row) => [row.ns, Object.keys(row.dicts)]),
      [["quality-gate", ["zh", "en"]]],
      "两语字典按本包命名空间一次性注册进官方 locale，且只注册一次",
    );
    assert.equal(trace.registrations[0]?.dicts.zh.cardTitle, UI_MESSAGES.zh.cardTitle);
    assert.equal(trace.registrations[0]?.dicts.en.cardTitle, UI_MESSAGES.en.cardTitle);
    assert.equal(typeof teardown, "function", "官方类型化 register 交回一个 disposer");
    if (typeof teardown === "function") {
      teardown();
    }
    assert.deepEqual(trace.disposedLocales, ["zh", "en"], "两语随那一个 disposer 一起回收");
    assert.deepEqual(trace.localeBindNs, ["quality-gate"], "bind 只调一次（稳定身份）");
    assert.ok(trace.desc !== null && trace.payload !== null, "slots.register 已调用");
    assert.equal(trace.desc.name, "plugins.bundle.config");
    // 槽位 key 与条目 id 是**两个**标识：key = profile 里那条 bundle 的包名（宿主按包名
    // 派发 plugins.bundle.config，证据链见 test/profile-bundle.ts），裸条目 id 只喂
    // configForms.get()（上面那条断言）。两侧同读真源、不抄常量，改错任何一边都炸。
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
    // 写入仍落到 configForms.get() 交回的那张表单上（set 存值 / unset 恢复默认），
    // 且 0.1.7 的受理位 Promise<boolean> **原样透传**给卡片（消费在 save()）：
    // 写通道不再 swallow——宿主拒写（false）与传输失败（reject）都必须回到卡片。
    assert.equal(await payload.set("gateBudgetMs", 30_000), true, "set 受理位透传");
    assert.equal(await payload.unset("memoryGatewayUrl"), true, "unset 受理位透传");
    assert.deepEqual(trace.setCalls, [["gateBudgetMs", 30_000]], "payload.set 必须写进本条目表单");
    assert.deepEqual(
      trace.unsetCalls,
      ["memoryGatewayUrl"],
      "payload.unset 必须清空本条目表单上的字段",
    );
    assert.deepEqual(
      trace.mutateCalls,
      [],
      "写入只用 set/unset，不碰官方 mutate（路径级原子写入是第五位，本卡不用）",
    );
    // slot 清理回调：只注销登记，**绝不 dispose 表单**——0.1.7 的 ConfigForm 契约里没有
    // dispose（installed config-form-types.d.ts:36-74），表单归 provider 长活；销毁它正是
    // 旧 settingsScope 那个「收起插件页后每次保存被静默丢弃」缺陷的来源。
    assert.equal(trace.slotCleanups.length, 1);
    trace.slotCleanups[0]?.();
    assert.deepEqual(trace.disposeCalls, [], "disposer 不得销毁 provider 持有的共享表单");
  });

  it("一次注册里的 zh / en 两份字典指向本包那两份对象（切语言 = 官方 locale 换 translator）", () => {
    const { ctx, trace } = makeHost(tZh);
    apply(ctx);
    const disposeDictionaries = trace.effects.get("quality-gate-card: locale dictionaries")?.();
    assert.ok(typeof disposeDictionaries === "function");
    disposeDictionaries();
    assert.equal(trace.registrations[0]?.dicts.zh, UI_MESSAGES.zh);
    assert.equal(trace.registrations[0]?.dicts.en, UI_MESSAGES.en);
    assert.equal((trace.payload as { t: Translate }).t("cardTitle"), UI_MESSAGES.zh.cardTitle);
  });
});
