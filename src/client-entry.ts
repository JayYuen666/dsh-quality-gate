// quality-gate client 半：设置卡（1 总开关 + 2 数字字段：注入配额 / 门禁预算
// + 记忆反馈三项：开关 / 网关地址 / 密钥引用）。
// 参照 zvec-grep / session-rescue 的卡片模式：keyed plugins.bundle.config 槽，
// React 由模块系统提供（rolldown external），只用 createElement。

import { createElement, useState } from "react";
import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
// 槽位契约的所有权在属主包：`plugins.bundle.config` 由 plugin-manager 通过
// `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }` 交出
// （installed `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:8-10`，
// 文件头明写「A registrant merges this contract with `import type` and registers
// through `ctx.slots`; it never imports this package at runtime」；那份 merge 在 :83）。
// 没有那份 merge 时，`ctx.slots.inject("plugins.bundle.config", …)` 的槽位名
// 一直只是个自由 `string`，拼错了编译器不说话。抄一次就多一处漂移点，而属主的 dts 现在是
// 本包 devDependency，编译器可以替我们对表。
// 这里取 `ConfigPageForm` 是**一举两得**：既是把那份 merge 载入 program 的入口（TS 会
// 顺着 `./client` 的再导出走到 slot-contract.ts），也是本卡渲染视模型两个状态位的真源
// （见下面 CardSnapshot）。lint 的 `require-module-specifiers` 禁空 import specifier，
// 正合本意——载入官方契约就该同时*用上*它。
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { z } from "zod";
import { diffTouched } from "@jayyuen66/dsh-plugin-shared/lib/card-diff";
import {
  CARD_UI_CSS,
  CardForm,
  NumberField,
  SaveBar,
  Section,
  TextField,
  ToggleField,
  splitHint,
} from "@jayyuen66/dsh-plugin-shared/lib/card-ui";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate } from "./ui-messages.ts";

const NS: LocaleNs = "quality-gate";

// ⚠ 两个**不同**的标识，别混用（混用过的形状：卡片打不开 / 保存写进别的条目）：
//  - `NS` = loader 条目 id = settings 命名空间 = `configForms.get(NS)` 的入参，
//    真源是本包 cordis.patch.yml 的裸 `- id:`（宿主读 `entry.options.id`）。
//  - 下面这个常量 = 本包在 profile 里那条 bundle 的**包名**，只当槽位 key 用。
// `plugins.bundle.config` 是按 bundle 包名 keyed 的槽位：宿主把注册项的 key 与
// bundle 包名精确相等匹配后才渲染（installed
// dsh-client-ui-plugin-manager/lib/client.js:2907 的
// `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })` →
// dsh-client-ui-renderer/lib/client.js:1179 的 `e.options.key === opts?.entryKey`；
// 同文件 :3979 的 `configured: ledger.bundles.has(openPkg.name)` 读的就是这批 key），
// 契约文本 installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:112-116
// （"keyed by the bundle's package name"）。
// 写成裸条目 id（`quality-gate`）时 ledger 里没有这个键 → 插件页永不出卡。
// 包名真源：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`；
// test/profile-bundle.ts 把真源读进测试，test/build-client.test.ts 的漂移针据此钉。
const BUNDLE_PKG = "@jayyuen66/dsh-quality-gate";

/** 客户端配置面直接取官方声明：`@deepseek-ai/dsh-client-ui-settings/client` 交出的
 *  `ConfigForm<T>`（getSnapshot / subscribe / mutate / set / unset）与其快照
 *  `ConfigFormSnapshot<T>`（installed `lib/types/client/config-form-types.d.ts:6-29`，
 *  `ConfigForm` 在 `:33-71`）。
 *  手抄一份 `getSnapshot: () => unknown` 的话，快照字段就得靠 fieldOf 逐位再解析一遍
 *  ——那个解析器只是丢失类型的补救，不是宿主契约（宿主侧 provider 会 decode/derive）。
 *  ⚠ 官方 `configForms.get(entryId)` 返回的表单**没有 dispose()**（表单归 provider 持有），
 *  且 `set`/`unset` 多了受理位：true=宿主受理，false=拒绝或被跳过，只有传输失败才 reject。
 *  本卡失败面仍以 Promise 拒绝为准，受理位即弃（只换类型源，不改行为）。 */
