# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。最新版本在最上。这里的偏离是刻意的：
版本标题不写发布日期（各版发布时间以 npm registry 为准，`npm view <包名> time` 取得到），并按需
增设标准六类之外的小节（如 `Tests`、`Not changed, deliberately`）。

## 0.1.14

会话侧栏开始显示真实门禁结果：每个会话留最近 20 条（命令、根、结论、单行摘要），经官方 Typert Remote 命名空间 `qualityGate` 的 `latest` / `state` 两个读方法读取，并由 `run` 立即执行一次；读面缺席（精简上下文、旧宿主）时侧栏的结果格显示“本会话尚无记录”，不报错。`@deepseek-ai/dsh-typert-protocol` 进入 devDependencies 与 peerDependencies（与 `dsh-dir-prep-organize` 同形）。

把"门禁没跑成"与"代码有问题"分开，并补上项目自定义门禁入口。包级 `tsc` 假失败根治：tsconfig 的 `references` 按 JSONC 解析（注释、尾逗号与字符串里的字样都不误判），带非空 `references` 的根不再发 `tsc --noEmit`（包级命令在未构建引用时必报 `TS6305`）；渲染期仍可能出现的 `TS2688 / TS6305 / TS6306 / TS6307` 按环境问题归为 `not-run`。`pnpm` 根有 lockfile 但无 `node_modules` 时不发命令，提示先安装依赖；脚本内部的 exit 126/127 一律按环境不可用处理。新增 `pnpmScripts`：只执行根 `package.json` 真声明且名字形状安全的脚本。队友台账的冷读移出串行段，`observeSession` 接组合信号与 15s 上限；门禁结果加回合判据（`lastTurn` 前进即丢弃）；首次见到会话的事件窗收在本回合起点；台账相对路径按条目自己的 `cwd` 解析。

### Added

- **门禁结果留存**：每条门禁（含预算不足被跳过的那条）记一行 `{ at, gate, root, outcome, detail }`，detail 压成单行并截到 200 字符，按会话环形保留 20 条。
- **`qualityGate` Remote 读面**：`latest()` 跨会话取最新一条；`state({ sessionId })` 取该会话的行。客户端 descriptor 手写、请求走 zod strict codec，应答逐行验形状，坏行丢掉而不是抛错。
- **会话侧栏**：在原有"启用状态 / 注入配额"两格旁增加"最近一次门禁"与"门禁命令"两格。
- **右键立即跑门禁**：会话菜单新增一项，经 `run` 方法对空闲会话跑一次当前项目的门禁；失败照回合收口同一套规则注入并开新回合，忙 / 无会话 / 无门禁时只回状态词。
- **diff 行注解（可选）**：装了 forge 面板（`ctx.forgeChanges` 在）时，结果里的诊断（tsc、go、cargo、ruff、rubocop、javac/Maven、dotnet、clang/gcc、PHP、eslint）注册为 `forge.diff.line.annotation` 源，按文件画到对应行；面板缺席就整条不出现，认不出的输出形状不产生注解。

- **九种语言的内置门禁矩阵**：项目没有声明自己的检查时，按根标记探测 JavaScript/TypeScript、Rust、Go、Python、Ruby、Java/Kotlin、C/C++、C#、PHP；同一个根可以有多条门禁，按 `root+command` 去重后串行执行。所有探测都是保守的：工具自己的配置文件/清单不出现就不发命令，工具缺失按 `not-run` 归因。
- **主流工具链补齐**：在九种生态的矩阵里增加各自的常用检查——JS/TS 的 `oxlint`/`oxfmt`/`prettier`/`biome`，Rust 的 `cargo clippy`，Go 的 `golangci-lint`/`staticcheck`，Python 的 `ruff format`/`black`/`flake8`/`pyright`/`pylint`，Ruby 的 `standardrb` 与 `Rakefile` 的 `check`/`test` 任务，C/C++ 的 `clang-tidy`/`cppcheck`，C# 的 `dotnet format`，PHP 的 `phpstan`/`psalm`/`php-cs-fixer`；仍然只认工具自己的配置，配置缺席就不发命令。
- **C/C++ 的 clang-format**：CLI 需要显式文件列表（不接受目录），所以不替项目拼 glob；只在 `.clang-format` 与 Makefile 的 `format-check` / `check-format` / `clang-format-check` 目标同时存在时跑 `make <目标>`。没有显式目标就不发命令，不会把目录参数硬塞给 clang-format。
- **Bazel**：根上有 `MODULE.bazel` / `WORKSPACE` / `WORKSPACE.bazel` 才追加 `bazel test //...`；这是项目显式声明的构建入口，整仓重构建仍受 `gateBudgetMs` 限制。
- **Java 的独立 Checkstyle**：没有 Maven/Gradle 的工程，根或 `config/checkstyle/` 下有 `checkstyle.xml` 且存在 `src/main/java` 时追加 `checkstyle -c <文件> src/main/java`；有构建工具时交给项目自己的插件/任务，不叠第二条。
- **Java/Kotlin 的独立静态分析**：`pom.xml` 里真的声明了 `maven-checkstyle-plugin`、`spotbugs-maven-plugin`、`maven-pmd-plugin` 或旧名 `pmd-maven-plugin` 时，Maven 改用 `verify`（`mvn -q verify` / wrapper 优先的 `./mvnw -q verify`），让项目自己的静态分析绑定到 `verify` 生命周期；没声明就仍跑 `test`，不猜插件坐标。Kotlin 另按自己的配置追加 `detekt --config <file>`（根或 `config/detekt/` 下的 yml/yaml），有 `.editorconfig` 与 `src/main/kotlin` 时再追加 `ktlint`。
- **可选的供应链扫描（`securityAudit`，默认关）**：打开后按锁文件追加一条依赖漏洞扫描——`package-lock.json` / `npm-shrinkwrap.json` → `npm audit --audit-level=high --omit=dev`，`pnpm-lock.yaml` → `pnpm audit --audit-level=high --prod`，`Cargo.toml` + `Cargo.lock` → `cargo audit`，`go.mod` → `govulncheck ./...`，`requirements.txt` → `pip-audit -r requirements.txt`，`Gemfile.lock` → `bundler-audit check --update`，`composer.lock` → `composer audit`。这一层独立于项目声明的 `check`：声明通常不包含依赖漏洞扫描，所以有声明时也会跑。
- **项目声明仍是第一层**：根 `package.json` 的 `check`、`pnpmScripts` 里点名且真声明的脚本、Makefile 的 `check`/`test` 目标压过所有内置探测（显式打开的 `securityAudit` 是唯一例外）。
- **诊断解析通用化**：`lib/gate-diagnostics.ts` 按命令解析各语言的行列诊断，`repoRelativeDiagnostics` 统一换算到仓库根相对路径；归因与 pass/fail 判定不变。
- **`GATED_EXT` 扩展**：覆盖 `.go`、`.rb`、`.java`、`.kt`、`.c/.h/.cc/.cpp/.hpp`、`.cs`、`.php`、`.xml`、`.gradle`、`.sln`、`.csproj`、`.ini`、`.cfg`、`.mod`、`.sum`，以及 `.neon`、`.jsonc`、`.clang-tidy`、`.cppcheck`、`Makefile`、`CMakeLists.txt`、`Gemfile`、`Rakefile`、`gradlew`、`mvnw`、`.rspec`、`.prettierrc`、`.flake8`、`.editorconfig`、`.oxlintrc`、`.oxfmtrc`、`.pylintrc` 这类文件名；`.sh` 仍排除。

### Changed

- **发布契约**：新增 peer `@deepseek-ai/dsh-typert-protocol`（`^0.2.3-alpha.2`），消费者跟随宿主共享实例。
- **`pnpm check` 的门槛**：只看根 `package.json` 是否声明了非空 `check`，不再要求 `pnpm-workspace.yaml`；workspace 根没有 `check` 时仍不退到 `tsc`（solution-style tsconfig 会永远通过）。
- **供应链扫描开关上设置卡**：`securityAudit` 改成 volatile，放在「门禁」小节的紧凑布尔单元格里，默认 `false`（这些扫描要联网，默认打开会让每次编辑回合都承担网络与额外工具的耗时）。部署值仍只有 `maxRootDepth` 与 `gateStdoutMaxBytes` 两项，继续走注册行 `config:`、改完重启。
- **`tsc` 门禁的判定条件**：`tsconfig.json` 的 `references` 非空时不再给包级 `tsc --noEmit`；这类工程应通过 `pnpmScripts` 声明自己的聚合检查。
- **`tsc` 环境错误**：`TS2688`（找不到类型定义）与 `TS6305/6306/6307`（引用产物未构建）改报 `not-run`，注入文案明确"不要为此修改代码"。
- **pnpm 依赖预检**：根有 `pnpm-lock.yaml` 且无 `node_modules` 时不发门禁命令（避免回合收尾时隐式安装/写盘），提示先 `pnpm install`。
- **exit 126/127 的归因**：只要 stderr 出现"命令不存在/不可执行"就按环境问题处理，包括项目脚本内部缺命令的情形。
- **`pnpmScripts`**：逗号或空白分隔的脚本名，默认空；仅根 `package.json` 真声明且匹配 `[A-Za-z0-9:._-]` 时执行 `pnpm run <名字>`。workspace 自己的 `check` 仍优先。
- **队友台账**：串行段只保留"列队友 + 读运行状态"；冷会话重放进入后台批次、在 `drain` 之前完成，`observeSession` 带回合信号与 15s 超时。
- **回合判据**：`agents.turnBoundaryOf` 的 `lastTurn` 与发起批次不一致时丢弃结果，不再把上一回合的失败注入下一回合。
- **首个事件窗**：首次见到的会话从 `openTurnStartSeq`（回合起点）开始，不再重放整份历史；fork 边界仍优先。编辑台账投影也使用同一回合下限，插件刚装载时不会把起点以前的历史编辑重放成本回合门禁。
- **台账路径**：相对路径按条目自己的 `cwd` 解析，换目录后的历史条目不会指错项目根。
- **子代理展示名**：`path ?? label ?? id`。

