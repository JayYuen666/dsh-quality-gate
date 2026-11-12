<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-quality-gate@main/icon.svg" width="96" height="96" alt="dsh-quality-gate logo" />
</p>

<h1 align="center">dsh-quality-gate</h1>

<p align="center"><em>回合结束时自动跑项目自己声明的检查；没跑成的检查，绝不会被记成通过。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-quality-gate"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-quality-gate?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-quality-gate"><img src="https://img.shields.io/npm/d18m/@jayyuen66/dsh-quality-gate?style=flat-square" alt="npm downloads (total)" /></a>
  <a href="https://github.com/JayYuen666/dsh-quality-gate/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-quality-gate/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D24.9-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.2--rc.2-658EFF?style=flat-square" alt="dsh" />
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

**一个 [dsh](https://github.com/deepseek-ai/deepseek-harness) 插件：回合统一处理质量门禁——本轮改过代码/配置文件，就在回合统一处理前跑该项目自己声明的检查；未通过经 `agent.followup` 注入修复指令、开新回合接着修，配额与总预算封顶。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [ 目录](#-目录)
- [ 它做什么](#-它做什么)
- [ 安装](#-安装)
  - [ shared 的版本下限](#-shared-的版本下限)
- [ 确认它在正常工作](#-确认它在正常工作)
- [ 它不提供什么](#-它不提供什么)
- [ 在 dsh 里启用](#-在-dsh-里启用)
- [ 跑哪四条门禁](#-跑哪四条门禁)
- [ 设置项](#-设置项)
- [ 对外接口](#-对外接口)
- [ 数据与隐私](#-数据与隐私)
- [ 已知边界](#-已知边界)
- [ 常见问题](#-常见问题)
- [ 开发](#-开发)
- [ 许可](#-许可)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

- **回合统一处理，不拦过程。** 判定挂在宿主事件 `agent/turn-stopping`：读本会话**成功的**编辑（具名子代理空闲时其台账按游标并入本回合；仍有队友在执行则推迟本轮）→ 每个文件向上找最近清单根 → 探测门禁 → 执行。失败经 `agent.followup` 注入修复指令；宿主在统一处理之后仍会检查收件箱，于是开新回合接着修。`workspace-write` 下门禁根若在会话 cwd 之上，会为这一批临时登记该根的写权限，批次结束即释放。
- **一次检查只有三种结论**：`pass`（真的跑完且 exit 0）、`code-failure`（跑了且报代码错）、`not-run`（没跑成）。一条没真正跑完的检查绝不会被记成通过；"没跑成"和"代码错"也绝不混在一起说——前者注入的是"请手动确认"，不写记忆、也不以 `gate-failure` 报给教训总线。
- **只跑项目自己声明的命令。** 四条白名单命令按项目根探测后择一，拿不到声明时宁可不给检查命令，也不替项目编一条每次都会失败的命令（判据见「跑哪四条检查」）。
- **防止无限循环。** 修复注入按会话跨回合计次数，用完就注入一次用户可见的放行说明并停止自动修复；所有检查的总时长有上限，超时按"未执行"注入说明，静默放行是不会发生的。
- **它不改代码、不拦截危险命令（那是 danger-guard 的职责）、不写任何文件。**

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-quality-gate
```

卸载：`dsh plugin --profile web remove @jayyuen66/dsh-quality-gate`。包在公共 npm 上，安装不需要凭据，也不需要配作用域源。

- **要求 Node.js `>= 24.9`。** 产物用到 `AbortSignal.any` 这类较新的运行时能力。
- **要求宿主 `dsh` 在 `0.2.2-rc.2` 或更新的 `0.2.2` 这条线上。** 宿主读取的版本要求是 `engines.dsh`（`^0.2.2-rc.2`），兼容性**只由它决定**；预发布版本参与范围比较，`0.3.0` 及以后要走明确承担风险的授权命令 `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`。支持窗口是滚动的：本包在发布时把窗口内的每个已发布宿主版本逐版取证，窗口滚动后重新取证，不把这一句里的版本号当长期承诺。
- **运行时依赖 `@jayyuen66/dsh-plugin-shared` 必须在同一 registry 上且不低于 `0.2.6`**（工具失败身份读取它新增的 `ToolResultRecord.error`），否则整组 404 或该特性静默退回旧语义。
- **`typescript` 是真实的 `dependencies`**：`tsc` 这条门禁的兜底入口——工程自己装的那份优先，其次随包安装的这份，运行时不联网，从不走 `npx` 的自动下载。
- **`zod` 也是真实的 `dependencies`**：编辑台账的投影状态和设置卡的值、草稿都用它校验形状；版本走伞根 catalog。client 产物按宿主的 `PLATFORM_MODULES` 保持 `require("zod")` 外部化。
- **`@deepseek-ai/schemastery` 由宿主解析、不由本包安装**：只有宿主 fork 的那一枚能把 `.volatile()` 字段解析成活的引用，换成公共的 schemastery 就变成改设置要重启才生效。`@deepseek-ai/dsh-credentials` 的两个校验函数是值导入，因此落在 `peerDependencies`——`dependencies` 里不放任何 `@deepseek-ai/*` 是发布契约（`test/publish-manifest.test.ts` 固定这一点：写在 `dependencies` 里的宿主包会在使用者自己的 profile 里再装一份，和正在运行的宿主并存）。
- 本地目录形态安装需 pnpm ≥ 12.3.0（12.0.0 的本地目录 `add` 有已知缺陷）。

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> shared 的版本下限

如果你的 profile 用 pnpm `overrides` 把 `@jayyuen66/dsh-plugin-shared` 钉在某个版本，那个钉住的值必须不低于本包声明的那一版。钉得更低会装到一份缺少运行期所导入名字的产物，宿主启动时报 `N entries did not activate` 和 `does not provide an export named ...`——包装得上、永远不生效，而各仓的单仓 CI 看不见这一类问题。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 确认它在正常工作

1. **层已经进栈。** `dsh --profile web --dump-config` 末尾出现 `# == @jayyuen66/dsh-quality-gate` 和 `- id: quality-gate`。
   - 那条命令是唯一被接受的"进了层栈"信号，而且它**不是只读命令**——它会重写该 profile 的根装配文件。层行要从 stdout 读，**并且**单独检查 stderr：没匹配上的 patch 目标只出现在 stderr，只看退出码证明不了任何事。两种写法都要认：`# == <层>` 和 `# == <层>, patched by <路径>`。
2. **卡片渲染出来。** 设置页的插件列表出现条目 `quality-gate`（中文界面标题为 "回合统一处理质量检查"）；改一个值，"保存"由 disabled 转 enabled，点保存后写入生效。
3. **门禁真的会跑。** 在它认得的工程里（例如根目录同时有 `package.json` 和 `tsconfig.json` 的 TS 项目）让 agent 改一个代码文件再结束回合：门禁命令会在该根执行；命令失败时模型收到 `[quality-gate]` 开头的修复指令，回合继续而不是直接结束。宿主日志里同一开头的行带着命令与项目根。如果毫无变化，读法是**层没装**，不是规则太松。
4. **"未能执行"怎么读。** 环境类失败（沙箱拒绝、工具装不上、时间预算不够）注入的是"请手动确认"的说明，而不是修复指令——这不是代码错误的证据，别照着它改代码。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

找之前先知道这几件事：

- **它不注册任何模型工具。** 整套实现就是一个 `agent/turn-stopping` 事件监听；没有 `gate_status` 这类可以调用的工具。
- **它没有 HTTP 路由，也没有 Remote 命名空间。** 设置卡直接用官方 `configForms` 表单、经宿主通道写设置——和自带数据接口的其他插件不同，本包的数据只有设置这一项。
- **它不加 CLI 子命令。**
- **它不写文件、不遥测**；唯一的出站请求是设置里明确开启的记忆网关（见「数据与隐私」）。
- 它**可选**使用的东西：`lessonLoop` 总线（教训上报）、`credentials`（密钥解析）、`sandboxPolicy`（按会话解析策略）、`sessionQuery`（读事件）、`shell`（执行命令）。都用可选的 `ctx.get` 读——缺哪个只让对应的能力没有，插件照常装载。

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- 组合包形态：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，里面只有一条 `- id: quality-gate`、`name` 为裸包名（宿主只对裸包名条目扫 `dsh.client`）；`dsh plugin --profile web add/remove` 维护这一行。卡片组件直接打进 `client.js`（只有 `react` / `zod` 外置给宿主模块表），卡片不依赖第二份包被装载。
- Host 侧唯一必需的依赖是 `settings`（`default.inject = ["settings"]`）；取值的优先级是：设置卡里的运行时值 > 注册行的 `config:` > schema 里的内置默认。
- Client 半（`dsh.client.platform = web`、`immediately: true`）往插件管理页的 `plugins.bundle.config` 槽注入一张卡。两枚标识刻意不同源：槽位 key 是 **bundle 包名** `@jayyuen66/dsh-quality-gate`，设置命名空间与 `configForms.get()` 用的是**裸条目 id** `quality-gate`——写混了卡片哪都不渲染。
- 卡片的保存明确分两步：改动先留在本地暂存（状态条提示），点"保存"才逐键**串行**写入并检查返回的 `Promise<boolean>` 受理标记——第一个 `false` 就停手、显示 `saveRejected` 并保留还没写入的改动；写入 reject 显示 `saveFailed`。保存期间输入框还能编辑，这期间产生的新改动留在待保存内容里，不会被这一次保存顺带抹掉；"撤销"丢弃暂存。清空一个输入框 = unset，恢复该字段的 schema 默认值。
- 有两个部署用的值卡上没有对应的行，只能写在注册行的 `config:` 上、改值要重启才生效：`maxRootDepth`（向上找项目根的层数）和 `gateStdoutMaxBytes`（证据捕获上限），默认值见设置表。

## <img src="https://api.iconify.design/lucide/terminal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 跑哪四条门禁

白名单在类型层锁死（`lib/gate-detect.ts` 的 `GateCommand` 联合），只有这四条能进入执行；每个项目根最多一条，优先级 workspace > Rust > Python > 只有 TS 的项目。

| 命令 | 什么时候用 |
| --- | --- |
| `pnpm check` | 根目录同时有 `pnpm-workspace.yaml` 和 `package.json`，且根 scripts 声明了非空的 `check`。workspace 根没声明 `check` 时一条门禁都不发——它不会退到 `tsc`（见下） |
| `cargo check` | 根目录有 `Cargo.toml` |
| `ruff check .` | 根目录有 `ruff.toml`，或者 `pyproject.toml` 里有 `[tool.ruff]` 开头的那些段。只有 `pyproject.toml` 不算——那是 Python 的元数据文件，不是"我在用 ruff"的声明 |
| `tsc --noEmit` | **不是 workspace** 的根目录同时有 `package.json` 和 `tsconfig.json`；没有 `tsconfig.json` 不算 TS 项目。workspace 根的 tsconfig 多是 solution-style（`files: []` 加 `references`），`tsc --noEmit` 一个子工程都不检查就退 0，所以不在这里 |

- `tsc` 在命令里只是个逻辑名：入口在运行时确定——工程自己装的 `typescript` 优先，其次是随包安装的那份，最后才是 PATH 上的 `tsc`（由"工具不可用"那条出口报成未执行）；绝不走 `npx` 的自动下载。
- 项目根探测：从编辑过的文件向上最多找 `maxRootDepth`（默认 10）层，取最近的清单根；子包**自己就是** workspace 根、也能给出 `pnpm check` 时就地执行（改一个包不能把整个多仓工作区拖进来）；否则 monorepo 的子包升到 `pnpm-workspace.yaml` 所在的工作区根——但只有在那一层**确实能给出门禁**时才升，再不行就保留子包自己的根（外层没有 `check` 脚本的 workspace 不能顶掉子包的 `tsc` 或 `ruff`门禁）。
- 时间与并发：总时长上限 `gateBudgetMs`；每个根取 `max(10s, 预算/根数)` 与实际剩余时间中较小的那个；剩下不足 5s 的那一段不再开始新命令，按"未执行"注入清单。门禁一条接一条跑，一次只注入一个失败。
- 证据上限：每条流在内存里留 64 KiB（截断时保留尾部，而第一条错误才是原因），被截断时从写出到磁盘的文件限量读回 4 KiB 开头；单个会话最多记录 500 个编辑文件，超出后按插入顺序淘汰并 warn。

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

命名空间 `quality-gate` 就是设置条目 id；投影到设置表单上的就是那几个 `.volatile()` 字段。

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；关掉之后回合结束时不再核验 |
| `maxInjectsPerTurn` | natural，1–5 | `2` | 修复指令的注入次数上限，按会话跨回合累计 |
| `gateBudgetMs` | natural，10000–600000 | `300000` | 所有门禁的总时长上限；超时按"未执行"注入说明，静默放行不会发生 |
| `memoryFeedback` | boolean | `false` | 是否把代码类失败另外写进记忆网关 |
| `memoryGatewayUrl` | string | `""`（未配置） | 网关基址；设置值优先，留空时改用环境变量 `TDAI_GATEWAY_URL` |
| `memoryGatewayKeyRef` | string（凭据引用名） | `TDAI_GATEWAY_KEY` | 网关密钥的引用名；值走宿主凭据服务，不写进设置 |
| `maxRootDepth` | natural | `10` | 向上找项目根的最大层数（部署值，卡上没有这一行） |
| `gateStdoutMaxBytes` | natural | `65536` | 每条流的证据捕获上限（部署值，卡上没有这一行） |

设置持久化在 dsh 数据目录的宿主设置文件里；卡的保存语义见「在 dsh 里启用」。

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 对外接口

- **没有 HTTP 接口**：本包不注册任何路由或端点，也没有供外部调用的接口。
- **对宿主**：settings 命名空间 `quality-gate` 是隐式注册的（命名空间 = 条目 id，可编辑字段由 `Config` 上标了 `.volatile()` 的项决定，不再有 `settings.register`）；schema 和注册行的 `config` 共用同一份 `Config`。页面策略声明为 `auto: false`——本包自带卡片，别让宿主再生成一份自动表单。
- **注入的 followup**：`role: "user"`、`source: { kind: "plugin:quality-gate" }`、id 是 `quality-gate-` 开头加一个 UUID。
- **注入给模型的文案只有四类**，统一带 `[quality-gate]` 开头与命令、项目根的上下文：修复指令；门禁"未能执行"的说明（里面带上时间预算不够而未执行的清单）；次数用完之后的放行说明。
- **日志**走宿主的具名 logger（`info` / `warn` / `error` 三个方法），那个服务不存在时才用 `console`。
- **语言**：host 侧的文案跟随官方 settings 的 `locale` 偏好，没注册时用中文，改语言下一回合生效；卡片文案走官方 client locale，切换语言由宿主重新渲染，不用重新加载页面。
- **对总线**（装了 lesson-loop 时）：`report({ source: "quality-gate", category: "gate-failure" | "gate-not-run", cwd, sessionId, turn, signature: 命令串, detail: 全文证据, evidence: { root, command, kind } })`。总线不存在时报告直接丢弃，门禁照常运行；`memoryFeedback` 开关不影响总线上报。
- **可选的对外发送**：向 `memoryGatewayUrl` 发 `POST /v2/conversation/add`，超时上限 5 秒。请求头带 Bearer 令牌和 `x-tdai-service-id`（环境变量 `TDAI_SERVICE_ID` 可以覆盖，默认 `default`）；body 是 `session_id: "dsh-agent"` 加一条 `assistant` 消息，`agent_id` 取会话 cwd 的尾目录名加 8 位 sha256 前缀（和 lesson-loop 的项目键用同一个生成函数）。

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

| 项目 | 内容 |
| --- | --- |
| 默认不对外发送 | `memoryFeedback` 关闭加地址为空是两道保险，任何一个为空都不推送、也不去查凭据 |
| 发出去的内容 | 开启后只把命令、项目根和全文报错（折成一行、不截断）发往**你自己配置的**网关 |
| 地址与凭据安全 | 凭据只发 `https` 或回环地址（`127.0.0.0/8`、IPv6 回环、`localhost`）；其中 `localhost` 依赖本机的 hosts 和 DNS，是有意留下的例外——hosts 被指向远端时凭据就会发往远端。明文 `http` 的非回环地址按未配置拒绝并说明原因。地址解析不出合法的 `http(s)` URL 同样按未配置处理；带 userinfo 的地址一律拒绝 |
| 密钥 | 值由宿主凭据服务持有（`$DSH_HOME` 下的凭据文件），设置里只存引用名；引用名不符合 POSIX 变量名语法就按未配置处理 |
| 失败处理 | 推送失败只 warn、绝不阻断回合结束：配置缺失或地址不安全的说明，每次装载只说一次；HTTP 非 2xx、超时和发送异常则每次失败各记一条（这几种不该被去重掩盖） |
| 读文件 | 清单是否存在、根 `package.json` 的 scripts、`pyproject.toml` 的段头、被截断后写到磁盘上的文件的开头；不写任何文件、不遥测 |
| 内存 | 会话级的记录（编辑记录、注入次数、事件游标）都在进程内存里，插件卸载就清空 |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

- **白名单只有四条命令，不能经设置扩展。** 用别的检查器（`go test`、`mypy`、`eslint`…）的根得不到门禁。
- **只记成功的编辑**，而且只认 `edit` / `write` / `str_replace_editor` / `apply_patch` 的写入（`view` 是只读，不算）。多文件的 `apply_patch` 按每个操作的目标分别记录，move 的源和目的都算。结算身份为审批被拒或派发前取消的调用不记录（工具没执行，文件一定没变）；已派发后中止的调用保守记录（写可能已落盘，宁可多检查一次）。扩展名白名单之外的文件（md/txt/图片/`.sh`）不计——没有一条门禁命令能校验它们，而 `.sh` 会把项目根解析到别的地方，跑出假失败。
- **同树的具名子代理会被纳入检查**：空闲/冷子代理的编辑台账经 `sessionQuery.inspectSession` 并入父会话这一轮，失败文案会点名改过该根的子代理；有队友仍在执行回合时本轮**推迟**（工作树正被并发写），等队友完成开启的下一回合再检查。out-of-process 子代理（ACP / claude-code / codex）不发 dsh 事件、也不共享这棵工作树，仍在检查范围之外。
- **不抢话**：收件箱已经有待处理消息、回合信号已取消，或者插件已卸载时不注入。plan mode 不豁免——规划回合改了代码，回合结束时同样检查。
- **证据被截断且磁盘上没有那份文件时，第一条错误可能已经随截断丢掉了**；文案会如实说明证据不完整，不假装完整。
- **沙箱策略解析失败时一条都不执行**（按未执行注入），绝不退到部署级策略——那会让检查写到沙箱外面被拒绝，产出一条假的失败指令。

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 常见问题

| 问题 | 回答 |
| --- | --- |
| pnpm 工程为什么没跑 `pnpm check`？ | 根必须同时有 `pnpm-workspace.yaml` 与 `package.json`，且根 scripts 声明了非空 `check` 脚本；缺 `pnpm-workspace.yaml` 时按下一候选判（非 workspace 根可能落到 `tsc` / `ruff` / `cargo`），而 workspace 根没声明 `check` 时一条门禁都不发（solution-style tsconfig 会让 `tsc` 总是通过）。刻意取舍：假失败比漏检查更贵 |
|门禁说"未能执行"，是代码错了吗？ | 不是。沙箱策略拒绝、runner 起不来、超时、取消、时间预算不够，以及 stderr **点到门禁命令本身**（工具没装）的 exit 126/127 都属于这一类。注入的文案明确要求**不要为此修改代码**，并以 `gate-not-run` 单独报给总线。如果 126/127 来自你自己的 `check` 脚本内部，那是代码失败，按代码失败上报 |
| 会不会无限修下去？ | 次数用完之后注入一次用户可见的放行说明并停止自动修复，直到某一次全部干净通过才重新计数 |
| 想临时停掉？ | 在设置卡里关 `enabled`，或者 `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate` |
| `tsc` 用哪个版本？ | 工程自己装的那份优先，其次是随包安装的 `typescript`，两份都没有才用 PATH 上的——从不通过 `npx` 下载 |
| 子代理改的代码呢？ | in-process 子代理的回合同样跳过检查，它们的编辑记在各自会话的记录里、不进入父会话的记录——当前不保证由父会话核验（可能漏检）；out-of-process 子代理不发 dsh 事件，天然不在检查范围内 |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install
pnpm run check   # typecheck（四个 tsconfig）→ lint → client 构建 → host 构建 → 测试（含覆盖率）→ tarball 核对 → 格式
```

- 覆盖率统计 `host.ts`、`lib/**` 和 `src/ui-messages.ts`，四项阈值 100%。字典是纯数据、`test/client-card.test.ts` 不用浏览器就能跑满它，算进统计范围才能让阈值真的管住它；`client-entry.ts` 不算进来——它的主要内容是界面渲染，需要 DOM 环境才能测，本包刻意不引 `react-dom` 和 `jsdom`，整个算进来会让阈值一直不通过。
- `test/publish-manifest.test.ts` 钉住发布形态：入口可解析、`@deepseek-ai/*` 不进 `dependencies`、产物内容里没有日期和本机路径，注释与文档也一起被它扫描。`test/dist-size.test.ts` 核对两个产物的体积上限；`check:pack` 对 `pnpm pack` 的真实 tarball 做核对。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可

MIT。源码在 [github.com/JayYuen666/dsh-quality-gate](https://github.com/JayYuen666/dsh-quality-gate)。

机制上移植自 ECC（MIT，© Affaan Mustafa）——回合结束时跑项目自己的检查，以及编辑记录这两处机制。[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 记录上游来源、本包在它之上做了什么，以及运行期依赖的边界。
