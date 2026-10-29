# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。最新版本在最上。

## 0.1.4

这一版收窄回合门禁的作用域：子包自己的 workspace 门禁不再被外层伞工作区顶掉，改单仓的回合不再跑整棵树。

### Fixed

- **单仓安装态下两份 zod 的 `ZodType` 不兼容**：宿主投影包自带 zod 4.4.3，本包 catalog 是
  4.6.7；`editLedgerProjection.stateSchema` 经宿主声明的类型做一次窄桥接，运行期仍交给宿主
  `safeParse`，不改依赖版本。
- **子包自己的 workspace 门禁被外层伞工作区顶掉。** 编辑一个自带 `pnpm-workspace.yaml` 且声明了 `check` 的子包时，根探测会继续上溯到外层伞工作区，把「改一个仓」放大成「整棵树跑一遍 `pnpm check`」：回合收口的预算被单条命令吃光，改本仓的回合反而反复超时。现在子包自己产得出 `pnpm check` 时就地执行、不再上溯；外层升级只在子包自己产不出门禁时发生。`test/host-integrity.test.ts` 新增一条伞工作区用例钉住这一面。
- **脚本内部的 exit 126/127 被误报成「门禁工具缺失」。** 126/127 是整条命令的退出码，不是「工具没装」的充分证据：`pnpm check` 的 check 脚本里缺命令时 pnpm 同样以 127 退出（实测 `pnpm run check` 对不存在的脚本命令回 `[ELIFECYCLE] Command failed with exit code 127`），tsc 的脚本也可能因缺 devDependency 回 127。原先这两档一律按 not-run 注入「command not found (tool not installed) — the gate did not run」，项目自己的坏脚本被当成环境问题放掉。现在只有 stderr **点名门禁命令自己的首 token**（`sh: pnpm: command not found`、`command not found: tsc`、Windows 的 `'pnpm' is not recognized`）才判工具不可用，其余 126/127 按代码失败上报并附证据；126 同理只在点名「不可执行」时判 not-run。`test/host.test.ts` 与 `test/host-integrity.test.ts` 的 126/127 用例补上点名证据，并新增一条「脚本内 127 仍报代码失败」的用例。

## 0.1.3

这一版把判定面与构建/CI 面一起收口：ruff 不再对只写了 `pyproject.toml` 的工程发门禁，卡片保存期间的编辑不再被静默丢弃，记忆反馈的文案与来源一致，Windows 与发布链的静默降级补上判据。宿主线抬到 `0.2.1-rc.3`。

### Fixed

- **只写了 `pyproject.toml` 的 Python 工程会被发 `ruff check .`。** `pyproject.toml` 是 Python 的元数据文件，不是「本项目用 ruff」的声明；原先只要它在场就产门禁，于是把 lint 交给别的工具的工程会被宿主 PATH 上的 ruff 按默认规则判一遍，再经同一个注入通道当成真实缺陷。现在 ruff 门禁要求根上有 `ruff.toml`，或 `pyproject.toml` 里真有 `[tool.ruff]` 一族段（段头按行首字面匹配，带引号的键与整表数组一并认）；两者都没有就不发。拿不到 `pyproject.toml` 内容时按「没有信息」处理，与读不到同一方向。
- **卡片保存期间的编辑会被静默丢弃。** 保存请求在途时输入框只按 `writable` 禁用，用户仍能继续改；而写入成功后无条件清空待保存集合，把点保存之后产生的新改动一起抹掉。现在只剔除本次真正写下的键，在途期间的新改动留在待保存面里。
- **记忆反馈的文案承诺了实现没做的事。** 文案说清空 key 就不启用记忆反馈，实际还有环境变量里的网关地址兜底、引用名也会回落到默认值；照着改，代码型门禁失败的证据仍会发出去。文案改成如实说明两条来源。
- **`test/` 下三处机器侧门禁的静默放行**：动态 `import()` 吃裸文件路径（Windows 上抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）改走 `pathToFileURL().href`；产物清单为空时两侧都折成同一个空串、被判「新鲜」，改为当场抛错；显式设了 `DSH_PROFILE_PACKAGE_JSON` 却指向不存在的文件时静默跳过，改为判红。
- **四个工作流里的判断面缺陷**：`ci.yml` 的 `find … -print -quit` 在零匹配时得到空串、多匹配时静默取任意一个，改为「恰好一个 tarball」并点名实际个数；`publish.yml` 的重复发布检查把包名与依赖名写死在 URL 里（改名后会查到 404 而当成首发放行），改为从 `package.json` 读，并在版本低于 registry `latest` 时告警（只告警：从旧分支发版会把 `latest` 回退，但半吊子的预发布序比较不该一票否决发布）；静态 token 的形态校验把 `exit 1` 降级为告警，OIDC 主线不该被兜底凭据的形态卡死；`scorecard.yml` 的 job 级判据用 `github.ref_name` 比默认分支名，同名 tag 上会误判，改为比完整 ref。
- **`ci.yml` 的 `-ignore SC2016` 是全局豁免**：一行调用同时校验四份工作流，`codeql.yml` 与 `scorecard.yml` 没有 run 脚本体，却也继承了这条豁免——它们将来真写出的同类缺陷会被一起吞掉。改成按文件分两次调用。
- **`codeql.yml` 与 `scorecard.yml` 缺并发控制与权限声明**：前者补 `actions: read`（本仓是 public，官方只在私有仓要求它；显式声明是为了可见性变化时不静默缺权限），后者补按事件名分组的 `concurrency`，让四个入口不再互相覆盖同一份 analysis 结果。

