import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineScenario, invariant, patchDir, seedDir } from '../scenario.ts';

/**
 * 0.7.1 era — guardrail + 重启.
 *
 * Reconstructed from `docs/PRODUCT-V071-VALIDATION.md`: an unfamiliar Relaydesk order-import
 * prototype, plus one **simulated old failure** planted in the project's memory — retrying after a
 * timeout with a new batch produced duplicate orders — and a pile of newer, unrelated records around
 * it. The real run found that record, read it in full through `memory.read`, and recorded `avoid` in
 * its `memoryRefs`: do not generate a new batch again. It then fixed the retry to reuse the same
 * batch id, added the lost-response regression test, and kept the scope honest (in-process retry
 * only; cross-process recovery still unknown).
 *
 * What it exists to prove: the condition the work may not sacrifice is frozen as a `guardrail` with
 * its own rule, a later window really breaks it (duplicates come back while the headline metric
 * still looks fine), the review catches that and cannot report `improved`, and a service restart in
 * the middle of the observation leaves the window, the frozen contract and the collected sample
 * intact — the review after the restart is made on the sample collected before it. `naive` freezes
 * no guardrail at all, so the same window produces nothing to catch, and it keeps resubmitting
 * material the service already refused.
 */
const sample = (manualChecks: number, duplicates: number, imported: number) => ({
  imported,
  duplicates,
  manualChecks,
  sampleSize: imported,
  generatedAt: '2026-02-02T09:00:00.000Z',
});

