import { ArrowUpRight } from 'lucide-react';
import type { DecisionView, ProjectLoop } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState, Markdown } from '../components/ui';
import { formatDate } from '../components/format';
import {
  useProjectWork,
  EvidenceReferences,
  SourceNotice,
  VerificationRecords,
  outcomeLabels,
  ExpectationReview,
} from './work-shared';

const understandingLabels = {
  fact: '事实记录',
  assumption: '待验证判断',
  unknown: '关键未知',
  capability: '工作能力',
  constraint: '约束认识',
};
const optionLabels = {
  act: '推进改进',
  investigate: '获取信息',
  build_capability: '补齐能力',
  observe: '继续观察',
  stop: '停止尝试',
};
const memoryUseLabels = { apply: '沿用', adapt: '调整后采用', avoid: '避免重犯', not_applicable: '本次不适用' };
function DecisionRecord({
  row,
  data,
  onChannel,
  showChannel = true,
}: {
  row: DecisionView;
  data: ProjectLoop;
  onChannel: () => void;
  showChannel?: boolean;
}) {
  const selected = row.options[row.selected];
  return (
    <section className="finding-section strategy-decision">
      <div className="strategy-meta">
        <span>{optionLabels[selected.kind]}</span>
        {showChannel && (
          <button onClick={onChannel}>
            查看工作日志 <ArrowUpRight size={12} />
          </button>
        )}
      </div>
      <h2>{selected.title}</h2>
      {row.status === 'active' && row.reviewReasons.length > 0 && (
        <div className="strategy-review" role="status">
          <strong>需要重新判断</strong>
          {row.reviewReasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
      )}
      <p>
        <b>下一步：</b>
        {row.nextStep}
      </p>
      <ExpectationReview row={row} data={data} />
      <details className="work-record">
        <summary>选择依据与投入边界</summary>
        <div className="work-record-body">
          <Markdown>{row.rationale}</Markdown>
          <p>
            <b>预期结果：</b>
            {row.expectedOutcome}
          </p>
          <p>
            <b>如何判断：</b>
            {row.evaluation}
          </p>
          {row.options.map((option, index) => (
            <div className="strategy-option" key={index}>
              <strong>
                {index === row.selected ? '已选择 · ' : ''}
                {option.title}
              </strong>
              <p>价值：{option.benefit}</p>
              <p>投入：{option.cost}</p>
              <p>未知：{option.uncertainty}</p>
            </div>
          ))}
          <p>
            <b>调整或停止条件：</b>
            {row.stopWhen}
          </p>
          <p className="subtle">
            复查时间：{formatDate(row.reviewAt)} · 已投入 {row.runsUsed} / {row.maxRuns} 轮，达到边界后先复盘。
          </p>
          <p>
            <b>当时的目标：</b>
            {row.objective.goal}
          </p>
          {row.understandingRefs.map((ref) => {
            const u = data.strategy?.understanding.find((v) => v.id === ref.id);
            return (
              <p key={ref.id} className="subtle">
                依据：{u?.title || ref.id} · 当时版本 {ref.revision}
                {u && u.revision !== ref.revision ? ' · 后续已更新' : ''}
              </p>
            );
          })}
          <EvidenceReferences ids={row.evidenceIds} data={data} />
        </div>
      </details>
      {!!row.memoryRefs?.length && (
        <details className="work-record">
          <summary>
            这次参考了哪些经验 <span className="subtle">{row.memoryRefs.length}</span>
          </summary>
          <div className="work-record-body">
            {row.memoryRefs.map((ref) => (
              <div className="strategy-option" key={`${ref.kind}:${ref.id}`}>
                <strong>
                  {memoryUseLabels[ref.use]} · {ref.snapshot.title}
                </strong>
                <p>{ref.reason}</p>
                <p className="subtle">
                  当时版本 {ref.revision}
                  {ref.snapshot.outcome ? ` · ${outcomeLabels[ref.snapshot.outcome]}` : ''}
                </p>
                {ref.snapshot.caution && <p className="subtle">{ref.snapshot.caution}</p>}
                <Markdown>{ref.snapshot.excerpt}</Markdown>
                {ref.snapshot.truncated && <p className="subtle">此处为历史摘要，完整记录仍保留。</p>}
                <EvidenceReferences ids={ref.snapshot.evidenceIds} data={data} />
              </div>
            ))}
          </div>
        </details>
      )}
      {row.review && (
        <div className="strategy-result">
          <strong>{outcomeLabels[row.review.outcome]}</strong>
          {!row.evaluationVersion && <p className="subtle">历史文字复盘，未进行逐项预期核对。</p>}
          <Markdown>{row.review.conclusion}</Markdown>
          <p>
            <b>对下一步的影响：</b>
            {row.review.nextDirection}
          </p>
          <EvidenceReferences ids={row.review.evidenceIds} data={data} />
        </div>
      )}
    </section>
  );
}
export function ProjectThinking({
  api,
  projectId,
  onNavigate,
  isDemo = false,
  items = [],
}: Pick<FeatureProps, 'api' | 'onNavigate'> & {
  projectId: string;
  isDemo?: boolean;
  items?: FeatureProps['snapshot']['items'];
}) {
  const { data, error, moreHistory, loadingHistory, historyError, loadHistory } = useProjectWork(api, projectId);
  if (error)
    return (
      <div className="feature-scroll">
        <p role="alert" className="form-error">
          {error}
        </p>
      </div>
    );
  if (isDemo && (!api.getProjectWork || (data && !data.strategy)))
    return (
      <EmptyState
        title="此示例暂未提供项目判断数据"
        description="可先查看「看板」中的示例事项。真实项目开展工作后，这里会展示保存的项目认识、行动依据与复盘。"
      />
    );
  if (!api.getProjectWork)
    return <EmptyState title="当前连接暂不支持项目判断" description="连接新版 Morrow 服务后可查看。" />;
  if (!data) return <p className="subtle">正在读取项目判断…</p>;
  if (!data.strategy)
    return (
      <EmptyState
        title="当前服务尚未支持项目判断"
        description="更新所连接的 Morrow 执行服务后，可查看项目认识与行动复盘。"
      />
    );
  const strategy = data.strategy,
    active = strategy.decisions
      .filter((r) => r.status === 'active')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    history = strategy?.decisions.filter((r) => r.status === 'reviewed') || [];
  return (
    <div className="feature-scroll">
      <article className="finding-document strategy-document">
        <div className="strategy-heading">
          <h1>当前判断</h1>
          {active[0] && (
            <Button variant="primary" onClick={() => onNavigate({ kind: 'channel', id: active[0].channelId })}>
              查看最新工作日志 <ArrowUpRight size={12} />
            </Button>
          )}
        </div>
        <p className="subtle">
          {active.length ? '先看当前下一步，在工作日志中跟进进展。' : '查看已保存的判断与反馈。'}
        </p>
        {!active.length && (
          <section className="finding-section">
            <h2>
              {history.length ? '已保存的下一步' : data.verifications?.length ? '已有复核反馈' : '等待形成下一步判断'}
            </h2>
            <p className="subtle">
              {history.at(-1)?.review?.nextDirection ||
                (data.verifications?.length
                  ? '复核记录已保存，原频道可据此继续修正或核验。'
                  : '频道运转起来后，Codex 会理解项目现状，再记录值得推进的方向。这里仅展示已保存的真实判断。')}
            </p>
          </section>
        )}
        {active.map((row, index) => (
          <DecisionRecord
            key={row.id}
            row={row}
            data={data}
            showChannel={index > 0}
            onChannel={() => onNavigate({ kind: 'channel', id: row.channelId })}
          />
        ))}
        {!!strategy?.understanding.length && (
          <details className="work-record" key={`understanding:${projectId}`} open>
            <summary>
              对项目的认识 <span className="subtle">{strategy.understanding.length}</span>
            </summary>
            {strategy.understanding.map((row) => (
              <details className="work-record" key={row.id}>
                <summary>
                  <span className="work-record-kind">{understandingLabels[row.kind]}</span>
                  <strong>{row.title}</strong>
                  <span className="subtle">
                    {row.status === 'invalidated'
                      ? '已推翻'
                      : row.status === 'retired'
                        ? '已停用'
                        : row.reviewAt <= new Date().toISOString()
                          ? '待复查'
                          : ''}
                  </span>
                </summary>
                <div className="work-record-body">
                  <Markdown>{row.statement}</Markdown>
                  <p>
                    <b>为什么相关：</b>
                    {row.relevance}
                  </p>
                  <p>
                    <b>如何复查：</b>
                    {row.verification}
                  </p>
                  <p className="subtle">
                    版本 {row.revision} · {formatDate(row.updatedAt)}
                  </p>
                  <EvidenceReferences ids={row.evidenceIds} data={data} />
                </div>
              </details>
            ))}
          </details>
        )}
        {!!history.length && (
          <details className="work-record strategy-history">
            <summary>
              此前尝试与复盘 <span className="subtle">{history.length}</span>
            </summary>
            {history
              .slice()
              .reverse()
              .map((row) => (
                <DecisionRecord
                  key={row.id}
                  row={row}
                  data={data}
                  onChannel={() => onNavigate({ kind: 'channel', id: row.channelId })}
                />
              ))}
          </details>
        )}
        <SourceNotice data={data} />
        <VerificationRecords
          key={projectId}
          data={data}
          items={items}
          compact
          history={{ more: moreHistory, loading: loadingHistory, error: historyError, load: () => void loadHistory() }}
        />
      </article>
    </div>
  );
}
