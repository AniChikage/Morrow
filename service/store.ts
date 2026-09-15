import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appResumeSummary } from './protocol.ts';
import type {
  AppResumeRecord,
  Channel,
  Control,
  Event,
  EventDetail,
  Knowledge,
  Project,
  Run,
  RunIO,
  Runtime,
  WorkItem,
} from './protocol.ts';
export const now = () => new Date().toISOString();
/** A Morrow-orchestrated turn, as opposed to native chat or a turn the App itself started. */
const scheduledSource =
  "(json_extract(data,'$.source') IS NULL OR json_extract(data,'$.source') IN ('morrow-schedule','nohuman-schedule'))";
/** One stored row, the shape every table has: the primary key and the JSON document in `data`. */
export type Row = { id: string; data: string };
/**
 * The part of a `native_threads` row this file itself reads: its id, the projection hash naming the
 * owner and revision it was taken at, and the hash of the `native_thread_state` row holding the
 * conversation state. A row written before the split has no `stateHash` and carries its own state.
 */
type ThreadHeader = { id: string; hash?: string; stateHash?: string };
/** The parsed documents of the rows one `SELECT data …` returned. */
export const parseRows = <T>(rows: unknown[]): T[] =>
  (rows as Pick<Row, 'data'>[]).map((row) => JSON.parse(row.data) as T);
/** The parsed document of the row one `SELECT data …` returned, or undefined when there was none. */
export const parseRow = <T>(row: unknown): T | undefined =>
  row ? (JSON.parse((row as Pick<Row, 'data'>).data) as T) : undefined;
/** The one number one `SELECT COUNT(…) AS n` or `SELECT …(…) AS n` returned. */
const scalar = (row: unknown) => Number((row as { n: number }).n);
/**
 * Every table in `workspace.sqlite`, in creation order. One list: the constructor creates exactly
 * these, `table()` accepts exactly these as an interpolated table name, and nothing else reaches
 * SQL. Adding a table here is all it takes; removing one needs a migration, because the rows stay.
 */
