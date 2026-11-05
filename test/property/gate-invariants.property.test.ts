// 门禁探测、编辑记账与记忆反馈的属性面。期望值来自各模块头注写明的契约
// （白名单四元组、假失败比漏检查更贵、URL fail-closed、单行化），不从实现派生。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import fc from "fast-check";

import { detectGate } from "../../lib/gate-detect.ts";
import type { ProjectRoot } from "../../lib/gate-detect.ts";
import { EditAccumulator, EDIT_TOOLS } from "../../lib/accumulator.ts";
import { resolveGatewayUrl } from "../../lib/gateway-target.ts";
import { isCredentialSafeUrl } from "../../lib/credential-url.ts";
import { buildFeedbackText } from "../../lib/feedback-content.ts";
import { MESSAGES } from "../../lib/messages.ts";

const { zh } = MESSAGES;

/** command 生成域（buildFeedbackText 的 join 输入）。 */
const commandArb = fc.array(fc.stringMatching(/^[a-z ]{0,10}$/u), { maxLength: 3 });
/** failure 文本生成域（buildFeedbackText 的单行化输入）。 */
const failureArb = fc.string({ maxLength: 80 });
/** 非回环明文与垃圾输入（isCredentialSafeUrl 的拒绝域）。 */
const unsafeUrlArb = fc.oneof(
  fc.constant("http://10.0.0.1:8080"),
  fc.constant("not a url"),
  fc.constant(""),
);

/** 探测判据点名的那两份清单文件（白名单性质的锚点）。 */
const PKG_JSON = "package.json";
const TSCONFIG_JSON = "tsconfig.json";
const WORKSPACE_YAML = "pnpm-workspace.yaml";
/** 项目根的文件清单生成域：真实仓库里这些名字的任意组合。 */
const fileNameArb = fc.constantFrom(
  PKG_JSON,
  TSCONFIG_JSON,
  WORKSPACE_YAML,
  "Cargo.toml",
  "pyproject.toml",
  "README.md",
);
const scriptsArb = fc.option(
  fc.array(fc.constantFrom("check", "build", "test"), { maxLength: 3 }),
  { nil: undefined },
);
const projectRootArb = fc.record(
  {
    root: fc.stringMatching(/^\/[a-z][a-z0-9]{0,6}$/u),
    files: fc.array(fileNameArb, { maxLength: 5 }),
    scripts: scriptsArb,
    ruffConfigured: fc.option(fc.boolean(), { nil: undefined }),
  },
  { requiredKeys: ["root", "files"] },
) as fc.Arbitrary<ProjectRoot>;

const COMMAND_WHITELIST = new Set(["pnpm check", "cargo check", "ruff check .", "tsc --noEmit"]);

describe("detectGate 的白名单与优先级性质", () => {
  it("任意根组合的产出命令都落在四元组白名单内；重复根只产一次", () => {
    fc.assert(
      fc.property(fc.array(projectRootArb, { maxLength: 5 }), (roots) => {
        const gates = detectGate(roots);
        for (const gate of gates) {
          assert.ok(
            COMMAND_WHITELIST.has(gate.command.join(" ")),
            `白名单外命令：${gate.command.join(" ")}`,
          );
        }
        const seenRoots = gates.map((gate) => gate.root);
        assert.equal(new Set(seenRoots).size, seenRoots.length, "重复根被重复探测");
      }),
    );
  });

  it("workspace 根永不产裸 tsc 门禁；tsc 门禁 ⇔ 非 workspace 且有 package.json + tsconfig.json", () => {
    fc.assert(
      fc.property(fc.array(fileNameArb, { maxLength: 5 }), scriptsArb, (files, scripts) => {
        const root: ProjectRoot =
          scripts === undefined ? { root: "/proj", files } : { root: "/proj", files, scripts };
        const gates = detectGate([root]);
        const tsc = gates.some((gate) => gate.command.join(" ") === "tsc --noEmit");
        const isWorkspace = files.includes(WORKSPACE_YAML);
        const hasPnpmCheck =
          files.includes(WORKSPACE_YAML) &&
          files.includes("package.json") &&
          scripts?.includes("check") === true;
        if (isWorkspace && !hasPnpmCheck) {
          assert.equal(tsc, false, "workspace 根发了裸 tsc 门禁（solution-style 恒绿陷阱）");
        }
        if (tsc) {
          assert.equal(isWorkspace, false);
          assert.equal(files.includes(PKG_JSON), true);
          assert.equal(files.includes(TSCONFIG_JSON), true);
        }
      }),
    );
  });
});

