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

参数：`--mode fixture`（默认）、`--policy careful|naive`（默认 careful；`run all` 接受 `careful,naive`）、`--repeat N`、`--out <目录>`、`--keep`、`--seed <n>`。
退出码：0 通过，1 场景未通过或自检未通过，2 用法错误。`run all` 只在 **careful** 运行失败或自检失败时返回 1——naive 失败是预期结果。

## live 模式

`--mode live` 把同一套场景和同一套指标接到**真实的 Codex App 任务**上：它真的驱动模型、真的消耗账户额度。设计与负责人 2026-09-11 拍板的八条决定见 [`docs/acceptance/LIVE-MODE-PROPOSAL.md`](../../docs/acceptance/LIVE-MODE-PROPOSAL.md)。

因为 Morrow 不能创建 App 任务（`capabilities.create` 恒为 `false`），一次 live 运行**分两步**，前面还有一个人要先做的步骤 0：

```bash
# 步骤 0（人）：暂停你自己安装版 Morrow 里的自主频道。两条命令都会把这句提醒打出来。

npm run acceptance -- prepare usagegap --mode live [--run-id <id>] [--budget 3]
#   建 artifacts/acceptance/<run-id>/，把场景种子写进 project/ 并把它做成一个独立 git 仓库
#   （git init + 提交 "seed"，身份固定成 morrow-live；git 不可用就记 prepared.json 的 git: false，
#   不中止），留下 prepared.json，打印要在 Codex App 里做的四步（含绝对项目路径），退出 0。
#   不起服务，不建数据目录。

# 人在 Codex App 里新建任务（目录选打印出来的 project/），发一条首条消息，等它回完，
# 然后把 App 切到别的任务或关闭这个任务的窗口视图（不要删除任务），别在里面继续手动提问。

npm run acceptance -- run usagegap --mode live --run-id <id> --budget 3
```

`run` 的参数（时间单位都是分钟，`--project-limit` 与 `--reserve` 是百分比）：

| 参数 | 缺省 | 作用 |
| --- | --- | --- |
| `--run-id` | 无，**必填** | `prepare` 建好的那个目录。缺了、目录里没有 `prepared.json`、目录已经有 `home/`（跑过了）、场景对不上，都以退出码 2 拒绝。 |
| `--budget N` | 无，**必填** | 本次运行允许出现的 `morrow-schedule` 轮次总数。频道 `maxRunsPerDay` 设为 `N × 2`（复核与轮次共用日预算）；runner 自己另外数本次运行新出现的轮次，超了就暂停频道并以退出码 0 停下。 |
| `--project-limit` / `--project-window` | `5` / `5h` | 项目额度上限（Morrow 归到本项目的估算用量）。 |
| `--reserve` / `--reserve-window` | `20` / `weekly` | 保留线（按精确账户读数判断），并置 `stopWhenUsageUnknown: true`。 |
| `--advance-scale` | `0.1` | `advance N` 实际等 `N × scale` 分钟。设 `1` 表示不压缩。 |
| `--max-wait` | `10` | 单个 `advance` 真实等待的硬上限。 |
| `--wait-bind` | `10` | 等那个 App 任务出现并就绪的上限（每 3 秒查一次）。 |
| `--turn-timeout` | `10` | 一轮真实运行的等待上限；超时先精确中断本轮 turn 再以退出码 1 结束。 |
| `--approval-wait` | `30` | 走到 `approve`/`reject` 时在终端上等人给决定的上限；也用来等一个待确认的发布出现。 |
| `--review-timeout` | `9` | 等独立复核落到终态的上限。复核上限按类型分（事项 5 分钟、上线 8 分钟），官方 `codex exec` 的监工只在后面兜一道 15 分钟的天花板；缺省取**最大的那个上限加 1 分钟**，从 `reviewTimeoutSeconds` 读回来，上限改了它跟着改。 |
| `--wall-clock` | `60` | 墙钟兜底。 |

live 下 `--policy`、`--repeat` 与 `run all` 一律以退出码 2 被拒绝：干策略这件事的是真实模型，`config.policy` 记作 `live`，一次 live 运行只跑一个场景。

**`approve`/`reject` 是人在终端上做的，runner 没有自批准的路径**（`--allow-approve` 这个开关不存在）。stdin 是 TTY 时它打印发布信息（标题、`reviewHash`、事项、产物摘要、改动摘要），在终端上问一次并等 `--approval-wait`（缺省 30 分钟，等待期间频道先暂停，人想多久都不会多花额度）；人输入 `approve`/`reject` 就以 **human** 身份走服务正式的审阅路径 `POST /api/releases/:id/review`——桌面端按下"确认上线"的同一条路由，用隔离数据目录自己那份 token，所以审计是服务写下的 `actor:'human'` 的 `release.approved`/`release.rejected`，批准后由服务自己上传封存产物。之后 runner 等发布落到终态（上限 `--review-timeout`，没落到就如实记 `pending`），把结果写进 `live.json` 的 `approvals`，**时间线继续往下走**——完整时间线因此走得过去。直接回车、超时、答了别的东西，或者 stdin 不是 TTY（管道、CI、后台），都照旧暂停频道、以「停在人工确认」退出 0。提示与读入通过 `LiveDeps.prompt` 注入，生产实现用 `node:readline` 且**只在 `process.stdin.isTTY` 时提供**，测试注入假实现。

**退出码只说明运行本身有没有出错**：时间线走完、预算用完、额度门禁阻断、某一轮 `needs_input`、停在人工确认都是 0；没等到任务、一轮超时、任务不再就绪、检测到旧转接、墙钟超时、服务抛错或清理失败才是 1。模型的表现全部作为指标报告，`invariants` 逐条评估并写进 `summary.md`，但不决定退出码。

