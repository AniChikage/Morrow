# 验收 harness 的 live 模式：设计与决定记录

**负责人已经拍板，live 模式已实现。** 下面第 1–10 节是设计正文（原提案），每一节末尾原来的「待确认」已经换成对应的决定；第 11 节是决定记录本身。实现在 `scripts/acceptance/live.ts`（编排与生产 deps 工厂）、`scripts/acceptance/timeline.ts`（动词的 live 分支）、`scripts/acceptance/run.ts`（`prepare` 与 `--mode live`）、`scripts/acceptance/metrics.ts` 与 `report.ts`（模式分支），测试在 `tests/acceptance-live.test.ts`（全部用注入的假依赖，不连真实 App、不消耗额度）。

已经真的跑过两次：**10.1 是首跑**（`usagegap-live-01`，退出码 1，`turn-timeout`），**10.2 是第二次**（`usagegap-live-02`，退出码 0，`needs-input`，两轮真实轮次都正常结束）。第二次证明通道通了，也提出了三个要补的地方——那三件事已经做完，决定 5 因此有一处修正（人在终端上输入 `approve` 就是人工确认）。完整时间线的建议参数在 10.2 末尾。

## 2026-09-11 的决定与实现状态

| # | 决定 | 实现 |
| --- | --- | --- |
| 1 | **作者自己的自主频道由人先暂停。** runner 跨不了数据目录，只在 `prepare` 和 `run` 开头打印提醒。 | `pauseOwnChannelsReminder`，写成「步骤 0」。 |
| 2 | **两步调用。** `prepare` 建目录、写种子与 `prepared.json`、打印人要做的四步后退出 0；`run` 再起服务、关联、跑时间线。`run` 拒绝：没有 `prepared.json` 的目录、已有 `home/` 的目录、缺 `--run-id`、场景与 `prepared.json` 不符。 | `prepareLive()` / `readPrepared()`。 |
| 3 | **`--advance-scale` 缺省 0.1**（20 分钟压成 2 分钟），可显式设 `1`；比例写进 `run.json`/`live.json`，`summary.md` 明写压缩倍数与「`adjustmentLatency` 的绝对分钟数不可与 fixture 直接比较」。 | `liveDefaults.advanceScale`、`scaleNote()`。 |
| 4 | **只有运行本身出错才非零退出**（第 6 节的表逐条照做）。模型的表现全部进指标；`invariants` 逐条评估并写进报告，但不决定退出码。 | `stopExitCodes`，`summary.md` 的 Invariants 小节明写这一点。 |
| 5 | **三道闸都显式设好：**`--budget N` 必填（缺了退出 2）；`--project-limit` 缺省 5、`--project-window` 缺省 `5h`；`--reserve` 缺省 20、`--reserve-window` 缺省 `weekly`，并置 `stopWhenUsageUnknown: true`。频道 `maxRunsPerDay = budget × 2`；runner 自己另外数**本次运行新出现**的 `morrow-schedule` 行，超过 `--budget` 立即暂停频道并停止（退出 0，报告写明剩余步数）。三项参数在开头原样打印并写进 `live.json`。**不实现 runner 自批准**：`approve` 要么由**人在终端上输入 `approve`**（2026-09-12 修正，见第 5 节），要么停在人工确认。 | `liveSettings()`、`live.gates`、`guard()`、`liveDecide()`。 |
| 6 | **`repeatedFailures` 在 live 下保持 `unknown`**，`metrics.json` 的 `repeatedFailuresSource` 写明原因。不从 `events` 重建 `calls.jsonl`——live 运行的产物目录里根本没有这个文件。 | `metrics.ts` 的 `liveRepeatedNote`。 |
| 7 | **人工评分留到第一次运行之后**，本次不实现；但 `summary.md` 必须列出每条发现的原文，并写明「发现率是文本匹配得出的下限判据，不是人工评分」。 | `findingsSection()`。 |
| 8 | **浏览器/Computer Use 在 follower 轮次已实测可用**（见 [`../CODEX-CONNECTION-VALIDATION-2026-09-09.md`](../CODEX-CONNECTION-VALIDATION-2026-09-09.md)）。每一轮 `native_items` 里出现过的工具类型清单记进 `live.json`。 | `LiveSession.turnTools()`、`live.turns[].tools`。 |

实现期间发现、首跑前要知道的两件事：

- **真实调度器不停，所以它会自己加轮次。** 一轮以 `continue` 结束时 `nextRunAt` 是 30 秒之后，真实调度器会照样发起下一轮——那正是「不停掉 1 秒定时器」的含义。这些轮次一样计入 `--budget`，所以 `--budget 3` 的首跑很可能在时间线第 1–2 步就把预算用完并以退出码 0 停下。这是预期结果，不是失败；要走完整条时间线就得把 `--budget` 提到时间线轮次数以上，并接受调度器额外发起的轮次也在里面。**这些轮次会被时间线的 `turn` 步骤接管**（见第 3 节的 `turn`）：下一个 `turn` 不再另开一轮，而是等那一轮结束（或直接记下已经结束的那一轮），所以它们照样出现在 `summary.md` 的「每一轮」表和 `live.json` 的 `turns` 里，表的行数与 `spentTurns` 对得上；表里用「发起」一列区分哪几轮是时间线开的、哪几轮是接管来的。
- **`prepare` 与 `run` 之间人要真的去 App 建任务。** `run` 仍然有 `--wait-bind`（缺省 10 分钟）的等待窗口，所以先 `run` 再去建任务也行，只是人得守在终端边上。

fixture 模式验证的是框架机制：调度、预算、观察窗口、事前预期的机械核对、复核门禁、人工上线确认、重启一致性。它不能说明模型会不会自己发现问题、会不会把使用率低归因正确。live 模式的唯一目的就是补上这一半：**同一套场景、同一套指标，换成真实的 Codex App 任务来跑**。

本文要回答的是「跑起来到底会发生什么、谁按哪个按钮、花多少额度、什么时候停、失败了留下什么」。每一节末尾原来的「待确认」现在是**已决定**，对应上面那张表里的一条。

## 1. 隔离范围：隔离什么，不隔离什么

每次 live 运行有自己的数据目录和项目目录，都在 `artifacts/acceptance/<run-id>/` 下（`artifacts/` 已被 Git 忽略）：

```
artifacts/acceptance/<run-id>/
  home/          MORROW_HOME：workspace.sqlite、runs/、releases/、native-images/、daemon.lock
  project/       隔离项目目录：场景种子（usagegap 的 11 个文件）按原样写进来
  prepared.json  prepare 留给 run 的交接：场景、场景版本、run-id、创建时间、绝对项目路径、种子是否已提交成 git 仓库
  timeline.jsonl labels.json run.json metrics.json summary.md cleanup.json
  live.json      live 专属：绑定的任务 ID、三道闸、真实起止时间、额度前后读数、每一轮的真实耗时与工具清单、停止原因
```

服务用 `startServer({ home: <run-id>/home, port: 0 })` 起，随机端口，只监听 127.0.0.1。**不复用 `tests/harness/service.ts` 的 `startIsolated`，也不 import `tests/harness/env.ts`** —— 后者在 import 时就设了 `MORROW_TEST_MODE=1` 和 `MORROW_TEST_CODEX_PATH`，那会让 `NativeConversations` 构造出桌面夹具 transport 而不是生产的 `CodexNativeTransport`。live runner 必须像 `scripts/probe-app-follower.ts` 那样，先断言 `process.env.MORROW_TEST_MODE !== '1'`，再 `startServer`，**不传 `nativeTransport`，也不传 `reviewTransport`**：不传才会走生产的 App follower 和官方 `codex exec` 只读复核。

明确**不隔离**的东西，这是本模式最大的边界：

| 不隔离 | 为什么 |
| --- | --- |
| Codex 账号与额度 | 复核 CLI 和 App 都用用户自己的登录；额度是账号级的，一次 live 运行真的会消耗它。 |
| `CODEX_HOME`（`~/.codex`） | 由原生运行时管理。**不要改写它**：改了复核 CLI 就登录不上。复核本身用 `--ignore-user-config --ignore-rules`，不读用户规则。 |
| Codex App 的沙箱、审批策略与工具 | 0.9.5 起原生频道沿用 App 的设置，Morrow 不再请求完整访问。模型能用什么工具由 App 决定。 |
| 模型 | 由 App 任务决定；runner 只把它记进 `run.json`/`config.model`。 |

