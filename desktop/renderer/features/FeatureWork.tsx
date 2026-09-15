import { CheckCircle2, Clock3 } from 'lucide-react';
import type { DesktopAPI } from '../../shared/types';
import { Markdown } from '../components/ui';
import { formatDate } from '../components/format';
import { questionExcerpt } from './ChannelQuestion';
import {
  releaseLabels,
  useProjectWork,
  EvidenceReferences,
  verificationLabels,
  VerificationRecords,
  outcomeLabels,
  ExpectationReview,
} from './work-shared';

const learningLabels = { outcome: '目标成效', hypothesis: '判断', experiment: '尝试' };
const conclusionLabels = {
  active: '进行中',
  supported: '证据支持',
  refuted: '已被推翻',
  inconclusive: '证据不足',
  stopped: '已停止',
};
export function FeatureWork({
  api,
  projectId,
  itemId,
  compact = false,
}: {
  api: DesktopAPI;
  projectId: string;
  itemId: string;
  compact?: boolean;
}) {
  const { data, error } = useProjectWork(api, projectId, itemId);
  if (!api.getProjectWork) return null;
  if (error)
    return (
      <p role="alert" className="form-error">
        {error}
      </p>
    );
  if (!data) return <p className="subtle">正在读取工作记录…</p>;
  if (
    !data.learning.length &&
    !data.watches.length &&
    !data.releases.length &&
    !data.evidence.length &&
    !data.strategy?.decisions.length &&
    !data.verifications?.length
  )
    return compact ? null : (
      <section className="finding-section">
        <h2>持续跟踪</h2>
        <p className="subtle">Codex 会在这里记录判断、尝试和实际反馈，沿着同一个 feature 持续推进。</p>
      </section>
    );
  const full = (
    <section className="finding-section">
      <h2>判断、尝试与反馈</h2>
      <VerificationRecords data={data} />
      {data.strategy?.decisions
        .filter((row) => row.expectations?.length)
        .map((row) => (
          <div key={row.id}>
            <h3>{row.options[row.selected].title}</h3>
            <ExpectationReview row={row} data={data} />
            {row.review && (
              <p>
                <b>{outcomeLabels[row.review.outcome]}：</b>
                {row.review.conclusion}
              </p>
            )}
          </div>
        ))}
      {data.learning.map((row) => (
        <details className="work-record" key={row.id} open={row.status === 'active'}>
          <summary>
            <span className="work-record-kind">{learningLabels[row.kind]}</span>
            <strong>{row.title}</strong>
            <span className="subtle">{conclusionLabels[row.status]}</span>
          </summary>
          <div className="work-record-body">
            <Markdown>{row.rationale}</Markdown>
            <p>
              <b>预期结果：</b>
              {row.expectedResult}
            </p>
            <p>
              <b>验证方式：</b>
              {row.evaluation}
            </p>
            {row.conclusion && (
              <p>
                <b>上次判断：</b>
                {row.conclusion}
              </p>
            )}
            <EvidenceReferences ids={row.evidenceIds} data={data} />
          </div>
        </details>
      ))}
      {data.watches.map((row) => (
        <div className="work-watch" key={row.id}>
          <Clock3 size={14} />
          <div>
            <strong>{row.title}</strong>
            <p>
              {row.status === 'triggered'
                ? row.continuous !== false
                  ? '已收到反馈 · 持续监测'
                  : '已收到符合条件的反馈'
                : row.status === 'expired'
                  ? row.continuous !== false
                    ? '已到复查时间 · 持续监测'
                    : '观察已到截止时间'
                  : row.status === 'cancelled'
                    ? '已停止观察'
                    : `等待反馈 · ${formatDate(row.deadline)}`}
            </p>
            {row.error && <p className="form-error">{row.error}</p>}
          </div>
        </div>
      ))}
      {data.releases.map((row) => (
        <div className="work-watch" key={row.id}>
          <CheckCircle2 size={14} />
          <div>
            <strong>{row.title}</strong>
            <p>{releaseLabels[row.status]}</p>
            <p>{row.observationPlan}</p>
          </div>
        </div>
      ))}
      {!!data.evidence.length && (
        <details className="work-record">
          <summary>
            实际记录与来源 <span className="subtle">{data.evidence.length}</span>
          </summary>
          <div className="work-record-body">
            <EvidenceReferences ids={data.evidence.map((e) => e.id)} data={data} />
          </div>
        </details>
      )}
    </section>
  );
  if (!compact) return full;
  const latest = [...(data.verifications || [])]
    .reverse()
    .filter((row) => row.itemId === itemId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return (
    <section className="finding-section">
      {latest && (
        <div className="finding-latest-review">
          <h2>最近事项复核</h2>
          <p>
            {verificationLabels[latest.status]} ·{' '}
            {latest.current === true ? '当前版本' : latest.current === false ? '版本或条件已变化' : '版本未核对'}
          </p>
          <p>{questionExcerpt(latest.summary, 160)}</p>
        </div>
      )}
      <details className="finding-disclosure" key={itemId}>
        <summary>判断、尝试与反馈</summary>
        {full}
      </details>
    </section>
  );
}
