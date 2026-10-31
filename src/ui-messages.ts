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
  /** 作用域只读（非 loopback 页面）时的状态条文本。 */
  readonly statusReadOnly: string;
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
  /** 网关地址不接受：带 userinfo，或明文 http 指向非回环地址。 */
  readonly invalidGatewayUrl: string;
  /** 凭据引用名不接受：宿主只认 [A-Za-z_][A-Za-z0-9_]*。 */
  readonly invalidKeyRef: string;
  /** 数字输入越界/非法时的行内提示。 */
  readonly outOfRange: string;
  /** 门禁小节标题。 */
  readonly gateSection: string;
  /** 记忆反馈小节标题。 */
  readonly memorySection: string;
  /** 配额单位。 */
  readonly unitTimes: string;
  /** 时长单位。 */
  readonly unitSeconds: string;
  /** 保存条脏状态（{count} 为改动条数）。 */
  readonly dirtyCount: string;
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
 * merge 之后键集由官方 `TranslateNS<NS>`（`dsh-client-ui-slots/lib/types/index.d.ts:67`，
 * `= Translate<LocaleKeysOf<N>>`，:45/:59）表达，`t("拼错的键")` 在编译期红。
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
 * 卡片取文案的函数形状：官方 `TranslateNS<N>`（installed `dsh-client-ui-slots/lib/types/index.d.ts:67`，
 * `= Translate<LocaleKeysOf<N>>`，而 `Translate<K> = (key: K, params?) => string`，同文件 `:45`）——
 * 键域就是上面 merge 的 `keyof UiMessages` **并上**官方 `common`
 * 命名空间的共享词（官方 `LocaleKeysOf` 的并集：宿主查找链在本命名空间 miss 之后确实
 * 会去 consult common，见 installed dsh-client-locale/lib/client.js:1425），函数面完全归官方。
 */
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    statusReadOnly: "当前作用域只读",
    statusClean: "无未保存的修改",
    save: "保存",
    saving: "保存中…",
    revert: "撤销",
    saveFailed: "保存失败：{message}",
    saveRejected: "保存被宿主拒绝（配置校验未通过或写入被跳过），修改未生效",
    invalidGatewayUrl:
      "网关地址不接受：不能带用户名/口令；远端地址必须是 https，明文 http 只允许本机回环",
    invalidKeyRef: "凭据引用名不接受：只能由字母、数字、下划线组成，且不能以数字开头",
    outOfRange: "超出允许范围，未保存",
    gateSection: "门禁",
    memorySection: "记忆反馈",
    unitTimes: "次",
    unitSeconds: "秒",
    dirtyCount: "已修改 {count} 项",
    enabledLabel: "启用质量门禁",
    enabledHint: "关闭后回合收口不再跑门禁（模型可带病收口）",
    injectsLabel: "每会话注入配额",
    injectsHint: "门禁失败后最多注入几次修复指令；配额按会话累计，门禁通过后重置",
    budgetLabel: "门禁总预算",
    budgetHint:
      "一次回合内所有门禁共享的总耗时预算（多根均分）；超时按「未能执行」注入，不静默放行",
    memoryLabel: "门禁失败沉淀记忆",
    memoryHint:
      "默认关闭。开启后：代码型门禁失败的证据（命令/根/全文报错，不截断）写入记忆网关的 L0 会话层供后续会话召回；总线 lesson-loop 的同步上报不受此开关影响。关闭后只注入不沉淀。投递要求网关地址与凭据引用都可用（见下面两项）",
    gatewayUrlLabel: "记忆网关地址",
    gatewayUrlHint:
      "插件不带任何默认地址：本机用户请填自己的网关地址（例如 http://127.0.0.1:8420），没有网关就让它空着。此项留空时回落到环境变量 TDAI_GATEWAY_URL，两处都空才算未配置、不启用记忆反馈。远端地址必须 https，明文 http 只允许本机回环（127.0.0.0/8、::1、localhost）",
    keyRefLabel: "网关密钥引用",
    keyRefHint:
      "网关鉴权令牌的凭据引用名（环境变量名形态，默认 TDAI_GATEWAY_KEY）。这里存的只是引用名，密钥值由 dsh 凭据服务管理（Web 凭据页或 ~/.dsh/.credentials.yaml 的 refs），不会写进 settings.yaml；清空即恢复默认引用名，而不是停用记忆反馈",
  },
  en: {
    statusReadOnly: "This scope is read-only",
    statusClean: "No unsaved changes",
    save: "Save",
    saving: "Saving…",
    revert: "Revert",
    saveFailed: "Save failed: {message}",
    saveRejected:
      "Save rejected by the host (validation failed or write skipped) — changes not applied",
    invalidGatewayUrl:
      "Gateway URL rejected: it must not embed credentials; remote addresses must use https, plain http is only allowed for loopback",
    invalidKeyRef:
      "Credential reference rejected: use letters, digits and underscores only, and do not start with a digit",
    outOfRange: "Out of the allowed range — not saved",
    gateSection: "Gate",
    memorySection: "Memory feedback",
    unitTimes: "times",
    unitSeconds: "seconds",
    dirtyCount: "{count} changed",
    enabledLabel: "Enable the quality gate",
    enabledHint: "When off: no gate runs at turn end (the model may close a turn with broken code)",
    injectsLabel: "Repair injections per session",
    injectsHint:
      "How many repair instructions a failing gate may inject; the quota accumulates across turns in one session and resets after a clean gate pass",
    budgetLabel: "Gate total budget",
    budgetHint:
      'Shared time budget for all gates in one turn (split across project roots); a timeout is injected as "could not run", never as a silent pass',
    memoryLabel: "Persist gate failures to memory",
    memoryHint:
      "Off by default. When on: the evidence of code-level gate failures (command, root, full error text, untruncated) is written into the memory gateway's L0 session layer so later sessions can recall it; synchronous reporting to the lesson-loop bus is unaffected by this switch. When off, repairs are injected but nothing is persisted. Delivery requires both the gateway URL and the credential ref to be usable (see the two fields below)",
    gatewayUrlLabel: "Memory gateway URL",
    gatewayUrlHint:
      "The plugin ships no default address: fill in your own gateway URL (e.g. http://127.0.0.1:8420), or leave it empty if you have no gateway. When this is empty the TDAI_GATEWAY_URL environment variable is used instead; only when both are empty is memory feedback unconfigured and disabled. Remote addresses must use https; plain http is only allowed for loopback (127.0.0.0/8, ::1, localhost)",
    keyRefLabel: "Gateway credential ref",
    keyRefHint:
      "Name of the credential holding the gateway token (POSIX env-var form, default TDAI_GATEWAY_KEY). Only the ref name is stored here — the secret itself is managed by the dsh credentials service (the web credentials page or the refs in ~/.dsh/.credentials.yaml) and never lands in settings.yaml; clearing it restores the default ref name rather than disabling memory feedback",
  },
};
