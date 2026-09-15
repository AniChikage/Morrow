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
| `upgrades` | 安装后的版本切换请求：目标 commit/整包指纹、回执给出的安装包路径、发起时的 `bootId`、阶段、阻塞工作与失败原因。每个目标指纹一条。 |

所有表位于 `workspace.sqlite`。`runs/`、`native-images/` 和 `releases/` 保存相关私有文件。原生任务的权威历史由 Codex 管理，Morrow 的 SQLite 保存已同步的镜像和编排记录，不把自己的记录当成另一套原生会话。

迁移保持已有 ID 和历史，支持旧运行来源、协议标记与任务创建记录。历史证据摘要不因品牌改名重新计算。每个一次性回填带自己的 marker，跑过一次之后启动不再整表扫描；删掉某个 marker 会重放对应回填。备份应使用 SQLite 在线备份，或停止服务后复制完整数据目录及相关文件。

看板、事件与运行历史目前没有自动裁剪策略。原生任务的 IPC 增量日志 `native_events` 会被持续清理：它只被 checkpoint 恢复读取（按线程从 `native_threads` 已覆盖的修订往后走），因此启动时的一次性迁移删掉再也读不到的行——已被 checkpoint 覆盖的修订、属于其他客户端的行、以及没有 `kind` 的投影行——并为剩下的行建 `(threadId, revision)` 索引。此后**每写出一次 checkpoint 就顺手删掉它已覆盖的日志行**（同一索引），所以这张表的上限是一次 checkpoint 间隔内的增量，而不是进程的运行时长：轮次流式进行时 checkpoint 最多每 30 秒一次，轮次结束或任务转为空闲时立刻写出，`close()` 一定写出。投影差异行已不再写入，恢复只依赖原始增量。`native_requests` 的已解决行在启动时按 `resolvedAt` 删掉超过 30 天的。删行不缩小文件；停止服务后用 `bash scripts/compact-db.sh` 回收空间，步骤见[升级与数据迁移](../docs/UPGRADING.md)。

## 运行日志

服务把生命周期事实按**每行一个 JSON 对象**写到 stdout，也就是登录启动项和 Electron 主进程指向的 `service.log`：`boot`（版本、commit/指纹前缀、`bootId`、数据目录、端口、打开数据库耗时、恢复时判为中断的轮次数）、`shutdown`（信号）、`schedule.failed`（某频道自动调度失败并因此停用）、`upgrade.phase`（切换阶段变化，阻塞项刷新不记）、`usage.refresh.failed`、`native.start.failed`、`native.sync.failed`（某个原生任务同步失败，带 `threadId`；同时仍写入该频道的时间线）、`boot.failed` 与 `unhandled.rejection`。

每行都经过本服务自己的脱敏，因此不会写出服务 token。**不记录请求体、查询串和请求头**，与请求错误路径同一条规矩。日志写入失败不影响它所描述的操作。transport 的连接/断开仍只进入频道时间线，尚未接入这里。

同一目录只允许一个 daemon，通过 `daemon.lock` 防止重复实例。SIGTERM/SIGINT 会停止服务调度并清理其拥有的 CLI 进程；不会杀死共享 Codex App。崩溃后，未结束的自有 CLI 轮次标记中断并暂停频道；共享任务则按原生状态恢复。发送回执不明确时先核对结果，不盲目重发。为新安装的版本主动让位时使用专用退出码 75（见下文），与崩溃和人工停止区分开。

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

早期版本支持过 Claude Code 与 Trae。它们的频道、运行和事件记录保持可读，服务不再调度或执行：`run`/`resume` 返回 409；巡检发现仍启用的旧频道时，会关闭其调度、置为暂停并写一条系统事件；`pause` 仍然可用。创建项目和频道只接受 `codex`。旧频道仍可通过 API 原地转换为 Codex 频道：`PATCH /api/channels/:id` 传入 `{ "runtime": "codex" }` 后，运行时变为 `codex`，已保存的会话 ID 被清空并写一条系统事件，事项、证据和历史记录保留。这是有意保留的迁移路径，桌面界面不提供该操作。