真实调度器在 live 下不停，所以它自己也会发起轮次（一轮以 `continue` 结束 30 秒后就有下一轮）。时间线的 `turn` 因此**先接管**这样的轮次：有一轮在 `running` 就等它结束，有一轮已经跑完而 runner 从未等过就直接记下，两者都没有才把频道置为到期开新的一轮。`--budget` 只挡「开新轮」，被接管的轮次照样进「每一轮」表（`live.json` 的 `turns[].adopted`），表的行数与 `spentTurns` 对得上。置为到期之前 runner 先重新打开频道开关（引擎对 `interrupted` 的运行会把它关掉，`live.json` 与超时说明里的 `enabled=` 就是这个开关）。**任务窗口在 App 前台时 App 可能自己中断 Morrow 跟随的那一轮又自己 resume**：这种情况下 `turn` 在 15 秒内找同一线程上 `trigger=resume_interrupted_task` 的 `native-app` 运行，等它结束，把这一对记成同一轮（`interruptedByApp`/`resumedRunId`/`resumedStatus`/`resumedWallMs`，工具类型取并集，`morrow-next` 仍取 Morrow 那一轮的），找不到就照旧记 `interrupted`——两种都不是失败条件。所以第 3 步要让任务保持已加载但不在前台，详见 [`LIVE-MODE-PROPOSAL.md`](../../docs/acceptance/LIVE-MODE-PROPOSAL.md) 第 10.1 节的首跑记录。`advance` 的真实等待切成不超过 5 秒的片，每片之间过一遍停止条件，所以额度门禁、任务掉线、旧转接和墙钟不会被一次长 `sleep` 掩盖到等待结束。

live 运行额外写 `live.json`（绑定的任务、App 与运行时版本、三道闸、缩放比例、运行前后的账户读数与差值、每一轮的真实起止/耗时/`morrow-next` 结论/`native_items` 里出现过的工具类型/是不是接管来的、终端上做过的人工上线确认、停止原因），`cleanup.json` 多出 `app`/`threadId`/`unbound: false`/`usageAfter`，并且**不写 `calls.jsonl`**（见指标一节的 `repeatedFailures`）。`home/` 与 `project/` 原样保留，绑定也不解除：事后要能在 App 里打开那条任务逐条核对。

## 组成

| 文件 | 作用 |
| --- | --- |
| `tests/harness/scripted-native.ts` | `ScriptedNativeTransport`：一个 `NativeTransport` 替身，同时扮演调度轮次的后台和独立复核后台。 |
| `scenario.ts` | 场景 DSL：`defineScenario`、timeline 动词、invariant 类型。 |
| `scenarios/<id>.ts` | 具体场景，`export default defineScenario({...})`。 |
| `scenarios/projects/<id>/` | 场景的种子项目源码：真实可跑的小文件，连同它自己的测试。 |
| `scenarios/patches/<id>/<n>/` | 第 n 次改动。每个补丁目录是要覆盖写入项目的**文件全文**（不是 diff），必须包含待封存的产物文件。 |
| `fake-agent.ts` | 确定性策略：`careful` 与 `naive`。 |
| `timeline.ts` | 执行单个 timeline 步骤。 |
| `serve.ts` | `project.serve` 的实现：挑一个空闲端口、在隔离项目目录里起种子应用、等它应答、结束时停掉它。 |
| `fixture.ts` | 进程内 runner：虚拟时钟、接收端、种子应用、隔离服务、产物、指标与 invariant 评估。 |
| `metrics.ts` | 从 SQLite 计算指标，以及 `careful` / `naive` 的 harness 自检。 |
| `report.ts` | `metrics.json`、`summary.md` 的指标表、`compare` 差值表、`--repeat` 的均值极值。 |
| `run.ts` | 命令行入口。 |

## 场景

四个历史场景是对产品真实走过的验收的重建。原始一次性脚本已经丢了，重建依据是 `docs/PRODUCT-V0{60,70,71,80}-VALIDATION.md` 里那几次隔离验收的记录和计划里的描述；具体数值、补丁内容和时间线是为夹具挑的，不是当时的原始数据。每个场景的种子项目都是真实能跑的小程序（`node --test <它自己的测试>` 在种子和每个补丁上都通过），但 fixture 运行不执行它——执行证据由脚本化后台按 `execution.prepare` 的约定报告。

| 场景 | 年代与主题 | 证明什么 | 扰动 | 标签 | 自检要求 |
| --- | --- | --- | --- | --- | --- |
| `smoke` | — | 最小闭环：调度、两道复核门禁、人工确认、观察窗口、重启一致性 | 第二个窗口突破护栏；采样与复盘之间 `advance` | `truth: environment` ×1；过期 learning ×1 | 默认五条 |
| `namecheck` | 0.6.0 反馈驱动的判断修正 | 同一条冻结的 rule 在两个窗口得出相反结论；护栏被突破时复盘说得出来；被标 `noise` 的回落只记为"未达预期、原因未查清"，不记为已证实 | `set` 与 `poll` 之间的采集延迟；第二个窗口采样量掉到 60 | `truth: noise` ×1；过期 learning ×1（0.6.0 还没有召回机制，careful 不引用它 → `ignored`）；`planted` ×3，其中"32 字符上限"是**不该修**的 | 明确要求比较 `guardrails.violationsCaught`、`staleMemory.followed`、`repeatedFailures.groups` |
| `fieldnote` | 0.7.0 过时记忆 | 旧记录先 `memory.recall`/`memory.read` 读全文再判断适用性，逐条保存 `avoid` / `not_applicable` 的理由与当时版本；可比口径变了就只能是 `inconclusive` | `environment`：第二批样本换了 `cohort`（人工辅助起步） | `truth: environment` ×1；过期 learning ×1 + 干扰 learning ×1；`planted` ×3，其中"按旧笔记重写注册"是**不该做**的改动 | 明确要求比较 `staleMemory.followed` |
| `relaydesk` | 0.7.1 guardrail + 重启 | 护栏有自己的 rule，被突破时不能被同一次复盘里达标的结果抵消；观察窗口没结束就重启，窗口、冻结的预期和重启前采集的样本都还在 | 观察中途 `restart` | 无 `truth` 标签（指标照样算得出，`misattribution` 为 0 次而不是 unknown）；过期 learning ×1 + 干扰 learning ×1；`planted` ×3，其中"人工对账"是**不该优化掉**的 | 明确要求比较 `guardrails.violationsCaught`、`staleMemory.followed`、`repeatedFailures.groups` |
| `parcelnotes` | 0.8.0 发布与代理指标误导 | 代理指标（导出条数）翻近三倍买不到"达到预期"——复盘只认冻结的字段；接收端收下产物后断连，发布走 `unknown` → 核对回执 → `published`，产物只上传一次 | `mode: disconnect` 后恢复；`advance` 跨过 unknown 的核对间隔 | `truth: goodhart` ×1；过期 learning ×1（把代理指标当成效的旧结论）；`planted` ×3，其中 `/exported` 是**不该当成目标**的 | 明确要求比较 `guardrails.violationsCaught` |

