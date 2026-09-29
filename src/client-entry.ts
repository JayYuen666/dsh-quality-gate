// quality-gate client 半：设置卡（1 总开关 + 2 数字字段：注入配额 / 门禁预算
// + 记忆反馈三项：开关 / 网关地址 / 密钥引用）。
// 参照 zvec-grep / session-rescue 的卡片模式：keyed plugins.bundle.config 槽，
// React 由模块系统提供（rolldown external），只用 createElement。

import { createElement, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
// 槽位契约的所有权在属主包：`plugins.bundle.config` 由 plugin-manager 通过
// `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }` 交出
// （installed `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:73-104`，
// 文件头明写「A registrant merges this contract with `import type` and registers
// through `ctx.slots`; it never imports this package at runtime」）。本包过去没有那份
// merge，也没有手抄一份——结果是 `ctx.slots.inject("plugins.bundle.config", …)` 的槽位名
// 一直只是个自由 `string`，拼错了编译器不说话。抄一次就多一处漂移点，而属主的 dts 现在是
// 本包 devDependency，编译器可以替我们对表。
// 这里取 `ConfigPageForm` 是**一举两得**：既是把那份 merge 载入 program 的入口（TS 会
// 顺着 `./client` 的再导出走到 slot-contract.ts），也是本卡渲染视模型两个状态位的真源
// （见下面 CardSnapshot）。lint 的 `require-module-specifiers` 禁空 import specifier，
// 正合本意——载入官方契约就该同时*用上*它。
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate } from "./ui-messages.ts";

const NS: LocaleNs = "quality-gate";

// ⚠ 两个**不同**的标识，别混用（混用过的形状：卡片打不开 / 保存写进别的条目）：
//  - `NS` = loader 条目 id = settings 命名空间 = `configForms.get(NS)` 的入参，
//    真源是本包 cordis.patch.yml 的裸 `- id:`（宿主读 `entry.options.id`）。
//  - 下面这个常量 = 本包在 profile 里那条 bundle 的**包名**，只当槽位 key 用。
// `plugins.bundle.config` 是按 bundle 包名 keyed 的槽位：宿主把注册项的 key 与
// bundle 包名精确相等匹配后才渲染（installed
// dsh-client-ui-plugin-manager/lib/client.js:1821 的
// `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })` →
// dsh-client-ui-renderer/lib/client.js:1154 的 `e.options.key === opts?.entryKey`；
// 同文件 :2698 的 `configured: ledger.bundles.has(openPkg.name)` 读的就是这批 key），
// 契约文本 installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:96-100
// （"keyed by the bundle's package name"），首方先例
// dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661。
// 写成裸条目 id（`quality-gate`）时 ledger 里没有这个键 → 插件页永不出卡。
// 包名真源：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`；
// test/profile-bundle.ts 把真源读进测试，test/build-client.test.ts 的漂移针据此钉。
const BUNDLE_PKG = "@jayyuen666/dsh-quality-gate";

const CARD_CSS = [
  ".qgc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
  ".qgc-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
  ".qgc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
  ".qgc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
  ".qgc-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
  ".qgc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
  ".qgc-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
  ".qgc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".qgc-chevron-open{transform:rotate(180deg)}",
  ".qgc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:8px 0 12px}",
  ".qgc-row{display:flex;flex-direction:row;justify-content:space-between;align-items:center;gap:12px;padding:9px 0}",
  ".qgc-label{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}",
  ".qgc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99);line-height:1.5;margin-top:2px}",
  ".qgc-switch{appearance:none;position:relative;width:34px;height:20px;border-radius:10px;background:var(--dsw-alias-fill-primary,#d8dbe2);transition:background .16s;cursor:pointer;border:0;flex:none}",
  '.qgc-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);transition:left .16s}',
  ".qgc-switch-on{background:var(--dsw-alias-brand-primary,#e07856)}",
  ".qgc-switch-on::after{left:16px}",
  ".qgc-switch:disabled{cursor:not-allowed;opacity:.6}",
  ".qgc-input{width:100%;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px;margin-top:4px}",
  // 保存条（改动先暂存，点「保存」才写入生效；「撤销」丢弃本地改动）
  ".qgc-savebar{display:flex;gap:8px;align-items:center;padding:10px 0 2px;border-top:1px dashed var(--dsw-alias-border-l2);margin-top:6px;flex-wrap:wrap}",
  ".qgc-btn{appearance:none;font:inherit;font-size:12px;cursor:pointer;border-radius:6px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit)}",
  ".qgc-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
  ".qgc-btn-primary{background:var(--dsw-alias-brand-primary,#e07856);border-color:var(--dsw-alias-brand-primary,#e07856);color:var(--dsw-alias-label-primary-foreground,#fff)}",
  ".qgc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#e07856);outline-offset:1px}",
  ".qgc-btn:disabled{opacity:.5;cursor:not-allowed}",
  ".qgc-dirty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}",
  ".qgc-saveerr{font-size:12px;color:#c4483f}",
].join("\n");

