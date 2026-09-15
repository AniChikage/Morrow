// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectLoop } from '../../shared/types';
import { FindingView } from './FindingView';
import { EvidenceReferences } from './work-shared';
import { featureProps, TestProviders, timestamp } from './testFixtures';

afterEach(cleanup);

it.each([
  ['execution', '原生命令 · 退出码 0 · node scripts/prompt-size.ts', 'node scripts/prompt-size.ts', true],
  ['file', '边界核对日志', '/tmp/project/checks.log', false],
  ['file', '读取 /tmp/project/checks.log 后核对边界', '/tmp/project/checks.log', true],
  ['execution', '原生命令 · node scripts/prompt-size.ts…', 'node scripts/prompt-size.ts && npm run typecheck', false],
] as const)(
  'keeps the %s evidence identity and only removes duplicate source text (%s)',
  async (origin, summary, source, duplicate) => {
    const { props } = featureProps();
    const id = '7e9c4894-504f-4c4a-9d92-e11accf76c82';
    const text = `[${id}] ${summary}\n来源：${source}`;
    props.snapshot.items[0].evidence = [text];
    const data: ProjectLoop = {
      releases: [],
      watches: [],
      learning: [],
      evidence: [
        {
          id,
          projectId: 'project-atlas',
          channelId: 'channel-system',
          runId: 'run-one',
          summary,
          source,
          origin,
          observedAt: timestamp,
          createdAt: timestamp,
          data: '保留原始记录',
        },
      ],
    };
    const original = JSON.stringify({ items: props.snapshot.items, data });
    render(
      <>
        <FindingView {...props} id="finding-import" />
        <section aria-label="结构化证据">
          <EvidenceReferences ids={[id]} data={data} />
        </section>
      </>,
      { wrapper: TestProviders }
    );
    await userEvent.setup().click(screen.getByText('证据', { selector: 'summary' }));
    const row = within(screen.getByRole('list', { name: '事项证据' })).getByRole('listitem');
    expect(row.title).toBe(id);
    expect(row.textContent).not.toContain(id);
    expect(row.textContent).toContain(summary);
    expect(row.textContent?.split(source)).toHaveLength(2);
    expect(row.textContent?.includes('来源：')).toBe(!duplicate);
    const structured = within(screen.getByRole('region', { name: '结构化证据' }));
    const disclosure = structured.getByText(summary).closest('summary')!;
    expect(disclosure.title).toBe(id);
    await userEvent.setup().click(disclosure);
    const sourceLine = disclosure.parentElement!.querySelector('.work-source')!;
    expect(sourceLine.textContent?.includes(source)).toBe(!duplicate);
    expect(sourceLine.textContent).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
    expect(structured.getByText('保留原始记录')).toBeTruthy();
    expect(JSON.stringify({ items: props.snapshot.items, data })).toBe(original);
  }
);

it('preserves free-form evidence, Markdown links and identifiers within the original text', async () => {
  const { props } = featureProps();
  const id = '7e9c4894-504f-4c4a-9d92-e11accf76c82';
  props.snapshot.items[0].evidence = [
    '[manual] 人工说明\n来源：人工说明',
    `[${id}](https://example.com/evidence)`,
    `[${id}] 摘要内部引用 [${id}]\n来源：独立来源`,
  ];
  const original = [...props.snapshot.items[0].evidence];
  render(<FindingView {...props} id="finding-import" />, { wrapper: TestProviders });
  await userEvent.setup().click(screen.getByText('证据', { selector: 'summary' }));
  const rows = within(screen.getByRole('list', { name: '事项证据' })).getAllByRole('listitem');
  expect(rows[0].textContent?.replace(/\s+/g, ' ')).toContain('[manual] 人工说明 来源：人工说明');
  expect(screen.getByRole('link', { name: id }).getAttribute('href')).toBe('https://example.com/evidence');
  expect(rows[2].title).toBe(id);
  expect(rows[2].textContent).toContain(`摘要内部引用 [${id}]`);
  expect(rows[2].textContent).toContain('来源：独立来源');
  expect(props.snapshot.items[0].evidence).toEqual(original);
});