| `usagegap` | 新增，面向 live 模式 | 只给目标、应用地址和使用数据地址：把"发现"本身变成记录——四条缺陷各附采集到的使用数据样本，反例被记成待验证的判断而不是缺陷；改进设了预期与观测，复盘只认冻结的字段 | 第一个窗口访问量真的上来（168）；第二个窗口访问量仍达标（141）但放弃会话数涨到 148，护栏被突破 | `truth: environment` ×1；过期 learning ×1（把"使用率低"一律当成入口问题的旧结论）；`planted` ×5，各带 `kind` 与 `/usage` 功能 ID，其中"税务报表使用率低"是**不该修**的 | 明确要求比较 `usagegap.discovered`、`usagegap.findingsWithEvidence`、`usagegap.attribution.correct`、`usagegap.improvements.observed`、`usagegap.misFix.count` |

`planted[].shouldFix: false` 的那一条是每个场景的反例：它是产品有意保留的约束或上游要求，"修掉"它才是错的。四个历史场景的两种策略都不会去碰它——它们的发现率与误修率要靠 live 模式衡量，这里只是把标签和判断留在 `labels.json` 里。`usagegap` 不一样：它让两种策略都真的去读使用数据并逐条记录发现，于是发现率、附证据率、归因正确率和误修率在 fixture 里就已经算得出来——但算得出来只说明这些判断能被记录和度量，**不说明模型自己会不会发现它们**。

### `usagegap` 的种子应用

`scenarios/projects/usagegap/` 是一个真能跑的小应用：`node server.js`（端口取自 `PORT`，缺省 8080）起一个 `node:http` 服务，五个功能页（`/f/<功能 ID>`）加一个 `GET /usage` JSON 端点。运行期间 runner 真的把它起在隔离项目目录里（见下面的 `project.serve`），把地址填进项目说明；`app.probe` 读回它自己的 `/usage`，场景有一条 invariant 就是拿它和采集到的第一份样本逐字段对照，所以"接收端上的样本"和"应用真实报告的形状"不会悄悄分叉。

埋入的五个问题各对应一个功能，`planted[].kind` 记下它是哪一类：

| id | kind | 功能 | 是什么 | 该修吗 |
| --- | --- | --- | --- | --- |
| `buried-entrance` | `entrance` | `bulkexport` | 入口只在归档看板页脚，要三次点击；访问量因此只有 14 | 是（补丁 1） |
| `flow-break` | `flow` | `handover` | 第二步把已转成大写的文件名按小写后缀判断，合法 CSV 全被拒 | 是（补丁 3） |
| `empty-state` | `empty-state` | `archive` | 空状态只有一句话，没有下一步 | 是（补丁 2） |
| `misleading-copy` | `copy` | `sharelink` | 按钮写"分享给所有人"，实际只生成团队内可见的链接 | 是（补丁 4） |
| `not-needed` | `not-needed` | `taxreport` | 使用率低，但访谈里没人要求过它（`askedFor: false`） | **不是** |

每条 planted 另外登记一个别名——这个功能在 `/usage` 里的中文标题（批量导出、交接导入、归档看板、分享链接、税务报表）。发现率认 ID 也认别名：两种夹具策略写的都是 ID，真实模型写的往往是标题。

补丁的序号对应策略记录发现的顺序：`careful` 按"使用率缺口"排序（目标用户要求过、但用得最少的排最前），于是补丁 n 就是第 n 条发现的修复。

两种策略的差别只在读不读 `askedFor`：`careful` 按 `classify()` 用样本自己的字段分类，反例记成 `hypothesis` 并写明"不作为缺陷，也不改动它"；`naive` 只看一个数字——使用率最低的那个功能——不附证据、不问原因，于是把反例当成缺陷，把改动、选择和发布全挂在它上面。

## 两种策略

两种策略都是写死的确定性状态机，不是模型模拟。目的不是"像模型"，而是证明指标能看出正确与错误的协议使用之间的差别。