export type EntryForm = ConfigForm<Record<string, unknown>>;

/**
 * 官方 `LocaleRuntime.register` 类型化重载的字典参数，取在本包命名空间上：
 * `Record<BuiltInLocaleId, LocaleDictOf<'quality-gate'>>`——两语（官方 `BuiltInLocaleId`
 * = `"zh" | "en"`，installed `dsh-client-locale/lib/types/locale-settings.d.ts:10-12`）
 * 必须齐、每语的键集必须等于 `UiMessages`，都由官方表达式给出。
 */
export type LocaleCatalog = Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>;

/** 本卡自己的渲染视模型（官方快照的有用子集 + 兜底值）。
 *  `status`/`writable` 两位不再手写联合/裸布尔：它们取自属主包交给配置页的那份官方状态
 *  （`ConfigPageForm['state']`，installed `dsh-client-ui-plugin-manager/lib/types/client/
 *  slot-contract.d.ts:166-168`，其类型就是官方 `ConfigFormSnapshot<Record<string, unknown>>`
 *  的再投影）。宿主把 status 的取值域或 writable 的必选性一改，这里当场红。
 *  两者都满足才允许写，故保持**必选**，不用可选位假装它们会缺；`value` 是本卡的兜底
 *  收窄（官方 `value: T | undefined` → 首个快照受理前落成空对象供渲染）。 */
interface CardSnapshot extends Pick<ConfigPageForm["state"], "status" | "writable"> {
  value: Record<string, unknown>;
}

/**
 * 两个数值字段的闭区间只写在 zod schema 上：host schema（`Schema.natural().min/max`）
 * 与卡片输入框都从这里取。zod 4.6 的 `.minValue`/`.maxValue` 直接读出折叠后的边界，
 * `NumberField` 的 `min/max` 因此不再另抄一份数字。
 */
const MAX_INJECTS_VALUE = z.int().min(1).max(5);
const GATE_BUDGET_MS_VALUE = z.int().min(10_000).max(600_000);

/** 把 zod 折叠后的显式边界摊成可选 props（null = 该方向没声明，不伪造一个上限）。 */
function boundsOf(schema: z.ZodNumber): { readonly min?: number; readonly max?: number } {
  const bounds: { min?: number; max?: number } = {};
  if (schema.minValue !== null) {
    bounds.min = schema.minValue;
  }
  if (schema.maxValue !== null) {
    bounds.max = schema.maxValue;
  }
  return bounds;
}

const MAX_INJECTS_BOUNDS = boundsOf(MAX_INJECTS_VALUE);
const GATE_BUDGET_MS_BOUNDS = boundsOf(GATE_BUDGET_MS_VALUE);

/** 两个数值 schema 的对外投影：测试用 `.minValue`/`.maxValue` 与 `z.toJSONSchema` 钉边界。 */
export const CARD_NUMBER_SCHEMAS = {
  maxInjectsPerTurn: MAX_INJECTS_VALUE,
  gateBudgetMs: GATE_BUDGET_MS_VALUE,
} as const;

/** 可选整数：越界/小数/非有限值折成 undefined，只丢那一格而不是整份快照。
 *  `.validate()` 只回答合法性、不建 ZodError，失败路径比 `.safeParse().success` 短。
 *  不引 `z.compile`：编译器给客户端 bundle 增约 28 KB，且 CSP 环境会拒绝 `new Function`；
 *  卡片每帧只解析一枚快照对象，收益抵不上这两条代价。 */
const MAX_INJECTS_SCHEMA = z.preprocess(
  (value) => (typeof value === "number" && MAX_INJECTS_VALUE.validate(value) ? value : undefined),
  MAX_INJECTS_VALUE.optional(),
);
const GATE_BUDGET_MS_SCHEMA = z.preprocess(
  (value) =>
    typeof value === "number" && GATE_BUDGET_MS_VALUE.validate(value) ? value : undefined,
  GATE_BUDGET_MS_VALUE.optional(),
);

/** 卡片可编辑字段的值面。逐字段先把错误类型折成 undefined：宿主给了坏形状时只丢掉
 *  那一格，其余字段照常渲染；整份快照不是对象时才整体回落到空表。 */
