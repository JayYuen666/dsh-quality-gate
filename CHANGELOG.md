# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。最新版本在最上。

## 0.1.1

宿主生态与工具链跟到发布线，发布面的判据补严。**门禁判定规则、四条命令白名单、注入文案与
默认设置都没改**，改的是「跟谁对齐」与「发出去的东西长什么样」。

### Changed

- `@deepseek-ai/*` 家族从 `0.2.1-alpha.1` 升到 `0.2.1-alpha.2`：devDependencies、
  peerDependencies 的 `@deepseek-ai/dsh`、`pnpm-workspace.yaml` 的 `overrides`、`engines.dsh`
  四处同值（`test/publish-manifest.test.ts` 要求 `dsh-*` 与 peer 逐项相等）。
  `@deepseek-ai/cordis` `4.0.5-alpha.1` 与 `@deepseek-ai/schemastery` `3.18.5-alpha.1` **不动**：
  那是 alpha.2 自己钉的两枚（`~4.0.5-alpha.1` / `~3.18.5-alpha.1`），registry 上没有更新的 alpha。
- 上游逐包比对过发布件：本包消费的声明面没有 breaking。`dsh-agent` / `dsh-credentials` /
  `dsh-settings` / `dsh-shell` / `dsh-sandbox-policy` / `dsh-package-manifest` 的 shipped 内容
  与 alpha.1 逐字节相同；`dsh-session` / `dsh-session-query` / `dsh-client-ui-plugin-manager`
  只有增量。打包契约（`cordis.patch.yml`、`dsh.bundle.patch`、`dsh.client`、`manifestVersion: 1`）
  不变，因此 `host.ts` 无必须的适配改动。
- `@jayyuen66/dsh-plugin-shared` `^0.1.2` → `^0.1.4`。这一枚改变了**发布物形状**：0.1.2 把
  `@deepseek-ai/dsh-jobs` / `dsh-tools` / `dsh-session` 等宿主包列在自己的 `dependencies` 里，
  消费方 profile（`nodeLinker: hoisted` + `autoInstallPeers: false`）于是会物化出第二份宿主
  类型面——正是「`@deepseek-ai/*` 不进 dependencies」那条门禁管不到的依赖树下一层。0.1.3 把它们
  挪进 `peerDependencies`，0.1.4 再把那几枚 peer 钉到 `0.2.1-alpha.2`。
- 入口面：`main` / `exports` 指向构建产物 `host.js` / `client.js`，入口覆盖不再写在
  `publishConfig` 里（pnpm 发布时合并到顶层、npm 忽略并打印 Unknown publishConfig——同一仓库
  换个发布器就会发出一个 import 必失败的包）。
- 工具链（`pnpm-workspace.yaml` 的 `catalog`）跟到发布线：`@types/node` 26.6.3→26.6.5、
  `vitest` 与 `@vitest/coverage-v8` 5.0.2→5.0.3、`vite` 8.3.1→8.3.4、`rolldown` 1.2.11→1.2.13、
  `oxlint` 1.86.0→1.87.0、`oxfmt` 0.71.0→0.72.0、`oxlint-tsgolint` 7.0.2003→7.0.2004。
  `typescript` 7.0.2、`react` / `@types/react` 19.3.0、`eslint-plugin-sonarjs` 4.2.2 已在发布线。
- 新增 `engines.node`（`>=22.12.0`）：产物用到 `AbortSignal.any` 这类较新的运行面。
- `tsconfig.client.json` 删掉 `"types": ["node"]` 这枚本地覆盖：shared 的 client 预设本来就是
  `types: []`，这一枚覆盖把 Node 全局又塞回了 client 半。删掉后 client 工程与宿主预设同形，
  类型检查照绿——client 面从未依赖 Node 全局。

### Added

- 文档拆分：`README.md` 为英文入口、`README.zh-CN.md` 为中文，两行头部互链。
- `CHANGELOG.md` 与 `THIRD_PARTY_NOTICES.md`（ECC `stop-format-typecheck` /
  `post-edit-accumulator` 的机制来源与差异表），两者一并写进 `files`。