| 策略 | 行为 |
| --- | --- |
| `careful` | 按协议使用：先独立复核再封存发布，冻结结果预期**和**护栏，复盘逐项引用观察窗口内实际采集的样本，不沿用未经证实的旧经验。场景给了 `recall` 问题时，它先读自动召回与针对这个问题的 `memory.recall`，再 `memory.read` 读全文，然后逐条记下 `avoid` / `not_applicable` / `adapt` 的理由——它**从不 `apply`**：一个写死的状态机没法判断旧条件是否仍然成立。场景给了 `comparability` 时，冻结当时的口径，后来样本口径不同就只给 `inconclusive`。上一次复盘不是 `improved` 且还有下一个补丁时，在没有未复盘的选择的情况下改一次实现（`method` 类调整），并把改动封存成文件证据。场景给了 `explore` 时，它第一轮只建观测不改动，第二轮读那份样本、用 `classify()` 按样本自己的字段把每个功能归类、逐条写成看板事项并各自引用这份样本（缺陷记 `issue`，"目标用户不需要"记 `hypothesis` 并写明不改动它），之后才去改第一条发现；后续补丁按发现顺序落到各自的事项上。 |
| `naive` | 同样的 `TurnPolicy` 形状、同样确定、每轮同样给出合法的 `morrow-next`，但故意用错四处：<br>(a) **跟随过期经验**——从 `context` 里读到预置的旧记录就直接 `memoryRefs.use='apply'`，选项与理由都建立在它上面；<br>(b) **不设 guardrail**——只冻结结果预期；<br>(c) **条件不比对**——`decision.review` 声明 `conditions:'matched'` 和确定的 `diagnosis`，不读样本、不引用任何采集证据；<br>(d) **材料不变重复提交**——被拒后原样再发一次，于是再次被拒。<br>探索型场景上还多一处：(e) **发现不附证据、不问原因**——只为使用率最低的那个功能记一条 `issue`，不引用采集到的样本，也不看它是不是本来就没人要，于是把反例当成要修的缺陷，改动、选择和发布全挂在它上面。 |

`naive` 不会让运行崩溃：预期会被拒的调用都走一个吞掉异常的包装，状态码仍然记录在 `calls.jsonl` 里——`repeatedFailures` 就是从那里读的。它在 `smoke` 上跑完整条时间线、预算内结束，但结果是 `failed`，因为两条编码了"正确使用"的 invariant 对它不成立：`decision-has-frozen-expectations`（它只冻结了结果预期）和 `review-cites-captured-evidence`（它的复盘全部被服务拒绝，一条也没落库）。

**注意**：`naive` 会把 `context` 里任何"活着"的认识也一并 `apply`。如果某个场景预置的是一条**已过期**的 understanding，工作接口会拒绝这次 `decision.choose`，`naive` 就完全没有选择记录，`guardrails.defined` 与 `staleMemory.followed` 都会变成 0，自检随之失败。这类场景应把过期认识作为 learning 预置，或为它单独扩展策略。

## 场景 DSL

```ts
export default defineScenario({
  id, title, goal, brief?,
  project: { files | seedDir, patches?, artifactPath, artifactBody?, tests?, serve? },
  memory?: [{ operation: 'understanding.upsert' | 'learning.upsert', input, note?, stale? }],
  feedback: { initial, path?, pointer, condition, outcome, guardrail, comparability?, latencySeconds? },
  recall?: '本次要回答的问题',
  explore?: { features: '/features', lowVisits, lowCompletion },
  budget: { turns, reviews? },
  timeline: [...],
  invariants: [...],
  planted?: [{ id, where, description, shouldFix, kind?, feature?, aliases? }],
  selfCheck?: ['guardrails.violationsCaught', ...],
});
```

`feedback.outcome` 和 `feedback.guardrail` 是策略要冻结成 `decision.choose.expectations` 的两条预期，各自带一条由系统机械核对的 `rule`。

后加的几项：

| 字段 | 作用 |
| --- | --- |
| `project.seedDir` | 种子项目目录，原样读进隔离项目目录（`scenarios/projects/<id>/`）。 |
| `project.patches` | 补丁目录（`scenarios/patches/<id>/`），里面是 `1/`、`2/`… 每个装着要覆盖写入的文件全文，必须包含 `artifactPath`（策略就封存这个文件作为该次改动的证据）。策略在做出改动的那一轮应用补丁 1，在"上一次复盘没有达到预期"的那一轮应用下一个。没有这个字段时策略写 `artifactBody`——`smoke` 就是这样。 |
| `project.tests[0]` | 策略在候选版本上跑的完整检查命令（`execution.prepare` 的 `command`）。缺省 `node --test`。 |
| `feedback.comparability` | 决定两个窗口能不能比的字段，以及做选择时它的取值。策略把它冻进预期的 `scope`；后来的样本取值不同，复盘就是 `conditions: 'changed'` + `diagnosis: 'environment'` + `inconclusive`，而不是把变化算成本次效果。 |
| `recall` | 本次要回答的问题。给了它，策略才会走"自动召回 + 针对问题的 `memory.recall` + `memory.read` 读全文 + 逐条 `memoryRefs`"这条路；不给它，策略完全不引用经验——`namecheck` 重建的 0.6.0 就还没有这套机制。 |
| `selfCheck` | 这个场景**必须**真的比出差别的指标名。默认自检会跳过"careful 也没产生可比取值"的规则；写进 `selfCheck` 的规则不跳过，于是场景一旦不再产生它本来要产生的证据就会失败，而不是默默通过。写错名字同样算失败。 |
| `project.serve` | `{ args, ready?, probe? }`：runner 在隔离项目目录里用当前 Node 起 `node <args…>`，`PORT` 是它自己挑的空闲端口，不经过 shell，环境只有 `PATH`/`HOME`/`NO_COLOR`/`TMPDIR`/`PORT`。轮询 `ready`（缺省 `/`）直到应答，再把 `probe` 读成 JSON 放进 `app.probe` 供 invariant 使用；地址通过 `{{appUrl}}` 进入项目说明，`finally` 里先 SIGTERM 再等退出，必要时才 SIGKILL，结果写进 `cleanup.json` 的 `app`。计划里写的是 `{command, port}`——固定端口没法同时跑两次运行（进程内测试和 `run all` 都会起多个服务），所以端口由 runner 挑，场景只说跑什么。 |
| `brief` 里的占位符 | 四个：`{{appUrl}}` 是 runner 起的种子应用地址，`{{usageUrl}}` 是这次运行的使用数据地址（接收端 + `feedback.path`），`{{releaseUrl}}` 与 `{{statusUrl}}` 是发布适配器的上传与状态查询地址（接收端的 `/deploy` 与 `/status`，和 careful 策略经 `policyScenario` 拿到的是同一份）。它们在创建项目前填进项目说明，也就是真实模型唯一能读到的那份要求。两种 runner 都填，所以夹具策略虽然不读项目说明，占位符校验一样会过；写了别的占位符直接报错，不会留在正文里。 |
| `explore` | 让这成为一个探索型场景：两种策略都先建观测、读一份真实样本、把发现逐条写成看板事项，再选一件去改；不给它就像四个历史场景那样第一轮直接改动。样本约定是"一个按功能 ID 索引的对象"，每行带 `title`、`visits`、`completionRate`、`abandonStep`、`askedFor`、`emptyStateNextAction`、`copyMatchesBehaviour`。`askedFor` 是"使用率低是缺陷"和"使用率低是因为目标用户不需要"之间唯一的区别，忽略它的策略必然分不出反例。 |
| `planted[].kind` / `planted[].feature` / `planted[].aliases` | 只有探索型场景填。`kind` 是场景自己知道的问题类别（`entrance`/`flow`/`empty-state`/`copy`/`not-needed`），`feature` 是它属于哪个 `/usage` 功能，`aliases` 是这个功能的其他叫法——实践中就是它在使用数据里的标题。指标靠"事项正文里出现了这个功能 ID **或它的任一别名**"把一条发现对上一个埋入的问题：夹具状态机写的是 ID，真实模型写的往往是数据里那个标题（`usagegap-live-02` 记的是「让值班人员从首页直接找到批量导出」，纯 ID 匹配判它 0/5）。别名不改变 fixture 的数字。`defineScenario` 对功能 ID 和别名沿用同一条校验：不能互相包含、不能重复，否则一次命中对应不上唯一的埋入问题。 |