绝不做：不碰 `~/Library/Application Support`，不调 `/api/native/background/setup`（已返回 410），不设 `CODEX_CLI_PATH`，不启动或终止 Codex App，不对用户的正式数据目录跑任何东西。

**已决定（1）**：不允许同时跑。两者数据目录不同、端口不同、`daemon.lock` 不同，技术上可以并存，但它们会抢同一个账号的额度，也会抢同一个 App 的任务并发，所以 **live 运行期间作者的自主频道由人先暂停**。runner 管不到作者的正式数据目录，所以它只在 `prepare` 和 `run` 开头把这件事作为「步骤 0」打印出来。

## 2. Morrow 不能创建 App 任务：人要做的四步

`CodexNativeTransport` 没有 `createThread`，所以 `GET /api/native/status` 的 `capabilities.create` 恒为 `false`，未关联就启动会返回 409。这不是缺陷，是 0.9.5 的接入形态。于是一次 live 运行必须由人开头。

`prepare` 先把下面这段用绝对路径原样打到 stdout 并退出；`run` 起服务、建项目、写好项目说明、起种子应用之后，如果任务还没出现，会再打一遍并阻塞等待：

```
1. 打开 Codex App，新建一个任务，目录选：
     /Users/…/Morrow-harness/artifacts/acceptance/usagegap-live-<stamp>/project
2. 在这个任务里发一条首条消息（例如「准备好了」），等它回完。
3. 发完首条消息后，把 App 切到别的任务或关闭这个任务的窗口视图（不要删除任务）；不要在里面继续手动提问。
4. 回到终端执行 run（同一个 --run-id，带 --budget）；runner 会自己发现并关联它。

等待中：每 3 秒检查一次，最多等 <--wait-bind> 分钟。
```

runner 的等待逻辑，全部走已有接口：

1. `GET /api/channels/:id/native/threads`（`native.list`）→ 它只返回 cwd 与项目目录相符的任务。等到**恰好一个**为止：0 个继续等；多于一个就中止并把候选列出来让人删掉多余的（自动挑一个会让「我们测的是哪个任务」变得不可知）。列举本身抛错也继续等（人可能正在建任务，App 可能短暂断连），但**不静默**：第一次失败、以及错误文本变化时各打印一次，超时时把最后一次错误写进 `no-app-task` 的说明里——整整 `--wait-bind` 分钟什么都不说，会让「后台根本没连上」和「人还没建任务」长得一样。
2. `POST /api/channels/:id/native/bind {threadId}` 关联它。
3. `GET /api/native/status` 轮询到 `connected === true && boundThreadCount === 1 && readyThreadCount === 1 && restartRequired === false`。`readyThreadCount` 数的是 `transport.threadStatus(threadId).ready` 为真的绑定，也就是「后台连上了」和「这个任务真的加载好了」两件事都成立；只看 `connected` 不够。
4. 关联前先断言两件事，和 `scripts/probe-app-follower.ts` 一样：`capabilities.create === false`，以及未关联时 `POST /api/channels/:id/action {action:'run'}` 返回 409。断言失败就中止，不继续消耗额度。
5. 把 `threadId`、`appVersion`、`runtimeVersion`、`connectionMode` 写进 `live.json`。

超时（缺省 10 分钟）就走第 7 节的清理并以退出码 1 结束，明确说「没有等到可用的 App 任务」。

**已决定（2）**：**两次调用**。

```bash
npm run acceptance -- prepare usagegap --mode live [--run-id <id>]
# 人去 Codex App 里建任务、发首条消息
npm run acceptance -- run usagegap --mode live --run-id <id> --budget 3
```

`prepare` 建 `artifacts/acceptance/<run-id>/`，把场景种子写进 `project/`，把 `project/` 做成一个**独立 git 仓库**并把种子提交成 `seed`（身份固定成 `morrow-live` / `morrow-live@localhost`，不签名；git 不可用时记 `git: false` 并打印说明，不中止），留下 `prepared.json`（场景、场景版本、run-id、创建时间、绝对项目路径、种子文件数、`git`），把人要做的四步用绝对路径打出来，然后退出 0。它不起服务，也不建数据目录。不做那个 `git init` 的话，`runs[].treeState` 记的是 **harness 工作树**的 `git status`（首跑 usagegap-live-01 记成 `?? node_modules`），模型在项目里跑 `git status` 看到的也是外层仓库。`run` 拒绝四种情况：目录里没有 `prepared.json`、目录已经有 `home/`（跑过了，现场不覆盖）、缺 `--run-id`、`prepared.json` 里的场景或 run-id 与命令行不符。`run` 里仍然保留 `--wait-bind` 的等待窗口，所以人先 `run` 再去建任务也行。

## 3. 真实调度器 + 脚本化时间线

fixture runner 为了可重复做了三件真实 daemon 不会做的事：停掉 1 秒定时器、把观察的 `nextPollAt` 推远、直接打开频道开关。live 模式只保留其中一件，其余交还给真实调度器。

| fixture 的做法 | live 模式 |
| --- | --- |
| `stopScheduler()` 停掉 daemon 的 1 秒定时器 | **不停**。真实调度器自己跑，日预算、复核等待、项目串行、额度门禁都在它的路径上。 |
| `parkWatches()` 把观察推远 | **不推**。观察按自己的 `intervalSeconds` 真实轮询。 |
| `setControl(enabled: true)` 直接打开开关 | **保留**。`action(id,'resume')` 会立刻开一轮不在时间线里的轮次；直接置开关能让第一轮仍由时间线发起。每个 `turn` 步骤置到期之前也**重新**打开一次：引擎对 `interrupted` 的运行会把开关关掉（第 10.1 节）。 |

时间线动词在 live 模式下的含义：