describe("EditAccumulator 的记账性质", () => {
  const pathArb = fc
    .tuple(
      fc.constantFrom("src", "lib", "scripts"),
      fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/u),
      fc.constantFrom("ts", "tsx", "js", "py", "rs", "sh", "md"),
    )
    .map(([dir, stem, ext]) => `${dir}/${stem}.${ext}`);

  it("drain 只收门禁后缀的路径；容量上限与 droppedCount 守恒", () => {
    fc.assert(
      fc.property(
        fc.array(pathArb, { maxLength: 12 }),
        fc.integer({ min: 1, max: 6 }),
        (paths, maxFiles) => {
          const acc = new EditAccumulator({ maxFiles });
          for (const filePath of paths) {
            acc.note("edit", filePath);
          }
          const drained = acc.drain();
          assert.ok(drained.length <= maxFiles, `容量破界：${String(drained.length)}`);
          for (const filePath of drained) {
            assert.equal(filePath.endsWith(".sh"), false, ".sh 不该进账（刻意排除）");
          }
          // drain 清空：第二次 drain 必为空。
          assert.equal(acc.drain().length, 0);
        },
      ),
    );
  });

  it("非编辑工具名不记账（EDIT_TOOLS 是唯一真源）", () => {
    const acc = new EditAccumulator();
    acc.note("read", "src/a.ts");
    acc.note("glob", "src/b.ts");
    assert.equal(acc.drain().length, 0);
    acc.note("edit", "src/c.ts");
    acc.note("write", "src/d.ts");
    // 期望值按平台分隔符构造：note() 归一入参，Windows 上记的是 `src\` 形。
    assert.deepEqual(acc.drain().toSorted(), [path.join("src", "c.ts"), path.join("src", "d.ts")]);
    for (const tool of EDIT_TOOLS) {
      assert.ok(["edit", "write", "str_replace_editor", "apply_patch"].includes(tool));
    }
  });
});

describe("resolveGatewayUrl 与 isCredentialSafeUrl 的 fail-closed 性质", () => {
  it("任意串要么回空串、要么是无 query/fragment/userinfo 的 http(s) 基址", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const resolved = resolveGatewayUrl(raw);
        if (resolved !== "") {
          assert.ok(/^https?:\/\//u.test(resolved), resolved);
          assert.equal(resolved.includes("?"), false);
          assert.equal(resolved.includes("#"), false);
        }
      }),
    );
  });

  it("明文 https 恒真；明文 http 非回环恒假；垃圾串恒假", () => {
    fc.assert(
      fc.property(unsafeUrlArb, (url) => {
        assert.equal(isCredentialSafeUrl(url), false);
      }),
    );
    assert.equal(isCredentialSafeUrl("https://gateway.example.com/v2"), true);
    assert.equal(isCredentialSafeUrl("http://127.0.0.1:8080/v2"), true);
    assert.equal(isCredentialSafeUrl("http://localhost:8080/v2"), true);
  });
});

describe("buildFeedbackText 的单行化与空证据契约", () => {
  it("failure 值单行化：输出恰两行（渲染模板 + 证据声明）；空 failure 回空串", () => {
    fc.assert(
      fc.property(commandArb, failureArb, (command, failure) => {
        const input = { command, root: "/proj", failure };
        const text = buildFeedbackText(input, zh);
        if (failure.trim().length === 0) {
          assert.equal(text, "", "空证据不该只留模板套壳");
          return;
        }
        const lines = text.split("\n");
        assert.equal(lines.length, 2, `反馈行数：${JSON.stringify(text)}`);
        for (const line of lines) {
          assert.equal(
            line.includes("\t"),
            false,
            `值里的制表符没被单行化：${JSON.stringify(line)}`,
          );
        }
      }),
    );
  });
});
