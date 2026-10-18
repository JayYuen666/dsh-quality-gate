# @jayyuen66/dsh-quality-gate

[English](./README.md)

### 它做什么

- 回合收口质量门禁：本轮改过代码/配置文件时，在回合收口前自动跑该项目自己声明的检查命令；不通过就经 `agent.followup` 开新回合、把修复指令注入给模型。
- 一次检查只有三种结论：`pass`（真的跑完且 exit 0）、`code-failure`（跑了且报代码错）、`not-run`（没跑成）。一条没真正跑完的检查绝不会被记成通过。
- 它不改代码、不拦截危险命令（那是 danger-guard 的职责）、也不写任何文件。

### 触发时机与不触发条件

- 触发点：宿主事件 `agent/turn-stopping`。流程是读增量事件窗 → 取本会话**成功**的编辑 → 每个文件向上找最近清单根 → 探测门禁 → 执行。
  - 编辑口径：`edit` / `write` / `str_replace_editor` 的写入；`view` 只读不算。
  - 清单根：最多向上找 10 层；monorepo 子包升到 `pnpm-workspace.yaml` 所在的工作区根——但只在该根**产得出门禁**时升级，否则保留子包自己的根（外层没有 `check` 脚本的 workspace 不得吃掉子包的 `tsc` / `ruff` 门禁）。
- 不触发：
  - `enabled: false`；本回合没有可检编辑（只改 md/txt/图片/`.sh`，或被拒、执行失败的编辑）。
  - 子代理会话（`origin === "subagent"` 或 `delegationDepth > 0`）；inbox 已有待处理消息（不抢话）。
  - 探测不出门禁的根；回合 signal 已取消或插件已卸载。
- 宿主没有 shell 服务时 warn 一次并放行；plan mode 不豁免——规划回合改了代码同样收口。

