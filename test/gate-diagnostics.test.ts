import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { diagnosticsFor } from "../lib/gate-diagnostics.ts";
import { repoRelativeDiagnostics, repositoryRootOf } from "../lib/repo-diagnostics.ts";

/** javac/Maven 在找不到符号时打的字面消息；三处断言共用一份，避免重复字面量。 */
const CANNOT_FIND_SYMBOL = "cannot find symbol";

describe("gate-diagnostics：按命令解析各语言的行列诊断", () => {
  it("tsc 复用 ts 解析器", () => {
    assert.deepEqual(
      diagnosticsFor(["tsc", "--noEmit"], "src/a.ts(12,5): error TS2322: bad type"),
      [{ path: "src/a.ts", line: 12, message: "bad type" }],
    );
  });

  it("go vet/test 的 file.go:line:col 形状", () => {
    assert.deepEqual(diagnosticsFor(["go", "vet", "./..."], "main.go:3:4: undefined: foo\n"), [
      { path: "main.go", line: 3, message: "undefined: foo" },
    ]);
  });

  it("cargo 的 error + --> 两行形状（blank 会重置未配对的 message）", () => {
    const text = [
      "error[E0308]: mismatched types",
      " --> src/main.rs:3:5",
      "",
      "error: could not compile `x`",
      "",
      "warning: unused",
    ].join("\n");
    assert.deepEqual(diagnosticsFor(["cargo", "check"], text), [
      { path: "src/main.rs", line: 3, message: "mismatched types" },
    ]);
  });

  it("cargo 的 messageMax/limit 生效", () => {
    const text = ["error: first", " --> a.rs:1:1", "error: second", " --> b.rs:2:2"].join("\n");
    assert.deepEqual(diagnosticsFor(["cargo", "check"], text, { messageMax: 3, limit: 1 }), [
      { path: "a.rs", line: 1, message: "fir" },
    ]);
  });

  it("ruff 的 file.py:line:col: CODE message", () => {
    assert.deepEqual(diagnosticsFor(["ruff", "check", "."], "src/a.py:3:1: E501 Line too long"), [
      { path: "src/a.py", line: 3, message: "E501 Line too long" },
    ]);
  });

  it("rubocop 的 severity 形状", () => {
    assert.deepEqual(
      diagnosticsFor(
        ["rubocop"],
        "lib/a.rb:3:1: C: Style/FrozenStringLiteralComment: Missing frozen string literal comment.",
      ),
      [
        {
          path: "lib/a.rb",
          line: 3,
          message: "Style/FrozenStringLiteralComment: Missing frozen string literal comment.",
        },
      ],
    );
  });

  it("javac 与 Maven 两种 Java 形状", () => {
    assert.deepEqual(
      diagnosticsFor(["mvn", "-q", "test"], "src/A.java:3: error: cannot find symbol"),
      [{ path: "src/A.java", line: 3, message: CANNOT_FIND_SYMBOL }],
    );
    assert.deepEqual(
      diagnosticsFor(["mvn", "-q", "test"], "[ERROR] /abs/A.java:[3,4] cannot find symbol"),
      [{ path: "/abs/A.java", line: 3, message: CANNOT_FIND_SYMBOL }],
    );
    assert.deepEqual(diagnosticsFor(["mvn", "-q", "test"], "[INFO] BUILD SUCCESS"), []);
  });

  it("dotnet 的 file(line,col): error CSxxxx 形状", () => {
    assert.deepEqual(
      diagnosticsFor(
        ["dotnet", "build", "--nologo"],
        "src/A.cs(3,4): error CS0103: name not found",
      ),
      [{ path: "src/A.cs", line: 3, message: "name not found" }],
    );
  });

  it("clang/gcc 的 file:line:col: error 形状", () => {
    assert.deepEqual(
      diagnosticsFor(["cmake", "--build", "build"], "src/a.cpp:3:4: error: no matching function"),
      [{ path: "src/a.cpp", line: 3, message: "no matching function" }],
    );
  });

  it("pHP 的 Parse/Fatal error 形状", () => {
    assert.deepEqual(
      diagnosticsFor(
        ["phpunit"],
        "PHP Parse error: syntax error, unexpected ';' in src/a.php on line 3",
      ),
      [{ path: "src/a.php", line: 3, message: "syntax error, unexpected ';'" }],
    );
  });

  it("eslint 的 file:line:col: message 形状", () => {
    assert.deepEqual(diagnosticsFor(["eslint", "."], "src/a.ts:3:4: Unexpected any."), [
      { path: "src/a.ts", line: 3, message: "Unexpected any." },
    ]);
  });

  it("limit 会截断通用收集器与 Java 解析器的条数", () => {
    assert.deepEqual(
      diagnosticsFor(["go", "vet", "./..."], "a.go:1:1: one\nb.go:2:2: two", { limit: 1 }),
      [{ path: "a.go", line: 1, message: "one" }],
    );
    assert.deepEqual(
      diagnosticsFor(["mvn", "-q", "test"], "A.java:1: error: one\nB.java:2: error: two", {
        limit: 1,
      }),
      [{ path: "A.java", line: 1, message: "one" }],
    );
  });

  it("所有解析器都接受 messageMax（截断只影响正文，不影响命中）", () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["ruff", "check", "."], "a.py:1:1: E1 long message"],
      [["rubocop"], "a.rb:1:1: C: long message"],
      [["dotnet", "build", "--nologo"], "a.cs(1,1): error CS1: long message"],
      [["cmake", "--build", "build"], "a.cpp:1:1: error: long message"],
      [["phpunit"], "PHP Fatal error: long message in a.php on line 1"],
      [["eslint", "."], "a.ts:1:1: long message"],
    ];
    for (const [command, text] of cases) {
      const parsed = diagnosticsFor(command, text, { messageMax: 4, limit: 1 });
      assert.equal(parsed.length, 1, `没有命中：${command.join(" ")}`);
      assert.equal(parsed[0]?.message.length, 4, `messageMax 没生效：${command.join(" ")}`);
    }
  });

  it("空命令与未知命令返回空表，不影响门禁结果", () => {
    assert.deepEqual(diagnosticsFor([], "a.go:1:1: bad"), []);
    assert.deepEqual(diagnosticsFor(["unknown"], "a.go:1:1: bad"), []);
  });

  it("其余命令分派（wrapper/ctest/make/phpunit/composer）也走对应解析器", () => {
    for (const command of [
      ["mvn", "-q", "test"],
      ["./mvnw", "-q", "test"],
      ["gradle", "check"],
      ["./gradlew", "check"],
      ["gradlew.bat", "check"],
    ]) {
      assert.equal(diagnosticsFor(command, "A.java:1: error: bad").length, 1, command.join(" "));
    }
    assert.equal(diagnosticsFor(["ctest", "--test-dir", "build"], "a.c:1:1: error: bad").length, 1);
    assert.equal(diagnosticsFor(["make", "check"], "a.h:1:1: error: bad").length, 1);
    assert.equal(
      diagnosticsFor(["vendor/bin/phpunit"], "PHP Parse error: bad in a.php on line 1").length,
      1,
    );
    assert.equal(
      diagnosticsFor(["composer", "validate"], "PHP Parse error: bad in a.php on line 1").length,
      1,
    );
  });

  it("未知命令、cargo fmt 这类没有行列诊断的输出返回空表", () => {
    assert.deepEqual(diagnosticsFor(["pnpm", "check"], "boom"), []);
    assert.deepEqual(
      diagnosticsFor(["cargo", "fmt", "--all", "--", "--check"], "Diff in src/main.rs"),
      [],
    );
    assert.deepEqual(diagnosticsFor(["vitest", "run"], "FAIL src/a.test.ts"), []);
  });
});

