// build-host.mjs 的类型声明（给 test/build-host.test.ts 这类 TS 文件做带类型的导入）。
export function buildHost(): Promise<string>;
/**
 * 单文件产物只接受唯一一个带正文的 entry chunk；多出 chunk 或 asset 直接构建失败。
 *
 * 签名从 shared 的实现处转导出，而不是自己抄一份：本包只做转导出。手写一份的话，shared 改签名时
 * 这里就悄悄跟不上了（tsc 优先用本声明，`@ts-check` 不会交叉校验）。
 * @throws {Error} 输出项不是恰好一项、那一项不是 entry chunk、或者它的正文为空时抛出
 */
export { singleEntryChunk } from "@jayyuen66/dsh-plugin-shared/lib/build-artifacts";
