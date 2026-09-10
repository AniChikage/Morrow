import type { Run } from './protocol.ts';
import type { WorkDecision } from './channel-work.ts';
import type { Store } from './store.ts';

export type RunLog = {
  work?: WorkDecision;
  direction?: string;
  commands: Array<{ id: string; command: string; status: string; exitCode?: number; sealed: boolean; output: string }>;
  files: string[];
  outputs: Array<{ id: string; kind: string; title: string; itemId?: string }>;
  activity?: Array<{ id: string; type: string; text: string; input: string; output: string }>;
  truncated: boolean;
};
const brief = (value: unknown, limit = 1000) => {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit) + '…' : text;
};

/** Read-only projection of persisted records; never infer success or write back to a run. */
export function runLog(store: Store, run: Run, detailed = false): RunLog {
  let truncated = false;
  const rows = (table: 'events' | 'loop_evidence' | 'loop_verifications') => {
    const fields =
      table === 'events'
        ? "json_extract(data,'$.action') action, json_extract(data,'$.itemId') itemId, substr(json_extract(data,'$.text'),1,1000) text, json_extract(data,'$.changes.after.state') state, substr(json_extract(data,'$.changes.after.focus'),1,2000) focus, substr(json_extract(data,'$.changes.after.reason'),1,2000) reason, substr(json_extract(data,'$.changes.after.nextStep'),1,2000) nextStep, substr(json_extract(data,'$.changes.after.title'),1,1000) title"
        : table === 'loop_evidence'
          ? "json_extract(data,'$.origin') origin, json_extract(data,'$.itemId') itemId, substr(json_extract(data,'$.source'),1,1000) source, substr(json_extract(data,'$.summary'),1,1000) summary, substr(json_extract(data,'$.data.command'),1,1000) command, json_extract(data,'$.data.status') status, json_extract(data,'$.data.exitCode') exitCode, json_extract(data,'$.data.boundVersion') boundVersion, json_extract(data,'$.data.outputComplete') outputComplete, json_extract(data,'$.data.nativeItemId') nativeItemId, substr(json_extract(data,'$.data.output'),1,4000) output"
          : "json_extract(data,'$.status') status, substr(json_extract(data,'$.summary'),1,1000) summary";
    const records = store.db
      .prepare(
        `SELECT id, ${fields} FROM ${store.table(table)} WHERE
      json_extract(data,'$.projectId')=? AND json_extract(data,'$.channelId')=? AND
      json_extract(data,'$.runId')=? ORDER BY rowid DESC LIMIT 101`
      )
      .all(run.projectId, run.channelId, run.id) as any[];
    if (records.length > 100) truncated = true;
    return records.slice(0, 100).reverse();
  };
  const events = rows('events'),
    evidence = rows('loop_evidence'),
    reviews = rows('loop_verifications');
  const savedWork = events.filter((event) => event.action === 'channel.next-step').at(-1);
  const work =
    savedWork && ['continue', 'wait', 'needs_input'].includes(savedWork.state)
      ? ({
          state: savedWork.state,
          focus: savedWork.focus || '',
          reason: savedWork.reason || '',
          nextStep: savedWork.nextStep || '',
        } as WorkDecision)
      : undefined;
  const items: any[] =
    run.sessionId && run.nativeTurnId
      ? (store.db
          .prepare(
            `SELECT id, json_extract(data,'$.type') type,
        substr(json_extract(data,'$.text'),1,4000) text, substr(json_extract(data,'$.input'),1,4000) input,
        substr(json_extract(data,'$.output'),1,4000) output, substr(json_extract(data,'$.raw.command'),1,1000) command,
        json_extract(data,'$.raw.status') status, json_extract(data,'$.raw.exitCode') exitCode,
        substr(json_extract(data,'$.raw.aggregatedOutput'),1,4000) aggregatedOutput
        FROM native_items WHERE json_extract(data,'$.threadId')=? AND json_extract(data,'$.turnId')=?
        ORDER BY rowid LIMIT 101`
          )
          .all(run.sessionId, run.nativeTurnId) as any[])
      : [];
  if (items.length > 100) {
    truncated = true;
    items.length = 100;
  }
  const commands: RunLog['commands'] = evidence
    .filter((e) => e.origin === 'execution')
    .map((e) => ({
      id: e.id,
      command: brief(e.command || e.source),
      status: e.status || 'unknown',
      ...(Number.isInteger(e.exitCode) ? { exitCode: e.exitCode } : {}),
      sealed: e.boundVersion === 1 && e.outputComplete === 1,
      output: brief(e.output, detailed ? 4000 : 300),
    }));
  const capturedIds = new Set(evidence.filter((e) => e.origin === 'execution').map((e) => e.nativeItemId));
  for (const item of items.filter((item) => item.type === 'commandExecution' && !capturedIds.has(item.id))) {
    commands.push({
      id: item.id,
      command: brief(item.command),
      status: item.status || 'unknown',
      ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
      sealed: false,
      output: brief(item.aggregatedOutput, detailed ? 4000 : 300),
    });
  }
  const files: string[] =
    run.sessionId && run.nativeTurnId
      ? [
          ...new Set(
            (
              store.db
                .prepare(
                  `SELECT substr(json_extract(change.value,'$.path'),1,1000) path
        FROM native_items n, json_each(n.data,'$.raw.changes') change
        WHERE json_extract(n.data,'$.threadId')=? AND json_extract(n.data,'$.turnId')=?
        AND json_extract(n.data,'$.type')='fileChange' AND change.type='object' LIMIT 21`
                )
                .all(run.sessionId, run.nativeTurnId) as any[]
            )
              .map((row) => row.path)
              .filter((path) => typeof path === 'string')
          ),
        ]
      : [];
  const outputs: RunLog['outputs'] = [];
  const itemChanges = new Map<string, any>();
  for (const event of events) {
    if (event.itemId && /^(item|feature)\.(created|updated)$/.test(event.action || ''))
      itemChanges.set(event.itemId, event);
    else if (/^(decision|understanding|learning)\./.test(event.action || ''))
      outputs.push({ id: event.id, kind: '判断', title: brief(event.text) });
  }
  for (const [id, event] of itemChanges)
    outputs.push({ id, itemId: id, kind: '看板事项', title: brief(event.title || event.text) });
  for (const e of evidence)
    outputs.push({ id: e.id, kind: '证据', title: brief(e.summary), ...(e.itemId ? { itemId: e.itemId } : {}) });
  for (const review of reviews)
    outputs.push({ id: review.id, kind: '独立复核', title: `${review.status} · ${brief(review.summary)}` });
  if (commands.length > 20 || files.length > 20 || outputs.length > 30) truncated = true;
  return {
    ...(work ? { work } : {}),
    direction: run.workDirection,
    commands: commands.slice(0, 20),
    files: files.slice(0, 20),
    outputs: outputs.slice(0, 30),
    truncated,
    ...(detailed
      ? {
          activity: items.map((item) => ({
            id: item.id,
            type: item.type,
            text: brief(item.text, 4000),
            input: brief(item.input, 4000),
            output: brief(item.output, 4000),
          })),
        }
      : {}),
  };
}
