# 可重复验收 harness

一条命令把一个验收场景跑完：真实的执行服务、真实的调度器、真实的项目工作接口，唯一被替换的是原生后台和外部世界。fixture 模式不调用任何模型，也不离开 loopback。

```bash
npm run acceptance -- list                  # 列出场景
npm run acceptance -- run smoke             # 跑一个场景
npm run acceptance -- run smoke --keep      # 保留隔离的数据目录和项目目录
npm run acceptance -- run smoke --out artifacts/acceptance/my-run
npm run acceptance -- run smoke --policy naive --repeat 3
npm run acceptance:fixture                  # = run all --policy careful,naive，含自检
npm run acceptance -- compare <目录A> <目录B> --ignore-volatile
npm run acceptance -- metrics <运行目录|数据目录> [--out metrics.json]
```

参数：`--mode fixture`（默认，目前只有这一种）、`--policy careful|naive`（默认 careful；`run all` 接受 `careful,naive`）、`--repeat N`、`--out <目录>`、`--keep`、`--seed <n>`。
退出码：0 通过，1 场景未通过或自检未通过，2 用法错误或未实现。`run all` 只在 **careful** 运行失败或自检失败时返回 1——naive 失败是预期结果。

## 组成

| 文件 | 作用 |
| --- | --- |
| `tests/harness/scripted-native.ts` | `ScriptedNativeTransport`：一个 `NativeTransport` 替身，同时扮演调度轮次的后台和独立复核后台。 |
| `scenario.ts` | 场景 DSL：`defineScenario`、timeline 动词、invariant 类型。 |
| `scenarios/<id>.ts` | 具体场景，`export default defineScenario({...})`。 |
| `fake-agent.ts` | 确定性策略：`careful` 与 `naive`。 |
| `timeline.ts` | 执行单个 timeline 步骤。 |
| `fixture.ts` | 进程内 runner：虚拟时钟、接收端、隔离服务、产物、指标与 invariant 评估。 |
| `metrics.ts` | 从 SQLite 计算指标，以及 `careful` / `naive` 的 harness 自检。 |
| `report.ts` | `metrics.json`、`summary.md` 的指标表、`compare` 差值表、`--repeat` 的均值极值。 |
| `run.ts` | 命令行入口。 |

## 两种策略

两种策略都是写死的确定性状态机，不是模型模拟。目的不是"像模型"，而是证明指标能看出正确与错误的协议使用之间的差别。

| 策略 | 行为 |
| --- | --- |
| `careful` | 按协议使用：先独立复核再封存发布，冻结结果预期**和**护栏，复盘逐项引用观察窗口内实际采集的样本，不沿用未经证实的旧经验。 |
| `naive` | 同样的 `TurnPolicy` 形状、同样确定、每轮同样给出合法的 `morrow-next`，但故意用错四处：<br>(a) **跟随过期经验**——从 `context` 里读到预置的旧记录就直接 `memoryRefs.use='apply'`，选项与理由都建立在它上面；<br>(b) **不设 guardrail**——只冻结结果预期；<br>(c) **条件不比对**——`decision.review` 声明 `conditions:'matched'` 和确定的 `diagnosis`，不读样本、不引用任何采集证据；<br>(d) **材料不变重复提交**——被拒后原样再发一次，于是再次被拒。 |

`naive` 不会让运行崩溃：预期会被拒的调用都走一个吞掉异常的包装，状态码仍然记录在 `calls.jsonl` 里——`repeatedFailures` 就是从那里读的。它在 `smoke` 上跑完整条时间线、预算内结束，但结果是 `failed`，因为两条编码了"正确使用"的 invariant 对它不成立：`decision-has-frozen-expectations`（它只冻结了结果预期）和 `review-cites-captured-evidence`（它的复盘全部被服务拒绝，一条也没落库）。

**注意**：`naive` 会把 `context` 里任何"活着"的认识也一并 `apply`。如果某个场景预置的是一条**已过期**的 understanding，工作接口会拒绝这次 `decision.choose`，`naive` 就完全没有选择记录，`guardrails.defined` 与 `staleMemory.followed` 都会变成 0，自检随之失败。这类场景应把过期认识作为 learning 预置，或为它单独扩展策略。

## 场景 DSL

```ts
export default defineScenario({
  id, title, goal, brief?,
  project: { files | seedDir, artifactPath, artifactBody?, tests?, serve? },
  memory?: [{ operation: 'understanding.upsert' | 'learning.upsert', input, note?, stale? }],
  feedback: { initial, path?, pointer, condition, outcome, guardrail, latencySeconds? },
  budget: { turns, reviews? },
  timeline: [...],
  invariants: [...],
  planted?: [{ id, where, description, shouldFix }],
});
```