export const TABLES = [
  'projects',
  'channels',
  'items',
  'runs',
  'events',
  'knowledge',
  'results',
  'controls',
  'run_io',
  'run_io_pending',
  'migrations',
  'loop_grants',
  'loop_calls',
  'loop_evidence',
  'loop_learning',
  'loop_watches',
  'loop_waits',
  'loop_releases',
  'strategy_understanding',
  'strategy_decisions',
  'strategy_revisions',
  'strategy_runs',
  'strategy_signals',
  'loop_executions',
  'loop_verifications',
  'loop_verification_events',
  'loop_finalizations',
  'native_bindings',
  'native_threads',
  'native_thread_state',
  'native_items',
  'native_events',
  'native_requests',
  'native_outbox',
  'native_turns',
  'native_attachments',
  'project_brief_revisions',
  'usage_samples',
  'settings',
  'upgrades',
  'channel_intents',
  'app_resumes',
] as const;
/** The tables holding project-scoped rows, which get an index on `$.projectId`. A subset of `TABLES`. */
export const PROJECT_TABLES = [
  'loop_evidence',
  'loop_learning',
  'loop_watches',
  'loop_releases',
  'strategy_understanding',
  'strategy_decisions',
  'strategy_revisions',
  'strategy_runs',
  'strategy_signals',
  'loop_executions',
  'loop_verifications',
  'loop_verification_events',
  'loop_finalizations',
  'project_brief_revisions',
  'usage_samples',
] as const;
export class Store {
  db: DatabaseSync;
  transactionDepth = 0;
  /**
   * The next sequence number for a run's output chunks, and for a run's events in one channel.
   * Both used to be counted in SQL before every single append, so writing n chunks read O(n²)
   * rows; a long native turn writes thousands. The number is taken from storage once per key and
   * then kept here, which is sound because one daemon owns a data directory at a time.
   *
   * Bounded like a cache — the least recently used key goes rather than growing without end, and a
   * dropped key costs one indexed read. A rolled-back transaction drops every key, so a number
   * that was never committed is counted again instead of leaving a hole.
   */
  ioSequence = new Map<string, number>();
  eventSequence = new Map<string, number>();
  sequenceLimit = 256;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    // In WAL mode a commit is durable once the write-ahead log has it, so `NORMAL` only gives up
    // the fsync per commit, never a committed row; `journal_size_limit` truncates the log back to
    // 32 MiB after a checkpoint instead of leaving a large one behind for the rest of the run.
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=33554432;'
    );
    for (const table of TABLES)
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS events_channel ON events(json_extract(data,'$.channelId')); CREATE INDEX IF NOT EXISTS events_run ON events(json_extract(data,'$.runId')); CREATE INDEX IF NOT EXISTS runs_channel ON runs(json_extract(data,'$.channelId')); CREATE INDEX IF NOT EXISTS knowledge_project ON knowledge(json_extract(data,'$.projectId'));"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS items_project ON items(json_extract(data,'$.projectId')); CREATE INDEX IF NOT EXISTS events_project ON events(json_extract(data,'$.projectId')); CREATE INDEX IF NOT EXISTS events_item ON events(json_extract(data,'$.itemId')); CREATE INDEX IF NOT EXISTS runs_project ON runs(json_extract(data,'$.projectId')); CREATE INDEX IF NOT EXISTS run_io_run ON run_io(json_extract(data,'$.runId'));"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS native_items_thread ON native_items(json_extract(data,'$.threadId')); CREATE INDEX IF NOT EXISTS native_outbox_thread ON native_outbox(json_extract(data,'$.threadId')); CREATE INDEX IF NOT EXISTS native_turns_thread ON native_turns(json_extract(data,'$.threadId')); CREATE INDEX IF NOT EXISTS loop_executions_thread ON loop_executions(json_extract(data,'$.threadId'));"
    );
    // Ingest reads one task's bindings and resolves its requests on every projection, and the
    // resolved requests of every task are swept by age at start-up.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS native_bindings_thread ON native_bindings(json_extract(data,'$.threadId')); CREATE INDEX IF NOT EXISTS native_requests_thread ON native_requests(json_extract(data,'$.threadId')); CREATE INDEX IF NOT EXISTS native_requests_resolved ON native_requests(json_extract(data,'$.resolvedAt'));"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS app_resumes_channel ON app_resumes(json_extract(data,'$.channelId')); CREATE INDEX IF NOT EXISTS app_resumes_thread ON app_resumes(json_extract(data,'$.threadId')); CREATE INDEX IF NOT EXISTS runs_native_turn ON runs(json_extract(data,'$.nativeTurnId'));"
    );
    this.migrate(dirname(path));
    for (const table of PROJECT_TABLES)
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_project ON ${table}(json_extract(data,'$.projectId'))`);
    // Built after `migrate` pruned the journal, not before: the only reader walks one thread's rows
    // forward from its checkpoint revision, and indexing a pruned table is far cheaper.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS native_events_thread_revision ON native_events(json_extract(data,'$.threadId'), CAST(json_extract(data,'$.revision') AS INTEGER))"
    );
    // The scheduler ticks once a second and asks each of these tables for the few rows in a state
    // that needs work; without these it read every row of every one of them, every second. An
    // execution capture is asked for far more often still — once per native IPC delta.
    for (const [table, column] of [
      ['controls', 'enabled'],
      ['loop_releases', 'status'],
      ['loop_verifications', 'status'],
      ['loop_verifications', 'interruptPending'],
      ['loop_finalizations', 'status'],
      ['loop_executions', 'status'],
      ['native_outbox', 'state'],
      ['upgrades', 'phase'],
    ] as const)
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS ${table}_${column.toLowerCase()} ON ${table}(json_extract(data,'$.${column}'))`
      );
    this.pruneNativeRequests();
  }
  /**
   * One-time backfills of rows written before a field existed. Each records its own marker, so a
   * start-up never reads a whole table again once its pass is done; deleting a marker replays it.
   */
  migrate(home: string) {
    // Projects written before the brief existed keep an empty brief at revision 0.
    if (!this.get('migrations', 'project-runtime-brief-v1'))
      this.transaction(() => {
        for (const p of this.all<Project>('projects'))
          if (!p.runtime || p.briefRevision === undefined)
            this.put('projects', {
              ...p,
              runtime: p.runtime || this.all<Channel>('channels').find((c) => c.projectId === p.id)?.runtime || 'codex',
              briefRevision: p.briefRevision ?? 0,
            });
        this.put('migrations', { id: 'project-runtime-brief-v1', createdAt: now() });
      });
    if (!this.get('migrations', 'item-number-v1'))
      this.transaction(() => {
        const numbers = new Map<string, number>();
        for (const item of this.all<WorkItem>('items')) {
          const projectId = item.projectId || this.get<Channel>('channels', item.channelId)?.projectId || '';
          if (item.number) numbers.set(projectId, Math.max(item.number, numbers.get(projectId) || 0));
        }
        for (const item of this.all<WorkItem>('items')) {
          const projectId = item.projectId || this.get<Channel>('channels', item.channelId)?.projectId || '';
          const number = item.number || (numbers.get(projectId) || 0) + 1;
          numbers.set(projectId, Math.max(number, numbers.get(projectId) || 0));
          const migrated = {
            ...item,
            projectId,
            number,
            sourceChannelIds: item.sourceChannelIds || (item.channelId ? [item.channelId] : []),
            lastRunId: item.lastRunId || '',
            revision: item.revision || 1,
          };
          if (JSON.stringify(migrated) !== JSON.stringify(item)) this.put('items', migrated);
        }
        this.put('migrations', { id: 'item-number-v1', createdAt: now() });
      });
    if (!this.get('migrations', 'run-project-report-v1'))
      this.transaction(() => {
        for (const run of this.all<Run>('runs')) {
          const channel = this.get<Channel>('channels', run.channelId);
          const migrated = {
            ...run,
            projectId: run.projectId || channel?.projectId || '',
            resumedFromSessionId: run.resumedFromSessionId || '',
            reportStatus:
              run.reportStatus ||
              (this.get('results', run.id) ? 'valid' : run.status === 'running' ? 'pending' : 'missing'),
            reportError: run.reportError || '',
          };
          if (JSON.stringify(migrated) !== JSON.stringify(run)) this.put('runs', migrated);
        }
        this.put('migrations', { id: 'run-project-report-v1', createdAt: now() });
      });
    // One statement instead of reading every event row: an event written before the column existed
    // takes its own channel's project, or '' when that channel is gone. `json_type(...) IS NULL`
    // matches only a missing key, the way the previous `=== undefined` check did.
    if (!this.get('migrations', 'event-project-v1'))
      this.transaction(() => {
        this.db.exec(
          "UPDATE events SET data=json_set(data,'$.projectId',COALESCE((SELECT json_extract(c.data,'$.projectId') FROM channels c WHERE c.id=json_extract(events.data,'$.channelId')),'')) WHERE json_type(data,'$.projectId') IS NULL"
        );
        this.put('migrations', { id: 'event-project-v1', createdAt: now() });
      });
    // The conversation state of a native task moved off its `native_threads` row into
    // `native_thread_state` (see `putNativeThread`). Existing rows are split once, one row and one
    // transaction at a time so a data directory with several large tasks never builds a single
    // enormous one; a row that already carries no state of its own is left alone, so the pass is
    // idempotent and deleting the marker replays only what is still unsplit. On a large database
    // this is the one slow part of the first start after this build (see docs/UPGRADING.md).
    if (!this.get('migrations', 'native-thread-state-v1')) {
      const startedAt = Date.now();
      const ids = this.db
        .prepare('SELECT id FROM native_threads ORDER BY rowid')
        .all()
        .map((row) => String((row as { id: string }).id));
      let split = 0;
      for (const id of ids) {
        const row = parseRow<{ id: string; state?: unknown }>(
          this.db.prepare('SELECT data FROM native_threads WHERE id=?').get(id)
        );
        if (!row || row.state === undefined) continue;
        this.putNativeThread(row);
        split += 1;
      }
      this.put('migrations', {
        id: 'native-thread-state-v1',
        createdAt: now(),
        threads: ids.length,
        split,
        durationMs: Date.now() - startedAt,
      });
    }
    this.pruneNativeEvents();
    // Who opened an item is now stored on the row. Older rows are read once from their own
    // `item.created` audit event; an item with no such event keeps the agent default.
    if (!this.get('migrations', 'item-origin-v1')) {
      const actors = new Map<string, string>(
        this.db
          .prepare(
            "SELECT json_extract(data,'$.itemId') AS itemId, json_extract(data,'$.actor') AS actor FROM events WHERE json_extract(data,'$.action')='item.created'"
          )
          .all()
          .map((row) => [String(row.itemId), String(row.actor)] as const)
      );
      this.transaction(() => {
        for (const item of this.all<WorkItem>('items'))
          if (!item.origin) this.put('items', { ...item, origin: actors.get(item.id) === 'human' ? 'human' : 'agent' });
        this.put('migrations', { id: 'item-origin-v1', createdAt: now() });
      });
    }
    // Existing private artifacts remain authoritative historical copies; mirror
    // them once without inventing chunk boundaries or missing old metadata.
    if (!this.get('migrations', 'run-io-v1')) {
      for (const run of this.all<Run>('runs')) {
        if (!/^[a-f0-9-]{36}$/i.test(run.id)) continue;
        const importing = this.get('migrations', `run-io-import:${run.id}`);
        if (this.ioPage(run.id, undefined, 1).chunks.length && !importing) continue;
        this.put('migrations', { id: `run-io-import:${run.id}`, createdAt: now() });
        let bytes = 0;
        for (const [file, stream] of [
          ['prompt.txt', 'prompt'],
          ['stdout.jsonl', 'stdout'],
          ['stderr.log', 'stderr'],
          ['last-message.json', 'final'],
          ['result.json', 'report'],
        ] as const) {
          try {
            const path = join(home, 'runs', run.id, file);
            const size = statSync(path).size;
            if (bytes + size > 24 * 1024 * 1024) continue;
            bytes += size;
            const marker = `run-io-import:${run.id}:${file}`;
            if (this.get('migrations', marker)) continue;
            let text = readFileSync(path, 'utf8');
            try {
              const token = readFileSync(join(home, 'token'), 'utf8').trim();
              if (/^[a-f0-9]{64}$/.test(token)) text = text.replaceAll(token, '[REDACTED]');
            } catch {}
            this.transaction(() => {
              for (let offset = 0; offset < text.length; offset += 32768)
                this.io(run.id, stream, text.slice(offset, offset + 32768));
              this.put('migrations', { id: marker, createdAt: now() });
            });
          } catch {}
        }
      }
      this.put('migrations', { id: 'run-io-v1', createdAt: now() });
    }
    // Every channel gets its durable user-intent counter, so a later "nobody paused since" check
    // reads storage rather than an in-memory counter that a restart forgets. Existing channels start
    // at generation 0. Turns recorded before the intent snapshot existed keep no snapshot, and no
    // continuation record is created for historical interruptions: paused channels stay paused.
    if (!this.get('migrations', 'app-resume-v1')) {
      const time = now();
      this.transaction(() => {
        for (const channel of this.all<Channel>('channels'))
          if (!this.get('channel_intents', channel.id))
            this.put('channel_intents', {
              id: channel.id,
              projectId: channel.projectId,
              generation: 0,
              createdAt: time,
              updatedAt: time,
            });
        this.put('migrations', { id: 'app-resume-v1', createdAt: time });
      });
    }
  }
  /**
   * The native IPC journal is read in exactly one place: checkpoint recovery walks one thread's
   * `native.patch` rows forward from the revision its `native_threads` checkpoint already covers.
   * Everything else in the table can never be read again — rows at or below that checkpoint, rows
   * left by a different owning client, and the projection rows that were written without a `kind`
   * and never had a reader at all. Rows of a thread with no checkpoint row are left untouched.
   *
   * Both halves are shaped around one row being huge — hundreds of KiB of conversation state, and
   * 8 GiB across a dogfood journal. The pass that decides asks for all four small fields in a single
   * `json_extract`, because every extra call over `data` parses the whole document again. The rows
   * that go are then removed by one unqualified DELETE, which frees the b-tree in bulk (three
   * seconds) instead of walking every overflow page row by row (minutes): the survivors are copied
   * aside by rowid first and put back after, inside one transaction, and they are only what no
   * checkpoint has covered yet — normally a handful.
   *
   * Deleting never shrinks the file; `scripts/compact-db.sh` reclaims the space while the daemon is
   * stopped. The index over what survives is built afterwards, by the constructor.
   */
  pruneNativeEvents() {
    if (this.get('migrations', 'native-events-prune-v1')) return 0;
    const startedAt = Date.now();
    const checkpoints = new Map<string, { owner: string; revision: number }>(
      this.db
        .prepare(
          "SELECT id, json_extract(data,'$.ownerClientId') AS owner, CAST(json_extract(data,'$.revision') AS INTEGER) AS revision FROM native_threads"
        )
        .all()
        .map(
          (row) => [String(row.id), { owner: String(row.owner ?? ''), revision: Number(row.revision ?? 0) }] as const
        )
    );
    const keep: number[] = [];
    let total = 0;
    for (const row of this.db
      .prepare(
        "SELECT rowid AS rid, json_extract(data,'$.kind','$.threadId','$.ownerClientId','$.revision') AS fields FROM native_events ORDER BY rowid"
      )
      .iterate() as Iterable<{ rid: number; fields: string }>) {
      total += 1;
      const [kind, threadId, owner, revision] = JSON.parse(row.fields) as [unknown, string, string, unknown];
      const checkpoint = checkpoints.get(String(threadId));
      const dead =
        kind === null || (!!checkpoint && (checkpoint.owner !== owner || Number(revision) <= checkpoint.revision));
      if (!dead) keep.push(Number(row.rid));
    }
    const removed = total - keep.length;
    if (removed) {
      // A previous attempt that died before its own cleanup leaves this behind; it is never read.
      this.db.exec('DROP TABLE IF EXISTS native_events_keep');
      this.transaction(() => {
        this.db.exec('CREATE TABLE native_events_keep (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
        const copy = this.db.prepare(
          'INSERT INTO native_events_keep (id,data) SELECT id,data FROM native_events WHERE rowid=?'
        );
        for (const rid of keep) copy.run(rid);
        this.db.exec('DELETE FROM native_events');
        this.db.exec('INSERT INTO native_events (id,data) SELECT id,data FROM native_events_keep ORDER BY rowid');
      });
      this.db.exec('DROP TABLE native_events_keep');
    }
    this.put('migrations', {
      id: 'native-events-prune-v1',
      createdAt: now(),
      removed,
      durationMs: Date.now() - startedAt,
    });
    return removed;
  }
  /**
   * A native approval request is answered inside the turn that raised it; a resolved row is then
   * kept only so the interface can explain what happened, which stops being worth anything long
   * before the row stops costing anything. Rows resolved more than 30 days ago therefore go at
   * every start-up, chosen through `native_requests_resolved` rather than by reading the table.
   *
   * `resolvedAt` exists only on rows that left `pending`, so a live request is never matched. The
   * rows written before that field existed are stamped once, under their own marker, so they age
   * from this upgrade instead of disappearing the moment it lands; deleting the marker replays it.
   */
  pruneNativeRequests(): number {
    if (!this.get('migrations', 'native-requests-resolved-at-v1')) {
      const at = now();
      this.transaction(() => {
        this.db
          .prepare(
            "UPDATE native_requests SET data=json_set(data,'$.resolvedAt',?) WHERE json_extract(data,'$.status')<>'pending' AND json_type(data,'$.resolvedAt') IS NULL"
          )
          .run(at);
        this.put('migrations', { id: 'native-requests-resolved-at-v1', createdAt: at });
      });
    }
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return Number(
      this.db.prepare("DELETE FROM native_requests WHERE json_extract(data,'$.resolvedAt')<?").run(cutoff).changes
    );
  }
  projectItems(projectId: string): WorkItem[] {
    return this.all<WorkItem>('items').filter((item) => item.projectId === projectId);
  }
  nativeRows<T = any>(
    table: 'native_items' | 'native_outbox' | 'native_turns' | 'native_bindings',
    threadId: string
  ): T[] {
    return parseRows<T>(
      this.db
        .prepare(`SELECT data FROM ${this.table(table)} WHERE json_extract(data,'$.threadId')=? ORDER BY rowid`)
        .all(threadId)
    );
  }
  /**
   * The channel bindings of one native task. Ingest asked for these by reading and parsing every
   * binding row, several times per projection, where a projection can arrive four times a second.
   */
  bindingsForThread<T = any>(threadId: string): T[] {
    return this.nativeRows<T>('native_bindings', threadId);
  }
  nextItemNumber(projectId: string): number {
    return Math.max(0, ...this.projectItems(projectId).map((item) => item.number || 0)) + 1;
  }
  all<T = any>(table: string): T[] {
    const rows = parseRows<T>(this.db.prepare(`SELECT data FROM ${this.table(table)} ORDER BY rowid`).all());
    return table === 'native_threads' ? rows.map((row) => this.withThreadState(row as ThreadHeader) as T) : rows;
  }
  /**
   * The rows of one table whose state needs attention, chosen by an index instead of by reading and
   * parsing the whole table. The scheduler asks once a second, so nothing here may be a full scan.
   */
  byStatus<T = any>(table: string, states: string[], column: 'status' | 'phase' | 'state' = 'status'): T[] {
    return parseRows<T>(
      this.db
        .prepare(
          `SELECT data FROM ${this.table(table)} WHERE json_extract(data,'$.${column}') IN (${states.map(() => '?').join(',')}) ORDER BY rowid`
        )
        .all(...states)
    );
  }
  /**
   * Channels whose autonomy control is on. A scheduler tick can only act on these — both the legacy
   * runtime shutdown and the due-run start require an enabled control — so the others never have to
   * be read, and a paused project costs the tick nothing.
   */
  enabledChannels(): Channel[] {
    return parseRows<Channel>(
      this.db
        .prepare(
          "SELECT channels.data AS data FROM controls JOIN channels ON channels.id=controls.id WHERE json_extract(controls.data,'$.enabled')=1 ORDER BY channels.rowid"
        )
        .all()
    );
  }
  recent<T = any>(table: string, limit: number): T[] {
    return parseRows<T>(
      this.db.prepare(`SELECT data FROM ${this.table(table)} ORDER BY rowid DESC LIMIT ?`).all(limit)
    ).reverse();
  }
  messages(channelId: string, limit = 100): Event[] {
    return parseRows<Event>(
      this.db
        .prepare(
          "SELECT data FROM events WHERE json_extract(data,'$.channelId')=? AND json_extract(data,'$.kind')='message' ORDER BY rowid DESC LIMIT ?"
        )
        .all(channelId, limit)
    ).reverse();
  }
  channelRuns(channelId: string, limit = 8): Run[] {
    return parseRows<Run>(
      this.db
        .prepare("SELECT data FROM runs WHERE json_extract(data,'$.channelId')=? ORDER BY rowid DESC LIMIT ?")
        .all(channelId, limit)
    ).reverse();
  }
  /**
   * The latest Morrow-orchestrated turn matching the filter, selected in SQL instead of by filtering
   * a page of recent runs: native chat and App-owned turns share this table, so any fixed page can
   * push the scheduled turn a guard depends on out of sight. `withTreeState` keeps only the finalized
   * turns that recorded the working tree, `exceptId` skips the caller's own run.
   */
  latestScheduledRun(filter: {
    projectId?: string;
    channelId?: string;
    exceptId?: string;
    withTreeState?: boolean;
  }): Run | undefined {
    const conditions = [scheduledSource];
    const values: string[] = [];
    for (const key of ['projectId', 'channelId'] as const)
      if (filter[key]) {
        conditions.push(`json_extract(data,'$.${key}')=?`);
        values.push(filter[key]!);
      }
    if (filter.exceptId) {
      conditions.push('id<>?');
      values.push(filter.exceptId);
    }
    if (filter.withTreeState) conditions.push("json_type(data,'$.treeState')='object'");
    return parseRow<Run>(
      this.db
        .prepare(`SELECT data FROM runs WHERE ${conditions.join(' AND ')} ORDER BY rowid DESC LIMIT 1`)
        .get(...values)
    );
  }
  runCount(channelId: string, day: string): number {
    return (
      scalar(
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM runs WHERE json_extract(data,'$.channelId')=? AND substr(json_extract(data,'$.startedAt'),1,10)=? AND ${scheduledSource}`
          )
          .get(channelId, day)
      ) +
      scalar(
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM loop_verifications WHERE json_extract(data,'$.channelId')=? AND substr(json_extract(data,'$.startedAt'),1,10)=?"
          )
          .get(channelId, day)
      )
    );
  }
  contextKnowledge(projectId: string, channelId: string): Knowledge[] {
    return parseRows<Knowledge>(
      this.db
        .prepare(
          "SELECT data FROM knowledge WHERE json_extract(data,'$.projectId')=? AND (json_extract(data,'$.confirmed')=1 OR json_extract(data,'$.channelId')=?) ORDER BY rowid DESC LIMIT 150"
        )
        .all(projectId, channelId)
    ).reverse();
  }
  get<T = any>(table: string, id: string): T | undefined {
    const row = parseRow<T>(this.db.prepare(`SELECT data FROM ${this.table(table)} WHERE id=?`).get(id));
    return row && table === 'native_threads' ? (this.withThreadState(row as unknown as ThreadHeader) as T) : row;
  }
  put<T extends { id: string }>(table: string, row: T): T {
    if (table === 'native_threads') return this.putNativeThread(row);
    this.write(table, row.id, JSON.stringify(row));
    return row;
  }
  /** One row written from text that is already JSON, so a large document is serialized only once. */
  write(table: string, id: string, data: string) {
    this.db
      .prepare(
        `INSERT INTO ${this.table(table)} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`
      )
      .run(id, data);
  }
  /**
   * One native task's checkpoint, written as a small header plus the conversation state behind it.
   *
   * The state used to live on the `native_threads` row itself, so every checkpoint rewrote all of
   * it — 43 MB on the author's own database, at most every 30 s for as long as a turn streams, and
   * again on every re-read of an idle task. The header — ids, owner, revision, hashes, projection
   * version and the summary the interface reads — is a few hundred bytes and is still rewritten
   * every time; `native_thread_state` holds the state and is written only when the state there is
   * not already the right one. Two cases are therefore skipped rather than repeated: a checkpoint at
   * a revision the stored state already covers, which is what a re-read of an idle task produces
   * (a new `syncedAt` and nothing else), and a reprojection that produced the same bytes.
   *
   * `stateHash` on the header names the state row it belongs to, so deciding reads the small row
   * rather than parsing the large one, and both halves are written in one transaction so a header
   * can never name a state that is not there. `get`/`all` put them back together, so every reader
   * of `native_threads` still sees the whole snapshot.
   */
  putNativeThread<T extends { id: string }>(row: T): T {
    const { state, ...header } = row as T & { state?: unknown; hash?: string };
    const stored = parseRow<ThreadHeader>(this.db.prepare('SELECT data FROM native_threads WHERE id=?').get(row.id));
    const present = !!this.db.prepare('SELECT 1 AS n FROM native_thread_state WHERE id=?').get(row.id);
    return this.transaction(() => {
      if (state === undefined) {
        // A caller replacing the row without a state replaces both of its halves.
        if (present) this.db.prepare('DELETE FROM native_thread_state WHERE id=?').run(row.id);
        this.write('native_threads', row.id, JSON.stringify(header));
        return row;
      }
      // The projection hash is the owner and revision this state came from, so an equal one is the
      // same state and the large document is never serialized again to find that out.
      if (present && stored?.stateHash && stored.hash && (row as { hash?: string }).hash === stored.hash) {
        this.write('native_threads', row.id, JSON.stringify({ ...header, stateHash: stored.stateHash }));
        return row;
      }
      const text = JSON.stringify(state);
      const stateHash = createHash('sha256').update(text).digest('hex');
      if (!present || stateHash !== stored?.stateHash)
        this.write(
          'native_thread_state',
          row.id,
          `{"id":${JSON.stringify(row.id)},"hash":"${stateHash}","updatedAt":${JSON.stringify(now())},"state":${text}}`
        );
      this.write('native_threads', row.id, JSON.stringify({ ...header, stateHash }));
      return row;
    });
  }
  /** A `native_threads` header with the conversation state behind it put back onto it. */
  withThreadState<T extends ThreadHeader>(header: T): T {
    if (!header.stateHash) return header;
    const row = parseRow<{ state: unknown }>(
      this.db.prepare('SELECT data FROM native_thread_state WHERE id=?').get(header.id)
    );
    return row ? { ...header, state: row.state } : header;
  }
  table(t: string) {
    if (!(TABLES as readonly string[]).includes(t)) throw new Error('Unknown table');
    return t;
  }
  /** The next number for `key`, read from storage the first time and counted in memory after. */
  nextSequence(counters: Map<string, number>, key: string, stored: () => number): number {
    const next = counters.get(key) ?? stored() + 1;
    counters.delete(key);
    if (counters.size >= this.sequenceLimit) counters.delete(counters.keys().next().value!);
    counters.set(key, next + 1);
    return next;
  }
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++;
    const savepoint = `nested_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
      return r;
    } catch (e) {
      this.db.exec(depth ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      if (depth) this.db.exec(`RELEASE ${savepoint}`);
      // Whatever this transaction numbered is gone; count from storage again rather than skip it.
      this.ioSequence.clear();
      this.eventSequence.clear();
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  event(
    channelId: string,
    runId: string,
    kind: string,
    text: string,
    detail?: EventDetail,
    metadata: Partial<Pick<Event, 'projectId' | 'itemId' | 'actor' | 'action' | 'changes'>> = {}
  ): Event {
    // This event's 1-based ordinal among the run's events in this channel, which is what a detail
    // row carries so that equal timestamps still order. Counted for every event, stored only on
    // the ones that have a detail, exactly as counting the rows again each time used to.
    const sequence = this.nextSequence(this.eventSequence, `${runId}\0${channelId}`, () =>
      scalar(
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.channelId')=?"
          )
          .get(runId, channelId)
      )
    );
    return this.put('events', {
      id: randomUUID(),
      projectId: metadata.projectId || this.get<Channel>('channels', channelId)?.projectId || '',
      channelId,
      runId,
      kind,
      text,
      createdAt: now(),
      ...(detail ? { detail: { ...detail, sequence } } : {}),
      ...metadata,
    });
  }
  eventPage(query: {
    projectId?: string;
    channelId?: string;
    itemId?: string;
    runId?: string;
    before?: string;
    after?: string;
    limit: number;
  }): { events: Event[]; hasMore: boolean; cursor?: string } {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    for (const key of ['projectId', 'channelId', 'itemId'] as const)
      if (query[key]) {
        conditions.push(`json_extract(data,'$.${key}')=?`);
        values.push(query[key]!);
      }
    if (query.runId) {
      conditions.push("json_extract(data,'$.runId')=?");
      values.push(query.runId);
    }
    const anchor = query.before || query.after;
    if (anchor) {
      conditions.push(`rowid ${query.after ? '>' : '<'} (SELECT rowid FROM events WHERE id=?)`);
      values.push(anchor);
    }
    const rows = this.db
      .prepare(
        `SELECT data FROM events WHERE ${conditions.join(' AND ')} ORDER BY rowid ${query.after ? 'ASC' : 'DESC'} LIMIT ?`
      )
      .all(...values, query.limit + 1) as { data: string }[];
    const hasMore = rows.length > query.limit;
    const events = rows.slice(0, query.limit).map((row) => JSON.parse(row.data) as Event);
    if (!query.after) events.reverse();
    const cursor = query.after ? events.at(-1)?.id : events[0]?.id;
    return { events, hasMore, ...(cursor ? { cursor } : {}) };
  }
  runPage(query: { projectId?: string; channelId?: string; before?: string; after?: string; limit: number }) {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    for (const key of ['projectId', 'channelId'] as const)
      if (query[key]) {
        conditions.push(`json_extract(data,'$.${key}')=?`);
        values.push(query[key]!);
      }
    const anchor = query.before || query.after;
    if (anchor) {
      conditions.push(`rowid ${query.after ? '>' : '<'} (SELECT rowid FROM runs WHERE id=?)`);
      values.push(anchor);
    }
    const rows = this.db
      .prepare(
        `SELECT data FROM runs ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY rowid ${query.after ? 'ASC' : 'DESC'} LIMIT ?`
      )
      .all(...values, query.limit + 1) as { data: string }[];
    const runs = rows.slice(0, query.limit).map((row) => JSON.parse(row.data) as Run);
    if (!query.after) runs.reverse();
    const cursor = query.after ? runs.at(-1)?.id : runs[0]?.id;
    return { runs, hasMore: rows.length > query.limit, ...(cursor ? { cursor } : {}) };
  }
  io(runId: string, stream: RunIO['stream'], text: string): RunIO {
    const sequence = this.nextSequence(this.ioSequence, runId, () =>
      scalar(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(CAST(json_extract(data,'$.sequence') AS INTEGER)),0) AS n FROM run_io WHERE json_extract(data,'$.runId')=?"
          )
          .get(runId)
      )
    );
    return this.put('run_io', { id: randomUUID(), runId, stream, text, createdAt: now(), sequence });
  }
  ioStream(runId: string, stream: RunIO['stream'], text: string, secret: string, final = false): RunIO | undefined {
    // Only finalized public chunks receive cursor IDs. An undecided token prefix
    // is durable in a private row, never published and never moved into old rows.
    const id = `${runId}:${stream}`;
    const previous = this.get<{ id: string; text: string }>('run_io_pending', id)?.text || '';
    const safe = (previous + text).replaceAll(secret, '[REDACTED]');
    let held = 0;
    if (!final)
      for (let length = Math.min(secret.length - 1, safe.length); length > 0; length--) {
        if (safe.endsWith(secret.slice(0, length))) {
          held = length;
          break;
        }
      }
    const ready = held ? safe.slice(0, -held) : safe;
    const pending = held ? safe.slice(-held) : '';
    return this.transaction(() => {
      this.put('run_io_pending', { id, runId, stream, text: pending });
      return ready ? this.io(runId, stream, ready) : undefined;
    });
  }
  ioPage(runId: string, after: string | undefined, limit: number) {
    const rows = this.db
      .prepare(
        `SELECT data FROM run_io WHERE json_extract(data,'$.runId')=? ${after ? 'AND rowid > (SELECT rowid FROM run_io WHERE id=?)' : ''} ORDER BY rowid ASC LIMIT ?`
      )
      .all(...(after ? [runId, after, limit + 1] : [runId, limit + 1])) as { data: string }[];
    const chunks = rows.slice(0, limit).map((row) => JSON.parse(row.data) as RunIO);
    const cursor = chunks.at(-1)?.id;
    return { chunks, hasMore: rows.length > limit, ...(cursor ? { cursor } : {}) };
  }
  runText(runId: string, stream: RunIO['stream']): string {
    return parseRows<RunIO>(
      this.db
        .prepare(
          "SELECT data FROM run_io WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.stream')=? ORDER BY rowid"
        )
        .all(runId, stream)
    )
      .map((row) => row.text)
      .join('');
  }
  snapshot(runtimes: Runtime[]) {
    return {
      // The polled snapshot carries the brief's revision, not its text; GET /api/projects/:id/brief returns the text.
      projects: this.all<Project>('projects').map(({ brief, ...project }) => ({
        ...project,
        briefRevision: project.briefRevision || 0,
      })),
      channels: this.all<Channel>('channels').map((channel) => {
        // One line and one expandable reason per channel; the ids stay in the record itself.
        const resume = parseRow<AppResumeRecord>(
          this.db
            .prepare(
              "SELECT data FROM app_resumes WHERE json_extract(data,'$.channelId')=? ORDER BY rowid DESC LIMIT 1"
            )
            .get(channel.id)
        );
        return {
          ...channel,
          autonomyEnabled: !!this.get<Control>('controls', channel.id)?.enabled,
          ...(resume ? { appResume: appResumeSummary(resume) } : {}),
        };
      }),
      items: this.all<WorkItem>('items'),
      runs: this.recent<Run>('runs', 500),
      events: this.recent<Event>('events', 1500),
      runtimes,
      releases: this.recent('loop_releases', 200),
    };
  }
  close() {
    this.db.close();
  }
}