/** 客户端配置面直接取官方声明：`@deepseek-ai/dsh-client-ui-settings/client` 交出的
 *  `ConfigForm<T>`（getSnapshot / subscribe / mutate / set / unset）与其快照
 *  `ConfigFormSnapshot<T>`（installed `lib/types/client/config-form-types.d.ts:6-74`）。
 *  原先这里手抄了一份 `getSnapshot: () => unknown`，快照字段全靠 fieldOf 逐位再解析一遍
 *  ——那个解析器只是丢失类型的补救，不是宿主契约（宿主侧 provider 会 decode/derive）。
 *  ⚠ 官方 `configForms.get(entryId)` 返回的表单**没有 dispose()**（表单归 provider 持有），
 *  且 `set`/`unset` 多了受理位：true=宿主受理，false=拒绝或被跳过，只有传输失败才 reject。
 *  本卡失败面仍以 Promise 拒绝为准，受理位即弃（这轮只换类型源，不改行为）。 */
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
 *  slot-contract.d.ts:150-155`，其类型就是官方 `ConfigFormSnapshot<Record<string, unknown>>`
 *  的再投影）。宿主把 status 的取值域或 writable 的必选性一改，这里当场红。
 *  两者都满足才允许写，故保持**必选**，不用可选位假装它们会缺；`value` 是本卡的兜底
 *  收窄（官方 `value: T | undefined` → 首个快照受理前落成空对象供渲染）。 */
interface CardSnapshot extends Pick<ConfigPageForm["state"], "status" | "writable"> {
  value: Record<string, unknown>;
}

interface ToggleRowProps {
  label: string;
  hint: string;
  /** 稳定锚点（schema-coverage 门禁按此识别绑定字段）。 */
  field: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

function ToggleRow(props: ToggleRowProps): ReactNode {
  return createElement(
    "div",
    { className: "qgc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "qgc-label" }, props.label),
      createElement("div", { className: "qgc-hint" }, props.hint),
    ),
    createElement("button", {
      type: "button",
      className: `qgc-switch${props.checked ? " qgc-switch-on" : ""}`,
      role: "switch",
      "aria-checked": props.checked,
      "data-field": props.field,
      disabled: props.disabled === true,
      onClick: props.onToggle,
    }),
  );
}

interface NumberInputRowProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  label: string;
  hint: string;
  field: string;
  value: unknown;
  disabled?: boolean;
  onChange: (field: string, value: unknown) => void;
  onClear: (field: string) => void;
  min?: number;
  max?: number;
}

/** 数字输入行：settings 数字字段 ↔ UI 字符串（v7 配置面补齐）。 */
function NumberInputRow(props: NumberInputRowProps): ReactNode {
  const num =
    typeof props.value === "number" && Number.isFinite(props.value) ? String(props.value) : "";
  const [text, setText] = useState(num);
  // 低危修复：越界/非法值不再静默不 set（旧实现输入框显示越界值但静默不落盘）——
  // 用 invalid 状态标 aria-invalid + 显示"未保存"提示，避免用户以为已生效。
  const [invalid, setInvalid] = useState(false);
  // C11：外部值变更（他处改设置 / unset 恢复默认）回同步输入框，不留过期快照
  useEffect(() => {
    setText(num);
    setInvalid(false);
  }, [num]);
  // 越界提示先取成变量：嵌进 createElement 里再调 t() 会超 max-nested-calls 上限。
  const invalidHint = props.t("outOfRange");
  return createElement(
    "div",
    { className: "qgc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "qgc-label" }, props.label),
      createElement("div", { className: "qgc-hint" }, props.hint),
      createElement("input", {
        type: "number",
        className: "qgc-input",
        value: text,
        disabled: props.disabled === true,
        "aria-invalid": invalid || undefined,
        onChange: (event: { target: { value: string } }) => {
          const next = event.target.value;
          setText(next);
          // C11：清空 → unset（恢复 schema 默认，不留过期值）
          if (next === "") {
            setInvalid(false);
            props.onClear(props.field);
            return;
          }
          const numeric = Number(next);
          if (!Number.isFinite(numeric)) {
            setInvalid(true);
            return;
          }
          const min = props.min ?? -Infinity;
          const max = props.max ?? Infinity;
          if (numeric >= min && numeric <= max) {
            setInvalid(false);
            props.onChange(props.field, numeric);
          } else {
            setInvalid(true);
          }
        },
      }),
      invalid
        ? createElement(
            "div",
            { className: "qgc-hint", style: { color: "var(--dsw-alias-danger, #e5484d)" } },
            invalidHint,
          )
        : null,
    ),
  );
}

interface TextInputRowProps {
  label: string;
  hint: string;
  /** 稳定锚点（schema-coverage 门禁按此识别绑定字段）。 */
  field: string;
  value: unknown;
  placeholder?: string;
  disabled?: boolean;
  onChange: (field: string, value: unknown) => void;
  onClear: (field: string) => void;
}

/**
 * 文本输入行：settings 字符串字段 ↔ UI 字符串。
 * 清空 = unset（回到 schema 默认值）——对本卡的两个网关字段，默认值就是"留空 = 不启用"。
 */
function TextInputRow(props: TextInputRowProps): ReactNode {
  const text = typeof props.value === "string" ? props.value : "";
  const [draft, setDraft] = useState(text);
  // 外部值变更（他处改设置 / unset 恢复默认）回同步输入框，不留过期快照（同数字行 C11）
  useEffect(() => {
    setDraft(text);
  }, [text]);
  return createElement(
    "div",
    { className: "qgc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "qgc-label" }, props.label),
      createElement("div", { className: "qgc-hint" }, props.hint),
      createElement("input", {
        type: "text",
        className: "qgc-input",
        value: draft,
        placeholder: props.placeholder ?? "",
        disabled: props.disabled === true,
        onChange: (event: { target: { value: string } }) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === "") {
            props.onClear(props.field);
            return;
          }
          // 落盘前 trim：地址/引用名带空格是手滑，不是值的一部分
          props.onChange(props.field, next.trim());
        },
      }),
    ),
  );
}

/** touched 层与快照的差异字段（值语义比较；undefined 与缺失等价）。 */
export function diffTouched(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(touched)) {
    if (JSON.stringify(touched[key] ?? null) !== JSON.stringify(value[key] ?? null)) {
      out.push(key);
    }
  }
  return out;
}

interface SaveBarProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  dirty: boolean;
  writable: boolean;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}

function SaveBar(props: SaveBarProps): ReactNode {
  const { t } = props;
  const dis = !props.writable || props.busy;
  // 状态条三态先取成变量：嵌进 createElement 里再调 t() 会超 max-nested-calls 上限。
  let dirtyText: string;
  if (props.writable) {
    dirtyText = props.dirty ? t("statusDirty") : t("statusClean");
  } else {
    dirtyText = t("statusReadOnly");
  }
  return createElement(
    "div",
    { className: "qgc-savebar" },
    createElement(
      "button",
      {
        type: "button",
        className: "qgc-btn qgc-btn-primary",
        "data-field": "save",
        disabled: dis || !props.dirty,
        onClick: props.onSave,
      },
      props.busy ? t("saving") : t("save"),
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "qgc-btn",
        "data-field": "discard",
        disabled: dis || !props.dirty,
        onClick: props.onDiscard,
      },
      t("revert"),
    ),
    props.error === null
      ? createElement("span", { className: "qgc-dirty" }, dirtyText)
      : createElement("span", { className: "qgc-saveerr" }, props.error),
  );
}

/** save() 落到表单上需要的全部依赖：写通道（含 0.1.7 受理位）+ 本回合的 touched 快照 +
 *  三个状态位的 setter（React 的 setState 身份稳定，逐次渲染传同一引用）。 */
interface SaveChannels {
  t: Translate;
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
  /** touched 与快照的差异键（save 起步时定的一次快照）。 */
  keys: readonly string[];
  touched: Record<string, unknown>;
  setBusy: (busy: boolean) => void;
  setSaveError: (error: string | null) => void;
  setTouched: (touched: Record<string, unknown>) => void;
}

/**
 * 逐键 await 写入并**消费受理位**（0.1.7 的 set/unset 回 Promise<boolean>：
 * true=宿主受理；false=拒绝或写入被跳过，settings.md:13 "refuses stale revisions"；
 * 传输失败才 reject）。false 或 rejection 都**不清 touched**——否则宿主拒写时
 * 卡片仍显示"已保存"，用户修改被静默丢弃（旧版 setTimeout 盲清正是这个缺陷）。
 */
async function writeTouched(channels: SaveChannels): Promise<void> {
  const { t, set, unset, keys, touched, setBusy, setSaveError, setTouched } = channels;
  try {
    for (const key of keys) {
      const val = touched[key];
      // 有意串行（非 Promise.all）：首个被拒（false/reject）即停——后面的字段
      // 不再写，touched 保留全部未落盘修改，避免"一半已写一半没写"的模糊态。
      // oxlint-disable-next-line no-await-in-loop -- 压掉本行 await 的"改 Promise.all 并行"判据：串行逐键写是宿主契约（settings.md:13 受理位），并行批会在首个拒写后继续落后续键，造出半写状态；按规则建议改写必然弱化 fail-closed 语义。
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
    setTouched({});
  } catch (error) {
    console.error("[quality-gate] save write failed:", error);
    setBusy(false);
    setSaveError(
      t("saveFailed", { message: String(error instanceof Error ? error.message : error) }),
    );
  }
}

/** 卡片头部的渲染输入（标题/描述/折叠箭头，元素与从前的内联写法逐个同形）。 */
interface CardHeaderProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  open: boolean;
  onToggle: () => void;
}

/** 头部：渲染子树扁平化（规避 max-nested-calls）——DOM 各层拆成独立 createElement 元素
 *  const，逐层用变量组合，避免 createElement 回调逐层内嵌。 */
function buildCardHeader(props: CardHeaderProps): ReactNode {
  const { t, open, onToggle } = props;
  const nameEl = createElement("div", { className: "qgc-name" }, t("cardTitle"));
  const descEl = createElement("div", { className: "qgc-desc" }, t("cardDescription"));
  const headDiv = createElement("div", { className: "qgc-head" }, nameEl, descEl);
  const chevronPathData = "M3 5l4 4 4-4";
  // SVG path 的 `d` 属性名只有 1 字符：用 ≥2 字符的变量作计算键，规避 id-length /
  // no-useless-computed-key（字面量 'd' 会被 oxfmt 反引号回短标识符而撞 id-length）。
  const chevronPathAttr = "d";
  const chevronPath = createElement("path", {
    [chevronPathAttr]: chevronPathData,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  });
  const chevron = createElement(
    "svg",
    {
      width: 14,
      height: 14,
      viewBox: "0 0 14 14",
      "aria-hidden": true,
      className: `qgc-chevron${open ? " qgc-chevron-open" : ""}`,
    },
    chevronPath,
  );
  return createElement(
    "button",
    {
      type: "button",
      className: "qgc-header",
      "aria-expanded": open,
      onClick: onToggle,
    },
    headDiv,
    chevron,
  );
}

/** 展开态六个设置行 + 保存条的渲染输入（与卡片渲染状态一一对应，逐项同形）。 */
interface CardRowsProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  writable: boolean;
  /** 渲染取值：touched 优先，快照兜底（未触碰字段实时跟随外部快照）。 */
  eff: (field: string) => unknown;
  setField: (field: string, val: unknown) => void;
  clearField: (field: string) => void;
  dirty: boolean;
  busy: boolean;
  saveError: string | null;
  onSave: () => void;
  onDiscard: () => void;
}

/** 展开态的 `ul` 本体：行元素仍按从前的顺序逐个传给同一个 createElement（不折成数组
 *  子节点，保持宿主侧 children 形状一致）。 */
function buildCardBody(props: CardRowsProps): ReactNode {
  const { t, writable, eff, setField, clearField, dirty, busy, saveError, onSave, onDiscard } =
    props;
  const rowEnabled = createElement(ToggleRow, {
    label: t("enabledLabel"),
    hint: t("enabledHint"),
    field: "enabled",
    checked: eff("enabled") !== false,
    disabled: !writable,
    onToggle: () => {
      setField("enabled", eff("enabled") === false);
    },
  });
  const rowInjects = createElement(NumberInputRow, {
    t,
    label: t("injectsLabel"),
    hint: t("injectsHint"),
    field: "maxInjectsPerTurn",
    value: eff("maxInjectsPerTurn"),
    disabled: !writable,
    onChange: (field: string, val: unknown) => {
      setField(field, val);
    },
    onClear: (field: string) => {
      clearField(field);
    },
    min: 1,
    max: 5,
  });
  const rowBudget = createElement(NumberInputRow, {
    t,
    label: t("budgetLabel"),
    hint: t("budgetHint"),
    field: "gateBudgetMs",
    value: eff("gateBudgetMs"),
    disabled: !writable,
    onChange: (field: string, val: unknown) => {
      setField(field, val);
    },
    onClear: (field: string) => {
      clearField(field);
    },
    min: 10_000,
    max: 600_000,
  });
  const rowMemory = createElement(ToggleRow, {
    label: t("memoryLabel"),
    hint: t("memoryHint"),
    field: "memoryFeedback",
    checked: eff("memoryFeedback") === true,
    disabled: !writable,
    onToggle: () => {
      setField("memoryFeedback", eff("memoryFeedback") !== true);
    },
  });
  const rowGatewayUrl = createElement(TextInputRow, {
    label: t("gatewayUrlLabel"),
    hint: t("gatewayUrlHint"),
    field: "memoryGatewayUrl",
    value: eff("memoryGatewayUrl"),
    placeholder: "http://127.0.0.1:8420",
    disabled: !writable,
    onChange: (field: string, val: unknown) => {
      setField(field, val);
    },
    onClear: (field: string) => {
      clearField(field);
    },
  });
  const rowGatewayKeyRef = createElement(TextInputRow, {
    label: t("keyRefLabel"),
    hint: t("keyRefHint"),
    field: "memoryGatewayKeyRef",
    value: eff("memoryGatewayKeyRef"),
    placeholder: "TDAI_GATEWAY_KEY",
    disabled: !writable,
    onChange: (field: string, val: unknown) => {
      setField(field, val);
    },
    onClear: (field: string) => {
      clearField(field);
    },
  });
  const rowSave = createElement(SaveBar, {
    t,
    dirty,
    writable,
    busy,
    error: saveError,
    onSave,
    onDiscard,
  });
  return createElement(
    "ul",
    { className: "qgc-body" },
    rowEnabled,
    rowInjects,
    rowBudget,
    rowMemory,
    rowGatewayUrl,
    rowGatewayKeyRef,
    rowSave,
  );
}

function DgCard(props: {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  useCard: <Result>(selector: (snap: CardSnapshot) => Result) => Result;
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
}): ReactNode {
  const { t } = props;
  const [open, setOpen] = useState(false);
  // 框架把 slots.register 注入的 hooks.card 映射为 useCard prop（client-runner PropsHooks）——
  // 直接读 props.hooks.card 会崩（props.hooks 不存在）。与 zvec-grep 卡同契约。
  const snap = props.useCard((cardSnap) => cardSnap);
  // 快照恒有值：框架把 hooks.card 绑成 `selector(getSnapshot())`（installed
  // dsh-client-ui-renderer/lib/client.js 的 bindSnapshotSelector → useSyncExternalStoreWithSelector），
  // 而本卡 cardStore.getSnapshot 的返回类型是必选的 CardSnapshot（无快照时交 EMPTY_SNAPSHOT），
  // 官方 ConfigForm.getSnapshot 同样必回 ConfigFormSnapshot ⇒ 这里没有任何 nullish 面，
  // `?.` / `??` 是死守卫（value 的兜底在 cardStore 里已做过一次）。
  const { value } = snap;
  // 官方快照的 writable 是必选 boolean（memory 模式永假），故直接取值即可，
  // 不再 `=== true` 假装它可能是别的形状；status==='ready' 仍是必要前置。
  const writable = snap.status === "ready" && snap.writable;
  // 保存条状态：touched = 用户动过的字段（undefined = 恢复默认/unset）
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 渲染取值：touched 优先，快照兜底（未触碰字段实时跟随外部快照）。 */
  const eff = (field: string): unknown => (field in touched ? touched[field] : value[field]);
  const dirty = diffTouched(touched, value).length > 0;
  const setField = (field: string, val: unknown): void => {
    setTouched((prev) => ({ ...prev, [field]: val }));
  };
  const clearField = (field: string): void => {
    setTouched((prev) => ({ ...prev, [field]: undefined }));
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
  const header = buildCardHeader({
    t,
    open,
    onToggle: () => {
      setOpen(!open);
    },
  });
  const body = open
    ? buildCardBody({
        t,
        writable,
        eff,
        setField,
        clearField,
        dirty,
        busy,
        saveError,
        onSave: save,
        onDiscard: discard,
      })
    : null;
  return createElement(
    "li",
    { className: `qgc-card${open ? " qgc-card-open" : ""}` },
    header,
    body,
  );
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
 *   （`<T>(entryId) => ConfigForm<T>`，installed `config-form.d.ts:142`），且
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
   *  `Context.configForms`，`get:142` 按 profile 条目 id 取那张共享表单）：取代已随宿主
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
    tag.id = "quality-gate-card-css";
    tag.textContent = CARD_CSS;
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
  // 一次性交齐与旧的两份逐语注册在宿主侧是**同一条代码路径**：installed
  // dsh-client-locale/lib/client.js:1379-1405 的 `register(ns, localeOrDicts, dict)` 在
  // 第二参不是字符串时走 `Object.entries(localeOrDicts)`，两份字典进同一个 `pairs`，
  // 返回的是**一个**回收全部 pairs 的 disposer（旧写法是两个 disposer 手工串起来）。
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "quality-gate-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        // 0.1.6：settings.plugin.item 已删除；plugins.bundle.config 按 bundle 包名 keyed。
        // 0.1.7 复核：该槽位仍在（installed
        // dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:100），故本段
        // 不动——换掉的只是它读写的表单来源，以及 key：用 BUNDLE_PKG（bundle 包名），
        // **不是** NS（NS 只喂 configForms.get()，见文件头）。
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        // 写入通道把 0.1.7 的 `Promise<boolean>` 受理位**原样**交给卡片：true=宿主受理；
        // false=拒绝或写入被跳过（settings.md:13 "refuses stale revisions before
        // persistence"）；传输失败才 reject（config-form-types.d.ts:62-64/:70-72）。
        // 消费与用户反馈（saveRejected / saveFailed 文案、touched 保留）在卡片 save()
        // 里——旧版在此 swallow、卡片盲目 setTimeout 清 touched，宿主拒写时卡片仍显示
        // "已保存"，用户修改被静默丢弃。unset 供数字行清空恢复默认。
        inject: () => ({
          t,
          hooks: { card: store },
          set: (field: string, value: unknown) => scope.set(field, value),
          unset: (field: string) => scope.unset(field),
        }),
      },
      DgCard,
    );
    // disposer 只 unregister()，**不 dispose 表单**：0.1.7 的 `configForms.get(entryId)`
    // 交回的是 provider 自己持有的共享表单（installed config-form.d.ts:138-142
    // "The entry's form, owned by this provider"），接口 `ConfigForm`
    // （config-form-types.d.ts:36-74）里根本没有 dispose，消费者无从销毁。slot
    // collapse 会调用本 disposer 并在再次声明时**重跑工厂**（installed
    // dsh-client-ui-renderer/lib/types/client/registry.d.ts:100 "Collapse disposes the
    // effect and a later declaration runs it again"）——表单共享且长活，所以重跑后写入
    // 依然落盘；旧 `settingsScope` 那种「离开插件页一次之后 scope 永久 disposed、每次
    // 保存被静默丢弃」的坑（0.1.6 的 fiber 级 dispose）随该服务一起消失。
    return unregister;
  });
}

export { inject, apply };