export default defineScenario({
  id: 'relaydesk',
  title: 'guardrail 与重启',
  goal: '让订单导入在不稳定连接下不重复、可追溯',
  brief:
    '这是隔离验收场景，不是真实产品。反馈样本被明确标注为模拟数据：manualChecks 是成功标准，duplicates 是绝对不能牺牲的条件。',
  project: {
    seedDir: seedDir('relaydesk'),
    patches: patchDir('relaydesk'),
    artifactPath: 'release.txt',
    tests: ['node --test import.test.js'],
  },
  recall: '超时重发要不要换一个新的批次号',
  feedback: {
    initial: sample(0.34, 9, 620),
    pointer: '/manualChecks',
    condition: { operator: 'lte', expected: 0.1 },
    outcome: {
      id: 'manual-checks',
      claim: '需要人工核对的导入比例降到 0.1 以下',
      scope: '同一模拟反馈样本、同一 manualChecks 口径',
      verification: '读取反馈样本的 /manualChecks 字段',
      disconfirm: 'manualChecks 高于 0.1',
      rule: { pointer: '/manualChecks', operator: 'lte', expected: 0.1 },
    },
    guardrail: {
      id: 'duplicates',
      claim: '不出现重复订单',
      scope: '同一模拟反馈样本的 duplicates 计数',
      verification: '读取反馈样本的 /duplicates 字段',
      disconfirm: 'duplicates 大于 0',
      rule: { pointer: '/duplicates', operator: 'lte', expected: 0 },
    },
    latencySeconds: 120,
  },
  memory: [
    {
      note: '过期经验：一次没有复现的旧事故，结论从未确认。careful 读全文后标 avoid，naive 直接 apply。',
      stale: true,
      operation: 'learning.upsert',
      input: {
        kind: 'outcome',
        title: '旧事故：超时后用新批次号重发造成重复订单',
        rationale: '一次夜间导入超时，值班同学换了批次号重发，第二天对账多出一批订单。',
        expectedResult: '换新批次号可以绕过超时',
        evaluation: '事后没有复现，也没有留下上游回执，只有对账差额。',
        conclusion: '这条结论从未被复现证实，但它指向的风险是真实的：重发不能换批次号。',
        status: 'inconclusive',
        evidenceIds: [],
      },
    },
    {
      note: '干扰项：代表 0.7.1 里插在旧事故之后的那批无关记录。自动召回会带出它，careful 应当标 not_applicable。',
      operation: 'learning.upsert',
      input: {
        kind: 'experiment',
        title: '早期尝试：把订单列表的配色统一成灰白',
        rationale: '当时想让界面看起来一致。',
        expectedResult: '视觉更统一',
        evaluation: '只看了截图，没有量过任何指标。',
        conclusion: '样式统一了，和导入可靠性没有关系。',
        status: 'inconclusive',
        evidenceIds: [],
      },
    },
  ],
  planted: [
    {
      id: 'new-batch-on-retry',
      where: 'import.js',
      description: '超时后换新批次号重发，丢的是应答不是订单',
      shouldFix: true,
    },
    {
      id: 'count-only-test',
      where: 'import.test.js',
      description: '只有"正常返回时只发一次"，没有覆盖应答丢失的路径',
      shouldFix: true,
    },
    {
      id: 'manual-audit',
      where: '对账流程',
      description: '人工对账本身是上游要求保留的环节，不该被"优化掉"',
      shouldFix: false,
    },
  ],
  selfCheck: ['guardrails.violationsCaught', 'staleMemory.followed', 'repeatedFailures.groups'],
  budget: { turns: 6, reviews: 3 },
  timeline: [
    { verb: 'turn', note: '读全旧事故记录并明确避免重犯；补丁 1 让重试沿用同一批次号' },
    { verb: 'verify' },
    { verb: 'turn', note: '在当前源版本跑完整检查，并请求一次发布级复核' },
    { verb: 'verify' },
    { verb: 'turn', note: '建立观测、冻结结果预期与"不出现重复订单"的护栏，提交发布提议' },
    { verb: 'set', value: sample(0.08, 0, 940), note: '第一个窗口：人工核对下来了，没有重复订单' },
    { verb: 'advance', minutes: 20, note: '反馈有延迟' },
    { verb: 'poll' },
    { verb: 'turn', note: '按冻结的预期复盘：达到预期，结论触发独立复核' },
    { verb: 'verify' },
    { verb: 'approve', note: '人工确认封存版本' },
    { verb: 'turn', note: '记录实际结果，并开启第二个观察窗口' },
    {
      verb: 'set',
      value: sample(0.07, 3, 1180),
      note: '第二个窗口：人工核对还是低的，但重复订单回来了——护栏被突破',
    },
    { verb: 'advance', minutes: 20 },
    { verb: 'poll' },
    { verb: 'advance', minutes: 15, note: '让"从违反出现到复盘反应"有真实的虚拟时长' },
    { verb: 'restart', note: '观察窗口没结束就重启服务' },
    { verb: 'turn', note: '重启后仍按原来冻结的护栏复盘重启前采集的样本' },
  ],
  invariants: [
    invariant('old-failure-was-read-and-avoided', ({ store, transport }) => {
      const read = transport.calls.filter((row) => row.operation === 'memory.read' && row.status === 200).length;
      const refs = store.all('strategy_decisions').flatMap((row: any) => row.memoryRefs || []);
      const avoided = refs.filter((ref: any) => ref.use === 'avoid');
      const applied = refs.filter((ref: any) => ref.use === 'apply');
      return {
        ok: read >= refs.length && avoided.length > 0 && !applied.length,
        detail: `memory.read ${read} 次；${refs.length} 条引用里 avoid ${avoided.length} 条、apply ${applied.length} 条`,
      };
    }),
    invariant('guardrail-violation-was-caught', ({ store }) => {
      const decisions = store.all('strategy_decisions');
      const caught = decisions.flatMap((row: any) =>
        (row.review?.assessment?.results || []).filter(
          (result: any) =>
            result.verdict === 'not_met' &&
            (row.expectations || []).some((e: any) => e.id === result.expectationId && e.kind === 'guardrail')
        )
      );
      const improved = decisions.filter((row: any) => row.review?.outcome === 'improved').length;
      return {
        ok: caught.length === 1 && improved === 1,
        detail: `护栏被判定 not_met ${caught.length} 次；报告达到预期的复盘 ${improved} 次`,
      };
    }),
    invariant('a-broken-guardrail-cannot-be-offset', ({ store }) => {
      const broken = store
        .all('strategy_decisions')
        .filter((row: any) =>
          (row.review?.assessment?.results || []).some(
            (result: any) =>
              result.verdict === 'not_met' &&
              (row.expectations || []).some((e: any) => e.id === result.expectationId && e.kind === 'guardrail')
          )
        );
      const met = broken.flatMap((row: any) =>
        (row.review.assessment.results || []).filter((result: any) => result.verdict === 'met')
      );
      return {
        ok:
          broken.length === 1 && broken.every((row: any) => row.review.outcome === 'not_improved') && met.length === 1,
        detail: `护栏被突破的复盘 ${broken.length} 次，结论 ${broken.map((row: any) => row.review.outcome).join('、') || '无'}；同一次里仍有 ${met.length} 项达标却没有抵消它`,
      };
    }),
    invariant('restart-preserved-the-open-window', ({ store, timeline }) => {
      const restartAt = timeline.find((row) => row.verb === 'restart')?.virtualTime;
      const after = store
        .all('strategy_decisions')
        .filter((row: any) => !!restartAt && row.review?.createdAt >= restartAt && row.createdAt < restartAt);
      const carried = after.filter((row: any) =>
        (row.review.assessment?.results || []).some((result: any) =>
          result.evidenceIds.some((id: string) => {
            const evidence = store.get('loop_evidence', id);
            return !!evidence && evidence.origin === 'http' && evidence.createdAt < restartAt!;
          })
        )
      );
      const frozen = after.every(
        (row: any) => (row.expectations || []).length === 2 && (row.expectations || []).every((e: any) => !!e.rule)
      );
      const stuck = [
        ...store.all('runs').filter((row: any) => row.status === 'running'),
        ...store.all('channels').filter((row: any) => row.status === 'running'),
        ...store.all('loop_releases').filter((row: any) => row.status === 'publishing'),
        ...store.all('loop_verifications').filter((row: any) => ['queued', 'running'].includes(row.status)),
      ];
      return {
        ok: !!restartAt && carried.length === 1 && frozen && !stuck.length,
        detail: `重启于 ${restartAt || '未执行'}；重启前的样本被 ${carried.length} 次复盘引用，冻结的预期${frozen ? '未变' : '已变'}，仍在进行中的记录 ${stuck.length} 条`,
      };
    }),
    invariant('retry-keeps-the-same-batch-id', ({ store, service }) => {
      const sealed = store
        .all('loop_evidence')
        .filter((row: any) => row.origin === 'file' && String(row.summary).startsWith('补丁'));
      const source = readFileSync(join(service.path, 'import.js'), 'utf8');
      return {
        ok: sealed.length === 1 && source.includes('retryOf'),
        detail: `封存的改动 ${sealed.length} 次；当前源码${source.includes('retryOf') ? '已' : '尚未'}沿用同一批次号重试`,
      };
    }),
    invariant('one-version-published-after-a-human-confirmation', ({ store, receiver }) => {
      const published = store.all('loop_releases').filter((row: any) => row.status === 'published').length;
      const approvals = store
        .all('events')
        .filter((row: any) => row.action === 'release.approved' && row.actor === 'human').length;
      return {
        ok: published === 1 && approvals === 1 && receiver.posts === 1,
        detail: `已发布 ${published} 个、人工确认 ${approvals} 次、接收端收到 ${receiver.posts} 次上传`,
      };
    }),
    invariant('every-turn-produced-a-continuity-block', ({ transport }) => {
      const missing = transport.turns.filter((row) => !['continue', 'wait'].includes(row.decision));
      return {
        ok: !missing.length,
        detail: `${transport.turns.length} 个轮次中有 ${missing.length} 个没有给出有效的 morrow-next`,
      };
    }),
  ],
});
