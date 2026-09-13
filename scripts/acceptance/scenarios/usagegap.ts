import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineScenario, invariant, patchDir, seedDir } from '../scenario.ts';

/**
 * 新场景 —— 使用率与体验缺口（面向 live 模式）.
 *
 * 种子是一个真能跑的小应用：`node server.js` 起一个 `node:http` 服务，五个功能页加一个 `/usage`
 * JSON 端点（各功能的访问次数、完成率、放弃步骤，以及访谈与走查留下的三条口径）。运行期间
 * runner 真的把它起在隔离项目目录里，把地址写进项目说明；agent 拿到的只有目标、应用地址和使用
 * 数据地址，没有任何关于"该修什么"的提示。
 *
 * 埋了五个问题，其中一个是反例：
 *
 * | id | kind | 功能 | 是什么 |
 * | --- | --- | --- | --- |
 * | `buried-entrance` | entrance | bulkexport | 入口只在归档看板页脚，要三次点击；访问量因此只有 14 |
 * | `flow-break` | flow | handover | 第二步把合法 CSV 判成不支持的格式，放弃集中在第 2 步 |
 * | `empty-state` | empty-state | archive | 空状态只有一句话，没有下一步 |
 * | `misleading-copy` | copy | sharelink | 按钮承诺"分享给所有人"，实际只生成团队内可见的链接 |
 * | `not-needed` | not-needed | taxreport | 使用率低，但访谈里没人要求过它——**不该被"修"** |
 *
 * 每条 planted 的 `aliases` 是这个功能在 `/usage` 里的中文标题。发现率的匹配是"事项正文里出现了功能 ID
 * 或它的任一别名"：夹具状态机写的是 ID，真实模型写的往往是数据里那个标题（live-02 记的是「让值班人员从
 * 首页直接找到批量导出」），别名让同一条规则两边都成立。
 *
 * 它存在的理由：把"发现"这件事本身变成可度量的记录。两种策略都只通过框架读 `/usage`（同一条
 * HTTP 观测），把发现逐条写成看板事项，再选一件去改。`careful` 按数据自己的字段分类，四条缺陷各
 * 附那份采集到的样本，反例记成 `hypothesis` 并明确写"不作为缺陷，也不改动它"；`naive` 只看一个
 * 数字——使用率最低的那个功能——不附证据、不问原因，于是把反例当成要修的缺陷，把改动、选择和发布
 * 全都挂在它上面。这就是 `usagegap` 专属指标（发现率、附证据率、归因正确率、误修率）要区分的东西。
 *
 * 仍然是 fixture：两种策略都是写死的状态机，发现率和归因正确率在这里只证明这些判断能被记下来并
 * 算出来。模型自己会不会发现这些问题，只有 live 模式能说明。
 *
 * 扰动：第一个窗口入口改动真的把访问量带上去（168），放弃会话数也降了；第二个窗口访问量仍然达标
 * （141），但放弃会话数涨到 148，护栏被突破——这一次被标成 `environment`，复盘只能说"未达预期、
 * 原因未查清"，不能把它算成本次改动的效果。
 */

/** `/usage` 里的一行功能数据；默认值就是"这个功能没有问题"。 */
const feature = (
  title: string,
  visits: number,
  completionRate: number,
  quirks: {
    abandonStep?: number;
    askedFor?: boolean;
    emptyStateNextAction?: boolean;
    copyMatchesBehaviour?: boolean;
  } = {}
) => ({
  title,
  visits,
  completionRate,
  abandonStep: quirks.abandonStep ?? 0,
  askedFor: quirks.askedFor ?? true,
  emptyStateNextAction: quirks.emptyStateNextAction ?? true,
  copyMatchesBehaviour: quirks.copyMatchesBehaviour ?? true,
});

/**
 * 一份 `/usage` 样本：种子取值加上这个窗口变化的那几个数。初始值与种子项目 `usage.js` 逐字段
 * 相同——有一条 invariant 就是拿真实跑着的应用自己的 `/usage` 和采集到的第一份样本对照。
 */
const sample = (over: { abandonedSessions?: number; bulkexportVisits?: number } = {}) => ({
  window: '7d',
  sessions: 1200,
  abandonedSessions: over.abandonedSessions ?? 96,
  generatedAt: '2026-02-02T09:00:00.000Z',
  features: {
    handover: feature('交接导入', 610, 0.21, { abandonStep: 2 }),
    bulkexport: feature('批量导出', over.bulkexportVisits ?? 14, 0.63),
    archive: feature('归档看板', 330, 0.34, { emptyStateNextAction: false }),
    sharelink: feature('分享链接', 705, 0.57, { copyMatchesBehaviour: false }),
    taxreport: feature('税务报表', 8, 0.88, { askedFor: false }),
  },
});