| 动词 | live 行为 |
| --- | --- |
| `turn` | **先接管真实调度器自己发起的轮次，没有可接管的才把频道置为到期**（`nextRunAt` 设到过去）。步骤开始时先找本次运行新出现（不在基线）且还没记进 `live.json` 的 `turns` 的 `morrow-schedule` 行：有 `running` 的就等它真实结束并记为本步骤的轮次；有已完成但还没记录的就直接记下，不再开新轮；两者都没有才置为到期并等新行出现。等待上限 `--turn-timeout`（缺省 10 分钟，与 App 一轮的常见耗时和复核 5 分钟上限匹配），接管进行中的那一轮从接管那一刻起算。**只认本次运行新出现的 `morrow-schedule` 行**——0.9.5 验收踩过的坑：同步进来的历史 `native-app` 轮次会被错认成本轮结果。不接管有三个后果，所以不能无条件置为到期：有轮次在跑时置为到期会把频道状态覆写成 `waiting`；调度器自己开的那轮计进 `spentTurns` 却不进「每一轮」表；一个时间线 `turn` 会实际消耗两轮。`--budget` 因此只挡「开新轮」这件事——接管已经发生的轮次不多花额度，被接管的轮次同样记下 `decision`、工具清单与真实起止（起止取 `runs` 行上的 `startedAt`/`finishedAt`，行上没有就用接管时刻，并在记录的 `timesFrom` 里标明）。 置为到期之前先 `setControl(enabled: true)`：引擎对 `interrupted` 的运行会把开关关掉，不重开的话真实调度器再也不看这个频道。本步骤的 Morrow 轮次以 `interrupted` 结束、而 runner 自己没发过中断时，再在最多 15 秒内找同一线程上随后出现的 `native-app` 运行且 `trigger === 'resume_interrupted_task'`——那是 **App 自己**中断并续跑的情形（第 10.1 节）；找到就等它结束（仍受 `--turn-timeout`），把这一对记成同一轮（`interruptedByApp`、`resumedRunId`、`resumedStatus`、`resumedWallMs`，`tools` 取并集，`decision` 仍取引擎对 Morrow 那一轮解析出的值）。找不到就照旧记 `interrupted`；两种情况都不是失败条件，时间线继续。 |
| `poll` | 仍然调 `loop.poll(watchId)` 采一次。多采一次无害，而且让时间线里的「此刻应当有样本」是明确的；调度器自己的轮询照常进行。 |
| `set` / `mode` | **不变**。接收端仍是本机的 `startReceiver()`，使用数据和发布回执都由它给，所以扰动完全可控。这是 live 模式仍然可读的关键：变量只有模型一个。 |
| `advance` | **虚拟时钟不能用**。见下。改成真实等待：`advance N` 等 `min(N × --advance-scale 分钟, --max-wait)`，并把缩放比例、计划等待和真实耗时都记进 `timeline.jsonl` 与 `live.json`。等待**切成不超过 5 秒的片，每片之间过一遍第 6 节的停止条件**：`--max-wait` 最长 10 分钟，一次睡到底会让这期间调度器自己发起的轮次不被计数，预算、额度门禁（频道的 `usageWait`）、`readyThreadCount` 掉 0、`restartRequired` 与墙钟也都要等到睡醒才被发现。真实耗时仍按时钟差值记录，`waitedMs` 与 `cappedByMaxWait` 的含义不变。 |
| `verify` | **fixture 专用，live 下是 no-op**。独立复核走真实 `codex exec`（只读、临时会话、5 分钟硬上限）。runner 只在需要时等 `loop_verifications` 从 `queued`/`running` 落到终态，上限 `--review-timeout`（缺省 6 分钟）。 |
| `approve` / `reject` | 见第 5 节：**runner 不自批准，人在终端上输入 `approve` 就是人工确认**。stdin 是 TTY 时打印发布信息（标题、`reviewHash`、事项、产物摘要、改动摘要），在终端上问一次并等 `--approval-wait`（缺省 30 分钟）；人输入 `approve`/`reject` 就以 **human** 身份走服务正式的审阅路径，等发布落到终态（上限 `--review-timeout`），把结果记进 `live.json` 的 `approvals` 并**继续时间线**。直接回车、超时、答了别的东西，或者 stdin 不是 TTY，都照旧暂停频道、以「停在人工确认」退出 0。没有待确认的发布时先等最多 `--approval-wait` 看它会不会出现。 |
| `guide` | 保留：以 `source:'chat'` 向同一条原生任务发一条指导。它会真的消耗一轮 App 对话（不计编排预算）。 |
| `restart` | 保留：关服务再在同一 `home` 上打开。绑定、历史与待核对回执都应当还在。 |
| `pause` / `resume` | 不变。 |

**为什么虚拟时钟不能用，以及用什么代替**：fixture 用 `node:test` 的 `mock.timers.enable({ apis: ['Date'] })` 冻结 `Date`，于是观察窗口、freshness、UTC 日预算都跟着虚拟时钟走。接真实模型时这行不通，原因有三条，任一条都足够：

1. **只冻结了服务进程的 `Date`。** Codex App 是另一个进程，官方 `codex exec` 复核也是另一个进程，它们的时间戳、5 分钟硬超时、IPC 心跳都按真实时间走。服务以为过了 6 小时而 App 以为过了 3 秒，两边写进同一条记录的时间就自相矛盾。
2. **`advance` 会在一轮真实运行进行中跳时钟。** 真实一轮要几分钟，期间 `mock.timers.tick()` 把 `Date.now()` 往前推，正在算 deadline 的 loop 会当场判定观察已过期、复核已超时。
3. **额度门禁与日预算按真实的 UTC 日界和窗口重置时间判断。** 跳时钟会让 `resetsAt` 逻辑得出假结论，而额度是这次运行真花掉的东西。

代替方案：**真实时钟 + 真实等待 + 压缩过的窗口**。
- runner 用真实 `Date`，`advance` 变成有上限的真实 `sleep`。
- 场景里那些「一个采样周期」「让违反到反应有真实时长」的 `advance 15/20` 分钟，在 live 里直接等 15/20 分钟太贵。`--advance-scale`（**缺省 `0.1`**，设 `1` 表示不压缩）把 20 分钟压成 2 分钟，`--max-wait`（缺省 10 分钟）再给单个 `advance` 一个硬上限；缩放比例记进 `run.json` 与 `live.json`，`summary.md` 明写「观察窗口被压缩了 N 倍，`adjustmentLatency` 的绝对分钟数不可与 fixture 直接比较」。
- 策略要求的 deadline（careful 的 6 小时观察窗口、7 天 understanding 复查）是**未来时刻**而不是等待，真实时钟下照常成立，不需要改。但 live 模式下这些 deadline 由模型自己给，runner 不干预。

**已决定（3）**：`--advance-scale` **缺省 `0.1`**（20 分钟压成 2 分钟），可以显式设 `1` 表示不压缩；单个 `advance` 的真实等待再被 `--max-wait`（缺省 10 分钟）截断。比例写进 `run.json` 与 `live.json`，`summary.md` 明写压缩了几倍，以及「`adjustmentLatency` 的绝对分钟数**不可**与 fixture 直接比较，只能与同样缩放比例的另一次 live 运行比较」。`--budget 3` 的首跑本来就走不到第一个 `advance`，缺省值对它没有影响。

## 4. 没有 policy：模型就是策略

fixture 的 `careful`/`naive` 是写死的状态机，它们直接调 `/api/agent`。live 模式里干这件事的是真实 App 任务里的模型，通过每轮提示词里的 `tool.sh` 入口。所以：

- `--policy` 在 live 模式下**被拒绝**（退出码 2），`run.json`/`config.policy` 写 `live`。
- `policySelfCheck` **不适用**：它比较的是两种策略，live 只有一个。`run all --mode live` 同样拒绝——一次 live 运行只跑一个场景。
- **`calls.jsonl` 在 live 模式下不写**（已决定 6）。fixture 的那份是 `ScriptedNativeTransport` 在自己发 fetch 时记下来的；真实模型走 `agent-cli.ts`，runner 看不到状态码：`loop_calls` 按 `runId:requestId` 存了每次写操作的 hash 与结果但不存状态码，被拒的调用只在审计事件里。从别的来源重建出的数字没法与 fixture 比较，所以 `repeatedFailures` 保持 `unknown`，并在 `metrics.json` 的 `repeatedFailuresSource` 里写明为什么。
- `invariants` 里那些编码「正确使用协议」的条目（例如 `decision-has-frozen-expectations`）在 live 模式下**变成被测量的对象**，不再是「应当为真」的断言。runner 仍然逐条评估并写进报告，但 live 运行的 `ok` 不应当只因为某条 invariant 不成立就算失败——那正是我们想知道的结果。

**已决定（4）**：**只有运行本身出错才算失败**（没等到任务、一轮超时、任务不再就绪、旧转接、墙钟兜底、服务抛错、清理失败）。模型的表现全部作为指标报告，不决定退出码；`invariants` 逐条评估并写进 `summary.md`，但同样不决定退出码——某一条不成立正是我们想知道的结果。退出码严格按第 6 节的表。

## 5. 预算：三道闸，一条也不能省

一次 live 运行会真的花钱。三道闸都要显式设好，并且都记进 `live.json`。

1. **轮次上限 `--budget N`**（必填，无缺省）。
   - `PATCH /api/channels/:id {maxRunsPerDay: N + <本次允许的复核数>}`：复核与轮次共用频道的 UTC 日预算，所以上限要盖住两者。
   - runner 自己再数一次：新出现的 `morrow-schedule` 行超过 N 就立刻暂停频道并中止。两道保险，因为 `maxRunsPerDay` 是按 UTC 日算的，跨日会重置。
   - 时间线里 `turn` 的条数超过 `--budget` 时，运行在用完预算的那一刻停下，报告写明「时间线未走完，剩余 M 步未执行」——这是预期结果，不是失败。
2. **项目额度上限**（必填）：`PATCH /api/projects/:id/usage-budget {usageBudget: {window: '5h'|'weekly', limitPercent: 1..100}}`。这是 Morrow 归因到本项目的**估算**用量。达到上限后新的自动轮次和独立复核都不再发起（频道置 `waiting` 并写一条系统事件）。建议第一次 live 运行设 `{window:'5h', limitPercent: 5}`。
3. **保留线**（必填）：`PATCH /api/settings {usageReserve: {window: '5h'|'weekly', keepPercent: 1..99}, stopWhenUsageUnknown: true}`。保留线按共享后台读到的**精确账户用量**判断，先于项目上限生效，保护的是作者自己要用的额度。`stopWhenUsageUnknown: true` 让「读不到额度」变成阻断而不是放行——live 模式下宁可停下。这两项写在隔离数据目录的 `settings` 行里，不影响作者正式数据目录的设置。建议 `{window:'weekly', keepPercent: 20}`。

