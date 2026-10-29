# Third-party notices

本包自身编写的代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。本文件记录**机制来源**与
**运行期依赖**：本包的哪一部分来自第三方、在什么意义上「来自」，以及本包自身代码与第三方代码
的边界在哪里。

## 机制来源：ECC（Everything Claude Code）

- 上游项目：`ECC`（Everything Claude Code）
- 上游仓库：https://github.com/affaan-m/ECC
- 上游许可：MIT，版权归 Affaan Mustafa 所有
- 上游机制名：`stop-format-typecheck`（回合收口跑项目自己的检查）、`post-edit-accumulator`
  （编辑记账）

### 移植的是什么

**机制与设计思路**，两处：

1. **回合收口跑项目声明的检查**（`host.ts` 的 `agent/turn-stopping` 批处理、
   `lib/gate-detect.ts` 按清单根择一）——收口时按项目形态运行它自己声明的检查命令，失败则把
   报错回给模型。
2. **编辑记账**（`lib/accumulator.ts`）——不逐文件跑检查（太贵），而是回合收口时一次算总账：
   本轮编辑过的代码/配置文件按插入序累计，容量到上限按插入序淘汰。

### 本包在其之上加了什么

上游是「一条 hook 命令」的形状，本包是跑在 dsh 宿主里的常驻插件，两者不等价：

| 维度 | 上游 ECC | 本包 |
| --- | --- | --- |
| 结论形状 | 退出码二值 | 显式三态 `pass` / `code-failure` / `not-run`，没真正跑完的检查永不记为通过 |
| 失败处理 | 回显给人 | 经 `agent.followup` 开新回合注入修复指令，带跨回合配额与放行说明 |
| 预算 | 无 | 会话总预算封顶、按根分摊、尾段不足则注入「未执行」清单 |
| 证据 | 直接回显 | 每条流有内存上限，截断时从落盘文件有界读回**头部**（首条错误才是根因） |
| 项目定位 | 当前工作目录 | 从编辑路径向上找最近清单根（monorepo 子包升到工作区根），多根各自择一 |
| 沙箱 | 不涉及 | 按会话解析沙箱策略后执行；策略拒绝与 runner 失败归 `not-run`，不污染记忆与自进化闭环 |
| 语言 | 单语 | 注入文案与设置卡中英双语，随宿主 locale 偏好 |

没有复制上游的任何一行实现代码：`host.ts` / `lib/*.ts` 全部为本包编写，语言、结构、错误处理
都与上游不同。

## 运行期依赖

本包产物（`host.js`、`client.js`）把依赖**外部化**：产物里保留裸说明符，运行时解析到宿主
profile 里那一份实例，因此不存在"把第三方源码打进发布物"的情形，本文件也就不需要附各包的
许可证全文。

- `@jayyuen66/dsh-plugin-shared`（MIT）——普通依赖。`lib/locale`、`lib/tool-events`、
  `lib/lesson-bus`、`lib/record`、`lib/project-key` 五个子路径来自它。
- `zod`（MIT）——普通依赖。`lib/edit-ledger.ts` 的投影状态与 `src/client-entry.ts` 的设置卡
  值面/草稿面用它做形状校验；client 产物按宿主 `PLATFORM_MODULES` 保持 `require("zod")` 外部化。
- `typescript`（Apache-2.0）——普通依赖，`tsc` 门禁的兜底入口。
- `@deepseek-ai/*`（一律 MIT，由宿主提供，声明为 peer / devDependency，**不进** `dependencies`）
  ——`dsh`、`cordis`、`schemastery`、`dsh-settings`、`dsh-shell`、`dsh-sandbox`、
  `dsh-sandbox-policy`、`dsh-session`、`dsh-session-query`、`dsh-session-projection`、
  `dsh-session-title`、`dsh-agent`、`dsh-llm`、`dsh-credentials`、`dsh-scope`、
  `dsh-subprocess`、`dsh-package-manifest`、`dsh-api-remotes`、`dsh-client-locale`、
  `dsh-client-store`、`dsh-client-ui-layout`、`dsh-client-ui-plugin-manager`、
  `dsh-client-ui-renderer`、`dsh-client-ui-settings`、`dsh-client-ui-slots`。
  除 `dsh-credentials`（值导入 `credentialRef` / `isCredentialRefName`）与 `schemastery`
  （值导入 `Schema`）之外，其余都只作类型消费。

依赖形状由 `test/publish-manifest.test.ts` 钉住：`@deepseek-ai/*` 出现在 `dependencies` 即失败
——那会在消费方 profile 里物化出第二份宿主类型面。
