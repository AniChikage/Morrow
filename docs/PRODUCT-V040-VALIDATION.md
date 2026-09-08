# NoHuman 0.4.0 原生同步验收

2026-09-07，macOS Apple Silicon。保留用户已认可的灰白紧凑 Electron 界面。

## 双向同步实证

本轮连接正在运行的 Codex App 任务 `01a07725-b183-70d0-a9e3-2447b54f5f71`，在 NoHuman 项目的「系统完善」频道关联该任务。未启动独立 Codex CLI 会话。

- App 端输入和助手回复从原生历史进入 NoHuman，包含当前轮次的追加消息。
- 通过 NoHuman 服务发送 `NH-20260907-2` 后，消息实际进入当前 App 任务；收到 `SYNC-NOHUMAN-OK`。重连后用户消息只有一条，原生轮次与发件回执一致。
- 从已安装 App 的输入框发送 `NH-UI-20260907`，当前 App 任务实际收到并回复 `SYNC-UI-OK`。数据库中用户消息和对应确认回复各一条，回执为 accepted，附件数为零。
- 用应用自身图标验收本地图片选择、草稿预览和移除，没有将图片发给模型。

脱敏核对结果：[双向回执](../artifacts/product-v040/bidirectional-sync.json)、[安装版输入框实证](../artifacts/product-v040/installed-ui-sync.json)。完整原生消息、事件和图片记录留在用户的私有 SQLite 数据目录。

## 修复与覆盖

实机测试发现并修复了原生 `steeringUserMessage` 输入类型、原生 composer 恢复上下文、重复消息投影、项目页遗留 CLI 入口，以及长会话流式处理的重复全量复制。

流式原始补丁逐条落库；展示投影短窗口合并。检查点、结束、关闭和崩溃恢复测试确保完整历史可恢复。工具输出和原始记录在展开时渲染，折叠时不构建大段 Markdown 或原始 JSON。

自动测试覆盖原生 socket 分帧、所有增量、版本/连接错误、精确发送与中断、去重、未知回执核对、历史分页、原生运行归属、调度权限、图片持久化、崩溃重放及大输出折叠。测试使用独立数据库、假 CLI 和模拟原生 owner。

最终结果：TypeScript 检查通过，51 项服务测试和 130 项桌面测试全部通过；Electron 构建、安装后的签名校验通过。使用打包的 Node 24 运行服务测试。

1194 条真实历史的隔离回放中，10 个流式增量从 2552 ms 降至 2 ms；该增量时间不包含最终检查点写入，首次全量导入均约 672 ms。最终安装后的会话读取三次为 58、11、10 ms，同步服务 CPU 单次采样约 1.3%，不代表所有机器或负载。[回放基准](../artifacts/product-v040/native-sync-performance.json)。

## 安装与数据

安装位置为 `~/Applications/NoHuman.app`。升级前做 SQLite 在线备份并保留旧 App；核对原有 3 个项目、7 个频道、5 个看板事项、旧运行和事件全部保留。原生历史导入产生额外运行记录，未触发项目自动执行。

数据核对：[迁移记录](../artifacts/product-v040/installed-migration.json)。截图：[运行时](../artifacts/product-v040/installed-runtimes.jpg)、[图片草稿](../artifacts/product-v040/installed-image-draft.jpg)。

最终重启后仍连接同一原生任务与轮次，验收用户消息和回复各一条，所有原有记录保留。[最终安装状态](../artifacts/product-v040/final-install-state.json)、[最终对话界面](../artifacts/product-v040/installed-native-chat-final.jpg)。最终包为 `dist/NoHuman.app` 与 `dist/NoHuman.dmg`。

## 验收范围

实机覆盖本机现有任务的历史读取、活动轮次追加、双向文字、重连和安装。空闲任务的新轮次、审批问答、实际图片发送、自动职责完成与看板更新有协议/模拟回归，本轮未触发这些真实模型操作。

当前实现依赖安装版 Codex App 的私有本机 IPC；协议升级不兼容时显示连接错误并禁用发送。创建新任务需先打开 App 的项目输入框、发送首条消息，再回 NoHuman 关联。远程 App 同步及 App 专属功能不在本轮支持范围。构建为本机 ad-hoc 签名，跨设备正式分发仍需 Developer ID 和公证。
