import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // node/no-sync 的例外按文件声明。基线里只放只读那一组（existsSync/readFileSync/readdirSync/
  // readSync/realpathSync/statSync），用到别的就要写明是哪个文件 —— 例外不会扩散到别的文件，
  // src/、lib/ 里再写这些调用照样报错。
  // `openSync`/`closeSync` 是 host.ts 的 headExcerpt 在用：spill 文件可能有几 MB，用文件描述符只读前 4 KiB。
  // `mkdirSync`/`rmSync`/`writeFileSync` 只有测试夹具在用（造现场、清现场、落夹具）。
  syncIoScopes: [
    { files: ["host.ts"], apis: ["openSync", "closeSync"] },
    { files: ["test/**"], apis: ["mkdirSync", "rmSync", "writeFileSync"] },
  ],
  titlePrefixes: ["EditAccumulator", "TypeScript"],
});
