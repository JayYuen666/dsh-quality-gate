import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // node/no-sync 的包内例外。基线只放只读那一组（existsSync/readFileSync/readdirSync/readSync/
  // realpathSync/statSync），读写类谁用谁在这里声明，所以这一条是可独立 review 的声明而非全局豁免表。
  //
  // `openSync`/`closeSync` 是本包生产代码唯一的同步 API 用途（host.ts 的 headExcerpt：spill 文件
  // 可达数 MB，用 fd 只读前 4 KiB）；`mkdirSync`/`rmSync`/`writeFileSync` 只有测试夹具在用，
  // 而这条 allowlist 是全局的、不区分 test 与 src，所以删掉它们会让三个测试文件整片报错。
  syncWrites: ["closeSync", "mkdirSync", "openSync", "rmSync", "writeFileSync"],
  titlePrefixes: ["EditAccumulator", "TypeScript"],
});