const optionalBoolean = z.preprocess(
  (value) => (typeof value === "boolean" ? value : undefined),
  z.boolean().optional(),
);
const optionalString = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z.string().optional(),
);

/** 网关地址是 HTTP(S) URL；空串与坏文本折成未设置。本地回环/端口由 `z.url` 放行。 */
const HTTP_URL_SCHEMA = z.url({ protocol: /^https?$/u });
const optionalHttpUrl = z.preprocess((value: unknown): string | undefined => {
  let text: string | undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      text = trimmed;
    }
  }
  return text;
}, HTTP_URL_SCHEMA.optional());
const CARD_VALUES = z.object({
  enabled: optionalBoolean,
  maxInjectsPerTurn: MAX_INJECTS_SCHEMA,
  gateBudgetMs: GATE_BUDGET_MS_SCHEMA,
  memoryFeedback: optionalBoolean,
  memoryGatewayUrl: optionalHttpUrl,
  memoryGatewayKeyRef: optionalString,
});
export type CardValues = z.infer<typeof CARD_VALUES>;
type CardField = keyof CardValues;
/** 草稿面仍按宽 string 读：`TextField` 没有 invalid 态，URL 收口只放在快照投影上，
 *  用户输入中的半截地址不会被当场折成空串。 */
const CARD_FIELD_SCHEMAS: { readonly [Field in CardField]: z.ZodType<CardValues[Field]> } = {
  enabled: optionalBoolean,
  maxInjectsPerTurn: MAX_INJECTS_SCHEMA,
  gateBudgetMs: GATE_BUDGET_MS_SCHEMA,
  memoryFeedback: optionalBoolean,
  memoryGatewayUrl: optionalString,
  memoryGatewayKeyRef: optionalString,
};

