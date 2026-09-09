# Multica 架构与展示差距审查

审查日期：2026-09-07。参照仓库：[multica-ai/multica](https://github.com/multica-ai/multica)，源码固定在 `7a438bd5b8bf39afd54259a7eb0971390e50a8ef`。本文件保留迁移前审查依据，并记录 0.2.0 的界面迁移与 0.3.0 的项目/执行契约调整。

## 0.3.0 功能模型更新

0.3.0 的重点是项目和执行语义：以现有文件夹接入项目，并选择默认原生 CLI。每个项目拥有一个功能看板，频道只表示持续职责和事项来源。同项目频道可继续已有事项；事项保留首次来源、参与频道、稳定编号和版本，运行期间的旧建议不会覆盖较新的人工修改。

项目、频道、事项、操作审计、运行及其输入输出保存在 SQLite。新增项目/事项级事件分页、完整运行详情和原始输出分页；UI 从真实持久记录显示变更前后值，不从当前快照推造历史。公开输出块保持不可变，可能跨分块的令牌前缀先保存在私有待定记录，确认后才进入公开游标流。已有数据按原 ID 幂等迁移，不自动合并事项，也不补造旧记录未保存的模型、权限或审计内容。

原生 CLI 负责会话、模型交互、工具执行和自身历史，Morrow 负责编排下一轮工作、预算、暂停和结果展示。Codex/Trae 保留原生配置、规则和技能加载，同时仍施加显式沙箱与审批边界。Claude 不再强制 JSON Schema，但仍使用 safe/restricted、空 MCP 配置和受限文件工具，不能声称完整继承其自定义配置或支持 Bash 测试执行。

回复采用正常 Markdown，可附加 `morrow-report` 看板报告。CLI 正常退出但报告缺失或无效仍是执行完成；报告状态独立记录，不生成虚构事项。暂停与恢复保留确切的原生会话 ID。本机原生终端交接要求项目所有频道已暂停且无活动执行，先持久化交接意图，再由主进程打开；原生终端后续 I/O 不会实时回传 Morrow。

因此这轮不只是界面换皮，也没有引入 Multica 的平台或替代原生 CLI。当前仍采用间隔调度和本地 Node/SQLite 服务，不包含文件变更触发器、实时自定义聊天、平台级负责人/协作或外部动作审批。完整字段、兼容规则和接口见 [contract.md](contract.md)。本节只说明实现契约，不作为 0.3.0 安装或原生窗口验收完成的声明。

## 0.2.0 界面迁移记录（历史）

桌面界面已从 SwiftUI 迁移到 Electron + React + TypeScript，使用 electron-vite 构建和 electron-builder 打包。与 Multica 相似的部分现在包括桌面技术栈，以及共用样式变量、基础控件、功能页面和视图状态的分层方式。Morrow 仍是面向长期 Channel 的本地工作台，执行服务保留 Node + SQLite，没有引入 Multica 的 Go/PostgreSQL 平台。

```text
React 界面（desktop/renderer）
  → 业务 API（desktop/shared/types.ts）
  → 隔离 preload（desktop/preload）
  → Electron 主进程（desktop/main）
  → 本机 HTTP 或 SSH 隧道
  → 独立 Node + SQLite daemon（service）
  → 已安装并登录的 Codex / Claude / Trae CLI
```

| 层次 | 当前 Morrow 实现 |
| --- | --- |
| 界面规范 | `styles/tokens.css`、`ui.css`、`shell.css`；Inter 字体、中文系统回退、Geist Mono 与 Lucide 图标 |
| 基础控件 | `components/ui.tsx`；共用按钮、菜单、对话框、状态、Markdown，部分交互基于 Radix |
| 功能页面 | `features/ProjectView.tsx` 的状态分组列表/看板与筛选；`FindingView.tsx` 主区详情；Channel、Runs、Runtimes 页面 |
| 执行内容 | `EventLog.tsx` 与 `eventPresentation.ts` 显示 Markdown、代码、工具输入/输出；兼容旧文本事件 |
| 导航与偏好 | `state/navigation.ts` 保存资源标签及前进/后退历史；保存列表偏好、侧栏尺寸和显隐状态 |
| 状态同步 | `state/workspace.tsx` 每两秒获取快照，修改后刷新；历史事件通过分页接口加载 |
| 本地边界 | `main/index.ts`、`connection.ts` 与 preload 验证业务 IPC，主进程持有 token，复用正在运行的 daemon |

界面与应用图标独立实现，没有复制 Multica UI 源码、品牌或产品截图资产。Inter、Geist Mono、Lucide、Radix 等通用依赖通过 npm 安装，其使用不等于复用 Multica 页面。旧 SwiftUI 代码保留为 `scripts/build-swiftui.sh` 的独立构建，默认 `scripts/build-app.sh` 现在生成 Electron 应用。

数据迁移沿用同一 workspace.sqlite、token 与 runs 目录；新主进程可导入旧 Swift 客户端的连接偏好。服务不随 UI 升级自动重启，连接旧 daemon 时仅在其快照范围内回退读取事件。详细边界见 [contract.md](contract.md)。SSH 输入校验及连接逻辑已有代码与隔离测试覆盖，当前没有真实远程主机联调结论。

技术栈迁移不代表功能或视觉完全等同于 Multica。Morrow 没有相同的平台协作、任务负责人、附件、React Query/Zustand 状态层或 WebSocket 推送；不会用不存在的数据补齐展示。最终界面质量仍需要原生窗口截图及实际交互验收，不能仅以打包通过作为依据。

以下是保留的 **0.1 SwiftUI 版本迁移前审查**，用于解释重建界面层的原因，不描述当前默认应用。

## 迁移前结论

0.1 版 Morrow 与 Multica 只有“桌面工作台控制独立 Agent 执行进程”的概念相似。当时 Morrow 是独立编写的 SwiftUI 应用，没有采用或复用 Multica 的 React 页面、基础组件与视图状态体系。此前的修改改善了三栏布局和信息密度，但不能称为完成了 Multica 的展示与交互对齐。

SwiftUI 并非无法实现这些效果。当前差距来自最初选择以轻量原生原型为目标，以及对组件、内容展示和交互状态实现得不够完整。迁移框架本身也不保证设计质量。

## 迁移前架构

| 层次 | Multica | Morrow 0.1 |
| --- | --- | --- |
| 桌面 | Electron、React、electron-vite | SwiftUI、SwiftPM |
| 界面组织 | Desktop/Web 共享 `packages/ui`、`packages/views`、`packages/core` | 各 SwiftUI 页面，少量共用控件与颜色 |
| 样式 | Tailwind、统一设计变量、Inter/CJK 字体栈、Lucide 图标 | 系统字体、SF Symbols、手写尺寸和样式 |
| 数据更新 | React Query、Zustand、平台事件 | AppStore、每两秒获取工作区快照 |
| 服务与执行 | Go 平台 API / WebSocket、PostgreSQL、连接平台的执行 daemon | 本机 Node HTTP 服务、SQLite、直接调度 CLI；远程走 SSH 隧道 |

源文件：[桌面依赖](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/apps/desktop/package.json)、[整体架构](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/README.md#architecture)。本地实现见 `Package.swift`、`Sources/Morrow/AppStore.swift`、`service/server.ts`。

## 迁移前三个主要差距

1. **视觉规范不完整。** Multica 为字号、行高、背景层级、选中态、悬停态、阴影、深浅主题建立了共用变量。Morrow 的 `Theme.swift` 仍以颜色和少量控件为主，页面内直接指定字号与间距，系统控件与手写控件混用。参照：[设计变量](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/packages/ui/styles/tokens.css)、[桌面字体](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/apps/desktop/src/renderer/src/globals.css)。

2. **列表可展示和操作的信息较少。** Multica 的任务行统一展示编号、状态、执行活动、标签、负责人和进度，并提供选择、菜单、拖动及可配置视图。Morrow 主要提供标题、类型、频道、引擎和证据数量；列表/看板状态仍局限于页面。需要按 Morrow 自身数据补齐有意义的展示，不能添加不存在的负责人、进度或伪造运行信息。参照：[任务界面](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/packages/views/issues/surface/issue-surface.tsx)、[列表行](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/packages/views/issues/components/list-row.tsx)。

3. **阅读与导航空间不足。** Multica 提供主内容区详情、富文本、附件和执行时间线，标签保存资源会话与历史，侧栏支持调整大小。Morrow 把发现说明、证据和下一步集中在 250pt 检查器中；顶部是项目切换，日志主要是普通文本。因此长结果难读，切换工作上下文的体验也较弱。参照：[任务详情](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/packages/views/issues/components/issue-detail.tsx)、[桌面标签状态](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/apps/desktop/src/renderer/src/stores/tab-store.ts)。

## 当时建议的迁移方向

如果以接近 Multica 的展示与交互为优先目标，建议采用 Electron + React 重建界面层，并按“设计变量 → 基础控件 → 工作区布局 → 列表/详情/执行内容 → 视图状态”组织实现。继续保留 Morrow 的长期 Channel、知识与证据模型，以及当前 Node/SQLite 执行服务。

最小适配是在 Electron 主进程负责服务启动、HTTP 请求、令牌与 SSH；preload 只暴露明确的业务操作给 React。当前服务拒绝浏览器 Origin，不能把 renderer 直接 fetch 当成接入方案，也不应把令牌放进页面或 localStorage。初期可继续使用快照更新，随后再按实际流式展示需求添加增量事件。

界面验收应包括：项目列表；可读的主区发现详情；Markdown、代码与执行事件分层展示；可调整属性栏；筛选/分组/视图状态保存；键盘导航；有内容、空状态、加载中和失败状态。以实际同屏对照与交互验证验收，不能只凭构建成功判断完成。

执行轨迹还需要协议层的补充：Morrow 的事件主要是 `kind` 与文本，Multica 事件协议含序号、工具、输入与输出等结构。要实现逐步工具轨迹，需在现有服务上增加结构化事件和增量/历史读取，而非只改变日志的字体。参照：[Multica 事件协议](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/server/pkg/protocol/messages.go)。

不需要为界面迁移同时引入 Multica 的 Go/PostgreSQL 平台。Multica 的 workspace、issue、agent、autopilot 与 Morrow 的 project、channel、work item、run 语义不同，原有业务页面不能通过字段改名直接接上。

## 源码复用边界

当前 [Multica LICENSE](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/LICENSE) 包含 Apache 2.0 之外的附加条款，涉及基于其 UI 代码的品牌保留以及商业嵌入等。采用同类通用技术栈与直接复制其 UI 源码是两种不同方案。上述建议为独立实现 Morrow 界面；如后续选择直接复用 Multica 代码，需按完整许可证处理对应品牌、归属与分发条件。

最初审查阶段仅检出参照仓库并记录方案。随后经用户授权完成 0.2.0 的 Electron 界面迁移，保留独立执行服务；0.3.0 再将事项归属调整到项目，并扩充原生执行和持久记录契约，具体变化见本文开头。
