import { APIError, choice, integer, keys, object, string } from './protocol.ts';
import type { Learning } from './autonomy-types.ts';
import type { ProjectWorkLoop, Scope } from './project-loop.ts';
import type { MemoryKind, MemoryMatch, MemoryReference, StrategyDecision, Understanding } from './strategy-types.ts';
import { now } from './store.ts';

export const memoryTables = { understanding: 'strategy_understanding', decision: 'strategy_decisions', learning: 'loop_learning' } as const;
type MemoryRecord = Understanding | StrategyDecision | Learning;
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

// Local lexical retrieval, not a semantic model or a confidence score. Chinese
// bigrams also find a phrase embedded in a longer sentence without spaces.
function terms(value: string) {
  const result = new Set<string>();
  for (const part of normalize(value).match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) || []) {
    if (/\p{Script=Han}/u.test(part)) {
      if (part.length > 1) for (let i = 0; i < part.length - 1; i++) result.add(part.slice(i, i + 2));
    } else if (part.length > 1) result.add(part);
  }
  return result;
}

export class ProjectMemory {
  readonly loop: ProjectWorkLoop;
  constructor(loop: ProjectWorkLoop) { this.loop = loop; }
  get store() { return this.loop.store; }
  record(projectId: string, kind: MemoryKind, id: string) {
    const row = this.store.get<MemoryRecord>(memoryTables[kind], id);
    if (row?.projectId !== projectId) throw new APIError(404, '经验记录不属于当前项目');
    return row;
  }
  describe(kind: MemoryKind, row: MemoryRecord): MemoryMatch {
    const decision = kind === 'decision' ? row as StrategyDecision : undefined;
    const understanding = kind === 'understanding' ? row as Understanding : undefined;
    const learning = kind === 'learning' ? row as Learning : undefined;
    const title = decision ? decision.options[decision.selected].title : (understanding || learning)!.title;
    const excerpt = understanding?.statement || decision?.review?.conclusion || learning?.conclusion || learning?.rationale || '';
    const caution = understanding
      ? understanding.status !== 'active' ? '已失效或停用，只能作为历史参考'
        : understanding.reviewAt <= now() ? '已到复查时间，不能直接沿用'
          : understanding.kind === 'assumption' || understanding.kind === 'unknown' ? '尚未确认的认识，需要验证' : undefined
      : decision ? '这是当时条件下的复盘，需重新判断适用性'
        : learning?.status === 'refuted' || learning?.status === 'stopped' ? '已被推翻或停止，不能直接沿用'
          : learning?.status !== 'supported' ? '尚无确定结论，需重新验证' : '证据支持限于当时条件';
    return {
      kind, id: row.id, revision: row.revision, title, status: row.status,
      excerpt: excerpt.slice(0, 600), truncated: excerpt.length > 600,
      evidenceIds: [...new Set([...row.evidenceIds, ...(decision?.review?.evidenceIds || [])])],
      updatedAt: row.updatedAt, ...(caution ? { caution } : {}),
      ...(decision?.review ? { outcome: decision.review.outcome } : {}),
      ...(understanding ? { reviewAt: understanding.reviewAt } : {}), reasons: [],
    };
  }
  recall(scope: Scope, input: Record<string, unknown>) {
    keys(input, ['query', 'itemId', 'limit']);
    const { project, channel } = this.loop.scope(scope);
    const item = this.loop.item(scope, input.itemId);
    const active = this.loop.strategy.active(project.id).find(row => row.channelId === channel.id);
    const query = string(input.query ?? [item?.title, active?.options[active.selected].title, channel.work?.focus, project.goal, channel.goal].filter(Boolean).join('\n').slice(0, 4000), 'query', 4000, true).trim();
    const limit = integer(input.limit ?? 6, 'limit', 1, 12);
    const queryTerms = [...terms(query)].slice(0, 160);
    const featureId = item?.id || active?.itemId;
    const corpus = (Object.keys(memoryTables) as MemoryKind[]).flatMap(kind =>
      this.loop.rows<MemoryRecord>(memoryTables[kind], project.id)
        .filter(row => kind !== 'decision' || row.status === 'reviewed')
        .map(row => {
          const match = this.describe(kind, row);
          const body = kind === 'understanding'
            ? [ (row as Understanding).statement, (row as Understanding).relevance, (row as Understanding).verification ]
            : kind === 'decision' ? [ (row as StrategyDecision).rationale, (row as StrategyDecision).nextStep, (row as StrategyDecision).expectedOutcome, (row as StrategyDecision).review?.conclusion, (row as StrategyDecision).review?.nextDirection, ...((row as StrategyDecision).expectations?.flatMap(e=>[e.claim,e.scope,e.disconfirm])||[]), (row as StrategyDecision).review?.assessment?.conditionReason, (row as StrategyDecision).review?.assessment?.explanation ]
              : [ (row as Learning).rationale, (row as Learning).expectedResult, (row as Learning).evaluation, (row as Learning).conclusion ];
          return { row, match, title: terms(match.title), body: terms(body.filter(Boolean).join('\n')) };
        }));
    const frequencies = new Map(queryTerms.map(term => [term, corpus.filter(doc => doc.title.has(term) || doc.body.has(term)).length]));
    const ranked = corpus.map(doc => {
      const matched = queryTerms.filter(term => doc.title.has(term) || doc.body.has(term));
      const sameFeature = !!featureId && 'itemId' in doc.row && doc.row.itemId === featureId;
      const score = matched.reduce((total, term) => total + Math.log(1 + corpus.length / (1 + (frequencies.get(term) || 0))) * (doc.title.has(term) ? 3 : 1), 0) + (sameFeature ? 12 : 0);
      const reasons = [...(sameFeature ? ['同一 feature 的历史记录'] : []), ...(matched.length ? [`文字相关：${matched.slice(0, 5).join('、')}`] : [])];
      return { match: { ...doc.match, reasons }, score };
    }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || b.match.updatedAt.localeCompare(a.match.updatedAt) || a.match.id.localeCompare(b.match.id));
    return { query, matches: ranked.slice(0, limit).map(row => row.match), hasMore: ranked.length > limit,
      method: '项目内文字相关性与同一 feature 关联；排序不代表事实可信度或经验适用性。先用 memory.read 阅读完整记录，再判断是否引用。' };
  }
  references(scope: Scope, value: unknown): MemoryReference[] {
    if (!Array.isArray(value) || value.length > 12) throw new APIError(400, 'memoryRefs 必须为不超过 12 项的数组');
    const seen = new Set<string>();
    return value.map(raw => {
      const input = object(raw); keys(input, ['kind', 'id', 'revision', 'use', 'reason']);
      const kind = choice(input.kind, 'kind', Object.keys(memoryTables) as MemoryKind[]);
      const id = string(input.id, 'id', 200), row = this.record(scope.projectId, kind, id);
      const revision = integer(input.revision, 'revision', 1, 2147483647);
      if (row.revision !== revision) throw new APIError(409, '参考经验已更新，请读取最新记录并重新判断适用性');
      if (seen.has(`${kind}:${id}`)) throw new APIError(400, '同一经验只能引用一次');
      seen.add(`${kind}:${id}`);
      if (kind === 'decision' && row.status !== 'reviewed') throw new APIError(409, '尚未复盘的行动不能当作经验引用');
      const use = choice(input.use, 'use', ['apply', 'adapt', 'avoid', 'not_applicable'] as const);
      const snapshot = this.describe(kind, row);
      if (use === 'apply' && (['invalidated', 'retired', 'refuted', 'stopped'].includes(row.status) || (kind === 'understanding' && (row as Understanding).reviewAt <= now()) || ['not_improved', 'abandoned'].includes(snapshot.outcome || ''))) {
        throw new APIError(409, '失效、到期或失败的经验不能直接沿用；先复查，或说明调整方法及重新验证的理由');
      }
      const { reasons, ...saved } = snapshot;
      return { kind, id, revision, use, reason: string(input.reason, 'reason', 3000), snapshot: saved };
    });
  }
}