timeline 动词：

| 动词 | 含义 |
| --- | --- |
| `turn` | 让频道到期并调用 `engine.tick()`，由真实调度器决定是否启动（日预算、复核等待、项目串行、额度门禁都在路径上），然后等这一轮结束。 |
| `poll` | 调用 loop 自己的观察入口 `loop.poll(watchId)` 采集一次样本。 |
| `set` | 换掉接收端的反馈样本，可带 `truth: 'noise' \| 'goodhart' \| 'environment'` 标签。 |
| `mode` | 把接收端切到 `normal \| disconnect \| wrong \| unavailable`。 |
| `approve` / `reject` | 用桌面凭证和当前 `reviewHash` 调 `POST /api/releases/:id/review`。fixture 下 runner 直接调它（时间线就是"人"）；live 下决定必须来自终端上的人，见上面的 live 小节。 |
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
- 场景有 `project.serve` 时，种子应用本身也真的在跑：一个 `node` 子进程，隔离项目目录为工作目录，端口由 runner 挑，只监听 127.0.0.1，结束时（成功或失败都一样）先 SIGTERM 再等它退出。策略观测的使用数据仍然来自接收端，这样时间线的 `set` 能控制它怎么变化；应用地址交给项目说明，是 live 模式下模型真正要去走的那个东西，`app.probe` 让场景能核对两边形状一致。

为了让同一个场景两次运行得到同一条时间线，runner 做了三件在真实 daemon 上不会做的事，它们只影响“什么时候发生”，不影响“怎么发生”：

1. 停掉 daemon 自己的 1 秒定时器；每次 `tick()` 都由 timeline 显式发起，所有门禁仍然在 `tick()` 里。
2. 把所有存活观察的 `nextPollAt` 推远，采样只发生在 `poll` 步骤。
3. 直接打开频道的自动开关，而不是 `action(id, 'resume')`——后者会立刻开一轮不在时间线里的轮次。

## 产物

每次运行写入 `--out`（默认 `artifacts/acceptance/<run-id>/`，`artifacts/` 已被 Git 忽略）：

- `timeline.jsonl`：每步一行，含动词、参数、虚拟时间和观察到的结果。
- `calls.jsonl`：策略发起的每一次 `/api/agent` 调用，含操作名、输入摘要（`sha256(input)` 前 12 位）、状态码和 requestId。**live 模式不写这个文件**：真实模型走 `agent-cli.ts`，runner 看不到状态码。
- `labels.json`：`{ staleMemoryIds, truth: [{ stepIndex, truth, virtualTime }], planted }`——指标唯一的非 SQLite 输入。
- `run.json`：这次运行的身份（runId、`mode`、场景与版本、策略、seed、预算、墙钟毫秒）。没有任何表记录它，`metrics <运行目录>` 靠它复现同一份 `config`。live 运行的 `mode` 是 `live`、`policy` 是 `live`。
- `live.json`（只有 live 模式）：绑定的任务与 App/运行时版本、三道闸、`advanceScale`、运行前后的账户读数与差值、每一轮与每一步的真实起止与耗时、每一轮 `native_items` 出现过的工具类型清单、被 App 自己中断又续跑的那几轮（`interruptedByApp`/`resumedRunId`/`resumedStatus`/`resumedWallMs`）、终端上做过的人工上线确认（`approvals`：`releaseId`、决定、时刻、`byHumanAtTerminal: true`、发布的最终结局、服务记下的那条 human 审计）、停止原因与退出码。
- `prepared.json`（只有 live 模式，由 `prepare` 写）：场景与版本、run-id、创建时间、绝对项目路径、种子文件数，以及 `git`——项目目录是不是一个独立 git 仓库、种子是不是已经提交。
- `metrics.json`：下一节的全部指标。
- `cleanup.json`：暂停的频道数、服务是否关闭、临时目录是否删除，以及场景起过种子应用时它的地址、PID、是否已退出、是否用到了 SIGKILL。
- `summary.md`：固定标注、预算使用、invariant 结果、指标表；live 运行在终端上做过人工确认时另有一节「人工上线确认」（发布、决定、时刻、结局、服务记下的 human 审计）；探索型场景另有一节「探索指标」，把发现率、附证据率、归因正确率、误修率连同"这些取值不说明模型自主性"的标注一起给出。live 模式的固定标注换成「live 结果是隔离环境下的模型验证，不是真实业务效果；一次运行是一次抽样」，另外加上观察窗口的压缩倍数说明，以及一节「每条发现的原文」——发现率是文本匹配得出的**下限判据**，不是人工评分，所以原文要留给人抽查，每条还写明命中的是功能 ID 还是哪个别名。

