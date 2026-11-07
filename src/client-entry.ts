// quality-gate 的 client 侧：设置卡（1 个总开关 + 2 个数字字段：注入配额 /门禁预算
// + 记忆反馈三项：开关 / 网关地址 / 密钥引用）。
// 参照 zvec-grep / session-rescue 的卡片写法：keyed 的 plugins.bundle.config 槽位，
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
// 没有那份 merge 时，`ctx.slots.inject("plugins.bundle.config", …)` 里的槽位名
// 一直只是一个普通的 `string`，拼错了编译器不会说话。自己抄一份就多一处会跟官方不一致的地方，
// 而属主的 dts 现在是本包 devDependency，编译器可以替我们核对。
// 这里取 `ConfigPageForm` 是**一举两得**：既是把那份 merge 载入 program 的入口（TS 会
// 顺着 `./client` 的再导出走到 slot-contract.ts），也是本卡渲染视图模型那两个状态位的唯一来源
// （见下面 CardSnapshot）。lint 的 `require-module-说明符s` 禁止空的 import说明符，
// 正合本意——载入官方契约就该同时*用上*它。
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { z } from "zod";
import {
  CARD_UI_CSS,
  CardForm,
  NumberField,
  SaveBar,
  Section,
  TextField,
  ToggleField,
  diffTouched,
  splitHint,
} from "@jayyuen66/dsh-plugin-shared/client";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate } from "./ui-messages.ts";
import { isCredentialSafeUrl } from "../lib/credential-url.ts";

const NS: LocaleNs = "quality-gate";

// ⚠ 这是两个**不同**的标识，不能混用（混用后的现象：卡片打不开 / 保存写进了别的条目）：
//  - `NS` = loader 条目 id = settings 命名空间 = `configForms.get(NS)` 的入参，
//    唯一来源是本包 cordis.patch.yml 的裸 `- id:`（宿主读 `entry.options.id`）。
//  - 下面这个常量 = 本包在 profile 里那条 bundle 的**包名**，只用来当槽位的 key。
// `plugins.bundle.config` 是按 bundle 包名 keyed 的槽位：宿主把注册项的 key 与
// bundle 包名精确相等匹配之后才渲染（installed
// dsh-client-ui-plugin-manager/lib/client.js:2907 的
// `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })` →
// dsh-client-ui-renderer/lib/client.js:1179 的 `e.options.key === opts?.entryKey`；
// 同文件 :3979 的 `configured: ledger.bundles.has(openPkg.name)` 读的就是这批 key），
// 这条契约写在 installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:112-116
// （"keyed by the bundle's package name"）。
// 写成裸条目 id（`quality-gate`）时 ledger 里没有这个键 → 插件页永不出卡。
// 包名以 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 为准；
// test/profile-bundle.ts 把它读进测试，test/build-client.test.ts 核对产物漂移时据此判断。
const BUNDLE_PKG = "@jayyuen66/dsh-quality-gate";

/** 客户端的配置类型直接取官方声明：`@deepseek-ai/dsh-client-ui-settings/client` 交出的
 *  `ConfigForm<T>`（getSnapshot / subscribe / mutate / set / unset）与它的快照
 *  `ConfigFormSnapshot<T>`（installed `lib/types/client/config-form-types.d.ts:6-29`，
 *  `ConfigForm` 在 `:33-71`）。
 *  照抄一份 `getSnapshot: () => unknown` 的话，快照字段就得靠 fieldOf 逐位再解析一遍
 *  ——那个解析器只是为了补回丢失的类型，不是宿主的契约（宿主侧的 provider 会 decode/derive）。
 *  ⚠ 官方 `configForms.get(entryId)` 返回的表单**没有 dispose()**（表单由 provider 持有），
 *  而且 `set`/`unset` 多返回一个受理标记：true 表示宿主受理，false 表示拒绝或被跳过，只有传输失败才 reject。
 *  本卡仍然把 Promise 拒绝当失败，受理标记照用（只换了类型来源，行为不变）。 */
export type EntryForm = ConfigForm<Record<string, unknown>>;

