# Morrow 执行服务

Node.js 24+ 服务，为桌面应用提供项目状态、原生任务同步、持续工作、反馈与发布确认。状态和有界运行 I/O 保存在 SQLite；原生运行时负责登录、模型配置、工具与实际执行。

产品介绍和安装见 [仓库 README](../README.md)。完整的 AI 工作操作与字段约束见 [项目工作协议](../docs/PROJECT-WORK-CONTRACT.md)。本文说明服务的部署方式与运行边界。

## 启动与配置

从仓库根目录执行：

```bash
npm ci
MORROW_HOME="$HOME/.local/share/morrow" MORROW_PORT=43821 npm start
```

服务直接运行 TypeScript，不需要单独编译。SQLite 使用 Node 内置模块；原生共享连接依赖 `ws`，因此仅复制 `service/` 目录不能完成部署。

| 配置 | 默认或用途 |
| --- | --- |
| `MORROW_HOME` | 数据目录。未设置时，新安装使用 `~/Library/Application Support/Morrow`；该目录不存在且旧 `NoHuman` 目录存在时沿用旧目录。 |
| `MORROW_PORT` | `43821`，仅监听 `127.0.0.1`。 |
| `CODEX_HOME` | 原生 Codex 的配置目录，默认 `~/.codex`；由原生运行时管理。 |
| `MORROW_NODE` | Electron 开发模式下可选的 Node 可执行文件路径。 |
| `MORROW_APP` | 登录启动脚本使用的已安装 App 路径。 |

旧 `NOHUMAN_HOME`、`NOHUMAN_PORT`、`NOHUMAN_NODE`、`NOHUMAN_APP` 保留兼容；同时设置时，新变量优先。原生桥接从实际数据目录下的 `codex-bridge/` 发现后台，明确指定或沿用旧目录时不会另找一个空的新目录。

Electron 优先连接已经运行的服务，只在本机端口未运行服务时启动打包的 daemon。关闭界面不会停止该 daemon；安装或 UI 升级不会自动重启它。可选登录启动：

```bash
bash scripts/login-service.sh install
# 撤销启动项，保留数据
bash scripts/login-service.sh uninstall
```

### 远程主机

在远端安装 Node 24+ 和需要使用的 CLI，并在远端完成 CLI 登录。部署完整仓库及生产依赖：

```bash
git clone https://github.com/AniChikage/Morrow.git
cd Morrow
npm ci --omit=dev
MORROW_HOME="$HOME/.local/share/morrow" npm start
```

使用现有用户服务管理器保持进程常驻，并保留 CLI 所在的 `PATH`。Mac 的设置页配置 SSH 主机、远端数据目录和服务端口；SSH 需支持非交互登录并已完成主机确认。桌面通过本机隧道连接，不需要公开服务端口。

远程项目使用远端的绝对路径，数据与执行保留在远端。Codex App 同步只支持本机同用户会话；远端服务不会回连 Mac App，也不会退回另一条 Codex CLI 会话。Claude/Trae 可使用远端 CLI 适配器，具体主机仍需联调。

## 认证、数据与恢复

数据目录权限为 `0700`。`token` 文件为 `0600`，客户端通过 `Authorization: Bearer …` 认证。`/health` 仅公开服务身份；所有 `/api/` 路由需要认证并拒绝浏览器 Origin，请求 JSON 上限为 1 MiB。Renderer 不获取 token，快照也不返回 token。

| 记录 | 存储内容 |
| --- | --- |
| 项目、频道、事项与事件 | 目标、设置、稳定事项编号、来源频道、版本和变更审计。 |
| `runs`、`run_io` 与报告 | 运行归属、输入、流式输出、最终回答和报告状态。 |
| `native_*` | 原生任务绑定、快照、消息、轮次、增量日志、请求、发送回执和附件记录。 |
| `loop_*` | 认识、行动选择、预期、证据、测量、复盘、观测、等待、验证与发布。 |

所有表位于 `workspace.sqlite`。`runs/`、`native-images/` 和 `releases/` 保存相关私有文件。原生任务的权威历史由 Codex 管理，Morrow 的 SQLite 保存已同步的镜像和编排记录，不把自己的记录当成另一套原生会话。