- **`test/schema-coverage.ts` 的 host schema 解析器**：括号匹配不跳过字符串、模板与注释，`Schema.object(` 只取首个块，扩展名只收 `.ts`，包根靠 `testDir/..` 硬推且读盘无兜底。这些偏差都会让「宿主字段全集」偏少而门禁假绿。解析器改成字符串/注释感知、遍历全部 `Schema.object`、按前缀识别扩展名、向上找 `package.json`、读不到时判红；新增 `test/schema-coverage.test.ts` 钉住这一面。
- **记忆反馈的目标面与正文收口**：网关地址必须是合法的 `http(s)` URL（半截串、非 http(s) scheme 均按「未配置」处理），凭据只发 https 或回环地址；`x-tdai-service-id` 形状不合规时回落默认服务名；命令、根与错误文本在写入记忆前折成单行，避免一条反馈被拆成多段。
- **编辑累加器的容量契约对任意入参成立**：`maxFiles` 为 NaN、0、负数或小数时回落到默认值；同一文件被反复编辑会刷新到最近位置，避免最该检查的文件第一个被淘汰；host 与累加器共用同一份编辑工具名单。
- **消息模板插值只认自有键**：`{constructor}` / `{toString}` 这类原型链名字不再渲染成函数源码，未提供的名字留空串。

### Changed

- **`ruff` 门禁的可发条件**（见 Fixed 第一条）是**判定规则**的变化：只有 `pyproject.toml` 的 Python 工程从此不再自动获得 ruff 门禁。两份 README 的命令表同步。
- **宿主线抬到 `0.2.1-rc.3`**：`engines.dsh`、peer/dev 依赖、overrides 与 README 徽标/正文同值。
- **构建编排统一进 shared 的 `lib/build-*`**：三个构建脚本只剩薄配置层，产物仍落 `dist/`；CI/CodeQL/Scorecard/Dependabot 与 Windows 矩阵补齐。

### Build and CI fixes

这一版同时清掉构建侧与 CI 侧的缺陷：一批只在 Windows 上才会红的判据、两个构建脚本里没有任何门看得见的静默降级，以及发布链路缺的一道检查。

#### Fixed

