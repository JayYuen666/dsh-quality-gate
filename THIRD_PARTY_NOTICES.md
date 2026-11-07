# Third-party notices

本包自己编写的代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。本文件记录**机制来源**与
**运行期依赖**：本包的哪一部分来自第三方、在什么意义上"来自"，以及本包自己的代码与第三方代码
的边界在哪里。

## 机制来源：ECC（Everything Claude Code）

- 上游项目：`ECC`（Everything Claude Code）
- 上游仓库：https://github.com/affaan-m/ECC
- 上游许可：MIT，版权归 Affaan Mustafa 所有
- 上游机制名：`stop-format-typecheck`（回合结束时跑项目自己的检查）、`post-edit-accumulator`
  （记录编辑过的文件）

### 移植的是什么

**机制与设计思路**，两处：

1. **回合结束时跑项目声明的检查**（`host.ts` 里 `agent/turn-stopping` 的批处理、
   `lib/gate-detect.ts` 按清单根择一）——回合结束时按项目形态运行它自己声明的检查命令，失败就把
   报错送回给模型。
2. **记录编辑过的文件**（`lib/accumulator.ts`）——不每改一个文件就跑一次检查（太慢），而是等到回合
   结束时一次跑完：这一轮编辑过的代码和配置文件按插入顺序累计，到了数量上限就按插入顺序淘汰最早的。

### 本包在它之上加了什么

上游是"一条 hook 命令"的形态，本包是跑在 dsh 宿主里的常驻插件，两者不等价：

| 方面 | 上游 ECC | 本包 |
| --- | --- | --- |
| 结论的形态 | 退出码两种 | 显式三种 `pass` / `code-failure` / `not-run`，没真正跑完的检查永远不会被记为通过 |
| 失败怎么处理 | 显示给人 | 经 `agent.followup` 开新回合注入修复指令，带跨回合的次数上限和放行说明 |
| 时间预算 | 无 | 会话总时长有上限、按项目根分摊、剩下的时间不够就注入"未执行"清单 |
| 证据 | 直接回显 | 每条流都有内存上限，被截断时从写到磁盘的文件限量读回**开头**（第一条错误才是原因所在） |
| 项目定位 | 当前工作目录 | 从编辑过的文件向上找最近的清单根（monorepo 子包升到工作区根），多个根各自择一 |
| 沙箱 | 不涉及 | 按会话解析沙箱策略之后执行；策略拒绝和 runner 失败算 `not-run`，不会把环境或策略问题当成代码缺陷写进记忆、也不报给 lesson-loop |
| 语言 | 单语 | 注入文案和设置卡都有中英两套，跟随宿主的 locale 偏好 |

没有复制上游的任何一行实现代码：`host.ts` 和 `lib/*.ts` 全部由本包编写，语言、结构和错误处理
都与上游不同。

## 运行期依赖

本包的产物（`host.js`、`client.js`）把依赖**外部化**：产物里保留裸说明符，运行时解析到宿主
profile 里的那一份实例，所以不存在"把第三方源码打进发布包"的情形，本文件也就不需要附各包的
许可证全文。

- `@jayyuen66/dsh-plugin-shared`（MIT）——普通依赖。`lib/locale`、`lib/tool-events`、
  `lib/lesson-bus`、`lib/record`、`lib/project-key` 五个子路径来自它。
- `zod`（MIT）——普通依赖。`lib/edit-ledger.ts` 的投影状态和 `src/client-entry.ts` 设置卡里
  已保存的值与待保存的草稿都用它校验形状；client 产物按宿主的 `PLATFORM_MODULES` 保持 `require("zod")` 外部化。
- `typescript`（Apache-2.0）——普通依赖，`tsc` 这条门禁的兜底入口。
- `@deepseek-ai/*`（一律 MIT，由宿主提供，声明为 peer / devDependency，**不进** `dependencies`）
  ——`dsh`、`cordis`、`schemastery`、`dsh-settings`、`dsh-shell`、`dsh-sandbox`、
  `dsh-sandbox-policy`、`dsh-session`、`dsh-session-query`、`dsh-session-projection`、
  `dsh-session-title`、`dsh-agent`、`dsh-llm`、`dsh-credentials`、`dsh-scope`、
  `dsh-subprocess`、`dsh-package-manifest`、`dsh-api-remotes`、`dsh-client-locale`、
  `dsh-client-store`、`dsh-client-ui-layout`、`dsh-client-ui-plugin-manager`、
  `dsh-client-ui-renderer`、`dsh-client-ui-settings`、`dsh-client-ui-slots`。
  除了 `dsh-credentials`（值导入 `credentialRef` 和 `isCredentialRefName`）与 `schemastery`
  （值导入 `Schema`）之外，其余都只用来取类型。

依赖的形状由 `test/publish-manifest.test.ts` 钉住：`@deepseek-ai/*` 出现在 `dependencies` 就判失败
——那会让使用者自己的 profile 里再装一份宿主的实现，和正在运行的宿主并存。
