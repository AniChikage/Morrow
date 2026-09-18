/**
 * What the three work pages have in common: the shared work-page request, the labels the
 * records are read by, and the record components themselves. `project-work.css` is this
 * feature's one stylesheet and is loaded here, for every page that builds on these parts.
 */
import { useEffect, useRef, useState } from 'react';
import type { DecisionView, DesktopAPI, ProjectLoop, Release, WorkItem } from '../../shared/types';
import { Button, Markdown } from '../components/ui';
import { mergeById, replaceIfChanged } from '../components/collections';
import { formatDate } from '../components/format';
import { featureNumber } from './featureOwnership';
import './project-work.css';

export const releaseLabels: Record<Release['status'], string> = {
  awaiting_approval: '待确认上线',
  approved: '已确认，等待上线',
  publishing: '正在上线',
  published: '已上线',
  rejected: '暂不上线',
  unknown: '上线结果待核对',
  failed: '上线失败',
};
type WorkPageState = {
  data?: ProjectLoop;
  error: string;
  historyError: string;
  moreHistory: boolean;
  loadingHistory: boolean;
};
const emptyWorkPage: WorkPageState = { error: '', historyError: '', moreHistory: false, loadingHistory: false };
/**
 * One work page per (project, item): its request, its result, its loaded history and its five-second
 * poll, shared by every mounted consumer. `FeatureWork`, `ProjectThinking` and `ProjectReleases` each
 * polled `projects/:id/work` on their own, so an open channel page — which shows the releases of its
 * project — ran the same request two or three times over at once.
 */
