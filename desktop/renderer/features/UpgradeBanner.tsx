import { useId, useState } from 'react';
import { Button } from '../components/ui';
import { upgradeView } from './upgradeState';
import type { DesktopAPI, Snapshot } from '../../shared/types';

const seenKey = 'morrow:upgrade-seen';
const phaseLabels: Record<string, string> = {
  pending: '等待当前工作结束',
  draining: '等待当前工作结束',
  exiting: '正在交接',
  blocked: '已停止',
  applied: '已完成',
};

/**
 * One compact line at the top of the shell, in the existing gray style: a new version is installed
 * and what is happening about it. It never claims the switch happened, never tells anyone to kill a
 * process, and 立即重启 only asks — the service refuses while real work is running and says what.
 */
export function UpgradeBanner({
  snapshot,
  api,
  busy,
  onMutate,
  onRefresh,
}: {
  snapshot: Snapshot;
  api: DesktopAPI;
  busy: boolean;
  onMutate: (action: () => Promise<unknown>) => Promise<unknown>;
  onRefresh: () => void;
}) {
  const view = upgradeView(snapshot);
  const restartReason = useId();
  const [openBlockers, setOpenBlockers] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(seenKey) || '';
    } catch {
      return '';
    }
  });
  if (!view || dismissed === view.record.id) return null;
  const { kind, record, state } = view;
  const blockers = state.blockers;
  const restart = () => void onMutate(() => api.requestUpgradeRestart!());
  const dismiss = () => {
    try {
      localStorage.setItem(seenKey, record.id);
    } catch {
      /* View preferences are best effort; the banner still closes for this session. */
    }
    setDismissed(record.id);
  };
  const version = [state.identity.version, record.targetCommit.slice(0, 12)].filter(Boolean).join(' · ');
  return (
    // A switch that stopped is the one outcome worth interrupting for; the rest is progress.
    <div className={`upgrade-banner upgrade-${kind}`} role={kind === 'blocked' ? 'alert' : 'status'}>
      <span className="upgrade-banner-text">
        {kind === 'waiting' && `新版本已安装，等待 ${blockers.length} 项工作结束`}
        {kind === 'ready' && '新版本已安装，即将自动切换'}
        {kind === 'switching' && '正在切换到新版本，稍后会自动回到当前页面'}
        {kind === 'applied' && `已切换到新版本${version ? `（${version}）` : ''}`}
        {kind === 'blocked' &&
          `切换未完成（${phaseLabels[record.phase] || record.phase}）：${record.error || '原因未记录'}`}
      </span>
      {kind === 'waiting' && (
        <>
          <Button variant="ghost" aria-expanded={openBlockers} onClick={() => setOpenBlockers((value) => !value)}>
            {openBlockers ? '收起阻塞工作' : '查看阻塞工作'}
          </Button>
          {/* A disabled button's `title` is unreadable, so the reason stands next to it and is named. */}
          <Button variant="ghost" disabled aria-describedby={restartReason}>
            立即重启
          </Button>
          <span className="subtle" id={restartReason}>
            有工作正在进行，不会被中断；工作结束后自动切换
          </span>
        </>
      )}
      {kind === 'ready' && (
        <Button variant="ghost" disabled={busy || !api.requestUpgradeRestart} onClick={restart}>
          立即重启
        </Button>
      )}
      {kind === 'applied' && (
        <Button variant="ghost" onClick={dismiss}>
          知道了
        </Button>
      )}
      {kind === 'blocked' && (
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onRefresh()}>
            重新检查
          </Button>
          <Button variant="ghost" disabled={busy || !api.requestUpgradeRestart} onClick={restart}>
            重试切换
          </Button>
        </>
      )}
      {kind === 'waiting' && openBlockers && (
        <ul className="upgrade-blockers" aria-label="阻塞切换的工作">
          {blockers.map((blocker, index) => (
            <li key={`${blocker.kind}:${index}`}>{blocker.label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