运行时发现只探测 Codex：优先使用 Codex App 自带的 `codex` 可执行文件，其次查找 PATH。CLI 安装检测不等于登录或额度验证；实际失败与原始输出会落库。

## 持续工作与反馈

接入现有文件夹后，新项目准备一个暂停的「自主推进」频道，默认沿用 App 任务权限与审批设置、每日最多 32 轮。接入、绑定和保存配置本身不启动模型工作。示例项目不能执行。

自动轮次获得项目目标、方向、共享看板、已有认识、相关经验和人工指导，以及 `service/native-capabilities.ts` 里那份 2026-09-09 实测的原生能力清单（由任务章程引用 `contract.nativeCapabilities`）。同一频道沿用同一原生任务，因此提示词分成两部分：任务开头一次性发出的**章程**（角色、目标、项目说明全文及版本、工作方向、规则与授权范围），以及之后每轮只发的**轮次提示**（一行提醒、关注点/下一步两行、额度、看板摘要和本轮工具入口）。章程全文仅在首次、项目说明/目标/方向/权限变化、换绑原生任务或未送达时发送；已有章程用满 10 轮、上一轮异常结束或没有保存 morrow-next 时发简短回顾。被原生任务拒收的轮次不算已送达。看板以 `#编号 类型 状态 标题` 摘要给出（人建立的事项和上一轮改动过的事项附下一步，已解决只计数），摘要总长最多 1200 字符，优先保留人工和上轮事项的下一步（最多150字符），超额只列编号，完整字段用 `context` 读取。每轮工具入口引用私有目录里的 `tool.sh`，由 `sh` 调用，转发原 CLI 参数且不内嵌凭证；旧 Node 调用仍兼容。看板会按剩余长度缩短，完整便条/回顾以1500/2500字符为目标，度量脚本同时检查工具入口250字符目标。Codex 通过运行范围内的工作接口维护项目；下一步可选择继续、等待或提问。用户手动暂停优先于反馈唤醒。发给模型的文本本身集中在 `service/prompts/`（章程、非原生 CLI 轮次、工作契约、策略指引、独立复核各一个模块），代码只负责按项目与频道行拼装；`tests/prompt-text.test.ts` 用固定输入的 sha256 钉住每段文本的字节。

同一项目目录的责任轮次串行执行，并等待已绑定原生任务空闲。每日上限按 UTC 日界计算，已启动的失败/中断轮次也计数；普通对话和外部 App 轮次不消耗编排预算。配置范围为每天 1–100 轮、复查间隔 1–1440 分钟。

一个项目的多个频道共享同一个看板和同一个工作目录，因此有两条分工护栏。**事项归属**：`items` 行新增可选 `ownerChannelId`（缺省为无人负责）。频道通过工作接口推进无人负责的事项即接手（`feature.upsert`、带 `itemId` 的 `decision.choose` 与 `verification.request`，审计 `item.claimed`）；事项存为 `resolved` 时交回（审计 `item.released`），`blocked` 保留负责频道；对别的频道负责的事项执行这三种写操作返回 409，读取和补充证据/经验/观测不受限制。轮次结束时的报告入口（`morrow-report` 经 `Engine.finishSuccess`，CLI 与原生两条路径同一处）遵守同一规则，并按轮次**结束时**的归属判断（轮次进行中被人改派即以改派后为准）：可写的事项照常写入并沿用接手/交回语义，别的频道负责的事项整条不写入，记一条审计 `report.item-refused`（actor `system`，`changes.after` 带 `itemId`、`reportedTitle`、`ownerChannelId`），同一份报告的其它事项照常应用；报告原文照旧保留在 `results` 与该轮 `report` I/O 中，`reportStatus` 仍为 `valid`，被拒条数写入 `runs.reportError` 并在工作日志留一条系统事件；归属被拒与 revision 冲突（`item.conflict` / `reportStatus: conflict`）分开记录，归属先判。人用 `PATCH /api/items/:id` 的 `ownerChannelId`（同项目频道或 `null`）分派或收回，可覆盖 agent 当前归属，审计 `item.assigned`。**未提交改动隔离**：每个结束的编排轮次在 `runs` 行记录可选 `treeState`（`git status --porcelain` 读出的 `dirty` 与最多 50 个相对路径；无仓库或读取失败记 `unknown`，只读，不执行任何改动仓库的 git 命令）。工作树当前有改动、且项目最近一次结束的编排轮次属于别的频道并记录了 `dirty` 时，该频道不开始：自动调度置 `waiting` 并按复查间隔重试，只写一条系统事件；人工「运行一次」和「持续运行」返回 409 且带同一句说明。同一频道可以在自己的改动上继续；只有人改动的工作树不阻断任何频道。看板摘要会标注负责频道，轮次提示会列出未提交改动的文件。