type WorkPage = {
  readonly api: DesktopAPI;
  readonly key: string;
  readonly subscribers: Set<() => void>;
  state: WorkPageState;
  timer: ReturnType<typeof setInterval>;
  /** False once the last consumer has gone, so a late response writes nothing that is still shown. */
  alive: boolean;
  pending: boolean;
  base?: ProjectLoop;
  older: Pick<ProjectLoop, 'verifications' | 'evidence'>;
  cursor?: string;
  historyBusy: boolean;
  historyStarted: boolean;
  historyRequest: number;
  load: () => Promise<void>;
  loadHistory: () => Promise<void>;
};
/** Keyed by the desktop API first: another connection is another service, not the same page. */
const workPages = new WeakMap<DesktopAPI, Map<string, WorkPage>>();
function createWorkPage(api: DesktopAPI, key: string, projectId: string, itemId?: string): WorkPage {
  const page: WorkPage = {
    api,
    key,
    subscribers: new Set(),
    state: emptyWorkPage,
    timer: setInterval(() => {
      if (document.visibilityState !== 'hidden') void page.load();
    }, 5000),
    alive: true,
    pending: false,
    older: { verifications: [], evidence: [] },
    historyBusy: false,
    historyStarted: false,
    historyRequest: 0,
    load: () => Promise.resolve(),
    loadHistory: () => Promise.resolve(),
  };
  const publish = (patch: Partial<WorkPageState>) => {
    const next: WorkPageState = { ...page.state, ...patch };
    // A poll that read the same page changes nothing here, so no consumer re-renders.
    if ((Object.keys(next) as Array<keyof WorkPageState>).every((field) => next[field] === page.state[field])) return;
    page.state = next;
    page.subscribers.forEach((notify) => notify());
  };
  const combined = (value: ProjectLoop): ProjectLoop => ({
    ...value,
    verifications: mergeById(page.older.verifications || [], value.verifications || []),
    evidence: mergeById(page.older.evidence, value.evidence),
  });
  page.load = async () => {
    if (page.pending || !api.getProjectWork) return;
    page.pending = true;
    try {
      const result = await api.getProjectWork(projectId, itemId);
      if (page.alive) {
        if (page.base && page.base.verificationHistory?.revision !== result.verificationHistory?.revision) {
          page.historyRequest++;
          page.older = { verifications: [], evidence: [] };
          page.historyStarted = false;
          page.historyBusy = false;
          publish({ loadingHistory: false, historyError: '' });
        }
        page.base = result;
        const patch: Partial<WorkPageState> = { error: '', data: replaceIfChanged(page.state.data, combined(result)) };
        if (!page.historyStarted) {
          page.cursor = result.verificationHistory?.cursor;
          patch.moreHistory = !!result.verificationHistory?.hasMore;
        }
        publish(patch);
      }
    } catch (e) {
      if (page.alive) publish({ error: e instanceof Error ? e.message : '工作记录加载失败' });
    } finally {
      page.pending = false;
    }
  };
  page.loadHistory = async () => {
    if (page.historyBusy || !page.cursor || !api.getProjectWork) return;
    const before = page.cursor,
      request = ++page.historyRequest;
    page.historyBusy = true;
    page.historyStarted = true;
    publish({ loadingHistory: true, historyError: '' });
    try {
      const older = await api.getProjectWork(projectId, itemId, before);
      if (!page.alive || request !== page.historyRequest) return;
      if (older.verificationHistory?.revision !== page.base?.verificationHistory?.revision)
        throw new Error('项目记录已更新，请稍后重新加载历史。');
      if (!older.verificationHistory || older.verificationHistory.cursor === before)
        throw new Error('服务未提供更早复核，请更新服务后重试。');
      page.older = {
        verifications: mergeById(page.older.verifications || [], older.verifications || []),
        evidence: mergeById(page.older.evidence, older.evidence),
      };
      page.cursor = older.verificationHistory.cursor;
      const patch: Partial<WorkPageState> = { moreHistory: older.verificationHistory.hasMore };
      if (page.base) patch.data = replaceIfChanged(page.state.data, combined(page.base));
      publish(patch);
    } catch (e) {
      if (page.alive && request === page.historyRequest)
        publish({ historyError: e instanceof Error ? e.message : '历史复核读取失败' });
    } finally {
      if (page.alive && request === page.historyRequest) {
        page.historyBusy = false;
        publish({ loadingHistory: false });
      }
    }
  };
  return page;
}
function acquireWorkPage(api: DesktopAPI, projectId: string, itemId?: string): WorkPage {
  let pages = workPages.get(api);
  if (!pages) workPages.set(api, (pages = new Map()));
  const key = JSON.stringify([projectId, itemId || '']);
  let page = pages.get(key);
  if (!page) pages.set(key, (page = createWorkPage(api, key, projectId, itemId)));
  return page;
}
/** The last consumer to leave takes the page with it, so a remount reads the service again. */
function releaseWorkPage(page: WorkPage): void {
  if (page.subscribers.size) return;
  page.alive = false;
  clearInterval(page.timer);
  const pages = workPages.get(page.api);
  if (pages?.get(page.key) === page) pages.delete(page.key);
}
export function useProjectWork(api: DesktopAPI, projectId: string, itemId?: string) {
  const [state, setState] = useState<WorkPageState>(emptyWorkPage);
  const page = useRef<WorkPage>(undefined);
  useEffect(() => {
    const shared = acquireWorkPage(api, projectId, itemId);
    page.current = shared;
    const notify = () => setState(shared.state);
    shared.subscribers.add(notify);
    notify(); // Whatever this page already holds is shown without asking the service again.
    void shared.load();
    return () => {
      shared.subscribers.delete(notify);
      page.current = undefined;
      releaseWorkPage(shared);
    };
  }, [api, projectId, itemId]);
  return { ...state, loadHistory: () => void page.current?.loadHistory() };
}
export function EvidenceReferences({ ids, data }: { ids: string[]; data?: ProjectLoop }) {
  return (
    <div className="work-evidence">
      {ids.map((id) => {
        const e = data?.evidence.find((row) => row.id === id);
        return (
          <details key={id}>
            <summary title={id}>
              {e?.summary || `证据 ${id.slice(0, 8)}`}{' '}
              <span className="subtle">
                {e?.origin === 'native'
                  ? '原生工具记录'
                  : e?.origin === 'execution'
                    ? '原生执行记录'
                    : e?.origin === 'http'
                      ? 'HTTP 采集'
                      : e?.origin === 'file'
                        ? '文件采集'
                        : 'Agent 记录'}
              </span>
            </summary>
            {e && (
              <>
                <p className="work-source">
                  {e.source && !e.summary.includes(e.source) && <>{e.source} · </>}
                  {formatDate(e.observedAt)}
                </p>
                {e.origin === 'native' && <p className="subtle">原生工具历史快照，不等同于执行检查或验收通过。</p>}
                {e.origin === 'file' && (
                  <p className="subtle">文件采集证明当时保存的内容，不能单独证明命令实际运行。</p>
                )}
                <pre>{typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2)}</pre>
              </>
            )}
          </details>
        );
      })}
    </div>
  );
}
/** Why every review reads as unknown right now: the project's own source version cannot be read. */
export function SourceNotice({ data }: { data?: ProjectLoop }) {
  if (!data?.sourceStale) return null;
  return <p className="work-source">源码版本暂时读不到：{data.sourceReason || '源版本不可读'}，复核状态按未知显示。</p>;
}
export const verificationLabels = {
  queued: '等待独立复核',
  running: '正在独立复核',
  passed: '独立复核通过',
  failed: '复核未通过',
  unknown: '复核结果未知',
};
export type VerificationRow = NonNullable<ProjectLoop['verifications']>[number];
/**
 * Which runtime actually ran a review. A review never runs on the runtime that did the work, so
 * this also says which account paid for it; rows written before reviews could pick a runtime, and
 * reviews the Codex App's own background task ran, carry no owner and stay 「原生任务」.
 */