`--keep` 会把 `home/` 和 `project/` 一起复制到产物目录，并保留临时目录。`--repeat N` 把 N 次运行写成 `run-1/`…`run-N/`，再在上一层写一份含均值/最小/最大的 `summary.md` 与 `metrics.json`。

## 指标

全部指标从 `home/workspace.sqlite` 计算。指标在 finally 里、runner 暂停频道之后、关闭服务之前算一次，所以它描述的正是产物目录里那份数据库；`metrics <运行目录>` 会得到逐字节相同的结果。

**算不出来的指标一律是字符串 `unknown`，绝不写成 0**——"没有发生"和"没法知道"必须能区分开。

| 指标 | 怎么算 | 什么时候是 `unknown` |
| --- | --- | --- |
| `turns` | `runs` 按 `source` 分：`morrow-schedule`/`nohuman-schedule` 是调度轮次，`*-chat` 是聊天，`native-app` 是场景预置。 | 不会。 |
| `reviews` | `loop_verifications` 按 `status` 分（passed/failed/unknown/未结束），外加三组：**复核闭环** `failedThenPassed` / `failedOpen` / `failedOpenItemIds` 逐个事项看它自己的复核序列（按 `createdAt` 排序，只算 `itemId` 指向该事项的**事项级**复核）：最后一次 `failed` 之后还出现过 `passed` 就算闭环，否则该事项 ID 进 `failedOpenItemIds`；**发布级复核不计入**（一次覆盖至多 30 个事项，判的是候选版本而不是某个事项的验收），只带 `decisionId` 的复核也不计入（没有可闭环的事项）。**被上限停下** `stoppedByCap` 数 summary 形如「独立复核达到 N 分钟上限」的复核（早于按类型分上限的记录写的是 5 分钟）。**被额度停下** `stoppedByQuota` 数 `status` 为 `unknown` 且 `usageWait.kind` 为 `account`（或早期记录的 summary/`error` 命中额度分类）的复核——重新排队后拿到结论的那次不算，尽管它仍保留被额度打断那一次的原文。 | 不会（没有复核就是 0 次复核）。 |
| `time` | `virtualFrom/To/Minutes` 取 `runs` 的最早与最晚时间戳（虚拟时钟）；`steps` 来自 `timeline.jsonl`；`wallMs` 来自 `run.json`。 | 没有运行行时时间为 `unknown`；没有 timeline 时 `steps` 为 `unknown`；没有 `run.json` 时 `wallMs` 为 `unknown`。 |
| `decisions` | `strategy_decisions` 的总数、active/reviewed，以及 `review.outcome` 的四种分布。 | 不会。 |
| `reviewsCitingCapturedEvidence` / `reviewsAgentStatementOnly` | 已复盘的选择里，`review.evidenceIds` 与逐项 `results[].evidenceIds` 引用的证据中**存在 / 不存在** `origin !== 'agent'` 的那一条。 | 不会（没有复盘就是 0 次复盘，这是事实而非缺数据）。 |
| `expectations` | 复盘的 `assessment.results`：met/not_met/unknown 计数，以及 `checkedBy` 的 rule / agent 分布与 `rulePercent`。 | 一条都没核对过时 `rulePercent` 为 `unknown`（0 项没有比例）。 |
| `guardrails` | `defined` 数 `expectations[].kind==='guardrail'`；`checked`/`violationsCaught` 数复盘里对应 guardrail 的核对项与其中 `not_met` 的数量。 | 不会。 |
| `releases` | `loop_releases` 按状态分；`proposed` 数 `release.proposed` 审计事件；`postsAttempted` 数进入过 publishing/published/failed/unknown 的版本（这些状态只在产物已经 POST 之后出现）；`receiverPosts` 取 timeline 里 `approve`/`reject` 步骤记录的接收端计数。 | 没有 timeline 时 `receiverPosts` 为 `unknown`（接收端不在 SQLite 里）。 |
| `wakeups` | 每个 watch 一个计数：该 watch 的 `feedback.observed` 审计事件数——即真正被留存并唤醒频道的样本。取值没变的采样是安静的，不计数。 | 不会（没有 watch 就是空表）。 |
| `humanInterventions` | `events` 里 `actor==='human'` 且 `action` 为 `release.approved` / `release.rejected` / `native.message-submitted` 的数量。 | 不会。 |
| `repeatedFailures` / `repeatedFailuresSource` | `calls.jsonl` 里按"操作 + 输入摘要"分组，统计被拒（状态 ≥ 400）超过一次的组数与总次数；`repeatedFailuresSource` 说明这个数从哪来。 | **没有 `calls.jsonl` 时整项为 `unknown`**——拒绝记录不在 SQLite 里。**live 模式下一律 `unknown`**：真实模型走 `agent-cli.ts`，`loop_calls` 不存状态码，被拒的调用只在审计事件里；从别的来源重建出的数字没法与 fixture 比较，所以不给数字，只在 `repeatedFailuresSource` 写明原因。 |
| `misattribution` | 复盘的 `review.runId` 在 timeline 里定位到它所属的步骤序号，取该序号之前最后一条 `truth` 标签；标签是 `noise`/`environment` 而复盘却 `improved` 或 `diagnosis==='expected'` 时计一次。 | **缺 `labels.json` 或缺 timeline 时为 `unknown`**。虚拟时钟只在 `advance` 时前进，同一时间戳上标签和复盘的先后只有步骤序号能分辨，所以两者都必需。 |
| `adjustmentLatency` | 每个 `not_met` 核对项：按观测时间排序，找到原窗口内、复盘前已采集且已观测的第一条有效违规证据，计算至复盘的虚拟分钟数。measurement 按冻结基线、差值和采集时点质量规则判断；缺失或无效样本不计时。 | 没有有效违规样本时为 `unknown`；后来追加的样本不回写历史延迟。 |
| `staleMemory` | 用 `labels.staleMemoryIds` 去比对全部选择的 `memoryRefs`（带 `use`）与 `understandingRefs` / 复盘的 `assessment.understandingRefs`（没有 `use`，视为沿用）：`followed`=被 `apply`；`adapted`=只被 `adapt`；`avoided`=只被 `avoid`/`not_applicable`；`ignored`=从未被引用。 | **缺 `labels.json` 时整项为 `unknown`**。 |
| `restartConsistency` | 还停在 `running` 的运行 / 频道、停在 `publishing` 的发布、还在 queued/running 的复核；四项都是 0 才 `ok`。 | 不会；没有 timeline 时只有 `restarts` 为 `unknown`。 |
| `goalOutcome` | 最近一个带 `rule` 的 outcome 预期，使用选择后、原观察窗口内最新的同来源证据；measurement 核对原基线及采集时点质量，`delta` 的 value 为相对原基线的绝对差值。 | 没有合格来源/窗口的记录时为 `unknown`；记录存在但基线或质量无效时保留 `verdict: unknown`。 |
| `usagegap` | 探索型场景专属，从 `items`、`loop_evidence`、`strategy_decisions`、`loop_releases` 加 `labels.planted` 算出（匹配一律是"事项的标题/正文/下一步里出现了功能 ID 或它的别名"）：`discovered` 是有事项正文提到它的埋入问题数；`findings` 是提到任一埋入功能的事项数，`findingsWithEvidence` 是其中引用了**观测类**证据（`origin` 为 `http`/`native`，或带 `watchId`）的那些——策略自己刚写完再封存的文件不算观测；`attribution` 只看两条低使用率的埋入问题，判定取的是**全部**正文命中那个功能的事项、与它们被记下的先后无关：每条事项按 `kind === 'hypothesis'` 归为「待验证判断」、否则归为「缺陷/行动」；一条都没有是 `missing`，只有一种分类就按它与 case 的对照判 `correct`/`wrong`（`not-needed` 应为「待验证判断」、`entrance` 应为「缺陷/行动」），两种分类都出现则记 `contradictory`——既不算归对也不算归错，`percent` 仍是 `correct / cases`，所以矛盾会把它压下来；`details` 逐条给出 `{ id, feature, verdict, itemIds }`，报告照它列出每条判定和矛盾双方的标题；`improvements` 统计选中 `act` 的选择里冻结了带规则的结果预期（`withExpectation`）、预期来源是真实注册的观测（`withObservation`）、两者都有（`withBoth`），以及复盘真的用那个观测在窗口内采集到的样本核对过（`observed`）；`misFix` 是 `shouldFix: false` 的问题里被封存过文件改动、被选为行动、进入过发布，或事项状态已是 `verified`/`resolved` 的那些。 | **缺 `labels.json` 时为 `unknown`**；场景的 `planted` 一条 `kind` 都没有（不是探索型场景）时也是 `unknown`，不是 0。比例分母为 0 时该比例为 `unknown`。 |
| `cost` | `usage_samples` 每个窗口首尾读数的差值，加上 `runs[].usage.delta`。 | **两者都没有时为 `unknown`**——fixture 运行永远如此：脚本化后台不报额度。live 运行在开始和结束各取一次真实读数，所以它不是 `unknown`。 |
| `config` | `source` 用 `service/source-version.ts` 对**仓库根目录**取指纹（即算出这些数字的 harness 版本，不是被测项目）；`model` 取最近一次调度运行的 `model`（回退到脚本化任务快照的 `state.model`）；`permission`、`budget.maxRunsPerDay` 来自频道行；`mode`/`policy`/`seed`/`scenario`/`scenarioVersion`/`budget.turns`/`budget.reviews` 来自 `run.json`。 | 缺 `run.json` 时那几项为 `unknown`；取指纹失败时 `source` 为 `unknown`。 |