- `test/publish-manifest.test.ts` 的发布面门禁：
  - 「仓库根目录每个 `.md` 都必须出现在发布面里」——只有 readme 形态的文件靠发布器无条件附带，
    `CHANGELOG.md` 之类不写进 `files` 就发不出去，而"文档写了但读者看不到"此前无人能发现。
  - `ALWAYS_SHIPPED` 改为按 `pnpm pack --dry-run` 实测的四枚，删掉不成立的条目。
  - 构建产物的内容扫描：随包发布的 `host.js` / `client.js` 里不许出现日期、本机绝对路径、
    pnpm 的 store 目录名。
  - `engines.dsh` 必须等于 peer `@deepseek-ai/dsh` 去掉区间算子的下界；`engines.node` 不得
    低于宿主发布线。
- 注释门禁（同一文件）从「只禁完整日期」扩到：只到月份的日期、指向作者主目录的本机路径、
  pnpm 的 store 目录名、内部工作项编号（字母+数字形态）、指向未随包发布的笔记的行号指针、
  上游源码仓的工作区路径，以及描述工作过程而非约束本身的那一类词（黑名单逐条见
  `test/publish-manifest.test.ts` 的 `FORBIDDEN_IN_COMMENTS`）。据此把 `host.ts`、`lib/*.ts`、
  `src/*.ts` 的注释重写了一遍：只留约束本身，删掉过程记录。指向已安装依赖的声明文件行号不在
  禁面内——版本钉住之后那是人人可查的证据。
- `pack-check.mjs` + `check:pack` 脚本：对 `pnpm pack` 产出的**真 tarball** 做体检——入口与
  无条件附带项都在包里、源码与本地状态目录没混进去、`@deepseek-ai/*` 没落进 `dependencies`、
  代码面里每个裸说明符都由 dependencies ∪ peerDependencies 提供、产物内容不含日期与本机路径。
  已接进 `check`，因此本地与 CI 同一口径。
- `test/dist-size.test.ts`：两个构建产物的字节预算。判据落在体积上是因为「依赖被内联进产物」
  这一类回归没有更早的报警器——类型检查与单测都不看产物。
- `ci.yml`：push / PR 上跑 `pnpm install --frozen-lockfile` + `pnpm run check`（含上面那条
  tarball 体检），并断言门禁没有改写受版本控制的文件。运行时只跑 node 24，与发布流程同一条线。

### Fixed

- `@deepseek-ai/dsh-credentials` 的声明位置与注释不一致：注释说它落在 `dependencies`，
  实际由「`@deepseek-ai/*` 不进 dependencies」的门禁禁掉。注释按真实机制改写——它靠
  **peerDependencies** 进入 `build-host.mjs` 的外部化面（外部化集合 = dependencies ∪
  peerDependencies），因此产物保留裸说明符、官方函数体不被内联。
- README 里「另一枚运行期依赖是 `@deepseek-ai/schemastery`」的措辞：那一枚由宿主解析、
  不由本包安装，文档改为按真实来源描述，并补上宿主版本要求。

### Not changed, deliberately

- 四条门禁命令的白名单与优先级、`not-run` 与 `code-failure` 的分界、注入配额、预算分摊、
  默认设置值、双语文案内容。
- `@deepseek-ai/*` 一律 type-only（`dsh-credentials` 的两枚纯字符串函数除外）。
- 覆盖率阈值仍由 `@jayyuen66/dsh-plugin-shared/config/vitest.base` 单源给出（100%），
  本包不放宽；`coverageInclude` 仍只覆盖 host 半（`host.ts` + `lib/*.ts`），client 半没有
  DOM 环境可跑，见 `test/client-card.test.ts` 的说明。

### Tests

- 门禁全套通过：typecheck（两个 tsconfig）、`oxlint`（0 warning / 0 error）、两个 rolldown
  构建、`vitest run --coverage`、`oxfmt --check`。
- 构建产物在真实 Node 上直接 `import()` 装载成功，裸说明符全部解析得到。
- `pnpm pack` 的 tarball 逐项目检：入口指向构建产物、`@deepseek-ai/*` 不在
  `dependencies`、两份 README 与两份新文档都在发布面里。

## 0.1.0

`@jayyuen66` 作用域下的首个公共 npm 发布。

### Added

- 回合收口质量门禁：`agent/turn-stopping` 按项目形态跑 `pnpm check` / `cargo check` /
  `ruff check .` / `npx tsc --noEmit`，未过则注入修复指令开新回合。
- 显式三态判定（`pass` / `code-failure` / `not-run`）与会话级配额、总预算、编辑记账。
- 设置卡（web client 面）与中英双语文案；记忆网关反馈默认关闭，密钥走宿主凭据通道。
