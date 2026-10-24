// lib/accumulator + lib/gate-detect 单元测试。
// accumulator：tool/result 事件流里收集本回合编辑过的代码文件（ECC post-edit-accumulator 移植）。
// gate-detect：项目根 → 质量门禁命令的自动探测（ECC stop-format-typecheck 的按项目分组思想）。
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { EDIT_TOOLS, EditAccumulator } from "../lib/accumulator.ts";
import { detectGate } from "../lib/gate-detect.ts";
import type { ProjectRoot } from "../lib/gate-detect.ts";

// 夹具用名（用例内的「根目录下有哪些文件 / 编辑了哪个文件」）。本包实现侧没有导出这些
// 名字（gate-detect 按字面量比对清单），故这里是**测试自有**的期望值常量，不是实现常量
// 的别名——断言不会退化成同义反复。
/** 根目录下的 npm 清单名。 */
const PKG_JSON = "package.json";
/** 根目录下的 pnpm workspace 清单名。 */
const WORKSPACE_MANIFEST = "pnpm-workspace.yaml";
/** 根目录下的 Rust 清单名。 */
const CARGO_MANIFEST = "Cargo.toml";
/** 根目录下的 Python 工程元数据文件名（ruff 段的宿主）。 */
const PYPROJECT = "pyproject.toml";
/** 根目录下的 TypeScript 配置名（tsc 门禁的必要条件）。 */
const TSCONFIG = "tsconfig.json";
/** 记账用例里那个「编辑过的 TS 源码」路径。 */
const EDITED_TS_FILE = "/w/src/a.ts";

