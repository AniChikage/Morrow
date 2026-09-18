# Codex 两种连接方案实测：2026-09-09

结论：**增强 follower 的核心能力通过实测；直接共享官方后台只通过部分能力，尚不能作为保留完整 App 工具的替代方案。** 本次是连接可行性验证，没有修改生产适配器、调度器、安装版 Morrow 或启动项。

测试基线：Morrow `91cb90c`；ChatGPT App `26.903.61454`，build `8378`；App 内附官方 `codex-cli 0.153.4`。使用真实安装版 App、官方签名运行时和真实模型轮次。测试只涉及合成任务、临时文件和本机测试网页。可机读的脱敏结果见 [results.json](../artifacts/codex-connection-validation-20260909/results.json)。

## 结果对照

| 检查 | 增强 follower | 直接共享官方后台 |
| --- | --- | --- |
| 连接及执行轮次 | 通过；多个独立连接接续同一 App 任务 | 通过；独立 App 和诊断客户端连接同一 WebSocket 后台 |
| 新建任务 | 未实现、未验证 follower 创建接口 | 通过；第二客户端调用 `thread/start`，执行首轮后能列出和读取 |
| 本轮只读沙箱 | 通过；App 回传只读，真实文件写入报 `PermissionError` | 通过；`turn/start` 设置只读，真实文件写入被拒 |
| 工作区写入沙箱 | 通过范围内/范围外 canary 检查；最终目录会被 App 合并，见下文 | 本次未单独验证 |
| `approvalsReviewer=auto_review` | 参数被接受并反映到 App 生效状态；未触发实际审批决策 | 本次未单独验证 |
| 应用内浏览器 | 通过；读取随机 marker、真实点击按钮、读取对应结果 | 未通过；`Browser is not available: iab` |
| App 工具 `get_usage_limits` | 实际调用成功 | 任务工具中缺失 |
| Computer Use | `sky.list_apps()` 实际调用成功 | 同一只读调用成功 |

Computer Use 结果仅代表本次列举接口可用，不代表所有桌面交互已经验收。没有验证记忆抽取、长时间无人值守、重启恢复、并发手动输入、完整发布审批或所有动态工具。

## 增强 follower

测试任务由 App 创建，随后诊断脚本复用 `service/codex-desktop-transport.ts`，向实际 App IPC 发送 `thread-follower-start-turn`。生产代码仍保持原样；诊断脚本直接使用该 transport 的请求层验证额外字段。

关键请求结构如下，模型等其余设置沿用任务已有值：

```json
{
  "conversationId": "<test-thread-id>",
  "turnStart": {
    "request": {
      "threadId": "<test-thread-id>",
      "input": [{ "type": "text", "text": "<bounded test prompt>", "text_elements": [] }],
      "clientUserMessageId": "<stable test message id>",
      "approvalPolicy": "never",
      "approvalsReviewer": "user",
      "permissions": null,
      "sandboxPolicy": { "type": "readOnly", "networkAccess": false }
    },
    "context": {
      "inheritThreadSettings": true,
      "useAppServerPermissionDefault": false,
      "usePermissionSelection": false
    }
  }
}
```

该请求使用现有协议版本 `2`，发给实际发现的任务 owner。`permissions: null` 与显式沙箱配合，避免继续选择先前的命名权限配置。一次性诊断只操作空闲测试任务；不据此声称生产调度的并发控制已经完成。

只读测试第一次使用 heredoc，shell 在准备临时文件时就被拒绝，Python 尚未运行。随后改用 `python3 -c`，实际打开目标 canary 时收到 `PermissionError: [Errno 1] Operation not permitted`，外部检查确认文件不存在。两次结果分别保留其真实含义。

工作区测试传入 `workspaceWrite`、禁止网络、排除通用临时目录，并使用 `approvalPolicy=never`。一次 Python 调用在测试工作区内写入成功，在其外的隔离临时目录写入被拒；文件存在性与工具输出一致。该轮另指定 `approvalsReviewer=auto_review`，App 状态确实回传此值。由于审批策略为 `never`，这不是一次实际自动审批决策的验收。

**目录限制：App 会合并已有工作区和可视化目录。** 本次 projectless 测试任务的最终可写范围包含传入的测试目录、App 原有 projectless 根目录及任务可视化目录。因此，不能把传入的 `writableRoots` 当成最终完整目录清单，也不能仅凭这次范围外 canary 被拒，就宣称能够任意缩小至单个目录。生产接入应检查最终生效范围。

完整访问轮次进行了三个有界工具测试：