迁移保持已有 ID 和历史，支持旧运行来源、协议标记与任务创建记录。历史证据摘要不因品牌改名重新计算。当前没有自动裁剪历史的策略；备份应使用 SQLite 在线备份，或停止服务后复制完整数据目录及相关文件。

同一目录只允许一个 daemon，通过 `daemon.lock` 防止重复实例。SIGTERM/SIGINT 会停止服务调度并清理其拥有的 CLI 进程；不会杀死共享 Codex App。崩溃后，未结束的自有 CLI 轮次标记中断并暂停频道；共享任务则按原生状态恢复。发送回执不明确时先核对结果，不盲目重发。

## 原生运行时

### Codex App

`codex-app-host-bridge.ts` 保留 App 的启动参数和配置，将其启动的原生后台通过私有 Unix WebSocket 提供给同用户客户端。Morrow 连接这个后台，不另起一个 `codex exec` 或替代后台。

首次在桌面配置后台连接后，需要在当前任务结束时重开一次 Codex App。生效后，Morrow 可以创建或冷恢复原生任务，无需用户逐条打开 App 页面。切换前的 owner/follower IPC 作为受限兼容路径，依赖 App 已加载的任务，不支持新的自动工作能力。

- 每个频道明确绑定一个本项目目录下的原生任务，只同步已绑定任务。
- 普通对话传递原始文字、图片和请求 ID；运行中通过原生 steering 追加指导。
- 自动轮次使用同一任务，核对频道范围后应用相应沙箱和原生自动审查。模型与登录仍由原生任务管理。
- 审批与结构化问答使用原生待处理请求 ID；不支持的内容明确交由 App 处理。
- 支持 PNG/JPEG/WebP/GIF：单张最多 10 MiB，每批最多 5 张、20 MiB。附件使用按频道隔离的私有副本与摘要校验。
- 断线时历史仍可读；同一请求 ID 的内容不能改变。丢失确认后保留未知回执，并按原生消息 ID 核对。

连接依赖 Codex App 的私有协议，不能承诺任意未来版本兼容。后台存在与某条任务就绪是不同状态；多后台归属不明确时不会猜测目标。

### Claude Code 与 Trae

Claude 使用受限非交互调用：只读提供 `Read/Grep/Glob`，编辑增加 `Edit/Write`；当前不开放 Bash 或 MCP，因此不能在该适配器中执行测试命令，也不完整继承 Claude 自定义插件能力。

Trae 使用 `traex exec --json` / `exec resume`，保留原生 provider、规则和默认模型，显式约束所选沙箱与审批设置。发现顺序为 `traex`、`traecli`，不使用图形应用的 `trae` 可执行文件。

这两个适配器的人工备注是下一轮上下文，不是实时 App 对话。CLI 安装检测不等于登录或额度验证；实际失败与原始输出会落库。

## 持续工作与反馈

接入现有文件夹后，新项目准备一个暂停的「自主推进」频道，默认允许工作区编辑、每日最多 32 轮。接入、绑定和保存配置本身不启动模型工作。示例项目不能执行。

自动轮次获得项目目标、方向、共享看板、已有认识、相关经验和人工指导。Codex 通过运行范围内的工作接口维护项目；下一步可选择继续、等待或提问。用户手动暂停优先于反馈唤醒。

同一项目目录的责任轮次串行执行，并等待已绑定原生任务空闲。每日上限按 UTC 日界计算，已启动的失败/中断轮次也计数；普通对话和外部 App 轮次不消耗编排预算。配置范围为每天 1–100 轮、复查间隔 1–1440 分钟。

自有 CLI 单轮超时 15 分钟，stdout/stderr 合计上限 20 MiB，组装提示上限 1 MiB；这些子进程限制不直接套用到共享 Codex App 轮次。暂停原生自动工作只中断属于该责任轮次的精确 turn ID。

反馈监测支持 HTTP(S) GET JSON、JSON Pointer 和 `changed/equals/gte/lte` 条件。新反馈、质量变化、采集故障和复查期限可唤醒启用的频道；重复相同状态不反复触发。与发布关联的观测在确认发布后开始采集。当前不包含文件变化触发器。

