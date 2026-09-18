import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Channel, Project, Run } from '../../service/protocol.ts';
import type { Evidence } from '../../service/autonomy-types.ts';
import type { IsolatedService } from './service.ts';

export type Grant = {
  /** The running run row the grant belongs to, as stored. */
  run: Run;
  /** The agent's bearer token; it is not a desktop credential. */
  token: string;
  /** The full `runs/<id>/agent-context.json` a native turn reads. */
  context: any;
  /** `POST /api/agent` with the grant token, asserting `status`; repeat a `requestId` to test idempotency. */
  call: (operation: string, input?: unknown, status?: number, requestId?: string) => Promise<any>;
  /**
   * Seals `command` with `execution.prepare` and emits the native items its capture observes, so a
   * test holds real execution evidence bound to the current source version. Nothing is executed and
   * no model runs: the reported exit code and output are the ones passed in. Needs `sessionId` and
   * `nativeTurnId` overrides, and the project must not change between the two emitted states.
   */
  execute: (command: string, reported?: { exitCode?: number; output?: string }) => Promise<Evidence>;
};

/**
 * A running run plus its work grant, so `/api/agent` can be called the way a native turn calls it.
 * The row mirrors what the scheduler writes (`morrow-schedule`, `codex-app`, the channel goal as the
 * work direction); `overrides` replace any field, e.g. the native thread and turn ids.
 */
export function grantFor(
  service: Pick<IsolatedService, 'store' | 'engine' | 'home' | 'api'>,
  options: { projectId: string; channelId: string; overrides?: Partial<Run> }
): Grant {
  const channel = service.store.get<Channel>('channels', options.channelId);
  const run = {
    id: randomUUID(),
    projectId: options.projectId,
    channelId: options.channelId,
    runtime: 'codex',
    status: 'running',
    source: 'morrow-schedule',
    executionOwner: 'codex-app',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    summary: '',
    sessionId: 'isolated-test',
    workDirection: channel?.goal,
    ...options.overrides,
  } as Run;
  service.store.put('runs', run);
  service.engine.loop.prepare(run);
  const context = JSON.parse(readFileSync(join(service.home, 'runs', run.id, 'agent-context.json'), 'utf8'));
  const call = (operation: string, input: unknown = {}, status = 200, requestId: string = randomUUID()) =>
    service.api('POST', '/api/agent', { operation, input, requestId }, status, context.token);
  const execute = async (command: string, reported: { exitCode?: number; output?: string } = {}) => {
    if (!run.sessionId || !run.nativeTurnId)
      throw new Error('grantFor: execution evidence needs sessionId and nativeTurnId overrides');
    const prepared = await call('execution.prepare', { command });
    const cwd = service.store.get<Project>('projects', options.projectId)!.path;
    const id = `execution-item-${prepared.id}`;
    const emit = (status: 'inProgress' | 'completed') => {
      const output = status === 'inProgress' ? '' : (reported.output ?? `${command} 完成`);
      const raw = {
        id,
        type: 'commandExecution',
        command,
        cwd,
        status,
        aggregatedOutput: output,
        ...(status === 'inProgress' ? {} : { exitCode: reported.exitCode ?? 0 }),
      };
      const row = {
        id,
        threadId: run.sessionId,
        turnId: run.nativeTurnId,
        type: 'commandExecution',
        role: 'tool',
        text: output,
        status,
        raw,
        present: true,
        ordinal: 0,
      };
      service.store.put('native_items', row);
      service.engine.loop.executions.observe(run.sessionId!, [row] as any);
    };
    emit('inProgress');
    emit('completed');
    return (await call('execution.read', { id: prepared.id })).evidence as Evidence;
  };
  return { run, token: context.token as string, context, call, execute };
}