`feedback.outcome` 和 `feedback.guardrail` 是策略要冻结成 `decision.choose.expectations` 的两条预期，各自带一条由系统机械核对的 `rule`。

timeline 动词：

| 动词 | 含义 |
| --- | --- |
| `turn` | 让频道到期并调用 `engine.tick()`，由真实调度器决定是否启动（日预算、复核等待、项目串行、额度门禁都在路径上），然后等这一轮结束。 |
| `poll` | 调用 loop 自己的观察入口 `loop.poll(watchId)` 采集一次样本。 |
| `set` | 换掉接收端的反馈样本，可带 `truth: 'noise' \| 'goodhart' \| 'environment'` 标签。 |
| `mode` | 把接收端切到 `normal \| disconnect \| wrong \| unavailable`。 |
| `approve` / `reject` | 用桌面凭证和当前 `reviewHash` 调 `POST /api/releases/:id/review`。 |
| `guide` | 以 `source: 'chat'` 向同一条原生任务发一条用户指导。 |
| `verify` | 仅 fixture：把排队中的独立复核推进到结论并落库。 |
| `restart` | 关掉服务再在同一数据目录上打开。 |
| `pause` / `resume` | 停止 / 恢复自动工作。 |
| `advance` | 推进虚拟时钟（分钟）。 |

`resume` 不在原计划的动词表里。加它是因为 `pause` 之后没有任何动词能让时间线继续，`pause` 会变成死路。

invariant 是命名过的谓词，输入 `{ store, service, transport, receiver, timeline }`，返回 `{ ok, detail }`。任何一条不成立，这次运行就算失败。

`memory[].stale: true` 标出场景预置的"过期经验"。runner 记下这些记录实际拿到的 ID，写进 `labels.json`；`truth` 与 `planted` 也在同一个文件里。**这三类标签是指标唯一的非 SQLite 输入**，服务和策略都看不到它们——策略只能在 `context` 里看到记录本身。

## fixture 模式做了什么

- 用 `node:test` 的 `mock.timers.enable({ apis: ['Date'] })` 冻结时钟。观察窗口、freshness、UTC 日预算都跟着虚拟时钟走；`setTimeout`、`fetch` 仍然是真的。
- `startIsolated()` 在临时目录上起一个真实服务：临时 `MORROW_HOME`、临时项目目录，绝不碰用户的数据目录。
- `ScriptedNativeTransport` 接住 `startServer({nativeTransport})` 交给它的两个角色。调度轮次里它读 `runs/<id>/agent-context.json` 拿到本轮凭证，再用配置的策略去调真实的 `/api/agent`；复核轮次里它按 `FakeReviewer` 的既有行为给出裁决。
- 外部世界是 `startReceiver()`：反馈样本、发布接收端和回执，全部在 127.0.0.1 上。

为了让同一个场景两次运行得到同一条时间线，runner 做了三件在真实 daemon 上不会做的事，它们只影响“什么时候发生”，不影响“怎么发生”：

1. 停掉 daemon 自己的 1 秒定时器；每次 `tick()` 都由 timeline 显式发起，所有门禁仍然在 `tick()` 里。
2. 把所有存活观察的 `nextPollAt` 推远，采样只发生在 `poll` 步骤。
3. 直接打开频道的自动开关，而不是 `action(id, 'resume')`——后者会立刻开一轮不在时间线里的轮次。

## 产物

每次运行写入 `--out`（默认 `artifacts/acceptance/<run-id>/`，`artifacts/` 已被 Git 忽略）：

- `timeline.jsonl`：每步一行，含动词、参数、虚拟时间和观察到的结果。
- `calls.jsonl`：策略发起的每一次 `/api/agent` 调用，含操作名、输入摘要（`sha256(input)` 前 12 位）、状态码和 requestId。
- `labels.json`：`{ staleMemoryIds, truth: [{ stepIndex, truth, virtualTime }], planted }`——指标唯一的非 SQLite 输入。
- `run.json`：这次运行的身份（runId、场景与版本、策略、seed、预算、墙钟毫秒）。没有任何表记录它，`metrics <运行目录>` 靠它复现同一份 `config`。
- `metrics.json`：下一节的全部指标。
- `cleanup.json`：暂停的频道数、服务是否关闭、临时目录是否删除。
- `summary.md`：固定标注、预算使用、invariant 结果、指标表。

`--keep` 会把 `home/` 和 `project/` 一起复制到产物目录，并保留临时目录。`--repeat N` 把 N 次运行写成 `run-1/`…`run-N/`，再在上一层写一份含均值/最小/最大的 `summary.md` 与 `metrics.json`。

## 指标

全部指标从 `home/workspace.sqlite` 计算。指标在 finally 里、runner 暂停频道之后、关闭服务之前算一次，所以它描述的正是产物目录里那份数据库；`metrics <运行目录>` 会得到逐字节相同的结果。