/**
 * 官方 `LocaleRuntime.register` 那条带类型的重载所需的字典参数，取在本包的命名空间上：
 * `Record<BuiltInLocaleId, LocaleDictOf<'quality-gate'>>`——两种语言（官方 `BuiltInLocaleId`
 * = `"zh" | "en"`，installed `dsh-client-locale/lib/types/locale-settings.d.ts:10-12`）
 * 必须齐全、每种语言的键集必须等于 `UiMessages`，这两条都由官方类型表达式给出。
 */
export type LocaleCatalog = Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>;

/** 本卡自己的渲染视图模型（官方快照里有用的那部分 + 默认值）。
 *  `status`/`writable` 两位不再手写联合/裸布尔：它们取自属主包交给配置页的那份官方状态
 *  （`ConfigPageForm['state']`，installed `dsh-client-ui-plugin-manager/lib/types/client/
 *  slot-contract.d.ts:166-168`，其类型就是官方 `ConfigFormSnapshot<Record<string, unknown>>`
 *  的再投影）。宿主改了 status 的取值范围或 writable 是否必填，这里立刻编译报错。
 *  两位都满足才允许写入，所以保持**必填**，不用可选位假装它们会缺；`value` 是本卡自己收窄的
 *  （官方 `value: T | undefined` → 第一个快照到达之前先落成空对象供渲染）。 */
interface CardSnapshot extends Pick<ConfigPageForm["state"], "status" | "writable"> {
  value: Record<string, unknown>;
}

/**
 * 两个数值字段的闭区间只写在 zod schema 上：host 的 schema（`Schema.natural().min/max`）
 * 与卡片输入框都从这里取。zod 4.6 的 `.minValue`/`.maxValue` 直接读出设置好的边界，
 * `NumberField` 的 `min/max` 因此不再另抄一份数字。
 */
const MAX_INJECTS_VALUE = z.int().min(1).max(5);
const GATE_BUDGET_MS_VALUE = z.int().min(10_000).max(600_000);

/** 把 zod 里设置好的显式边界转成可选 props（null 表示那个方向没声明，不编造一个上限）。 */
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

/** 两个数值 schema 对外的形式：测试用 `.minValue`/`.maxValue` 和 `z.toJSONSchema` 核对边界。 */
export const CARD_NUMBER_SCHEMAS = {
  maxInjectsPerTurn: MAX_INJECTS_VALUE,
  gateBudgetMs: GATE_BUDGET_MS_VALUE,
} as const;

/** 换 zod 版本也能用的闭区间整数判断：宿主平台冻结的那份 zod（实测 4.4.3）没有 `.validate`
 *  （4.6 才回到 classic 那套接口），这里用 `boundsOf` 取到的边界自己判，不依赖 zod 的方法——
 *  否则单仓测试（catalog 里的 4.6.7）全部通过，真宿主里槽位崩溃、设置表单没有提示地消失。 */
function inBounds(
  bounds: { readonly min?: number; readonly max?: number },
  value: number,
): boolean {
  return (
    Number.isInteger(value) &&
    (bounds.min ?? Number.NEGATIVE_INFINITY) <= value &&
    value <= (bounds.max ?? Number.POSITIVE_INFINITY)
  );
}

/** 可选整数：超出范围、小数、非有限值转成 undefined，只丢掉那一格，不影响整份快照。
 *  不引入 `z.compile`：编译器给客户端 bundle 增加约 28 KB，而且 CSP 环境会拒绝 `new Function`；
 *  卡片每一帧只解析一个快照对象，这点收益抵不上那两条代价。 */
const MAX_INJECTS_SCHEMA = z.preprocess(
  (value) => (typeof value === "number" && inBounds(MAX_INJECTS_BOUNDS, value) ? value : undefined),
  MAX_INJECTS_VALUE.optional(),
);
const GATE_BUDGET_MS_SCHEMA = z.preprocess(
  (value) =>
    typeof value === "number" && inBounds(GATE_BUDGET_MS_BOUNDS, value) ? value : undefined,
  GATE_BUDGET_MS_VALUE.optional(),
);

