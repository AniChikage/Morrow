# 0.4.3 后台对话接入验收

2026-09-07，Apple Silicon macOS；原生 Codex 二进制 0.153.3。

## 已完成

- `npm run typecheck` 通过。
- `npm test`：60 项通过，1 项原生运行时集成测试默认跳过。
- `npm run test:ui`：14 个文件，135 项通过。
- 单独启用 `NOHUMAN_TEST_CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex` 运行 `tests/codex-shared-runtime.integration.test.ts`：1 项通过。使用隔离 CODEX_HOME、项目目录和本地 Responses 模型夹具，无用户项目执行或真实模型请求。
- 原生集成覆盖：App 启动参数透传，NoHuman 创建任务；App 客户端追加到同一轮次；App 外部轮次回流；原生后台退出重开后，App 客户端仅初始化，NoHuman 直接恢复相同任务 ID 并继续发送。
- `npm run build:app` 通过，安装到 `~/Applications/NoHuman.app`，版本 0.4.3；签名严格检查通过。打包的 Node 能加载共享传输与 ws 依赖，透明启动器 `--version` 正确透传原生二进制。
- CUA 验证已安装界面中的后台设置、撤销、重新启用。撤销后 launchd 环境变量和登录启动项确实移除；已重新启用并保留待 App 重开提示。
- NoHuman 服务已升级；升级时无独立 CLI 运行。3 个项目、7 个频道、2 个原生绑定保持原 ID；SQLite `quick_check=ok`，配置与撤销操作有数据库审计。
- 安装前数据库备份：`/tmp/nohuman-before-v043.sqlite`。安装截图：`/tmp/nohuman-v043-installed.jpg`。测试及构建日志：`/tmp/nohuman-v043-*.log`。

## 尚待实际 Codex App 重开后验收

当前 Codex App 仍使用升级前启动的原生后台，因此状态为 `backgroundConfigured=true`、`backgroundReady=false`、`capabilities.create=false`。已有加载任务通过旧连接继续同步。这不表示后台冷恢复已在安装版 App 上完成最终验收。

本次开发任务结束后，完整退出 Codex App，再从 Finder/启动台重新打开，让 `CODEX_CLI_PATH` 配置生效。NoHuman 已停留在 NoHuman 项目「系统完善」频道，绑定本开发任务。接下来核对：

1. 自动发现由真实 App 启动的同一原生后台，后台能力变为可用。
2. 在 NoHuman 发送，并确认真实 App 中同一任务、回复、工具及审批链路。
3. 不打开对应 App 页面，恢复已有任务、创建新任务，并核对实际双端历史及重连。

启动桥接不修改 App bundle；保留 App 原生参数、环境和 MCP 工具配置。NoHuman 退出或服务重启只断开第二个客户端。原生运行时生命周期仍跟随 App。
