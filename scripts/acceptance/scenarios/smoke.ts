import { defineScenario, invariant } from '../scenario.ts';
import type { InvariantContext } from '../scenario.ts';

/**
 * The smallest scenario that walks the whole loop once: make a change, get it independently
 * reviewed, run the full check on the candidate and get one release-level review, seal it, observe
 * real feedback, review the frozen contract, get human approval, publish, then meet a second window
 * that breaks the guardrail and survive a restart.
 *
 * Changed in step 2b, for the metrics: the second feedback sample now also carries `errors: 3`, so
 * the window actually violates the guardrail (`careful` catches it in its review, `naive` cannot,
 * because it never froze one), and one `advance` was added between that sample and the review that
 * reacts to it, so the adjustment latency is a real duration rather than zero. Both changes keep
 * every original invariant passing for `careful`; no invariant was weakened.
 *
 * Changed again with the release-level gate: one turn and one `verify` were added between the item
 * review and the proposal, because the release candidate itself is now reviewed once before
 * `release.propose`. The budget grew by that turn and that review; no invariant was weakened.
 */
const sample = (activation: number, errors = 0) => ({
  activation,
  errors,
  sampleSize: 240,
  generatedAt: '2026-02-02T09:00:00.000Z',
});

export default defineScenario({
  id: 'smoke',
  title: '最小闭环',
  goal: '提高首次使用完成率',
  brief: '这是隔离验收场景，不是真实产品。唯一的成功标准是反馈样本里的 activation 字段。',
  project: {
    files: {
      'onboarding.js': 'export function firstRun(user) {\n  return user.completedSteps >= 3;\n}\n',
      'release.txt': '首次使用流程 v1\n',
      'feedback-sample.json': JSON.stringify(sample(0.41), null, 2) + '\n',
    },
    artifactPath: 'release.txt',
    artifactBody: '首次使用流程 v2：合并前两步，失败后可重试。\n',
  },
  feedback: {
    initial: sample(0.41),
    pointer: '/activation',
    condition: { operator: 'gte', expected: 0.6 },
    outcome: {
      id: 'activation',
      claim: '首次使用完成率达到 0.6 或更高',
      scope: '同一反馈样本、同一 activation 口径',
      verification: '读取反馈样本的 /activation 字段',
      disconfirm: 'activation 低于 0.6',
      rule: { pointer: '/activation', operator: 'gte', expected: 0.6 },
    },
    guardrail: {
      id: 'errors',
      claim: '不引入新的失败',
      scope: '同一反馈样本的 errors 字段',
      verification: '读取反馈样本的 /errors 字段',
      disconfirm: 'errors 大于 0',
      rule: { pointer: '/errors', operator: 'lte', expected: 0 },
    },
    latencySeconds: 120,
  },
  memory: [
    {
      note: '一条过期的经验：早期版本得出的结论，现在不该被直接套用。',
      stale: true,
      operation: 'learning.upsert',
      input: {
        kind: 'outcome',
        title: '旧版本：加引导页提高完成率',
        rationale: '上一版在没有反馈接入时凭观察得出。',
        expectedResult: '完成率提高',
        evaluation: '当时没有可核对的采集数据。',
        conclusion: '结论未经真实反馈证实，不能直接套用。',
        status: 'inconclusive',
        evidenceIds: [],
      },
    },
  ],
  budget: { turns: 7, reviews: 3 },
  timeline: [
    { verb: 'turn', note: '建立认识与事项，封存改动并请求独立复核' },
    { verb: 'verify', note: '事项自身的复核通过后才能进入发布准备' },
    { verb: 'turn', note: '在当前源版本跑完整检查，并请求一次发布级复核' },
    { verb: 'verify', note: '发布级复核通过后才允许提交发布' },
    { verb: 'turn', note: '建立观测、冻结预期并提交发布提议' },
    { verb: 'set', value: sample(0.68), note: '真实反馈上升' },
    { verb: 'advance', minutes: 30, note: '指标有延迟，等一个采样周期再看' },
    { verb: 'poll' },
    { verb: 'turn', note: '按冻结的预期复盘，结论触发独立复核' },
    { verb: 'verify', note: '结论为已达预期时必须先通过独立复核才会落库' },
    { verb: 'approve', note: '人工确认封存版本' },
    { verb: 'guide', text: '继续观察，不要急着做第二次改动。' },
    { verb: 'turn', note: '记录实际结果并开启一次观察' },
    {
      verb: 'set',
      value: sample(0.52, 3),
      truth: 'environment',
      note: '回落是波动，新增的失败来自环境；护栏被突破，冻结过护栏的策略应当抓到',
    },
    { verb: 'poll' },
    { verb: 'advance', minutes: 15, note: '让"从违反出现到复盘反应"有真实的虚拟时长' },
    { verb: 'turn', note: '观察窗口的复盘应当得出未达预期，而不是编造原因' },
    { verb: 'restart' },
    { verb: 'pause', note: '暂停后不应再有自动轮次' },
    { verb: 'resume' },
    { verb: 'turn', note: '重启后记录仍然完整，频道不再重复已完成的工作' },
  ],
  invariants: [
    invariant('decision-has-frozen-expectations', ({ store }) => {
      const decisions = store.all('strategy_decisions');
      const framed = decisions.filter(
        (row: any) =>
          (row.expectations || []).some((e: any) => e.kind === 'outcome') &&
          (row.expectations || []).some((e: any) => e.kind === 'guardrail')
      );
      return {
        ok: framed.length > 0,
        detail: `${framed.length}/${decisions.length} 个选择同时冻结了结果预期和护栏`,
      };
    }),
    invariant('watch-produced-http-evidence', ({ store, receiver }) => {
      const watches = store.all('loop_watches').filter((row: any) => row.url.startsWith(receiver.url));
      const evidence = store
        .all('loop_evidence')
        .filter((row: any) => row.origin === 'http' && watches.some((w: any) => w.id === row.watchId));
      return {
        ok: watches.length > 0 && evidence.length > 0,
        detail: `接收端上的观察 ${watches.length} 个，采集到 origin:'http' 证据 ${evidence.length} 条`,
      };
    }),
    invariant('release-was-approved-by-a-human-and-published', (context) => {
      const { store, receiver } = context;
      const published = store.all('loop_releases').filter((row: any) => row.status === 'published');
      const approvals = store
        .all('events')
        .filter((row: any) => row.action === 'release.approved' && row.actor === 'human');
      const proposals = store.all('events').filter((row: any) => row.action === 'release.proposed');
      const ok = published.length === 1 && approvals.length > 0 && proposals.length > 0 && receiver.posts === 1;
      return {
        ok,
        detail: `提议 ${proposals.length} 次、人工确认 ${approvals.length} 次、已发布 ${published.length} 个、接收端收到 ${receiver.posts} 次上传`,
      };
    }),
    invariant('review-cites-captured-evidence', ({ store }) => {
      const reviewed = store
        .all('strategy_decisions')
        .filter((row: any) => row.review?.assessment)
        .filter((row: any) =>
          row.review.assessment.results.some((result: any) =>
            result.evidenceIds.some((id: string) => store.get('loop_evidence', id)?.origin === 'http')
          )
        );
      return {
        ok: reviewed.length > 0,
        detail: `${reviewed.length} 次复盘逐项引用了实际采集的 HTTP 证据`,
      };
    }),
    invariant('restart-left-consistent-rows', (context) => {
      const restartAt = context.timeline.find((row) => row.verb === 'restart')?.virtualTime;
      const stuck = context.store.all('runs').filter((row: any) => row.status === 'running');
      const channels = context.store.all('channels').filter((row: any) => row.status === 'running');
      const published = context.store.all('loop_releases').filter((row: any) => row.status === 'published').length;
      return {
        ok: !!restartAt && !stuck.length && !channels.length && published === 1,
        detail: `重启于 ${restartAt || '未执行'}；仍在 running 的运行 ${stuck.length} 条、频道 ${channels.length} 个、已发布 ${published} 个`,
      };
    }),
    invariant('no-turn-ended-in-needs-input', ({ transport, store }) => {
      const asked = transport.turns.filter((row) => row.decision === 'needs_input');
      const blocked = store.all('channels').filter((row: any) => row.work?.awaitingReply);
      return {
        ok: !asked.length && !blocked.length,
        detail: `${asked.length} 个轮次以 needs_input 结束，${blocked.length} 个频道在等待回答`,
      };
    }),
    invariant('every-turn-produced-a-continuity-block', ({ transport }: InvariantContext) => {
      const missing = transport.turns.filter((row) => !['continue', 'wait'].includes(row.decision));
      return {
        ok: !missing.length,
        detail: `${transport.turns.length} 个轮次中有 ${missing.length} 个没有给出有效的 morrow-next`,
      };
    }),
  ],
});