### Fixed

- **手动跑门禁与自动路径一致**：`QualityGateRemoteService.run` 在 `grantGateRoots` 之后重新解析一次策略，并把有效策略交给批次——此前临时登记的可写根没有进入策略快照，手动入口会静默地跑一条注定被拒的门禁。
- **`pnpmScripts` 的透传**：`rootForFile` / `projectRootsOf` / `hasPnpmCheckGate` 不再丢掉自定义脚本名。此前它在 workspace 根判定里也被忽略。
- **`securityAudit` 不参与根选择**：它只在选定根之后追加供应链扫描。此前它被算进 pnpm 门禁命中：只有 lockfile 的子包会截停向上探测，只有 lockfile 的外层 workspace 会吞掉子包真正的 `tsc` / `check`，扫描命令退出 0 就成了假通过。
- **编辑台账首回合游标**：台账路径与事件窗共用 `openTurnStartSeq`；首次加载（`lastSeq` 为空）不再从 0 重放历史编辑。`lastSeq` 存在时仍保留增量语义，读失败留下的未处理编辑不会被跳过。
- **tsconfig 的 JSONC 解析**：`references` 判定不再扫原始文本，而是剥掉字符串外的行/块注释与尾逗号后 `JSON.parse`；注释里出现 `"references"` 不再误判成引用，注释/尾逗号里的真实引用也不再误判成未引用。
- **手动批次进入 `inFlightGates`**：dispose 的 `Promise.allSettled` 现在会等到手动批次结束，卸载不会再让门禁子进程活过插件生命周期。
- **卸载清空 `recentResults`**：同一 `sessionId` 可能被复用，旧的"最近结果"会跨装载周期出现在侧栏。
- **`isTurnAgent` 校验 `status` 与 `inbox`**：这两个字段就是手动入口与注入前判据要读的，单校验 session + followup 会让形状不全的替身读到 `undefined`。
- **`eslint` 用解析器认得的输出格式**：命令改为 `eslint --format unix .`，`lib/gate-diagnostics.ts` 的 ts 解析器只认 `path:line:col:` 形状，stylish 树此前解析不出任何一条诊断。
- **pytest 只认显式入口**：`tests/` / `test/` 目录不再触发 `pytest -q`——目录存在而没有用例时 pytest 退 5，那是配置错误不是代码失败。
- **ruff format 需要显式配置**：只有 `[tool.ruff.format]` / `[format]` 段存在时才追加 `ruff format --check`；声明了 black 时不再叠加。此前"有 ruff 段"就发，会把只启用 lint 的工程整片判红。
- **clang-format 门禁可达**：`.clang-format` 进入探测清单，Makefile 目标不再只收 `check`/`test`，收全部目标名并排除 `:=` / `::=` 变量赋值。
- **setup.cfg 的 pylint 段与 composer 的数组脚本**：setup.cfg 按 `[pylint]` 段头判定（此前误用 pyproject 的正则）；`declaredScriptsOf` 接受非空字符串数组，composer 的 `"test": ["phpunit"]` 不再被丢掉。
- **诊断解析补齐**：Go 的列号可省；PHP 认 `Fatal error: … in <file>:<line>`（与此前的 `on line` 两种形状）；Rust 的 `aborting due to` / `could not compile` 汇总行不再挂上一条错误的 `-->` 文件。
- **绝对路径诊断不再跑出仓库**：`repoRelativeDiagnostics` 对已经是绝对路径的诊断（Maven）保留原值，不再产出 `../..` 形状。
- **改动记录器认工具配置**：`GATED_NAME` / `GATED_EXT` 补 `makefile`、`GNUmakefile` 与 `.conf`（`staticcheck.conf` 此前不算改动）。
- **根标记与探测表分开**：`MANIFESTS` 仍是探测文件名表（新增 `.clang-format`），向上找根改走 `ROOT_MARKERS`，`.prettierrc` / `.editorconfig` / 各类工具配置不再把一个目录升成项目根。
- **`maxDepth<=0` 与脚本名首字符**：层数上限为 0 时 `hitDepthLimit` 为真（不再静默跳过）；`SCRIPT_NAME_PATTERN` 禁止首字符 `-` / `.`，避免把选项形状的名字当脚本。
- **侧栏与注解的刷新**：注解 observable 在内容未变时保持原引用、不再通知订阅者；会话侧栏每 5 秒重读一次（门禁结果在回合结束时才落盘，只读一次会永远停在打开面板那一刻）。
- **`make test` 不再压掉内置探测**：只有 `check` 目标算项目声明并覆盖内置门禁；`test` 目标改为追加一个测试入口（与 `rake test` 同分工），只把 `test` 写进 Makefile 的工程不再因此失去 lint/format。
- **错误摘要不再丢成因**：`messageOf` 对 `Error` 的空 `message` 退回 `String(error)`（至少留下 `Error`），非 `Error` 对象读字符串型 `message`，都读不到才是 `unknown error`。
- **`pnpm audit` 不被依赖预检误伤**：预检只在 `pnpm <script>` / `pnpm run` 形态下要求 `node_modules`；`pnpm audit` 只读 lockfile，没有安装依赖也照跑。
- **Remote 返回面收敛**：`latest` 直接复用 `parseRow` 的行解析（不再另起一套状态分支），运行请求与状态各用独立的 `typeSymbol`，`parseRow` 只在 `known` 时解析诊断。
- **重复实现与注释归位**：Python 的 `[tool.black]` / `[tool.pyright]` 探测抽成 `pyprojectConfiguredOf`，诊断收集器由 `gate-detect.ts` 的 `collectDiagnostics` 单点提供（`parseTsDiagnostics` 委托它），`ROOT_MARKERS` 删掉没有消费方的 `meson.build` / `settings.gradle(.kts)`，`setGateReader`（全仓无调用）与 `TeamEdits.deferred`（恒无读取点）删除，几处挂错位置的 JSDoc 移回其函数上方。

### Tests

- 新增 `test/gate-multilang.test.ts`（九种语言矩阵、主流工具链、项目声明优先、同根去重、Maven verify、Kotlin detekt/ktlint、供应链扫描默认关闭/打开）、`test/gate-diagnostics.test.ts`（各命令诊断与仓库根换算）与 `test/host.test.ts` 的多语言根探测执行、POM 读不出时退回 `test`、行级 `securityAudit`、`cargo audit` / `composer audit` 子命令缺失按工具缺失的用例。
- 覆盖率为 `host.ts`、`lib/**`、`src/ui-messages.ts`、`src/remote.ts` 四项 100%；新增分支都由正例与负例各钉一条。
- `test/gate.test.ts` 新增 references 与 `pnpmScripts` 的判定用例；`test/host.test.ts` 覆盖 tsc 环境错误、pnpm 预检、跨回合丢弃、首窗起点、条目 cwd 与边界缺省形态；`test/host-integrity.test.ts` 覆盖"列出队友之后/冷读期间"两个卸载点。
- 新增 `test/project-probe.test.ts`（脚本形状、Python 配置段、Makefile 目标、根标记、`maxDepth<=0` 与读不动的清单）与 `test/errors.test.ts`（`messageOf` 的四类分支）；`test/gate-diagnostics.test.ts` 补 Go 可选列号、PHP 的 `in <file>:<line>`、Rust 汇总行、Maven 绝对路径；`test/gate-multilang.test.ts` 的 eslint / ruff format / pytest / Makefile 判据随实现收缩；`test/host.test.ts` 与 `test/host-integrity.test.ts` 补手动路径策略重解析、`securityAudit` / `pnpmScripts` 透传、`pnpm audit` 无 `node_modules` 照跑、`isTurnAgent` 形状与 dispose 清 `recentResults`。

## 0.1.13