可选测量计划保存指标口径、目标关系、代理局限、基线、样本/完整性等字段规则及数据时间。新观测必须满足来源、窗口与质量要求，数据不足保留未知。规则核对和独立模型复核都不等同于线上业务因果证明。

执行状态与看板报告状态分开。可选 `morrow-report` 必须通过协议校验；旧 `nohuman-report` 仍能读取。缺少报告不会凭空创建事项，普通聊天也不会自动被解释为看板结论。Agent 提交的完成状态还受当前验证要求约束。

## 工作接口与发布确认

自动 Codex 轮次获得 `agent-cli.ts --context …` 入口，使用短期、限定项目/频道/运行的凭据调用 `/api/agent`。该凭据不能访问桌面人工审阅接口；桌面 token 不写入提示。使用 `--operation context` 获取当前状态与操作契约；写操作必须携带 `--request-id`，重试保持相同 ID 和内容，`--input -` 支持从 stdin 读取 JSON。

`release.propose` 要求关联事项、具体改动、预期收益、检查证据、影响、回退和观察计划，并封存项目内的产物文件及审阅摘要。当前产物上限为 8 MiB，大型发布可以提交不可变的部署清单。

项目需提供以下 HTTP 适配接口及必要的发布授权：

| 请求 | 约定 |
| --- | --- |
| POST 发布 URL | Header `Idempotency-Key: <releaseId>`；JSON 为 `{releaseId, reviewHash, artifact:{name, sha256, bytes, base64}}`。 |
| GET 状态 URL | 带 `releaseId` 查询参数，只查询该次发布。 |
| 回执 | `{releaseId, artifactSha256, status:"published", url?}`；只有确实发布匹配产物后才能返回 `published`，明确失败可返回 `failed`。 |

桌面人工审阅提交当前 `reviewHash` 与决定。确认后只发送封存产物，源文件后来修改不会更换被批准的内容。发布超时或回执不明时标记 `unknown`，通过 GET 核对，不自动重复 POST；ID、摘要和发布状态必须一致。响应上限为 512 KiB，不跟随重定向。

发布门禁约束 Morrow 的发布接口。原生工具、网络和外部凭据受各原生运行时权限约束；提示中的行为要求不能等同于独立的系统权限隔离。

### 桌面 API 导航

| 路由 | 用途 |
| --- | --- |
| `GET /api/native/status` | 实际连接状态、后台就绪与支持能力。 |
| `/api/channels/:id/native/threads`、`bind`、`create` | 项目任务目录、明确绑定、创建原生任务。 |
| `/api/channels/:id/native/conversation`、`messages` | 分页原生历史、提交/追加消息与幂等回执。 |
| `/api/channels/:id/native/interrupt`、`respond` | 精确停止轮次、回答待处理原生请求。 |
| `GET /api/projects/:id/work` | 项目工作记录，可通过 `itemId` 限定事项。 |
| `POST /api/agent` | 运行范围内的 AI 工作操作。 |
| `POST /api/releases/:id/review` | 桌面人工发布决定，工作凭据不能调用。 |

请求方法、参数校验和其余路由以 [server.ts](server.ts) 为准；领域字段与操作规则见 [项目工作协议](../docs/PROJECT-WORK-CONTRACT.md)。

## 验证

在仓库根目录运行：

```bash
npm run typecheck
npm test
npm run test:ui
npm run build:app
```

默认服务测试使用隔离数据库、假 CLI、模拟 IPC/共享后台及本地反馈与发布端，不运行用户项目或调用模型服务。测试开关为 `MORROW_TEST_MODE=1`，可通过 `MORROW_TEST_CODEX_PATH`、`MORROW_TEST_CLAUDE_PATH`、`MORROW_TEST_TRAE_PATH` 注入夹具，`MORROW_TEST_TIMEOUT_MS` 缩短超时。

可选真实 Codex 二进制测试使用独立原生目录和本地模型夹具，入口见 [codex-shared-runtime.integration.test.ts](../tests/codex-shared-runtime.integration.test.ts)。它验证原生协议链路，不代表真实模型的自主决策能力或线上收益。原生窗口交互、实际远端主机和真实项目反馈需要分别验收。
