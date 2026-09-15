import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APIError, keys, string } from './protocol.ts';
import type { NativeItem } from './protocol.ts';
import type { ProjectWorkLoop, Scope } from './project-loop.ts';
import type { Evidence } from './autonomy-types.ts';
import type { ExecutionCapture } from './verification-types.ts';
import { sourceVersion } from './source-version.ts';
import { now } from './store.ts';

/** Decode only a native shell's three literal argv words. Never evaluate shell text. */
export function executionCommand(raw: Record<string, any>): string {
  const command = typeof raw.command === 'string' ? raw.command : '';
  // An automatically reviewed native command starts as `agent` and completes
  // as `unifiedExecStartup`, with the same literal shell argv representation.
  if (!['agent', 'unifiedExecStartup'].includes(raw.source)) return command;
  const words: string[] = [];
  let word = '',
    quote = '',
    started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (c === '\\' && quote !== "'") {
      const next = command[++i];
      if (next === undefined) return command;
      word += quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next) ? '\\' + next : next === '\n' ? '' : next;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    if (/[;|&()<>`$]/.test(c)) return command;
    word += c;
    started = true;
  }
  if (quote) return command;
  if (started) words.push(word);
  return words.length === 3 && /^(?:\/bin\/)?(?:bash|zsh|sh)$/.test(words[0]) && ['-c', '-lc'].includes(words[1])
    ? words[2]
    : command;
}

export class ExecutionEvidence {
  readonly loop: ProjectWorkLoop;
  /**
   * The captures of a native task that are still waiting for, or watching, their command. Held in
   * memory because `queueSnapshot` asks whether a task is being observed on every single IPC delta
   * and `ingest` on every projection, while the answer changes only when a capture is written — so
   * every write drops the entry of the task it belongs to and the next question reads it again.
   */
  open = new Map<string, ExecutionCapture[]>();
  constructor(loop: ProjectWorkLoop) {
    this.loop = loop;
  }
  /** Stores a capture and invalidates what its task had memoised. */
  write(row: ExecutionCapture): ExecutionCapture {
    this.open.delete(row.threadId);
    return this.loop.store.put('loop_executions', row);
  }
  /** One task's open captures, chosen through `loop_executions_thread` rather than by reading the table. */
  openCaptures(threadId: string): ExecutionCapture[] {
    let rows = this.open.get(threadId);
    if (!rows)
      this.open.set(
        threadId,
        (rows = this.loop.store.db
          .prepare(
            "SELECT data FROM loop_executions WHERE json_extract(data,'$.threadId')=? AND json_extract(data,'$.status') IN ('prepared','running') ORDER BY rowid"
          )
          .all(threadId)
          .map((row: any) => JSON.parse(row.data) as ExecutionCapture))
      );
    return rows;
  }
  prepare(scope: Scope, input: Record<string, unknown>) {
    keys(input, ['command']);
    const { project, run } = this.loop.scope(scope);
    const projectRoot = realpathSync(project.path);
    const serviceDirectory = realpathSync(dirname(fileURLToPath(import.meta.url)));
    const serviceRelative = relative(projectRoot, serviceDirectory);
    if (
      !serviceRelative ||
      (serviceRelative !== '..' && !serviceRelative.startsWith('../') && !isAbsolute(serviceRelative))
    )
      throw new APIError(409, '运行中的 Morrow 服务位于项目目录内；请使用独立安装版服务后再准备执行证据。');
    if (!run.sessionId || !run.nativeTurnId) throw new APIError(409, '执行证据需要当前原生任务与轮次');
    const command = string(input.command, 'command', 20000);
    const previous = this.loop
      .rows<ExecutionCapture>('loop_executions', scope.projectId)
      .find(
        (row) => row.runId === scope.runId && row.command === command && ['prepared', 'running'].includes(row.status)
      );
    if (previous) return previous;
    const row: ExecutionCapture = {
      id: randomUUID(),
      projectId: scope.projectId,
      channelId: scope.channelId,
      runId: scope.runId,
      threadId: run.sessionId,
      turnId: run.nativeTurnId,
      command,
      cwd: projectRoot,
      version: sourceVersion(project.path),
      status: 'prepared',
      createdAt: now(),
      nativeCursor: Number(
        (this.loop.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM native_items').get() as any).n
      ),
    };
    this.write(row);
    return row;
  }
  observing(threadId: string) {
    return this.openCaptures(threadId).length > 0;
  }
  observe(threadId: string, items: NativeItem[]) {
    const pending = this.openCaptures(threadId);
    if (!pending.length) return;
    for (const record of pending) {
      // Read once per capture rather than once per item: inside this loop only its own writes
      // change the row, and a streaming command brings hundreds of items past it.
      let row = this.loop.store.get<ExecutionCapture>('loop_executions', record.id)!;
      for (const item of items) {
        if (
          !['prepared', 'running'].includes(row.status) ||
          item.type !== 'commandExecution' ||
          item.turnId !== row.turnId ||
          (item.raw.command !== row.command && executionCommand(item.raw) !== row.command)
        )
          continue;
        if (row.nativeItemId && row.nativeItemId !== item.id) continue;
        const position = this.loop.store.db.prepare('SELECT rowid AS n FROM native_items WHERE id=?').get(item.id) as
          { n: number } | undefined;
        if (!position || position.n <= row.nativeCursor) continue;
        const raw = item.raw;
        const ended =
          typeof raw.status === 'string' && ['completed', 'failed', 'declined', 'interrupted'].includes(raw.status);
        let error = row.error;
        try {
          if (typeof raw.cwd !== 'string') throw new Error('原生命令目录缺失');
          if (realpathSync(raw.cwd) !== row.cwd) error = '原生命令目录与项目不同';
          // The seal reads every source file, so it is taken at exactly the two deltas that matter
          // per capture — the one that starts the command, while the row is still `prepared`, and
          // the one that ends it — and never on the hundreds of streaming deltas in between.
          if ((row.status === 'prepared' || ended) && sourceVersion(row.cwd).digest !== row.version.digest)
            error = '准备后或执行期间源文件发生变化';
        } catch {
          error = '无法核对命令目录或源版本';
        }
        if (!ended) {
          if (row.status === 'prepared')
            row = this.write({
              ...row,
              status: 'running',
              nativeItemId: item.id,
              startedAt: now(),
              ...(error ? { error } : {}),
            });
          continue;
        }
        const output = typeof raw.aggregatedOutput === 'string' ? raw.aggregatedOutput : '';
        // Native completed commands use explicit null for empty output. An absent
        // field still means output was not supplied; captured history is immutable.
        const outputComplete =
          (typeof raw.aggregatedOutput === 'string' || raw.aggregatedOutput === null) &&
          !raw.outputTruncated &&
          !raw.truncated &&
          !/output (?:was )?truncated|tokens truncated/i.test(output) &&
          Buffer.byteLength(output) <= 4 * 1024 * 1024;
        if (!row.startedAt) error = '未观察到原生命令开始，不能事后补写执行版本';
        const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : null;
        const data = {
          command: row.command,
          nativeCommand: raw.command,
          cwd: row.cwd,
          exitCode,
          status: raw.status,
          output: Buffer.from(output)
            .subarray(0, 4 * 1024 * 1024)
            .toString('utf8'),
          outputComplete,
          sourceVersion: row.version,
          boundVersion: !error,
          threadId,
          turnId: row.turnId,
          nativeItemId: item.id,
          ...(error ? { error } : {}),
        };
        const time = now();
        const evidence: Evidence = {
          id: randomUUID(),
          projectId: row.projectId,
          channelId: row.channelId,
          runId: row.runId,
          summary: `原生命令 · ${exitCode === null ? '退出结果未知' : `退出码 ${exitCode}`} · ${row.command.slice(0, 160)}`,
          source: row.command,
          origin: 'execution',
          observedAt: time,
          createdAt: time,
          data,
          digest: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
        };
        this.loop.store.put('loop_evidence', evidence);
        const captured = this.write({
          ...row,
          status: 'captured',
          nativeItemId: item.id,
          evidenceId: evidence.id,
          ...(error ? { error } : {}),
        });
        this.loop.strategy.evidenceObserved(evidence);
        this.loop.audit(
          row,
          'execution.captured',
          evidence.summary,
          undefined,
          { evidenceId: evidence.id, boundVersion: !error },
          'system'
        );
        row = captured;
      }
    }
  }
  read(scope: Scope, input: Record<string, unknown>) {
    keys(input, ['id']);
    this.loop.scope(scope);
    const row = this.loop.store.get<ExecutionCapture>('loop_executions', string(input.id, 'id', 200));
    if (row?.projectId !== scope.projectId) throw new APIError(404, '执行记录不属于当前项目');
    return { ...row, evidence: row.evidenceId ? this.loop.store.get('loop_evidence', row.evidenceId) : undefined };
  }
  recover() {
    for (const row of this.loop.store.byStatus<ExecutionCapture>('loop_executions', ['prepared', 'running']))
      this.write({
        ...row,
        status: 'unknown',
        error: '服务重启，执行期间源版本无法完整核验；请重新准备并执行',
      });
  }
}
