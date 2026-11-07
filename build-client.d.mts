/** build-client.mjs 的类型声明（给 test/build-client.test.ts 这类 TS 文件做带类型的导入）。 */
export function buildClient(): Promise<string>;
/** 跟随 shared 的构建配置一起外置的 React 运行时模块名单（本包 build-client.mjs 原样转导出，名单由 shared 在一处维护）。 */
export { REACT_RUNTIME_MODULES } from "@jayyuen66/dsh-plugin-shared/lib/build-client";
/**
 * 单文件产物只接受唯一一个带正文的 entry chunk；多出 chunk 或 asset 直接构建失败。
 *
 * 签名从 shared 的实现处转导出，而不是自己抄一份：本包只做转导出。手写一份的话，shared 改签名时
 * 这里就悄悄跟不上了（tsc 优先用本声明，`@ts-check` 不会交叉校验）。
 * @throws {Error} 输出项不是恰好一项、那一项不是 entry chunk、或者它的正文为空时抛出
 */
export { singleEntryChunk } from "@jayyuen66/dsh-plugin-shared/lib/build-artifacts";
