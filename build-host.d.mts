// build-host.mjs 的声明（供 test/build-host.test.ts 等 TS 侧类型化导入）。
export function buildHost(): Promise<string>;
/**
 * 单文件产物只接受唯一的带正文 entry chunk；多余 chunk / asset 直接构建失败。
 *
 * 签名从 shared 的实现处再导出而不是手抄：本包只做转导出，手写一份就在 shared 改签名时
 * 静默漂移（tsc 优先用本声明，`@ts-check` 不会交叉校验）。
 * @throws {Error} 输出项多于/少于 1 项、唯一项不是 entry chunk、或 entry chunk 正文为空时抛出
 */
export { singleEntryChunk } from "@jayyuen66/dsh-plugin-shared/lib/build-artifacts";
