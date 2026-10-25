// src/ui-messages.ts —— 设置卡 UI 文案字典（中英双语）。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 UiMessages 接口，少键多键在编译期红。
// 注册与取值走官方 @deepseek-ai/dsh-client-locale 的**类型化**那条 register 重载
// （`ctx.locale.register(ns, dicts)`，一次交齐两语）+ `ctx.locale.bind(ns)`，语言切换由
// 宿主驱动、无需重载页面（见 src/client-entry.ts 的 apply）。键集之所以能由官方表达式
// 给出，靠的是本文件把 `quality-gate` merge 进了官方 `LocaleNamespaceMap`（见下面）。
// 插值不放进字典（官方字典是扁平字符串表）：带变量的整行用官方 `{name}` 占位符，
// 由宿主侧的 Translate 渲染，本文件只存扁平字符串。
import type { TranslateNS as OfficialTranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/** 本包设置卡产出的全部界面文案。 */
export interface UiMessages {
  /** 卡片标题（设置页插件列表里的那一行）。 */
  readonly cardTitle: string;
  /** 卡片副标题：一句话说明本包做什么。 */
  readonly cardDescription: string;
  /** 作用域只读（非 loopback 页面）时的状态条文本。 */
  readonly statusReadOnly: string;
  /** 有未保存改动时的状态条文本。 */
  readonly statusDirty: string;
  /** 无未保存改动时的状态条文本。 */
  readonly statusClean: string;
  /** 保存按钮（空闲态）。 */
  readonly save: string;
  /** 保存按钮（写入中）。 */
  readonly saving: string;
  /** 撤销按钮。 */
  readonly revert: string;
  /** 保存失败整行（{message} 错误摘要）。 */
  readonly saveFailed: string;
  /** 保存被宿主拒绝（受理位 false：校验未通过或写入被跳过），修改未生效。 */
  readonly saveRejected: string;
  /** 数字输入越界/非法时的行内提示。 */
  readonly outOfRange: string;
  readonly enabledLabel: string;
  readonly enabledHint: string;
  readonly injectsLabel: string;
  readonly injectsHint: string;
  readonly budgetLabel: string;
  readonly budgetHint: string;
  readonly memoryLabel: string;
  readonly memoryHint: string;
  readonly gatewayUrlLabel: string;
  readonly gatewayUrlHint: string;
  readonly keyRefLabel: string;
  readonly keyRefHint: string;
}

/**
 * 本包的文案命名空间 merge 进官方的 `LocaleNamespaceMap`（installed
 * `dsh-client-ui-slots/lib/types/index.d.ts:22-31`「Locale namespace table. Dictionary
 * owners extend via declaration merging (exactly like {@link SlotMap} …)」）。这不是可选
 * 的美化：官方 `LocaleRuntime.bind` 有两条重载（installed
 * `dsh-client-locale/lib/types/client/index.d.ts:219` 的类型化那条、:226 的
 * `bind(ns: string): Translate` 未类型化那条），不 merge 时本包命名空间只能落到后面那条，
 * 拿回来的 `t` 键域是宽 `string`——卡片要的键集收窄的 `t` 于是**没有任何官方来源**，
 * 本地只好继续手写一个官方给不出的函数形状。实测把下面这一行撤掉（本包不再 merge），
 * 官方 `LocaleDictOf` / `TranslateNS` 的约束域立刻只剩宿主包 merge 的那三个命名空间
 * （`Type '"quality-gate"' does not satisfy the constraint
 * '"common" | "pluginManager" | "settings.locale"'`，TS2344）：merge 是键域的**唯一**入口。
 * merge 之后键集由官方 `TranslateNS<NS>`（`index.d.ts:67`，`= Translate<LocaleKeysOf<N>>`，
 * :45/:59）表达，`t("拼错的键")` 在编译期红。
 * ⚠ 表键必须是字面量（interface 键位不接受计算属性），故下面的等式常量是本源，
 * client-entry.ts 的 `NS` 按它的类型 `LocaleNs` 标注：两边哪天分叉，那行编译期就红。
 */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** 本包设置卡的全部界面文案键。 */
    "quality-gate": keyof UiMessages;
  }
}

/** 编译期契约：merge 里写死的命名空间键（`Translate` 用它取 `TranslateNS`）与卡片
 *  条目 id 必须是同一个串——改任何一处都要动这一行才会红。 */
const LOCALE_NS_KEY = "quality-gate" as const;

/**
 * 本源只以**类型**形态对外流通：`client-entry.ts` 的 `const NS: LocaleNs = "quality-gate"` 把条目
 * id 钉在本源上（分叉即编译期红），而产物漂移针仍要按字面量形状从 bundle 里抓 `NS`，所以那里
 * 保留字面量、只加类型标注——值导出不必存在（用例侧同理：要断言运行时那串就写字面量）。
 */
export type LocaleNs = typeof LOCALE_NS_KEY;

