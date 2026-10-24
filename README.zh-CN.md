<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-quality-gate@main/icon.svg" width="96" height="96" alt="dsh-quality-gate logo" />
</p>

<h1 align="center">dsh-quality-gate</h1>

<p align="center"><em>回合收口时自动跑项目自己声明的检查；没跑成的检查，绝不会被记成通过。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-quality-gate"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-quality-gate?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-quality-gate"><img src="https://img.shields.io/npm/dm/@jayyuen66/dsh-quality-gate?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/JayYuen666/dsh-quality-gate/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-quality-gate/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-658EFF?style=flat-square" alt="English" /></a>
</p>

**一个 [dsh](https://github.com/deepseek-ai/deepseek-harness) 插件：回合收口质量门禁——本轮改过代码/配置文件，就在回合收口前跑该项目自己声明的检查；未通过经 `agent.followup` 注入修复指令、开新回合接着修，配额与总预算封顶。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [确认它真的在工作](#确认它真的在工作)
- [它不提供什么](#它不提供什么)
- [在 dsh 里启用](#在-dsh-里启用)
- [跑哪四条门禁](#跑哪四条门禁)
- [设置项](#设置项)
- [对外接口](#对外接口)
- [数据与隐私](#数据与隐私)
- [已知边界](#已知边界)
- [常见问题](#常见问题)
- [开发](#开发)
- [许可](#许可)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

- **回合收口，不拦过程。** 判定挂在宿主事件 `agent/turn-stopping`：读本会话**成功的**编辑 → 每个文件向上找最近清单根 → 探测门禁 → 执行。失败经 `agent.followup` 注入修复指令；宿主在收口之后仍会检查收件箱，于是开新回合接着修。
- **一次检查只有三种结论**：`pass`（真的跑完且 exit 0）、`code-failure`（跑了且报代码错）、`not-run`（没跑成）。一条没真正跑完的检查绝不会被记成通过；「没跑成」与「代码错」也绝不混同——前者注入的是「请手动确认」，不写记忆、不以 `gate-failure` 进教训总线。
- **只跑项目自己声明的命令。** 四条白名单命令按根探测择一，拿不到声明就宁可不给门禁，也不替项目发明一条稳定假失败的命令（判据见「跑哪四条门禁」）。
- **防跑飞。** 修复注入按会话跨回合计配额，耗尽即注入一次用户可见的放行说明并停止自动修复；门禁总预算封顶，超时按「未执行」注入、不静默放行。
- **它不改代码、不拦截危险命令（那是 danger-guard 的职责）、不写任何文件。**

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-quality-gate
```

卸载：`dsh plugin --profile web remove @jayyuen66/dsh-quality-gate`。包在公共 npm 上，安装不需要凭据，也不需要配作用域源。

- **要求 Node.js `>= 22.12`。** 产物用到 `AbortSignal.any` 这类较新的运行面。
- **要求宿主 `dsh` 在 `0.2.1-rc.3` 这条线上。** 宿主读取的版本要求是 `engines.dsh`（`^0.2.1-rc.3`），它**单独决定**兼容性；预发布版本参与范围比较，`0.3.0` 及以后要走显式担责的授权 `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`。
- **运行时依赖 `@jayyuen66/dsh-plugin-shared` 必须已在同一 registry 上**，否则整组 404。
- **`typescript` 是真实的 `dependencies`**：`tsc` 门禁的兜底入口——工程自己装的那份优先，其次随包安装的这份，运行期无网络动作，从不走 `npx` 的自动下载。
- **`@deepseek-ai/schemastery` 由宿主解析、不由本包安装**：只有宿主 fork 的那一枚能把 `.volatile()` 字段解析成活引用，换成公共 schemastery 就变成改设置要重启才生效。`@deepseek-ai/dsh-credentials` 的两枚校验函数是值导入，因此落在 `peerDependencies`——`dependencies` 里不放任何 `@deepseek-ai/*` 是发布契约（`test/publish-manifest.test.ts` 钉着：写在 `dependencies` 里的宿主包会在消费方 profile 里物化出第二份，与运行中的宿主并存）。
- 本地目录形态安装需 pnpm ≥ 12.3.0（12.0.0 的本地目录 `add` 有已知缺陷）。

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> shared 的版本下限

如果你的 profile 用 pnpm `overrides` 把 `@jayyuen66/dsh-plugin-shared` 钉在某个版本，那个钉住的值必须不低于本包声明的那一版。钉得更低会装到一份缺少运行期所导入名字的产物，宿主起来时报 `N entries did not activate` 与 `does not provide an export named ...`——包装得上、永远不生效，而各仓单仓 CI 看不见这一类。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 确认它真的在工作

1. **层已经进栈。** `dsh --profile web --dump-config` 末尾出现 `# == @jayyuen66/dsh-quality-gate` 与 `- id: quality-gate`。
   - 那条命令是唯一被接受的「进了层栈」信号，而且它**不是只读命令**——它会重写该 profile 的根装配文件。层行要从 stdout 读，**并且**单独检查 stderr：没匹配上的 patch 目标只出现在 stderr，只看退出码证明不了任何事。两种形态都要认：`# == <层>` 与 `# == <层>, patched by <路径>`。
2. **卡片渲染出来。** 设置页的插件列表出现「quality-gate 回合收口门禁」；改一个值，「保存」由 disabled 转 enabled，点保存后写入生效。
3. **门禁真的会跑。** 在它认得的工程里（例如根有 `package.json` + `tsconfig.json` 的 TS 项目）让 agent 改一个代码文件再结束回合：门禁命令在该根执行；命令失败时模型收到 `[quality-gate]` 前缀的修复指令，回合继续而非直接结束。宿主日志里同一前缀的行带着命令与根。若毫无变化，读法是**层没装**，不是规则太松。
4. **「未能执行」的读法。** 环境类失败（沙箱拒绝、工具装不上、预算不足）注入的是「请手动确认」说明而不是修复指令——这不是代码错误的证据，别照着它改代码。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

找之前先知道这几件事：

- **它不注册任何模型工具。** 整个面就是 `agent/turn-stopping` 事件监听；没有 `gate_status` 这类可调工具。
- **它没有 HTTP 路由，也没有 Remote 命名空间。** 设置卡直接消费官方 `configForms` 表单、经宿主通道写设置——与自带数据面的兄弟插件不同，本包的数据面就只有设置这一块。
- **它不加 CLI 子命令。**
- **它不写文件、不遥测**；唯一的出站请求是设置里显式开启的记忆网关（见「数据与隐私」）。
- 它**可选**消费的东西：`lessonLoop` 总线（教训上报）、`credentials`（密钥解析）、`sandboxPolicy`（按会话解析策略）、`sessionQuery`（事件读面）、`shell`（执行面）。都是可选 `ctx.get` 读——缺哪个只让对应能力消失，插件照常装载。

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- 组合包形态：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，唯一的注册行是 `- id: quality-gate`、`name` 为裸包名（宿主只对裸包名条目扫 `dsh.client`）；`dsh plugin --profile web add/remove` 维护该行。
- Host 半硬依赖只有 `settings`（`default.inject = ["settings"]`）；优先级是 设置卡运行时值 > 行 `config:` > schema 内置默认。
- Client 半（`dsh.client.platform = web`、`immediately: true`）往插件管理页的 `plugins.bundle.config` 槽注入一张卡。两枚标识刻意不同源：槽位 key 是 **bundle 包名** `@jayyuen66/dsh-quality-gate`，设置命名空间与 `configForms.get()` 用的是**裸条目 id** `quality-gate`——写混了卡片哪都不渲染。
- 卡的保存是显式两段式：改动先留在本地暂存（状态条提示），点「保存」才逐键**串行**写入并消费 `Promise<boolean>` 受理位——首个 `false` 即停手、显示 `saveRejected` 并保留未落盘的改动；写入 reject 显示 `saveFailed`。保存期间输入框仍可编辑，期间产生的新改动保留在待保存面里，不会被这次保存顺带抹掉；「撤销」丢弃暂存。清空一个输入框 = unset，恢复该字段的 schema 默认。
- 两枚部署值没有卡上的行，只能写在注册行的 `config:` 上、改值随重启生效：`maxRootDepth`（向上找根的层数）与 `gateStdoutMaxBytes`（证据捕获上限），默认值见设置表。

## <img src="https://api.iconify.design/lucide/terminal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 跑哪四条门禁

白名单在类型层锁死（`lib/gate-detect.ts` 的 `GateCommand` 联合），只有这四条能进执行面；每个根至多一条，优先级 workspace > Rust > Python > 裸 TS。

| 命令 | 什么时候发 |
| --- | --- |
| `pnpm check` | 根同时有 `pnpm-workspace.yaml` 与 `package.json`，且根 scripts 声明了非空 `check`。没声明就退回下一候选 |
| `cargo check` | 根有 `Cargo.toml` |
| `ruff check .` | 根有 `ruff.toml`，或 `pyproject.toml` 里有 `[tool.ruff]` 一族段。只有 `pyproject.toml` 不算——那是 Python 元数据文件，不是「用 ruff」的声明 |
| `tsc --noEmit` | 根同时有 `package.json` 与 `tsconfig.json`；缺 `tsconfig.json` 不算 TS 项目 |

- `tsc` 在命令里只是逻辑名：入口在运行期解析——工程自己装的 `typescript` 优先，其次随包那份，最后 PATH 上的 `tsc`（由「工具不可用」出口报成未执行）；绝不走 `npx` 的自动下载。
- 根探测：从编辑文件向上最多 `maxRootDepth`（默认 10）层找最近清单根；monorepo 子包升到 `pnpm-workspace.yaml` 所在的工作区根——但只在该根**产得出门禁**时升级，否则保留子包自己的根（外层没有 `check` 脚本的 workspace 不得吃掉子包的 `tsc` / `ruff` 门禁）。
- 预算与并发：总预算 `gateBudgetMs`；每根取 `max(10s, 预算/根数)` 与实际剩余的较小值；剩余不足 5s 的尾段不再起跑，按「未执行」注入清单。门禁顺序执行，一次只注入一个失败。
- 证据上限：每条流内存留存 64 KiB（截断保尾部，首条错误才是根因），被截断时从落盘文件有界读回 4 KiB 头部；单会话编辑记账 500 个文件，超出按插入序淘汰并 warn。

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

命名空间 `quality-gate` 即设置条目 id；投影进设置表单的字段就是那几个 `.volatile()` 的。

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；关掉即收口不再核验 |
| `maxInjectsPerTurn` | natural，1–5 | `2` | 修复指令注入配额，按会话跨回合累计 |
| `gateBudgetMs` | natural，10000–600000 | `300000` | 门禁总预算；超时按失败注入，不静默放行 |
| `memoryFeedback` | boolean | `false` | 是否把代码型失败额外沉淀到记忆网关 |
| `memoryGatewayUrl` | string | `""`（未配置） | 网关基址；设置值优先，留空回落 env `TDAI_GATEWAY_URL` |
| `memoryGatewayKeyRef` | string（凭据引用名） | `TDAI_GATEWAY_KEY` | 网关密钥的引用名；值走宿主凭据服务，不落设置 |
| `maxRootDepth` | natural | `10` | 向上找项目根的最大层数（部署值，卡上无行） |
| `gateStdoutMaxBytes` | natural | `65536` | 每条流的证据捕获上限（部署值，卡上无行） |

设置持久化在 dsh 数据目录的宿主设置文件里；卡的保存语义见「在 dsh 里启用」。

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 对外接口

- **无 HTTP 面**：本包不注册任何路由或端点，也没有供外部调用的接口。
- **对宿主**：settings 命名空间 `quality-gate` 是隐式注册（命名空间 = 条目 id，可编辑字段由 `Config` 上标 `.volatile()` 的项决定，不再有 `settings.register`）；schema 与注册行 `config` 共用同一份 `Config`。页面策略声明为 `auto: false`——本包自带卡片，别让宿主再生成一份自动表单。
- **注入的 followup**：`role: "user"`、`source: { kind: "plugin:quality-gate" }`、id 为 `quality-gate-` 前缀加一个 UUID。
- **注入给模型的文案只有四类**，统一带 `[quality-gate]` 前缀与命令/根上下文：修复指令；门禁「未能执行」说明（内嵌预算不足的未执行清单）；配额耗尽后的放行说明。
- **日志**走宿主具名 logger（`info` / `warn` / `error` 面），该服务缺席才回退 `console`。
- **语言**：host 侧文案随官方 settings 的 `locale` 偏好，未注册即中文，改语言下一回合生效；卡片文案走官方 client locale，切语言由宿主重渲染、不必重载页面。
- **对总线**（装了 lesson-loop 时）：`report({ source: "quality-gate", category: "gate-failure" | "gate-not-run", cwd, sessionId, turn, signature: 命令串, detail: 全文证据, evidence: { root, command, kind } })`。总线缺失时报告直接丢弃，门禁照常运行；`memoryFeedback` 开关不影响总线上报。
- **可选外发**：向 `memoryGatewayUrl` 发 `POST /v2/conversation/add`，5s 超时封顶。请求头带 Bearer 令牌与 `x-tdai-service-id`（env `TDAI_SERVICE_ID` 可覆盖，默认 `default`）；body 为 `session_id: "dsh-agent"` 加一条 `assistant` 消息，`agent_id` 取会话 cwd 的尾目录名加 8 位 sha256 前缀（与 lesson-loop 的项目分桶同源）。

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

| 口径 | 内容 |
| --- | --- |
| 默认零外发 | `memoryFeedback` 关 + 地址空是双保险，任一为空都不推送、也不去查凭据 |
| 出域内容 | 开启后只把命令、项目根与全文报错（单行化、不截断）发往**你自己配的**网关 |
| 地址与凭据安全 | 凭据只发 `https` 或回环地址（`localhost`、`127.0.0.0/8`、IPv6 回环）；明文 `http` 非回环按未配置拒绝并说明理由。地址解析不出合法 `http(s)` URL 同样按未配置 |
| 密钥 | 值由宿主凭据服务持有（`$DSH_HOME` 下的凭据文件），设置里只存引用名；引用名不合 POSIX 变量名语法即视为未配置 |
| 失败处理 | 推送失败只 warn 且每次装载只说一次，绝不阻断收口 |
| 读盘 | 清单存在性、根 `package.json` 的 scripts、`pyproject.toml` 的段头、截断落盘文件的头部；不写任何文件、不遥测 |
| 内存 | 会话级账本（编辑记账/注入配额/事件游标）都在进程内存，插件卸载即清 |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

- **白名单只有四条命令，不能经设置扩展。** 用别的检查器（`go test`、`mypy`、`eslint`…）的根得不到门禁。
- **只记成功编辑**，且只认 `edit` / `write` / `str_replace_editor` 的写入（`view` 只读不算）。扩展名白名单之外的文件（md/txt/图片/`.sh`）不计——没有一条门禁命令能校验它们，`.sh` 只会把根解析到别处跑出假失败。
- **out-of-process 子代理（ACP / claude-code / codex）不发 dsh 事件**，天然不在门禁面内；in-process 子代理跳过，其编辑由父会话下一回合统一核验。
- **不抢话**：inbox 已有待处理消息、回合信号已取消或插件已卸载时不注入。plan mode 不豁免——规划回合改了代码同样收口。
- **证据被截断且没有落盘文件时，首个错误可能已随截断丢弃**；文案如实说明证据不完整，不假装完整。
- **沙箱策略解析失败时一门都不执行**（按未执行注入），绝不回落部署级策略——那会让门禁写在沙箱外被拒、产出假的失败指令。

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 常见问题

| 问题 | 回答 |
| --- | --- |
| pnpm 工程为什么没跑 `pnpm check`？ | 根 `package.json` 没声明非空 `check` 脚本。刻意取舍：假失败比漏检查更贵 |
| 门禁说「未能执行」，是代码错了吗？ | 不是。沙箱策略拒绝、runner 起不来、超时、取消、exit 126/127、预算不足都属此类。注入文案明确要求**不要为此修改代码**，并以 `gate-not-run` 单独上报总线 |
| 会不会无限修下去？ | 配额耗尽后注入一次用户可见的放行说明并停止自动修复，直到某次全部干净通过才重新计数 |
| 临时停掉？ | 设置卡关 `enabled`，或 `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate` |
| `tsc` 用哪个版本？ | 工程自己装的那份优先，其次随包安装的 `typescript`，都不在才回落 PATH——从不经 `npx` 下载 |
| 子代理改的代码呢？ | in-process 子代理由父会话下一回合统一核验；out-of-process 子代理不发 dsh 事件，天然不在门禁面内 |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install
pnpm run check   # typecheck（三个 tsconfig）→ lint → client 构建 → host 构建 → 测试（含覆盖率）→ tarball 体检 → 格式
```

- 覆盖率只统计 `host.ts` 与 `lib/**`，四项阈值 100%。`src/` 不是"没有用例执行"：`test/client-card.test.ts` 无头跑过卡片接线与两语字典（`ui-messages.ts` 被完整执行），但 `client-entry.ts` 的大头是渲染面，要 DOM 基座才能测，本包刻意不引 `react-dom` 与 `jsdom`——渲染测试是另一套基座。把 `src/` 整体计进分母会让阈值变成常红，所以阈值钉在被完整验证的那一面。
- `test/publish-manifest.test.ts` 钉发布形态：入口可解析、`@deepseek-ai/*` 不进 `dependencies`、产物内容无日期与本机路径，注释与文档面同受其扫描。`test/dist-size.test.ts` 守两个产物的体积预算；`check:pack` 对 `pnpm pack` 的真 tarball 做体检。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可

MIT。源码在 [github.com/JayYuen666/dsh-quality-gate](https://github.com/JayYuen666/dsh-quality-gate)。

机制层面移植自 ECC（MIT，© Affaan Mustafa）——回合收口跑项目自己的检查、编辑记账两处机制。[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 记录上游来源、本包在其之上做了什么，以及运行期依赖的边界。