**算不出来的指标一律是字符串 `unknown`，绝不写成 0**——"没有发生"和"没法知道"必须能区分开。

| 指标 | 怎么算 | 什么时候是 `unknown` |
| --- | --- | --- |
| `turns` | `runs` 按 `source` 分：`morrow-schedule`/`nohuman-schedule` 是调度轮次，`*-chat` 是聊天，`native-app` 是场景预置。 | 不会。 |
| `reviews` | `loop_verifications` 按 `status` 分（passed/failed/unknown/未结束）。 | 不会。 |
| `time` | `virtualFrom/To/Minutes` 取 `runs` 的最早与最晚时间戳（虚拟时钟）；`steps` 来自 `timeline.jsonl`；`wallMs` 来自 `run.json`。 | 没有运行行时时间为 `unknown`；没有 timeline 时 `steps` 为 `unknown`；没有 `run.json` 时 `wallMs` 为 `unknown`。 |
| `decisions` | `strategy_decisions` 的总数、active/reviewed，以及 `review.outcome` 的四种分布。 | 不会。 |
| `reviewsCitingCapturedEvidence` / `reviewsAgentStatementOnly` | 已复盘的选择里，`review.evidenceIds` 与逐项 `results[].evidenceIds` 引用的证据中**存在 / 不存在** `origin !== 'agent'` 的那一条。 | 不会（没有复盘就是 0 次复盘，这是事实而非缺数据）。 |
| `expectations` | 复盘的 `assessment.results`：met/not_met/unknown 计数，以及 `checkedBy` 的 rule / agent 分布与 `rulePercent`。 | 一条都没核对过时 `rulePercent` 为 `unknown`（0 项没有比例）。 |
| `guardrails` | `defined` 数 `expectations[].kind==='guardrail'`；`checked`/`violationsCaught` 数复盘里对应 guardrail 的核对项与其中 `not_met` 的数量。 | 不会。 |
| `releases` | `loop_releases` 按状态分；`proposed` 数 `release.proposed` 审计事件；`postsAttempted` 数进入过 publishing/published/failed/unknown 的版本（这些状态只在产物已经 POST 之后出现）；`receiverPosts` 取 timeline 里 `approve`/`reject` 步骤记录的接收端计数。 | 没有 timeline 时 `receiverPosts` 为 `unknown`（接收端不在 SQLite 里）。 |
| `wakeups` | 每个 watch 一个计数：该 watch 的 `feedback.observed` 审计事件数——即真正被留存并唤醒频道的样本。取值没变的采样是安静的，不计数。 | 不会（没有 watch 就是空表）。 |
| `humanInterventions` | `events` 里 `actor==='human'` 且 `action` 为 `release.approved` / `release.rejected` / `native.message-submitted` 的数量。 | 不会。 |
| `repeatedFailures` | `calls.jsonl` 里按"操作 + 输入摘要"分组，统计被拒（状态 ≥ 400）超过一次的组数与总次数。 | **没有 `calls.jsonl` 时整项为 `unknown`**——拒绝记录不在 SQLite 里。 |
| `misattribution` | 复盘的 `review.runId` 在 timeline 里定位到它所属的步骤序号，取该序号之前最后一条 `truth` 标签；标签是 `noise`/`environment` 而复盘却 `improved` 或 `diagnosis==='expected'` 时计一次。 | **缺 `labels.json` 或缺 timeline 时为 `unknown`**。虚拟时钟只在 `advance` 时前进，同一时间戳上标签和复盘的先后只有步骤序号能分辨，所以两者都必需。 |
| `adjustmentLatency` | 每个 `not_met` 核对项：找到该预期来源在窗口内**第一条已经违反规则**的证据，算它的 `observedAt` 到复盘 `createdAt` 的虚拟分钟数，给出次数与 min/max/mean。 | 没有任何 `not_met` 核对项时整项为 `unknown`。 |
| `staleMemory` | 用 `labels.staleMemoryIds` 去比对全部选择的 `memoryRefs`（带 `use`）与 `understandingRefs` / 复盘的 `assessment.understandingRefs`（没有 `use`，视为沿用）：`followed`=被 `apply`；`adapted`=只被 `adapt`；`avoided`=只被 `avoid`/`not_applicable`；`ignored`=从未被引用。 | **缺 `labels.json` 时整项为 `unknown`**。 |
| `restartConsistency` | 还停在 `running` 的运行 / 频道、停在 `publishing` 的发布、还在 queued/running 的复核；四项都是 0 才 `ok`。 | 不会；没有 timeline 时只有 `restarts` 为 `unknown`。 |
| `goalOutcome` | 最近一个带 `rule` 的 outcome 预期，配上该来源**最新**一条采集证据的实际取值与机械核对结果。 | 没有这样的预期或该来源没有任何证据时为 `unknown`。 |
| `cost` | `usage_samples` 每个窗口首尾读数的差值，加上 `runs[].usage.delta`。 | **两者都没有时为 `unknown`**——fixture 运行永远如此：脚本化后台不报额度。 |
| `config` | `source` 用 `service/source-version.ts` 对**仓库根目录**取指纹（即算出这些数字的 harness 版本，不是被测项目）；`model` 取最近一次调度运行的 `model`（回退到脚本化任务快照的 `state.model`）；`permission`、`budget.maxRunsPerDay` 来自频道行；`mode`/`policy`/`seed`/`scenario`/`scenarioVersion`/`budget.turns`/`budget.reviews` 来自 `run.json`。 | 缺 `run.json` 时那几项为 `unknown`；取指纹失败时 `source` 为 `unknown`。 |

