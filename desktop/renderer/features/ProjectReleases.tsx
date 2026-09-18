import { useState } from 'react';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import type { DesktopAPI, Release, ReleaseScript } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, EmptyState, Markdown } from '../components/ui';
import { formatDate } from '../components/format';
import { upgradeSwitching } from './upgradeState';
import {
  releaseLabels,
  useProjectWork,
  EvidenceReferences,
  SourceNotice,
  verificationLabel,
  VerificationRecords,
} from './work-shared';

/** Reads the sealed script on demand, so a human sees the exact text that will run before approving. */
function ReleaseScriptText({ api, releaseId }: { api: DesktopAPI; releaseId: string }) {
  const [script, setScript] = useState<ReleaseScript>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  if (!api.getReleaseScript) return null;
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setScript(await api.getReleaseScript!(releaseId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '封存脚本读取失败');
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="release-script">
      {!script && (
        <Button variant="ghost" disabled={loading} onClick={() => void load()}>
          {loading ? '正在读取…' : '查看将要执行的脚本'}
        </Button>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {script && (
        <>
          <p className="work-source">
            {script.script.path} · {script.script.bytes.toLocaleString()} 字节
          </p>
          <pre className="release-log">{script.script.text}</pre>
          {script.statusScript && (
            <>
              <p className="work-source">{script.statusScript.path}（核对状态时执行）</p>
              <pre className="release-log">{script.statusScript.text}</pre>
            </>
          )}
        </>
      )}
    </div>
  );
}
export function ProjectReleases(props: FeatureProps & { projectId: string }) {
  const { snapshot, api, projectId, busy, onMutate, onNavigate } = props;
  const releases = (snapshot.releases || [])
    .filter((row) => row.projectId === projectId)
    .slice()
    .reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const ongoing = releases.filter((r) => ['awaiting_approval', 'approved', 'publishing', 'unknown'].includes(r.status));
  ongoing.sort((a, b) => Number(b.status === 'awaiting_approval') - Number(a.status === 'awaiting_approval'));
  const visible = ongoing.length ? ongoing : releases.slice(0, 1);
  const previous = releases.filter((r) => !visible.includes(r));
  const [selected, setSelected] = useState<string>();
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState('');
  const { data, error } = useProjectWork(api, projectId);
  // A publication started during the handover would be interrupted by it; declining still works.
  const switching = upgradeSwitching(snapshot);
  const row = releases.find((r) => r.id === selected);
  const missingEvidence =
    !!row &&
    !!data &&
    row.checks.some((check) => check.evidenceIds.some((id) => !data.evidence.some((e) => e.id === id)));
  // The one review of this candidate as a whole; each item's own review stays in the list below.
  const releaseReview = row?.releaseVerificationId
    ? data?.verifications?.find((v) => v.id === row.releaseVerificationId)
    : undefined;
  const review = async (decision: 'approve' | 'reject') => {
    if (!row || !api.reviewRelease || pending) return;
    setPending(true);
    setLocalError('');
    const ok = await onMutate(() => api.reviewRelease!(row.id, row.reviewHash, decision, feedback));
    if (!ok) setLocalError('操作未完成，请核对错误后重试；不会自动重复提交。');
    setPending(false);
  };
  const releaseEntry = (release: Release) => (
    <button
      key={release.id}
      onClick={() => {
        setSelected(release.id);
        setFeedback('');
        setLocalError('');
      }}
      className="release-row"
    >
      <span className={`release-status release-${release.status}`}>{releaseLabels[release.status]}</span>
      <strong>{release.title}</strong>
      <span className="subtle">{release.itemIds.length} 个事项</span>
      <ArrowUpRight size={14} />
    </button>
  );
  if (!row)
    return (
      <div className="feature-scroll">
        {releases.length ? (
          <article className="finding-document release-document">
            <h1>上线确认</h1>
            <p className="subtle">
              {ongoing.some((r) => r.status === 'awaiting_approval')
                ? '先打开待审版本，核对变更与风险后再确认。'
                : ongoing.length
                  ? '查看上线进度；结局未知时先核对回执。'
                  : '查看最近上线结果，之前的版本在历史中。'}
            </p>
            <section aria-label={ongoing.length ? '待确认与上线进度' : '最近上线结果'}>
              {visible.map(releaseEntry)}
            </section>
            {!!previous.length && (
              <details className="work-record release-history" key={projectId}>
                <summary>
                  历史上线 <span className="subtle">{previous.length}</span>
                </summary>
                {previous.map(releaseEntry)}
              </details>
            )}
          </article>
        ) : (
          <EmptyState
            title="AI 准备好后，在这里确认上线"
            description="变更、复核结果、预期收益与观察计划会一并提交。上线后的效果继续归入原来的事项。"
          />
        )}
      </div>
    );
  return (
    <div className="feature-scroll">
      <article className="finding-document release-document" key={row.id}>
        <Button variant="ghost" onClick={() => setSelected(undefined)}>
          <ArrowLeft size={14} />
          所有上线
        </Button>
        <div className="release-heading">
          <span className={`release-status release-${row.status}`}>{releaseLabels[row.status]}</span>
          <span className="subtle">{formatDate(row.createdAt)}</span>
        </div>
        <h1>{row.title}</h1>
        {row.error && (
          <p role="alert" className="form-error">
            {row.error}
          </p>
        )}
        <section className="finding-section">
          <h2>本次确认的版本</h2>
          <p className="work-source">
            {row.artifact.name} · {row.artifact.bytes.toLocaleString()} 字节
          </p>
          <p className="work-source">SHA256 {row.artifact.sha256}</p>
          <p className="work-source">审核标识 {row.reviewHash}</p>
          <p className="subtle">上线使用这份封存产物，后续修改需要重新准备版本。</p>
        </section>
        <details className="work-record">
          <summary>
            关联事项 <span className="subtle">{row.itemIds.length}</span>
          </summary>
          <div className="release-features">
            {row.itemIds.map((id) => {
              const item = snapshot.items.find((v) => v.id === id);
              return (
                <button key={id} onClick={() => onNavigate({ kind: 'finding', id })}>
                  #{item?.number || '—'} {item?.title || '查看事项'}
                </button>
              );
            })}
          </div>
        </details>
        <section className="finding-section">
          <h2>这次改了什么</h2>
          <Markdown>{row.changes}</Markdown>
        </section>
        <section className="finding-section">
          <h2>影响范围与回退</h2>
          <Markdown>{row.risks}</Markdown>
          <Markdown>{row.rollback}</Markdown>
        </section>
        <section className="finding-section">
          <h2>复核情况</h2>
          {row.checks.map((check, index) => (
            <div key={index} className="release-check">
              <strong>
                {check.result === 'passed' ? '复核通过' : '尚未复核'} · {check.name}
              </strong>
              <EvidenceReferences ids={check.evidenceIds} data={data} />
            </div>
          ))}
          {error && (
            <p role="alert" className="form-error">
              证据加载失败：{error}
            </p>
          )}
          {missingEvidence && (
            <p role="alert" className="form-error">
              部分复核证据尚未读取，暂时无法确认上线。
            </p>
          )}
        </section>
        <SourceNotice data={data} />
        {!!row.releaseVerificationId && (
          <p className="work-source">
            上线级复核：
            {releaseReview ? `${verificationLabel(releaseReview)} · ${releaseReview.summary}` : '记录尚未读取'}
          </p>
        )}
        {!!row.verificationIds?.length && data && (
          <details className="work-record">
            <summary>
              事项历史复核 <span className="subtle">{row.verificationIds.length}</span>
            </summary>
            <VerificationRecords
              items={snapshot.items}
              data={{ ...data, verifications: data.verifications?.filter((v) => row.verificationIds!.includes(v.id)) }}
            />
          </details>
        )}
        <details className="work-record">
          <summary>背景与预期收益</summary>
          <div className="work-record-body">
            <section className="finding-section">
              <h2>为什么做</h2>
              <Markdown>{row.rationale}</Markdown>
            </section>
            <section className="finding-section">
              <h2>预期收益</h2>
              <Markdown>{row.expectedBenefit}</Markdown>
              <p className="subtle">这是待验证的预期，上线后的实际效果会单独记录。</p>
            </section>
          </div>
        </details>
        <section className="finding-section">
          <h2>上线后如何判断效果</h2>
          <Markdown>{row.observationPlan}</Markdown>
        </section>
        <section className="finding-section">
          <h2>上线目标</h2>
          <p>{row.target.label}</p>
          {row.target.kind === 'local-script' ? (
            <>
              <p className="work-source">脚本 {row.target.script}</p>
              <p className="work-source">
                参数 {row.target.args.length ? row.target.args.join(' ') : '（无）'} · 超时 {row.target.timeoutSeconds}{' '}
                秒
              </p>
              <p className="work-source">脚本 SHA256 {row.target.scriptSha256.slice(0, 12)}…</p>
              {row.target.statusScript && <p className="work-source">状态脚本 {row.target.statusScript}</p>}
              <p className="subtle">
                确认后 Morrow 在项目目录执行这份封存脚本，只传入固定的 MORROW_*
                变量，不含服务凭据；脚本本身由你编写并已提交在项目里。
              </p>
              <ReleaseScriptText api={api} releaseId={row.id} />
            </>
          ) : (
            <p className="work-source">{row.target.url}</p>
          )}
        </section>
        {row.feedback && (
          <section className="finding-section">
            <h2>你的指导</h2>
            <Markdown>{row.feedback}</Markdown>
          </section>
        )}
        {!!row.log && (
          <details className="work-record">
            <summary>
              上线脚本输出{' '}
              <span className="subtle">保留最后 {Math.min(row.log.length, 4000).toLocaleString()} 字符</span>
            </summary>
            <pre className="release-log">{row.log.slice(-4000)}</pre>
          </details>
        )}
        {row.status === 'unknown' && (
          <Button
            variant="primary"
            disabled={busy || pending || switching || !api.reconcileRelease}
            onClick={() => void onMutate(() => api.reconcileRelease!(row.id))}
          >
            核对上线结果
          </Button>
        )}
        {row.status === 'awaiting_approval' && (
          <div className="release-confirm">
            <label>
              指导意见（可选）
              <textarea
                aria-label="上线指导意见"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="需要调整的地方，或补充观察重点…"
              />
            </label>
            <div>
              <Button disabled={busy || pending || !api.reviewRelease} onClick={() => void review('reject')}>
                暂不上线，继续调整
              </Button>
              <Button
                variant="primary"
                disabled={busy || pending || switching || !api.reviewRelease || !!error || !data || missingEvidence}
                onClick={() => void review('approve')}
              >
                {pending ? '正在提交…' : '确认这个版本上线'}
              </Button>
            </div>
            {localError && (
              <p role="alert" className="form-error">
                {localError}
              </p>
            )}
          </div>
        )}
      </article>
    </div>
  );
}