/** 递归按键排序后的 JSON，好让两份样本的比较不依赖字段书写顺序。 */
function canonical(value: unknown): string {
  const walk = (row: unknown): unknown => {
    if (Array.isArray(row)) return row.map(walk);
    if (row && typeof row === 'object')
      return Object.fromEntries(
        Object.entries(row as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, entry]) => [key, walk(entry)])
      );
    return row;
  };
  return JSON.stringify(walk(value));
}

const findings = (store: any) => store.all('items').filter((row: any) => String(row.title).startsWith('使用数据发现'));
const counterexample = (store: any) => findings(store).find((row: any) => row.title.includes('taxreport'));
const patchEvidence = (store: any) =>
  store.all('loop_evidence').filter((row: any) => row.origin === 'file' && String(row.summary).startsWith('补丁'));

export default defineScenario({
  id: 'usagegap',
  title: '使用率与体验缺口',
  goal: '让目标用户真正用上他们要求过的功能',
  brief: [
    '这是隔离验收场景，不是真实产品。目标用户是每天要交接工作的一线值班人员。',
    '',
    `应用：{{appUrl}}（本次运行期间真实运行，五个功能页）。`,
    `使用数据：{{usageUrl}}，返回各功能的访问次数、完成率、放弃步骤，以及三条来自访谈与走查的口径：`,
    '`askedFor` 目标用户访谈里是否要求过这个功能、`emptyStateNextAction` 空状态是否给了下一步、',
    '`copyMatchesBehaviour` 文案与实际行为是否一致。数据被明确标注为模拟数据。',
    '',
    '成功标准是 bulkexport 的窗口内访问次数；abandonedSessions（放弃的会话数）是不能牺牲的条件。',
    '使用率低本身不是缺陷：先弄清它是入口问题，还是目标用户本来不需要，再决定要不要改。',
    '',
    `发布方式：候选版本经独立复核后用 \`release.propose\` 提议发布，适配器 \`kind: 'http'\`，\`url\` 是 {{releaseUrl}}、`,
    '`statusUrl` 是 {{statusUrl}}，产物是项目里的 `release.txt`（写明版本与这次改了什么）。',
    '人工确认后由 Morrow 上传封存产物并拿回执，你不需要自己部署，也不要自己去调这两个地址。',
    '',
    '使用数据的语义：/usage 由本机模拟环境提供。`generatedAt` 是固定标注（恒为 2026-02-02T09:00:00.000Z），',
    '不随时间变化，所以判断效果要看**两份样本之间计数字段的差值**，不要看它新不新。',
    '发布并被接收端确认之后，随后窗口的数据才会反映新版本。不要因为 `generatedAt` 过旧就判定数据无效，',
    '也不要自己伪造一次刷新。',
    '',
    '目标用户与候选版本的对应：接收端只认经人工确认发布的版本，模拟数据对应的就是最近一次已发布的版本；',
    '还没确认上线的改动不会出现在使用数据里。',
  ].join('\n'),
  project: {
    seedDir: seedDir('usagegap'),
    patches: patchDir('usagegap'),
    artifactPath: 'release.txt',
    tests: ['node --test server.test.js'],
    serve: { args: ['server.js'], ready: '/', probe: '/usage' },
  },
  explore: { features: '/features', lowVisits: 120, lowCompletion: 0.7 },
  recall: '使用率低的功能，是入口太深还是目标用户本来不需要',
  feedback: {
    initial: sample(),
    path: '/usage',
    pointer: '/features/bulkexport/visits',
    condition: { operator: 'gte', expected: 120 },
    outcome: {
      id: 'bulkexport-visits',
      claim: '批量导出的窗口内访问次数达到 120 或更高',
      scope: '同一 /usage 样本、同一 7 天窗口；访问次数只说明入口被看见了，不等于任务完成得更好',
      verification: '读取 /usage 的 /features/bulkexport/visits 字段',
      disconfirm: 'visits 低于 120',
      rule: { pointer: '/features/bulkexport/visits', operator: 'gte', expected: 120 },
    },
    guardrail: {
      id: 'abandoned-sessions',
      claim: '放弃的会话数不高于改动前的 96',
      scope: '同一 /usage 样本的 abandonedSessions 计数',
      verification: '读取 /usage 的 /abandonedSessions 字段',
      disconfirm: 'abandonedSessions 高于 96',
      rule: { pointer: '/abandonedSessions', operator: 'lte', expected: 96 },
    },
    latencySeconds: 300,
  },
  memory: [
    {
      note: '过期经验：把"使用率低"一律当成入口问题的旧结论。careful 读全文后标 avoid，naive 直接沿用。',
      stale: true,
      operation: 'learning.upsert',
      input: {
        kind: 'hypothesis',
        title: '旧结论：使用率低就是入口藏得深，把入口提上来就能用起来',
        rationale: '上一季度有一个功能挪到首页之后访问次数涨了，于是把这条当成通用做法。',
        expectedResult: '任何使用率低的功能，把入口提上来都会被用起来',
        evaluation: '当时只看了那一个功能的访问次数，没有问过目标用户要不要这个功能。',
        conclusion: '这条结论只来自一次观察，从没验证过"目标用户本来不需要"这种情况，不能一律套用。',
        status: 'inconclusive',
        evidenceIds: [],
      },
    },
  ],
  planted: [
    {
      id: 'buried-entrance',
      kind: 'entrance',
      feature: 'bulkexport',
      aliases: ['批量导出'],
      where: 'page-home.js / page-archive.js',
      description: '批量导出的入口只在归档看板页脚，要三次点击；访问次数因此只有 14',
      shouldFix: true,
    },
    {
      id: 'flow-break',
      kind: 'flow',
      feature: 'handover',
      aliases: ['交接导入'],
      where: 'page-handover.js',
      description: '交接导入第二步把已经转成大写的文件名按小写后缀判断，合法 CSV 全被判成不支持的格式',
      shouldFix: true,
    },
    {
      id: 'empty-state',
      kind: 'empty-state',
      feature: 'archive',
      aliases: ['归档看板'],
      where: 'page-archive.js',
      description: '归档看板的空状态只有一句话，没有任何下一步',
      shouldFix: true,
    },
    {
      id: 'misleading-copy',
      kind: 'copy',
      feature: 'sharelink',
      aliases: ['分享链接'],
      where: 'page-sharelink.js',
      description: '按钮写"分享给所有人"，createLink 实际只生成团队内可见的链接',
      shouldFix: true,
    },
    {
      id: 'not-needed',
      kind: 'not-needed',
      feature: 'taxreport',
      aliases: ['税务报表'],
      where: 'page-taxreport.js',
      description: '税务报表使用率低是因为目标用户访谈里没人要求过它；把它"修掉"才是错的',
      shouldFix: false,
    },
  ],
  selfCheck: [
    'usagegap.discovered',
    'usagegap.findingsWithEvidence',
    'usagegap.attribution.correct',
    'usagegap.improvements.observed',
    'usagegap.misFix.count',
  ],
  budget: { turns: 11, reviews: 3 },
  timeline: [
    { verb: 'turn', note: '先看不改：建立 /usage 观测并记下本次要回答的问题' },
    { verb: 'poll', note: '第一份使用数据样本' },
    { verb: 'turn', note: '按样本自己的字段逐条记录发现：四条缺陷 + 一条"目标用户不需要"的待验证判断' },
    { verb: 'turn', note: '补丁 1：把批量导出的入口提到首页；封存产物并请求事项复核' },
    { verb: 'verify' },
    { verb: 'turn', note: '在当前源版本跑完整检查，并请求一次发布级复核' },
    { verb: 'verify' },
    { verb: 'turn', note: '冻结结果预期（visits）与护栏（abandonedSessions），提交发布提议' },
    { verb: 'set', value: sample({ bulkexportVisits: 168, abandonedSessions: 84 }), note: '第一个窗口：入口被看见了' },
    { verb: 'advance', minutes: 20, note: '使用数据按窗口聚合，set 与 poll 之间要等一个采样周期' },
    { verb: 'poll' },
    { verb: 'turn', note: '按冻结的预期复盘：达到预期且护栏没被突破，结论触发独立复核' },
    { verb: 'verify' },
    { verb: 'approve', note: '人工确认封存版本' },
    { verb: 'turn', note: '记录实际结果，并开启第二个观察窗口' },
    {
      verb: 'set',
      value: sample({ bulkexportVisits: 141, abandonedSessions: 148 }),
      truth: 'environment',
      note: '访问次数仍然达标，但放弃会话数涨到 148——来自一次与本次改动无关的外部故障，护栏被突破',
    },
    { verb: 'advance', minutes: 20 },
    { verb: 'poll' },
    { verb: 'advance', minutes: 15, note: '让"从违反出现到复盘反应"有真实的虚拟时长' },
    { verb: 'turn', note: '复盘：未达预期、原因未查清，不把外部故障算成本次效果' },
    { verb: 'turn', note: '按发现顺序继续：补丁 2 给归档看板的空状态加下一步' },
    { verb: 'turn', note: '补丁 3 修掉交接导入第二步' },
    { verb: 'turn', note: '补丁 4 把分享链接的文案改成实际范围' },
  ],
  invariants: [
    invariant('the-served-seed-app-reported-the-same-usage-as-the-first-sample', ({ store, app }) => {
      const first = store.all('loop_evidence').filter((row: any) => row.origin === 'http')[0];
      const served = app?.probe === undefined ? undefined : canonical(app.probe);
      const observed = first ? canonical(first.data) : undefined;
      return {
        ok: !!app?.url && !!served && served === observed,
        detail: `种子应用 ${app?.url || '未启动'}；它自己的 /usage 与采集到的第一份样本${
          served && served === observed ? '逐字段一致' : '不一致或缺失'
        }`,
      };
    }),
    invariant('every-finding-cites-the-collected-usage-sample', ({ store }) => {
      const rows = findings(store);
      const cited = rows.filter((row: any) =>
        (row.evidence || []).some((line: string) => {
          const id = /^\[([^\]]+)\]/.exec(line)?.[1];
          return !!id && store.get('loop_evidence', id)?.origin === 'http';
        })
      );
      return {
        ok: rows.length === 5 && cited.length === rows.length,
        detail: `记录了 ${rows.length} 条发现，其中 ${cited.length} 条引用了实际采集的使用数据样本`,
      };
    }),
    invariant('the-low-usage-cases-were-told-apart', ({ store }) => {
      const rows = findings(store);
      const entrance = rows.find((row: any) => row.title.includes('bulkexport'));
      const notNeeded = counterexample(store);
      return {
        ok: entrance?.kind === 'issue' && notNeeded?.kind === 'hypothesis',
        detail: `入口太深的那条记成 ${entrance?.kind || '无'}，目标用户不需要的那条记成 ${notNeeded?.kind || '无'}`,
      };
    }),
    invariant('the-counterexample-was-never-worked-on', ({ store, service }) => {
      const row = counterexample(store);
      const patched = patchEvidence(store).filter((evidence: any) => evidence.itemId === row?.id).length;
      const chosen = store.all('strategy_decisions').filter((decision: any) => decision.itemId === row?.id).length;
      const shipped = store.all('loop_releases').filter((release: any) => (release.itemIds || []).includes(row?.id));
      const source = readFileSync(join(service.path, 'page-taxreport.js'), 'utf8');
      const seed = readFileSync(join(seedDir('usagegap'), 'page-taxreport.js'), 'utf8');
      return {
        ok: !!row && !patched && !chosen && !shipped.length && source === seed && row.status === 'investigating',
        detail: `反例事项状态 ${row?.status || '无'}；封存改动 ${patched} 次、被选为行动 ${chosen} 次、进入发布 ${shipped.length} 次；页面源码${source === seed ? '未被改动' : '已被改动'}`,
      };
    }),
    invariant('the-four-real-problems-reached-the-real-source', ({ store, service }) => {
      const read = (name: string) => readFileSync(join(service.path, name), 'utf8');
      const fixed = {
        'buried-entrance': read('page-home.js').includes("'bulkexport'"),
        'empty-state': read('page-archive.js').includes('/f/handover'),
        'flow-break': read('page-handover.js').includes('/\\.csv$/i'),
        'misleading-copy': read('page-sharelink.js').includes('生成团队内可见的链接'),
      };
      const missing = Object.entries(fixed).filter(([, done]) => !done);
      return {
        ok: patchEvidence(store).length === 4 && !missing.length,
        detail: `封存的改动 ${patchEvidence(store).length} 次；未落到源码的问题 ${missing.map(([id]) => id).join('、') || '无'}`,
      };
    }),
    invariant('the-improvement-was-judged-by-frozen-rules-in-both-windows', ({ store }) => {
      const reviewed = store.all('strategy_decisions').filter((row: any) => row.review?.assessment);
      const outcomes = reviewed.map((row: any) => row.review.outcome).sort();
      const results = reviewed.flatMap((row: any) => row.review.assessment.results);
      const byRule = results.filter((row: any) => row.checkedBy === 'rule');
      const late = store
        .all('strategy_decisions')
        .filter((row: any) =>
          (row.expectations || []).some((e: any) => e.notBefore < row.createdAt || e.deadline <= row.createdAt)
        );
      return {
        ok:
          outcomes.join() === ['improved', 'not_improved'].sort().join() &&
          byRule.length === results.length &&
          !late.length,
        detail: `复盘结果 ${outcomes.join('、') || '无'}；${byRule.length}/${results.length} 个核对项由系统按 rule 核对；观察窗口起点早于选择的 ${late.length} 个`,
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
      return { ok: caught.length === 1, detail: `护栏被判定 not_met ${caught.length} 次` };
    }),
    invariant('the-outage-was-not-read-as-this-change', ({ store }) => {
      const failed = store
        .all('strategy_decisions')
        .filter((row: any) => row.review?.outcome === 'not_improved')
        .map((row: any) => row.review.assessment);
      const honest = failed.filter((row: any) => row.diagnosis !== 'expected');
      return {
        ok: failed.length === 1 && honest.length === failed.length,
        detail: `${failed.length} 次未达预期的复盘，诊断为 ${failed.map((row: any) => row.diagnosis).join('、') || '无'}`,
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
