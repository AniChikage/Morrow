import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Channel, Event, EventDetail, Project, Run, RunIO, WorkItem } from "./protocol.ts";
export const now = () => new Date().toISOString();
export class Store {
  db: DatabaseSync;
  transactionDepth = 0;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    for (const table of [
      "projects",
      "channels",
      "items",
      "runs",
      "events",
      "knowledge",
      "results",
      "controls",
      "run_io",
      "run_io_pending",
      "migrations",
      "loop_grants", "loop_calls", "loop_evidence", "loop_learning", "loop_watches", "loop_waits", "loop_releases",
      "strategy_understanding", "strategy_decisions", "strategy_revisions", "strategy_runs", "strategy_signals",
      "loop_executions", "loop_verifications", "loop_verification_events", "loop_finalizations",
      "native_bindings", "native_threads", "native_items", "native_events", "native_requests", "native_outbox", "native_turns", "native_attachments",
    ])
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
      );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS events_channel ON events(json_extract(data,'$.channelId')); CREATE INDEX IF NOT EXISTS events_run ON events(json_extract(data,'$.runId')); CREATE INDEX IF NOT EXISTS runs_channel ON runs(json_extract(data,'$.channelId')); CREATE INDEX IF NOT EXISTS knowledge_project ON knowledge(json_extract(data,'$.projectId'));",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS items_project ON items(json_extract(data,'$.projectId')); CREATE INDEX IF NOT EXISTS events_project ON events(json_extract(data,'$.projectId')); CREATE INDEX IF NOT EXISTS events_item ON events(json_extract(data,'$.itemId')); CREATE INDEX IF NOT EXISTS runs_project ON runs(json_extract(data,'$.projectId')); CREATE INDEX IF NOT EXISTS run_io_run ON run_io(json_extract(data,'$.runId'));");
    this.db.exec("CREATE INDEX IF NOT EXISTS native_items_thread ON native_items(json_extract(data,'$.threadId')); CREATE INDEX IF NOT EXISTS native_outbox_thread ON native_outbox(json_extract(data,'$.threadId')); CREATE INDEX IF NOT EXISTS native_turns_thread ON native_turns(json_extract(data,'$.threadId')); ");
    this.migrate(dirname(path));
    for (const table of ['loop_evidence','loop_learning','loop_watches','loop_releases','strategy_understanding','strategy_decisions','strategy_revisions','strategy_runs','strategy_signals','loop_executions','loop_verifications','loop_verification_events','loop_finalizations']) this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_project ON ${table}(json_extract(data,'$.projectId'))`);
  }
  migrate(home: string) {
    this.transaction(() => {
      for (const p of this.all<Project>("projects")) if (!p.runtime) this.put("projects", { ...p, runtime: this.all<Channel>("channels").find(c => c.projectId === p.id)?.runtime || "codex" });
      const numbers = new Map<string, number>();
      for (const item of this.all<WorkItem>('items')) {
        const projectId = item.projectId || this.get<Channel>('channels', item.channelId)?.projectId || '';
        if (item.number) numbers.set(projectId, Math.max(item.number, numbers.get(projectId) || 0));
      }
      for (const item of this.all<WorkItem>("items")) {
        const projectId = item.projectId || this.get<Channel>("channels", item.channelId)?.projectId || "";
        const number = item.number || (numbers.get(projectId) || 0) + 1;
        numbers.set(projectId, Math.max(number, numbers.get(projectId) || 0));
        const migrated = { ...item, projectId, number, sourceChannelIds: item.sourceChannelIds || (item.channelId ? [item.channelId] : []), lastRunId: item.lastRunId || "", revision: item.revision || 1 };
        if (JSON.stringify(migrated) !== JSON.stringify(item)) this.put("items", migrated);
      }
      for (const run of this.all<Run>("runs")) {
        const channel = this.get<Channel>("channels", run.channelId);
        const migrated = { ...run, projectId: run.projectId || channel?.projectId || "", resumedFromSessionId: run.resumedFromSessionId || "", reportStatus: run.reportStatus || (this.get("results", run.id) ? "valid" : run.status === "running" ? "pending" : "missing"), reportError: run.reportError || "" };
        if (JSON.stringify(migrated) !== JSON.stringify(run)) this.put("runs", migrated);
      }
      for (const event of this.all<Event>("events")) if (event.projectId === undefined) this.put("events", { ...event, projectId: this.get<Channel>("channels", event.channelId)?.projectId || "" });
    });
    // Existing private artifacts remain authoritative historical copies; mirror
    // them once without inventing chunk boundaries or missing old metadata.
    if (!this.get("migrations", "run-io-v1")) {
      for (const run of this.all<Run>("runs")) {
        if (!/^[a-f0-9-]{36}$/i.test(run.id)) continue;
        const importing = this.get('migrations', `run-io-import:${run.id}`);
        if (this.ioPage(run.id, undefined, 1).chunks.length && !importing) continue;
        this.put('migrations', {id:`run-io-import:${run.id}`,createdAt:now()});
        let bytes = 0;
        for (const [file, stream] of [["prompt.txt", "prompt"], ["stdout.jsonl", "stdout"], ["stderr.log", "stderr"], ["last-message.json", "final"], ["result.json", "report"]] as const) {
          try {
            const path = join(home, "runs", run.id, file);
            const size = statSync(path).size;
            if (bytes + size > 24 * 1024 * 1024) continue;
            bytes += size;
            const marker = `run-io-import:${run.id}:${file}`;
            if (this.get('migrations',marker)) continue;
            let text = readFileSync(path, "utf8");
            try { const token = readFileSync(join(home,'token'),'utf8').trim(); if (/^[a-f0-9]{64}$/.test(token)) text = text.replaceAll(token,'[REDACTED]'); } catch {}
            this.transaction(() => {
              for (let offset = 0; offset < text.length; offset += 32768) this.io(run.id, stream, text.slice(offset, offset + 32768));
              this.put('migrations',{id:marker,createdAt:now()});
            });
          } catch {}
        }
      }
      this.put("migrations", { id: "run-io-v1", createdAt: now() });
    }
  }
  projectItems(projectId: string): WorkItem[] { return this.all<WorkItem>("items").filter(item => item.projectId === projectId); }
  nativeRows<T = any>(table:'native_items'|'native_outbox'|'native_turns',threadId:string):T[] {return this.db.prepare(`SELECT data FROM ${this.table(table)} WHERE json_extract(data,'$.threadId')=? ORDER BY rowid`).all(threadId).map((row:any)=>JSON.parse(row.data));}
  nextItemNumber(projectId: string): number { return Math.max(0, ...this.projectItems(projectId).map(item => item.number || 0)) + 1; }
  all<T = any>(table: string): T[] {
    return this.db
      .prepare(`SELECT data FROM ${this.table(table)} ORDER BY rowid`)
      .all()
      .map((r: any) => JSON.parse(r.data));
  }
  recent<T = any>(table: string, limit: number): T[] {
    return this.db
      .prepare(
        `SELECT data FROM ${this.table(table)} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(limit)
      .map((r: any) => JSON.parse(r.data))
      .reverse();
  }
  messages(channelId: string, limit = 100): Event[] {
    return this.db
      .prepare(
        "SELECT data FROM events WHERE json_extract(data,'$.channelId')=? AND json_extract(data,'$.kind')='message' ORDER BY rowid DESC LIMIT ?",
      )
      .all(channelId, limit)
      .map((r: any) => JSON.parse(r.data))
      .reverse();
  }
  channelRuns(channelId: string, limit = 8): Run[] {
    return this.db
      .prepare(
        "SELECT data FROM runs WHERE json_extract(data,'$.channelId')=? ORDER BY rowid DESC LIMIT ?",
      )
      .all(channelId, limit)
      .map((r: any) => JSON.parse(r.data))
      .reverse();
  }
  runCount(channelId: string, day: string): number {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM runs WHERE json_extract(data,'$.channelId')=? AND substr(json_extract(data,'$.startedAt'),1,10)=? AND (json_extract(data,'$.source') IS NULL OR json_extract(data,'$.source') IN ('morrow-schedule','nohuman-schedule'))",
          )
          .get(channelId, day) as any
      ).count,
    ) + Number((this.db.prepare("SELECT COUNT(*) AS n FROM loop_verifications WHERE json_extract(data,'$.channelId')=? AND substr(json_extract(data,'$.startedAt'),1,10)=?").get(channelId,day) as any).n);
  }
  contextKnowledge(projectId: string, channelId: string): any[] {
    return this.db
      .prepare(
        "SELECT data FROM knowledge WHERE json_extract(data,'$.projectId')=? AND (json_extract(data,'$.confirmed')=1 OR json_extract(data,'$.channelId')=?) ORDER BY rowid DESC LIMIT 150",
      )
      .all(projectId, channelId)
      .map((r: any) => JSON.parse(r.data))
      .reverse();
  }
  get<T = any>(table: string, id: string): T | undefined {
    const r = this.db
      .prepare(`SELECT data FROM ${this.table(table)} WHERE id=?`)
      .get(id) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  put<T extends { id: string }>(table: string, row: T): T {
    this.db
      .prepare(
        `INSERT INTO ${this.table(table)} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(row.id, JSON.stringify(row));
    return row;
  }
  table(t: string) {
    if (
      ![
        "projects",
        "channels",
        "items",
        "runs",
        "events",
        "knowledge",
        "results",
        "controls",
        "run_io",
        "run_io_pending",
        "migrations",
        "loop_grants", "loop_calls", "loop_evidence", "loop_learning", "loop_watches", "loop_waits", "loop_releases",
        "strategy_understanding", "strategy_decisions", "strategy_revisions", "strategy_runs", "strategy_signals",
        "loop_executions", "loop_verifications", "loop_verification_events", "loop_finalizations",
        "native_bindings", "native_threads", "native_items", "native_events", "native_requests", "native_outbox", "native_turns", "native_attachments",
      ].includes(t)
    )
      throw new Error("Unknown table");
    return t;
  }
  transaction<T>(fn: () => T): T {
    const depth=this.transactionDepth++;
    const savepoint=`nested_${depth}`;
    this.db.exec(depth?`SAVEPOINT ${savepoint}`:"BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec(depth?`RELEASE ${savepoint}`:"COMMIT");
      return r;
    } catch (e) {
      this.db.exec(depth?`ROLLBACK TO ${savepoint}`:"ROLLBACK");
      if(depth)this.db.exec(`RELEASE ${savepoint}`);
      throw e;
    } finally {this.transactionDepth--;}
  }
  event(channelId: string, runId: string, kind: string, text: string, detail?: EventDetail, metadata: Partial<Pick<Event, "projectId" | "itemId" | "actor" | "action" | "changes">> = {}): Event {
    const sequence = detail ? Number((this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.channelId')=?").get(runId, channelId) as any).count) + 1 : undefined;
    return this.put("events", {
      id: randomUUID(),
      projectId: metadata.projectId || this.get<Channel>("channels", channelId)?.projectId || "",
      channelId,
      runId,
      kind,
      text,
      createdAt: now(),
      ...(detail ? { detail: { ...detail, sequence } } : {}),
      ...metadata,
    });
  }
  eventPage(query: { projectId?: string; channelId?: string; itemId?: string; runId?: string; before?: string; after?: string; limit: number }): { events: Event[]; hasMore: boolean; cursor?: string } {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    for (const key of ["projectId", "channelId", "itemId"] as const) if (query[key]) { conditions.push(`json_extract(data,'$.${key}')=?`); values.push(query[key]!); }
    if (query.runId) { conditions.push("json_extract(data,'$.runId')=?"); values.push(query.runId); }
    const anchor = query.before || query.after;
    if (anchor) {
      conditions.push(`rowid ${query.after ? '>' : '<'} (SELECT rowid FROM events WHERE id=?)`);
      values.push(anchor);
    }
    const rows = this.db.prepare(`SELECT data FROM events WHERE ${conditions.join(' AND ')} ORDER BY rowid ${query.after ? 'ASC' : 'DESC'} LIMIT ?`).all(...values, query.limit + 1) as { data: string }[];
    const hasMore = rows.length > query.limit;
    const events = rows.slice(0, query.limit).map(row => JSON.parse(row.data) as Event);
    if (!query.after) events.reverse();
    const cursor = query.after ? events.at(-1)?.id : events[0]?.id;
    return { events, hasMore, ...(cursor ? { cursor } : {}) };
  }
  runPage(query: { projectId?: string; channelId?: string; before?: string; after?: string; limit: number }) {
    const conditions: string[] = []; const values: (string | number)[] = [];
    for (const key of ["projectId", "channelId"] as const) if (query[key]) { conditions.push(`json_extract(data,'$.${key}')=?`); values.push(query[key]!); }
    const anchor = query.before || query.after;
    if (anchor) { conditions.push(`rowid ${query.after ? '>' : '<'} (SELECT rowid FROM runs WHERE id=?)`); values.push(anchor); }
    const rows = this.db.prepare(`SELECT data FROM runs ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY rowid ${query.after ? 'ASC' : 'DESC'} LIMIT ?`).all(...values, query.limit + 1) as {data:string}[];
    const runs = rows.slice(0, query.limit).map(row => JSON.parse(row.data) as Run);
    if (!query.after) runs.reverse();
    const cursor = query.after ? runs.at(-1)?.id : runs[0]?.id;
    return { runs, hasMore: rows.length > query.limit, ...(cursor ? {cursor} : {}) };
  }
  io(runId: string, stream: RunIO['stream'], text: string): RunIO {
    const sequence = Number((this.db.prepare("SELECT COUNT(*) AS count FROM run_io WHERE json_extract(data,'$.runId')=?").get(runId) as any).count) + 1;
    return this.put("run_io", { id: randomUUID(), runId, stream, text, createdAt: now(), sequence });
  }
  ioStream(runId: string, stream: RunIO['stream'], text: string, secret: string, final = false): RunIO | undefined {
    // Only finalized public chunks receive cursor IDs. An undecided token prefix
    // is durable in a private row, never published and never moved into old rows.
    const id = `${runId}:${stream}`;
    const previous = this.get<{id:string;text:string}>('run_io_pending', id)?.text || '';
    const safe = (previous + text).replaceAll(secret, '[REDACTED]');
    let held = 0;
    if (!final) for (let length = Math.min(secret.length - 1, safe.length); length > 0; length--) {
      if (safe.endsWith(secret.slice(0, length))) { held = length; break; }
    }
    const ready = held ? safe.slice(0, -held) : safe;
    const pending = held ? safe.slice(-held) : '';
    return this.transaction(() => {
      this.put('run_io_pending', {id,runId,stream,text:pending});
      return ready ? this.io(runId, stream, ready) : undefined;
    });
  }
  ioPage(runId: string, after: string | undefined, limit: number) {
    const rows = this.db.prepare(`SELECT data FROM run_io WHERE json_extract(data,'$.runId')=? ${after ? 'AND rowid > (SELECT rowid FROM run_io WHERE id=?)' : ''} ORDER BY rowid ASC LIMIT ?`).all(...(after ? [runId, after, limit + 1] : [runId, limit + 1])) as {data:string}[];
    const chunks = rows.slice(0, limit).map(row => JSON.parse(row.data) as RunIO);
    const cursor = chunks.at(-1)?.id;
    return { chunks, hasMore: rows.length > limit, ...(cursor ? {cursor} : {}) };
  }
  runText(runId: string, stream: RunIO['stream']): string { return this.db.prepare("SELECT data FROM run_io WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.stream')=? ORDER BY rowid").all(runId, stream).map((row:any) => JSON.parse(row.data).text).join(''); }
  snapshot(runtimes: any[]) {
    return {
      projects: this.all<Project>("projects"),
      channels: this.all<Channel>("channels").map(channel=>({...channel,autonomyEnabled:!!this.get<any>("controls",channel.id)?.enabled})),
      items: this.all<WorkItem>("items"),
      runs: this.recent<Run>("runs", 500),
      events: this.recent<Event>("events", 1500),
      runtimes,
      releases: this.recent('loop_releases', 200),
    };
  }
  close() {
    this.db.close();
  }
}