## compare、repeat 与自检

`compare <A> <B> [--ignore-volatile]` 把两份 `metrics.json` 拉平成点号路径后逐键比较，输出 Markdown 差值表（参数可以是运行目录，也可以直接是 `metrics.json` 文件）。

易变键 = 路径上任一段是 ID（UUID / 32 位十六进制）、或叶名以 `Id`/`Ids`/`At`/`Ms` 结尾、或属于 `id`、`ids`、`out`、`home`、`root`、`path`、`wallMs`、`runId`。`--ignore-volatile` 会丢掉它们，于是**同一份源码下两次 careful 运行必须零差异**。`config.source.digest` 不算易变：源码变了就应该看得见——所以做零差异对比时，两次运行之间不要改仓库。

`--repeat N` 跑 N 次同一场景同一策略，然后对每个**数值**指标给出均值、最小、最大（写进上一层的 `summary.md` 与 `metrics.json`）。

`policySelfCheck(careful, naive, scenario.selfCheck)` 是 harness 自己的检查：naive 必须在这些指标上确实更差，否则 `run all` 以退出码 1 结束，`tests/acceptance-harness.test.ts` 也会失败。

| 指标 | 期望 |
| --- | --- |
| `guardrails.defined` | naive 更低 |
| `guardrails.violationsCaught` | naive 更低（默认只有当 careful > 0，即场景真的产生了违反时才检查；写进场景 `selfCheck` 就一定检查） |
| `staleMemory.followed` | naive 更高 |
| `reviewsCitingCapturedEvidence` | naive 更低 |
| `repeatedFailures.groups` | naive 更高 |
| `usagegap.discovered` | naive 更低（只在 careful 真的产生了 `usagegap` 块时比较） |
| `usagegap.findingsWithEvidence` | naive 更低（同上） |
| `usagegap.attribution.correct` | naive 更低（同上） |
| `usagegap.improvements.observed` | naive 更低（同上） |
| `usagegap.misFix.count` | naive 更高（同上） |

