# 架构与数据

[文档首页](README.md) · [核心机制](CORE-MECHANISM.md)

```text
Electron / React 界面
  └─ 隔离的 preload → Electron 主进程
       ├─ 本机 HTTP / SSH 隧道 → Node 执行服务 → SQLite
       └─ 文件夹选择、原生窗口与本机操作

执行服务
  ├─ 项目工作接口、调度、反馈、证据核对与发布确认
  └─ Codex App 共享原生后台
```

服务默认监听 `127.0.0.1:43821`，使用私有随机 token。Renderer 不持有该 token，`localStorage` 只保存视图偏好。退出界面后独立服务可以继续工作；机器休眠时不执行。

| 数据位置 | 内容 |
| --- | --- |
| `workspace.sqlite` | 项目、看板、运行 I/O、原生记录、证据、判断、经验、发布与审计。 |
| `runs/` | 有界 CLI 输入输出及工作上下文的私有文件副本。 |
| `native-images/` | 原生对话图片的私有副本。 |
| `releases/` | 与人工审阅版本关联的封存发布产物。 |
| `codex-bridge/` | 启动器、配置回执与共享后台连接清单。 |
| `token`、`service.log`、`desktop-connection.json` | 服务认证、诊断日志与桌面连接偏好。 |

远程模式通过已有 SSH 配置连接远端服务，代码执行和数据保留在远端。Codex App 同步要求服务与 App 在同一台机器、同一用户会话；远端服务不会回连本机的 Codex App，远端的自动工作依赖该主机自己的 Codex App 共享后台。远端安装依赖、启动和接口说明见 [执行服务文档](../service/README.md)。

原生任务的权威历史由 Codex 管理。SQLite 保存已绑定任务的同步镜像和 Morrow 编排记录；不会导入未关联任务的私有历史。早期版本留下的 Claude Code / Trae 频道、运行和事件仍按原样保存并可读，但不再执行。

同一套服务、调度器和工作接口还支撑仓库内的可重复验收 harness（[`scripts/acceptance/`](../scripts/acceptance/README.md)）。fixture 模式下 `startServer({nativeTransport})` 收到的是一个脚本化的原生后台替身，外部世界是本机接收端，时钟是虚拟的：`npm run acceptance -- run <场景>` 会在临时数据目录上把一个场景从建立观察、冻结预期、独立复核、人工上线确认一直跑到重启后的记录一致性，并写出 `timeline.jsonl`、`calls.jsonl` 与 `summary.md`。fixture 结果验证框架机制，不验证模型自主性。

进一步阅读：[项目工作协议](PROJECT-WORK-CONTRACT.md)、[执行服务与恢复](../service/README.md)、[升级与数据迁移](UPGRADING.md)。