- 通过官方 Browser 接口选择 `iab`，打开本机合成页面，读取服务端随机生成的 marker，真实点击 `Run probe`，读取 `CLICK_OK:<marker>`。页面服务日志中的 marker 与浏览器结果一致；测试标签页随后关闭。
- 实际调用 App 的 `get_usage_limits`，原生工具记录为完成；脱敏产物不保存账户用量或账户标识。
- 通过官方 Computer Use 的 `sky.list_apps()` 返回条目数量。

各轮使用独立 follower 客户端重新连接同一任务，证明这些测试不依赖诊断进程持续持有连接。尚未测试 App 本身退出后的自动恢复。测试没有新增 follower 的任务创建能力。

## 直接共享官方后台

在独立临时 `CODEX_HOME` 中启动 App 内附的官方 `codex app-server --listen ws://127.0.0.1:<port>`；以独立 `CODEX_ELECTRON_USER_DATA_PATH` 启动另一份原签名 App 实例，并仅为该实例设置 `CODEX_APP_SERVER_WS_URL`。保留官方 CLI 路径，没有使用 Morrow 转接程序、全局 launchd 环境变量或 daemon 安装管理命令。

这证明普通前台 app-server 验证不必先安装另一份独立 CLI。它不代表 daemon 管理方式或远程部署已经验证。

App 日志确认 `transport=websocket`，初始化得到版本 `0.153.4`；诊断客户端能创建任务、开始模型轮次、读取实际结果及历史。只创建而未执行首轮的空任务在客户端断开后出现 `no rollout found`；另一个任务完成首轮后可正常列出和读取。不能把空任务的创建回执当作已经持久保存。

工具测试依次发现：

1. 初次直接运行：应用内浏览器不可用，App 用量工具缺失，Computer Use 列举成功。
2. App 恢复任务失败，明确报错 `failed to load configuration: invalid transport in mcp_servers.codex_app`。独立后台没有 App 通常在启动时注入的完整 MCP 启动配置。
3. 只在隔离配置中补入安装包的 `codex-app-tools/desktop-mcp.json` 定义、官方启动脚本和官方 Node 路径，连接隔离 App 自己的工具 socket。使用 App 常规的 `omit_tools_from=["deferred"]` 配置方式。再次测试仍缺少浏览器和 App 用量工具。
4. 在轮次结束后，仅重启隔离 App，并让它打开同一个已经持久化的测试任务。日志确认 `thread/resume` 成功，浏览器运行时路径仍为官方 CLI、Node 和 node_repl。后续第二客户端直接发起轮次，避免再以另一次无配置 `thread/resume` 干扰 App 准备状态；浏览器和 App 用量工具仍未通过。

最后一轮再由第二客户端传入只读沙箱，真实 canary 写入被拒，确认基本执行与权限接口可以使用。

隔离 App 日志中没有出现 `dynamic_app_tools_peer_rejected` 或 `native pipe rejected socket peer`。本次失败不能直接归因为已重现原桥接的签名拒绝。后台连接、MCP 基础配置、App 的任务/工具注册和浏览器运行状态仍需分别处理；尚未定位全部缺口，也没有证明所有共享后台组合均不可行。本次复用同一合成任务进行配置修正，不能排除其已有工具进程状态的影响。

Computer Use 拒绝读取 ChatGPT App 自身 UI，因此 App 的连接、恢复和任务归属以协议及日志核对，没有进行该窗口的视觉验收。

## 本轮交付与后续选择

建议近期以增强 follower 接入自动轮次，保留 App 创建任务及 App 准备工具的路径。适配器应携带经验证的本轮权限参数、回读实际范围，并保留现有请求回执核对与任务忙碌检查；这属于后续实现，本次尚未修改。

直接共享后台保留为研究选项，目前不能标为完整 App 工具就绪。进一步验证应显式处理 App 工具注册和浏览器会话初始化，并使用新的合成任务排除旧工具进程状态，而非只依据后台握手成功验收。

测试结束已停止隔离 App、官方测试后台和本机网页服务，删除隔离认证副本、App 数据目录及成功写入的 canary。主 App 进程未重启，launchd 的 `CODEX_CLI_PATH` 仍未设置；清理后主任务的 App 用量工具和应用内浏览器接口均再次调用成功。保留一个 App 测试任务用于查看真实 follower 轨迹，独立后台的数据目录已清理。

仓库只新增本记录与脱敏结果；没有修改生产行为。校验包含 JSON 解析、结果断言、随机 marker 与页面请求记录核对、canary 存在性核对、敏感字段检查及 `git diff --check`；文档与证据变更不触发全量应用构建。
