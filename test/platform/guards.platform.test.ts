// 跨平台判据：shell 引号处理（tsc 绝对路径可能带空格/单引号）、编辑路径归一的平台
// 语义（POSIX 上反斜杠是文件名字符）、CRLF 的 pyproject 与 ruff 门禁探测。全部纯函数，
// 三平台 CI 都真跑。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { detectGate } from "../../lib/gate-detect.ts";
import { shellArg } from "../../host.ts";
import { EditAccumulator } from "../../lib/accumulator.ts";

const BACKSLASH_PATH = `src${String.fromCodePoint(92)}a.ts`;

describe("shellArg 的 posix 引号语义", () => {
  it("安全字符原样；含空白或单引号的参数加单引号并转义", () => {
    assert.equal(shellArg("tsc"), "tsc");
    assert.equal(shellArg("/opt/my tools/tsc"), "'/opt/my tools/tsc'");
    // 含单引号的路径：'\'' 三段式（与 ocr-review / zvec-grep 的 shq 同一口径）。
    assert.equal(shellArg(String.raw`/opt/it's/tsc`), String.raw`'/opt/it'\''s/tsc'`);
  });

  it("引号往返：拼接后的串按同一规则可复原（真 shell 验证在 e2e 层）", () => {
    const tricky = "/dir with space/it's/tsc";
    const quoted = shellArg(tricky);
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
    // 转义段 `'\''` 的三段各自成对：' + \' + '。
    assert.equal(quoted.includes(String.raw`'\''`), true);
  });
});

describe("编辑路径归一的平台语义", () => {
  it("posix 上反斜杠是文件名字符：反斜杠路径不被折叠，仍按门禁后缀记账", () => {
    const acc = new EditAccumulator();
    acc.note("edit", BACKSLASH_PATH);
    assert.deepEqual(acc.drain(), [BACKSLASH_PATH]);
  });

  it("正斜杠路径照常记账；.sh 刻意排除（探针实测的取舍）", () => {
    const acc = new EditAccumulator();
    acc.note("edit", "src/a.ts");
    acc.note("edit", "scripts/run.sh");
    assert.deepEqual(acc.drain(), ["src/a.ts"]);
  });
});

describe("ruff 门禁探测的输入形状", () => {
  it("ruffConfigured=true 且有 pyproject.toml 才发 ruff 门禁；false 与 undefined 都不发", () => {
    const files = ["pyproject.toml", "src/x.py"];
    assert.deepEqual(detectGate([{ root: "/proj", files, ruffConfigured: true }]), [
      { root: "/proj", command: ["ruff", "check", "."] },
    ]);
    assert.deepEqual(detectGate([{ root: "/proj", files, ruffConfigured: false }]), []);
    assert.deepEqual(detectGate([{ root: "/proj", files }]), []);
  });

  it("crlf 内容不影响判定：ruffConfigured 是调用方读出来的布尔，门禁只看它", () => {
    // pyproject.toml 以 CRLF 落盘时，段头正则在读取侧消化行尾；判据面只收布尔。
    const files = ["pyproject.toml", "src/x.py"];
    assert.deepEqual(detectGate([{ root: "/crlf-proj", files, ruffConfigured: true }]), [
      { root: "/crlf-proj", command: ["ruff", "check", "."] },
    ]);
  });
});
