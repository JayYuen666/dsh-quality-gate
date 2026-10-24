import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
export default definePackageConfig({
  // 分母刻意只收 host.ts + lib/**：src/ 不是"从不被执行"——client-card.test.ts 无头跑过
  // apply 接线与字典（ui-messages 现量 100%），但 client-entry 的大头是渲染面，要 DOM
  // 基座才能测，本包不引 react-dom/jsdom；整体计进来会把 100% 阈值变成常红。这一口径
  // 在两份 README 的覆盖率小节对外写明。
  coverageInclude: ["host.ts", "lib/**/*.ts"],
  test: {
    setupFiles: ["test/setup-logs.ts"],
  },
});
