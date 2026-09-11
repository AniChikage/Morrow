/**
 * Measures what one autonomous turn actually costs, on an isolated service with a fixture project:
 * a 4 KiB brief and ten board items, the size the real dogfood thread reached. It builds the first
 * turn and then an immediately following turn with nothing changed, and prints both prompt sizes.
 * Nothing here calls a model or touches the user's data directory.
 *
 *   node scripts/prompt-size.ts
 */
import '../tests/harness/env.ts';
import { startIsolated } from '../tests/harness/service.ts';
import { grantFor } from '../tests/harness/grant.ts';
import { now } from '../service/store.ts';
import type { Channel, Project, Run, WorkItem } from '../service/protocol.ts';

/** Second-turn budget this change is meant to hold; the script fails when a turn grows past it. */
export const turnNoteLimit = 1500;
export const reviewLimit = 2500;
export const toolEntryLimit = 250;

const body = '记录当前事实、已验证的部分、仍然未知的部分，以及下一步为什么值得做和怎么核对。';
/** `label` plus filler text cut to exactly `length` characters, so a fixture field has a stated size. */
const filler = (label: string, length: number) => (label + '：' + body.repeat(60)).slice(0, length);

/** A brief the size of a real one: goals, users, stage, priorities, constraints and open decisions. */
export const fixtureBrief = filler('项目说明', 4400);

export type Measurement = {
  first: number;
  second: number;
  review: number;
  charter: number;
  items: number;
  boardJson: number;
  tools: number;
};

export async function measurePrompts(): Promise<Measurement> {
  const s = await startIsolated({
    project: { name: '提示词度量', goal: '把持续工作的每轮输入压到必要范围', brief: fixtureBrief },
  });
  try {
    await s.api('PATCH', '/api/settings', { usageReserve: { window: '5h', keepPercent: 10 } });
    // A bound native task is what selects the autonomous prompt; no transport call is made here.
    s.store.put('native_bindings', {
      id: s.channel.id,
      projectId: s.project.id,
      threadId: 'prompt-size-thread',
      cwd: s.path,
      createdAt: now(),
    });
    const overrides: Partial<Run> = {
      sessionId: 'prompt-size-thread',
      source: 'morrow-schedule',
      executionOwner: 'codex-app',
    };
    const first = grantFor(s, { projectId: s.project.id, channelId: s.channel.id, overrides });
    const items = seedBoard(s, 10, first.run.id);
    const firstPrompt = s.engine.prompt(project(s), channel(s), first.run);
    // The turn is accepted and produces a work decision, so the next one needs no charter.
    s.store.put('runs', { ...first.run, status: 'completed', nativeTurnId: 'prompt-size-turn-1', finishedAt: now() });
    s.store.put('channels', {
      ...channel(s),
      work: {
        state: 'continue',
        focus: items[0].title,
        reason: '上一轮读到的证据仍然支持这个方向，且没有新的反证。',
        nextStep: '继续按上一轮的计划补齐观测，再核对预期与实际结果。',
        runId: first.run.id,
        updatedAt: now(),
        awaitingReply: false,
      },
    });
    const second = grantFor(s, { projectId: s.project.id, channelId: s.channel.id, overrides });
    const secondPrompt = s.engine.prompt(project(s), channel(s), second.run);
    const tools = s.engine.loop.prepare(second.run);
    s.store.put('runs', { ...second.run, status: 'completed', nativeTurnId: 'prompt-size-turn-2', finishedAt: now() });
    s.store.put('channels', {
      ...channel(s),
      work: { ...channel(s).work!, runId: second.run.id },
      promptCharter: { ...channel(s).promptCharter!, turnsSince: 9 },
    });
    const reminder = grantFor(s, { projectId: s.project.id, channelId: s.channel.id, overrides });
    const reviewPrompt = s.engine.prompt(project(s), channel(s), reminder.run);
    if (!reviewPrompt.includes('章程回顾') || reviewPrompt.includes('项目说明结束'))
      throw new Error('measurement must exercise an expired, delivered charter review');
    return {
      tools: tools.length,
      review: reviewPrompt.length,
      first: firstPrompt.length,
      second: secondPrompt.length,
      charter: firstPrompt.length - secondPrompt.length,
      items: items.length,
      boardJson: JSON.stringify(items).length,
    };
  } finally {
    await s.cleanup();
  }
}

const project = (s: { store: any; project: Project }) => s.store.get('projects', s.project.id) as Project;
const channel = (s: { store: any; channel: Channel }) => s.store.get('channels', s.channel.id) as Channel;

/** Items with realistic field lengths: the first is human-created, the second the previous run touched. */
export function seedBoard(
  s: { store: any; project: Project; channel: Channel },
  count: number,
  lastRunId = ''
): WorkItem[] {
  const time = now();
  const items: WorkItem[] = [];
  for (let index = 0; index < count; index++) {
    const item: WorkItem = {
      id: `prompt-size-item-${index}`,
      projectId: s.project.id,
      origin: index === 0 ? 'human' : 'agent',
      number: index + 1,
      channelId: s.channel.id,
      sourceChannelIds: [s.channel.id],
      lastRunId: index === 1 ? lastRunId : '',
      revision: index + 1,
      title: filler(`事项 ${index + 1}`, 40),
      summary: filler(`事项 ${index + 1} 摘要`, 380),
      status: index % 5 === 4 ? 'resolved' : index % 3 === 0 ? 'investigating' : 'open',
      kind: index % 4 === 0 ? 'issue' : index % 3 === 0 ? 'hypothesis' : 'feature',
      evidence: Array.from({ length: 4 }, (_, e) => filler(`[evidence-${index}-${e}] 观测`, 90)),
      nextStep: filler(`事项 ${index + 1} 下一步`, 300),
      createdAt: time,
      updatedAt: time,
    };
    s.store.put('items', item);
    items.push(item);
  }
  return items;
}

if (import.meta.filename === process.argv[1]) {
  const result = await measurePrompts();
  process.stdout.write(
    [
      `board items            ${result.items}`,
      `full board JSON        ${result.boardJson} chars`,
      `first turn (charter)   ${result.first} chars`,
      `second turn (note)     ${result.second} chars`,
      `charter share          ${result.charter} chars`,
      `review turn            ${result.review} chars`,
      `tool entry             ${result.tools} chars`,
      '',
    ].join('\n')
  );
  if (result.second > turnNoteLimit || result.review > reviewLimit || result.tools > toolEntryLimit) {
    process.stderr.write(
      `limits: note ${result.second}/${turnNoteLimit}, review ${result.review}/${reviewLimit}, tools ${result.tools}/${toolEntryLimit}\n`
    );
    process.exitCode = 1;
  }
}
