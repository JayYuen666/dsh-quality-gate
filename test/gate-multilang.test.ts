import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { detectGate } from "../lib/gate-detect.ts";
import type { DetectOptions, GateCommand, ProjectRoot } from "../lib/gate-detect.ts";

const ROOT = "/w/multi";
const PKG_JSON = "package.json";
const TSCONFIG_JSON = "tsconfig.json";
const CARGO_MANIFEST = "Cargo.toml";
const PYPROJECT_MANIFEST = "pyproject.toml";
const CMAKE_MANIFEST = "CMakeLists.txt";
const COMPOSER_MANIFEST = "composer.json";
const POM_XML = "pom.xml";
const GEMFILE = "Gemfile";
const RUBOCOP_CONFIG = ".rubocop.yml";
const CSHARP_APP = "App.csproj";
const COMPOSER_VALIDATE = ["composer", "validate", "--no-check-publish"] as const;
const EDITORCONFIG = ".editorconfig";
const GRADLE_FILE = "build.gradle";
const CHECKSTYLE_CONFIG = "checkstyle.xml";
const CHECKSTYLE_NESTED = "config/checkstyle/checkstyle.xml";
const JAVA_MAIN = "src/main/java";
const CLANG_FORMAT = ".clang-format";
const FORMAT_CHECK_TARGET = "format-check";
const MAKE_FORMAT_CHECK = ["make", FORMAT_CHECK_TARGET] as const;
const BAZEL_TEST = ["bazel", "test", "//..."] as const;
const CHECKSTYLE_ROOT_CMD = ["checkstyle", "-c", CHECKSTYLE_CONFIG, JAVA_MAIN] as const;
const CHECKSTYLE_NESTED_CMD = ["checkstyle", "-c", CHECKSTYLE_NESTED, JAVA_MAIN] as const;
const PACKAGE_LOCK = "package-lock.json";
const NPM_AUDIT = ["npm", "audit", "--audit-level=high", "--omit=dev"] as const;
const PNPM_AUDIT = ["pnpm", "audit", "--audit-level=high", "--prod"] as const;
const PIP_AUDIT = ["pip-audit", "-r", "requirements.txt"] as const;
function commands(
  files: readonly string[],
  extra: Partial<ProjectRoot> = {},
  scripts: readonly string[] = [],
  options: DetectOptions = {},
): readonly (readonly string[])[] {
  return detectGate([{ root: ROOT, files, ...extra }], scripts, options).map(
    (gate) => gate.command,
  );
}