- **`host.ts` 里三处用 `/` 拼子项的地方改成 `path.join`。** `findManifestRoot` 探测 `MANIFESTS`、`workspaceRootUpgrade` 探测 `pnpm-workspace.yaml`、`probeProjectRoot` 过滤 manifest 与判断 `tsconfig.json`，原先都用模板串拼出 `dir/manifest`。`dir` 是宿主给的真实路径，在 Windows 上这种混形让 `existsSync` 恒假——于是所有 manifest 都探测不到、项目根一路回落到父目录，`gate-detect` 的判据整片失效而命令照常退出 0。同一处 `declaredScriptsOf` 读 `package.json` 也改成 `path.join`。新增 `TSCONFIG_MANIFEST` 常量，避免同一个文件名在文件里出现两次。
- **`collapseStorePaths` 的折叠原先完全静默。** 正则只认 `/` 分隔的「内容寻址 store 段」（`node_modules/` 下那层带「名@版_哈希」的目录），既没有归一反斜杠，也没有折掉前缀里的 `../`。没命中时它原样放行，于是 `client.js` 会带着「版本 + 本机 store 哈希」进公共产物，而两道新鲜度门禁比的都是同一台机器上的内存构建与磁盘文件——没有任何门能看见。现在先归一分隔符，再把可选的前缀与 store 段整段折成一层，折完仍检出 store 段就抛错停止构建。
- **`writeArtifact` 的临时文件名只用 pid。** 同一进程里并发写两个产物会撞名、各自截断对方。临时名加上 `randomUUID()`；`catch` 里清理临时文件的 `rm` 包进内层 try/catch，清理失败不再取代并吞掉真正的写失败（Windows 上 `EBUSY` / `EPERM` 会让清理自己抛）。
- **客户端产物的 `external` 由 `id.startsWith("react/")` 改成精确集合 `REACT_RUNTIME_MODULES`。** 外壳的模块表按精确串匹配，前缀放行会给产物留下模块表里没有的键——加载期报 `not in the module table`，整张卡片静默不渲染。集合与宿主客户端侧的 `PLATFORM_MODULES` 同源，只收宿主真给得出的四个说明符。
- **两处注释与实现不符。** 构建脚本的头注释说「react 及其子路径都要外部化」并给了「内联子路径会出现第二份 React」的理由——那个理由不成立，`react/jsx-runtime` 内联后自身仍 `require("react")`；`ci.yml` 里「门禁没跑过就别留下产物。」那行原先挂在上传覆盖率报告上方，与它描述的步骤错位。
- **`test/host-integrity.test.ts`、`test/host.test.ts`、`test/gateway-feedback.test.ts` 的 POSIX 假设。** 新增的 Windows 矩阵会让这些判据整片红：临时目录原先写成字面量 `/tmp/qg-shallow-…`，改成 `path.join(tmpdir(), …)`；匹配 tsc 命令的正则 `/bin\/tsc --noEmit$/u` 在 Windows 上拿到的渲染是 `'C:\…\bin\tsc' --noEmit`（带引号、反斜杠），改成 `/bin[\\/]tsc'? --noEmit$/u`；`deriveProjectKey` 的注入补上 `sep: "/"`，让它与字形的来源同源——路径字形与 `resolve` 不来自同一次调用时，`path.win32` 会把 `/tmp/x/proj` 解析成带盘符的串，字面量替换一次都不命中。

#### Added

- **`tsconfig.build-scripts.json` 与 `typecheck` 里的一次额外 `tsc`。** 两个构建脚本头部的 `// @ts-check` 只在编辑器里生效：它们不在任何 `tsc` program 的 `include` 里，CI 因此对这一面没有任何门。新 tsconfig 继承共享基线、打开 `allowJs` / `checkJs`、`noEmit`，只收两个构建脚本；`typecheck` 追加 `&& tsc --noEmit -p tsconfig.build-scripts.json`。变异实测：往 `build-client.mjs` 塞一行 `probe.toFixed("nope")` 会红，删掉即绿。
- **`tsconfig.build-scripts.json` 补齐之后暴露并修掉的类型缺陷**：`isRecord` 一律改成类型谓词（`@returns {raw is Record<string, unknown>}`），`asRecord` 改成守卫分支而不是类型断言（断言会同时撞 `typescript(no-unsafe-type-assertion)` 与 `eslint(no-inline-comments)`）；`invokedDirectly()` 先取 `process.argv.at(1)` 再判 `undefined`，不再把可能不存在的值直接交给 `realpathSync`；读 `package.json` 的 `name` 用 `const nameKey = "name"` 索引——点号写法被 `noPropertyAccessFromIndexSignature` 拒绝，索引写法又被 `dot-notation` 要求改成点号，两侧只能靠一次具名取值同时满足。
- **`.gitattributes` 钉 `* text=auto eol=lf`。** Windows runner 上 Git for Windows 的机器级 `core.autocrlf=true` 会把工作树换成 CRLF，而 `oxfmt` 的 `endOfLine` 默认是 `lf`——`fmt:check` 只在 windows 那一格把每个文件都判成未格式化，内容一字不差。
- **`test/dist-size.test.ts` 的预算改成按实测锚定**：`host.js` 70 500 B（实测 61 110 B）、`client.js` 23 500 B（实测 20 222 B），取实测上浮约 15% 再向上取整到 500 B。注释写明本仓没有 `build-types.mjs`，所以只量两项。
- **`package.json` 的 `keywords`**，以及两份 README 各新增一节「shared 的版本下限 / Shared version floor」。

