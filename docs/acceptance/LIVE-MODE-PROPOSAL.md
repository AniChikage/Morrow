# 验收 harness 的 live 模式：待确认的设计

**这是提案，不是实现。** 在负责人明确确认之前不要开始写 live 模式。`npm run acceptance -- run <场景> --mode live` 目前只打印这份文件的路径并以退出码 2 结束。

fixture 模式验证的是框架机制：调度、预算、观察窗口、事前预期的机械核对、复核门禁、人工上线确认、重启一致性。它不能说明模型会不会自己发现问题、会不会把使用率低归因正确。live 模式的唯一目的就是补上这一半：**同一套场景、同一套指标，换成真实的 Codex App 任务来跑**。

本文要回答的是「跑起来到底会发生什么、谁按哪个按钮、花多少额度、什么时候停、失败了留下什么」。每一节末尾的「待确认」是需要负责人拍板的点。

## 1. 隔离范围：隔离什么，不隔离什么

每次 live 运行有自己的数据目录和项目目录，都在 `artifacts/acceptance/<run-id>/` 下（`artifacts/` 已被 Git 忽略）：

```
artifacts/acceptance/<run-id>/
  home/          MORROW_HOME：workspace.sqlite、runs/、releases/、native-images/、daemon.lock
  project/       隔离项目目录：场景种子（usagegap 的 11 个文件）按原样写进来
  timeline.jsonl calls.jsonl labels.json run.json metrics.json summary.md cleanup.json
  live.json      live 专属：绑定的任务 ID、真实起止时间、额度前后读数、每一轮的真实耗时
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

**待确认**：live 运行是否允许与作者正在使用的安装版 Morrow 同时开着？（两者数据目录不同、端口不同、`daemon.lock` 不同，技术上可以；但它们会抢同一个账号的额度，也会抢同一个 App 的任务并发。建议：不允许，live 运行期间作者的自主频道先暂停。）

## 2. Morrow 不能创建 App 任务：人要做的四步

`CodexNativeTransport` 没有 `createThread`，所以 `GET /api/native/status` 的 `capabilities.create` 恒为 `false`，未关联就启动会返回 409。这不是缺陷，是 0.9.5 的接入形态。于是一次 live 运行必须由人开头。

runner 起服务、建项目、写好项目说明、起种子应用之后，**把下面这段原样打到 stdout，然后阻塞等待**：

```
1. 打开 Codex App，新建一个任务，目录选：
     /Users/…/Morrow-harness/artifacts/acceptance/usagegap-live-<stamp>/project
2. 在这个任务里发一条首条消息（例如「准备好了」），等它回完。
3. 保持这个任务打开，不要关闭窗口，也不要在它里面继续手动提问。
4. 回到这个终端；runner 会自己发现并关联它。

