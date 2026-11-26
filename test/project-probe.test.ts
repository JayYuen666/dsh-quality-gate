import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findManifestRoot, probeProjectRoot, workspaceRootUpgrade } from "../lib/project-probe.ts";

/** 夹具里反复用到的清单名；写成常量是为了不让 lint 把重复字面量当成麻烦。 */
const PKG_JSON = "package.json";
const PYPROJECT = "pyproject.toml";
const SETUP_CFG = "setup.cfg";
const TOX_INI = "tox.ini";
const RUFF_TOML = "ruff.toml";
const DOT_RUFF_TOML = ".ruff.toml";
const TSCONFIG = "tsconfig.json";
const CSPROJ = "App.csproj";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "qg-probe-"));
  roots.push(root);
  return root;
}

/** 按相对路径写文件（自动建父目录），用的都是真实磁盘文件——探针读的就是这些。 */
async function put(root: string, name: string, text: string): Promise<void> {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

describe("project-probe", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  describe("project-probe：把磁盘上的目录读成 ProjectRoot", () => {
    it("空目录：没有清单，也没有任何配置面", async () => {
      const root = await makeRoot();
      assert.deepEqual(probeProjectRoot(root), { root, files: [] });
    });

    it("目录不存在：同样读成空画像，而不是抛错", async () => {
      const root = path.join(await makeRoot(), "missing");
      assert.deepEqual(probeProjectRoot(root), { root, files: [] });
    });

    it("package.json 的 scripts：只收能跑的声明（空串、空数组、混合数组都不算）", async () => {
      const root = await makeRoot();
      await put(
        root,
        PKG_JSON,
        JSON.stringify({
          scripts: { check: "pnpm run lint", lint: "", build: ["eslint", "."], dev: [] },
        }),
      );
      const probed = probeProjectRoot(root);
      assert.deepEqual(probed.files, [PKG_JSON]);
      assert.deepEqual(probed.scripts, ["check", "build"]);
    });

    it("scripts 里非字符串值被丢掉；scripts 本身不是对象时不登记", async () => {
      const root = await makeRoot();
      await put(root, PKG_JSON, JSON.stringify({ scripts: { test: "vitest", x: 7 } }));
      assert.deepEqual(probeProjectRoot(root).scripts, ["test"]);
      await put(root, PKG_JSON, JSON.stringify({ scripts: 42 }));
      assert.deepEqual(probeProjectRoot(root).scripts, undefined);
    });

    it("package.json 读不出来（JSON 非法）时 scripts 保持 undefined，不替项目猜", async () => {
      const root = await makeRoot();
      await put(root, PKG_JSON, "{ broken");
      assert.deepEqual(probeProjectRoot(root).scripts, undefined);
    });

    it("composer.json 的 scripts 收数组写法，混合数组按不可执行处理", async () => {
      const root = await makeRoot();
      await put(
        root,
        "composer.json",
        JSON.stringify({ scripts: { test: ["phpunit"], lint: "php -l", bad: [1, "x"] } }),
      );
      const probed = probeProjectRoot(root);
      assert.deepEqual(probed.files, ["composer.json"]);
      assert.deepEqual(probed.composerScripts, ["test", "lint"]);
    });

    it("pyproject 的配置段：ruff/lint、ruff format、pytest、mypy、pylint、black、pyright 各自登记", async () => {
      const root = await makeRoot();
      await put(
        root,
        PYPROJECT,
        [
          "[tool.ruff]",
          "line-length = 100",
          "[tool.ruff.format]",
          "quote-style = 'double'",
          "[tool.pytest.ini_options]",
          "addopts = '-q'",
          "[tool.mypy]",
          "strict = true",
          "[tool.pylint.main]",
          "jobs = 2",
          "[tool.black]",
          "line-length = 100",
          "[tool.pyright]",
          "include = ['src']",
        ].join("\n"),
      );
      const probed = probeProjectRoot(root);
      assert.equal(probed.ruffConfigured, true);
      assert.equal(probed.ruffFormatConfigured, true);
      assert.equal(probed.pytestConfigured, true);
      assert.equal(probed.mypyConfigured, true);
      assert.equal(probed.pylintConfigured, true);
      assert.equal(probed.blackConfigured, true);
      assert.equal(probed.pyrightConfigured, true);
    });

    it("pyproject 只有 [tool.ruff] 时，格式化门禁是 false 而不是真", async () => {
      const root = await makeRoot();
      await put(root, PYPROJECT, "[tool.ruff]\nline-length = 100\n");
      const probed = probeProjectRoot(root);
      assert.equal(probed.ruffConfigured, true);
      assert.equal(probed.ruffFormatConfigured, false);
    });

    it("ruff.toml / .ruff.toml 的 [format] 也算格式化器声明", async () => {
      const root = await makeRoot();
      await put(root, RUFF_TOML, "[format]\nquote-style = 'double'\n");
      assert.equal(probeProjectRoot(root).ruffFormatConfigured, true);
      await rm(path.join(root, RUFF_TOML));
      await put(root, DOT_RUFF_TOML, "[lint]\nselect = ['E']\n");
      assert.equal(probeProjectRoot(root).ruffFormatConfigured, false);
      await rm(path.join(root, DOT_RUFF_TOML));
      await put(root, DOT_RUFF_TOML, "[format.single]\n");
      assert.equal(probeProjectRoot(root).ruffFormatConfigured, true);
    });

    it("setup.cfg 用 [pylint] 段头，[tool.pylint] 形状不适用", async () => {
      const root = await makeRoot();
      await put(root, SETUP_CFG, "[pylint]\njobs = 2\n");
      assert.equal(probeProjectRoot(root).pylintConfigured, true);
      await put(root, SETUP_CFG, "[tool.pylint.main]\njobs = 2\n");
      assert.equal(probeProjectRoot(root).pylintConfigured, false);
    });

    it("setup.cfg / tox.ini / pytest.ini / mypy.ini 的其它 Python 载体", async () => {
      const root = await makeRoot();
      await put(root, SETUP_CFG, "[tool:pytest]\naddopts = '-q'\n[mypy]\nstrict = true\n");
      const setupProbe = probeProjectRoot(root);
      assert.equal(setupProbe.pytestConfigured, true);
      assert.equal(setupProbe.mypyConfigured, true);
      await put(root, TOX_INI, "[pytest]\n[flake8]\nmax-line-length = 100\n");
      const toxProbe = probeProjectRoot(root);
      assert.equal(toxProbe.pytestConfigured, true);
      assert.equal(toxProbe.flake8Configured, true);
      await put(root, "pytest.ini", "[pytest]\n");
      assert.equal(probeProjectRoot(root).pytestConfigured, true);
      await put(root, "mypy.ini", "[mypy]\nstrict = true\n");
      assert.equal(probeProjectRoot(root).mypyConfigured, true);
      // 只有 tox.ini 一份载体时，pytest 段也要单独被读到（setup.cfg 在场会短路掉这一支）。
      const toxOnly = await makeRoot();
      await put(toxOnly, TOX_INI, "[pytest]\n");
      assert.equal(probeProjectRoot(toxOnly).pytestConfigured, true);
    });

    it("makefile 里收全部目标名，不把变量赋值当成目标", async () => {
      const root = await makeRoot();
      await put(
        root,
        "Makefile",
        [
          "FOO := bar",
          "BAR ::= baz",
          "CPPFLAGS = -Wall",
          "all: build",
          "check: test",
          "test:",
          "format-check:",
          "clang-format-check:",
          ".PHONY: check test",
        ].join("\n"),
      );
      const targets = probeProjectRoot(root).makeTargets ?? [];
      assert.deepEqual(
        targets.filter((name) => !["all", ".PHONY"].includes(name)),
        ["check", "test", "format-check", "clang-format-check"],
      );
      assert.equal(
        targets.some((name) => ["FOO", "BAR", "CPPFLAGS"].includes(name)),
        false,
      );
    });

    it("rakefile 只认 check/test 任务", async () => {
      const root = await makeRoot();
      await put(root, "Rakefile", "task :check do\nend\ntask 'test' do\nend\ntask :lint do\nend\n");
      assert.deepEqual(probeProjectRoot(root).rakeTargets, ["check", "test"]);
    });

    it("tsconfig 的 references 按 JSONC 解析：注释、尾逗号、字符串里的注释字样都不误判", async () => {
      const root = await makeRoot();
      await put(root, TSCONFIG, '{"references": [{"path": "../a"}]}');
      assert.equal(probeProjectRoot(root).tsconfigReferences, true);

      // JSONC 的注释与尾逗号是合法输入；字符串里的 //、/* */ 和转义引号不能被当成注释。
      await put(
        root,
        TSCONFIG,
        [
          "\uFEFF{",
          "  // project references",
          String.raw`  "note": "http://x/* literal */ and \" quoted",`,
          '  "references": [',
          "    // the referenced package",
          '    { "path": "../a" },',
          "  ],",
          "}",
        ].join("\r\n"),
      );
      assert.equal(probeProjectRoot(root).tsconfigReferences, true);

      // 注释或字符串里出现 references 不是配置项。
      await put(
        root,
        TSCONFIG,
        '{\n/* "references": [ {"path": "../a"} ] */\n"compilerOptions": {"strict": true}\n}',
      );
      assert.equal(probeProjectRoot(root).tsconfigReferences, false);
      await put(
        root,
        TSCONFIG,
        '{"note": "\\\"references\\\": [ { \\\"path\\\": \\\"../a\\\" } ]"}',
      );
      assert.equal(probeProjectRoot(root).tsconfigReferences, false);

      // 数组存在但没有有效 path 项，不能当成 project references。
      await put(root, TSCONFIG, '{"references": [{"path": ""}, {"path": 3}, {"path": "../a"}]}');
      assert.equal(probeProjectRoot(root).tsconfigReferences, true);
      await put(root, TSCONFIG, '{"references": [{"path": ""}, {"path": 3}]}');
      assert.equal(probeProjectRoot(root).tsconfigReferences, false);
      await put(root, TSCONFIG, '{"references": []}');
      assert.equal(probeProjectRoot(root).tsconfigReferences, false);
      await put(root, TSCONFIG, '{"references": {}}');
      assert.equal(probeProjectRoot(root).tsconfigReferences, false);
      await put(root, TSCONFIG, "[]");
      assert.equal(probeProjectRoot(root).tsconfigReferences, false);

      // JSONC 允许的非法 JSON（坏注释/截断）不能被猜成 true，交给 undefined 的保守分支。
      await put(root, TSCONFIG, '{"references": [');
      assert.equal(probeProjectRoot(root).tsconfigReferences, undefined);
    });

    it("pom.xml 里有静态分析插件才认为 verify 会跑到质量门禁", async () => {
      const root = await makeRoot();
      await put(
        root,
        "pom.xml",
        "<project><build><plugins><plugin><artifactId>maven-checkstyle-plugin</artifactId></plugin></plugins></build></project>",
      );
      assert.equal(probeProjectRoot(root).mavenVerifyConfigured, true);
      await put(root, "pom.xml", "<project><artifactId>x</artifactId></project>");
      assert.equal(probeProjectRoot(root).mavenVerifyConfigured, false);
    });

    it(".NET 工程文件与嵌套构建标记进 files；tests/ 目录也进", async () => {
      const root = await makeRoot();
      await put(root, CSPROJ, "<Project />");
      await mkdir(path.join(root, "build"), { recursive: true });
      await put(root, "build/CMakeCache.txt", "");
      await mkdir(path.join(root, "tests"), { recursive: true });
      const probed = probeProjectRoot(root);
      assert.equal(probed.files.includes(CSPROJ), true);
      assert.equal(probed.files.includes("build/CMakeCache.txt"), true);
      assert.equal(probed.files.includes("tests/"), true);
    });

    it("清单项是目录（读不动）时各配置面回落 undefined，不抛错", async () => {
      const root = await makeRoot();
      await Promise.all(
        [PYPROJECT, SETUP_CFG, TOX_INI, "Makefile", "Rakefile", "pom.xml", TSCONFIG, RUFF_TOML].map(
          (name) => mkdir(path.join(root, name)),
        ),
      );
      const probed = probeProjectRoot(root);
      assert.equal(probed.ruffConfigured, undefined);
      assert.equal(probed.ruffFormatConfigured, undefined);
      assert.equal(probed.pytestConfigured, undefined);
      assert.equal(probed.mypyConfigured, undefined);
      assert.equal(probed.blackConfigured, undefined);
      assert.equal(probed.pyrightConfigured, undefined);
      assert.equal(probed.flake8Configured, undefined);
      assert.equal(probed.pylintConfigured, undefined);
      assert.equal(probed.makeTargets, undefined);
      assert.equal(probed.rakeTargets, undefined);
      assert.equal(probed.mavenVerifyConfigured, undefined);
      assert.equal(probed.tsconfigReferences, undefined);
    });
  });

  describe("project-probe：向上找根", () => {
    it("maxDepth<=0：循环一次都不转，但必须标记命中深度上限", async () => {
      const root = await makeRoot();
      const file = path.join(root, "a.ts");
      assert.deepEqual(findManifestRoot(file, 0), { root: undefined, hitDepthLimit: true });
    });

    it("最近的一层有 package.json，就在那里停；maxDepth 够用时不算撞上限", async () => {
      const root = await makeRoot();
      await put(root, PKG_JSON, "{}");
      const file = path.join(root, "a.ts");
      assert.deepEqual(findManifestRoot(file, 1), { root, hitDepthLimit: false });
    });

    it("工具配置与无消费方的构建清单不算根标记：.prettierrc / tsconfig / settings.gradle", async () => {
      const root = await makeRoot();
      await put(root, ".prettierrc", "{}");
      await put(root, TSCONFIG, "{}");
      await put(root, "settings.gradle", "rootProject.name = 'x'");
      assert.deepEqual(findManifestRoot(path.join(root, "a.ts"), 1), {
        root: undefined,
        hitDepthLimit: true,
      });
    });

    it("一路找不到根时 hitDepthLimit 为 true", async () => {
      const root = await makeRoot();
      const nested = path.join(root, "a", "b");
      await mkdir(nested, { recursive: true });
      assert.deepEqual(findManifestRoot(path.join(nested, "x.ts"), 2), {
        root: undefined,
        hitDepthLimit: true,
      });
    });

    it("到达文件系统根之后不再往上：不会在 root 与它的父目录之间打转", async () => {
      const fsRoot = path.parse(tmpdir()).root;
      // 到顶是"没有根"，不是"撞了深度上限"：hitDepthLimit 只表达后者（warn 由它触发）。
      assert.deepEqual(findManifestRoot(path.join(fsRoot, "a.ts"), 50), {
        root: undefined,
        hitDepthLimit: false,
      });
      assert.equal(workspaceRootUpgrade(fsRoot, 5), fsRoot);
    });

    it(".NET 工程文件本身可以充当根标记", async () => {
      const root = await makeRoot();
      await put(root, CSPROJ, "<Project />");
      assert.deepEqual(findManifestRoot(path.join(root, "a.ts"), 1), {
        root,
        hitDepthLimit: false,
      });
    });

    it("workspaceRootUpgrade 向上找到 pnpm-workspace.yaml 就返回工作区根", async () => {
      const root = await makeRoot();
      await put(root, "pnpm-workspace.yaml", "packages: []\n");
      const child = path.join(root, "packages", "a");
      await mkdir(child, { recursive: true });
      assert.equal(workspaceRootUpgrade(child, 3), root);
      assert.equal(workspaceRootUpgrade(root, 1), root);
    });
  });
});
