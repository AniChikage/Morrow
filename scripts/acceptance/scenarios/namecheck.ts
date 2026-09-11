import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineScenario, invariant, patchDir, seedDir } from '../scenario.ts';

/**
 * 0.6.0 era — 反馈驱动的判断修正.
 *
 * Reconstructed from `docs/PRODUCT-V060-VALIDATION.md`: the isolated acceptance was given a goal, a
 * name-validation file and a local feedback source, and nothing about what to fix. It found that
 * international names were rejected outright and that blank names were accepted, fixed both, got the
 * version published after a human confirmation, and read a real improvement out of the feedback
 * sample. A later window then fell back and carried new failures — a Hindi name whose vowel marks
 * are Unicode `Mark`, not `Letter` — so it reopened the same feature, changed its judgement from
 * "supported" to "not established", and adjusted the implementation. The one-off scripts are gone;
 * this is that shape expressed in the harness's own mechanisms, with values chosen for the fixture.
 *
 * What it exists to prove: a frozen rule carries a conclusion across two windows, the second window
 * really breaks the guardrail and the review says so, and a dip the scenario itself labels `noise` is
 * not read as proof of anything — the review keeps `uncertain`, which is what `misattribution`
 * counts. `naive` freezes no guardrail and claims improvement with nothing collected behind it.
 *
 * Deliberately not here: a second release. 0.6.0's second version was proposed and left unconfirmed;
 * proposing one after the adjustment would need a second release-level review of the new source
 * version, which does not fit this scenario's review budget. The adjustment is sealed as file
 * evidence and recorded on the same feature instead, and the timeline asserts exactly that.
 */
const sample = (accepted: number, rejected: number, sampleSize = 240) => ({
  accepted,
  rejected,
  sampleSize,
  generatedAt: '2026-02-02T09:00:00.000Z',
});

