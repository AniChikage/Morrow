import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Channel, Run } from '../../service/protocol.ts';
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
  return { run, token: context.token as string, context, call };
}
