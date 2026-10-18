// 产物体积预算：钉的是「第三方实现被内联进发布物」这一类跳变。
//
// 为什么用字节数当判据：这类回归没有更早的报警器。类型检查照绿（外部化与否不影响类型），
// 单测照绿（本包的测试在源码侧跑），装出去才发现产物里多了一份官方实现的副本——而副本正是
// 「同一个契约两份声明、各自漂移」事故的起点。所以预算按当前体积上浮一档，只关心**量级**：
// 正常改文案改逻辑碰不到这个数量级，把整包依赖吃进来一定会。
import { statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

/** 每个产物的字节上限。 */
const BUDGETS: readonly { readonly file: string; readonly maxBytes: number }[] = [
  // 上限够容纳若干轮文案与判据的增长，不够容纳一枚宿主包的函数体。
  { file: "host.js", maxBytes: 96 * 1024 },
  // client 半只有一张设置卡，翻倍即说明有东西被错误打包进来。
  { file: "client.js", maxBytes: 32 * 1024 },
];

describe("发布产物体积", () => {
  it.each(BUDGETS)("$file 不超过 $maxBytes 字节", ({ file, maxBytes }) => {
    const stats = statSync(path.join(pkgDir, file));
    expect(stats.isFile(), `${file} 不在盘上：先跑 pnpm run build && pnpm run build:client`).toBe(
      true,
    );
    expect(stats.size, `${file} 当前 ${stats.size} 字节，预算 ${maxBytes}`).toBeLessThan(maxBytes);
  });
});