每日上限之后还有额度门禁：全局的「保留给自己的额度」按共享后台读到的精确账户用量判断，项目的「额度上限」按 Morrow 归因到该项目的轮次估算判断。达到任一条时，新的自动轮次和独立复核不再发起（频道 `waiting`，`nextRunAt` 取窗口重置时间或下一个 UTC 日，写一条系统事件，不计入运行次数；排队中的复核保留 `queued` 并按 `retryAt` 重试），手动运行返回 429。读数不可用时默认放行，设置 `stopWhenUsageUnknown` 后阻断并每 10 分钟重试；进行中的轮次不打断，普通对话不受影响。读数与限制通过 `context.budget` 和每轮的轮次提示提供给 Codex。

有界 CLI 子进程路径只在 `MORROW_TEST_MODE=1` 下作为测试夹具通道可达：单轮超时 15 分钟，stdout/stderr 合计上限 20 MiB，组装提示上限 1 MiB；这些子进程限制不套用到共享 Codex App 轮次。暂停原生自动工作只中断属于该责任轮次的精确 turn ID。

反馈监测支持 HTTP(S) GET JSON、JSON Pointer 和 `changed/equals/gte/lte` 条件。新反馈、质量变化、采集故障和复查期限可唤醒启用的频道；重复相同状态不反复触发。与发布关联的观测在确认发布后开始采集。当前不包含文件变化触发器。

可选测量计划保存指标口径、目标关系、代理局限、基线、样本/完整性等字段规则及数据时间。新观测必须满足来源、窗口与质量要求，数据不足保留未知。规则核对和独立模型复核都不等同于线上业务因果证明。

执行状态与看板报告状态分开。可选 `morrow-report` 必须通过协议校验；旧 `nohuman-report` 仍能读取。缺少报告不会凭空创建事项，普通聊天也不会自动被解释为看板结论。Agent 提交的完成状态还受当前验证要求约束。

## 工作接口与发布确认

自动 Codex 轮次获得 `agent-cli.ts --context …` 入口，使用短期、限定项目/频道/运行的凭据调用 `/api/agent`。该凭据不能访问桌面人工审阅接口；桌面 token 不写入提示。使用 `--operation context` 获取当前项目数据，`--operation contract` 获取各操作的字段约定、发布适配说明、工作原则与原生能力清单（两者都是只读，无需 `--request-id`）；写操作必须携带 `--request-id`，重试保持相同 ID 和内容，`--input -` 支持从 stdin 读取 JSON。写操作只回执关键字段：`evidence.capture`/`evidence.record` 返回来源、摘要与 `bytes` 而不回放内容（全文用 `evidence.read`），`feature.upsert` 返回编号、版本、状态与复核 ID。

`release.propose` 要求关联事项、具体改动、预期收益、检查证据、影响、回退和观察计划，并封存项目内的产物文件及审阅摘要。当前产物上限为 8 MiB，大型发布可以提交不可变的部署清单。

