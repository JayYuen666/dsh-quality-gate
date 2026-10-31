import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
export default definePackageConfig({
  // 分母收 host.ts + lib/** + src/ui-messages.ts：ui-messages 是纯字典，client-card.test.ts
  // 无头执行即可覆盖它，计进分母让 100% 阈值真正守住这份字典（新增键漏测会直接红）；
  // src/client-entry.ts 留在分母外——它的主体是渲染面，要 DOM 基座才能测，本包不引
  // react-dom/jsdom，整体计进来会把阈值变成常红。这一口径在两份 README 的覆盖率小节
  // 对外写明。
  coverageInclude: ["host.ts", "lib/**/*.ts", "src/ui-messages.ts"],
  test: {
    setupFiles: ["test/setup-logs.ts"],
  },
});
