import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // node/no-sync 的例外按文件声明。基线只放只读那一组（existsSync/readFileSync/readdirSync/
  // readSync/realpathSync/statSync），其余谁用谁点名文件 —— 名单不外溢，src/、lib/ 再写这些
  // 调用照样报。
  // `openSync`/`closeSync` 是 host.ts 的 headExcerpt：spill 文件可达数 MB，用 fd 只读前 4 KiB。
  // `mkdirSync`/`rmSync`/`writeFileSync` 只有测试夹具在用（造现场、清现场、落夹具）。
  syncIoScopes: [
    { files: ["host.ts"], apis: ["openSync", "closeSync"] },
    { files: ["test/**"], apis: ["mkdirSync", "rmSync", "writeFileSync"] },
  ],
  titlePrefixes: ["EditAccumulator", "TypeScript"],
});