export const reviewOwnerLabels = {
  native: '原生任务',
  'codex-cli': 'Codex 复核会话',
  'claude-cli': 'Claude Code 复核会话',
};
/**
 * What a review says now. A pass only ever covered the source version it ran against, so once that
 * version has moved on the label says so instead of reading as a standing pass.
 */
export const verificationLabel = (row: Pick<VerificationRow, 'status'> & { current?: boolean }) =>
  row.status === 'passed' && !row.current ? '源码或核验材料已变化，需要重新复核' : verificationLabels[row.status];
export function VerificationRecord({
  row,
  data,
  expanded,
  compact = false,
  items = [],
}: {
  row: VerificationRow;
  data: ProjectLoop;
  expanded: boolean;
  compact?: boolean;
  items?: WorkItem[];
}) {
  const item = items.find((value) => value.id === row.itemId);
  const release = data.releases.find((value) => value.releaseVerificationId === row.id);
  const title =
    row.kind === 'release'
      ? `上线级 · ${release?.title || '尚未关联上线记录'}`
      : item
        ? `${featureNumber(item)} ${item.title}`
        : row.itemId
          ? '事项信息未载入'
          : row.decisionId
            ? '行动复核'
            : '频道复核';
  const stale = row.status === 'passed' && !row.current;
  const tone =
    stale || row.status === 'unknown' || row.status === 'queued'
      ? 'waiting'
      : row.status === 'passed'
        ? 'verified'
        : row.status;
  return (
    <details className="work-record" open={expanded}>
      <summary>
        <strong>
          <span className="verification-title">
            {title}
            <span className={`verification-status status-${tone}`} title={verificationLabel(row)}>
              {stale ? '需重新复核' : verificationLabel(row)}
            </span>
          </span>
          {compact && (
            <span className="verification-summary">
              {row.summary.length > 120 ? row.summary.slice(0, 120) + '…' : row.summary}
            </span>
          )}
        </strong>
        <span className="subtle">{formatDate(row.finishedAt || row.createdAt)}</span>
      </summary>
      <div className="work-record-body">
        <Markdown>{row.summary}</Markdown>
        {row.findings.map((f, i) => (
          <p key={i}>
            <b>{f.severity === 'blocking' ? '需要修正' : '复核备注'}：</b>
            {f.message}
          </p>
        ))}
        {row.checks.map((c) => (
          <p key={c.expectationId}>
            <b>{verdictLabels[c.verdict]}：</b>
            {c.reason}
          </p>
        ))}
        {row.limitations.map((v, i) => (
          <p className="subtle" key={i}>
            {v}
          </p>
        ))}
        <p className="subtle">
          独立只读任务 · 最多 5 分钟 · 计入频道预算。通过仅覆盖本次核验范围，业务效果仍需实际反馈。
        </p>
        <p className="work-source">
          源版本：{row.version.digest.slice(0, 16)} · {row.version.files} 个文件
          {row.threadId ? ` · ${reviewOwnerLabels[row.executionOwner || 'native']}：${row.threadId}` : ''}
        </p>
        <EvidenceReferences ids={row.evidenceIds} data={data} />
      </div>
    </details>
  );
}
export function VerificationRecords({
  data,
  compact = false,
  history,
  items = [],
}: {
  data: ProjectLoop;
  compact?: boolean;
  items?: WorkItem[];
  history?: { more: boolean; loading: boolean; error: string; load: () => void };
}) {
  const [showAll, setShowAll] = useState(false);
  if (!data.verifications?.length) return null;
  const rows = data.verifications.slice().reverse();
  if (!compact)
    return (
      <section className="finding-section">
        <h2>独立复核</h2>
        {rows.map((row) => (
          <VerificationRecord
            key={row.id}
            row={row}
            data={data}
            items={items}
            expanded={row.status === 'failed' || row.status === 'running'}
          />
        ))}
      </section>
    );
  // A retry or a new decision for the same shared feature supersedes its earlier
  // presentation, never its stored verdict. Unscoped decisions/channels stay distinct.
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = new Map<string, VerificationRow>();
  const previous: VerificationRow[] = [];
  for (const row of rows) {
    const key =
      row.kind === 'release'
        ? `release:${(row.itemIds || []).join(',')}`
        : row.itemId
          ? `item:${row.itemId}`
          : row.decisionId
            ? `decision:${row.decisionId}`
            : `channel:${row.channelId}`;
    if (latest.has(key)) previous.push(row);
    else latest.set(key, row);
  }
  const active = data.strategy?.decisions.filter((row) => row.status === 'active') || [];
  const latestRows = [...latest.values()];
  return (
    <section className="finding-section" aria-label="最近复核">
      <h2>最近复核</h2>
      {history?.more && <p className="subtle">更早的复核尚未全部载入，可在历史中继续读取。</p>}
      {(showAll ? latestRows : latestRows.slice(0, 5)).map((row) => (
        <VerificationRecord
          key={row.id}
          row={row}
          data={data}
          items={items}
          compact
          expanded={
            row.status === 'running' ||
            (row.status === 'failed' &&
              active.some((d) => (row.itemId ? d.itemId === row.itemId : d.id === row.decisionId)))
          }
        />
      ))}
      {latestRows.length > 5 && (
        <Button variant="ghost" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? '只显示最新 5 条' : `显示全部 ${latestRows.length} 条`}
        </Button>
      )}
      {(!!previous.length || history?.more || history?.error) && (
        <details className="work-record verification-history">
          <summary>
            历史复核{' '}
            <span className="subtle">
              {previous.length}
              {history?.more ? ' 已载入' : ''}
            </span>
          </summary>
          {previous.map((row) => (
            <VerificationRecord key={row.id} row={row} data={data} items={items} compact expanded={false} />
          ))}
          {history?.error && <p role="alert">{history.error}</p>}
          {(history?.more || history?.error) && (
            <Button disabled={history.loading} onClick={history.load}>
              {history.loading ? '正在读取…' : history.error ? '重试历史复核' : '加载更早复核'}
            </Button>
          )}
        </details>
      )}
    </section>
  );
}
export const outcomeLabels = {
  improved: '本次预期已达成',
  not_improved: '未达到本次预期',
  inconclusive: '仍无法判断',
  abandoned: '停止这个方向',
};
export const verdictLabels = { met: '有证据支持', not_met: '与预期不符', unknown: '仍待核对' };
const diagnosisLabels = {
  expected: '符合本次预期',
  pending: '等待数据',
  measurement: '观察存在问题',
  execution: '执行存在问题',
  assumption: '原假设需要调整',
  environment: '适用环境发生变化',
  uncertain: '原因仍不确定',
};
const adjustmentLabels = {
  continue: '继续当前方向',
  observe: '继续观察',
  measurement: '完善观察',
  method: '调整方法',
  assumption: '重新判断假设',
  stop: '停止这个方向',
};
export function ExpectationReview({ row, data }: { row: DecisionView; data: ProjectLoop }) {
  const assessment = row.review?.assessment;
  if (!row.expectations?.length) return null;
  const needsRepair = row.observations?.some((o) => o.status === 'needs_repair');
  return (
    <details className="work-record">
      <summary>
        预期与实际{' '}
        <span className="subtle">
          {row.expectations.length} 项{needsRepair ? ' · 观测待修复' : ''}
        </span>
      </summary>
      <div className="work-record-body">
        {row.expectations.map((expected) => {
          const result = assessment?.results.find((r) => r.expectationId === expected.id),
            plan = expected.measurement,
            observation = result?.observation || row.observations?.find((o) => o.expectationId === expected.id);
          return (
            <div className="strategy-option" key={expected.id}>
              <strong>
                {expected.kind === 'guardrail' ? '不能牺牲的条件' : '希望取得的结果'} · {expected.claim}
              </strong>
              <p>
                {result ? verdictLabels[result.verdict] : '等待核对'}
                {result ? ` · ${result.checkedBy === 'rule' ? '规则核对' : 'Codex 根据证据解读'}` : ''}
              </p>
              <p>
                <b>适用条件：</b>
                {expected.scope}
              </p>
              <p>
                <b>验证办法：</b>
                {expected.verification}
              </p>
              {expected.rule && (
                <p>
                  <b>预先约定：</b>
                  {plan?.comparison === 'delta' ? '相对原基线的差值 · ' : ''}
                  {expected.rule.pointer || '整个值'}{' '}
                  {expected.rule.operator === 'gte' ? '≥' : expected.rule.operator === 'lte' ? '≤' : '='}{' '}
                  {String(expected.rule.expected)}
                  {result?.observedValue !== undefined
                    ? ` · 采集值：${result.observedValue === null ? '字段缺失或类型不符' : String(result.observedValue)}`
                    : ''}
                </p>
              )}
              {plan && (
                <div className="measurement-detail">
                  <p>
                    <b>观测指标：</b>
                    {plan.metric}
                  </p>
                  <p>
                    <b>与目标的关系：</b>
                    {plan.goalRelation}
                  </p>
                  <p>
                    <b>原基线：</b>
                    {'unavailable' in plan.baseline
                      ? `尚未取得 · ${plan.baseline.unavailable}`
                      : observation?.baselineValue == null
                        ? '待核对原始记录'
                        : String(observation.baselineValue)}
                    {observation?.observedValue != null ? ` · 最新值：${String(observation.observedValue)}` : ''}
                    {plan.comparison === 'delta' && observation?.comparedValue != null
                      ? ` · 差值：${String(observation.comparedValue)}`
                      : ''}
                  </p>
                  <p>
                    <b>数据核对：</b>
                    {observation?.status === 'ready'
                      ? '已满足原观测条件'
                      : observation?.status === 'needs_repair'
                        ? '需要修复观测'
                        : '等待有效观测'}
                    {observation?.status === 'ready' ? ` · ${verdictLabels[observation.verdict]}` : ''}
                  </p>
                  {observation?.issues.map((issue) => (
                    <p className="subtle" key={issue}>
                      {issue}
                    </p>
                  ))}
                  <p className="subtle">
                    数据时间最多落后 {plan.freshness.maxAgeSeconds} 秒；{plan.checks.map((c) => c.label).join('、')}。
                  </p>
                  {!!observation?.checks.length && (
                    <ul>
                      {observation.checks.map((c, i) => (
                        <li key={i}>
                          {c.label}：
                          {c.status === 'passed' ? '符合约定' : c.status === 'failed' ? '不符合约定' : '缺少有效字段'}
                          {c.observedValue != null ? ` · ${String(c.observedValue)}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="subtle">判断边界：{plan.limitation}</p>
                  <EvidenceReferences
                    ids={[
                      ...new Set([
                        ...('evidenceId' in plan.baseline ? [plan.baseline.evidenceId] : []),
                        ...(observation?.evidenceId ? [observation.evidenceId] : []),
                      ]),
                    ]}
                    data={data}
                  />
                </div>
              )}
              <p>
                <b>反证条件：</b>
                {expected.disconfirm}
              </p>
              <p className="subtle">
                观察窗口：{formatDate(expected.notBefore)} — {formatDate(expected.deadline)}
              </p>
              <p className="work-source">
                约定来源：
                {expected.source.kind === 'file'
                  ? expected.source.path
                  : expected.source.kind === 'execution'
                    ? expected.source.command
                    : (expected.source.path ?? expected.source.url)}
              </p>
              {result && (
                <>
                  <Markdown>{result.reason}</Markdown>
                  <EvidenceReferences ids={result.evidenceIds} data={data} />
                </>
              )}
            </div>
          );
        })}
        {assessment && (
          <div className="strategy-option">
            <strong>{diagnosisLabels[assessment.diagnosis]}</strong>
            <p>
              <b>条件核对：</b>
              {assessment.conditions === 'matched'
                ? '与原条件相符'
                : assessment.conditions === 'changed'
                  ? '条件已有变化'
                  : '条件尚未确认'}{' '}
              · {assessment.conditionReason}
            </p>
            <Markdown>{assessment.explanation}</Markdown>
            <p>
              <b>接下来：</b>
              {adjustmentLabels[assessment.adjustment]}
            </p>
            {assessment.understandingRefs.map((ref) => (
              <p className="subtle" key={ref.id}>
                已保存的认识：{data.strategy?.understanding.find((u) => u.id === ref.id)?.title || ref.id} · 版本{' '}
                {ref.revision}
              </p>
            ))}
            <p className="subtle">规则核对只说明约定字段的结果，因果解释仍需验证。</p>
          </div>
        )}
      </div>
    </details>
  );
}