#### Changed

- **`publish.yml` 补回 `pnpm run check`。** 发布由 `workflow_dispatch` 手动触发，可以从任意分支派发；CI 在 `main` 上的绿不代表被派发的那个 ref 是绿的，而发布前少这一道检查等于把「发布物能装」与「发布物正确」当成一件事。现在它在 `pnpm install --frozen-lockfile` 之后、`发布` 之前跑。
- **`ci.yml` 的覆盖率上传取 `if-no-files-found: warn` 而不是 `error`。** 这一步在 `if: always()` 下跑，而 `coverage/` 由 vitest 产出——typecheck / lint / build 任一先红时目录根本不存在，此时判红会盖住真正的失败原因，还把后面的步骤一起中断。
- **`ci.yml` 里新增的 Windows 矩阵与多平台并发组的形状**：组键带 `event_name`，取消只给 `push` 与 `pull_request`；gate 的检查名带 `matrix.os`；attest 拆成独立 job 并补齐 `artifact-metadata: write`；install-probe 收窄到 `contents: read`；所有 `actions/checkout` 带 `persist-credentials: false`；第三方 action 与 `actionlint` 全部钉到 commit SHA / 校验和。

#### Not changed, deliberately

- **除 ruff 的可发条件外，四条命令的白名单与优先级、`not-run` 与 `code-failure` 的分界、注入配额、预算分摊、默认设置值与双语文案内容未变。**
- **覆盖率阈值仍由 `@jayyuen66/dsh-plugin-shared/config/vitest.base` 单源给出（100%）**，`coverageInclude` 仍只覆盖 host 半。

#### Tests

- `pnpm run check` 通过：typecheck 三个 tsconfig、`oxlint` 0 warning / 0 error、两个 rolldown 构建、`vitest run --coverage` 四项 100%、`oxfmt --check`、`check:pack` 的 tarball 体检。
- 新增的门禁都做过变异实测：`tsconfig.build-scripts.json` 那条塞错误即红、删掉即绿；`collapseStorePaths` 的残留检查拿含 `.pnpm` 的行喂进去会抛，四种真实形态（无前缀 / `../` 前缀 / 反斜杠 / 普通相对段）折叠结果逐个断言。
- Windows 兼容那三条用渲染出的两种字形直接验证判据：POSIX 形态的 `<root>/node_modules/.bin/tsc --noEmit` 与 win32 形态的带盘符、带反斜杠、带引号那一种，旧正则只命中前者，新正则两个都命中。

## 0.1.2

`tsc` 改走本包依赖、凭据只发 https，并修掉三处「命令照绿而门禁没在工作」的静默失效。

### Fixed

- **事件读面缺失或读失败时整条门禁静默失活、零日志。** 改为按成因 warn-once，并补「同一条只说一次」的断言。
- **每回合让宿主按默认 `projectionMode="all"` 白算整份 session 投影**：显式传 `"none"`。
- **`workspace` 上溯会把子包自己的 `tsc` / `ruff` 门禁吃掉**：只在外层真能产出门禁时才升级，两份 README 同步。
- **`npx tsc` 在项目未装 `typescript` 时会下载并执行已弃用的 stub 包**：`typescript` 进 `dependencies`，门禁改为解析真实入口（工程本地优先、其次本包依赖），`npx` 与 stub 的识别文案删除；命令拼接补引号处理。
- **记忆网关允许明文 `http` 并照发 `Bearer`**：只允许 `https` 或回环地址，其它地址在解析凭据之前按未配置拒绝并说明理由。

### Changed

- `vitest.config.ts` 写明客户端半边不计覆盖率的理由（共享基线要求的例外说明）。

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