/** 卡片可编辑字段的取值范围。逐字段先把错误的类型转成 undefined：宿主给了不合适的形状时只丢掉
 *  那一格，其余字段照常渲染；只有整份快照不是对象时才全部回落到空表。 */
const optionalBoolean = z.preprocess(
  (value) => (typeof value === "boolean" ? value : undefined),
  z.boolean().optional(),
);
const optionalString = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z.string().optional(),
);

/** 网关地址：必须是 http(s)，且和宿主运行期用同一份判据——不能带 userinfo，远端只能 https，
 *  明文 http 只允许本机回环。空串与不合语法的文本按未设置处理。 */
const optionalHttpUrl = z.preprocess(
  (value: unknown): string | undefined => {
    let text: string | undefined;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "") {
        text = trimmed;
      }
    }
    return text;
  },
  z.string().refine(isCredentialSafeUrl, { error: "credential-unsafe-url" }).optional(),
);
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
/** 草稿仍然按普通的 string 读：`TextField` 没有"输入无效"这个状态，正在输入的半截地址不会被
 *  立刻变成空串；提交时由 `writeTouched` 用同一份凭据地址判断拦下，不合规的地址不会写进设置。 */
const CARD_FIELD_SCHEMAS: { readonly [Field in CardField]: z.ZodType<CardValues[Field]> } = {
  enabled: optionalBoolean,
  maxInjectsPerTurn: MAX_INJECTS_SCHEMA,
  gateBudgetMs: GATE_BUDGET_MS_SCHEMA,
  memoryFeedback: optionalBoolean,
  memoryGatewayUrl: optionalString,
  memoryGatewayKeyRef: optionalString,
};

/** 读取快照里的值：逐字段解析，不合适的形状与超出范围的值只丢掉那一格，其余字段照常渲染。
 *  整份只做一次 `safeParse` 的话，一个不合法的 URL 会把 enabled 和两个数字字段一起清空。 */
export function projectCardValues(raw: Record<string, unknown>): CardValues {
  const out: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(CARD_VALUES.shape)) {
    const parsed = schema.safeParse(raw[field]);
    if (parsed.success) {
      out[field] = parsed.data;
    }
  }
  return out;
}

/** save() 落到表单上需要的全部依赖：写入通道（含 0.1.7 的受理标记）+ 本次的 touched 快照 +
 *  三个状态位的 setter（React 的 setState 身份稳定，每次渲染传的都是同一个引用）。 */
export interface SaveChannels {
  t: Translate;
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
  /** touched 与快照之间不同的那些键（save 开始时确定的一次快照）。 */
  keys: readonly string[];
  touched: Record<string, unknown>;
  setBusy: (busy: boolean) => void;
  setSaveError: (error: string | null) => void;
  /** 用 updater 改写 touched：要按"此刻的"草稿层决定保留哪些键，取值不能是 save 开始时那份旧快照。 */
  setTouched: (update: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
}

/** 判断两个值是否相等（与 shared 的 diffTouched 用同一种比较）：表单值是标量和数组，只比引用会把内容相同的数组判成改动。 */
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** 凭据引用名的合法形状：与 @deepseek-ai/dsh-credentials 的 REF_PATTERN 是同一个式子。客户端不引
 *  那个包导出的值（那是宿主侧的凭据服务），所以这里按同一条正则再判一次；两处不一致时宿主运行期仍然会拒绝。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_]\w*$/u;

/**
 * 逐键 await 写入，并且**用上返回的受理标记**（0.1.7 的 set/unset 返回 Promise<boolean>：
 * true 表示宿主受理；false 表示拒绝或者写入被跳过（官方语义："refuses stale revisions"）；
 * 只有传输失败才 reject）。false 和 reject 都**不清空 touched**——否则宿主拒写时
 * 卡片仍然显示"已保存"，用户的修改没有任何提示就丢了。
 *
 * 成功之后也只清空**本次真正写下的那些键**：保存期间只有保存按钮被禁用，输入框还能继续改，
 * 这期间产生的新改动如果一并清掉就是无声地丢失。这里的判据是"当前草稿值仍然等于本次快照值"——
 * 相等说明这一条已经落到宿主，可以从草稿层移除；不等说明用户又改过，留着让它重新变脏。
 */