/**
 * 卡片取文案的函数形状：官方 `TranslateNS<N>`（installed `index.d.ts:67`，
 * `= Translate<LocaleKeysOf<N>>`，而 `Translate<K> = (key: K, params?) => string`，
 * `index.d.ts:45`）——键域就是上面 merge 的 `keyof UiMessages` **并上**官方 `common`
 * 命名空间的共享词（官方 `LocaleKeysOf` 的并集：宿主查找链在本命名空间 miss 之后确实
 * 会去 consult common，见 installed dsh-client-locale/lib/client.js:1417），函数面完全归官方。
 */
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    cardTitle: "quality-gate 回合收口质量门禁",
    cardDescription:
      "回合收口质量门禁（ECC stop-format-typecheck 移植）：本回合编辑过代码文件时，收口前自动跑项目门禁（根 package.json 声明了 check 才用 pnpm check，否则 cargo check / ruff / tsc），失败自动开新回合注入修复指令；失败事实同步 lesson-loop 总线，记忆网关沉淀默认关闭",
    statusReadOnly: "当前作用域只读",
    statusDirty: "有未保存的修改，点「保存」生效",
    statusClean: "无未保存的修改",
    save: "保存",
    saving: "保存中…",
    revert: "撤销",
    saveFailed: "保存失败：{message}",
    saveRejected: "保存被宿主拒绝（配置校验未通过或写入被跳过），修改未生效",
    outOfRange: "超出允许范围，未保存",
    enabledLabel: "启用质量门禁",
    enabledHint: "关闭后回合收口不再跑门禁（模型可带病收口）",
    injectsLabel: "每回合注入配额",
    injectsHint: "门禁失败每回合最多注入几次修复指令（1-5，默认 2，防跑飞）",
    budgetLabel: "门禁预算（毫秒）",
    budgetHint: "单次门禁最大耗时（10s-600s，默认 300s；超时按失败注入不静默放行）",
    memoryLabel: "门禁失败沉淀记忆",
    memoryHint:
      "默认关闭。开启后：代码型门禁失败的证据（命令/根/全文报错，不截断）写入记忆网关的 L0 会话层供后续会话召回（需同时填下面两项，任一留空即不启用）；总线 lesson-loop 的同步上报不受此开关影响。关闭后只注入不沉淀",
    gatewayUrlLabel: "记忆网关地址",
    gatewayUrlHint:
      "留空 = 不启用记忆反馈。插件不带任何默认地址：本机用户请填自己的网关地址（例如 http://127.0.0.1:8420），没有网关就让它空着",
    keyRefLabel: "网关密钥引用",
    keyRefHint:
      "网关鉴权令牌的凭据引用名（环境变量名形态，默认 TDAI_GATEWAY_KEY）。这里存的只是引用名，密钥值由 dsh 凭据服务管理（Web 凭据页或 ~/.dsh/.credentials.yaml 的 refs），不会写进 settings.yaml；清空即恢复默认引用名",
  },
  en: {
    cardTitle: "quality-gate turn-end quality gate",
    cardDescription:
      "Turn-end quality gate (ported from ECC stop-format-typecheck): when this turn edited code files, the project gate runs automatically before the turn closes (pnpm check only if the root package.json declares a check script, otherwise cargo check / ruff / tsc); a failure opens a new turn with repair instructions. Failure facts are also reported to the lesson-loop bus; memory-gateway persistence is off by default",
    statusReadOnly: "This scope is read-only",
    statusDirty: "Unsaved changes — press Save to apply",
    statusClean: "No unsaved changes",
    save: "Save",
    saving: "Saving…",
    revert: "Revert",
    saveFailed: "Save failed: {message}",
    saveRejected:
      "Save rejected by the host (validation failed or write skipped) — changes not applied",
    outOfRange: "Out of the allowed range — not saved",
    enabledLabel: "Enable the quality gate",
    enabledHint: "When off: no gate runs at turn end (the model may close a turn with broken code)",
    injectsLabel: "Repair injections per turn",
    injectsHint:
      "How many repair instructions a failing gate may inject per turn (1-5, default 2 — runaway protection)",
    budgetLabel: "Gate budget (milliseconds)",
    budgetHint:
      "Max duration of one gate run (10s-600s, default 300s; a timeout injects a failure instead of passing silently)",
    memoryLabel: "Persist gate failures to memory",
    memoryHint:
      "Off by default. When on: the evidence of code-level gate failures (command, root, full error text, untruncated) is written into the memory gateway's L0 session layer so later sessions can recall it (both fields below must be filled — leaving either empty disables it); synchronous reporting to the lesson-loop bus is unaffected by this switch. When off, repairs are injected but nothing is persisted",
    gatewayUrlLabel: "Memory gateway URL",
    gatewayUrlHint:
      "Empty = memory feedback disabled. The plugin ships no default address: fill in your own gateway URL (e.g. http://127.0.0.1:8420), or leave it empty if you have no gateway",
    keyRefLabel: "Gateway credential ref",
    keyRefHint:
      "Name of the credential holding the gateway token (POSIX env-var form, default TDAI_GATEWAY_KEY). Only the ref name is stored here — the secret itself is managed by the dsh credentials service (the web credentials page or the refs in ~/.dsh/.credentials.yaml) and never lands in settings.yaml; clearing it restores the default ref name",
  },
};