发布门禁分两半：每个关联事项至少有一次独立复核通过（可以是改动当时的源版本，ID 记入 `verificationIds`），并且有一次覆盖全部关联事项、绑定当前源版本的发布级复核通过（`verification.request kind:"release"`，ID 记入 `releaseVerificationId`）。发布级复核复用同一套排队、只读 CLI 会话、5 分钟上限、未知处理与重试机制；请求时要求至少一项绑定当前源版本的 execution 证据，任一事项从未复核通过则返回 409。事项自身完成（`feature.upsert` 到 verified/resolved 与报告路径）仍要求该事项当前源版本的复核。

发布目标有两种形状：`target.kind` 为 `http`（省略时同）或 `local-script`。

| 适配 | 约定 |
| --- | --- |
| `http` · POST 发布 URL | Header `Idempotency-Key: <releaseId>`；JSON 为 `{releaseId, reviewHash, artifact:{name, sha256, bytes, base64}}`。 |
| `http` · GET 状态 URL | 带 `releaseId` 查询参数，只查询该次发布。 |
| `local-script` · 执行 | `target:{kind:"local-script", label, script, args, timeoutSeconds, statusScript?}`。`script`/`statusScript` 是项目内的相对路径，必须是人写好并已提交在项目里的普通文件（≤256 KiB，符号链接不得指向项目外）；`args` ≤16 项、每项 ≤1000 字符，作为参数数组传给进程，不经过 shell；`timeoutSeconds` 为 30–3600 的整数；`label` ≤100 字。提议时脚本被复制封存，摘要写入 `target.scriptSha256`/`statusScriptSha256` 并因此进入 `reviewHash`；agent 不能提供或修改摘要。人确认后在项目根目录执行封存副本（关闭标准输入），退出码 0 且最后一行非空 stdout 为回执 JSON 才算确认。 |
| `local-script` · 核对 | 优先读固定位置的 `<数据目录>/releases/<id>/receipt.json`，其次以 60 秒上限、同一环境、不带参数执行封存的 `statusScript`，否则保持 `unknown`。 |
| 回执 | `{releaseId, artifactSha256, status:"published", url?}`；只有确实发布匹配产物后才能返回 `published`，明确失败可返回 `failed`。两种适配使用同一回执形状与校验。 |

`local-script` 执行时的环境是固定的最小集合，不含服务 token；除下表中可选的 `TMPDIR` 外，不透传服务自身的其余环境变量：

| 变量 | 内容 |
| --- | --- |
| `PATH`、`HOME`、`NO_COLOR=1` | 基本执行环境；`NO_COLOR` 让输出便于留存。 |
| `TMPDIR`（可选） | 仅当服务自身有该变量时透传，使脚本下的构建与测试与服务用同一个临时目录，而不是回落到 `/tmp`。 |
| `MORROW_RELEASE_ID` | 本次发布 ID，回执必须回报同一个值。 |
| `MORROW_ARTIFACT_PATH`、`MORROW_ARTIFACT_SHA256` | 封存产物副本的路径与摘要（dogfood 中是发布清单）。 |
| `MORROW_REVIEW_HASH` | 人已确认的审阅摘要。 |
| `MORROW_PROJECT_PATH` | 项目目录，同时是脚本的工作目录。 |
| `MORROW_RECEIPT_PATH` | 固定为 `<数据目录>/releases/<id>/receipt.json`，脚本写入同一份回执 JSON。 |
| `MORROW_RUNTIME_CACHE` | `<数据目录>/runtime-cache`，可复用的缓存目录；`scripts/build-electron.sh` 用它复用已校验的 Node 24 下载。 |

桌面人工审阅提交当前 `reviewHash` 与决定。确认后只发送封存产物或执行封存脚本，源文件后来修改不会更换被批准的内容；封存脚本摘要不符时批准返回 409，发布阶段发现不符则记 `failed` 且不执行任何命令。发布超时或回执不明时标记 `unknown`：`http` 通过 GET 核对，不自动重复 POST；`local-script` 超时先向进程组发 SIGTERM、5 秒后 SIGKILL，之后只按上表核对，不自动重跑。ID、摘要和发布状态必须一致。HTTP 响应上限为 512 KiB，不跟随重定向；脚本 stdout/stderr 合计保留最后 1 MiB 作为 `log`（已脱敏，`context` 只给尾部）。

