import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
export default definePackageConfig({
  // 只统计宿主/门禁逻辑：设置卡渲染面（src/）从不被这些用例执行——本包刻意不引
  // react-dom/jsdom，补渲染测试是另一套基座。把这半边计进来会把 100% 阈值变成常红，
  // 而"绿的面比被验的面小"这件事在 README 的覆盖声明里写明。
  coverageInclude: ["host.ts", "lib/**/*.ts"],
  test: {
    setupFiles: ["test/setup-logs.ts"],
  },
});
