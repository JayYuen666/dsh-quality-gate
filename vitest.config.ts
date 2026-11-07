import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共部分（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）只有一个来源，在 shared/config/vitest.base.ts；这里只留本包的差异。
export default definePackageConfig({
  // 覆盖率统计范围收 host.ts + lib/** + src/ui-messages.ts：ui-messages 是一份纯字典，client-card.test.ts
  // 不用浏览器就能覆盖它，算进统计范围可以让 100% 阈值真的管住这份字典（新增键没测到就直接报错）；
  // src/client-entry.ts 不算进来——它的主要内容是界面渲染，需要 DOM 环境才能测，本包不引
  // react-dom/jsdom，整个算进来会让阈值一直不通过。这个统计范围在两份 README 的覆盖率小节里
  // 对外写明。
  coverageInclude: ["host.ts", "lib/**/*.ts", "src/ui-messages.ts"],
  test: {
    setupFiles: ["test/setup-logs.ts"],
  },
});