发布门禁约束 Morrow 的发布接口。`local-script` 是服务唯一会执行「工作接口记录所指向的命令」的地方：脚本由人编写并提交，提议时封存，只在人确认该确切版本后执行一次；这是有人把关的安装步骤，不是通用命令通道，也不声称脚本自身的行为被沙箱隔离。原生工具、网络和外部凭据受各原生运行时权限约束；提示中的行为要求不能等同于独立的系统权限隔离。

## 安装后的自动版本切换

`local-script` 发布安装的往往就是 Morrow 自己。构建阶段由 `scripts/build-info.ts` 在包内写入只读的 `Contents/Resources/build-info.json`，含 commit 与**整包运行指纹**（服务 TS、编译后的 main/preload/renderer、package 元信息；不含该文件自身与任何签名，因此重复签名不会变成新版本，纯界面改动也算新版本）。daemon 与 Electron 主进程在启动时各读一次并记在内存：这是"正在运行的版本"，之后磁盘上的包被替换也不会改变它。开发检出没有 `.app` 祖先，指纹为 `unknown`，因此永不参与切换。

`scripts/release-local.sh` 在安装成功后补两个回执字段：`installedBundle`（安装到的 `.app` 绝对路径）与 `buildFingerprint`（读取刚安装那个包的 build-info）。读不到只写日志并保留人工切换，不把已完成的安装判为失败；脚本本身不重启、不发信号、不改 `install-app.sh` 的替换/回退逻辑。

`receipt()` 在与 `published` 同一事务内判断是否要切换：只有 `local-script` 目标、回执包路径与本服务自身包的真实路径一致、指纹与运行中的不同，才写入一条 `pending` 记录（同指纹记为 `applied`，不重启；同一目标指纹只记一次）。HTTP 目标、别的项目里同名的脚本装到别处、缺字段或字段非法，都不会产生请求——识别依据是包路径与指纹，不是脚本文件名。

待切换期间（`pending`/`draining`/`exiting`）拒绝一切**会开新工作**的入口，409 都点明切换：手动 `run`/`resume`、会启动原生轮次的聊天发送、新的独立复核与重试、上线确认、发布结果核对；自动调度不报错而是等待并每频道写一条系统事件。暂停、中断、回答原生提问、读取与否决发布照常可用；已排队的复核会跑完（否则永远等不到空闲），已批准但尚未开始的发布留到切换后再执行。空闲判定读真实状态而非 `channels.status`：无 CLI 轮次、无原生轮次（含 starting/scheduled 与活跃 turn）、无未被任务接收的发送、无排队或进行中的复核、无进行中的发布。10 分钟只是提示期限，到点把阻塞项写进记录供界面显示，继续等待，不中断任何工作。

没有发布回执的安装也会被发现：`tick()` 每 60 秒重读自己所在包的 `build-info.json`，磁盘上的整包指纹与运行中的不一致时登记一条待切换记录（`releaseId` 记为 `manual-install`），之后与回执路径完全相同。因此 `npm run build:app && bash scripts/install-app.sh` 之后不需要手动 `pkill`。开发检出（无包、指纹 `unknown`）和重装同一版本都不触发；同一目标指纹已有记录（含 `recover()` 判为 `blocked` 的）不会再登记，因此不会反复重开。

本机 Electron 发现无法完成接手时——待切换的服务不是本应用所在的安装包、使用了其他数据目录、或本机服务已更换启动实例——会把原因写进记录并置为 `blocked`（每个原因只报一次），而不是只留一行日志。否则记录会停在 `draining`：每个会开新工作的入口永久 409，调度每个 tick 都写等待，而没有人再推进它。开发模式运行的界面没有自己的安装包，既不接手也不写 `blocked`，留给已安装的应用完成切换。