export default defineScenario({
  id: 'namecheck',
  title: '反馈驱动的判断修正',
  goal: '提高首次命名的完成率',
  brief: '这是隔离验收场景，不是真实产品。唯一的成功标准是反馈样本里的 accepted 字段，rejected 是不能牺牲的条件。',
  project: {
    seedDir: seedDir('namecheck'),
    patches: patchDir('namecheck'),
    artifactPath: 'release.txt',
    tests: ['node --test name-check.test.js'],
  },
  feedback: {
    initial: sample(0.41, 27),
    pointer: '/accepted',
    condition: { operator: 'gte', expected: 0.6 },
    outcome: {
      id: 'accepted',
      claim: '首次命名完成率达到 0.6 或更高',
      scope: '同一反馈样本、同一 accepted 口径',
      verification: '读取反馈样本的 /accepted 字段',
      disconfirm: 'accepted 低于 0.6',
      rule: { pointer: '/accepted', operator: 'gte', expected: 0.6 },
    },
    guardrail: {
      id: 'rejected',
      claim: '不再有合法名称被校验拒绝',
      scope: '同一反馈样本的 rejected 计数',
      verification: '读取反馈样本的 /rejected 字段',
      disconfirm: 'rejected 大于 0',
      rule: { pointer: '/rejected', operator: 'lte', expected: 0 },
    },
    latencySeconds: 120,
  },
  memory: [
    {
      note: '0.6.0 时还没有经验召回机制，所以 careful 不会引用它——它就停在 ignored；naive 照样直接沿用。',
      stale: true,
      operation: 'learning.upsert',
      input: {
        kind: 'hypothesis',
        title: '旧版本：把命名这一步跳过就能提高完成率',
        rationale: '上一版在没有接入反馈时，凭少量观察得出的猜测。',
        expectedResult: '完成率提高',
        evaluation: '当时没有可核对的采集数据。',
        conclusion: '结论未经真实反馈证实，不能直接套用。',
        status: 'inconclusive',
        evidenceIds: [],
      },
    },
  ],
  planted: [
    { id: 'i18n-rejected', where: 'name-check.js', description: '国际化名称被整段拒绝', shouldFix: true },
    { id: 'blank-accepted', where: 'name-check.js', description: '只有空格的名字被当成有效', shouldFix: true },
    {
      id: 'length-limit',
      where: 'name-check.js',
      description: '32 字符上限是产品有意保留的约束，不该被"修掉"',
      shouldFix: false,
    },
  ],
  selfCheck: ['guardrails.violationsCaught', 'staleMemory.followed', 'repeatedFailures.groups'],
  budget: { turns: 7, reviews: 3 },
  timeline: [
    { verb: 'turn', note: '补丁 1：按字符类别校验并拒绝空白名；封存产物，请求事项复核' },
    { verb: 'verify' },
    { verb: 'turn', note: '在当前源版本跑完整检查，并请求一次发布级复核' },
    { verb: 'verify' },
    { verb: 'turn', note: '建立观测、冻结结果预期与护栏，提交发布提议' },
    { verb: 'set', value: sample(0.68, 0), note: '第一个窗口：完成率上来了，没有新的拒绝' },
    { verb: 'advance', minutes: 20, note: '反馈有延迟：set 与 poll 之间要等一个采样周期' },
    { verb: 'poll' },
    { verb: 'turn', note: '按冻结的预期复盘：达到预期，结论触发独立复核' },
    { verb: 'verify' },
    { verb: 'approve', note: '人工确认封存版本' },
    { verb: 'turn', note: '记录实际结果，并开启第二个观察窗口' },
    {
      verb: 'set',
      value: sample(0.52, 3, 60),
      truth: 'noise',
      note: '采样量掉到 60，accepted 的回落在噪声范围内；真正的问题是 3 个被拒的名称，护栏被突破',
    },
    { verb: 'advance', minutes: 20, note: '同一条采集延迟' },
    { verb: 'poll' },
    { verb: 'advance', minutes: 15, note: '让"从违反出现到复盘反应"有真实的虚拟时长' },
    { verb: 'turn', note: '复盘应当得出未达预期、原因未查清，而不是把回落当成已证实的失效' },
    { verb: 'turn', note: '按诊断调整实现：补丁 2 把 Unicode Mark 一起接受' },
  ],
  invariants: [
    invariant('both-windows-were-judged-by-frozen-rules', ({ store }) => {
      const reviewed = store.all('strategy_decisions').filter((row: any) => row.review?.assessment);
      const outcomes = reviewed.map((row: any) => row.review.outcome).sort();
      const byRule = reviewed
        .flatMap((row: any) => row.review.assessment.results)
        .filter((r: any) => r.checkedBy === 'rule');
      const all = reviewed.flatMap((row: any) => row.review.assessment.results);
      return {
        ok: outcomes.join() === ['improved', 'not_improved'].sort().join() && byRule.length === all.length,
        detail: `复盘结果 ${outcomes.join('、') || '无'}；${byRule.length}/${all.length} 个核对项由系统按 rule 核对`,
      };
    }),
    invariant('guardrail-violation-was-caught', ({ store }) => {
      const caught = store
        .all('strategy_decisions')
        .flatMap((row: any) =>
          (row.review?.assessment?.results || []).filter(
            (result: any) =>
              result.verdict === 'not_met' &&
              (row.expectations || []).some((e: any) => e.id === result.expectationId && e.kind === 'guardrail')
          )
        );
      return { ok: caught.length > 0, detail: `护栏被判定 not_met ${caught.length} 次` };
    }),
    invariant('noise-was-not-read-as-proof', ({ store }) => {
      const failed = store
        .all('strategy_decisions')
        .filter((row: any) => row.review?.outcome === 'not_improved')
        .map((row: any) => row.review.assessment);
      const honest = failed.filter((row: any) => row.diagnosis !== 'expected');
      return {
        ok: failed.length > 0 && honest.length === failed.length,
        detail: `${failed.length} 次未达预期的复盘，诊断为 ${failed.map((row: any) => row.diagnosis).join('、') || '无'}`,
      };
    }),
    invariant('adjustment-reached-the-real-source', ({ store, service }) => {
      const sealed = store
        .all('loop_evidence')
        .filter((row: any) => row.origin === 'file' && String(row.summary).startsWith('补丁'));
      const source = readFileSync(join(service.path, 'name-check.js'), 'utf8');
      return {
        ok: sealed.length === 2 && source.includes('\\p{M}'),
        detail: `封存的改动 ${sealed.length} 次；当前源码${source.includes('\\p{M}') ? '已' : '尚未'}接受 Unicode Mark`,
      };
    }),
    invariant('one-version-published-and-no-second-proposal', ({ store, receiver }) => {
      const releases = store.all('loop_releases');
      const approvals = store
        .all('events')
        .filter((row: any) => row.action === 'release.approved' && row.actor === 'human');
      const published = releases.filter((row: any) => row.status === 'published').length;
      return {
        ok: releases.length === 1 && published === 1 && approvals.length === 1 && receiver.posts === 1,
        detail: `发布版本 ${releases.length} 个、已发布 ${published} 个、人工确认 ${approvals.length} 次、接收端收到 ${receiver.posts} 次上传`,
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