async function writeTouched(channels: SaveChannels): Promise<void> {
  const { t, set, unset, keys, touched, setBusy, setSaveError, setTouched } = channels;
  try {
    for (const key of keys) {
      const val = touched[key];
      // 卡片侧与宿主运行期用同一份判据：不拦的话会写进 settings.yaml，卡片显示已保存，
      // 而 resolveFeedbackTarget 在运行期判定不安全之后就不发送了，没有任何提示。
      if (
        key === "memoryGatewayUrl" &&
        typeof val === "string" &&
        val.trim() !== "" &&
        !isCredentialSafeUrl(val.trim())
      ) {
        setBusy(false);
        setSaveError(t("invalidGatewayUrl"));
        return;
      }
      if (
        key === "memoryGatewayKeyRef" &&
        typeof val === "string" &&
        val.trim() !== "" &&
        !CREDENTIAL_REF_PATTERN.test(val.trim())
      ) {
        setBusy(false);
        setSaveError(t("invalidKeyRef"));
        return;
      }
      // 有意一个接一个写（不用 Promise.all）：第一个被拒（false 或 reject）就停——后面的字段
      // 不再写，touched 保留全部还没写入的修改，避免出现"一半已写一半没写"这种说不清的状态。
      // oxlint-disable-next-line no-await-in-loop -- 压掉本行 await 的"改成 Promise.all 并行"这条提示：逐键串行写入是宿主的契约（宿主按键返回受理标记），并行批会在第一个拒写之后继续写后面的键，造成半写状态；按规则建议改写一定会削弱"宁可拒绝也不留半写"的语义。
      const accepted = await (val === undefined ? unset(key) : set(key, val));
      // accepted 为假就按"被拒绝"处理：受理标记缺失或形状不对时，宁可保留改动多报
      // 一次错，也不清空 touched 把用户的修改丢掉。
      if (!accepted) {
        setBusy(false);
        setSaveError(t("saveRejected"));
        return;
      }
    }
    setBusy(false);
    setTouched((prev) => {
      // 只保留"本次没写下的键"：写入期间只有保存按钮被禁用，输入框还能编辑，
      // 这期间产生的新改动如果一并清掉就是无声地丢失。
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
  /** 取文案（官方 ctx.locale.bind 返回的函数）。 */
  t: Translate;
  writable: boolean;
  /** 渲染时用的值：touched 优先，没有就用快照里的值。 */
  eff: <Field extends CardField>(field: Field) => CardValues[Field];
  setField: (field: CardField, value: unknown) => void;
}

/** 质量门禁小节：总开关 + 注入配额 + 预算（存毫秒，按秒显示）。 */
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
  /** 取文案（官方 ctx.locale.bind 返回的函数，见 apply）。 */
  t: Translate;
  useCard: <Result>(selector: (snap: CardSnapshot) => Result) => Result;
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
}): ReactNode {
  const { t } = props;
  // 框架把 slots.register 注入的 hooks.card 映射成 useCard prop（client-runner 的 PropsHooks）——
  // 直接读 props.hooks.card 会抛错（props.hooks 不存在）。和 zvec-grep 的卡片用的是同一个契约。
  const snap = props.useCard((cardSnap) => cardSnap);
  const value = projectCardValues(snap.value);
  const writable = snap.status === "ready" && snap.writable;
  // 保存条的状态：touched = 用户改过的字段（值是 undefined 表示恢复默认，走 unset）
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 渲染时用的值：touched 优先（经过 zod 收窄），没动过的字段实时跟随外部快照。 */
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
 * 本卡用到的 ctx 部分：`effect` 和 `slots` 直接取官方的类型，`locale` 取官方**带类型**的那条
 * 重载，只有 `configForms` 还是自己声明的方法投影（原因见那一条）。
 *
 * - `effect`：cordis 官方效应面（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts:8`
 *   的 `interface Context extends Pick<Fiber, 'effect'>`，:157/:159 两条重载）。原先这里
 *   手写的是 `(factory: () => (() => void) | undefined, label?: string) => void`——返回值
 *   抄成了 `void`，而官方返回的是可以 await 的 `Disposable`/`AsyncDisposable`；自己抄一份，
 *   cordis 改了入参或返回形状时就没有任何东西能发现。
 * - `slots`：官方 `SlotRegistry`（renderer 把它加进 cordis 的 `Context`，installed
 *   `dsh-client-ui-renderer/lib/types/client/index.d.ts:27`）里**只取这两个方法**。取 `Pick`
 *   而不是 `Context["slots"]` 整个类型：`SlotRegistry` 是带 private 字段的 cordis
 *   `Service` 类（同目录 `registry.d.ts:46`），TS 对它做名义类型比较，测试用的假对象满足不了。
 *   `register` 逐字复用 `SlotCore['register']`（`registry.d.ts:85`，两条重载），
 *   `inject` 是 `registry.d.ts:111` 那条"按槽位声明生命周期装 effect"（disposer 随 collapse
 *   重跑工厂这件事写在 :100）。合并进 `SlotMap` 的槽位键在这里是**编译期检查**的：
 *   `inject` 和 `register` 的 key 参数只能是 `keyof SlotMap & string`，
 *   `plugins.bundle.config` 能通过，靠的是文件头那条 `import type` 把属主的 merge 载入 program。
 * - `configForms`：只声明用到的 `get`。官方 `ConfigForms.get` 是泛型
 *   （`<T>(entryId) => ConfigForm<T>`，installed `config-form.d.ts:137`），而且
 *   `ConfigForms` 同样是 Service 类 → 既不能整类型拿来用，也不能把 `Pick` 交给测试假对象；
 *   这里把 `T` 固定在本卡唯一取的那张表单上，返回类型仍然是官方的 `ConfigForm`。
 * - `locale`：官方 `@deepseek-ai/dsh-client-locale` 的 client 接口（`LocaleRuntime`，installed
 *   `lib/types/client/index.d.ts:97`）里**带类型**的那两条重载：
 *   - `register`：`index.d.ts:199` 的 `register<N extends Extract<keyof
 *     LocaleNamespaceMap, string>>(ns: N, dicts: Record<BuiltInLocaleId,
 *     LocaleDictOf<N>>)`，取在 `typeof NS` 上：字典参数就是上面的 `LocaleCatalog`
 *     （两种语言必须一次交齐，少一种就在编译期报错）。
 *     ⚠ 不用 :209 那条不带类型的三参重载（`dict: LocaleDict = Record<string, string>`）：
 *     `UiMessages` 按 lint 的 `consistent-type-definitions` 必须写成 `interface`，而
 *     interface 没有隐式索引签名，走那条得本包自己把字典再转换一次；带有限键的那条
 *     既满足官方的契约，又让"少一门语言""多一个键"都在编译期报错。
 *   - `bind`：:219 那条带类型的（`bind<N>(ns: N): TranslateNS<N>`）。本包的命名空间已经 merge
 *     进 `LocaleNamespaceMap`（见 ui-messages.ts），所以取在 `typeof NS` 上得到的就是只认本包键的
 *     `Translate`。
 *     ⚠ 不写成 `LocaleRuntime['bind']`：那会把 :226 那条不带类型的重载（返回
 *     `Translate<string>`）一起带进目标类型，任何单一实现都满足不了两条——实测把这一处
 *     改成 `LocaleRuntime["bind"]` 之后，测试假对象立刻报
 *     `Type 'string' is not assignable to type 'LocaleKeysOf<"quality-gate">'`。
 */
export interface ClientCtx {
  effect: Context["effect"];
  slots: Pick<SlotRegistry, "inject" | "register">;
  /** 0.1.7 的配置表单服务（installed
   *  `dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98` 交出
   *  `Context.configForms`，`get:137` 按 profile 条目 id 取那张共享表单）：取代已随宿主
   *  移除的 `settingsScope`（installed 全树找不到）。注入只需要 `configForms` 本身——
   *  写入侧的 `remote.settings` 由 provider 自己的 fiber 负责（同文件 :113-118 明写
   *  「letting a shared form write through the caller's context would make every caller
   *  declare `remote.settings`」，所以这里不必声明）。 */
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
  // 缓存必须按 scope 各存一份（放在闭包里）：放到模块全局的话，多个 scope 交替调用 getSnapshot
  // 会互相顶掉缓存，useSyncExternalStore 每次都拿到新引用 → 无限重渲染。官方也承诺
  // 快照引用在下一次变更前保持不变，所以直接比较引用是成立的。
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
          // 官方的 value 在第一个快照到达之前是 undefined，这里换成空对象供渲染。
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
  // （0.1.7 起 settings 命名空间就是条目 id，不再有单独的 register 命名空间），
  // 和 host 侧隐式注册用的命名空间是同一个来源，所以直接复用 NS。
  const scope = ctx.configForms.get(NS);
  const store = cardStore(scope);
  // 卡片文案交给官方 locale：把本包两种语言的字典一次性交给**带类型**的那条 register 重载
  // （官方要求每个内置 locale 都要有，少一种就在编译期报错；disposer 随 effect 回收），再
  // bind 出一个稳定的取文案函数交给卡片。语言切换由宿主驱动 slot 重新渲染，不用重新加载页面。
  // 两份字典一次性交齐走的是宿主同一条代码路径：installed
  // dsh-client-locale/lib/client.js:1387-1413 的 `register(ns, localeOrDicts, dict)` 在
  // 第二个参数不是字符串时走 `Object.entries(localeOrDicts)`，两份字典进同一个 `pairs`，
  // 返回的是**一个**回收全部 pairs 的 disposer（一种语言一种语言地交，就得手工把两个 disposer 串起来）。
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "quality-gate-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        // plugins.bundle.config 按 bundle 包名 keyed，而且没有 settings.plugin.item 那个槽位
        // （installed
        // dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:116），这一段
        // 不要改——表单来源和 key 各归各：key 用 BUNDLE_PKG（bundle 包名），
        // **不是** NS（NS 只喂 configForms.get()，见文件开头）。
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        // 写入通道把 0.1.7 的 `Promise<boolean>` 受理标记**原样**交给卡片：true 表示宿主受理；
        // false 表示拒绝或者写入被跳过（官方语义："refuses stale revisions before
        // persistence"）；只有传输失败才 reject（config-form-types.d.ts:62-64/:70-72）。
        // 怎么用这个标记、怎么反馈给用户（saveRejected / saveFailed 文案、touched 保留）写在卡片的
        // save() 里——在这里忽略受理标记，宿主拒写时卡片仍然显示"已保存"，修改没有任何提示就丢了。
        // unset 供数字行清空、恢复默认值。
        inject: () => ({
          t,
          hooks: { card: store },
          set: (field: string, value: unknown) => scope.set(field, value),
          unset: (field: string) => scope.unset(field),
        }),
      },
      DgCard,
    );
    // disposer 只做 unregister()，**不 dispose 表单**：`configForms.get(entryId)`
    // 返回的是 provider 自己持有的共享表单（installed config-form.d.ts:133-137
    // "The entry's form, owned by this provider"），接口 `ConfigForm`
    // （config-form-types.d.ts:33-71）里根本没有 dispose，调用方也就无从销毁。slot
    // collapse 会调用这个 disposer，并在再次声明时**重跑工厂**（installed
    // dsh-client-ui-renderer/lib/types/client/registry.d.ts:100 "Collapse disposes the
    // effect and a later declaration runs it again"）——表单是共享的、一直活着，所以重跑之后
    // 写入照样生效；如果换成调用方自己持有一份可以被 dispose 的 scope，就会出现"离开插件页一次
    // 之后 scope 永远是 disposed 状态、每次保存都没有提示地失败"这一类问题。
    return unregister;
  });
}

// writeTouched 也一并导出：验证"保存期间继续编辑不会丢"的用例要直接调用它（界面渲染不计入覆盖率，
// 但这段纯异步逻辑不值得为它单独起一套 DOM——调用方式见 test/client-save-during-edit.test.ts）。
export { inject, apply, writeTouched };
