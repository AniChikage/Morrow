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

旧 `NOHUMAN_HOME`、`NOHUMAN_PORT`、`NOHUMAN_NODE`、`NOHUMAN_APP` 保留兼容；同时设置时，新变量优先。`codex-bridge/` 只保留旧转接安装回执，用于安全撤销；生产执行不再从中发现后台。

Electron 优先连接已经运行的服务，只在本机端口未运行服务时启动打包的 daemon。关闭界面不会停止该 daemon；安装或 UI 升级不会自动重启它。可选登录启动：

```bash
bash scripts/login-service.sh install
# 撤销启动项，保留数据
bash scripts/login-service.sh uninstall
```

### 远程主机

在远端安装 Node 24+。远端的自动工作同样依赖该主机自己的 Codex App 与后台连接；只想查看和管理数据时不需要它们。部署完整仓库及生产依赖：

```bash
git clone https://github.com/AniChikage/Morrow.git
cd Morrow
npm ci --omit=dev
MORROW_HOME="$HOME/.local/share/morrow" npm start
```

使用现有用户服务管理器保持进程常驻，并保留 `codex` 所在的 `PATH`。Mac 的设置页配置 SSH 主机、远端数据目录和服务端口；SSH 需支持非交互登录并已完成主机确认。桌面通过本机隧道连接，不需要公开服务端口。

远程项目使用远端的绝对路径，数据与执行保留在远端。Codex App 同步只支持服务所在机器的同用户会话；远端服务不会回连本机的 Mac App，也不会退回另一条 Codex CLI 会话。

## 认证、数据与恢复

数据目录权限为 `0700`。`token` 文件为 `0600`，客户端通过 `Authorization: Bearer …` 认证。`/health` 仅公开服务身份；所有 `/api/` 路由需要认证并拒绝浏览器 Origin，请求 JSON 上限为 1 MiB。Renderer 不获取 token，快照也不返回 token。

| 记录 | 存储内容 |
| --- | --- |
| 项目、频道、事项与事件 | 目标、设置、稳定事项编号、来源频道、版本和变更审计。 |
| `runs`、`run_io` 与报告 | 运行归属、输入、流式输出、最终回答和报告状态。 |
| `native_*` | 原生任务绑定、快照、消息、轮次、增量日志、请求、发送回执和附件记录。 |
| `loop_*` | 认识、行动选择、预期、证据、测量、复盘、观测、等待、验证与发布。 |
| `settings`、`usage_samples` | 全局设置（保留给自己的额度、额度未知时是否停止）与账户用量读数；运行记录里的 `usage` 保存本轮前后读数之差。 |

所有表位于 `workspace.sqlite`。`runs/`、`native-images/` 和 `releases/` 保存相关私有文件。原生任务的权威历史由 Codex 管理，Morrow 的 SQLite 保存已同步的镜像和编排记录，不把自己的记录当成另一套原生会话。

迁移保持已有 ID 和历史，支持旧运行来源、协议标记与任务创建记录。历史证据摘要不因品牌改名重新计算。当前没有自动裁剪历史的策略；备份应使用 SQLite 在线备份，或停止服务后复制完整数据目录及相关文件。

同一目录只允许一个 daemon，通过 `daemon.lock` 防止重复实例。SIGTERM/SIGINT 会停止服务调度并清理其拥有的 CLI 进程；不会杀死共享 Codex App。崩溃后，未结束的自有 CLI 轮次标记中断并暂停频道；共享任务则按原生状态恢复。发送回执不明确时先核对结果，不盲目重发。

## 原生运行时

### Codex App

生产 `CodexNativeTransport` 只使用 App 的 owner/follower IPC，不替换 `CODEX_CLI_PATH`，不拉起替代 App 后台。旧启动转接程序及共享 transport 保留为历史隔离夹具，生产入口不会选择它们，配置接口返回 410。

- 在 App 为同一目录创建任务、发送首条消息并保持打开，再在 Morrow 明确关联。Morrow 不自动创建、分叉或替换原生任务。
- 普通对话同步文字、图片、原生请求和运行记录；用户运行中指导使用 steering。自动轮次发现任务已忙时返回等待，不能自动变成 steering 干扰手动轮次。
- `native` 自动轮次传递空工作选项，只标识自动请求，不改变 App 的沙箱、审批策略或复核者。
- 只读/工作区选项保留 `on-request` + `auto_review` 和明确沙箱；发送 `permissions:null` 以配合显式沙箱。App 可能合并已有目录，启动前仍检查当前权限，不能声称只含传入目录。
- 独立复核走官方 `codex exec` 只读临时会话，使用专用 supervisor 处理取消、硬超时及父服务退出。只有实际 CLI 工具事件、正常终止和退出码均有效时才能通过。CLI 未提供轮次 ID 时保持为空，不编造原生 ID。
- 额度通过短暂的官方 app-server 客户端读取 `account/rateLimits/read`，不创建任务或模型轮次；失败保持未知，沿用原预算门禁。
- 保留绑定、历史、待核对回执、原生审批/问答与附件规则。发送结果未知时先同步核对，不自动重发。

服务启动撤销精确匹配的旧转接环境变量及登录项；不终止 App，不覆盖其他自定义配置。旧转接进程仍在运行时，状态与自动工作门禁要求在当前任务结束后重开 App。后台连接就绪与某个任务已加载是两回事，运行时页分别展示。

### 已停止支持的运行时