describe("repo-diagnostics：门禁根相对 → 仓库根相对", () => {
  it("有 .git 的父目录时从仓库根换算；没有 .git 时退回起点", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "qg-diag-"));
    try {
      const repo = path.join(temp, "repo");
      const pkg = path.join(repo, "packages", "pkg");
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(path.join(pkg, "src"), { recursive: true });
      assert.equal(repositoryRootOf(pkg), repo);
      const diagnostics = repoRelativeDiagnostics(
        pkg,
        ["go", "vet", "./..."],
        "src/a.go:3:1: bad",
        200,
      );
      assert.deepEqual(diagnostics, [{ path: "packages/pkg/src/a.go", line: 3, message: "bad" }]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }

    const detached = await mkdtemp(path.join(tmpdir(), "qg-nogit-"));
    try {
      assert.equal(repositoryRootOf(detached), detached);
    } finally {
      await rm(detached, { recursive: true, force: true });
    }
  });

  it("maven 这类直接打绝对路径的诊断原样保留，不换算成跑出仓库的 `../`", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "qg-diag-abs-"));
    try {
      const repo = path.join(temp, "repo");
      const pkg = path.join(repo, "packages", "pkg");
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(pkg, { recursive: true });
      const outside = "/outside/A.java";
      const diagnostics = repoRelativeDiagnostics(
        pkg,
        ["mvn", "-q", "verify"],
        `[ERROR] ${outside}:[3,4] cannot find symbol`,
        200,
      );
      assert.deepEqual(diagnostics, [{ path: outside, line: 3, message: CANNOT_FIND_SYMBOL }]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
