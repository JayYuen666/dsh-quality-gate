# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。最新版本在最上。这里的偏离是刻意的：
版本标题不写发布日期（各版发布时间以 npm registry 为准，`npm view <包名> time` 取得到），并按需
增设标准六类之外的小节（如 `Tests`、`Not changed, deliberately`）。

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