早期版本支持过 Claude Code 与 Trae。它们的频道、运行和事件记录保持可读，服务不再调度或执行：`run`/`resume` 与 `native-handoff` 返回 409；巡检发现仍启用的旧频道时，会关闭其调度、置为暂停并写一条系统事件；`pause` 仍然可用。创建项目和频道只接受 `codex`。旧频道仍可通过 API 原地转换为 Codex 频道：`PATCH /api/channels/:id` 传入 `{ "runtime": "codex" }` 后，运行时变为 `codex`，已保存的会话 ID 被清空并写一条系统事件，事项、证据和历史记录保留。这是有意保留的迁移路径，桌面界面不提供该操作。

运行时发现只探测 Codex：优先使用 Codex App 自带的 `codex` 可执行文件，其次查找 PATH。CLI 安装检测不等于登录或额度验证；实际失败与原始输出会落库。

## 持续工作与反馈

接入现有文件夹后，新项目准备一个暂停的「自主推进」频道，默认沿用 App 任务权限与审批设置、每日最多 32 轮。接入、绑定和保存配置本身不启动模型工作。示例项目不能执行。

自动轮次获得项目目标、方向、共享看板、已有认识、相关经验和人工指导，以及 `service/native-capabilities.ts` 里那份 2026-09-09 实测的原生能力清单（`context.nativeCapabilities` 和提示词里的一行）。Codex 通过运行范围内的工作接口维护项目；下一步可选择继续、等待或提问。用户手动暂停优先于反馈唤醒。

同一项目目录的责任轮次串行执行，并等待已绑定原生任务空闲。每日上限按 UTC 日界计算，已启动的失败/中断轮次也计数；普通对话和外部 App 轮次不消耗编排预算。配置范围为每天 1–100 轮、复查间隔 1–1440 分钟。

每日上限之后还有额度门禁：全局的「保留给自己的额度」按共享后台读到的精确账户用量判断，项目的「额度上限」按 Morrow 归因到该项目的轮次估算判断。达到任一条时，新的自动轮次和独立复核不再发起（频道 `waiting`，`nextRunAt` 取窗口重置时间或下一个 UTC 日，写一条系统事件，不计入运行次数；排队中的复核保留 `queued` 并按 `retryAt` 重试），手动运行返回 429。读数不可用时默认放行，设置 `stopWhenUsageUnknown` 后阻断并每 10 分钟重试；进行中的轮次不打断，普通对话不受影响。读数与限制通过 `context.budget` 和自动轮次提示词提供给 Codex。

有界 CLI 子进程路径只在 `MORROW_TEST_MODE=1` 下作为测试夹具通道可达：单轮超时 15 分钟，stdout/stderr 合计上限 20 MiB，组装提示上限 1 MiB；这些子进程限制不套用到共享 Codex App 轮次。暂停原生自动工作只中断属于该责任轮次的精确 turn ID。

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
| `GET /api/native/status` | 实际连接状态、后台就绪、支持能力与最近账户用量读数（含 `attempted`/`lastError`，用于区分「尚未读取」和「协议未返回」）。 |
| `/api/channels/:id/native/threads`、`bind`、`create` | 项目任务目录、明确绑定、创建原生任务。 |
| `/api/channels/:id/native/conversation`、`messages` | 分页原生历史、提交/追加消息与幂等回执。 |
| `/api/channels/:id/native/interrupt`、`respond` | 精确停止轮次、回答待处理原生请求。 |
| `GET /api/projects/:id/work` | 项目工作记录，可通过 `itemId` 限定事项。 |
| `GET /api/projects/:id/brief` | 项目目标与用户写下的项目说明及其版本；`/api/state` 只带版本号不带正文。 |
| `PATCH /api/projects/:id` | `{goal?, brief?, revision}` 修改目标或项目说明，版本不符返回 409；每次保存写入版本记录与审计，并要求进行中的判断重新评估。 |
| `GET /api/settings`、`PATCH /api/settings` | 全局设置：`{usageReserve?: {window:'5h'\|'weekly', keepPercent:1–99} \| null, stopWhenUsageUnknown?: boolean}`；首次读取时创建默认行，改动写审计。 |
| `PATCH /api/projects/:id/usage-budget` | `{usageBudget: {window, limitPercent:1–100} \| null}` 设置或清除项目额度上限（归因估算）；示例项目返回 409。 |
| `GET /api/projects/:id/usage` | 最近账户读数与是否过期、是否尝试过读取（`attempted`）与最近一次失败原因（`lastError`，已脱敏、最多 200 字）、适用的保留线与项目上限、本项目在窗口内的估算用量，以及当前门禁判断。 |
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

默认服务测试使用隔离数据库、假 CLI、模拟 IPC/共享后台及本地反馈与发布端，不运行用户项目或调用模型服务。测试开关为 `MORROW_TEST_MODE=1`，可通过 `MORROW_TEST_CODEX_PATH` 注入夹具，`MORROW_TEST_TIMEOUT_MS` 缩短超时。

服务测试的公共骨架在 `tests/harness/`：`env.ts` 设置测试开关与夹具运行时（必须最先导入），`service.ts` 的 `startIsolated()` 在临时数据目录里启动服务并创建项目（含 `api`、`restart`、`cleanup`），`grant.ts` 的 `grantFor()` 生成一次运行的工作授权，`receiver.ts` 的 `startReceiver()` 提供带故障模式的本地反馈与发布接收端，`wait.ts` 提供 `until`/`pause`，`fake-reviewer.ts` 是原生协议替身。新的服务测试一律基于这套骨架，不再复制 `setup()`；`npm test` 只匹配 `tests/*.test.ts`，不会把骨架模块当作测试运行。

可选真实 Codex 二进制测试使用独立原生目录和本地模型夹具，入口见 [codex-shared-runtime.integration.test.ts](../tests/codex-shared-runtime.integration.test.ts)。它验证原生协议链路，不代表真实模型的自主决策能力或线上收益。原生窗口交互、实际远端主机和真实项目反馈需要分别验收。