/** 快照值投影：整份一次解析；每个字段的坏形状与越界值各自折成 undefined，其余字段照常渲染。 */
export function projectCardValues(raw: Record<string, unknown>): CardValues {
  const parsed = CARD_VALUES.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** save() 落到表单上需要的全部依赖：写通道（含 0.1.7 受理位）+ 本回合的 touched 快照 +
 *  三个状态位的 setter（React 的 setState 身份稳定，逐次渲染传同一引用）。 */
export interface SaveChannels {
  t: Translate;
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
  /** touched 与快照的差异键（save 起步时定的一次快照）。 */
  keys: readonly string[];
  touched: Record<string, unknown>;
  setBusy: (busy: boolean) => void;
  setSaveError: (error: string | null) => void;
  /** 按 updater 改写 touched：要按「此刻的」草稿层决定保留哪些键，取值不能是 save 起步时的旧快照。 */
  setTouched: (update: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
}

/** 值语义相等（与 shared 的 diffTouched 同口径）：表单值是标量与数组，引用相等会把等值数组判成改动。 */
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * 逐键 await 写入并**消费受理位**（0.1.7 的 set/unset 回 Promise<boolean>：
 * true=宿主受理；false=拒绝或写入被跳过（官方语义："refuses stale revisions"；
 * 传输失败才 reject）。false 或 rejection 都**不清 touched**——否则宿主拒写时
 * 卡片仍显示"已保存"，用户修改被静默丢弃。
 *
 * 成功后也只清**本次真正写下的那些键**：保存期间只有保存按钮被禁用，输入框仍可编辑，
 * 期间产生的新改动若一并清掉就是静默丢失。这里的判据是「当前草稿值仍等于本次快照值」——
 * 相等说明这条已落到宿主、可以从草稿层移除；不等说明用户又改过，保留下来重新变脏。
 */
async function writeTouched(channels: SaveChannels): Promise<void> {
  const { t, set, unset, keys, touched, setBusy, setSaveError, setTouched } = channels;
  try {
    for (const key of keys) {
      const val = touched[key];
      // 有意串行（非 Promise.all）：首个被拒（false/reject）即停——后面的字段
      // 不再写，touched 保留全部未落盘修改，避免"一半已写一半没写"的模糊态。
      // oxlint-disable-next-line no-await-in-loop -- 压掉本行 await 的"改 Promise.all 并行"判据：串行逐键写是宿主契约（宿主的受理位），并行批会在首个拒写后继续落后续键，造出半写状态；按规则建议改写必然弱化 fail-closed 语义。
      const accepted = await (val === undefined ? unset(key) : set(key, val));
      // !accepted 按"拒绝"收口（fail-closed）：受理位缺失/畸形时宁可保留改动多报
      // 一次错，也不静默清 touched 把用户修改丢掉。
      if (!accepted) {
        setBusy(false);
        setSaveError(t("saveRejected"));
        return;
      }
    }
    setBusy(false);
    setTouched((prev) => {
      // 只保留「本次没写下的键」：写入期间只有保存按钮被禁用，输入框仍可编辑，
      // 期间产生的新改动若一并清掉就是静默丢失。
      const next: Record<string, unknown> = {};
      for (const [key, now] of Object.entries(prev)) {
        const written = keys.includes(key) && sameValue(now, touched[key]);
        if (!written) {
          next[key] = now;
        }
      }
      return next;
    });
  } catch (error) {
    console.error("[quality-gate] save write failed:", error);
    setBusy(false);
    setSaveError(
      t("saveFailed", { message: String(error instanceof Error ? error.message : error) }),
    );
  }
}

interface SectionInputs {
  /** 取文案（官方 ctx.locale.bind 的结果）。 */
  t: Translate;
  writable: boolean;
  /** 渲染取值：touched 优先，快照兜底。 */
  eff: <Field extends CardField>(field: Field) => CardValues[Field];
  setField: (field: CardField, value: unknown) => void;
}

/** 门禁小节：总开关 + 注入配额 + 预算（毫秒按秒显示）。 */
function buildGateSection(props: SectionInputs): ReactNode {
  const { t, writable, eff, setField } = props;
  const maxInjects = eff("maxInjectsPerTurn");
  const budgetMs = eff("gateBudgetMs");
  const budgetSeconds = budgetMs === undefined ? undefined : budgetMs / 1000;
  const budgetMinSeconds = (GATE_BUDGET_MS_BOUNDS.min ?? 0) / 1000;
  const budgetMaxSeconds = (GATE_BUDGET_MS_BOUNDS.max ?? 0) / 1000;
  const enabled = createElement(ToggleField, {
    label: t("enabledLabel"),
    ...splitHint(t("enabledHint")),
    field: "enabled",
    checked: eff("enabled") ?? true,
    disabled: !writable,
    onChange: (next: boolean): void => {
      setField("enabled", next);
    },
  });
  const injects = createElement(NumberField, {
    label: t("injectsLabel"),
    ...splitHint(t("injectsHint")),
    field: "maxInjectsPerTurn",
    value: maxInjects,
    ...MAX_INJECTS_BOUNDS,
    step: 1,
    unit: t("unitTimes"),
    invalidHint: t("outOfRange"),
    disabled: !writable,
    onChange: (next: number | undefined): void => {
      setField("maxInjectsPerTurn", next);
    },
  });
  const budget = createElement(NumberField, {
    label: t("budgetLabel"),
    ...splitHint(t("budgetHint")),
    field: "gateBudgetMs",
    value: budgetSeconds,
    min: budgetMinSeconds,
    max: budgetMaxSeconds,
    step: 1,
    unit: t("unitSeconds"),
    invalidHint: t("outOfRange"),
    disabled: !writable,
    onChange: (next: number | undefined): void => {
      setField("gateBudgetMs", next === undefined ? undefined : next * 1000);
    },
  });
  return createElement(Section, { title: t("gateSection") }, enabled, injects, budget);
}

/** 记忆反馈小节：开关 + 网关地址 + 密钥引用。 */
function buildMemorySection(props: SectionInputs): ReactNode {
  const { t, writable, eff, setField } = props;
  const gatewayUrl = eff("memoryGatewayUrl") ?? "";
  const keyRef = eff("memoryGatewayKeyRef") ?? "";
  const memory = createElement(ToggleField, {
    label: t("memoryLabel"),
    ...splitHint(t("memoryHint")),
    field: "memoryFeedback",
    checked: eff("memoryFeedback") === true,
    disabled: !writable,
    onChange: (next: boolean): void => {
      setField("memoryFeedback", next);
    },
  });
  const url = createElement(TextField, {
    label: t("gatewayUrlLabel"),
    ...splitHint(t("gatewayUrlHint")),
    field: "memoryGatewayUrl",
    value: gatewayUrl,
    placeholder: "http://127.0.0.1:8420",
    monospace: true,
    disabled: !writable,
    onChange: (next: string): void => {
      setField("memoryGatewayUrl", next.trim() === "" ? undefined : next.trim());
    },
  });
  const keyRefField = createElement(TextField, {
    label: t("keyRefLabel"),
    ...splitHint(t("keyRefHint")),
    field: "memoryGatewayKeyRef",
    value: keyRef,
    placeholder: "TDAI_GATEWAY_KEY",
    monospace: true,
    disabled: !writable,
    onChange: (next: string): void => {
      setField("memoryGatewayKeyRef", next.trim() === "" ? undefined : next.trim());
    },
  });
  return createElement(Section, { title: t("memorySection") }, memory, url, keyRefField);
}

function DgCard(props: {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  useCard: <Result>(selector: (snap: CardSnapshot) => Result) => Result;
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
}): ReactNode {
  const { t } = props;
  // 框架把 slots.register 注入的 hooks.card 映射为 useCard prop（client-runner PropsHooks）——
  // 直接读 props.hooks.card 会崩（props.hooks 不存在）。与 zvec-grep 卡同契约。
  const snap = props.useCard((cardSnap) => cardSnap);
  const value = projectCardValues(snap.value);
  const writable = snap.status === "ready" && snap.writable;
  // 保存条状态：touched = 用户动过的字段（undefined = 恢复默认/unset）
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 渲染取值：touched 优先（经 zod 收窄），快照兜底（未触碰字段实时跟随外部快照）。 */
  const eff = <Field extends CardField>(field: Field): CardValues[Field] => {
    if (!(field in touched)) {
      return value[field];
    }
    const parsedTouched = CARD_FIELD_SCHEMAS[field].safeParse(touched[field]);
    return parsedTouched.success ? parsedTouched.data : undefined;
  };
  const dirtyKeys = diffTouched(touched, value);
  const dirty = dirtyKeys.length > 0;
  const setField = (field: CardField, val: unknown): void => {
    setTouched((prev) => ({ ...prev, [field]: val }));
  };
  const save = (): void => {
    const keys = diffTouched(touched, value);
    if (keys.length === 0) {
      return;
    }
    setBusy(true);
    setSaveError(null);
    void writeTouched({
      t,
      set: props.set,
      unset: props.unset,
      keys,
      touched,
      setBusy,
      setSaveError,
      setTouched,
    });
  };
  const discard = (): void => {
    setTouched({});
    setSaveError(null);
  };
  const inputs: SectionInputs = { t, writable, eff, setField };
  const gate = buildGateSection(inputs);
  const memory = buildMemorySection(inputs);
  const saveBar = createElement(SaveBar, {
    dirty,
    busy,
    writable,
    error: saveError,
    saveLabel: t("save"),
    savingLabel: t("saving"),
    revertLabel: t("revert"),
    dirtyLabel: t("dirtyCount", { count: dirtyKeys.length }),
    cleanLabel: t("statusClean"),
    readOnlyLabel: t("statusReadOnly"),
    onSave: save,
    onDiscard: discard,
  });
  return createElement(CardForm, null, gate, memory, saveBar);
}

/**
 * 本卡用到的 ctx 面：`effect` / `slots` 两位直接取官方服务面，`locale` 取官方**类型化**
 * 重载，只有 `configForms` 仍是方法面投影（原因见那一条）。
 *
 * - `effect`：cordis 官方效应面（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts:8`
 *   的 `interface Context extends Pick<Fiber, 'effect'>`，:157/:159 两个重载）。原先这里
 *   手写的是 `(factory: () => (() => void) | undefined, label?: string) => void`——返回位
 *   被抄成了 `void`，而官方交回的是可 await 的 `Disposable`/`AsyncDisposable`；抄一次就把
 *   cordis 的入参/返回形状漂移钉死的机会丢掉了。
 * - `slots`：官方 `SlotRegistry`（renderer 把它增强进 cordis `Context`，installed
 *   `dsh-client-ui-renderer/lib/types/client/index.d.ts:27`）的**方法面投影**。取 `Pick`
 *   而不是 `Context["slots"]` 整个类型：`SlotRegistry` 是带 private 字段的 cordis
 *   `Service` 类（同目录 `registry.d.ts:46`），TS 对它做名义比较，测试桩件无法满足。
 *   `register` 逐字复用 `SlotCore['register']`（`registry.d.ts:85`，两个重载），
 *   `inject` 是 `registry.d.ts:111` 的「按槽位声明生命周期装 effect」那一位（disposer
 *   随 collapse 重跑工厂的语义就写在 :100）。合并进 `SlotMap` 的槽位键在这里是
 *   **编译期受检**的：`inject`/`register` 的 key 参数域就是 `keyof SlotMap & string`，
 *   `plugins.bundle.config` 能过靠的是文件头那条 `import type` 把属主 merge 载入 program。
 * - `configForms`：只投影用到的 `get`。官方 `ConfigForms.get` 是泛型
 *   （`<T>(entryId) => ConfigForm<T>`，installed `config-form.d.ts:137`），且
 *   `ConfigForms` 同样是 Service 类 → 既不能整类型用，也不能把 `Pick` 交给桩件；
 *   这里把 `T` 钉在本卡唯一取的那张表单上，返回面仍是官方 `ConfigForm`。
 * - `locale`：官方 `@deepseek-ai/dsh-client-locale` 的 client 面（`LocaleRuntime`，installed
 *   `lib/types/client/index.d.ts:97`）在**类型化**那两条重载上的投影：
 *   - `register`：`index.d.ts:199` 的 `register<N extends Extract<keyof
 *     LocaleNamespaceMap, string>>(ns: N, dicts: Record<BuiltInLocaleId,
 *     LocaleDictOf<N>>)`，取在 `typeof NS` 上：字典参数即上面的 `LocaleCatalog`
 *     （两语必须一次交齐，缺一门即编译期红）。
 *     ⚠ 不用 :209 那条未类型化的三参重载（`dict: LocaleDict = Record<string, string>`）：
 *     `UiMessages` 按 lint 的 `consistent-type-definitions` 必须是 `interface`，而
 *     interface 拿不到隐式索引签名，走那条得先本包自己把字典再投影一次；有限键映射那条
 *     既满足官方契约、又让「少一门语言」「多一个键」都在编译期红。
 *   - `bind`：:219 的类型化那条（`bind<N>(ns: N): TranslateNS<N>`）。本包命名空间已 merge
 *     进 `LocaleNamespaceMap`（见 ui-messages.ts），故取在 `typeof NS` 上就是本包键集收窄的
 *     `Translate`。
 *     ⚠ 不写成 `LocaleRuntime['bind']`：那会把 :226 的未类型化重载（返回
 *     `Translate<string>`）一起带进目标类型，任何单一实现都满足不了两条——实测把这一位
 *     改成 `LocaleRuntime["bind"]` 之后，测试桩件当场红在
 *     `Type 'string' is not assignable to type 'LocaleKeysOf<"quality-gate">'`。
 */
export interface ClientCtx {
  effect: Context["effect"];
  slots: Pick<SlotRegistry, "inject" | "register">;
  /** 0.1.7 的配置表单服务（installed
   *  `dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98` 交出
   *  `Context.configForms`，`get:137` 按 profile 条目 id 取那张共享表单）：取代已随宿主
   *  移除的 `settingsScope`（installed 全树零命中）。注入只需 `configForms` 本身——
   *  写侧的 `remote.settings` 由 provider 自己的 fiber 承担（同文件 :113-118 明写
   *  「letting a shared form write through the caller's context would make every caller
   *  declare `remote.settings`」，故此处不必声明）。 */
  configForms: {
    get: (entryId: string) => EntryForm;
  };
  locale: {
    register: (ns: typeof NS, dicts: LocaleCatalog) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
}

function cardStore(scope: EntryForm): {
  getSnapshot: () => CardSnapshot;
  subscribe: (listener: () => void) => () => void;
} {
  // 缓存必须 per-scope（闭包内）：模块全局会在多 scope 交错 getSnapshot 时互相
  // 冲 memo，导致 useSyncExternalStore 每次拿到新引用 → 无限重渲染。官方也承诺
  // 快照引用在下次变更前稳定，故身份比较成立。
  let cachedSnap: ConfigFormSnapshot<Record<string, unknown>> | null = null;
  let cachedView: CardSnapshot | null = null;
  const EMPTY_SNAPSHOT: CardSnapshot = { status: "loading", writable: false, value: {} };
  return {
    getSnapshot(): CardSnapshot {
      const snap = scope.getSnapshot();
      if (snap !== cachedSnap) {
        cachedSnap = snap;
        cachedView = {
          status: snap.status,
          writable: snap.writable,
          // 官方 value 在首个快照受理前是 undefined，这里落到空对象供渲染。
          value: snap.value ?? {},
        };
      }
      return cachedView ?? EMPTY_SNAPSHOT;
    },
    subscribe(listener) {
      return scope.subscribe(listener);
    },
  };
}

const inject = ["slots", "configForms", "locale"];

function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "dsh-card-ui-css-quality-gate";
    tag.textContent = CARD_UI_CSS;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "quality-gate-card: styles");
  // 本包的共享表单：条目 id == profile/cordis.patch.yml 里的裸 id `quality-gate`
  // （0.1.7 起 settings 命名空间即条目 id，不再有独立的 register 命名空间），
  // 与 host 半隐式注册用的命名空间同源，故直接复用 NS。
  const scope = ctx.configForms.get(NS);
  const store = cardStore(scope);
  // 卡片文案交给官方 locale：把本包两语字典一次性交给**类型化**那条 register 重载
  // （官方要求每个内置 locale 都在，缺一门即编译期红；disposer 随 effect 回收），再
  // bind 出稳定的取文案函数交给卡片。语言切换由宿主驱动 slot 重渲染，无需重载页面。
  // 两份字典一次性交齐走的是宿主同一条代码路径：installed
  // dsh-client-locale/lib/client.js:1387-1413 的 `register(ns, localeOrDicts, dict)` 在
  // 第二参不是字符串时走 `Object.entries(localeOrDicts)`，两份字典进同一个 `pairs`，
  // 返回的是**一个**回收全部 pairs 的 disposer（逐语各交一份就得手工串两个 disposer）。
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "quality-gate-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        // plugins.bundle.config 按 bundle 包名 keyed，且没有 settings.plugin.item 那枚槽位
        // （installed
        // dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:116），本段
        // 不动——表单来源与 key 各归各处：key 用 BUNDLE_PKG（bundle 包名），
        // **不是** NS（NS 只喂 configForms.get()，见文件头）。
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        // 写入通道把 0.1.7 的 `Promise<boolean>` 受理位**原样**交给卡片：true=宿主受理；
        // false=拒绝或写入被跳过（官方语义："refuses stale revisions before
        // persistence"）；传输失败才 reject（config-form-types.d.ts:62-64/:70-72）。
        // 消费与用户反馈（saveRejected / saveFailed 文案、touched 保留）在卡片 save()
        // 里——这里 swallow 受理位会让宿主拒写时卡片仍显示"已保存"，用户修改被静默丢弃。
        // unset 供数字行清空恢复默认。
        inject: () => ({
          t,
          hooks: { card: store },
          set: (field: string, value: unknown) => scope.set(field, value),
          unset: (field: string) => scope.unset(field),
        }),
      },
      DgCard,
    );
    // disposer 只 unregister()，**不 dispose 表单**：`configForms.get(entryId)`
    // 交回的是 provider 自己持有的共享表单（installed config-form.d.ts:133-137
    // "The entry's form, owned by this provider"），接口 `ConfigForm`
    // （config-form-types.d.ts:33-71）里根本没有 dispose，消费者无从销毁。slot
    // collapse 会调用本 disposer 并在再次声明时**重跑工厂**（installed
    // dsh-client-ui-renderer/lib/types/client/registry.d.ts:100 "Collapse disposes the
    // effect and a later declaration runs it again"）——表单共享且长活，所以重跑后写入
    // 依然落盘；换成消费者自己持有一份可 disposed 的 scope，就会长出「离开插件页一次之后
    // scope 永久 disposed、每次保存被静默丢弃」那一类坑。
    return unregister;
  });
}

// writeTouched 一并导出：保存期间「编辑不丢」的行为用例要直接驱动它（渲染面留在覆盖率
// 分母外，但这段纯异步逻辑不值得只为测它起一套 DOM——接缝见 test/save-during-edit.test.ts）。
export { inject, apply, writeTouched };