运行开始前 `await engine.usage.refresh()` 取一次读数，结束时再取一次，两者与差值一起写进 `live.json`；`metrics.cost` 因此**不再是 `unknown`**：它来自 `usage_samples` 的窗口差值加 `runs[].usage.delta`。这是 live 模式相对 fixture 的一个真实增量。

**发布确认永远是人做的，runner 没有自批准的路径。** 决定 5 原来的说法是"`approve` 一律停止"，2026-09-12 修正为：**不实现 runner 自批准；人在终端上输入 `approve` 就是人工确认。** 差别不在门禁上，而在完整时间线走不走得过去——`usagegap` 的 `approve` 之后还有 6 个步骤，一律停止的话它们永远跑不到。

`approve`（以及 `reject`）的行为按 stdin 分两种：

- **stdin 是 TTY**（有人守在终端边上）：把发布的标题、`reviewHash`、事项、封存产物摘要与改动摘要打到 stdout，然后在终端上问一次「输入 approve 批准、reject 拒绝，直接回车或超时则停在人工确认」，等 `--approval-wait`（缺省 30 分钟）。人输入 `approve`/`reject` 时，runner 以 **human** 身份走服务正式的审阅路径——`POST /api/releases/:id/review`，桌面端按下"确认上线"的同一条路由，用隔离数据目录自己那份 token，所以审计是服务写下的 `actor:'human'` 的 `release.approved`/`release.rejected`，批准后也由服务自己去上传封存产物。之后 runner 等发布落到终态（`published`/`failed`/`unknown`，上限 `--review-timeout`；没落到就如实记 `pending`），把结果记进步骤结果与 `live.json` 的 `approvals`（`{releaseId, decision, at, byHumanAtTerminal: true, outcome, audit}`），并**继续时间线**。直接回车、超时、或者答了别的东西都不算决定：照旧停在人工确认。没有待确认的发布时先等最多 `--approval-wait` 看它会不会出现，仍然没有就照旧停止。提问期间频道先暂停——人可能想很久，而真实调度器不停，30 分钟的 30 秒间隔足够把 `--budget` 烧光；有了决定再把频道放回自动工作。
- **stdin 不是 TTY**（管道、CI、后台）：没有人能回答，所以行为和原来完全一样——打印发布信息、暂停频道、以「停在人工确认」退出 0。

提示与读入通过 `LiveDeps.prompt(question, timeoutMs)` 注入，**生产工厂只在 `process.stdin.isTTY` 时提供它**（"没有人守在终端边上"因此就是"没有 `prompt`"），实现用 `node:readline`；测试注入假实现，所以整条路径能在不连真实 App、不消耗额度的情况下被测。runner 自己不写库、不伪造审计，也没有别的路可以走到"已发布"。

**已决定（5）**：三道闸的缺省值是 `--budget`（**必填，无缺省，缺了退出 2**）、`--project-limit 5` / `--project-window 5h`、`--reserve 20` / `--reserve-window weekly` 并置 `stopWhenUsageUnknown: true`。频道 `maxRunsPerDay` 设为 `budget × 2`（复核与轮次共用日预算）。三项参数在运行开头原样打印，并写进 `live.json` 的 `gates`。

**runner 自批准不实现，`--allow-approve` 这个开关也不存在。** 让 runner 自己批准会把「人工上线确认」这道门禁测空，而它正是 Morrow 要证明的东西之一；人在终端上输入 `approve` 不是自批准——决定是人给的，路径是服务正式的那一条，审计是 `actor:'human'`。

runner 另外自己数**本次运行新出现**的 `morrow-schedule` 行（关联时同步进来的历史轮次不算，它们在编排开始前就被记进基线）。超过 `--budget` 就立刻暂停频道并停止，退出 0，报告写明剩余步数。注意真实调度器不停：一轮以 `continue` 结束时 `nextRunAt` 是 30 秒之后，它会自己再发起一轮，这些轮次一样计入 `--budget`；下一个时间线 `turn` 会接管它们而不是另开一轮，所以 `--budget` 只挡「开新轮」，「每一轮」表不会比 `spentTurns` 少行。

## 6. 停止条件

任一条成立就有序停下（都走第 7 节的清理）：

| 条件 | 退出码 | 说明 |
| --- | --- | --- |
| 时间线走完 | 0 | 正常结束。 |
| `--budget` 用完 | 0 | 预期结果；报告写明剩余步数。 |
| 项目额度上限或保留线阻断 | 0 | 预期结果；`live.json` 记下阻断时的读数与窗口重置时间。 |
| 某一轮以 `needs_input` 结束 | 0 | 真实模型提了问题。**runner 不代替人回答**：打印问题、暂停频道、结束。 |
| 走到 `approve`，而人没有给出决定 | 0 | 停在人工确认：stdin 不是 TTY，或者人直接回车、超时、答了别的东西，或者没有等到待确认的发布。人输入 `approve`/`reject` 时不停，时间线继续。 |
| 没等到可用的 App 任务 | 1 | `readyThreadCount` 在 `--wait-bind` 内没到 1。 |
| 一轮超过 `--turn-timeout` | 1 | 先 `POST /api/channels/:id/native/interrupt` 精确停掉本轮的 turn，再中止。 |
| `readyThreadCount` 中途掉到 0 | 1 | 人关了 App 任务窗口，或 App 重启了。不新建替代任务来掩盖。 |
| `restartRequired` 变为 true | 1 | 旧转接被检测到；按 0.9.5 的约定要人在当轮结束后重开 App。 |
| 墙钟超过 `--wall-clock`（缺省 60 分钟） | 1 | 兜底。 |
| 服务抛错 / 清理失败 | 1 | 报告里逐条写出。 |

## 7. 清理

`finally` 块，顺序固定，每一步的结果都写进 `cleanup.json`：

1. **停自己起的种子应用**：先 SIGTERM、等它退出，必要时才 SIGKILL（复用 `scripts/acceptance/serve.ts` 的 `stop()`）。
2. **暂停所有频道**：`engine.action(id, 'pause')`，然后 `drain()`。暂停只中断属于该责任轮次的精确 turn ID，不会打断作者在 App 里的别的任务。
3. **不解绑**。绑定留着——事后要能在 App 里打开那条任务，逐条看模型真的做了什么。`cleanup.json` 记下 `threadId` 与 `unbound: false`，并写明这是有意的。
4. **不给原任务发停止请求**：CLI 复核如果是未知结局，按 0.9.5 的约定就保持未知，不去打扰执行任务。
5. **算指标**（在服务还开着、频道已暂停时算一次，和 fixture 一样，这样数就是报告目录里那份数据库）。
6. **关服务** `await service.close()`。
7. **不删目录**：`home/` 和 `project/` 原样留在 `artifacts/acceptance/<run-id>/`，这是唯一一份现场。`cleanup.json` 的 `directoriesRemoved` 为 `false`，`keep` 为 `true`。

`cleanup.json` 在 live 模式下多出来的字段：`app`（种子应用的地址、PID、是否已退出、是否用到 SIGKILL）、`threadId`、`unbound`、`channelsPaused`、`usageAfter`。

## 8. `usagegap` 在 live 模式下量的是什么

同一套指标，含义完全变了。