describe("gate-detect：多语言内置门禁矩阵", () => {
  it("多语言：JS/TS：eslint/vitest/jest/tsc 各按自己的配置出现", () => {
    assert.deepEqual(
      commands([PKG_JSON, "eslint.config.js", "vitest.config.ts", "jest.config.js", TSCONFIG_JSON]),
      [
        ["eslint", "--format", "unix", "."],
        ["vitest", "run"],
        ["jest", "--ci"],
        ["tsc", "--noEmit"],
      ] satisfies GateCommand[],
    );
  });

  it("多语言：JS/TS：只有 eslint 配置、没有 tsconfig → 只跑 eslint", () => {
    assert.deepEqual(commands([PKG_JSON, ".eslintrc.json"]), [
      ["eslint", "--format", "unix", "."] as const,
    ]);
  });

  it("多语言：JS/TS：oxlint / oxfmt 配置优先于 eslint / prettier", () => {
    assert.deepEqual(commands([PKG_JSON, "oxlintrc.json", "oxfmtrc.jsonc"]), [
      ["oxlint", "."] as const,
      ["oxfmt", "--check", "."] as const,
    ]);
    assert.deepEqual(commands([PKG_JSON, "oxlintrc.json", ".eslintrc.json"]), [
      ["oxlint", "."] as const,
    ]);
  });

  it("多语言：JS/TS：workspace 根仍可跑 eslint，但不发明 tsc", () => {
    assert.deepEqual(
      commands([PKG_JSON, "pnpm-workspace.yaml", "eslint.config.mjs", TSCONFIG_JSON]),
      [["eslint", "--format", "unix", "."] as const],
    );
  });

  it("多语言：JS/TS：vitest / jest 单独识别，不互相替代", () => {
    assert.deepEqual(commands([PKG_JSON, "vitest.config.js"]), [["vitest", "run"] as const]);
    assert.deepEqual(commands([PKG_JSON, "jest.config.ts"]), [["jest", "--ci"] as const]);
  });

  it("多语言：JS/TS：带 references 的 tsconfig 不发包级 tsc（避免必然 TS6305）", () => {
    assert.deepEqual(commands([PKG_JSON, TSCONFIG_JSON], { tsconfigReferences: true }), []);
    assert.deepEqual(commands([PKG_JSON, TSCONFIG_JSON], { tsconfigReferences: false }), [
      ["tsc", "--noEmit"] as const,
    ]);
  });

  it("多语言：Rust：cargo check + cargo test --no-run；有 rustfmt 配置才跑 fmt", () => {
    assert.deepEqual(commands([CARGO_MANIFEST]), [
      ["cargo", "check"] as const,
      ["cargo", "test", "--no-run"] as const,
    ]);
    assert.deepEqual(commands([CARGO_MANIFEST, "rustfmt.toml"]), [
      ["cargo", "check"] as const,
      ["cargo", "fmt", "--all", "--", "--check"] as const,
      ["cargo", "test", "--no-run"] as const,
    ]);
  });

  it("多语言：Go：go vet + go test", () => {
    assert.deepEqual(commands(["go.mod"]), [
      ["go", "vet", "./..."] as const,
      ["go", "test", "./..."] as const,
    ]);
  });

  it("多语言：Python：ruff/pytest/mypy 各自按配置标记独立出现", () => {
    assert.deepEqual(commands([PYPROJECT_MANIFEST, "ruff.toml", "pytest.ini", "mypy.ini"]), [
      ["ruff", "check", "."] as const,
      ["pytest", "-q"] as const,
      ["mypy", "."] as const,
    ]);
    // ruff format 是独立的配置面：ruff.toml 存在不等于项目启用了格式化。
    assert.deepEqual(commands([PYPROJECT_MANIFEST, "ruff.toml"], { ruffFormatConfigured: true }), [
      ["ruff", "check", "."] as const,
      ["ruff", "format", "--check", "."] as const,
    ]);
  });

  it("多语言：Python：pyproject 里的配置段由 host 读成布尔值；undefined 时不猜", () => {
    assert.deepEqual(
      commands([PYPROJECT_MANIFEST], {
        ruffConfigured: true,
        pytestConfigured: true,
        mypyConfigured: true,
      }),
      [["ruff", "check", "."] as const, ["pytest", "-q"] as const, ["mypy", "."] as const],
    );
    assert.deepEqual(
      commands([PYPROJECT_MANIFEST], {
        ruffConfigured: true,
        ruffFormatConfigured: true,
        pytestConfigured: true,
        mypyConfigured: true,
      }),
      [
        ["ruff", "check", "."] as const,
        ["ruff", "format", "--check", "."] as const,
        ["pytest", "-q"] as const,
        ["mypy", "."] as const,
      ],
    );
    assert.deepEqual(commands([PYPROJECT_MANIFEST]), []);
  });

  it("多语言：Python：tests/ 目录不是 pytest 入口；只有 .py 文件也不构成门禁", () => {
    // 有 tests/ 目录而没有一条用例时 `pytest -q` 会退 5（no tests collected），
    // 把「目录存在」当入口等于把空套件报成门禁失败。
    assert.deepEqual(commands([PYPROJECT_MANIFEST, "tests/"]), []);
    assert.deepEqual(commands([PYPROJECT_MANIFEST, "test/"]), []);
    assert.deepEqual(commands(["a.py"]), []);
  });

  it("多语言：Python：.ruff.toml 与 setup.cfg/tox.ini 也能作为根标记，但不凭空发命令", () => {
    assert.deepEqual(commands([PYPROJECT_MANIFEST, ".ruff.toml"]), [
      ["ruff", "check", "."] as const,
    ]);
    assert.deepEqual(commands(["setup.cfg"]), []);
    assert.deepEqual(commands(["tox.ini"]), []);
    assert.deepEqual(commands(["mypy.ini"]), [["mypy", "."] as const]);
  });

  it("多语言：Ruby：rubocop 只认 .rubocop.yml；rspec 只认 .rspec", () => {
    assert.deepEqual(commands([GEMFILE, RUBOCOP_CONFIG]), [["rubocop"] as const]);
    assert.deepEqual(commands([GEMFILE, ".rspec"]), [["rspec"] as const]);
    assert.deepEqual(commands(["Gemfile"]), []);
  });

  it("多语言：Java：Maven/Gradle wrapper 优先，无 wrapper 才用 PATH 上的工具", () => {
    assert.deepEqual(commands(["pom.xml"]), [["mvn", "-q", "test"] as const]);
    assert.deepEqual(commands(["pom.xml", "mvnw"]), [["./mvnw", "-q", "test"] as const]);
    assert.deepEqual(commands(["build.gradle"]), [["gradle", "check"] as const]);
    assert.deepEqual(commands(["build.gradle.kts", "gradlew"]), [["./gradlew", "check"] as const]);
    assert.deepEqual(commands([GRADLE_FILE, "gradlew.bat"]), [["gradlew.bat", "check"] as const]);
    assert.deepEqual(commands(["settings.gradle"]), []);
  });

  it("多语言：C/C++：只在已经配置好 build 目录时才构建/测试", () => {
    assert.deepEqual(commands([CMAKE_MANIFEST]), []);
    assert.deepEqual(commands([CMAKE_MANIFEST, "build/CMakeCache.txt"]), [
      ["cmake", "--build", "build"] as const,
    ]);
    assert.deepEqual(commands([CMAKE_MANIFEST, "build/CTestTestfile.cmake"]), [
      ["ctest", "--test-dir", "build", "--output-on-failure"] as const,
    ]);
    assert.deepEqual(
      commands([CMAKE_MANIFEST, "build/CMakeCache.txt", "build/CTestTestfile.cmake"]),
      [
        ["cmake", "--build", "build"] as const,
        ["ctest", "--test-dir", "build", "--output-on-failure"] as const,
      ],
    );
  });

  it("多语言：Makefile：check 是唯一压过内置探测的声明，test 只作为测试入口追加", () => {
    assert.deepEqual(commands(["Makefile", CARGO_MANIFEST], { makeTargets: ["check"] }), [
      ["make", "check"] as const,
    ]);
    assert.deepEqual(commands(["Makefile"], { makeTargets: ["test"] }), [
      ["make", "test"] as const,
    ]);
    assert.deepEqual(commands(["Makefile"], { makeTargets: [] }), []);
    // test 目标不再压掉内置 lint/format：真实工程常常只把 test 写进 Makefile。
    assert.deepEqual(
      commands([PKG_JSON, "eslint.config.js", "Makefile"], { makeTargets: ["test"] }),
      [["eslint", "--format", "unix", "."] as const, ["make", "test"] as const],
    );
    assert.deepEqual(commands(["Rakefile"], { rakeTargets: ["test"] }), [
      ["rake", "test"] as const,
    ]);
    assert.deepEqual(commands(["Rakefile"], { rakeTargets: ["check", "test"] }), [
      ["rake", "check"] as const,
    ]);
    assert.deepEqual(commands(["Rakefile"], { rakeTargets: [] }), []);
    assert.deepEqual(commands([GEMFILE, RUBOCOP_CONFIG, "Rakefile"], { rakeTargets: ["test"] }), [
      ["rubocop"] as const,
      ["rake", "test"] as const,
    ]);
  });

  it("多语言：Java：pom 含 checkstyle/spotbugs/pmd 插件时 Maven 跑 verify", () => {
    assert.deepEqual(commands([POM_XML]), [["mvn", "-q", "test"] as const]);
    assert.deepEqual(commands([POM_XML], { mavenVerifyConfigured: true }), [
      ["mvn", "-q", "verify"] as const,
    ]);
    assert.deepEqual(commands([POM_XML, "mvnw"], { mavenVerifyConfigured: true }), [
      ["./mvnw", "-q", "verify"] as const,
    ]);
  });

  it("多语言：Kotlin detekt 只认配置，ktlint 只在有 Kotlin 源目录且自带 .editorconfig 时", () => {
    assert.deepEqual(commands([POM_XML]), [["mvn", "-q", "test"] as const]);
    assert.deepEqual(commands([POM_XML, "detekt.yml"]), [
      ["mvn", "-q", "test"] as const,
      ["detekt", "--config", "detekt.yml"] as const,
    ]);
    assert.deepEqual(commands([POM_XML, "detekt.yaml"]), [
      ["mvn", "-q", "test"] as const,
      ["detekt", "--config", "detekt.yaml"] as const,
    ]);
    assert.deepEqual(commands([POM_XML, "config/detekt/detekt.yml"]), [
      ["mvn", "-q", "test"] as const,
      ["detekt", "--config", "config/detekt/detekt.yml"] as const,
    ]);
    assert.deepEqual(commands([POM_XML, "config/detekt/detekt.yaml"]), [
      ["mvn", "-q", "test"] as const,
      ["detekt", "--config", "config/detekt/detekt.yaml"] as const,
    ]);
    assert.deepEqual(commands([POM_XML, EDITORCONFIG, "src/main/kotlin"]), [
      ["mvn", "-q", "test"] as const,
      ["ktlint"] as const,
    ]);
    assert.deepEqual(commands([POM_XML, EDITORCONFIG]), [["mvn", "-q", "test"] as const]);
  });

  it("多语言：clang-format 只在 .clang-format + Makefile 显式检查目标时跑", () => {
    assert.deepEqual(commands([CLANG_FORMAT], { makeTargets: [FORMAT_CHECK_TARGET] }), [
      MAKE_FORMAT_CHECK,
    ]);
    assert.deepEqual(commands([CLANG_FORMAT]), []);
    assert.deepEqual(commands(["Makefile"], { makeTargets: [FORMAT_CHECK_TARGET] }), []);
    assert.deepEqual(commands([CLANG_FORMAT], { makeTargets: ["test"] }), []);
    assert.deepEqual(commands([CMAKE_MANIFEST, CLANG_FORMAT], { makeTargets: ["check-format"] }), [
      ["make", "check-format"] as const,
    ]);
  });

  it("多语言：Bazel 只在根上有 MODULE.bazel / WORKSPACE 时跑", () => {
    assert.deepEqual(commands(["MODULE.bazel"]), [BAZEL_TEST]);
    assert.deepEqual(commands(["WORKSPACE"]), [BAZEL_TEST]);
    assert.deepEqual(commands(["WORKSPACE.bazel"]), [BAZEL_TEST]);
    assert.deepEqual(commands(["BUILD.bazel"]), []);
  });

  it("多语言：没有 Maven/Gradle 时，独立 Checkstyle 只认配置与 src/main/java", () => {
    assert.deepEqual(commands([CHECKSTYLE_CONFIG, JAVA_MAIN]), [CHECKSTYLE_ROOT_CMD]);
    assert.deepEqual(commands([CHECKSTYLE_NESTED, JAVA_MAIN]), [CHECKSTYLE_NESTED_CMD]);
    assert.deepEqual(commands([CHECKSTYLE_CONFIG]), []);
    assert.deepEqual(commands([JAVA_MAIN]), []);
    // 有构建工具时不叠 CLI：Maven/Gradle 自己声明的那条才是项目门禁。
    assert.deepEqual(commands([POM_XML, CHECKSTYLE_CONFIG, JAVA_MAIN]), [
      ["mvn", "-q", "test"] as const,
    ]);
    assert.deepEqual(commands([GRADLE_FILE, CHECKSTYLE_CONFIG, JAVA_MAIN]), [
      ["gradle", "check"] as const,
    ]);
  });

  it("多语言：供应链扫描默认关闭，打开后按锁文件追加", () => {
    assert.deepEqual(commands([PKG_JSON, PACKAGE_LOCK]), []);
    assert.deepEqual(commands([PKG_JSON], {}, [], { securityAudit: true }), []);
    assert.deepEqual(
      commands([PKG_JSON, PACKAGE_LOCK], { scripts: ["check"] }, [], {
        securityAudit: true,
      }),
      [["pnpm", "check"] as const, NPM_AUDIT],
    );
    assert.deepEqual(commands([PKG_JSON, PACKAGE_LOCK], {}, [], { securityAudit: true }), [
      NPM_AUDIT,
    ]);
    assert.deepEqual(commands([PKG_JSON, "pnpm-lock.yaml"], {}, [], { securityAudit: true }), [
      PNPM_AUDIT,
    ]);
    assert.deepEqual(commands([PKG_JSON, "npm-shrinkwrap.json"], {}, [], { securityAudit: true }), [
      NPM_AUDIT,
    ]);
    assert.deepEqual(commands([CARGO_MANIFEST, "Cargo.lock"], {}, [], { securityAudit: true }), [
      ["cargo", "check"] as const,
      ["cargo", "test", "--no-run"] as const,
      ["cargo", "audit"] as const,
    ]);
    assert.deepEqual(commands(["go.mod"], {}, [], { securityAudit: true }), [
      ["go", "vet", "./..."] as const,
      ["go", "test", "./..."] as const,
      ["govulncheck", "./..."] as const,
    ]);
    assert.deepEqual(commands([GEMFILE, "Gemfile.lock"], {}, [], { securityAudit: true }), [
      ["bundler-audit", "check", "--update"] as const,
    ]);
    assert.deepEqual(
      commands([COMPOSER_MANIFEST, "composer.lock"], {}, [], { securityAudit: true }),
      [COMPOSER_VALIDATE, ["composer", "audit"] as const],
    );
    assert.deepEqual(
      commands([PYPROJECT_MANIFEST, "requirements.txt"], {}, [], { securityAudit: true }),
      [PIP_AUDIT],
    );
  });

  it("多语言：C#：测试工程用 dotnet test；solution 或单一 csproj 用 dotnet build；多工程无 solution 不猜", () => {
    assert.deepEqual(commands(["App.Test.csproj"]), [["dotnet", "test", "--nologo"] as const]);
    assert.deepEqual(commands(["App.sln", CSHARP_APP]), [["dotnet", "build", "--nologo"] as const]);
    assert.deepEqual(commands([CSHARP_APP]), [["dotnet", "build", "--nologo"] as const]);
    assert.deepEqual(commands(["Contest.csproj"]), [["dotnet", "build", "--nologo"] as const]);
    assert.deepEqual(commands(["Tests.csproj"]), [["dotnet", "test", "--nologo"] as const]);
    assert.deepEqual(commands(["A.csproj", "B.csproj"]), []);
  });

  it("多语言：PHP：composer test 脚本优先；否则 composer validate；phpunit 另行叠加", () => {
    assert.deepEqual(commands([COMPOSER_MANIFEST], { composerScripts: ["test"] }), [
      ["composer", "run-script", "test"] as const,
    ]);
    assert.deepEqual(commands([COMPOSER_MANIFEST]), [COMPOSER_VALIDATE]);
    assert.deepEqual(commands([COMPOSER_MANIFEST, "phpunit.xml"]), [
      COMPOSER_VALIDATE,
      ["phpunit"] as const,
    ]);
    assert.deepEqual(commands([COMPOSER_MANIFEST, "phpunit.xml", "vendor/bin/phpunit"]), [
      COMPOSER_VALIDATE,
      ["vendor/bin/phpunit"] as const,
    ]);
  });

  it("项目声明优先：声明的 check/额外脚本压过所有内置语言探测", () => {
    assert.deepEqual(
      commands([PKG_JSON, "pnpm-workspace.yaml", CARGO_MANIFEST], { scripts: ["check"] }),
      [["pnpm", "check"] as const],
    );
    assert.deepEqual(commands([PKG_JSON, CARGO_MANIFEST], { scripts: ["all"] }, ["all"]), [
      ["pnpm", "run", "all"] as const,
    ]);
  });

  it("同一根重复输入的相同门禁按 root+command 去重", () => {
    assert.deepEqual(
      detectGate([
        { root: ROOT, files: ["go.mod"] },
        { root: ROOT, files: ["go.mod"] },
      ]),
      [
        { root: ROOT, command: ["go", "vet", "./..."] },
        { root: ROOT, command: ["go", "test", "./..."] },
      ],
    );
  });

  it("多语言：JS/TS 的主流格式化器（prettier / biome）", () => {
    assert.deepEqual(commands([PKG_JSON, ".prettierrc"]), [["prettier", "--check", "."] as const]);
    assert.deepEqual(commands([PKG_JSON, "biome.json"]), [["biome", "check", "."] as const]);
    // biome 自带格式化，存在 biome 配置时不再叠加 prettier。
    assert.deepEqual(commands([PKG_JSON, "biome.json", ".prettierrc"]), [
      ["biome", "check", "."] as const,
    ]);
  });

  it("多语言：Rust clippy 只在项目声明 clippy 配置时启用", () => {
    assert.deepEqual(commands([CARGO_MANIFEST, "clippy.toml"]), [
      ["cargo", "check"] as const,
      ["cargo", "clippy", "--all-targets", "--", "-D", "warnings"] as const,
      ["cargo", "test", "--no-run"] as const,
    ]);
  });

  it("多语言：Go 的 golangci-lint / staticcheck 各自按配置启用", () => {
    assert.deepEqual(commands(["go.mod", ".golangci.yml"]), [
      ["go", "vet", "./..."] as const,
      ["golangci-lint", "run"] as const,
      ["go", "test", "./..."] as const,
    ]);
    assert.deepEqual(commands(["go.mod", "staticcheck.conf"]), [
      ["go", "vet", "./..."] as const,
      ["staticcheck", "./..."] as const,
      ["go", "test", "./..."] as const,
    ]);
  });

  it("多语言：Python black / flake8 / pyright 按配置段或配置文件启用", () => {
    assert.deepEqual(
      commands([PYPROJECT_MANIFEST], {
        blackConfigured: true,
        pyrightConfigured: true,
        flake8Configured: true,
      }),
      [["black", "--check", "."] as const, ["flake8"] as const, ["pyright"] as const],
    );
    assert.deepEqual(commands([PYPROJECT_MANIFEST, "pyrightconfig.json"]), [["pyright"] as const]);
    assert.deepEqual(commands([PYPROJECT_MANIFEST, ".flake8"]), [["flake8"] as const]);
    assert.deepEqual(commands([PYPROJECT_MANIFEST, ".pylintrc"]), [["pylint", "."] as const]);
    // black 已声明时，ruff 只跑 lint；不叠加 ruff format，避免两套格式化规则互相判红。
    assert.deepEqual(
      commands([PYPROJECT_MANIFEST], { ruffConfigured: true, blackConfigured: true }),
      [["ruff", "check", "."] as const, ["black", "--check", "."] as const],
    );
  });

  it("多语言：Ruby standardrb、C# dotnet format、PHP phpstan/psalm/php-cs-fixer", () => {
    assert.deepEqual(commands([GEMFILE, ".standard.yml"]), [["standardrb"] as const]);
    assert.deepEqual(commands([GEMFILE, RUBOCOP_CONFIG, ".standard.yml"]), [
      ["standardrb"] as const,
    ]);
    assert.deepEqual(commands([CSHARP_APP, ".editorconfig"]), [
      ["dotnet", "format", "--verify-no-changes", "--nologo"] as const,
      ["dotnet", "build", "--nologo"] as const,
    ]);
    assert.deepEqual(commands([COMPOSER_MANIFEST, "phpstan.neon"]), [
      COMPOSER_VALIDATE,
      ["phpstan", "analyse"] as const,
    ]);
    assert.deepEqual(commands([COMPOSER_MANIFEST, "psalm.xml"]), [
      COMPOSER_VALIDATE,
      ["psalm"] as const,
    ]);
    assert.deepEqual(commands([CMAKE_MANIFEST, "build/compile_commands.json", ".clang-tidy"]), [
      ["run-clang-tidy", "-p", "build"] as const,
    ]);
    assert.deepEqual(commands([CMAKE_MANIFEST, "build/compile_commands.json", ".cppcheck"]), [
      ["cppcheck", "--project=build/compile_commands.json", "--error-exitcode=1"] as const,
    ]);
    assert.deepEqual(commands([COMPOSER_MANIFEST, ".php-cs-fixer.php"]), [
      COMPOSER_VALIDATE,
      ["php-cs-fixer", "fix", "--dry-run", "--diff"] as const,
    ]);
  });

  it("未知扩展名/未知清单不产生门禁", () => {
    assert.deepEqual(commands(["README.md", "notes.txt"]), []);
  });
});