宿主基线切到 `dsh 0.2.3-alpha.2`（Node `^24.22.3 || >=26.13.1`），shared 经 catalog 抬到 `^0.2.13`。编辑台账升到 `stateVersion: 3`：每条记录必填 `cwd`，按条目解析；`ChildLedgerSnapshot.entries` 改为必填，新增活目录 `WorkingDirectoryFace` 与子代理 cwd 用例。设置卡随 shared v3 视觉层更新，并新增 `QgPanelSection` 会话面板段（id `quality-gate-status`，order 120）；客户端槽位与产物预算测试同步。

## 0.1.12

宿主基线抬到 `0.2.2-rc.5`：devDependencies 全族精确钉 rc.5，`engines.dsh` 与 dsh 家族 peer 同一条窗口，两份 README 的支持窗口徽章同步。devDependencies 补 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-tool-executor-ptc`——shared `./lib/tool-events` 的声明（PTC 两个载荷的官方增补与失败身份的官方真源）在本包的类型检查里解析到它们。shared 经 catalog 抬到 `^0.2.12`，`pnpm-lock.yaml` 经 `pnpm install --lockfile-only` 重解到 registry 现量；devDependencies 另补 `react-dom`（`^19.3.0`，与 react 相邻）——shared 0.2.12 的 card-ui 经 `createPortal` 引 `react-dom`，本包客户端测试经 ESM 链解析到它（与 danger-guard / dir-prep / session-rescue 的既有供应同形）。规则、门禁与默认配置不变。

## 0.1.11

设置卡组件不再打进 `client.js`，改回外置 shared 客户端行，由 `cordis.patch.yml` 新增的固定 id 供应行装载；`@jayyuen66/dsh-plugin-shared` 抬到 `^0.2.10`，吸底保存条的旧固定 id 样式冲突与底色随 shared 修复。client 产物随外置与压缩降到实测 11,921 B，预算收紧到 12,500 B。门禁判据与默认配置不变。

### Changed

- **client 产物外置 `@jayyuen66/dsh-plugin-shared/client`，供应行回到补丁里**：`package.json` 的 `dsh.client.external` 声明该说明符，`cordis.patch.yml` 插入 `- id: dsh-plugin-shared` 固定 id 供应行（必须保持开启；停用后设置卡失去 shared 组件供应，多个插件共用同一 id 时宿主把开关标成「无法唯一定位」并禁用）。0.1.7 的「内联自足」取舍就此反转：内联本是 shared 未随 profile 物化时对 issue #2（`missed the module table`）的绕路，本版随 shared 0.2.10 的固定 id 契约重新外置，显式接受「shared 必须作为 client row 被宿主装载」这一前提，`build-client.mjs` 的 `CLIENT_EXTERNALS` 与两份 README 的组合包说明同步改口径；client 构建同时开启 minify。
- **shared 运行时依赖抬到 `^0.2.10`**（catalog 由根 `sync` 投影，两份 README 的版本下限同步改 0.2.10）：保存条在宿主「设置」对话框里不再凹出一条比四周更暗的横带；上一代插件占住固定 id `dsh-card-ui-css` 时新样式改注入覆盖样式，不再被旧 bundle 压回去。
- **client 产物预算收紧**：shared card-ui 的字节不再计入本产物，`test/dist-size.test.ts` 的 client 预算由 47,500 B 收紧到 12,500 B。
- **README 与 DETAIL 增加反馈入口**：随 shared 0.2.10 的口径——启动失败时请附宿主版本、profile 安装形态与浏览器控制台原文，`missed the module table` 一行能直接说明 shared 客户端供应行有没有被物化。

### Tests

- `test/profile-bundle.ts` 改从 `src/client-entry.ts` 取槽位 key 与 `configForms.get()` 的条目 id：minify 会 mangle 局部标识符，产物里已无稳定的常量名；产物只负责证明注册存在，声明值从源码取。
- `test/build-client.test.ts` 的产物断言反转：`client.js` 里保留 `require("@jayyuen66/dsh-plugin-shared/client")` 即外置成立，内联回流才判红。

## 0.1.10

market 热挂与 bundle 层双路径装载时第二份 `apply` 整份让路（本包的注册面不去重也不抛错，第二遍会静默各挂一份，同一个回合的门禁判定与台账写入都会跑两遍）；设置卡接「有字段越界就不许保存」那道门禁；卡片样式改用 shared 的共享 `<style>`；shared 抬到 `^0.2.9`，输入框不再撑出容器、小节内补上纵向间距。门禁判据与默认配置不变。

### Added

- **单实例锁**：`apply` 最前面用 shared 的 `claimInstance` 抢 `"@jayyuen66/dsh-quality-gate/instance"`，抢不到就 `log.warn` 一行「本次装配让路，门禁与台账由在册的那一份提供」并直接返回。本包的事件监听与两处 `svc.inject` 挂的投影/设置页策略**都不去重、也不抛错**，所以重复是静默的；锁随在册那一份的 fiber 卸载自动释放。
- **回归测试**：`test/host-integrity.test.ts` 新增「同一作用域第二次装配让路：不重复注册、不抛错」，判据含 `warn` 恰好一次。

### Changed

- **`lib/messages.ts` 的 `renderTemplate()` 换成 shared 的 `fillPlaceholders`**：宽匹配（`{gate.command}` 这类带点的名字照样查表）与「只取自有属性」两条契约不变；**缺值语义从「替空串」改成「保留原文」**——漏传参数时花括号留在正文里一眼可见，不再悄悄少一段说明。多条既有断言随之改判。
- **卡片样式改用 shared 的 `ensureCardUiCss()`**：不再把 `CARD_UI_CSS` 整段拼进本仓的 `<style>`，改为固定 id `dsh-card-ui-css` 的幂等注入 + 引用计数。
- **运行时依赖 shared 抬到 `^0.2.9`**；两份 README 里的 shared 版本下限同步从 0.2.6 改成 0.2.9（单实例锁、占位符插值、样式注入与越界保存门禁都从那一版导入）。
- **文档跟到当前行为**：「已知边界」补上单实例让路；常见问题里「子代理的编辑不进入父会话、可能漏检」与 `isRootSession` 注释里「本插件不做聚合」都跟到具名子代理台账聚合的实际行为（空闲/冷子代理的台账按游标并入父会话本轮，队友仍在执行则推迟）。

### Fixed

- **越界数字草稿会被静默丢掉**：`NumberField` 对越界草稿**不调 `onChange`**，于是它根本不进 `touched`。两个数字字段（`maxInjectsPerTurn` / `gateBudgetMs`）现在都接 `onInvalidChange` 上报，卡片据此灰掉保存并在保存条上点名「有字段超出范围，先修正或撤销后再保存。」（`src/ui-messages.ts` 的 `invalidFields`）；`resetToken` 在保存/撤销后把框里的非法草稿清回已提交值。
- **越界时连撤销都点不动**：上一版把「有未保存改动」与「有越界字段」混成保存条的一个 `disabled`。现在 `SaveBar` 分开算：保存被 `blocked` 拦下，撤销保持可点——撤销正是越界状态的出路。
- **输入控件撑出容器**（shared 侧）：`.dsu-form` 整棵子树统一 `border-box`，否则 `.dsu-input` 的 `width:100%` 会连同左右 padding 一起撑出容器 26px。
- **总预算被按门禁条数均分，导致长门禁必然超时且报错读起来像配置没生效**：`runGateBatch` 原来算 `perGate = max(10s, budget / gates.length)`，每一条都只能用这个均分值。改到伞工作区根的文件时门禁根会升到根上，那一条 `pnpm check` 实跑 `node scripts/check-all.mjs`（十个仓串行，实测 `real 240.68s`），而 600s / 10 条 = 60s——每一条的窗口都短于一次门禁的固有耗时，于是必然全部超时，注入的却是「60s 预算内未完成」，看起来像 `gateBudgetMs` 没生效。现在改成共享池：`windowFor(remaining, laterGates)` 先从剩余里扣掉后面每条 5s 的保底，剩下的全给当前这条；后面没有门禁时它可以用掉整个剩余预算。**判据**：`test/host.test.ts` 那条回归用例断言 100s 预算下第一条拿到 95s（均分实现是 50s）、最后一条拿回 90s 以上，变异（改回均分）即红；另用官方 `LocalBashExecutor` 起两个真 pnpm 根（一条 20s、一条 5s，总预算 30s）跑了一遍对照——均分给 `[15000,15000]`、那条 20s 的门禁 `timedOut`，共享池给 `[25000,9860]`、两条都 `exit=0`。
- **「未执行」清单里的毫秒数与事实无关**：`skippedText` 把 `MIN_USEFUL_GATE_MS`（5000）当成 `{budgetMs}` 填进「剩余预算不足 {budgetMs}ms」——那句话读的是一个固定阈值，模板要的却是当时真正还剩多少，用户无法据此判断该调多少预算。模板改成「本轮剩余预算 {budgetMs}ms」，并传入真实的剩余值（`Math.max(0, remaining)`）。

## 0.1.9

设置卡的下拉候选与说明浮层不再漂到浏览器最左边；shared 抬到 `^0.2.8`（含运行时几何自检），CI 的 action 钉版升到最新。门禁判据与默认配置不变。

### Fixed

- **下拉候选与说明浮层被钉在视口左边缘**：`.dsu-menu` 与 `.dsu-tip` 的 `position-area: block-end span-inline-start` 选中的是「行内起始列 + 中间列」，而 `position: fixed` 下该区域的起始边是**视口左边缘**、不是触发器左边缘，再叠一条 `justify-self: start`，浮层就落在 `x=0`。改为 `block-end span-inline-end`——真实 Chromium（patchright headless，156.0.8078.4）实测：1440px 视口、触发器左边缘 860px，改前浮层左边缘 0，改后 860；触发器贴到右侧时 `flip-inline` 会改成右边缘对齐，贴到视口底部时 `flip-block` 翻到上方。
- **锚定没兑现时改回 JS 矩形定位**：`select.ts` 与 `field.ts` 的 `place()` 此前只要 `CSS.supports("position-area: block-end")` 为真就直接 `return`，方向性错误没有任何兜底。现在锚定后先量一次浮层矩形，用 shared 0.2.8 的 `anchorPlacementOff` 判它是否真贴在触发器上（行内起始边或结束边任一在 2px 容差内贴住，且块向落在触发器下方或上方），不通过才把 `position-area` 显式置 `none` 再写 `left` / `top`。顺序是承重的：实测同时留着 `position-area` 只写坐标时块向仍由锚定决定（浮层 `y` 落在 314 而不是 160），必须先关。回退是单向的——同一个浮层一旦走过 JS 路径，后续 `resize` 不再尝试锚定，避免两个定位源来回抢。
- **回归测试**：`test/card-ui.test.ts` 新增 `anchorPlacementOff` 的四种对齐形态（左边缘对齐、`flip-inline` 右对齐、`flip-block` 翻上方、两轴都不沾）与容差边界，以及三条锚定用例（浮层真贴住时不写 JS 坐标、被钉到视口左侧时改写坐标并关掉 `position-area`、回退过的浮层不再重试锚定）。

### Changed

- **运行时依赖 shared 抬到 `^0.2.8`**：`pnpm-workspace.yaml` 的 catalog 由根 `sync` 投影，`pnpm-lock.yaml` 随 `sync:lock` 重解；`client.js` 按新 shared 重建，内联的 `CARD_UI_CSS` 逐字节等于已装 shared 导出的那一份。0.2.8 新增的 `anchorPlacementOff` / `ANCHOR_PLACEMENT_TOLERANCE` 只被卡片内部使用，本包对外工具与 Remote 方法名单不变。
- **CI 的 action 钉版升到最新**：`github/codeql-action` 的 `init` / `analyze` / `upload-sarif` 由 `v4.39.1` 升到 `v4.39.3`（`33d7b85da1a04171e211befe2c739303b9a4c066`），`pnpm/action-setup` 由 `v6.1.0`（`ea17c68d…`）升到 `v6.1.1`（`73e46992…`）。钉版仍是 40 位 commit SHA + 版本注释，由根 `scripts/upgrade-actions.mjs` 现量比对上游 tag 后改写，`--check` 可复跑。

## 0.1.8

接入宿主 rc.2 的四项新能力：门禁根的临时写权限、具名子代理的编辑聚合与推迟、`inspectSession` 台账读取、工具失败身份。宿主开发基线抬到 `0.2.2-rc.2`，支持窗口随之收到 `^0.2.2-rc.2`。

### Added

- **门禁根的临时写权限（`sandboxPolicy.registerWritableRoot`）**：会话开在 monorepo 子包、而 `pnpm check` / `cargo check` / `tsc` 必须回到仓库根执行时，根目录不在本会话的可写边界内——产物写不出去会让命令非零退出，变成假失败。现在只在 `workspace-write` 且门禁根未被工作区/额外可写根覆盖时为**这一批门禁**登记该根，批次结束（通过、失败、跳过或抛错）在 `finally` 里释放；`read-only` 不登记（不替用户提权），`danger-full-access` 无需登记。
- **具名子代理的编辑聚合（AgentTeam）**：根会话回合结束时经 `subagents.listDescendants` 递归列出本树子代理。有队友仍在执行（`agents` 里 `status === running`）→ **推迟**本轮门禁并保留已收集的文件（队友完成后会开启新的根回合再检查）；其余子代理的编辑台账按各自游标增量并入本回合的文件集，门禁失败时在注入文案里点名改过该根的子代理。
- **`sessionQuery.inspectSession` 读取子代理台账**：只读本包自己的编辑台账投影与 header，准备冷会话后在当次截面同步取值并立即释放，不 attach、不恢复 Agent；事件窗仍走 `observeSession`（官方禁止新增同步历史读取）。
- **工具失败身份（`tool/result.error.info`）**：编辑台账按结算身份分档——审批被拒与派发前取消（`APPROVAL_*` / `ABORTED_BEFORE_DISPATCH`）不核验，已派发后中止（`ABORTED` / `AbortError`）保守核验（写可能已落盘），其余失败与无身份沿用旧的"不核验"。投影状态版本升到 2。

### Changed

- **宿主开发基线抬到 `0.2.2-rc.2`**：`devDependencies` 整组 `@deepseek-ai/dsh-*` 抬到 `0.2.2-rc.2`，并补上 rc.2 新增的 `@deepseek-ai/dsh-error`（`dsh-llm` 的精确 peer，`autoInstallPeers: false` 下须显式声明）。
- **支持窗口收到 `^0.2.2-rc.2`**：`engines.dsh` 与 `@deepseek-ai/dsh*` peer 由 `^0.2.1-rc.5 || ^0.2.2-alpha.3` 改为 `^0.2.2-rc.2`（单条 0.2.2 线，rc.1 宿主不再声明支持）；`@deepseek-ai/schemastery` peer 由 `^3.18.5 || ^3.18.6-alpha.1` 收到 `^3.19.0`。devDependencies 仍精确钉版。
- **运行时依赖 shared 抬到 `^0.2.6`**：工具失败身份读的是该版本 `ToolResultRecord.error`；catalog 与 `pnpm-lock.yaml` 随根 `sync` / `sync:lock` 重解，装到 0.2.5 时该字段恒为 `undefined`，失败身份集成会退回旧的"只核验成功编辑"语义。

## 0.1.7

修复 0.1.6 引入的 web 启动隐患：卡片组件收回 `client.js` 内联，移除对 `@jayyuen66/dsh-plugin-shared/client` 的模块表外置与 `cordis.patch.yml` 里的 shared 供应行。默认配置与检查命令白名单不变。

### Fixed

- **卡片组件内联进 `client.js`，产物自足**：0.1.6 把 `@jayyuen66/dsh-plugin-shared/client` 外置给宿主模块表，靠 `cordis.patch.yml` 插入的一条**不写 id** 的 shared 组件行把 shared 装载成供应方。这份供应链在 shared 只作为传递依赖装进 profile 时（`dsh plugin add` 的正常结果）没有保证——宿主侧可以既不报错也不把 shared 的 client 产物排进启动图，页面启动时 `require("@jayyuen66/dsh-plugin-shared/client")` 落进 `missed the module table`，整窗「应用无法启动或已意外停止」（dsh-ocr-review 仓 issue #2，宿主 0.2.2-rc.1 dsh desktop 实报）。`build-client.mjs` 的外置清单收回 react / zod 两族（宿主 `PLATFORM_MODULES` 供给，内联反而会产生第二份身份），卡片组件全部内联；`package.json` 的 `dsh.bundle.client.external` 与 patch 里的 shared 供应行随之移除，`cordis.patch.yml` 回到只声明本包一行。`test/build-client.test.ts` 的产物断言反转：`client.js` 里出现 `dsh-plugin-shared/client` 说明符即外置回流，当场判红。

## 0.1.6

`apply_patch` 进入编辑台账与回合累加器的收集范围；宿主开发基线抬到 `0.2.2-rc.1`，支持窗口从单条 `^0.2.1-rc.3` 改成两条宿主线的并集，`engines.node` 下限抬到 `>=24.9.0`；卡片组件改由 shared 的 `./client` 提供。默认配置与检查命令白名单不变，需要留意的是 `engines.node` 抬高后 node 22 装不上本包。

### Added

- **`apply_patch` 记录**：编辑台账与回合累加器按补丁的每个操作目标记录（含 move 的源与目的）；失败结果否定同 callId 的全部行。补丁解析复用 shared 的官方 `dsh-fs-patch` 封装。

### Changed

- **shared 抬到 0.2.4**：catalog、生成物与 lockfile 随之同步；shared 新增的普通依赖 `@deepseek-ai/dsh-fs-patch` 由 shared 自己安装，本包不重复声明。
- **宿主开发基线**：`devDependencies` 的 dsh 家族抬到 `0.2.2-rc.1`，`@deepseek-ai/cordis` 抬到 `4.1.0`、cordis 插件组的两个抬到 `1.1.0`、`@deepseek-ai/schemastery` 抬到 `3.19.0`；根 catalog 与 overrides 的投影同步，`pnpm-lock.yaml` 随之重新解析。
- **支持窗口写成并集**：`engines.dsh` 与 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-credentials` 两个 peer 由 `^0.2.1-rc.3` 改为 `^0.2.1-rc.5 || ^0.2.2-alpha.3`；`@deepseek-ai/schemastery` 的 peer 由 `^3.18.6-alpha.1` 放宽为 `^3.18.5 || ^3.18.6-alpha.1`，与两条宿主线各自实际安装的版本对齐。caret 的预发布比较只看自己那一组版本号，只写一条线会把另一条线上的预发布判成不满足，而装载的判断（`app-boot` 带 `includePrerelease` 读 `engines.dsh`）没有这个区别——把窗口写窄只会让发布声明和安装器的判断各说一套。`engines.node` 由 `>=22.12.0` 抬到 `>=24.9.0`，取值来自宿主自己声明的下限。
- **卡片组件改由 shared 的 `./client` 提供**：`src/client-entry.ts` 的运行期值导入（`diffTouched` 和卡片组件）合并进 `./client`，`package.json` 新增 `dsh.bundle.client.external`，`build-client.mjs` 的外置清单同步——组件由模块图提供，不再在每张卡片的产物里内联一份；`cordis.patch.yml` 因此插入一条**不写 id** 的 `@jayyuen66/dsh-plugin-shared` 组件行（写 id 会在插件页多出一个可关闭的组件，关掉之后设置卡整块不启用）。
- **CI 的 pnpm 与 node 取值**：`ci.yml` 与 `publish.yml` 的 workflow 级 `env.PNPM_VERSION` 固定为 `12.11.2`（与伞根 `packageManager` 同一个值，浮动主版本 `12` 会让门禁和发布在补丁版之间变化）；`node: [22, 24]` 加 macOS 排除改为单独一格 `node: [24.9]`，`node-version` 由 `24` 改为 `24.9`。