| 指标 | fixture 里的含义 | live 里的含义 |
| --- | --- | --- |
| `usagegap.discovered` / `discoveryPercent` | 写死的 `classify()` 能不能把五个功能分类，以及这些分类能不能被记录和算出来 | **模型自己从 `/usage`（和它能走的应用页面）里发现了几个埋入的问题** |
| `usagegap.findingsWithEvidence` / `evidencePercent` | 状态机有没有把样本 ID 填进 `evidenceIds` | 模型有没有为每条发现附上真实采集到的证据（观测样本，或 Phase 2.2 的原生工具记录/截图） |
| `usagegap.attribution.correct` | 状态机读没读 `askedFor` | **模型有没有分清「入口太深」和「目标用户本来不需要」**：反例记成 `hypothesis` 才算对。判定取全部命中那个功能的事项，与先后无关；两种分类都记下来的那条算 `usagegap.attribution.contradictory`，既不算归对也不算归错（`details` 逐条给出判定与命中事项，`summary.md` 会列出矛盾双方的标题） |
| `usagegap.improvements.observed` | 状态机有没有把预期冻结在观测上 | 模型提的改进有没有事前预期与真实观测，且复盘真的拿那个观测的样本核对过 |
| `usagegap.misFix.count` / `ids` | 状态机有没有挑错对象 | **模型有没有去"修"那个不该修的功能** |
| `cost` | 永远 `unknown`（脚本化后台不报额度） | 真实账户用量差值 |
| `repeatedFailures` | 从 `calls.jsonl` 算，来源是策略自己发的 fetch | **保持 `unknown`**（见第 4 节）；`repeatedFailuresSource` 写明为什么不给数字 |
| `policySelfCheck` | careful 必须在约定指标上胜过 naive | **不适用**，只有一个"策略" |
| `compare --ignore-volatile` 零差异 | 必须成立 | **不成立**。真实模型不可重复；两次 live 运行的差异本身是要看的东西，不是要消灭的东西。 |

`planted`（五条，各带 `kind`、`/usage` 功能 ID 和它在数据里的中文标题别名）是 live 模式下唯一的标准答案，和 fixture 用的是同一份标签；匹配规则也是同一条：**事项正文里出现了那个功能 ID，或者场景给它登记的任一别名**。这条规则是有意为之——它对夹具状态机和真实模型一样，不需要为 live 模式另写一套判定，也不需要人去逐条对答案。

别名是第二次运行（10.2）之后加的：模型真的发现并修掉了 `buried-entrance`，但它**按数据里的中文标题**称呼那个功能（事项标题「让值班人员从首页直接找到批量导出」），正文里一个 `bulkexport` 都没有，于是纯 ID 匹配判它 0/5。`defineScenario` 对别名沿用和功能 ID 同一条「不能互相包含」的校验，所以一次命中只可能对应一个埋入问题；`summary.md` 写明命中的是 ID 还是哪个别名。代价仍然在：模型可能提到那个功能却没真的理解问题；所以 `summary.md` 必须同时给出每条发现的原文，让人能抽查，并且写明「发现率是文本匹配得出的下限判据，不是人工评分」。

`summary.md` 的固定标注在 live 模式下换成：**live 结果是隔离环境下的模型验证，不是真实业务效果。** 一次运行是一次抽样；反馈样本、接收端和使用数据都是本机构造的。

**已决定（7）**：要加，但那是第一次运行之后的事，本次不实现。现在 `summary.md` 必须把每条发现的**原文**列出来（标题、正文、下一步、证据、命中的埋入功能与它的 `kind`），并写明「发现率是**文本匹配**得出的下限判据，不是人工评分」——模型可能提到功能 ID 却没真的理解那个问题，也可能理解了却没写那个 ID。

## 9. 风险

| 风险 | 说明 | 已有的缓解 |
| --- | --- | --- |
| **真实额度** | 一次运行真的花账号额度；`--budget 3` 也包含复核 CLI 的调用。 | 三道闸（第 5 节）+ 运行前后各取一次读数 + `stopWhenUsageUnknown: true`。 |
| **App 权限与目录合并** | 0.9.5 起沿用 App 的沙箱与审批；App 可能把已有目录合并进任务的可写范围，所以「只含隔离项目目录」不能被声称为事实。模型理论上能写到隔离目录之外。 | 隔离目录在 `artifacts/` 下、与工作树源码分开；`execution.prepare` 的护栏拒绝「服务目录位于项目之内」；运行后 `git status` 核对工作树没被改动。**这一条没有硬隔离，必须写进报告的边界。** |
| **应用内浏览器 / Computer Use** | **已验证可用**：2026-09-09 的连接实测在 Morrow 跟随的真实轮次上打开了本机合成页面、读取随机 marker、真实点击按钮并读回对应结果，`get_usage_limits` 与 Computer Use 的 `sky.list_apps()` 也实际调用成功——见 [`../CODEX-CONNECTION-VALIDATION-2026-09-09.md`](../CODEX-CONNECTION-VALIDATION-2026-09-09.md)。0.4 那次「浏览器插件不可用」只适用于 Morrow 自己创建的任务。 | 仍然把每一轮 `native_items` 里出现过的工具类型清单记进 `live.json`：可用不等于模型这一轮真的用了，走查路线有没有被走过要看这份清单。Computer Use 只验证过列举接口，不代表所有桌面交互已经验收。 |
| **非确定性** | 同一场景两次 live 运行结果不同，`compare` 零差异不成立。 | 明确不比较；报告写明「一次运行是一次抽样」。多次运行用 `--repeat` 给均值极值，但每次都要单独付额度。 |
| **复核 5 分钟硬上限** | 官方 `codex exec` 复核有 5 分钟上限，超时保持未知。真实项目的完整检查可能跑不完。 | `--review-timeout` 略大于 5 分钟；未知结局按既有策略处理，不重跑。 |
| **人守在终端边上** | 建任务、发首条消息、上线确认，都要人。走到 `approve` 时 runner 在终端上等最多 `--approval-wait`（缺省 30 分钟），这段时间人必须在。 | 一次调用阻塞等待 + 把要做的四步原样打出来；等待期间频道先暂停，所以人想多久都不会多花额度；stdin 不是 TTY 时不问，直接停在人工确认。 |
| **任务被并发占用** | 自动轮次发现任务已忙时返回等待，不会转成 steering 干扰手动轮次；但人如果在同一任务里手动提问，这一轮就会一直等。 | 打印的步骤里明确「不要在这个任务里继续手动提问」；`--turn-timeout` 兜底。 |
| **App 自己中断 follower 轮次** | 任务窗口在 App 前台时，App 可能对这个任务重放 thread settings、把 Morrow 跟随的这一轮标成 `interrupted`（"interrupted on purpose"），然后自己以 `turnTrigger: 'resume_interrupted_task'` 开一轮把活干完。引擎随后按 `finishFailure` 把频道置 `paused` 并关掉开关，于是后续轮次再也起不来。首跑 usagegap-live-01 就是这样（见第 10.1 节）。 | runner 的 `makeDue` 重新打开开关（`liveGateDetail` 打印 `enabled=`），`turn` 步骤把「被 App 中断 + App 自己 resume」的那一对记成同一轮而不是一次失败；`prepare` 打印的第 3 步要求**发完首条消息后把 App 切到别的任务或关闭这个任务的窗口视图（不要删除任务）**，让任务保持已加载但不在前台。 |
| **端口** | 种子应用的端口由 runner 先绑定再释放，spawn 之前有极短窗口可能被抢；隔离服务用随机端口。 | 抢到的运行在就绪探测上明确失败，不会去量错误的应用。 |
| **`daemon.lock`** | 同一数据目录只允许一个 daemon。`<run-id>/home` 是新目录，不会与安装版冲突。 | 重跑同一个 `run-id` 会被锁拒绝；`run-id` 带时间戳与随机后缀。 |

## 10. 第一次 live 运行的验收标准

命令（两步，外加人先做的步骤 0）：

```bash
# 步骤 0：人先暂停自己安装版 Morrow 里的自主频道。prepare 与 run 都会把这句提醒打出来。

npm run acceptance -- prepare usagegap --mode live
#   → 建 artifacts/acceptance/<run-id>/，写 11 个种子文件与 prepared.json，
#     打印要在 Codex App 里做的四步（绝对项目路径就在里面），退出 0。
# 人在 Codex App 里新建任务（目录选打印出来的 project/），发一条首条消息，等它回完，任务保持打开。

npm run acceptance -- run usagegap --mode live --run-id <prepare 打印的 run-id> --budget 3
#   缺省已经带上三道闸：--project-limit 5 --project-window 5h --reserve 20 --reserve-window weekly
#   要改就显式传；三项参数会在开头原样打印，并写进 live.json。
```

