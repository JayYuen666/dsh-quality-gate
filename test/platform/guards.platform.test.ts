// 跨平台的判据：shell 的引号处理（tsc 的绝对路径可能带空格或单引号）、编辑路径归一在三种平台上的
// 语义（POSIX 上反斜杠是文件名字符）、CRLF 写法的 pyproject 与 ruff门禁的探测。全部是纯函数，
// 三平台 CI 都真跑。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import { detectGate } from "../../lib/gate-detect.ts";
import { shellArg } from "../../host.ts";
import { EditAccumulator } from "../../lib/accumulator.ts";

const BACKSLASH_PATH = `src${String.fromCodePoint(92)}a.ts`;

describe("shellArg 的 posix 引号语义", () => {
  it("安全字符原样；含空白或单引号的参数加单引号并转义", () => {
    assert.equal(shellArg("tsc"), "tsc");
    assert.equal(shellArg("/opt/my tools/tsc"), "'/opt/my tools/tsc'");
    // 含单引号的路径：'\'' 那三段式写法（和 ocr-review、zvec-grep 的 shq 用的是同一种写法）。
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

describe("编辑路径归一在各平台上的语义", () => {
  it("posix 上反斜杠是文件名字符：带反斜杠的路径不会被换成平台分隔符，仍然按门禁用的后缀记录下来", () => {
    const acc = new EditAccumulator();
    acc.note("edit", BACKSLASH_PATH);
    assert.deepEqual(acc.drain(), [BACKSLASH_PATH]);
  });

  it("正斜杠路径照常记录；.sh 刻意排除（用探测脚本实测之后定下的取舍）", () => {
    const acc = new EditAccumulator();
    acc.note("edit", "src/a.ts");
    acc.note("edit", "scripts/run.sh");
    // 期望值按当前平台的分隔符写：note() 会 path.normalize，Windows 上 `src/a.ts` 记成
    // `src\` 形。这一条判的是「正斜杠入参照样进账、.sh 不进」，不是那串字节长什么样。
    assert.deepEqual(acc.drain(), [path.join("src", "a.ts")]);
  });
});

describe("ruff门禁的探测所接受的输入形状", () => {
  it("ruffConfigured=true 且有 pyproject.toml 才给出 ruff 这条门禁；false 和 undefined 都不给", () => {
    const files = ["pyproject.toml", "src/x.py"];
    assert.deepEqual(detectGate([{ root: "/proj", files, ruffConfigured: true }]), [
      { root: "/proj", command: ["ruff", "check", "."] },
    ]);
    assert.deepEqual(detectGate([{ root: "/proj", files, ruffConfigured: false }]), []);
    assert.deepEqual(detectGate([{ root: "/proj", files }]), []);
  });

  it("crlf 写法的内容不影响判断：ruffConfigured 是调用方读出来的布尔值，这一层只看它", () => {
    // pyproject.toml 用 CRLF 写到磁盘时，段头的正则在读取那一步就去掉了行尾；这一层只接布尔值。
    const files = ["pyproject.toml", "src/x.py"];
    assert.deepEqual(detectGate([{ root: "/crlf-proj", files, ruffConfigured: true }]), [
      { root: "/crlf-proj", command: ["ruff", "check", "."] },
    ]);
  });
});