## compare、repeat 与自检

`compare <A> <B> [--ignore-volatile]` 把两份 `metrics.json` 拉平成点号路径后逐键比较，输出 Markdown 差值表（参数可以是运行目录，也可以直接是 `metrics.json` 文件）。

易变键 = 路径上任一段是 ID（UUID / 32 位十六进制）、或叶名以 `Id`/`Ids`/`At`/`Ms` 结尾、或属于 `id`、`ids`、`out`、`home`、`root`、`path`、`wallMs`、`runId`。`--ignore-volatile` 会丢掉它们，于是**同一份源码下两次 careful 运行必须零差异**。`config.source.digest` 不算易变：源码变了就应该看得见——所以做零差异对比时，两次运行之间不要改仓库。

`--repeat N` 跑 N 次同一场景同一策略，然后对每个**数值**指标给出均值、最小、最大（写进上一层的 `summary.md` 与 `metrics.json`）。

`policySelfCheck(careful, naive)` 是 harness 自己的检查：naive 必须在这些指标上确实更差，否则 `run all` 以退出码 1 结束，`tests/acceptance-harness.test.ts` 也会失败。

| 指标 | 期望 |
| --- | --- |
| `guardrails.defined` | naive 更低 |
| `guardrails.violationsCaught` | naive 更低（只有当 careful > 0，即场景真的产生了违反时才检查） |
| `staleMemory.followed` | naive 更高 |
| `reviewsCitingCapturedEvidence` | naive 更低 |
| `repeatedFailures.groups` | naive 更高 |

任一侧是 `unknown` 就算这一条不通过：自检不接受"没法比较"。

## 对真实数据目录算指标

```bash
npm run acceptance -- metrics ~/Library/Application\ Support/Morrow --out artifacts/weekly.json
```

`metrics` 接受任意运行目录或任意 Morrow 数据目录。它把 `workspace.sqlite`（以及存在的 `-wal`/`-shm`）复制到临时目录再以只读方式打开，**从不写源目录**，也不做迁移。数据目录没有标签，所以 `staleMemory`、`misattribution`、`repeatedFailures`、`releases.receiverPosts` 会是 `unknown`，其余从 SQLite 算出的指标照常给出。这是 Phase 3 每周复盘要在真实 daemon 目录上跑的命令。

## fixture 结果能证明什么，不能证明什么

**fixture 结果验证框架机制，不验证模型自主性。** 通过意味着：调度、预算、观察窗口、事前预期的机械核对、独立复核门禁、人工上线确认、重启后的记录一致性这些机制按约定工作，而且同样的输入能重复得到同样的结果。

它不能说明模型会不会自己选对问题、会不会发现真实的体验缺陷，也不能说明任何业务收益。策略是写死的状态机，反馈样本是场景给的，接收端是本机的。要衡量模型自主性，得用 live 模式接真实的 Codex 后台跑同一套场景和指标——那是后续步骤。

指标同样不说明模型自主性。`naive` 在约定指标上劣于 `careful`，证明的是**指标能看出协议被用错**，不是任何一种策略像模型。

## 加一个场景

在 `scenarios/` 下新建 `<id>.ts`，`export default defineScenario({...})`，`id` 只用小写字母、数字和连字符，跟文件名一致。`npm run acceptance -- list` 会自动发现它。

新场景要能同时被两种策略跑完，并让自检成立：至少预置一条 `stale: true` 的 learning（`staleMemory` 的分子），并且让某个窗口真的突破护栏（`guardrails.violationsCaught` 的分子）。`smoke` 为此在第二个窗口把 `errors` 提到 3 并标注 `truth: 'environment'`，又在采样和复盘之间加了一次 `advance`，好让"从违反出现到复盘反应"是一段真实时长；两处改动都没有放宽任何 invariant，careful 依旧全绿。