等待中：每 3 秒检查一次，最多等 <--wait-bind> 分钟。
```

runner 的等待逻辑，全部走已有接口：

1. `GET /api/channels/:id/native/threads`（`native.list`）→ 它只返回 cwd 与项目目录相符的任务。等到**恰好一个**为止：0 个继续等；多于一个就中止并把候选列出来让人删掉多余的（自动挑一个会让「我们测的是哪个任务」变得不可知）。
2. `POST /api/channels/:id/native/bind {threadId}` 关联它。
3. `GET /api/native/status` 轮询到 `connected === true && boundThreadCount === 1 && readyThreadCount === 1 && restartRequired === false`。`readyThreadCount` 数的是 `transport.threadStatus(threadId).ready` 为真的绑定，也就是「后台连上了」和「这个任务真的加载好了」两件事都成立；只看 `connected` 不够。
4. 关联前先断言两件事，和 `scripts/probe-app-follower.ts` 一样：`capabilities.create === false`，以及未关联时 `POST /api/channels/:id/action {action:'run'}` 返回 409。断言失败就中止，不继续消耗额度。
5. 把 `threadId`、`appVersion`、`runtimeVersion`、`connectionMode` 写进 `live.json`。

超时（缺省 10 分钟）就走第 7 节的清理并以退出码 1 结束，明确说「没有等到可用的 App 任务」。

**待确认**：等待是否要做成两次调用（先 `--prepare` 打印目录并退出，人建好任务后再 `--run`）？一次调用阻塞等待更简单，也不会出现「目录已经被别的运行覆盖」的问题，但要求人守在终端边上。建议一次调用。

## 3. 真实调度器 + 脚本化时间线

fixture runner 为了可重复做了三件真实 daemon 不会做的事：停掉 1 秒定时器、把观察的 `nextPollAt` 推远、直接打开频道开关。live 模式只保留其中一件，其余交还给真实调度器。

| fixture 的做法 | live 模式 |
| --- | --- |
| `stopScheduler()` 停掉 daemon 的 1 秒定时器 | **不停**。真实调度器自己跑，日预算、复核等待、项目串行、额度门禁都在它的路径上。 |
| `parkWatches()` 把观察推远 | **不推**。观察按自己的 `intervalSeconds` 真实轮询。 |
| `setControl(enabled: true)` 直接打开开关 | **保留**。`action(id,'resume')` 会立刻开一轮不在时间线里的轮次；直接置开关能让第一轮仍由时间线发起。 |

时间线动词在 live 模式下的含义：

| 动词 | live 行为 |
| --- | --- |
| `turn` | 仍然把频道置为到期（`nextRunAt` 设到过去）并等一轮 `morrow-schedule` 运行真实结束。等待上限 `--turn-timeout`（缺省 10 分钟，与 App 一轮的常见耗时和复核 5 分钟上限匹配）。**只认本次运行新出现的 `morrow-schedule` 行**——0.9.5 验收踩过的坑：同步进来的历史 `native-app` 轮次会被错认成本轮结果。 |
| `poll` | 仍然调 `loop.poll(watchId)` 采一次。多采一次无害，而且让时间线里的「此刻应当有样本」是明确的；调度器自己的轮询照常进行。 |
| `set` / `mode` | **不变**。接收端仍是本机的 `startReceiver()`，使用数据和发布回执都由它给，所以扰动完全可控。这是 live 模式仍然可读的关键：变量只有模型一个。 |
| `advance` | **虚拟时钟不能用**。见下。改成真实等待：`advance N` 变成 `await sleep(min(N 分钟, --max-wait))`，并把真实耗时记进 `timeline.jsonl`。 |
| `verify` | **fixture 专用，live 下是 no-op**。独立复核走真实 `codex exec`（只读、临时会话、5 分钟硬上限）。runner 只在需要时等 `loop_verifications` 从 `queued`/`running` 落到终态，上限 `--review-timeout`（缺省 6 分钟）。 |
| `approve` | 见第 5 节：缺省**不自动批准**，运行停在这里。 |
| `guide` | 保留：以 `source:'chat'` 向同一条原生任务发一条指导。它会真的消耗一轮 App 对话（不计编排预算）。 |
| `restart` | 保留：关服务再在同一 `home` 上打开。绑定、历史与待核对回执都应当还在。 |
| `pause` / `resume` | 不变。 |

**为什么虚拟时钟不能用，以及用什么代替**：fixture 用 `node:test` 的 `mock.timers.enable({ apis: ['Date'] })` 冻结 `Date`，于是观察窗口、freshness、UTC 日预算都跟着虚拟时钟走。接真实模型时这行不通，原因有三条，任一条都足够：

1. **只冻结了服务进程的 `Date`。** Codex App 是另一个进程，官方 `codex exec` 复核也是另一个进程，它们的时间戳、5 分钟硬超时、IPC 心跳都按真实时间走。服务以为过了 6 小时而 App 以为过了 3 秒，两边写进同一条记录的时间就自相矛盾。
2. **`advance` 会在一轮真实运行进行中跳时钟。** 真实一轮要几分钟，期间 `mock.timers.tick()` 把 `Date.now()` 往前推，正在算 deadline 的 loop 会当场判定观察已过期、复核已超时。
3. **额度门禁与日预算按真实的 UTC 日界和窗口重置时间判断。** 跳时钟会让 `resetsAt` 逻辑得出假结论，而额度是这次运行真花掉的东西。

代替方案：**真实时钟 + 真实等待 + 压缩过的窗口**。
- runner 用真实 `Date`，`advance` 变成有上限的真实 `sleep`。
- 场景里那些「一个采样周期」「让违反到反应有真实时长」的 `advance 15/20` 分钟，在 live 里直接等 15/20 分钟太贵。提供 `--advance-scale`（缺省 `1`，可设 `0.1` 把 20 分钟压成 2 分钟），把缩放比例记进 `run.json`，并在 `summary.md` 明写「观察窗口被压缩了 N 倍，`adjustmentLatency` 的绝对分钟数不可与 fixture 直接比较」。
- 策略要求的 deadline（careful 的 6 小时观察窗口、7 天 understanding 复查）是**未来时刻**而不是等待，真实时钟下照常成立，不需要改。但 live 模式下这些 deadline 由模型自己给，runner 不干预。

**待确认**：`--advance-scale` 的缺省值。建议第一次 live 运行用 `1`（不压缩）但配合 `--budget 3`，这样时间线根本走不到第一个 `advance`；等要跑完整条时间线时再决定压缩比例。

## 4. 没有 policy：模型就是策略

fixture 的 `careful`/`naive` 是写死的状态机，它们直接调 `/api/agent`。live 模式里干这件事的是真实 App 任务里的模型，通过每轮提示词里的 `tool.sh` 入口。所以：

- `--policy` 在 live 模式下**被拒绝**（退出码 2），`run.json`/`config.policy` 写 `live`。
- `policySelfCheck` **不适用**：它比较的是两种策略，live 只有一个。`run all --mode live` 同样拒绝——一次 live 运行只跑一个场景。
- `calls.jsonl` 仍然有内容：它记的是「这一轮通过工作接口做了什么、哪些被拒了」。live 模式下这些调用来自真实模型，所以 `repeatedFailures` 第一次有了真正的含义（模型有没有把被拒的材料原样再发一次）。记录方式要换：fixture 是 `ScriptedNativeTransport` 在自己发 fetch 时记下来的，live 模式下模型走 `agent-cli.ts`，runner 看不到。**需要一个新的来源**：`loop_calls` 表已经按 `runId:requestId` 存了每次写操作的 hash 与结果，但不存状态码；被拒的调用只在审计事件里。建议 live 模式下的 `calls.jsonl` 从 `events` 重建，并在 `metrics.json` 里把 `repeatedFailures` 的来源写清楚，或者干脆保持 `unknown` 而不是给一个来源不同、没法与 fixture 比较的数。
- `invariants` 里那些编码「正确使用协议」的条目（例如 `decision-has-frozen-expectations`）在 live 模式下**变成被测量的对象**，不再是「应当为真」的断言。runner 仍然逐条评估并写进报告，但 live 运行的 `ok` 不应当只因为某条 invariant 不成立就算失败——那正是我们想知道的结果。

**待确认**：live 运行的成败判据。建议：**只有运行本身出错才算失败**（没等到任务、超预算、服务崩溃、清理失败）；模型的表现全部作为指标报告，不决定退出码。否则第一次 live 运行几乎必然「失败」，而那不是有用的信号。

## 5. 预算：三道闸，一条也不能省

一次 live 运行会真的花钱。三道闸都要显式设好，并且都记进 `live.json`。

1. **轮次上限 `--budget N`**（必填，无缺省）。
   - `PATCH /api/channels/:id {maxRunsPerDay: N + <本次允许的复核数>}`：复核与轮次共用频道的 UTC 日预算，所以上限要盖住两者。
   - runner 自己再数一次：新出现的 `morrow-schedule` 行超过 N 就立刻暂停频道并中止。两道保险，因为 `maxRunsPerDay` 是按 UTC 日算的，跨日会重置。
   - 时间线里 `turn` 的条数超过 `--budget` 时，运行在用完预算的那一刻停下，报告写明「时间线未走完，剩余 M 步未执行」——这是预期结果，不是失败。
2. **项目额度上限**（必填）：`PATCH /api/projects/:id/usage-budget {usageBudget: {window: '5h'|'weekly', limitPercent: 1..100}}`。这是 Morrow 归因到本项目的**估算**用量。达到上限后新的自动轮次和独立复核都不再发起（频道置 `waiting` 并写一条系统事件）。建议第一次 live 运行设 `{window:'5h', limitPercent: 5}`。
3. **保留线**（必填）：`PATCH /api/settings {usageReserve: {window: '5h'|'weekly', keepPercent: 1..99}, stopWhenUsageUnknown: true}`。保留线按共享后台读到的**精确账户用量**判断，先于项目上限生效，保护的是作者自己要用的额度。`stopWhenUsageUnknown: true` 让「读不到额度」变成阻断而不是放行——live 模式下宁可停下。这两项写在隔离数据目录的 `settings` 行里，不影响作者正式数据目录的设置。建议 `{window:'weekly', keepPercent: 20}`。

运行开始前 `await engine.usage.refresh()` 取一次读数，结束时再取一次，两者与差值一起写进 `live.json`；`metrics.cost` 因此**不再是 `unknown`**：它来自 `usage_samples` 的窗口差值加 `runs[].usage.delta`。这是 live 模式相对 fixture 的一个真实增量。

**发布确认不自动做。** `approve` 动词在 live 模式下缺省行为是：把发布的标题、改动、`reviewHash` 和产物摘要打到 stdout，暂停频道，写报告，以「停在人工确认」结束。`--allow-approve` 可以让 runner 用隔离目录里的桌面凭证自己批准，但报告必须写明「本次上线确认由 runner 执行，不代表人工审阅」，否则「人工上线确认」这道门禁就被测空了。`--budget 3` 的第一次运行根本走不到 `approve`（`usagegap` 的 `approve` 在第 6 轮之后）。

**待确认**：三道闸的具体数值，以及 `--allow-approve` 是否要存在。

## 6. 停止条件

任一条成立就有序停下（都走第 7 节的清理）：

| 条件 | 退出码 | 说明 |
| --- | --- | --- |
| 时间线走完 | 0 | 正常结束。 |
| `--budget` 用完 | 0 | 预期结果；报告写明剩余步数。 |
| 项目额度上限或保留线阻断 | 0 | 预期结果；`live.json` 记下阻断时的读数与窗口重置时间。 |
| 某一轮以 `needs_input` 结束 | 0 | 真实模型提了问题。**runner 不代替人回答**：打印问题、暂停频道、结束。 |
| 遇到 `approve` 且没有 `--allow-approve` | 0 | 停在人工确认。 |
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
| `usagegap.attribution.correct` | 状态机读没读 `askedFor` | **模型有没有分清「入口太深」和「目标用户本来不需要」**：反例记成 `hypothesis` 才算对 |
| `usagegap.improvements.observed` | 状态机有没有把预期冻结在观测上 | 模型提的改进有没有事前预期与真实观测，且复盘真的拿那个观测的样本核对过 |
| `usagegap.misFix.count` / `ids` | 状态机有没有挑错对象 | **模型有没有去"修"那个不该修的功能** |
| `cost` | 永远 `unknown`（脚本化后台不报额度） | 真实账户用量差值 |
| `repeatedFailures` | 从 `calls.jsonl` 算，来源是策略自己发的 fetch | 需要换来源（见第 4 节），否则保持 `unknown` |
| `policySelfCheck` | careful 必须在约定指标上胜过 naive | **不适用**，只有一个"策略" |
| `compare --ignore-volatile` 零差异 | 必须成立 | **不成立**。真实模型不可重复；两次 live 运行的差异本身是要看的东西，不是要消灭的东西。 |

`planted`（五条，各带 `kind` 与 `/usage` 功能 ID）是 live 模式下唯一的标准答案，和 fixture 用的是同一份标签；匹配规则也是同一条：**事项正文里出现了那个功能 ID**。这条规则是有意为之——它对夹具状态机和真实模型一样，不需要为 live 模式另写一套判定，也不需要人去逐条对答案。代价是模型可能提到功能 ID 却没真的理解那个问题；所以 `summary.md` 必须同时给出每条发现的原文，让人能抽查，并且写明「发现率是文本匹配得出的下限判据，不是人工评分」。

`summary.md` 的固定标注在 live 模式下换成：**live 结果是隔离环境下的模型验证，不是真实业务效果。** 一次运行是一次抽样；反馈样本、接收端和使用数据都是本机构造的。

**待确认**：要不要在第一次 live 运行之后加一轮人工评分（人读五条发现原文，逐条判对错），并把人工评分与文本匹配的结果一起放进报告作为对照？建议要，但那是第一次运行之后的事。

## 9. 风险

| 风险 | 说明 | 已有的缓解 |
| --- | --- | --- |
| **真实额度** | 一次运行真的花账号额度；`--budget 3` 也包含复核 CLI 的调用。 | 三道闸（第 5 节）+ 运行前后各取一次读数 + `stopWhenUsageUnknown: true`。 |
| **App 权限与目录合并** | 0.9.5 起沿用 App 的沙箱与审批；App 可能把已有目录合并进任务的可写范围，所以「只含隔离项目目录」不能被声称为事实。模型理论上能写到隔离目录之外。 | 隔离目录在 `artifacts/` 下、与工作树源码分开；`execution.prepare` 的护栏拒绝「服务目录位于项目之内」；运行后 `git status` 核对工作树没被改动。**这一条没有硬隔离，必须写进报告的边界。** |
| **应用内浏览器 / Computer Use 是否可用** | 0.4 的探测结论是：Morrow 自己创建的任务里浏览器插件不可用；本模式的任务由人在 App 里创建，理应带 App 自己的工具，但**没有在 Morrow 跟随的轮次上验证过**。如果不可用，模型只能读 `/usage` 而不能真的走页面，`empty-state` 和 `misleading-copy` 这两条基本不可能被发现。 | 第一次 live 运行先只要求 `/usage` 路线能跑通；把「工具清单与实际可用性」记进 `live.json`（每轮的 `native_items` 里有哪些工具类型），据此再决定要不要为走查单独加一条能力缺口记录。 |
| **非确定性** | 同一场景两次 live 运行结果不同，`compare` 零差异不成立。 | 明确不比较；报告写明「一次运行是一次抽样」。多次运行用 `--repeat` 给均值极值，但每次都要单独付额度。 |
| **复核 5 分钟硬上限** | 官方 `codex exec` 复核有 5 分钟上限，超时保持未知。真实项目的完整检查可能跑不完。 | `--review-timeout` 略大于 5 分钟；未知结局按既有策略处理，不重跑。 |
| **人守在终端边上** | 建任务、发首条消息、可能还要按上线确认，都要人。 | 一次调用阻塞等待 + 把要做的四步原样打出来；`--budget 3` 让第一次运行走不到 `approve`。 |
| **任务被并发占用** | 自动轮次发现任务已忙时返回等待，不会转成 steering 干扰手动轮次；但人如果在同一任务里手动提问，这一轮就会一直等。 | 打印的步骤里明确「不要在这个任务里继续手动提问」；`--turn-timeout` 兜底。 |
| **端口** | 种子应用的端口由 runner 先绑定再释放，spawn 之前有极短窗口可能被抢；隔离服务用随机端口。 | 抢到的运行在就绪探测上明确失败，不会去量错误的应用。 |
| **`daemon.lock`** | 同一数据目录只允许一个 daemon。`<run-id>/home` 是新目录，不会与安装版冲突。 | 重跑同一个 `run-id` 会被锁拒绝；`run-id` 带时间戳与随机后缀。 |

## 10. 第一次 live 运行的验收标准

命令：

```bash
npm run acceptance -- run usagegap --mode live --budget 3
```

（加上第 5 节要确认的额度上限与保留线参数。）

这次运行**不要求模型发现任何问题**。它要证明的是 live 通道本身通了：

1. runner 打印了那四步，人在 App 里建好任务并发了首条消息，runner 自己发现并关联了它，`GET /api/native/status` 报 `connected=true`、`connectionMode='app-follower'`、`boundThreadCount=1`、`readyThreadCount=1`、`capabilities.create=false`，未关联时的 `run` 返回过 409。
2. 三轮真实 `morrow-schedule` 运行全部由真实调度器发起并正常结束（`status='completed'`），每一轮的 `runs` 行带真实的 `sessionId`/`nativeTurnId`，`permission` 为 `native`，`model` 不是 `scripted-native-model`。
3. 这三轮里模型真的调过工作接口：`events` 里有 `decision.chosen` 或 `feature.upsert` 类的审计记录；不要求它走到发布。
4. 种子应用在整个运行期间可访问，`/usage` 与接收端上的样本形状一致（`app.probe` 对照，和 fixture 同一条 invariant）。
5. 轮次不超过 3，项目额度上限与保留线都没被触发（如果触发了，运行以 0 结束并在报告里说明——这也是通过）。
6. `metrics.cost` 不是 `unknown`：运行前后的账户读数差值落在 `live.json` 与 `cost.byWindow` 里。
7. `usagegap` 的五项探索指标都算得出来（哪怕是 0/5），并且 `summary.md` 同时给出每条发现的原文和 live 的固定标注。
8. `cleanup.json` 显示：种子应用已停止（`stopped: true`）、频道已暂停（`channelsPaused >= 1`）、服务已关闭（`serviceClosed: true`）、目录保留（`directoriesRemoved: false`）、绑定保留（`unbound: false`）。
9. 运行结束后：`pgrep` 无残留进程、端口无残留监听、`git status` 显示工作树未被改动、作者的正式数据目录 `~/Library/Application Support/Morrow` 修改时间未变。
10. 整个过程没有调用 `/api/native/background/setup`，没有设置 `CODEX_CLI_PATH`，没有 `npm run build:app`。

做完这一次，再决定要不要跑完整条时间线（11 轮 + 3 次复核 + 一次人工确认），以及 `--advance-scale` 取多少。

## 11. 需要负责人拍板的清单

1. live 运行期间是否暂停作者自己的自主频道（第 1 节）。
2. 一次调用阻塞等待，还是 `--prepare` / `--run` 两次调用（第 2 节）。
3. `--advance-scale` 的缺省值与第一次运行的取值（第 3 节）。
4. live 运行的成败判据：是否只有「运行本身出错」才算失败（第 4 节）。
5. `--budget`、项目额度上限、保留线的具体数值；`--allow-approve` 要不要存在（第 5 节）。
6. `repeatedFailures` 在 live 模式下换来源，还是保持 `unknown`（第 4、8 节）。
7. 是否在第一次运行后加一轮人工评分作为文本匹配的对照（第 8 节）。
8. 应用内浏览器/Computer Use 在 Morrow 跟随的轮次里是否可用——这一条要先实测，不能靠推断（第 9 节）。

确认之后才动手。实现范围预计是一个新文件 `scripts/acceptance/live.ts`（不 import `tests/harness/env.ts`）、`run.ts` 里把 `--mode live` 接到它上面、`timeline.ts` 里按模式分支那几个动词，以及 `metrics.ts` 里 `config.mode` 与 `repeatedFailures` 来源的处理。
