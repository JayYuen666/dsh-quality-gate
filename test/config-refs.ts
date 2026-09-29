// test/config-refs.ts —— 0.1.7 隐式注册的测试桩件（本包三个 host 测试共用）。
//
// 背景：0.1.7 删掉了 `settings.register(ns, schema, { base })`。命名空间变成**隐式**的
// （= profile 条目 id，见 cordis.patch.yml），可编辑字段由 schema 上的 `.volatile()`
// 声明，内置默认从「register 的第二层底座」搬进 schema 的 `.default()`；交进 apply 的
// 每个 volatile 字段是一枚 **Volatile 引用**（读当前值 `.get()`），不再是普通值快照。
// 于是 mock 不能再造一个 `scope.get()`：必须复刻宿主真正交给插件的那份形状。
//
// 这里只做一件事：从**导出**的 Config schema 反推字段名/默认/投影，测试里不手写清单，
// 漏字段就是测试红（而不是"两份各自漂移"）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "../host.ts";

/** Config schema 的字段节点（读 meta/type/dict 用，不复制 schema 结构）。 */
export interface SchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
}

/** 一次 settings.configure() 的调用记录（页面策略断言用）。 */
export interface ConfigureCall {
  presentation: { auto?: boolean };
  owner: unknown;
}

/** settings.describe() 的一行（宿主给全量 SettingsDescriptor，本包只读这两个字段）。 */
export interface DescribeRow {
  ns: string;
  value: unknown;
}

/** 导出 Config schema 的 dict（字段名与元数据都从宿主实际读的那份来）。 */
export function configDict(): Record<string, SchemaNode> {
  return (plugin.Config as unknown as SchemaNode).dict ?? {};
}

/**
 * 复刻 cordis 交进 apply 的那份 Config（W4 起形状是**混合**的，实测宿主 fork 的
 * schemastery resolve：volatile 字段包成 Volatile 引用、非 volatile 字段是普通值）：
 *  - volatile 字段 → 一枚**稳定引用**，get() 现读 value——与真实 Volatile 的
 *    "引用不变、值可变"同构（cosmokit createVolatile 也只有一个 get()，
 *    见 harness vendor/cosmokit/src/volatile.ts）；
 *  - 非 volatile 字段（maxRootDepth/gateStdoutMaxBytes，部署假定值）→ 普通值原样透传。
 * 判据读 schema 的 meta.volatile（单源）：漏标 .volatile() 的字段会在这里自动退回普通值，
 * 测试随宿主口径走，不另维护一份清单。
 */
export function refsOf(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) =>
      field.meta?.["volatile"] === true ? [key, { get: () => value[key] }] : [key, value[key]],
    ),
  );
}

/** apply + 它的 Config：0.1.7 的 config 是引用而不是快照，两处必须同源。 */
export function applyGate(ctx: unknown, value: Record<string, unknown>): void {
  plugin.apply(ctx as never, refsOf(value) as never);
}

/** 逐字段 schema 默认 —— 等价于 0.1.6 交给 `settings.register(ns, schema, { base })`
 *  的那份底座，0.1.7 把它搬到了 schema 的 `.default()` 上（少一层「底座」）。 */
export function schemaDefaults(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) => [key, field.meta?.["default"]]),
  );
}

/**
 * 复刻宿主 packages/settings/settings/src/schema.ts:37-47 的 volatileForm()：
 * 「自身标了 volatile」或「是 object 且子树里有可编辑字段」的字段才进表单。
 * @returns 顶层 object 时给表单字段名清单；叶子可编辑时给 []；
 *  null = 该子树没有任何可编辑字段 → 宿主 describe() 会整条跳过本条目
 *  （settings/src/index.ts:308-309），写入则抛 `has no volatile fields`（:386）。
 *  （用 null 而不是 undefined 表"没有"：本仓 lint 的 consistent-return 把
 *  `return undefined` 记作无值返回，与同函数里的 `return []` 冲突。）
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

/** cordis.patch.yml 里的裸条目 id —— 0.1.7 的 settings 命名空间就是它。
 *  读文件而不是抄常量：卡片与命名空间两处都按它对齐，写死会让测试与包体漂移。 */
export function patchEntryId(): string {
  const yml = readFileSync(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)), "utf8");
  const match = /^\s*-\s+id:\s*(?<id>\S+)\s*$/mu.exec(yml);
  const id = match?.groups?.["id"];
  assert.ok(typeof id === "string" && id.length > 0, "cordis.patch.yml 里没有裸 `- id:` 条目");
  return id;
}