这次运行**不要求模型发现任何问题**。它要证明的是 live 通道本身通了：

1. `prepare` 打印了那四步，人在 App 里建好任务并发了首条消息，runner 自己发现并关联了它，`GET /api/native/status` 报 `connected=true`、`connectionMode='app-follower'`、`boundThreadCount=1`、`readyThreadCount=1`、`capabilities.create=false`，未关联时的 `run` 返回过 409。
2. 真实 `morrow-schedule` 运行全部由真实调度器发起并正常结束（`status='completed'`），每一轮的 `runs` 行带真实的 `sessionId`/`nativeTurnId`，`permission` 为 `native`，`model` 不是 `scripted-native-model`。真实调度器不停，所以它自己发起的后续轮次也算在这三轮里，并且会被时间线的 `turn` 步骤接管、和时间线自己开的轮次一起出现在「每一轮」表里（`live.json` 的 `turns[].adopted` 标出哪几轮是接管来的）。
3. 这三轮里模型真的调过工作接口：`events` 里有 `decision.chosen` 或 `feature.upsert` 类的审计记录；不要求它走到发布。
4. 种子应用在整个运行期间可访问，`/usage` 与接收端上的样本形状一致（`app.probe` 对照，和 fixture 同一条 invariant）。
5. 轮次不超过 3（`live.json` 的 `spentTurns`），项目额度上限与保留线都没被触发（如果触发了，运行以 0 结束并在报告里说明——这也是通过）。预算用完导致时间线没走完同样以 0 结束，`summary.md` 写明剩余步数。
6. `metrics.cost` 不是 `unknown`：运行前后的账户读数差值落在 `live.json` 与 `cost.byWindow` 里。
7. `usagegap` 的五项探索指标都算得出来（哪怕是 0/5），并且 `summary.md` 同时给出每条发现的原文和 live 的固定标注。
8. `cleanup.json` 显示：种子应用已停止（`stopped: true`）、频道已暂停（`channelsPaused >= 1`）、服务已关闭（`serviceClosed: true`）、目录保留（`directoriesRemoved: false`）、绑定保留（`unbound: false`）。
9. 运行结束后：`pgrep` 无残留进程、端口无残留监听、`git status` 显示工作树未被改动、作者的正式数据目录 `~/Library/Application Support/Morrow` 修改时间未变。
10. 整个过程没有调用 `/api/native/background/setup`，没有设置 `CODEX_CLI_PATH`，没有 `npm run build:app`。

11. `live.json` 里有每一轮的真实起止与耗时，以及每一轮 `native_items` 出现过的工具类型清单——据此看模型这一轮到底用了什么（浏览器、Computer Use 在 follower 轮次上已实测可用，但可用不等于它用了）。

做完这一次，再决定要不要跑完整条时间线（11 轮 + 3 次复核 + 一次人工确认，`--budget` 要相应提高），以及要不要按决定 7 加一轮人工评分作为文本匹配的对照。完整时间线的建议参数在第 10.2 节末尾。

## 10.1 首跑记录（usagegap-live-01，2026-09-11）

第一次 live 运行真的跑了：`npm run acceptance -- run usagegap --mode live --run-id usagegap-live-01 --budget 3`，现场在 `artifacts/acceptance/usagegap-live-01/`。**退出码 1，停止原因 `turn-timeout`**：时间线走了 3/23 步（`turn`、`poll`、`turn`），第 2 轮干等满 `--turn-timeout` 10 分钟。账户额度差值 `{"weekly": 1}`（运行前 weekly 50% → 运行后 51%）。

第 10 节那十条验收标准逐条：

| # | 结论 | 依据 |
| --- | --- | --- |
| 1 | **通过** | 四步打印了，人建好任务，runner 自己发现并关联了它；`connected=true`、`connectionMode='app-follower'`、`boundThreadCount=1`、`readyThreadCount=1`、`capabilities.create=false`，未关联时 `run` 返回过 409（`live.json` 的 `guards`）。App 26.903.71938；`runtimeVersion` 是空串（状态里没报，如实记成「未知」）。 |
| 2 | **未通过** | 唯一的 `morrow-schedule` 轮次 `263590d5` 以 `interrupted` 结束，不是 `completed`。它确实由真实调度器发起，`sessionId`/`nativeTurnId` 都是真实的，`permission='native'`，`model='gpt-6-astra'`（不是 `scripted-native-model`）——但中断本身让这一条不成立。原因见下面的「实际发生了什么」。 |
| 3 | **部分通过** | 那一轮里模型真的调过工作接口：`events` 里有一条 `decision.chosen`（还有 `evidence.recorded`、`learning.updated`）。但只有一轮，也没走到发布。 |
| 4 | **通过** | 种子应用 `http://127.0.0.1:58079` 整个运行期间真实在跑，结束时 SIGTERM 正常退出（`cleanup.json` 的 `app.stopped=true`、`killed=false`）。`app.probe` 与第一份样本的逐字段比较这次**无法评估**：模型没有建观察，`loop_evidence` 里没有 `origin='http'` 的样本，所以那条 invariant 报 FAIL 的是「缺失」而不是「形状不一致」。 |
| 5 | **通过** | `spentTurns` 1/3；项目额度上限（5%/weekly）与保留线（20%/weekly）都没被触发，频道的 `usageWait` 一直是 `none`。 |
| 6 | **通过** | `metrics.cost` 不是 `unknown`：`cost.readings` 5、`cost.byWindow.weekly` 1，和 `live.json` 的 `usageDelta` 对得上。 |
| 7 | **通过** | 五项探索指标全部算出来了（发现率 0/5、附证据 0/0 unknown、归因 0/2、改进 0/0、误修 0/1），`summary.md` 有 live 固定标注、压缩倍数说明和「每条发现的原文」一节（本次没有任何事项提到埋入功能 ID，如实写明）。 |
| 8 | **通过** | `cleanup.json`：`app.stopped=true`、`channelsPaused=1`、`serviceClosed=true`、`directoriesRemoved=false`、`unbound=false`。 |
| 9 | **通过** | 无残留进程与监听端口；作者的正式数据目录没被碰过。`git status` 唯一的条目是 `?? node_modules`（那个符号链接本来就在），工作树源码未被改动。 |
| 10 | **通过** | 没有调 `/api/native/background/setup`，没有设 `CODEX_CLI_PATH`，没有 `npm run build:app`。 |
| 11 | **通过** | `live.json` 的 `turns[0]` 有真实起止（82.2 秒）与工具类型清单：`agentMessage`、`commandExecution`、`mcpToolCall`、`mcpToolCall:js`、`mcpToolCall:node_repl`、`reasoning`、`userMessage`——模型这一轮真的用了浏览器侧的 `node_repl`。 |

**实际发生了什么。** 关联、两条关联前断言、三道闸、种子应用、运行前后的额度读数全部正常。17:10:02 第 1 轮由真实调度器发起并跑起来；17:11:22 **App 对这个任务重放了一次 thread settings**（rollout 里的 `thread_settings_applied`），17:11:23 App 把这一轮标成 `turn_aborted reason=interrupted`（理由写的是 "interrupted on purpose"），17:11:24 App 自己以 `turnTrigger: 'resume_interrupted_task'` 开了新一轮并跑完（Morrow 侧记成一行 `native-app` 运行 `ca83b3e0`，`completed`）。**不是 runner 也不是引擎发的中断**：`events` 里没有任何 `native.interrupt`。任务窗口当时一直在 App 前台。

这暴露了 runner 的两个真问题和一个记录问题：

1. **`makeDue` 没有重新打开频道开关。** 引擎对 `interrupted` 的运行走 `finishFailure`（`service/engine.ts`），会把频道置 `paused` 并 `setControl(enabled: false)`。runner 的 `makeDue` 只改 `status`/`nextRunAt`，于是第 2 轮真实调度器根本不看这个频道，干等满 `--turn-timeout` 后以退出码 1 结束。更糟的是 `liveGateDetail` 当时不打印开关状态（只有 `status=waiting nextRunAt=… runsToday=1/6 reviewsPending=0 usageWait=none`），从报告里看不出真实原因。
2. **App 自己中断又自己续跑的那一对，被记成一次失败的轮次。** 那一轮的活其实干完了，只是干完它的是 App 自己开的 `native-app` 轮次。
3. **`runs[].treeState` 记的不是被测项目的树。** 它是 `{"dirty":true,"files":["node_modules"]}`——**harness 工作树**的 `git status`：`project/` 在 `Morrow-harness` 的 git 工作树里（`artifacts/` 被忽略），自己却不是一个仓库。`treeConflict` 门禁不是这次的原因（单频道不会和自己冲突），但模型在项目里跑 `git status` 看到的也是外层仓库。