任一侧是 `unknown` 就算这一条不通过：自检不接受"没法比较"。场景可以用 `selfCheck` 要求某几条必须被比较——`namecheck` 与 `relaydesk` 按计划要求 `guardrails.violationsCaught`、`staleMemory.followed` 与 `repeatedFailures.groups` 三项都比出差别，于是这三条既不会被跳过，也不会因为场景后来不再产生违反而悄悄消失。

## 对真实数据目录算指标

```bash
npm run acceptance -- metrics ~/Library/Application\ Support/Morrow --out artifacts/weekly.json
```

`metrics` 接受任意运行目录或任意 Morrow 数据目录。它把 `workspace.sqlite`（以及存在的 `-wal`/`-shm`）复制到临时目录再以只读方式打开，**从不写源目录**，也不做迁移。数据目录没有标签，所以 `staleMemory`、`misattribution`、`repeatedFailures`、`releases.receiverPosts` 会是 `unknown`，其余从 SQLite 算出的指标照常给出。这是 Phase 3 每周复盘要在真实 daemon 目录上跑的命令。

## fixture 结果能证明什么，不能证明什么

**fixture 结果验证框架机制，不验证模型自主性。** 通过意味着：调度、预算、观察窗口、事前预期的机械核对、独立复核门禁、人工上线确认、重启后的记录一致性这些机制按约定工作，而且同样的输入能重复得到同样的结果。

它不能说明模型会不会自己选对问题、会不会发现真实的体验缺陷，也不能说明任何业务收益。策略是写死的状态机，反馈样本是场景给的，接收端是本机的。`usagegap` 的探索指标也一样：`careful` 的 5/5 发现率与 0 误修率证明的是"这些判断能被记录下来并算出来"，不是"模型会这样判断"。要衡量模型自主性，得用 **live 模式**接真实的 Codex App 任务跑同一套场景和指标（见上面的 live 小节）。live 的结果也有它自己的边界：它是隔离环境下的模型验证，不是真实业务效果，一次运行只是一次抽样，两次 live 运行之间不存在"零差异"这回事。

指标同样不说明模型自主性。`naive` 在约定指标上劣于 `careful`，证明的是**指标能看出协议被用错**，不是任何一种策略像模型。

## 加一个场景

在 `scenarios/` 下新建 `<id>.ts`，`export default defineScenario({...})`，`id` 只用小写字母、数字和连字符，跟文件名一致；种子项目放 `scenarios/projects/<id>/`，补丁放 `scenarios/patches/<id>/<n>/`。`npm run acceptance -- list` 会自动发现它。

新场景要能同时被两种策略跑完，并让自检成立：至少预置一条 `stale: true` 的 learning（`staleMemory` 的分子），并且让某个窗口真的突破护栏（`guardrails.violationsCaught` 的分子）。`smoke` 为此在第二个窗口把 `errors` 提到 3 并标注 `truth: 'environment'`，又在采样和复盘之间加了一次 `advance`，好让"从违反出现到复盘反应"是一段真实时长；两处改动都没有放宽任何 invariant，careful 依旧全绿。

几个会让新场景当场卡住的坑：

- **预置的 learning 必须是 `apply` 允许的状态**（`active` / `supported` / `inconclusive`）。`naive` 会把 `context` 里的旧记录一并 `apply`，而工作接口拒绝直接沿用 `refuted` / `stopped` / 失效的记录——那样 `naive` 一条选择都留不下，`guardrails.defined` 与 `staleMemory.followed` 全变成 0，自检跟着失败。要表达"这条经验其实站不住"，就写在它的 `conclusion` 里（careful 读全文后标 `avoid`），不要写进 `status`。
- **`status: 'supported'` 或 `'refuted'` 的 learning 需要证据引用**，而预置阶段还没有任何证据，所以预置只能用不需要证据的状态。
- **每个场景的 `budget.turns` 就是时间线里 `turn` 的条数**，`budget.reviews` 要算上两道门禁（事项复核 + 发布级复核）和每一次结论为 `improved` 的复盘各占一次。
- **人工确认（`approve`）会给还没复盘的选择发一条复查信号**，下一轮就会去复盘。想让第一个窗口有样本可比，`set`/`advance`/`poll` 要排在 `approve` 之前（`namecheck`、`relaydesk`）；想重建"本地已验证、业务效果未知"的 `inconclusive`，就故意不给样本（`fieldnote`）。
- **`unknown` 的发布要过 60 秒才会被 `tick()` 核对**，所以 `mode: 'disconnect'` 之后要 `advance` 到超过这个间隔，下一次 `turn` 才会把回执核对回来（`parcelnotes`）。
- **探索型场景多两轮**：第一轮只建观测，第二轮才读样本记发现，所以第一份样本要有一个 `poll` 步骤排在它们中间；`budget.turns` 要把这两轮算进去。`explore` 要求 `project.serve` 存在，且每条 `planted` 都带 `kind` 与 `feature`——`defineScenario` 会当场拒绝漏掉的那条。
