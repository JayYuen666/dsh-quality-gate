// 卡片客户端的**宿主运行时 API 面**门禁：卡片在宿主页面里拿到的是平台冻结的 zod
// （实测 0.2.2-alpha.2 冻结 4.4.3），而单仓测试与构建用的是 catalog 的 4.6.7——
// 两版的 API 面不同（4.4.3 无 `.validate`），单仓测试全绿也可能在真宿主里崩
// （实测：`.validate` 在槽位挂载时抛 TypeError，设置表单静默消失）。
// 这道静态门禁钉"产物不得调用宿主 zod 缺失的方法"，与 B 回路的真宿主验收互补。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/** 宿主冻结 zod（4.4.3）缺失、而 catalog zod（4.6.7）提供的 API 清单。
 *  新增调用面前先到 harness 的 node_modules 里核冻结版本的真实面。 */
const HOST_MISSING_ZOD_APIS = [".validate("] as const;

/** 卡片源码面：client-entry 与它直接引用的 src 模块（不含测试）。 */
const CLIENT_SOURCES = ["src/client-entry.ts"] as const;

describe("客户端 zod API 面对宿主冻结版本的兼容门", () => {
  it("卡片源码不得调用宿主 zod 缺失的 API（真宿主实测的崩溃形状）", () => {
    for (const source of CLIENT_SOURCES) {
      const text = readFileSync(path.resolve(import.meta.dirname, "..", source), "utf8");
      for (const api of HOST_MISSING_ZOD_APIS) {
        assert.equal(
          text.includes(api),
          false,
          `${source} 调用了宿主冻结 zod 缺失的 ${api}：单仓测试绿、真宿主槽位崩`,
        );
      }
    }
  });

  it("构建产物同样不得含该调用面（构建回归的第二道锚）", () => {
    const text = readFileSync(path.resolve(import.meta.dirname, "..", "client.js"), "utf8");
    for (const api of HOST_MISSING_ZOD_APIS) {
      assert.equal(text.includes(api), false, `client.js 产物含 ${api}`);
    }
  });
});