**这次做的修改**（都在 harness 侧，`service/**` 一行没动——引擎行为是被测对象）：

- `makeDue` 先 `setControl(enabled: true)` 再置到期，和 `resume` 一致；`ChannelView` 多了 `enabled`（生产从 `store.get('controls', channelId)?.enabled` 读），`liveGateDetail` 把 `enabled=` 放在说明的第一项。
- `turn` 步骤接住 App 自己中断并 resume 的情况：本步骤的 Morrow 轮次以 `interrupted` 结束、而 runner 自己没发过中断时，在最多 15 秒内找同一线程上随后出现的 `native-app` 运行且 `trigger === 'resume_interrupted_task'`（`RunView.trigger` 从 `native_turns` 里该 run 的 `raw.params.turnTrigger` 读，按 `native_turns.runId` 对上，所以 `native-app` 运行也映射得到它的 native turn）；找到就等它结束（仍受 `--turn-timeout`），把这一对记成同一轮：`interruptedByApp: true`、`resumedRunId`、`resumedStatus`、`resumedWallMs`，`tools` 取两轮的并集，`decision` 仍取引擎对 Morrow 那一轮解析出的值（App 自己 resume 的轮次引擎不解析 `morrow-next`，所以通常是 `none`，如实记）。打印一行说明，`summary.md` 的「每一轮」表在状态里标出「App 中断后自行续跑 → <结局>」。找不到续跑轮次就照旧记 `interrupted`。**这一切都不是失败条件**：无论哪种，时间线都继续往下走。
- `prepare` 把项目目录做成独立 git 仓库：`git init -q`、`git add -A`、`git commit -q -m "seed"`，身份走 env 固定成 `morrow-live` / `morrow-live@localhost` 并带 `-c commit.gpgsign=false`（另加 `-c init.defaultBranch=main`，纯粹为了不打印默认分支名的提示），`prepared.json` 记 `git: true`。git 不可用时记 `git: false`、打印说明、**不中止**。这样 `runs[].treeState` 和模型看到的 `git status` 都是种子应用自己的。
- `prepare` 打印的第 3 步改成「发完首条消息后，把 App 切到别的任务或关闭这个任务的窗口视图（不要删除任务）；不要在里面继续手动提问」——保持任务已加载但不在前台。`run` 等待关联时打印的同一份文本也跟着改（两处共用一份）。

下一次 live 运行仍然用 `--budget 3` 重跑同一个场景（新的 `--run-id`），先看第 2 轮能不能真的起来。

## 10.2 第二次运行记录（usagegap-live-02，2026-09-12）

`npm run acceptance -- run usagegap --mode live --run-id usagegap-live-02 --budget 3`，现场在 `artifacts/acceptance/usagegap-live-02/`。**退出码 0，停止原因 `needs-input`**：时间线走了 3/23 步（`turn`、`poll`、`turn`），两轮真实轮次都以 `completed` 结束（313 秒、138 秒），第 2 轮以 `needs_input` 收尾，runner 照约定不代替人回答。账户周额度差值 1%（运行前 weekly 0% → 运行后 1%）；`metrics.cost.byWindow.weekly` 是 2，因为 `cost` 把 `usage_samples` 的窗口差值（1）再加上 `runs[].usage.delta`（第 1 轮 1、第 2 轮 0）。

**第 10.1 节暴露的三个问题都不再出现。** `makeDue` 重新打开开关之后第 2 轮真的起来了；两轮都没有被 App 中断（`live.json` 的 `turns` 里没有 `interruptedByApp`），也没有一轮是接管来的（没有 `adopted`）——这次任务窗口按 `prepare` 打印的第 3 步切到了别的任务，印证了 10.1 的判断：那次中断来自**前台的任务窗口**，不是 follower 本身的问题。`prepared.json` 的 `git: true`，`runs[].treeState` 看的是种子应用自己那棵树。

**模型这两轮做了什么**（全部来自 `events` 的审计记录）：

| 轮次 | 做的事 |
| --- | --- |
| 1（313 秒） | 建 `/usage` 观测（`watch.created`）并采到第一份样本；用浏览器侧的 `node_repl` 走了一遍真实页面，记下「首页无批量导出，点归档看板再点页脚共**两次**到达，与源码注释写的三次不一致，以真实操作为准」（`evidence.recorded`）；写下两条认识；建事项 #1「让值班人员从首页直接找到批量导出」；`decision.chosen` 选择"先准备并验证批量导出的首页直接入口"，冻结了结果预期与护栏；跑种子自己的测试（`execution.captured`，退出码 0，`node --test server.test.js`）；把改动提交成 `18c6416`；另起一个独立预览（`http://127.0.0.1:56307`）真实点击验证首页入口已经出现，并明确记下"用户提供的 56104 仍是原首页，未上线"；请求独立复核；以 `morrow-next: wait` 结束。 |
| 2（138 秒） | 读独立复核的原文，发现它已经被作废——`loop_verifications` 的那条结局是 `unknown`，说明是"复核期间源版本或目标变化，旧结论不能用于当前版本"；自己纠正了上一轮引用的证据快照（那份快照里混着无关的记忆搜索，不能当复核结论的证据）；`decision.chosen` 选"暂停推进，等待发布与数据接入说明"；以 `morrow-next: needs_input` 结束并提问。 |

**模型最后的原话**（事项 #1 的 `nextStep`）：「请提供本场景发布接收 URL、statusUrl、产物格式，以及模拟数据由谁/何时刷新、窗口和候选版本/目标人群如何对应。」它没有编一个部署地址，也没有伪造一次数据刷新——这正是要的行为，缺的是项目说明本来就没写这三件事。

第 10 节那十条验收标准逐条：

| # | 结论 | 依据 |
| --- | --- | --- |
| 1 | **通过** | runner 自己发现并关联了人建好的任务；`connectionMode='app-follower'`、`capabilities.create=false`、未关联时 `run` 返回 409（`live.json` 的 `guards`）。App 26.908.40834；`runtimeVersion` 仍是空串（状态里没报，如实记成「未知」）。 |
| 2 | **通过** | 两轮 `morrow-schedule` 都由真实调度器发起、都以 `completed` 结束，`sessionId`/`nativeTurnId` 真实，`permission='native'`，`model='gpt-6-astra'`。两轮都是时间线自己开的：`--budget 3` 只用掉 2，第 2 轮在第 1 轮结束后立刻由 `turn` 步骤发起，调度器没来得及自己插一轮。 |
| 3 | **通过** | `events` 里有 `watch.created`、`feedback.observed`、`evidence.recorded`×4、`understanding.updated`×3、`feature.created`、`decision.chosen`×2、`execution.captured`×2、`verification.queued`、`decision.reviewed`、`learning.updated`。没走到发布（`releases` 全 0），这一条本来也不要求。 |
| 4 | **通过** | 种子应用 `http://127.0.0.1:56104` 整个运行期间在跑，结束时 SIGTERM 正常退出；invariant `the-served-seed-app-reported-the-same-usage-as-the-first-sample` 这次 **PASS**（模型真的建了观测，第一份样本与应用自己的 `/usage` 逐字段一致）。 |
| 5 | **通过** | `spentTurns` 2/3；项目额度上限（5%/weekly）与保留线（20%/weekly）都没被触发，`usageWait` 一直是 `none`。 |
| 6 | **通过** | `cost.readings` 6、`cost.byWindow.weekly` 2；`live.json` 的 `usageDelta` 是 `{"weekly": 1}`，两者的关系见本节开头。 |
| 7 | **通过** | 五项探索指标全部算出来：文本匹配发现率 0/5、附证据 0/0（`unknown`）、归因 0/2、改进 1/1（且真的用观测核对过）、误修 0/1。`summary.md` 有 live 固定标注、压缩倍数说明和「每条发现的原文」一节。 |
| 8 | **通过** | `cleanup.json`：`app.stopped=true`、`killed=false`、`channelsPaused=1`、`serviceClosed=true`、`directoriesRemoved=false`、`unbound=false`。 |
| 9 | **通过** | 无残留进程与监听端口；工作树源码与作者的正式数据目录都没被碰过。 |
| 10 | **通过** | 没有调 `/api/native/background/setup`，没有设 `CODEX_CLI_PATH`，没有 `npm run build:app`。 |
| 11 | **通过** | `live.json` 的 `turns` 有两轮的真实起止与工具类型清单：第 1 轮 `agentMessage`、`commandExecution`、`fileChange`、`mcpToolCall`、`mcpToolCall:js`、`mcpToolCall:node_repl`、`reasoning`、`userMessage`（浏览器侧的 `node_repl` 真的被用了，而且是拿它走真实页面）；第 2 轮只有 `agentMessage`、`commandExecution`、`reasoning`、`userMessage`。 |

