// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appResumeSummary } from '../../../service/protocol';
import type { AppResumeRecord } from '../../../service/protocol';
import { ChannelView } from './ChannelView';
import { featureProps, TestProviders } from './testFixtures';
afterEach(cleanup);

const record = (patch: Partial<AppResumeRecord> = {}): AppResumeRecord => ({
  id: 'record-one',
  projectId: 'project-atlas',
  channelId: 'channel-system',
  threadId: 'thread-one',
  originalRunId: 'run-one',
  originalNativeTurnId: 'turn-one',
  pauseCause: 'native-interrupt',
  intent: {
    generation: 2,
    autonomyEnabled: true,
    threadId: 'thread-one',
    briefRevision: 1,
    workDirection: '持续验证问题并记录证据。',
    permission: 'native',
    at: '2026-09-11T17:10:00.000Z',
  },
  status: 'observing',
  basis: [],
  exclusions: [],
  createdAt: '2026-09-11T17:11:23.620Z',
  updatedAt: '2026-09-11T17:11:23.620Z',
  ...patch,
});

test('the channel page shows one collapsed line per App-resume state and keeps the ids out of it', async () => {
  const user = userEvent.setup();
  const cases = [
    [record(), 'App 续跑：观察中', /正在观察 Codex App 是否自行续跑/],
    [
      record({ status: 'linked', relation: 'inferred-sequence', basis: ['resume_interrupted_task'] }),
      'App 续跑：进行中',
      /依据：resume_interrupted_task/,
    ],
    [
      record({ status: 'resumed', appliedAt: '2026-09-11T17:12:15.000Z' }),
      'App 续跑：已恢复等待',
      /App 续跑完成，下一轮核对其工作/,
    ],
    [record({ status: 'unconfirmed', exclusions: ['multiple-candidates'] }), 'App 续跑：关联未确认', /多个|依据/],
    [record({ status: 'kept-paused', exclusions: ['human-pause'] }), 'App 续跑：保持暂停', /依据：human-pause/],
  ] as const;
  for (const [row, label, reason] of cases) {
    const { props } = featureProps();
    props.snapshot.channels[0].appResume = appResumeSummary(row);
    const view = render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    const summary = await screen.findByText(label);
    const details = summary.closest('details') as HTMLDetailsElement;
    // One line, collapsed: the reason is the expandable body, not part of the status line.
    expect(details.open).toBe(false);
    expect(summary.textContent).toBe(label);
    expect(screen.getByText(reason).closest('details')).toBe(details);
    await user.click(summary);
    expect(details.open).toBe(true);
    // Ids stay in the record and the work log, not on the channel page.
    expect(screen.queryByText(/run-one|turn-one|record-one/)).toBeNull();
    view.unmount();
  }
});

test('a channel with no observation shows no App-resume line', async () => {
  const { props } = featureProps();
  render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
  await screen.findByRole('heading', { name: '系统完善' });
  expect(screen.queryByText(/App 续跑/)).toBeNull();
});