describe("EditAccumulator：本回合编辑文件记账", () => {
  let acc: EditAccumulator;
  beforeEach(() => {
    acc = new EditAccumulator();
  });

  it("记 edit/write 的 file_path，drain 时去重返回并清空", () => {
    acc.note("edit", "/w/a.ts");
    acc.note("edit", "/w/a.ts");
    acc.note("write", "/w/b.rs");
    assert.deepEqual(acc.drain(), ["/w/a.ts", "/w/b.rs"]);
    assert.deepEqual(acc.drain(), [], "清空后再次 drain 为空（防重复批处理）");
  });

  it("非编辑工具不记；空路径不记", () => {
    acc.note("bash", "/w/x");
    acc.note("edit", "");
    acc.note("edit", undefined);
    assert.deepEqual(acc.drain(), []);
  });

  it("str_replace_editor 记账（并存编辑器不逃过门禁）", () => {
    acc.note("str_replace_editor", "/w/a.ts");
    acc.note("edit", "/w/b.ts");
    assert.deepEqual(acc.drain(), ["/w/a.ts", "/w/b.ts"]);
  });

  it("只记代码/配置扩展名（md/txt/png 等忽略——它们不需要门禁）", () => {
    acc.note("edit", EDITED_TS_FILE);
    acc.note("edit", "/w/b.md");
    acc.note("edit", "/w/c.png");
    acc.note("edit", "/w/d.json");
    acc.note("edit", "/w/e.rs");
    assert.deepEqual(acc.drain(), [EDITED_TS_FILE, "/w/d.json", "/w/e.rs"]);
  });

  it("容量上限：超出淘汰最旧（防超长回合内存膨胀）", () => {
    const small = new EditAccumulator({ maxFiles: 2 });
    small.note("edit", "/w/1.ts");
    small.note("edit", "/w/2.ts");
    small.note("edit", "/w/3.ts");
    const drained = small.drain();
    assert.equal(drained.length, 2);
    assert.ok(!drained.includes("/w/1.ts"), "最旧的被淘汰");
  });

  it("重复编辑要把顺序刷到最近（否则反复编辑的文件最早被淘汰）", () => {
    const small = new EditAccumulator({ maxFiles: 2 });
    small.note("edit", "/w/1.ts");
    small.note("edit", "/w/2.ts");
    // 再编辑一次 1.ts → 它变成最新，被淘汰的应是 2.ts
    small.note("edit", "/w/1.ts");
    small.note("edit", "/w/3.ts");
    assert.deepEqual(small.drain(), ["/w/1.ts", "/w/3.ts"]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["负数", -1],
    ["0", 0],
    ["小数", 2.5],
  ])("非法 maxFiles（%s）回退默认值：记账照常、不淘汰", (_label, bad) => {
    // 归一化之前这四种入参各自出问题：NaN 让 `size >= NaN` 恒假（永不淘汰、Set 无限增长），
    // 负数每次 note 都淘汰一项，0 让容量实际变成 1。合法值为正整数，其余按"没给"处理。
    const acc2 = new EditAccumulator({ maxFiles: bad });
    for (let i = 0; i < 10; i += 1) {
      acc2.note("edit", `/w/${String(i)}.ts`);
    }
    assert.equal(acc2.droppedCount(), 0, "默认上限远大于 10，不应产生淘汰");
    assert.equal(acc2.drain().length, 10);
  });

  it("容量淘汰计数可查 droppedCount（drain 后清零，host 侧 warn 用）", () => {
    const small = new EditAccumulator({ maxFiles: 2 });
    small.note("edit", "/w/1.ts");
    small.note("edit", "/w/2.ts");
    assert.equal(small.droppedCount(), 0);
    small.note("edit", "/w/3.ts");
    assert.equal(small.droppedCount(), 1);
    assert.deepEqual(small.drain(), ["/w/2.ts", "/w/3.ts"]);
    assert.equal(small.droppedCount(), 0, "drain 后计数清零");
  });

  it("accumulator 的 EDIT_TOOLS 是 host 与累加器共用的唯一真源", () => {
    // host.ts 的 isEditTool 从同一集合取值：两边各写一份时新增编辑器工具只改一侧就会
    // 静默分叉（只改 host 则累加器丢记账，只改累加器则 host 根本不调用 note）。
    assert.deepEqual([...EDIT_TOOLS].toSorted(), ["edit", "str_replace_editor", "write"]);
  });
});

describe("gate-detect：项目门禁命令自动探测", () => {
  it("pnpm-workspace + package.json + 已声明 check 脚本 → pnpm check", () => {
    const roots: ProjectRoot[] = [
      {
        root: "/w/wukil",
        files: [PKG_JSON, WORKSPACE_MANIFEST, "src/a.ts"],
        scripts: ["build", "check"],
      },
    ];
    assert.deepEqual(detectGate(roots), [{ root: "/w/wukil", command: ["pnpm", "check"] }]);
  });

  it("纯 Rust 项目（Cargo.toml）→ cargo check", () => {
    const roots: ProjectRoot[] = [{ root: "/w/rs", files: [CARGO_MANIFEST, "src/main.rs"] }];
    assert.deepEqual(detectGate(roots), [{ root: "/w/rs", command: ["cargo", "check"] }]);
  });

  it("pyproject.toml 里有 [tool.ruff] 段 → ruff check", () => {
    const roots: ProjectRoot[] = [
      { root: "/w/py", files: [PYPROJECT, "src/a.py"], ruffConfigured: true },
    ];
    assert.deepEqual(detectGate(roots), [{ root: "/w/py", command: ["ruff", "check", "."] }]);
  });

  it("只有 ruff.toml（无 pyproject）→ 同样拿到 ruff 门禁（host MANIFESTS 已登记该根标记）", () => {
    const roots: ProjectRoot[] = [{ root: "/w/py2", files: ["ruff.toml", "a.py"] }];
    assert.deepEqual(detectGate(roots), [{ root: "/w/py2", command: ["ruff", "check", "."] }]);
  });

  it("pyproject.toml 在场但无 ruff 段 → 不发 ruff 门禁（假失败回归）", () => {
    // pyproject.toml 不是 ruff 的配置标记，只是 Python 工程最常见的元数据文件。
    // 只写 [project]、lint 交给 pytest-flake8 / pylint 的工程大量存在；对它们发
    // `ruff check .`，宿主 PATH 上只要有 ruff，就会拿默认规则集判一个从未声明用
    // ruff 的项目，再把结果经同一个注入通道当成真实缺陷。
    const roots: ProjectRoot[] = [
      { root: "/w/py3", files: [PYPROJECT, "src/a.py"], ruffConfigured: false },
    ];
    assert.deepEqual(detectGate(roots), []);
  });

  it("pyproject.toml 存在但 ruff 配置信息缺失（undefined）→ 不猜，不发 ruff 门禁", () => {
    const roots: ProjectRoot[] = [{ root: "/w/py4", files: ["pyproject.toml", "a.py"] }];
    assert.deepEqual(detectGate(roots), []);
  });

  it("TypeScript 项目（package.json + tsconfig.json，无 workspace）→ tsc --noEmit", () => {
    const roots: ProjectRoot[] = [{ root: "/w/ts", files: [PKG_JSON, TSCONFIG, "index.ts"] }];
    assert.deepEqual(detectGate(roots), [{ root: "/w/ts", command: ["tsc", "--noEmit"] }]);
  });

  it("多项目根各得各的门禁（每根一条，互不影响）", () => {
    const roots: ProjectRoot[] = [
      { root: "/w/a", files: [PKG_JSON, TSCONFIG, "x.ts"] },
      { root: "/w/b", files: [CARGO_MANIFEST, "x.rs"] },
    ];
    const gates = detectGate(roots);
    assert.equal(gates.length, 2);
    assert.deepEqual(gates[1]?.command, ["cargo", "check"]);
  });

  it("无清单文件的目录 → 无门禁（空配置项跳过）", () => {
    const roots: ProjectRoot[] = [{ root: "/w/none", files: ["readme.md", "x.txt"] }];
    assert.deepEqual(detectGate(roots), []);
  });

  it("探测优先级：workspace > rust > python > tsc（同根并存时取最上层）", () => {
    const roots: ProjectRoot[] = [
      {
        root: "/w/mix",
        files: [PKG_JSON, WORKSPACE_MANIFEST, CARGO_MANIFEST, "a.ts"],
        scripts: ["check"],
      },
    ];
    assert.deepEqual(detectGate(roots)[0]?.command, ["pnpm", "check"]);
  });

  it("空输入安全", () => {
    assert.deepEqual(detectGate([]), []);
  });
});

describe("gate-detect：files 为根目录相对名", () => {
  it("相对名匹配清单（绝对路径输入不匹配——归并由 host 层负责）", () => {
    const roots: ProjectRoot[] = [{ root: "/w", files: [PKG_JSON, TSCONFIG] }];
    assert.deepEqual(detectGate(roots)[0]?.command, ["tsc", "--noEmit"]);
    // 绝对路径输入不触发（防御：探测只认相对名）
    const abs: ProjectRoot[] = [{ root: "/w", files: ["/w/package.json"] }];
    assert.deepEqual(detectGate(abs), []);
  });
});

describe("gate-detect：假失败回归（门禁误报 HOME 的 npm init 空壳）", () => {
  it("只有 package.json、无 tsconfig.json → 不发 tsc 门禁（HOME 的 npm init 空壳）", () => {
    // 实测事故：主目录下的 package.json 是 npm init 空壳（无 tsconfig），
    // 被当 TS 项目发 tsc 门禁 → 无配置可读 → 假失败注入。tsconfig 是必要条件。
    const roots: ProjectRoot[] = [{ root: "/home/dev", files: [PKG_JSON] }];
    assert.deepEqual(detectGate(roots), []);
  });

  it("tsconfig.json 是 tsc 门禁的必要条件（package.json 单独不够）", () => {
    assert.deepEqual(detectGate([{ root: "/w", files: [PKG_JSON] }]), []);
    assert.deepEqual(detectGate([{ root: "/w", files: [TSCONFIG] }]), []);
    assert.deepEqual(detectGate([{ root: "/w", files: [PKG_JSON, TSCONFIG] }])[0]?.command, [
      "tsc",
      "--noEmit",
    ]);
  });

  it("workspace 门禁不受 tsconfig 要求影响（只要声明了 check 脚本）", () => {
    const workspaceRoot: ProjectRoot = {
      root: "/w",
      files: [PKG_JSON, WORKSPACE_MANIFEST],
      scripts: ["check"],
    };
    assert.deepEqual(detectGate([workspaceRoot])[0]?.command, ["pnpm", "check"]);
  });
});

// 门禁探测的「假失败注入」防线：`pnpm check` 只在根 package.json 真的声明了 check 脚本时
// 才提议。没有 check 脚本的 pnpm 工程是绝大多数，而 `pnpm check` 会以
// 「Command "check" not found」非零退出 —— 本包把门禁失败当真实质量缺陷去开新回合注入
// 修复指令，于是「工程没问题的前提下被要求去修一个不存在的脚本」。
describe("gate-detect：pnpm check 必须有已声明的 check 脚本", () => {
  it("workspace 根 scripts 里没有 check → 不发 pnpm check，退到下一候选（tsc）", () => {
    const roots: ProjectRoot[] = [
      {
        root: "/w/nocheck",
        files: [PKG_JSON, WORKSPACE_MANIFEST, TSCONFIG],
        scripts: ["build", "test"],
      },
    ];
    assert.deepEqual(detectGate(roots), [{ root: "/w/nocheck", command: ["tsc", "--noEmit"] }]);
  });

  it("workspace 根无 check 脚本且不是 TS 工程 → 一条门禁都不给（宁缺毋滥）", () => {
    const roots: ProjectRoot[] = [
      { root: "/w/nocheck2", files: [PKG_JSON, WORKSPACE_MANIFEST], scripts: ["build"] },
    ];
    assert.deepEqual(detectGate(roots), []);
  });

  it("scripts 信息缺失（undefined：package.json 读不到/JSON 坏/无 scripts 字段）→ 不发 pnpm check", () => {
    // 保守口径：拿不到信息时**不猜**。给一条没有依据的门禁 = 给一条可能注定命令级失败
    // 的门禁；少给一次门禁只是少一次自动核验，用户可以自己跑。
    const roots: ProjectRoot[] = [
      { root: "/w/unknown", files: [PKG_JSON, WORKSPACE_MANIFEST, CARGO_MANIFEST] },
    ];
    assert.deepEqual(detectGate(roots), [{ root: "/w/unknown", command: ["cargo", "check"] }]);
  });

  it("空 scripts 清单（package.json 有 scripts 之外的形态）同样不发 pnpm check", () => {
    assert.deepEqual(
      detectGate([{ root: "/w/empty", files: [PKG_JSON, WORKSPACE_MANIFEST], scripts: [] }]),
      [],
    );
  });
});

describe("accumulator：.sh 不记账（四种门禁命令都无法校验 shell 脚本）", () => {
  it(".sh 文件不计入门禁面（不会把根拖到无关的 package.json 上）", () => {
    const acc = new EditAccumulator();
    acc.note("write", "/home/dev/.dsh/run-all-tests.sh");
    acc.note("edit", EDITED_TS_FILE);
    assert.deepEqual(acc.drain(), [EDITED_TS_FILE]);
  });

  it("其余代码/配置扩展名仍照常记账", () => {
    const acc = new EditAccumulator();
    for (const filePath of [
      "/w/a.ts",
      "/w/b.tsx",
      "/w/c.mjs",
      "/w/d.rs",
      "/w/e.py",
      "/w/f.json",
      "/w/g.yaml",
      "/w/h.yml",
      "/w/i.toml",
    ]) {
      acc.note("edit", filePath);
    }
    assert.equal(acc.drain().length, 9);
  });
});