### 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-quality-gate
```

- 包在公共 npm（`registry.npmjs.org`）上，安装侧不需要凭据。
- 宿主需 `@deepseek-ai/dsh` 0.2.1-rc.2 起（`engines.dsh`）：本包按这一版宿主的类型面编译。
- 运行时依赖 `@jayyuen66/dsh-plugin-shared` 必须已在同一 registry 上，否则整组 404。
- `@deepseek-ai/schemastery` 由宿主解析、不由本包安装：只有宿主 fork 的那一枚能把 `.volatile()` 字段解析成活引用，换成公共 `schemastery` 就变成改设置要重启才生效。
- 本地目录形态安装需 pnpm ≥ 12.3.0（12.0.0 的本地目录 `add` 有已知缺陷）。

### 在 dsh 里启用

- 装载由包内 `cordis.patch.yml` 负责（`package.json` 的 `dsh.bundle.patch` 指向它），插一行 `- id: quality-gate`、`name` 为本包名；`dsh plugin --profile web add/remove` 维护该行。
- Host 半只硬依赖宿主的 `settings`（`default.inject = ["settings"]`）；`shell` / `sandboxPolicy` / `lessonLoop` / `credentials` / `sessionQuery` 一律 `ctx.get` 可选读，缺失不会让插件加载失败。
- 优先级：设置卡的运行时值 > 该行 `config:` > 包内置默认。client 半（`dsh.client.platform = web`、`immediately: true`）往插件管理页的 `plugins.bundle.config` 槽注入一张卡（key = 本包名；`configForms.get()` 与 settings 命名空间用的是裸条目 id `quality-gate`）。
- 卡的保存是显式的：改动先留在本地暂存，点「保存」才逐键写 settings（状态条提示「有未保存的修改，点「保存」生效」）。
  - 写入通道把 `Promise<boolean>` 受理位原样交给卡片——首个 `false` 即停手、显示 `saveRejected` 那行并保留未落盘的改动（吞掉受理位会让宿主拒写时卡仍显示已保存）；写入 reject 显示 `saveFailed`，「撤销」丢弃暂存。

### 设置的检查命令

四条白名单命令在类型层锁死（只有这四条能进执行面），每根择一，优先级 workspace > Rust > Python > 裸 TS：

- `pnpm check`：根同时有 `pnpm-workspace.yaml` 与 `package.json`，且根 scripts 声明了非空 `check`；没声明就退回下一候选——宁可不给门禁，也不替项目发明一条稳定假失败的命令。
- `cargo check`（`Cargo.toml`）、`ruff check .`（`pyproject.toml` 或 `ruff.toml`）、`npx tsc --noEmit`（`package.json` + `tsconfig.json`，缺 `tsconfig.json` 不算 TS 项目）。
- 预算与并发：总预算 `gateBudgetMs` 封顶，每根取 `max(10s, 预算/根数)` 与实际剩余的小值。
  - 剩余不足 5s 的尾段不再起跑，按「未执行」注入清单。
  - 门禁顺序执行，一次只注入一个失败。
- 证据上限：每条流内存留存 64 KiB，被截断时从落盘文件有界读回 4 KiB 头部（首条错误才是根因）；单会话编辑记账 500 个文件，超出按插入序淘汰并 warn。

### 设置项

- `enabled`：boolean，默认 `true`。关掉即收口不再核验。
- `maxInjectsPerTurn`：1–5，默认 `2`。修复指令注入配额，按会话跨回合累计。
- `gateBudgetMs`：10000–600000，默认 `300000`。超时按失败注入，不静默放行。
- `memoryFeedback`：boolean，默认 `false`。是否把代码型失败额外沉淀到记忆网关。
- `memoryGatewayUrl`：string，默认空 = 不启用；设置值优先，留空回落 env `TDAI_GATEWAY_URL`。
- `memoryGatewayKeyRef`：string（凭据引用名），默认 `TDAI_GATEWAY_KEY`；设置里只存引用名。
- 另有两枚非 volatile 的部署值：设置卡上没有它们的行，只在注册行的 `config:` 上给（cordis 交进 apply 的是值而非引用，改值随重启生效）。
  - `maxRootDepth` 默认 `10`——「最多向上找 10 层」说的就是它；`gateStdoutMaxBytes` 默认 `65536`——「每条流内存留存 64 KiB」说的就是它。

### 对外接口

- 无 HTTP 面：本包不注册任何路由或端点，也没有供外部调用的接口。
- 对宿主：settings 命名空间 `quality-gate` 是 0.1.7 的隐式注册（= 条目 id，可编辑字段由条目 `Config` 上标了 `.volatile()` 的项决定，本包不再调 `settings.register`），schema 与行 `config` 共用同一份 `Config`。
  - 只剩页面策略要声明：`svc.inject(["settings"], …)` 的子上下文里 `settings.configure({ auto: false }, svc.fiber)`——本包自带卡片，别让宿主再生成一份自动表单。
  - 注入的 followup 为 `role: "user"`、`source: { kind: "plugin:quality-gate" }`、id 为 `quality-gate-` 前缀加一个 UUID。
- 日志走宿主具名 logger（`ctx.logger("quality-gate")`，本包用的方法面是 `info` / `warn` / `error`），该服务缺席才回退 `console`。
- 注入给模型的文案只有四类，消息统一带 `[quality-gate]` 前缀与命令/根上下文：
  - 修复指令。
  - 门禁「未能执行」说明。
  - 配额耗尽后的放行说明。
  - 嵌在「未能执行」里的预算不足清单。
- 两语文案随官方 settings 命名空间 `locale` 的偏好，未注册即中文，改语言下一回合生效。
  - 卡片文案另走官方 client locale：`ctx.locale.register(NS, UI_MESSAGES)` 交字典、`ctx.locale.bind(NS)` 出取文案函数，切语言由宿主重渲染 slot、不必重载页面。
- 对总线：`ctx.get("lessonLoop")?.report({ source: "quality-gate", category: "gate-failure" | "gate-not-run", cwd, sessionId, turn, signature: 命令串, detail: 全文证据, evidence: { root, command, kind } })`。
- 可选外发：向 `memoryGatewayUrl` 配的地址发 `POST /v2/conversation/add`，5s 超时封顶。
  - 请求头带 Bearer 令牌与 `x-tdai-service-id`（env 可覆盖，默认 `default`）。
  - body 为 `session_id: "dsh-agent"` + 一条 `assistant` 消息，`agent_id` 取会话 cwd 的尾目录名加 8 位 sha256 前缀（与 lesson-loop 项目分桶同源）。

### 数据与隐私

- 默认零外发：`memoryFeedback` 关 + 地址空是双保险，任一为空都不推送、也不去查凭据。
- 开启后送出的只有命令、项目根与全文报错（不截断），落到你自配的网关。
  - 失败只 warn 且每次装载只说一次，绝不阻断收口。
  - 密钥值由宿主凭据服务持有（`$DSH_HOME` 下的凭据文件），引用名不合 POSIX 环境变量语法即视为未配置。
- 与 lesson-loop 的关系是**可选**的：总线缺失时报告直接丢弃，门禁照常运行；装了才多一份教训沉淀，`memoryFeedback` 开关不影响总线上报。
  - 本包只读盘（清单存在性、根 `package.json` 的 scripts、截断落盘文件的头部），不写文件、不遥测。

### 常见问题

- pnpm 工程为什么没跑 `pnpm check`？根 `package.json` 没声明非空 `check` 脚本，这是刻意取舍：假失败比漏检查更贵。
- 门禁说「未能执行」是代码错了吗？不是。
  - 沙箱策略拒绝、runner 起不来、超时、取消、exit 126/127、`npx` 抓到 stub 包、预算不足都属此类。
  - 注入文案明确要求「不要为此修改代码」，不写记忆，并以 `gate-not-run` 单独上报总线。
- 会不会无限修？配额耗尽后注入一次用户可见的「放行说明」并停止自动修复，直到某次全部干净通过才重新计数。
- 临时停掉：设置卡关 `enabled`，或 `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate`。
- 子代理改的代码呢？in-process 子代理跳过，由父会话下一回合统一核验。
  - out-of-process 子代理（ACP/claude-code/codex）不发 dsh 事件，天然不在门禁面面内。
- 许可 MIT，仓库见 `package.json` 的 `repository.url`。
