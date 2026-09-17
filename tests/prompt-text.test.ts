import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { autonomousCharter, type PromptContext } from '../service/channel-work.ts';
import type { Scope } from '../service/project-loop.ts';
import type { Channel, Project } from '../service/protocol.ts';
import type { Verification } from '../service/verification-types.ts';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { startReleaseFixture } from './harness/release.ts';

/**
 * The exact bytes of every prompt and contract text an agent receives, pinned by digest. The text
 * lives in the service only to be sent to a model, so moving it between modules must not edit it:
 * a changed digest here is either a deliberate prompt change (update the digest in the same commit
 * and say so) or an accident a refactor made. Inputs are fixed literals wherever a call site takes
 * them, so the digest covers the text and nothing else.
 */
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const fixedProject: Project = {
  id: 'prompt-text-project',
  name: '提示词文本',
  path: '/tmp/prompt-text-project',
  goal: '让每段发给模型的文本都有确定的字节',
  brief: '第一行要求。\n第二行要求。',
  briefRevision: 3,
  createdAt: '2026-01-02T03:04:05.000Z',
  isDemo: false,
  runtime: 'codex',
};
const fixedChannel: Channel = {
  id: 'prompt-text-channel',
  projectId: fixedProject.id,
  name: '长期职责',
  goal: '把提示词文本固定下来',
  runtime: 'codex',
  model: 'gpt-5-codex',
  status: 'idle',
  intervalMinutes: 30,
  maxRunsPerDay: 12,
  permission: 'workspace-write',
  nextRunAt: '2026-01-02T04:00:00.000Z',
  lastRunAt: '2026-01-02T03:00:00.000Z',
  sessionId: '',
};
/** The board-report schema the charter appends when a turn has no work grant; a fixed stand-in. */
const fixedReportSchema = { type: 'object', properties: { items: { type: 'array' } } };

const charterContext = (over: Partial<PromptContext> = {}): PromptContext => ({
  project: fixedProject,
  channel: fixedChannel,
  items: [],
  ...over,
});

test('the autonomous charter text is unchanged for every channel scope and report mode', () => {
  const workspace = autonomousCharter(charterContext());
  const readOnly = autonomousCharter(charterContext({ channel: { ...fixedChannel, permission: 'read-only' } }));
  const native = autonomousCharter(charterContext({ channel: { ...fixedChannel, permission: 'native' } }));
  const report = autonomousCharter(charterContext({ reportSchema: fixedReportSchema }));
  assert.deepEqual(
    { workspace: digest(workspace), readOnly: digest(readOnly), native: digest(native), report: digest(report) },
    {
      workspace: '6fa5acdd4ca837ac49981c7683268f3f4d06c4555f06c9ee8f0c15a2e060be1e',
      readOnly: 'd690bf0ccc2cc2ab157eabb5f215c7964ab871b4455471e92386d04156aa5227',
      native: '3fbfc1ed0ed40c15b452a32cf59edae331a7ff1f48ce14195af152220e47fbe8',
      report: '4bb6f05afe605742ff1324941ace985295b1e4210ef3df305613558b89c2365b',
    }
  );
});

test('the non-native CLI turn prompt text is unchanged', async () => {
  const s = await startIsolated({ project: false });
  try {
    // Ids no row uses: the board, notes, knowledge and prior runs the prompt reads are all empty,
    // so every byte of the result comes from the fixed literals above and the prompt text itself.
    assert.equal(s.engine.loop.channelNames(fixedProject.id)[fixedChannel.id], undefined);
    const prompt = s.engine.prompt(fixedProject, fixedChannel);
    assert(prompt.includes('verified/resolved 只用于复核者能在只读环境独立重现的事实'));
    assert(prompt.includes('测试、构建等命令结果只作为证据附上，不作为 verified 的依据'));
    assert.equal(
      digest(prompt),
      // Changed deliberately for #45: verified/resolved claims must be independently reproducible
      // read-only facts. Test/build results remain supporting material, not grounds for verified;
      // the prompt no longer asks a read-only reviewer to rerun commands that write files.
      // 0.14.0 introduced the automatic independent read-only review before claims take effect.
      // (0.13.0 changed the sentence that introduces the JSON context: it now
      // names `humanNotes` as notes people left for the channel rather than live input, and says the
      // ones marked `new` arrived after the previous turn started and must be answered this turn.
      // 0.12.1 changed the two edits after the permission line: the 45-minute limit the turn now
      // states, and the working-tree line the native charter already had. `fixedProject.path` is not
      // a repository, so the tree line stays empty here.)
      '68c357f0a89f129d610d52fc91cdf663d3b2fff3085aca2c180205b273efe82f'
    );
  } finally {
    await s.cleanup();
  }
});

test('the work contract and strategy guidance served to a turn are unchanged', async () => {
  const s = await startIsolated({});
  try {
    const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    const scope: Scope = {
      id: 'prompt-text-grant',
      projectId: s.project.id,
      channelId: s.channel.id,
      runId: grant.run.id,
      expiresAt: '',
    };
    const contract = s.engine.loop.contract(scope, {});
    const { operations, releaseAdapter, principles } = contract;
    assert.match(operations['feature.complete'], /原子保存复盘与事项完成意图/);
    assert.match(principles, /探索或效果实验/);
    assert.equal(
      digest(JSON.stringify({ operations, releaseAdapter, principles })),
      // Atomic completion plus a lighter path for clear fixes; evidence and release gates remain.
      '0d482d130a7eb91890ad389cb1957ef0f8a8bab074aac1758fdb782f33388c90'
    );
    const strategy = s.engine.loop.strategy.context(scope);
    assert.equal(
      digest(
        JSON.stringify({
          readMore: strategy.readMore,
          reset: strategy.budget.reset,
          evaluationGuidance: strategy.evaluationGuidance,
          observationGuidance: strategy.observationGuidance,
          guidance: strategy.guidance,
        })
      ),
      '660fadeba7fde018b4e5a742cd572682817edd108e452a3dceb842fa11b6e189'
    );
  } finally {
    await s.cleanup();
  }
});

/**
 * Ids, timestamps, digests, commits and the temporary project path differ on every run, and the
 * reviewer prompt quotes the frozen material as JSON. Replacing exactly those leaves the prompt
 * text itself, which is what this file pins.
 */
const stable = (text: string, root: string) =>
  text
    .replaceAll(root, '<project>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>')
    .replace(/\b[0-9a-f]{64}\b/g, '<digest>')
    .replace(/\b[0-9a-f]{40}\b/g, '<commit>');

test('the release and item review prompt text is unchanged', async () => {
  const s = await startReleaseFixture();
  try {
    const rows = s.store.all<Verification>('loop_verifications');
    const release = rows.find((row) => row.kind === 'release')!;
    const item = rows.find((row) => row.kind !== 'release')!;
    // Deliberate: the release prompt now states its own 8-minute cap instead of the item's 5.
    assert.equal(
      digest(stable(release.prompt, s.path)),
      'e54dc1f9cb10bc96a86a4985ecd4e014d477109eb3f4c0731a3e95fb4274fb33'
    );
    assert.equal(
      digest(stable(item.prompt, s.path)),
      'f12d95d2990d3886d366cd8122a45a05a05d6a640c50070b9fde37d24d445306'
    );
  } finally {
    await s.cleanup();
  }
});
