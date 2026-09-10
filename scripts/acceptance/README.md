# 可重复验收 harness

一条命令把一个验收场景跑完：真实的执行服务、真实的调度器、真实的项目工作接口，唯一被替换的是原生后台和外部世界。fixture 模式不调用任何模型，也不离开 loopback。

```bash
npm run acceptance -- list                  # 列出场景
npm run acceptance -- run smoke             # 跑一个场景
npm run acceptance -- run smoke --keep      # 保留隔离的数据目录和项目目录
npm run acceptance -- run smoke --out artifacts/acceptance/my-run
```

参数：`--mode fixture`（默认，目前只有这一种）、`--policy careful`（默认）、`--out <目录>`、`--keep`、`--seed <n>`。
`compare` 和 `metrics` 子命令属于下一步，现在会打印 `not implemented in this step` 并以退出码 2 结束。
退出码：0 通过，1 场景未通过，2 用法错误或未实现。

## 组成

| 文件 | 作用 |
| --- | --- |
| `tests/harness/scripted-native.ts` | `ScriptedNativeTransport`：一个 `NativeTransport` 替身，同时扮演调度轮次的后台和独立复核后台。 |
| `scenario.ts` | 场景 DSL：`defineScenario`、timeline 动词、invariant 类型。 |
| `scenarios/<id>.ts` | 具体场景，`export default defineScenario({...})`。 |
| `fake-agent.ts` | 确定性策略。目前只有 `careful`；`naive` 是下一步的扩展点。 |
| `timeline.ts` | 执行单个 timeline 步骤。 |
| `fixture.ts` | 进程内 runner：虚拟时钟、接收端、隔离服务、产物与 invariant 评估。 |
| `run.ts` | 命令行入口。 |

## 场景 DSL

```ts
export default defineScenario({
  id, title, goal, brief?,
  project: { files | seedDir, artifactPath, artifactBody?, tests?, serve? },
  memory?: [{ operation: 'understanding.upsert' | 'learning.upsert', input, note? }],
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
- `calls.jsonl`：策略发起的每一次 `/api/agent` 调用，含操作名、输入摘要、状态码和 requestId。
- `cleanup.json`：暂停的频道数、服务是否关闭、临时目录是否删除。
- `summary.md`：固定标注、预算使用、invariant 结果。

`--keep` 会把 `home/` 和 `project/` 一起复制到产物目录，并保留临时目录。

## fixture 结果能证明什么，不能证明什么

**fixture 结果验证框架机制，不验证模型自主性。** 通过意味着：调度、预算、观察窗口、事前预期的机械核对、独立复核门禁、人工上线确认、重启后的记录一致性这些机制按约定工作，而且同样的输入能重复得到同样的结果。

它不能说明模型会不会自己选对问题、会不会发现真实的体验缺陷，也不能说明任何业务收益。策略是写死的状态机，反馈样本是场景给的，接收端是本机的。要衡量模型自主性，得用 live 模式接真实的 Codex 后台跑同一套场景和指标——那是后续步骤。

## 加一个场景

在 `scenarios/` 下新建 `<id>.ts`，`export default defineScenario({...})`，`id` 只用小写字母、数字和连字符，跟文件名一致。`npm run acceptance -- list` 会自动发现它。
