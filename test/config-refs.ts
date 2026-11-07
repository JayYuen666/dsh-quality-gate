// test/config-refs.ts —— 0.1.7 隐式注册对应的测试替身（本包的 host 测试共用）。
//
// 背景：0.1.7 删掉了 `settings.register(ns, schema, { base })`。命名空间变成**隐式**的
// （= profile 条目 id，见 cordis.patch.yml），可编辑字段由 schema 上的 `.volatile()`
// 声明，内置默认从"register 的第二层 base"搬进 schema 的 `.default()`；交进 apply 的
// 每个 volatile 字段是一个 **Volatile 引用**（读当前值用 `.get()`），不再是普通值的快照。
// 所以测试替身不能再造一个 `scope.get()`：必须做出宿主真正交给插件的那种结构。
//
// 这里只做一件事：从**导出**的 Config schema 反推字段名、默认值和表单投影，测试里不手写清单，
// 漏了字段就让测试失败（而不是"两份清单各改各的"）。

import assert from "node:assert/strict";
import plugin from "../host.ts";
import type { ConfigShape } from "../host.ts";

/** Config schema 的字段节点（用来读 meta/type/dict，不复制 schema 的结构）。 */
export interface SchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
}

/** 一次 settings.configure() 的调用记录（用来断言页面策略）。 */
export interface ConfigureCall {
  presentation: { auto?: boolean };
  owner: unknown;
}

/** settings.describe() 返回的一行（宿主给的是完整的 SettingsDescriptor，本包只读这两个字段）。 */
export interface DescribeRow {
  ns: string;
  value: unknown;
}

/** 导出 Config schema 的 dict（字段名和元数据都来自宿主实际读取的那一份）。 */
export function configDict(): Record<string, SchemaNode> {
  const { dict } = plugin.Config as unknown as SchemaNode;
  // 不能写 `?? {}`：拿不到 dict 时所有字段断言会对着一个空集合走空（"一个字段都没有"和"读不到"看不出区别）。
  assert.ok(dict !== undefined, "导出 Config schema 不是带 dict 的 object 节点：读不到字段列表");
  return dict;
}

/**
 * 做出 cordis 交进 apply 的那份 Config（结构是**混合**的，实测宿主 fork 的
 * schemastery resolve：volatile 字段包成 Volatile 引用、非 volatile 字段是普通值）：
 *  - volatile 字段 → 一个**引用地址不变**的对象，get() 现读 value——和真实 Volatile 的
 *    "引用不变、值可变"一致（cosmokit 的 createVolatile 也只有一个 get()，
 *    见 harness vendor/cosmokit/src/volatile.ts）；
 *  - 非 volatile 字段（maxRootDepth、gateStdoutMaxBytes，部署用的默认值）→ 普通值直接传过去。
 * 这里读 schema 的 meta.volatile 来决定（只有一处来源）：没标 .volatile() 的字段会自动退回普通值，
 * 测试跟着宿主的做法走，不再维护第二份清单。
 */
export function refsOf(value: Record<string, unknown>): Record<string, unknown> {
  const dict = configDict();
  // 先把两边键对齐再转换：多给的键会被 Object.entries 丢弃而不提示，少给的键会以 undefined
  // 交给 apply，或者包成一个 get() 永远返回 undefined 的引用——两种都是静默失败，测试却照样通过。
  const missing = Object.keys(dict).filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !Object.hasOwn(dict, key));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    "refsOf：传入的 value 与 Config schema 的字段集不一致",
  );
  return Object.fromEntries(
    Object.entries(dict).map(([key, field]) =>
      field.meta?.["volatile"] === true ? [key, { get: () => value[key] }] : [key, value[key]],
    ),
  );
}

/** apply 和它要的 Config：0.1.7 的 config 是引用而不是快照，两处必须来自同一个地方。
 *  第二个参数的类型收窄到导出的 `ConfigShape`（不是 Record）：apply 的签名一变，这一行就先报错，
 *  而这个替身存在的意义正是"两边的做法不一致时要报错"。ctx 仍然只能做强行转换——宿主的 Context
 *  接口太大，在测试里完整复刻等于把宿主的类型抄一遍。 */
export function applyGate(ctx: unknown, value: Record<string, unknown>): void {
  plugin.apply(ctx as never, refsOf(value) as unknown as ConfigShape);
}

/** 逐字段读出 schema 里的默认值 —— 相当于 0.1.6 交给 `settings.register(ns, schema, { base })`
 *  的那份 base，0.1.7 把它搬到了 schema 的 `.default()` 上（少了一层 base）。 */
export function schemaDefaults(): Record<string, unknown> {
  // 每个字段都必须声明 .default()：按**值**判断有没有（`"default" in meta` 会把
  // `.default(undefined)` 也算成已经声明，随后把 undefined 当部署值交给 apply）。
  // 本 schema 的字段都是 boolean、natural 或 string，undefined 不是合法的默认值。
  const missing = Object.entries(configDict())
    .filter(([, field]) => field.meta?.["default"] === undefined)
    .map(([key]) => key);
  assert.deepEqual(missing, [], "Config schema 里有字段没写 .default()：新增字段忘了默认值");
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) => [key, field.meta?.["default"]]),
  );
}

/**
 * 做出宿主 packages/settings/settings/src/schema.ts:37-47 的 volatileForm() 的结果：
 * "自己标了 volatile"或者"是 object 且子树里有可编辑字段"的字段才进表单。
 * @returns 顶层是 object 时给出表单字段名清单；单个字段可编辑时给 []；
 *  null = 这个子树里没有任何可编辑字段 → 宿主的 describe() 会整条跳过本条目
 *  （settings/src/index.ts:308-309），写入则抛 `has no volatile fields`（:386）。
 *  （用 null 而不是 undefined 表示"没有"：本仓 lint 的 consistent-return 会把
 *  `return undefined` 记成无值返回，和同一个函数里的 `return []` 冲突。）
 */
export function volatileFormOf(node: SchemaNode): string[] | null {
  if (node.meta?.["volatile"] === true) {
    return [];
  }
  if (node.type !== "object") {
    return null;
  }
  const kept = Object.entries(node.dict ?? {}).flatMap(([key, child]) =>
    volatileFormOf(child) === null ? [] : [key],
  );
  return kept.length === 0 ? null : kept;
}

/** cordis.patch.yml 里本 bundle 的裸条目 id —— 0.1.7 的 settings 命名空间就是它。
 *  实现只有一份（profile-bundle.ts：按 `name:` 定位到本包的条目，认引号和行尾注释，
 *  有多条 insert 时不会取到别人的 id）；这里只是再导出一次，不再维护第二份解析。 */
export { patchEntryId } from "./profile-bundle.ts";