确认空闲且本机 Electron 已接手后，daemon 先置内部退出标记再写 `exiting`（两者之间没有 await，因此发布或轮次无法在检查后插队），随后停止接收请求（其余请求 503 带 `code:upgrade_exiting`）、有界排空在途请求、走原有关闭路径释放 HTTP/锁/数据库，最后以退出码 75 退出。主进程确认旧 daemon 真的退出（自有子进程等退出事件；被接管的 daemon 等锁释放且健康检查离线）后才 `app.relaunch()`，新实例启动新 daemon。新 daemon 启动时先对账：目标指纹已在运行记 `applied`，仍是旧指纹记 `blocked` 并保留原因（不无限重开），之后才走原有的发布 reconcile 与原生恢复。首个带该能力的安装版仍需一次人工切换来启用它。

### 桌面 API 导航

| 路由 | 用途 |
| --- | --- |
| `GET /api/native/status` | 实际连接状态、后台就绪、支持能力与最近账户用量读数（含 `attempted`/`lastError`，用于区分「尚未读取」和「协议未返回」）。 |
| `/api/channels/:id/native/threads`、`bind` | 项目任务目录与明确绑定。 |
| `/api/channels/:id/native/conversation`、`messages`、`open` | 分页原生历史、提交/追加消息与幂等回执、在 App 中打开该任务所需的信息。 |
| `/api/channels/:id/native/interrupt` | 精确停止当前原生轮次。 |
| `GET /api/projects/:id/work` | 项目工作记录，可通过 `itemId` 限定事项。 |
| `GET /api/projects/:id/brief` | 项目目标与用户写下的项目说明及其版本；`/api/state` 只带版本号不带正文。 |
| `PATCH /api/projects/:id` | `{goal?, brief?, revision}` 修改目标或项目说明，版本不符返回 409；每次保存写入版本记录与审计，并要求进行中的判断重新评估。 |
| `PATCH /api/items/:id` | `{status?, title?, summary?, kind?, evidence?, nextStep?, revision?, ownerChannelId?}`；`ownerChannelId` 取同项目频道 ID 或 `null`（无人负责），可覆盖 agent 当前归属，写 `item.assigned` 审计；其他频道不属于该项目返回 404。 |
| `GET /api/settings`、`PATCH /api/settings` | 全局设置：`{usageReserve?: {window:'5h'\|'weekly', keepPercent:1–99} \| null, stopWhenUsageUnknown?: boolean}`；首次读取时创建默认行，改动写审计。 |
| `PATCH /api/projects/:id/usage-budget` | `{usageBudget: {window, limitPercent:1–100} \| null}` 设置或清除项目额度上限（归因估算）；示例项目返回 409。 |
| `GET /api/projects/:id/usage` | 最近账户读数与是否过期、是否尝试过读取（`attempted`）与最近一次失败原因（`lastError`，已脱敏、最多 200 字）、适用的保留线与项目上限、本项目在窗口内的估算用量，以及当前门禁判断。 |
| `POST /api/agent` | 运行范围内的 AI 工作操作。 |
| `POST /api/releases/:id/review` | 桌面人工发布决定，工作凭据不能调用。 |
| `GET /api/releases/:id/script` | `local-script` 发布的封存脚本原文与摘要（≤256 KiB），供人确认前逐字阅读；工作凭据不能调用，`http` 目标返回 409。 |
| `GET /api/upgrade` | 运行中的构建身份（`bootId`、commit、整包指纹、自身包路径、数据目录）、专用退出码、当前是否空闲与阻塞工作，以及待切换记录；同样的内容也放入 `/api/state` 的 `upgrade` 字段供界面轮询。 |
| `POST /api/upgrade/acknowledge`、`restart`、`blocked` | 切换握手，仅桌面凭据：都必须带 `{fromBootId, targetFingerprint}` 且与当前启动、当前目标一致，幂等。`acknowledge` 表示本机 Electron 已核对身份与目标并接手；`restart` 是界面「立即重启」提前发起同一握手，仍有工作在进行时 409 并列出阻塞项；`blocked` 记录接手失败原因（`reason` ≤500 字）。工作凭据调用这三个路由与 `GET /api/upgrade` 一律 401。 |

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