**文本匹配的发现率是 0/5，而人工评分是「发现并修掉 1/5」。** 模型真的找到了 `buried-entrance`：它走了真实页面、量出到达步数、把入口改到首页、跑了测试、提交了 `18c6416`、还另起一个预览点击验证过。它只是**按数据里的中文标题**称呼这个功能——事项标题是「让值班人员从首页直接找到批量导出」，正文里一个 `bulkexport` 都没有，所以 ID 文本匹配判它 0。这正是决定 7 说的那种情形（「也可能理解了却没写那个 ID」），也是本次为此改掉判定规则的原因（见下面第 2 件事）。另外它顺手纠正了一处**种子源码的注释错误**：注释写"要三次点击"，真实操作只要两次，它以真实操作为准并写进了证据。

税务报表（反例 `not-needed`）**正确地没被碰**：`misFix.count` 0，`page-taxreport.js` 未被改动，模型全程没提它。误修 0。归因 0/2 的原因只是那两条低使用率的埋入问题里，`taxreport` 根本没被记成事项（`missing` 2），不是归错。

**模型提的问题，和本次为此做的三件改动**：

1. **项目说明补齐发布接入与数据语义。** `projectBrief()` 多了 `{{releaseUrl}}` 与 `{{statusUrl}}` 两个占位符（接收端自己的 `/deploy` 与 `/status`，和 careful 策略经 `policyScenario` 拿到的是同一份地址），fixture 与 live 两个 runner 都填。`usagegap` 的 `brief` 补了三段：发布方式（经独立复核后用 `release.propose`，适配器 `kind: 'http'`，产物是项目里的 `release.txt`，人工确认后由 Morrow 上传并拿回执，模型不需要自己部署）、使用数据的语义（`generatedAt` 是固定标注、恒为 `2026-02-02T09:00:00.000Z`，判断效果要看**样本之间计数字段的差值**，不要因为它旧就判定数据无效，也不要自己伪造刷新）、目标用户与候选版本的对应（接收端只认经人工确认发布的版本，模拟数据对应最近一次已发布的版本）。
2. **发现率判定加功能标题别名。** `planted[]` 多了可选的 `aliases`，`usagegap` 五条各登记它在 `/usage` 里的中文标题（批量导出、交接导入、归档看板、分享链接、税务报表）。匹配规则变成「事项正文里出现了功能 ID **或它的任一别名**」，`defineScenario` 对别名沿用和功能 ID 同一条「不能互相包含」的校验，`summary.md` 的「命中的埋入功能」写明命中的是 ID 还是哪个别名。两种夹具策略写的都是 ID，所以 fixture 的数字一个都没变（careful 仍然 5/5、naive 仍然 1/5）；run 02 那条标题现在命中 `bulkexport`（`tests/acceptance-live.test.ts` 用同一个标题字符串把这件事钉住）。
3. **`approve`/`reject` 改成终端上的人工确认。** 见第 5 节里对决定 5 的修正：stdin 是 TTY 时 runner 在终端上问一次，人输入 `approve` 就以**人**的身份走服务正式的审阅路径（`POST /api/releases/:id/review`），然后时间线继续——完整时间线因此走得过去。

**跑完整条时间线的建议参数**：

```bash
npm run acceptance -- run usagegap --mode live --run-id <id> \
  --budget 16 --wall-clock 180 --project-window weekly --project-limit 12
```

- `--budget 16`：时间线有 11 个 `turn`，再留 5 轮给真实调度器自己发起的轮次（一轮以 `continue` 结束 30 秒后就有下一轮，它们会被下一个 `turn` 步骤接管，但仍然计预算）。频道 `maxRunsPerDay` 随之是 32，盖住 3 次独立复核。
- `--wall-clock 180`：11 轮 × 前两轮实测的 2–5 分钟，加 3 次独立复核（每次上限 5 分钟）、压缩后的四次 `advance`（20+20+15 分钟 × 0.1 ≈ 5.5 分钟）和一次人工确认的等待。180 分钟是兜底，不是预期耗时。
- `--project-window weekly --project-limit 12`：02 两轮就吃掉周额度 1%，11 轮加复核按同一速率是 5–8%，5% 的缺省会在中途把运行挡下来。保留线仍用缺省 20%/weekly。
- 人要守在终端边上：走到 `approve` 时 runner 会在终端上问一次（`--approval-wait` 缺省 30 分钟）。

## 11. 决定记录：八条原来要拍板的问题，现在的答案

原来这一节是「需要负责人拍板的清单」。2026-09-11 全部拍板，逐条如下（顶部那张表是同一份决定的摘要与实现位置）：

| # | 原来的问题 | 决定 | 写在哪一节 |
| --- | --- | --- | --- |
| 1 | live 运行期间是否暂停作者自己的自主频道 | 暂停，由人先做；runner 只打印「步骤 0」提醒 | 第 1 节 |
| 2 | 一次调用阻塞等待，还是两次调用 | **两次调用**：`prepare` 然后 `run --run-id` | 第 2 节 |
| 3 | `--advance-scale` 的缺省值 | 缺省 **0.1**，可显式设 1；比例写进报告并说明不可与 fixture 比较 | 第 3 节 |
| 4 | live 运行的成败判据 | **只有运行本身出错才算失败**；invariants 逐条评估但不决定退出码 | 第 4、6 节 |
| 5 | 三道闸的数值；`--allow-approve` 要不要存在 | `--budget` 必填；项目上限 5%/5h；保留线 20%/weekly + `stopWhenUsageUnknown`；**runner 自批准不实现**，`--allow-approve` 这个开关不存在；2026-09-12 修正：人在终端上输入 `approve` 就是人工确认（`--approval-wait` 缺省 30 分钟），时间线继续 | 第 5 节 |
| 6 | `repeatedFailures` 换来源还是保持 unknown | **保持 `unknown`**，不重建 `calls.jsonl`，在 `repeatedFailuresSource` 写明原因 | 第 4、8 节 |
| 7 | 第一次运行后是否加人工评分 | 要加，但在第一次运行之后；现在先在 `summary.md` 给出每条发现的原文与「文本匹配是下限判据」的说明 | 第 8 节 |
| 8 | 浏览器/Computer Use 在 follower 轮次是否可用 | **已实测可用**（2026-09-09）；每轮的工具类型清单仍然记进 `live.json` | 第 9 节 |

实现落在：新文件 `scripts/acceptance/live.ts`（编排核心 + 生产 deps 工厂，不 import `tests/harness/env.ts`）、`run.ts` 的 `prepare` 子命令与 `--mode live`、`timeline.ts` 里按模式分支的动词、`metrics.ts` 的 `config.mode`/`repeatedFailures` 与 `report.ts` 的 live 标注与发现原文。编排核心接受一个 `deps` 对象（起服务的工厂、时钟与 sleep、输出、任务列举/关联/状态查询、种子应用启停、额度读取），`tests/acceptance-live.test.ts` 用假依赖跑完整条编排——**没有任何测试连真实 App 或消耗额度**；生产工厂里的 `MORROW_TEST_MODE !== '1'` 断言本身也有一条测试。
