import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { DesktopAPI, Project, ProjectUsage as ProjectUsageData, UsageWindow } from '../../shared/types';
import { usageWindows } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button } from '../components/ui';
import { formatResetTime, usageWindowLabel } from '../components/format';
import './content.css';

/**
 * The 额度 rows of a project's inspector: the exact account reading per window, the reserve line, this project's
 * estimated share of the chosen window, and the inline form for its cap. Plain rows, no cards.
 */
export function ProjectUsageSection({
  api,
  project,
  busy,
  onMutate,
  readingAt,
}: {
  api: DesktopAPI;
  project: Project;
  busy: boolean;
  onMutate: FeatureProps['onMutate'];
  /** Timestamp of the latest reading in the polled snapshot; a new reading reloads the section. */
  readingAt?: string;
}) {
  const [usage, setUsage] = useState<ProjectUsageData>();
  const [error, setError] = useState('');
  const [selectedWindow, setWindow] = useState<UsageWindow>(project.usageBudget?.window || '5h');
  const [percent, setPercent] = useState(project.usageBudget ? String(project.usageBudget.limitPercent) : '');
  const budgetWindow = project.usageBudget?.window;
  const budgetLimit = project.usageBudget?.limitPercent;
  const load = useCallback(async () => {
    if (!api.getProjectUsage) return;
    try {
      setUsage(await api.getProjectUsage(project.id));
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '额度读取失败');
    }
  }, [api, project.id]);
  useEffect(() => {
    void load();
  }, [load, readingAt, budgetWindow, budgetLimit]);
  useEffect(() => {
    setWindow(budgetWindow || '5h');
    setPercent(budgetLimit === undefined ? '' : String(budgetLimit));
  }, [project.id, budgetWindow, budgetLimit]);
  const supported = !!api.getProjectUsage;
  const canEdit = !!api.updateProjectUsageBudget && !project.isDemo;
  const reading = usage && !usage.stale ? usage.reading : undefined;
  async function save(event: FormEvent) {
    event.preventDefault();
    const value = Number(percent);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      setError('上限需要是 1 到 100 之间的整数。');
      return;
    }
    setError('');
    await onMutate(() => api.updateProjectUsageBudget!(project.id, { window: selectedWindow, limitPercent: value }));
  }
  return (
    <section className="property-section" aria-label="额度">
      <h3>额度</h3>
      {!supported ? (
        <p className="subtle">当前连接的 Morrow 服务尚不支持额度读数。</p>
      ) : (
        <>
          {reading ? (
            reading.windows.map((entry) => (
              <p className="usage-row" key={entry.name}>
                {usageWindowLabel(entry.name)} · 已用 {entry.usedPercent}% ·{' '}
                {entry.resetsAt ? `重置 ${formatResetTime(entry.resetsAt)}` : '重置时间未知'}
              </p>
            ))
          ) : (
            <p className="usage-row">
              <span className="usage-unknown">额度未知</span>
              {/* Same distinction as the runtimes page: nothing read yet, a read that returned nothing, or a stale reading. */}
              <span className="subtle" title={usage?.lastError}>
                {usage?.reading ? '读数已过期' : usage?.attempted === false ? '尚未读取账户用量' : '协议未返回账户用量'}
              </span>
            </p>
          )}
          {usage?.reserve && (
            <p className="usage-row subtle">
              保留线 · {usageWindowLabel(usage.reserve.window)}窗口保留 {usage.reserve.keepPercent}%
            </p>
          )}
          {usage?.budget && usage.project && (
            <p
              className="usage-row"
              title={`自 ${formatResetTime(usage.project.windowStart)} 起归因到本项目的 ${usage.project.runs} 轮`}
            >
              本项目 · {usageWindowLabel(usage.budget.window)} · 估算已用 {usage.project.usedPercent}%，上限{' '}
              {usage.budget.limitPercent}%（{usage.project.runs} 轮）
            </p>
          )}
          {usage?.gate.blocked && !usage.gate.pending && <p className="usage-row subtle">{usage.gate.message}</p>}
          <form className="usage-form" onSubmit={save} aria-label="项目额度上限">
            <select
              aria-label="额度窗口"
              value={selectedWindow}
              disabled={!canEdit || busy}
              onChange={(event) => setWindow(event.target.value as UsageWindow)}
            >
              {usageWindows.map((name) => (
                <option key={name} value={name}>
                  {usageWindowLabel(name)}
                </option>
              ))}
            </select>
            <input
              aria-label="额度上限百分比"
              type="number"
              min={1}
              max={100}
              step={1}
              placeholder="上限 %"
              value={percent}
              disabled={!canEdit || busy}
              onChange={(event) => setPercent(event.target.value)}
            />
            <Button
              variant="primary"
              type="submit"
              aria-label="保存额度上限"
              disabled={!canEdit || busy || !percent.trim()}
            >
              保存
            </Button>
            <Button
              aria-label="清除额度上限"
              disabled={!canEdit || busy || !project.usageBudget}
              onClick={() => void onMutate(() => api.updateProjectUsageBudget!(project.id, null))}
            >
              清除
            </Button>
          </form>
          {project.isDemo && <p className="subtle">示例项目不能设置额度上限。</p>}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