### Fixed

- **注入回调不再丢掉 setup 屏障**（`host.ts`）：`inject` 的回调返回类型由 `void` 放宽为 `void | Promise<void>`，把注册那一条 promise 交回 cordis——它把回调返回值当作子 fiber 的 setup 屏障，返回 `void` 时页面策略那一条还没挂上就被判为装配完成。`test/host.test.ts` 补两条用例固定这个时序。
- **发布产物核对在 Windows 上打不出包**（`pack-check.mjs`）：`check:pack` 原先把系统临时目录的绝对路径带引号交给 ComSpec 的 `/c`，cmd 会把那对双引号连同参数一起交给 pnpm，pnpm 于是把 `"C:\Users\…\Temp\…"` 当相对路径拼到 cwd 上，报 `Failed to create directory D:\a\…\"C:\Users\…"`（os error 123）。输出目录改为本包目录下一个自建的相对名（`.pack-tmp-<pid>-<rand>`）：这一段名字既没有空格也没有引号，参数里没有需要保护的字符，两个平台可以用同一种写法；`.gitignore` 补 `/.pack-tmp*/` 兜住进程被强制终止时留下的残骸。同一条路径此前只在 Windows 那一格暴露——那一格上一版是 1.1 秒零输出的假通过。
- **Windows 格第一次真跑出来的八条失败**（`test/gate.test.ts`、`test/platform/guards.platform.test.ts`、`test/property/gate-invariants.property.test.ts`）：`EditAccumulator.note()` 会对入参做 `path.normalize`，Windows 上写死的 `/w/a.ts`、`src/a.ts` 被归一成 `\` 形式，而期望值是 POSIX 的写法——断言因此只在半个平台上成立。测试数据改由 `path.join` 按当前平台构造，两边来源一致后 normalize 成为恒等变换，被判断的三件事（去重、淘汰顺序、扩展名过滤）没有变弱。`detectGate` 的 `root` 字面量不经过归一，未动。
- **台账的同 callId 回填不再只否定最后一行**（`lib/edit-ledger.ts`）：原先按 callId 找最近一条标记失败，普通编辑器一次调用只产一行、语义不变；`apply_patch` 一次调用可产多行，只否定最后一行会让其余路径在失败后仍被当成成功编辑，改为否定同 callId 的全部行。分流的 `pending` / `noCallId` 两张表合成一张 `records`，无 callId 的异常形状仍保守直记防漏。
- **回合累加器要收集的编辑类型补齐**（`lib/accumulator.ts`）：`EDIT_TOOLS` 加入 `apply_patch`，多文件补丁的路径由 `editPathsOf` 逐个展开，`note` 仍按单个路径去重。

### Docs

- dsh 徽章由 `^0.2.1-rc.3` 抬到 `^0.2.1-rc.5`，与 `engines.dsh` 的第一条同值；`cordis.patch.yml` 的注册行说明由"只有一行"改写为"两个条目"，并解释 shared 那行为何不写 id（`test/profile-bundle.ts` 里同类说法同步）；开发命令注释里的 typecheck 由"三个 tsconfig"改为四个，与 `package.json` 的 `typecheck` 实际跑的数量一致。

## 0.1.5

一轮跨方面的审查修复：凭据 URL 的判据重建、设置卡改成逐字段校验、检查命令的探测与反馈发送的收尾处理改正；注入次数的语义改为按会话跨回合累计。

### Fixed

- **凭据 URL 的判据重建**（新增 `lib/credential-url.ts`，`lib/gateway-target.ts` 改为转导出）：IPv4-mapped 回环地址按末 32 位的数值判断（`::ffff:7fa:0` 不再被误判为回环）；`resolveGatewayUrl` 对带 userinfo、query 或 hash 的基址返回空串（宁可当作未配置，不做放宽）。
- **设置卡逐字段校验**（`src/client-entry.ts`）：`projectCardValues` 改成逐字段解析，一个不合法的 URL 不再清空整张卡；网关地址经 `isCredentialSafeUrl` refine，保存前拦下 `invalidGatewayUrl`；凭据引用名按 REF_PATTERN 再判一次 `invalidKeyRef`；数字字段弃用宿主 zod 里缺失的 `.validate`，改用 `inBounds` 自己比较边界（在宿主冻结的 zod 4.4.3 下不再崩溃）。
- **编辑台账的读取**（`lib/edit-ledger-reader.ts`）：publish 和 effect 收进 try，失败时先收回读取函数、再释放投影、最后报原始错误；重复 dispose 不再抛错。
- **台账游标与卸载**（`host.ts`）：游标只推进到台账实际覆盖到的末尾（被 `EDIT_LEDGER_MAX` 截断不再让中间那段 seq 永远读不到）；异步读窗之后再次检查卸载标记，dispose 之后不再新建后台任务。
- **门禁命令的探测**（`lib/gate-detect.ts`）：workspace 根缺少 check 脚本时不再退一步去跑 tsc（solution-style 会永远报通过）；同一个 root 去重；清单文件加上 `.ruff.toml`。
- **网关反馈**（`lib/gateway-feedback.ts`）：基址校验 http(s)、query 与 userinfo，并复用凭据的那份判据；不合法的 serviceId 改用 default；正文为空时不发送；错误正文只在 content-type 是文本或 JSON 时才写进日志。
- **反馈内容**（`lib/feedback-content.ts`）：command 不是数组时容错处理、failure 为空时不入库、正文末尾追加防止把仓库内容当指令执行的隔离说明；`renderTemplate` 的占位符放宽到 `{[^{}]+}`。
- **零散修复**：`lib/accumulator.ts` 的路径先 trim 再 normalize 统一；`lib/edit-ledger.ts` 的 `strictObject` 改为 `object`、failEntry 可重复调用、空 callId 不标失败；`pack-check.mjs` 改用官方的 `builtinModules`、排除模板插值、产物缺席或没有入口时明确报错、win32 走 ComSpec；`build-host.mjs` 增加空产物的检查。

### Changed

- **注入次数的语义**：由"每个回合每个根各一次"改为"每个会话跨回合累计、干净通过后重置"（`host.ts`、`cordis.patch.yml` 和卡片的中英文案同步）。
- **发布链加固**（`.github/workflows/publish.yml`）：分支守卫比较完整的 ref、校验 token 的形式、把 tarball 里的 name/version 与预检结果逐字比对、查询 registry 上是否已有同一版本、直接发布那一个 tarball、发布后轮询可见性；CI 侧 actionlint 按 glob 逐文件豁免、codeql 对 fork 的 PR 只在 analyze 这一步容错。
- **构建与元数据**：package.json 删掉 `prepack`、typecheck 串起四个 program；覆盖率的统计范围加上 `src/ui-messages.ts`；oxlint 的 `syncWrites` 改成按文件声明的 `syncIoScopes`；author 改成对象形式；`@deepseek-ai/schemastery` 的 peer 放宽为 `^3.18.6-alpha.1`；catalog 里的 shared 抬到 0.2.2；devDependencies 新增 `@deepseek-ai/dsh-bash-local` 和 `@deepseek-ai/dsh-subprocess-local`，以及 fast-check 4.10.2。

### Added

- **三层测试**：`test/e2e/real-tsc.e2e.test.ts`（真跑 tsc 进程）、`test/platform/guards.platform.test.ts`、`test/property/gate-invariants.property.test.ts`（fast-check）、`test/client-zod-surface.test.ts`（禁止使用 `.validate` 的那条门禁）。

## 0.1.4

这一版收窄回合结束检查的范围：子包自己的 workspace 检查不再被外层的伞工作区挤掉，改单个仓库的回合不再跑整棵树。

### Fixed

- **单仓安装状态下两份 zod 的 `ZodType` 不兼容**：宿主的投影包自带 zod 4.4.3，本包 catalog 用的是
  4.6.7；`editLedgerProjection.stateSchema` 按宿主声明的类型做一次范围受限的类型转换，运行时仍然交给
  宿主的 `safeParse`，不改依赖版本。
- **子包自己的 workspace门禁被外层伞工作区挤掉。** 编辑一个自带 `pnpm-workspace.yaml` 且声明了 `check` 的子包时，项目根探测会继续往上走到外层的伞工作区，把"改一个仓"放大成"整棵树跑一遍 `pnpm check`"：回合结束时的时间预算被这一条命令用完，改本仓的回合反而反复超时。现在子包自己能给出一条像样的 `pnpm check` 时就在原地执行、不再往上找；升到外层只发生在子包自己给不出门禁的时候。`test/host-integrity.test.ts` 新增一条伞工作区的用例把这个行为钉住下来。
- **脚本内部的 exit 126/127 被误报成"检查用的工具没装"。** 126/127 是整条命令的退出码，不是"工具没装"的充分证据：`pnpm check` 的 check 脚本里缺命令时 pnpm 同样以 127 退出（实测 `pnpm run check` 对不存在的脚本命令返回 `[ELIFECYCLE] Command failed with exit code 127`），tsc 的脚本也可能因为缺 devDependency 返回 127。原先这两种都按 not-run 注入"command not found (tool not installed) — the gate did not run"，项目自己写坏的脚本被当成环境问题放掉。现在只有 stderr **点到检查命令自己的第一个 token**（`sh: pnpm: command not found`、`command not found: tsc`、Windows 上的 `'pnpm' is not recognized`）才判工具不可用，其余的 126/127 按代码失败上报并附上证据；126 同样只在点到"不可执行"时才判 not-run。`test/host.test.ts` 与 `test/host-integrity.test.ts` 的 126/127 用例补上了点名的证据，并新增一条"脚本内部返回 127 仍然报代码失败"的用例。

## 0.1.3

这一版把判定面与构建/CI 面一起统一处理：ruff 不再对只写了 `pyproject.toml` 的工程发门禁，卡片保存期间的编辑不再被静默丢弃，记忆反馈的文案与来源一致，Windows 与发布链的静默降级补上判据。构建/CI 那一批清掉的是只在 Windows 上才会红的判据、两个构建脚本里没有任何门看得见的静默降级，以及发布链路缺的一道检查。宿主线抬到 `0.2.1-rc.3`。

### Fixed

- **只写了 `pyproject.toml` 的 Python 工程会被发一条 `ruff check .`。** `pyproject.toml` 是 Python 的元数据文件，不是"本项目使用 ruff"的声明；原先只要它在场就给出门禁命令，于是把 lint 交给别的工具的工程会被宿主 PATH 上的 ruff 按默认规则判一遍，再经同一条注入通道被当成真实缺陷。现在 ruff 的门禁命令要求根上有 `ruff.toml`，或者 `pyproject.toml` 里确实有 `[tool.ruff]` 开头的那些段（段头按行首做字面匹配，带引号的键和数组表也认）；两者都没有就不发。读不到 `pyproject.toml` 内容时按"没有信息"处理，和读不到文件取同一个方向。
- **卡片保存期间产生的编辑会被静默丢掉。** 保存请求还在路上时输入框只按 `writable` 禁用，用户仍然可以继续改；而写入成功之后无条件清空待保存集合，把点了保存之后才产生的新改动一起抹掉。现在只去掉本次真正写下的键，这期间产生的新改动留在待保存内容里。
- **记忆反馈的文案说了实现里没有的行为。** 文案写"清空 key 就不再启用记忆反馈"，实际还有环境变量里的网关地址作为另一个来源、引用名也会改用默认值；照着那句话做，代码类检查失败的证据仍然会发出去。文案改成如实说明这两个来源。
- **`test/` 下三处机器侧门禁的静默放行**：动态 `import()` 吃裸文件路径（Windows 上抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）改走 `pathToFileURL().href`；产物清单为空时两侧都折成同一个空串、被判「新鲜」，改为当场抛错；显式设了 `DSH_PROFILE_PACKAGE_JSON` 却指向不存在的文件时静默跳过，改为判红。
- **四个工作流里的判断缺陷**：`ci.yml` 的 `find … -print -quit` 在零匹配时得到空串、多个匹配时静默取任意一个，改为要求"恰好一个 tarball"并打印实际个数；`publish.yml` 的重复发布检查把包名和依赖名写死在 URL 里（改名之后会查到 404、于是当成第一次发布放行），改为从 `package.json` 读，并在版本低于 registry 的 `latest` 时告警（只告警：从旧分支发版会把 `latest` 退回去，但一个不完整的预发布版本顺序比较不应该直接否决发布）；静态 token 的形式校验把 `exit 1` 降为告警，OIDC 这条主路径不该被备用凭据的形式卡住；`scorecard.yml` 的 job 级判断用 `github.ref_name` 和默认分支名比较，遇到同名 tag 会误判，改为比较完整的 ref。
- **`ci.yml` 的 `-ignore SC2016` 是全局豁免**：一行调用同时校验四份工作流，`codeql.yml` 和 `scorecard.yml` 没有 run 脚本内容，却也跟着继承了这条豁免——它们以后真写出的同类问题会被一起放过。改成按文件分两次调用。
- **`codeql.yml` 与 `scorecard.yml` 缺并发控制与权限声明**：前者补上 `actions: read`（本仓是公开仓库，官方只在私有仓库要求这一项；明确写出来是为了可见性变化时不要静默少权限），后者补上按事件名分组的 `concurrency`，让四个触发入口不再互相覆盖同一份 analysis 结果。
- **`test/schema-coverage.ts` 里读 host schema 的解析器**：匹配括号时不跳过字符串、模板与注释，`Schema.object(` 只取第一个块，扩展名只收 `.ts`，包根靠 `testDir/..` 硬推而且读不到时没有处理。这些偏差都会让"宿主字段全集"偏少，而门禁因此看起来通过。解析器改成能识别字符串和注释、遍历全部 `Schema.object`、按前缀识别扩展名、向上找 `package.json`、读不到时报失败；新增 `test/schema-coverage.test.ts` 把这一部分的行为钉住下来。
- **记忆反馈的目标地址与正文的处理**：网关地址必须是合法的 `http(s)` URL（只写了一半的串、不是 http(s) 的 scheme 都按"未配置"处理），凭据只发 https 或回环地址；`x-tdai-service-id` 的形式不合法时改用默认服务名；命令、项目根和错误文本在写入记忆之前先折成一行，避免一条反馈被拆成多段。
- **编辑累加器的容量上限对任何入参都成立**：`maxFiles` 是 NaN、0、负数或小数时改用默认值；同一个文件被反复编辑会把位置刷新到最近，避免最该检查的文件第一个被淘汰；host 和累加器共用同一份编辑工具名单。
- **消息模板插值只认对象自己的键**：`{constructor}` 和 `{toString}` 这类原型链上的名字不再被渲染成函数源码，没有给值的名字替换成空串。

构建与 CI（同属这一版）：

- **`host.ts` 里三处用 `/` 拼接子路径的地方改成 `path.join`。** `findManifestRoot` 找 `MANIFESTS`、`workspaceRootUpgrade` 找 `pnpm-workspace.yaml`、`probeProjectRoot` 过滤清单文件和判断 `tsconfig.json`，原先都用模板字符串拼出 `dir/manifest`。`dir` 是宿主给出的真实路径，在 Windows 上这种混合写法让 `existsSync` 永远返回 false——于是所有清单都探测不到、项目根一路退到父目录，`gate-detect` 的判断整片失效，而命令照常退出 0。同一处 `declaredScriptsOf` 读 `package.json` 也改成 `path.join`。新增 `TSCONFIG_MANIFEST` 常量，避免同一个文件名在文件里出现两次。
- **`collapseStorePaths` 的折叠原先完全静默。** 正则只认 `/` 分隔的「内容寻址 store 段」（`node_modules/` 下那层带「名@版_哈希」的目录），既没有归一反斜杠，也没有折掉前缀里的 `../`。没命中时它原样放行，于是 `client.js` 会带着「版本 + 本机 store 哈希」进公共产物，而两道新鲜度门禁比的都是同一台机器上的内存构建与磁盘文件——没有任何门能看见。现在先归一分隔符，再把可选的前缀与 store 段整段折成一层，折完仍检出 store 段就抛错停止构建。
- **`writeArtifact` 的临时文件名只用 pid。** 同一个进程里并发写两个产物会撞名、互相截断。临时名加上 `randomUUID()`；`catch` 里清理临时文件的 `rm` 包进内层 try/catch，清理失败不再替代并掩盖真正的写入失败（Windows 上 `EBUSY` 和 `EPERM` 会让清理这一步自己抛错）。
- **客户端产物的 `external` 由 `id.startsWith("react/")` 改成精确集合 `REACT_RUNTIME_MODULES`。** 外壳的模块表按精确串匹配，前缀放行会给产物留下模块表里没有的键——加载期报 `not in the module table`，整张卡片静默不渲染。集合与宿主客户端侧的 `PLATFORM_MODULES` 同源，只收宿主真给得出的四个说明符。
- **两处注释与实际实现不一致。** 构建脚本开头的注释说"react 和它的子路径都要外部化"，并给出"内联子路径会出现第二份 React"的理由——这个理由不成立，`react/jsx-runtime` 内联之后自身仍然 `require("react")`；`ci.yml` 里"门禁没跑过就别留下产物。"那一行原先挂在上传覆盖率报告的步骤上方，和它描述的步骤对不上。
- **`test/host-integrity.test.ts`、`test/host.test.ts`、`test/gateway-feedback.test.ts` 里的 POSIX 假设。** 新增的 Windows 矩阵会让这些断言整片失败：临时目录原先写成字面量 `/tmp/qg-shallow-…`，改成 `path.join(tmpdir(), …)`；匹配 tsc 命令的正则 `/bin\/tsc --noEmit$/u` 在 Windows 上拿到的是 `'C:\…\bin\tsc' --noEmit`（带引号、反斜杠），改成 `/bin[\\/]tsc'? --noEmit$/u`；`deriveProjectKey` 的输入补上 `sep: "/"`，让路径写法和它的来源一致——路径写法和 `resolve` 的结果不是同一次调用得到时，`path.win32` 会把 `/tmp/x/proj` 解析成带盘符的字符串，字面量替换一次都不会命中。

### Changed

- **宿主开发线抬到 `0.2.2-alpha.2`**：devDependencies 与 catalog/overrides 取同一个值；`engines.dsh` 与
  `@deepseek-ai/dsh*` 的 peer 写成支持窗口 `^0.2.1-rc.3`。
- **`ruff`门禁命令在什么条件下会发**（见 Fixed 第一条）是**判断规则**的变化：只有 `pyproject.toml` 的 Python 工程从此不再自动拿到 ruff门禁命令。两份 README 的命令表同步。
- **宿主线抬到 `0.2.1-rc.3`**：`engines.dsh`、peer/dev 依赖、overrides 和 README 的徽章与正文取同一个值。
- **构建的编排统一到 shared 的 `lib/build-*`**：三个构建脚本只剩下配置的那一层，产物仍然输出到 `dist/`；CI、CodeQL、Scorecard、Dependabot 和 Windows 矩阵补齐。

- **`publish.yml` 补回 `pnpm run check`。** 发布由 `workflow_dispatch` 手动触发，可以从任意分支发起；CI 在 `main` 上通过不代表被发起的那个 ref 也通过，而发布前少了这一项检查，就等于把"发出去的东西装得上"和"发出去的东西是对的"当成同一件事。现在它在 `pnpm install --frozen-lockfile` 之后、`发布` 之前跑。
- **`ci.yml` 的覆盖率上传改成 `if-no-files-found: warn` 而不是 `error`。** 这一步在 `if: always()` 下运行，而 `coverage/` 由 vitest 产出——typecheck、lint 或 build 任一步先失败时目录根本不存在，这时报失败会盖住真正的原因，还会把后面的步骤一起打断。
- **`ci.yml` 里新增的 Windows 矩阵与多平台并发组的写法**：组键带上 `event_name`，取消只给 `push` 和 `pull_request`；检查名带上 `matrix.os`；attest 拆成独立的 job 并补上 `artifact-metadata: write`；install-probe 收窄到 `contents: read`；所有 `actions/checkout` 带上 `persist-credentials: false`；第三方 action 和 `actionlint` 全部固定到 commit SHA 或校验和。

### Added

- **`tsconfig.build-scripts.json` 与 `typecheck` 里多出的一次 `tsc`。** 两个构建脚本开头的 `// @ts-check` 只在编辑器里生效：它们不在任何 `tsc` program 的 `include` 里，CI 因此对这一部分没有任何检查。新的 tsconfig 继承共享基线、打开 `allowJs` 和 `checkJs`、`noEmit`，只收两个构建脚本；`typecheck` 追加 `&& tsc --noEmit -p tsconfig.build-scripts.json`。把改动改回坏的形状实测过：往 `build-client.mjs` 塞一行 `probe.toFixed("nope")` 会失败，删掉就恢复。
- **`tsconfig.build-scripts.json` 补上之后暴露并修掉的类型问题**：`isRecord` 一律改成类型谓词（`@returns {raw is Record<string, unknown>}`），`asRecord` 改成走守卫分支而不是类型断言（断言会同时踩到 `typescript(no-unsafe-type-assertion)` 和 `eslint(no-inline-comments)`）；`invokedDirectly()` 先取 `process.argv.at(1)` 再判断是否为 `undefined`，不再把可能不存在的值直接交给 `realpathSync`；读 `package.json` 的 `name` 用 `const nameKey = "name"` 做索引——点号写法被 `noPropertyAccessFromIndexSignature` 拒绝，方括号写法又被 `dot-notation` 要求改成点号，只能靠一次具名取值同时满足两条。
- **`.gitattributes` 固定 `* text=auto eol=lf`。** Windows runner 上 Git for Windows 的机器级 `core.autocrlf=true` 会把工作区文件换成 CRLF，而 `oxfmt` 的 `endOfLine` 默认值是 `lf`——`fmt:check` 只在 windows 那一格把每个文件都判成未格式化，内容其实一个字都没差。
- **`test/dist-size.test.ts` 的上限改成按实测值定**：`host.js` 70 500 B（实测 61 110 B）、`client.js` 23 500 B（实测 20 222 B），在实测值上加约 15% 再向上取整到 500 B。注释写明本仓没有 `build-types.mjs`，所以只量这两项。
- **`package.json` 的 `keywords`**，以及两份 README 各新增一节"shared 的版本下限 / Shared version floor"。

### Not changed, deliberately

- **除了 ruff 检查命令的发出条件之外，四条命令的白名单与优先级、`not-run` 与 `code-failure` 的分界、注入次数上限、时间预算的分配、默认设置值和双语文案的内容都没变。**
- **覆盖率阈值仍然由 `@jayyuen66/dsh-plugin-shared/config/vitest.base` 这一处给出（100%）**，`coverageInclude` 仍然只覆盖 host 侧。

### Tests

- `pnpm run check` 通过：typecheck 三个 tsconfig、`oxlint` 0 warning / 0 error、两个 rolldown 构建、`vitest run --coverage` 四项 100%、`oxfmt --check`、`check:pack` 的 tarball 核对。
- 新增的门禁都做过变异实测：`tsconfig.build-scripts.json` 那条塞错误即红、删掉即绿；`collapseStorePaths` 的残留检查拿含 `.pnpm` 的行喂进去会抛，四种真实形态（无前缀 / `../` 前缀 / 反斜杠 / 普通相对段）折叠结果逐个断言。
- Windows 兼容那三条用两种写法直接验证断言：POSIX 形式的 `<root>/node_modules/.bin/tsc --noEmit`，和 win32 形式那个带盘符、反斜杠和引号的写法，旧正则只命中前者，新正则两个都命中。

## 0.1.2

`tsc` 改走本包的依赖、凭据只发 https，并修掉三处"命令照常通过而门禁其实没在工作"的静默失效。

### Fixed

- **事件读取接口不存在或读取失败时，整套检查静默失效、一条日志都没有。** 改为按原因 warn 一次（同一个原因只说一次），并补上"同一条只说一次"的断言。
- **每个回合让宿主按默认的 `projectionMode="all"` 把整份 session 投影白算一遍**：改为显式传 `"none"`。
- **往上找 `workspace` 根会顶掉子包自己的 `tsc` 或 `ruff`门禁**：只有在外层确实能给出门禁时才升这一层，两份 README 同步。
- **`npx tsc` 在项目没装 `typescript` 时会下载并执行一个已弃用的占位包**：`typescript` 进 `dependencies`，门禁改为解析真实的入口（工程本地优先、其次本包依赖里的那份），关于 `npx` 和占位包的识别文案删除；命令拼接补上引号处理。
- **记忆网关允许明文 `http` 并且照样发 `Bearer`**：现在只允许 `https` 或回环地址，其他地址在解析凭据之前就按未配置拒绝并说明原因。

### Changed

- `vitest.config.ts` 写明客户端那一半不计入覆盖率的理由（共享基线要求写出的例外）。

## 0.1.1

宿主生态与工具链跟到发布线，发布产物的检查补严。**检查的判断规则、四条命令白名单、注入文案和
默认设置都没有改**，改的是"和哪个版本对齐"与"发出去的东西是什么样子"。

### Changed

- `@deepseek-ai/*` 家族从 `0.2.1-alpha.1` 升到 `0.2.1-alpha.2`：devDependencies、
  peerDependencies 的 `@deepseek-ai/dsh`、`pnpm-workspace.yaml` 的 `overrides`、`engines.dsh`
  四处取同一个值（`test/publish-manifest.test.ts` 要求 `dsh-*` 与 peer 逐项相等）。
  `@deepseek-ai/cordis` `4.0.5-alpha.1` 与 `@deepseek-ai/schemastery` `3.18.5-alpha.1` **不动**：
  那是 alpha.2 自己固定的两个版本（`~4.0.5-alpha.1` / `~3.18.5-alpha.1`），registry 上没有更新的 alpha。
- 上游逐包比对过发布件：本包用到的类型声明没有破坏性变化。`dsh-agent` / `dsh-credentials` /
  `dsh-settings` / `dsh-shell` / `dsh-sandbox-policy` / `dsh-package-manifest` 发布出来的内容
  与 alpha.1 逐字节相同；`dsh-session` / `dsh-session-query` / `dsh-client-ui-plugin-manager`
  只有增量。打包契约（`cordis.patch.yml`、`dsh.bundle.patch`、`dsh.client`、`manifestVersion: 1`）
  不变，因此 `host.ts` 没有必需的适配改动。
- `@jayyuen66/dsh-plugin-shared` `^0.1.2` → `^0.1.4`。这一版改变了**发布产物的组成**：0.1.2 把
  `@deepseek-ai/dsh-jobs`、`dsh-tools`、`dsh-session` 这些宿主包列在自己的 `dependencies` 里，
  使用者的 profile（`nodeLinker: hoisted` 加 `autoInstallPeers: false`）因此会再装一份宿主的实现，
  和正在运行的宿主并存——这正是"`@deepseek-ai/*` 不进 dependencies"那条门禁管不到的依赖树下一层。
  0.1.3 把它们挪进 `peerDependencies`，0.1.4 再把那几个 peer 对齐到 `0.2.1-alpha.2`。
- 入口：`main` 和 `exports` 指向构建产物 `host.js` / `client.js`，入口的覆盖范围不再写在
  `publishConfig` 里（pnpm 发布时会合并到顶层、npm 忽略它并打印 Unknown publishConfig——同一个仓库
  换一个发布工具就会发出一个 import 一定失败的包）。
- 工具链（`pnpm-workspace.yaml` 的 `catalog`）跟到发布线：`@types/node` 26.6.3→26.6.5、
  `vitest` 与 `@vitest/coverage-v8` 5.0.2→5.0.3、`vite` 8.3.1→8.3.4、`rolldown` 1.2.11→1.2.13、
  `oxlint` 1.86.0→1.87.0、`oxfmt` 0.71.0→0.72.0、`oxlint-tsgolint` 7.0.2003→7.0.2004。
  `typescript` 7.0.2、`react` 与 `@types/react` 19.3.0、`eslint-plugin-sonarjs` 4.2.2 已经在发布线上。
- 新增 `engines.node`（`>=22.12.0`）：产物用到 `AbortSignal.any` 这类较新的运行时能力。
- `tsconfig.client.json` 删掉 `"types": ["node"]` 这一处本地覆盖：shared 的 client 预设本来就是
  `types: []`，这个覆盖把 Node 的全局类型又塞回了客户端那一半。删掉之后 client 工程和宿主预设一致，
  类型检查仍然通过——客户端部分从来没有用到 Node 的全局类型。

### Added

- 文档拆分：`README.md` 是英文入口，`README.zh-CN.md` 是中文，两行开头互相链接。
- `CHANGELOG.md` 与 `THIRD_PARTY_NOTICES.md`（ECC 的 `stop-format-typecheck` 与
  `post-edit-accumulator` 的机制来源和差异表），两份都写进了 `files`。
- `test/publish-manifest.test.ts` 的发布产物门禁：
  - "仓库根目录每个 `.md` 都必须出现在发布产物里"——只有 readme 形式的文件靠发布工具无条件附带，
    `CHANGELOG.md` 这类不写进 `files` 就发不出去，而"文档写了但读者看不到"这种情况此前没有人能发现。
  - `ALWAYS_SHIPPED` 改成按 `pnpm pack --dry-run` 实测到的四个，删掉不成立的条目。
  - 构建产物的内容扫描：随包发布的 `host.js` 和 `client.js` 里不许出现日期、本机绝对路径、
    pnpm 的 store 目录名。
  - `engines.dsh` 必须等于 peer `@deepseek-ai/dsh` 去掉范围符号后的下界；`engines.node` 不得
    低于宿主的发布线。
- 注释检查（同一个文件）从"只禁完整日期"扩到：只写到月份的日期、指向作者主目录的本机路径、
  pnpm 的 store 目录名、内部工作项编号（字母加数字的形式）、指向未随包发布的笔记的行号指针、
  上游源码仓里的工作区路径，以及那些描述工作过程而不是写出约束本身的词（逐条见
  `test/publish-manifest.test.ts` 的 `FORBIDDEN_IN_COMMENTS`）。据此把 `host.ts`、`lib/*.ts`
  和 `src/*.ts` 的注释重写了一遍：只留约束本身，删掉过程记录。指向已安装依赖的声明文件行号不在
  禁掉的范围内——版本钉住之后那是人人都能查到的依据。
- `pack-check.mjs` 和 `check:pack` 脚本：对 `pnpm pack` 产出的**真实 tarball** 做核对——入口和
  无条件附带项都在包里、源码和本地状态目录没混进去、`@deepseek-ai/*` 没落进 `dependencies`、
  代码文件里每个裸说明符都由 dependencies 或 peerDependencies 提供、产物内容不含日期和本机路径。
  已经接进 `check`，所以本地和 CI 用的是同一套判断。
- `test/dist-size.test.ts`：两个构建产物的字节上限。检查落在体积上，是因为"依赖被内联进产物"
  这一类回归没有更早的信号——类型检查和单元测试都不看产物。
- `ci.yml`：push 和 PR 上跑 `pnpm install --frozen-lockfile` 加 `pnpm run check`（含上面那条
  tarball 核对），并断言检查过程没有改写受版本控制的文件。运行时只用 node 24，和发布流程在同一条线上。

### Fixed

- `@deepseek-ai/dsh-credentials` 的声明位置和注释不一致：注释说它在 `dependencies`，
  实际上被"`@deepseek-ai/*` 不进 dependencies"这条门禁挡在外面。注释按真实的机制改写——它靠
  **peerDependencies** 进入 `build-host.mjs` 的外部化范围（外部化集合是 dependencies 加上
  peerDependencies），所以产物保留裸说明符，官方实现的函数体不会被内联。
- README 里"另一个运行时依赖是 `@deepseek-ai/schemastery`"这个说法：那一个由宿主解析、
  不由本包安装，文档改为按实际来源描述，并补上宿主版本要求。

### Not changed, deliberately

- 四条门禁命令的白名单与优先级、`not-run` 与 `code-failure` 的分界、注入次数上限、时间预算的
  分配、默认设置值、双语文案的内容。
- `@deepseek-ai/*` 一律只取类型（`dsh-credentials` 的两个纯字符串函数除外）。
- 覆盖率阈值仍然由 `@jayyuen66/dsh-plugin-shared/config/vitest.base` 这一处给出（100%），
  本包不放宽；`coverageInclude` 仍然只覆盖 host 那部分（`host.ts` 加 `lib/*.ts`），客户端那一半没有
  DOM 环境可以跑，见 `test/client-card.test.ts` 的说明。

### Tests

- 全套门禁通过：typecheck（两个 tsconfig）、`oxlint`（0 warning / 0 error）、两个 rolldown
  构建、`vitest run --coverage`、`oxfmt --check`。
- 构建产物在真实 Node 上直接 `import()` 装载成功，裸说明符全部解析得到。
- `pnpm pack` 的 tarball 逐项检查：入口指向构建产物、`@deepseek-ai/*` 不在
  `dependencies` 里、两份 README 和两份新文档都在发布产物里。

## 0.1.0

`@jayyuen66` 作用域下的第一个公共 npm 发布。

### Added

- 回合结束时的质量门禁：`agent/turn-stopping` 按项目形态跑 `pnpm check`、`cargo check`、
  `ruff check .` 或 `npx tsc --noEmit`，没通过就注入修复指令并开新回合。
- 显式的三种判断结果（`pass` / `code-failure` / `not-run`），加上会话级的次数上限、总时长上限
  和编辑文件记录。
- 设置卡（web 客户端界面）与中英双语文案；记忆网关的反馈默认关闭，密钥走宿主的凭据通道。
