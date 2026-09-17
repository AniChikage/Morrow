import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
  existsSync,
} from 'node:fs';
import { basename, join, relative, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { APIError, choice, integer, keys, object, string, itemKinds, itemStatuses } from './protocol.ts';
import type { Channel, Control, Project, Run, WorkItem } from './protocol.ts';
import type { Evidence, Learning, FeedbackWatch, Release, ReleaseScript, ProjectLoop } from './autonomy-types.ts';
import { nativeEvidenceItems, nativeEvidenceSnapshot } from './native-evidence.ts';
import { nativeCapabilities } from './native-capabilities.ts';
import { workContract } from './prompts/work-contract.ts';
import { Store, now, parseRows } from './store.ts';
import { ProjectStrategy } from './project-strategy.ts';
import { WorkVerification } from './work-verification.ts';
import { ExecutionEvidence } from './execution-evidence.ts';
import { isFingerprint } from './build-identity.ts';
import type { UpgradeManager } from './upgrade.ts';
import type { UsageMonitor } from './usage.ts';
import type { ExecutionCapture } from './verification-types.ts';
import { helperSources, type Helpers } from './runtime-helpers.ts';

export type Scope = { id: string; projectId: string; channelId: string; runId: string; expiresAt: string };
/**
 * One already-answered work-interface call, kept so a repeated `requestId` returns the same result
 * instead of writing twice. `hash` covers the operation and its input, so the same id with different
 * content is a conflict rather than a replay.
 */
type LoopCall = { id: string; projectId: string; runId: string; hash: string; result: unknown };
type Wait = {
  id: string;
  projectId: string;
  runId: string;
  watchIds: string[];
  releaseIds: string[];
  deadline: string;
  reason: string;
  status: 'waiting' | 'ready';
  event?: string;
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fileValueDigest(value: unknown): string {
  const ordered = (v: unknown): unknown =>
    v === null || typeof v !== 'object'
      ? v
      : Array.isArray(v)
        ? v.map(ordered)
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, ordered((v as Record<string, unknown>)[key])])
          );
  return digest(JSON.stringify(ordered(value)));
}
const text = (value: unknown, field: string, max = 10000) => string(value, field, max);
const list = (value: unknown, field: string, max = 50): string[] => {
  if (!Array.isArray(value) || value.length > max) throw new APIError(400, `${field} 必须为数组，最多 ${max} 项`);
  return [...new Set(value.map((v) => text(v, field, 200)))];
};
function timestamp(value: unknown, field: string) {
  const v = text(value, field, 40);
  if (!Number.isFinite(Date.parse(v))) throw new APIError(400, `${field} 时间无效`);
  return new Date(v).toISOString();
}
function endpoint(value: unknown) {
  const raw = text(value, 'url', 4096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new APIError(400, '反馈/发布地址无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new APIError(400, '仅支持不含用户名密码的 HTTP(S) 地址');
  return url.href;
}
function valueAt(data: unknown, pointer: string): unknown {
  if (pointer === '') return data;
  if (!pointer.startsWith('/')) throw new APIError(400, 'pointer 使用 JSON Pointer，例如 /metrics/activation');
  return pointer
    .slice(1)
    .split('/')
    .reduce<unknown>(
      (v, key) =>
        v !== null && typeof v === 'object'
          ? Object.getOwnPropertyDescriptor(v, key.replaceAll('~1', '/').replaceAll('~0', '~'))?.value
          : undefined,
      data
    );
}
/** Sealed local-script limits: the human-owned script itself, its argv, and the output kept as `log`. */
const scriptLimit = 256 * 1024;
const logLimit = 1024 * 1024;
const receiptLimit = 512 * 1024;
/** The argv of a sealed script. Values are passed to `spawn` as an array, never through a shell. */
function scriptArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new APIError(400, 'args 必须为数组，最多 16 项');
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length > 1000 || entry.includes('\0'))
      throw new APIError(400, 'args 每项必须是不含空字符、最多 1000 字符的字符串');
    return entry;
  });
}
async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body)
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > 512 * 1024) throw new Error('响应超过 512 KB');
      chunks.push(chunk);
    }
  const raw = Buffer.concat(chunks).toString('utf8');
  return { data: JSON.parse(raw), hash: digest(raw) };
}

// Missing descendants are allowed at registration. Every existing component is
// checked again on each poll so a later symlink cannot redirect a file watch.
function fileWatchPath(projectPath: string, path: unknown) {
  const root = realpathSync(projectPath),
    actual = resolve(root, text(path, 'path', 4096));
  const rel = relative(root, actual);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    throw new APIError(403, '观察文件必须位于当前项目内');
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new APIError(403, '观察文件路径不能包含符号链接');
      if (current === actual ? !stat.isFile() : !stat.isDirectory())
        throw new APIError(400, '观察路径必须指向普通文件');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return actual;
}

function readWatchFile(projectPath: string, path: string, pointer: string) {
  const actual = fileWatchPath(projectPath, path);
  let fd: number;
  try {
    fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('观察文件必须是至多512 KB的普通文件');
    // Reject a replacement between validation and opening, including ancestor links.
    fileWatchPath(projectPath, path);
    const current = lstatSync(actual);
    if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('观察文件在读取时被替换');
    const buffer = Buffer.alloc(512 * 1024 + 1);
    let length = 0,
      count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0)
      length += count;
    if (length > 512 * 1024) throw new Error('观察文件超过512 KB');
    const bytes = buffer.subarray(0, length),
      raw = bytes.toString('utf8');
    let data: unknown;
    try {
      data = JSON.parse(raw, (_key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('观察文件包含非有限数值');
        return value;
      });
    } catch (error) {
      if (error instanceof RangeError) throw error;
      if (pointer) throw new Error('文件不是 JSON，不能使用 pointer');
      data = raw;
    }
    return { data, hash: digest(bytes) };
  } finally {
    closeSync(fd);
  }
}
/**
 * One evidence record without its content: provenance, digest and stored size, so a turn can see
 * what was collected without the bytes being replayed into every context and write response.
 * `evidence.read {id}` still returns the preserved `data`.
 */
export function evidenceRow(row: Evidence) {
  const { data, ...rest } = row;
  return { ...rest, bytes: Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data ?? null)) };
}

export class ProjectWorkLoop {
  store: Store;
  home: string;
  baseURL = '';
  closed = false;
  pending = new Set<Promise<unknown>>();
  inFlight = new Set<string>();
  strategy: ProjectStrategy;
  verification: WorkVerification;
  executions: ExecutionEvidence;
  /** Attached by the engine; the reviewer gate and `context.budget` read through it. */
  usage?: UsageMonitor;
  /** Attached by the engine, so a published receipt can request a switch to the build it installed. */
  upgrade?: UpgradeManager;
  /** Attached by the engine so a sealed script's own output can never carry the desktop token. */
  redact: (text: string) => string = (text) => text;
  /** Where this boot spawns its helper scripts from; the engine pins them to the running build. */
  helpers: Helpers = helperSources();
  constructor(store: Store, home: string) {
    this.store = store;
    this.home = home;
    this.strategy = new ProjectStrategy(this);
    this.verification = new WorkVerification(this);
    this.executions = new ExecutionEvidence(this);
  }
  rows<T>(table: string, projectId: string): T[] {
    return parseRows<T>(
      this.store.db
        .prepare(`SELECT data FROM ${this.store.table(table)} WHERE json_extract(data,'$.projectId')=? ORDER BY rowid`)
        .all(projectId)
    );
  }
  view(
    projectId: string,
    itemId?: string,
    verificationOptions: { before?: string; includeLatest?: boolean } = {}
  ): ProjectLoop {
    const linked = (r: { itemId?: string; itemIds?: string[] }) =>
      !itemId || r.itemId === itemId || r.itemIds?.includes(itemId);
    const learning = this.rows<Learning>('loop_learning', projectId).filter(linked).slice(-150);
    const allReleases = this.rows<Release>('loop_releases', projectId).filter(linked);
    const releases = allReleases.filter(
      (row, index) => row.status === 'awaiting_approval' || index >= allReleases.length - 50
    );
    const strategy = this.strategy.view(projectId, itemId);
    const references = new Set([
      ...learning.flatMap((row) => row.evidenceIds),
      ...releases.flatMap((row) => row.checks.flatMap((check) => check.evidenceIds)),
      ...strategy.understanding.flatMap((row) => row.evidenceIds),
      ...strategy.decisions.flatMap((row) => [
        ...row.evidenceIds,
        ...(row.expectations || []).flatMap((e) =>
          e.measurement && 'evidenceId' in e.measurement.baseline ? [e.measurement.baseline.evidenceId] : []
        ),
        ...(row.review?.evidenceIds || []),
        ...(row.memoryRefs || []).flatMap((ref) => ref.snapshot.evidenceIds),
      ]),
    ]);
    const verificationPage = this.verification.page(
      projectId,
      itemId,
      releases.flatMap((row) => [
        ...(row.verificationIds || []),
        ...(row.releaseVerificationId ? [row.releaseVerificationId] : []),
      ]),
      verificationOptions
    );
    const verifications = verificationPage.verifications;
    for (const row of verifications) for (const id of row.evidenceIds) references.add(id);
    const allEvidence = this.rows<Evidence>('loop_evidence', projectId);
    const recent = new Set(
      allEvidence
        .filter(linked)
        .slice(-100)
        .map((row) => row.id)
    );
    return {
      evidence: allEvidence.filter((row) => recent.has(row.id) || references.has(row.id)),
      learning,
      watches: this.rows<FeedbackWatch>('loop_watches', projectId).filter(linked).slice(-100),
      releases,
      strategy,
      verifications,
      // Why no verification can read as current right now, when the source version is unreadable at
      // all. Previously swallowed, which left every row looking stale with nothing said about it.
      ...(verificationPage.sourceStale ? { sourceStale: true, sourceReason: verificationPage.sourceReason } : {}),
      ...(verificationOptions.includeLatest
        ? {
            verificationHistory: {
              hasMore: verificationPage.hasMore,
              cursor: verificationPage.cursor,
              revision: verificationPage.revision,
            },
          }
        : {}),
      finalizations: this.verification.finalizations(projectId, itemId),
    };
  }
  /** An audit row that only says what the write produced. `auditChange` also records what it replaced. */
  audit(
    scope: Pick<Scope, 'projectId' | 'channelId' | 'runId'>,
    action: string,
    summary: string,
    itemId?: string,
    changes?: unknown,
    actor: 'agent' | 'system' | 'human' = 'agent'
  ) {
    this.auditChange(scope, action, summary, itemId, changes ? { after: changes } : undefined, actor);
  }
  /**
   * The same row, stating the item's previous state as well: `before` is the row as it stood before
   * the write, `after` the row actually stored. Item history can only name the fields that moved
   * when it has both sides; a row with `after` alone (every row written before this build, and every
   * creation, which has no before) keeps describing itself in its own text. An "after" payload may
   * itself carry `before`/`after` keys, so the two shapes are two methods rather than one sniffed
   * argument. Not emitted at all when neither side is given, exactly as before.
   */
  auditChange(
    scope: Pick<Scope, 'projectId' | 'channelId' | 'runId'>,
    action: string,
    summary: string,
    itemId?: string,
    changes?: { before?: unknown; after?: unknown },
    actor: 'agent' | 'system' | 'human' = 'agent'
  ) {
    const recorded = {
      ...(changes?.before !== undefined ? { before: changes.before } : {}),
      ...(changes?.after !== undefined ? { after: changes.after } : {}),
    };
    this.store.event(scope.channelId, scope.runId, 'system', summary, undefined, {
      projectId: scope.projectId,
      itemId,
      actor,
      action,
      ...(Object.keys(recorded).length ? { changes: recorded } : {}),
    });
  }
  prepare(run: Run): string {
    if (!this.baseURL) return '';
    this.strategy.prepare(run);
    const secret = randomBytes(32).toString('hex');
    const scope: Scope = {
      id: digest(secret),
      projectId: run.projectId,
      channelId: run.channelId,
      runId: run.id,
      expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    };
    this.store.put('loop_grants', scope);
    const directory = join(this.home, 'runs', run.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'agent-context.json');
    writeFileSync(path, JSON.stringify({ url: `${this.baseURL}/api/agent`, token: secret }), { mode: 0o600 });
    const command = [process.execPath, this.helpers['agent-cli.ts'], '--context', path]
      .map((v) => "'" + v.replaceAll("'", "'\\''") + "'")
      .join(' ');
    // Only paths live in this launcher; the existing CLI still reads and validates the run grant.
    // `sh` avoids executable-bit assumptions and "$@" preserves stdin and every original CLI argument.
    const launcher = join(directory, 'tool.sh');
    writeFileSync(launcher, `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o600 });
    return `\nsh '${launcher.replaceAll("'", "'\\''")}' --operation context\n写操作带 --request-id，用 --input - 传JSON；重试同ID/内容。仅本轮项目，不能批准；详情 --operation contract，勿读凭证。\n`;
  }
  authenticate(authorization: string): Scope {
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const grant = this.store.get<Scope>('loop_grants', digest(token));
    if (!grant || grant.expiresAt < now()) throw new APIError(401, '原生工作接口凭证已失效');
    return grant;
  }
  scope(scope: Scope) {
    const channel = this.store.get<Channel>('channels', scope.channelId);
    const project = this.store.get<Project>('projects', scope.projectId);
    const run = this.store.get<Run>('runs', scope.runId);
    if (
      !project ||
      project.isDemo ||
      channel?.projectId !== project.id ||
      run?.projectId !== project.id ||
      run.channelId !== channel.id ||
      run.status !== 'running'
    )
      throw new APIError(409, '本轮已结束，等待下一原生工作轮次后继续');
    return { project, channel, run };
  }
  item(scope: Scope, id: unknown, optional = true) {
    if (id === undefined && optional) return undefined;
    const item = this.store.get<WorkItem>('items', text(id, 'itemId', 200));
    if (!item || item.projectId !== scope.projectId) throw new APIError(404, 'feature 不属于当前项目');
    return item;
  }
  /** The channel name an ownership message names; a removed channel still produces a readable refusal. */
  channelName(channelId: string) {
    return this.store.get<Channel>('channels', channelId)?.name || '已移除的频道';
  }
  /** Channel id → name for one project, so an id in a record can be named without another read. */
  channelNames(projectId: string): Record<string, string> {
    return Object.fromEntries(
      this.store
        .all<Channel>('channels')
        .filter((row) => row.projectId === projectId)
        .map((row) => [row.id, row.name])
    );
  }
  /**
   * The ownership rule itself: a channel may advance an item nobody is responsible for, or one it is
   * responsible for, and nothing else. `requireOwner` refuses a work-interface write with it; the
   * turn report entry point (`Engine.finishSuccess`) needs the same rule as a value, because one
   * refused report entry must not discard the rest of an otherwise valid report.
   */
  mayAdvance(channelId: string, item: WorkItem) {
    return !item.ownerChannelId || item.ownerChannelId === channelId;
  }
  /** Refuses a work-interface write on an item another channel of this project is responsible for. */
  requireOwner(scope: Scope, item: WorkItem) {
    if (!this.mayAdvance(scope.channelId, item))
      throw new APIError(
        409,
        `事项 #${item.number} 由频道「${this.channelName(item.ownerChannelId!)}」负责；只能推进分派给本频道或无人负责的事项`
      );
  }
  /**
   * Item ownership (事项归属) after this channel advanced `item` to `status`: an unowned item becomes
   * this channel's, a resolved one is released, and anything else (including `blocked`) keeps the
   * owner it has. An item another channel is responsible for is refused, so two channels of one
   * project never advance the same item. Reads are never affected, and the human assignment route
   * can override any of this. The caller stores the returned owner; `assign` writes it for an
   * operation that does not write the item row itself.
   */
  owner(scope: Scope, item: WorkItem, status = item.status): string | undefined {
    this.requireOwner(scope, item);
    const next = status === 'resolved' ? undefined : item.ownerChannelId || scope.channelId;
    if (next !== item.ownerChannelId)
      this.auditChange(
        scope,
        next ? 'item.claimed' : 'item.released',
        next ? `#${item.number}「${item.title}」由本频道负责` : `#${item.number}「${item.title}」已解决，交回无人负责`,
        item.id,
        // Responsibility as it stood and as it stands, the same two sides the human assignment route
        // records; `item` is the row before this write, so its owner is the previous one.
        { before: { ownerChannelId: item.ownerChannelId ?? null }, after: { ownerChannelId: next ?? null } },
        // Morrow assigns responsibility as a consequence of the write; the write itself is audited
        // separately as the agent's, and a human assignment is audited as the human's.
        'system'
      );
    return next;
  }
  /** `owner`, for an operation whose own write does not carry the item row. Keeps `revision` untouched. */
  assign(scope: Scope, item: WorkItem) {
    const next = this.owner(scope, item);
    if (next !== item.ownerChannelId) this.store.put('items', { ...item, ownerChannelId: next });
  }
  refs(scope: Scope, ids: unknown) {
    const result = list(ids, 'evidenceIds');
    for (const id of result)
      if (this.store.get<Evidence>('loop_evidence', id)?.projectId !== scope.projectId)
        throw new APIError(404, '证据不属于当前项目');
    return result;
  }
  linkEvidence(entry: Evidence) {
    if (!entry.itemId) return;
    const item = this.store.get<WorkItem>('items', entry.itemId);
    if (!item || item.projectId !== entry.projectId || item.evidence.some((value) => value.startsWith(`[${entry.id}]`)))
      return;
    this.store.put('items', {
      ...item,
      evidence: [...item.evidence, `[${entry.id}] ${entry.summary}\n来源：${entry.source}`],
      revision: item.revision + 1,
      updatedAt: now(),
    });
  }
  /**
   * The read-only contract behind the work interface. It is the same text for every turn, so a turn
   * reads it when it needs the exact field rules instead of receiving it inside `context`.
   */
  contract(scope: Scope, input: Record<string, any>) {
    keys(input, []);
    const { project } = this.scope(scope);
    return {
      ...workContract,
      // A dated record of one real probe, not a live query: `untested` means no measurement exists.
      nativeCapabilities,
      briefRevision: project.briefRevision || 0,
    };
  }
  context(scope: Scope, input: Record<string, any>) {
    keys(input, ['itemId']);
    const { project, channel } = this.scope(scope);
    const item = this.item(scope, input.itemId);
    const view = this.view(project.id, item?.id);
    const evidence = view.evidence.map(evidenceRow);
    const learning = view.learning.slice(-12).map((row) => {
      const truncated = [row.rationale, row.expectedResult, row.evaluation, row.conclusion].some(
        (value) => value.length > 500
      );
      return {
        ...row,
        rationale: row.rationale.slice(0, 500),
        expectedResult: row.expectedResult.slice(0, 500),
        evaluation: row.evaluation.slice(0, 500),
        conclusion: row.conclusion.slice(0, 500),
        ...(truncated ? { truncated: true } : {}),
      };
    });
    const learningTotal = Number(
      (
        this.store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM loop_learning WHERE json_extract(data,'$.projectId')=?${item ? " AND json_extract(data,'$.itemId')=?" : ''}`
          )
          .get(...(item ? [project.id, item.id] : [project.id])) as { n: number }
      ).n
    );
    return {
      hint: '这里只有项目当前数据。操作契约、发布适配说明、工作原则与原生能力清单运行 contract 操作；项目说明正文在本任务开头的章程里，证据全文用 evidence.read。',
      project: {
        id: project.id,
        name: project.name,
        goal: project.goal,
        briefRevision: project.briefRevision || 0,
      },
      channel: { id: channel.id, goal: channel.goal },
      // `features[].ownerChannelId` and other channels' records carry ids; this maps them to names.
      channelNames: this.channelNames(project.id),
      budget: this.usage?.budgetContext(project, channel),
      strategy: this.strategy.context(scope, item?.id),
      learningCoverage: {
        total: learningTotal,
        included: learning.length,
        partial: learningTotal > learning.length,
        readMore: '这里只列最近 12 条摘要；历史和全文用 memory.recall/search/read 读取。',
      },
      features: item ? [item] : this.store.projectItems(project.id),
      learning,
      evidence,
      watches: view.watches,
      // A local publication's log can reach 1 MiB; the agent reads a bounded tail and the full text stays in SQLite.
      releases: view.releases.map((row) =>
        row.log && row.log.length > 2000 ? { ...row, log: row.log.slice(-2000), logTruncated: true } : row
      ),
      verifications: view.verifications,
      finalizations: view.finalizations,
      executions: this.rows<ExecutionCapture>('loop_executions', project.id).slice(-12),
    };
  }
  async call(scope: Scope, payload: unknown): Promise<unknown> {
    const body = object(payload);
    keys(body, ['operation', 'input', 'requestId']);
    const operation = text(body.operation, 'operation', 80);
    const input = object(body.input ?? {});
    if (operation === 'context') return this.context(scope, input);
    if (operation === 'contract') return this.contract(scope, input);
    if (operation === 'observation.read') return this.strategy.evaluation.read(scope, input);
    if (operation === 'execution.read') return this.executions.read(scope, input);
    if (operation === 'verification.read') return this.verification.read(scope, input);
    if (operation === 'memory.search' || operation === 'memory.read' || operation === 'memory.recall')
      return this.strategy.read(scope, operation, input);
    if (operation === 'evidence.native') return nativeEvidenceItems(this, scope, input);
    if (operation === 'evidence.read') {
      keys(input, ['id']);
      this.scope(scope);
      const row = this.store.get<Evidence>('loop_evidence', text(input.id, 'id', 200));
      if (row?.projectId !== scope.projectId) throw new APIError(404, '证据不属于当前项目');
      return row;
    }
    const requestId = text(body.requestId, 'requestId', 200);
    const key = `${scope.runId}:${requestId}`;
    const hash = digest(JSON.stringify({ operation, input }));
    const previous = this.store.get<LoopCall>('loop_calls', key);
    if (previous) {
      if (previous.hash !== hash) throw new APIError(409, '请求 ID 已用于不同内容');
      return previous.result;
    }
    this.scope(scope);
    return this.store.transaction(() => {
      const result = this.mutate(scope, operation, input, key);
      this.store.put('loop_calls', { id: key, hash, result, projectId: scope.projectId, runId: scope.runId });
      return result;
    });
  }
  file(scope: Scope, path: unknown, maxBytes: number) {
    const { project } = this.scope(scope);
    const root = realpathSync(project.path);
    let actual: string;
    try {
      actual = realpathSync(isAbsolute(String(path)) ? text(path, 'path', 4096) : join(root, text(path, 'path', 4096)));
    } catch {
      throw new APIError(400, '文件不存在');
    }
    const rel = relative(root, actual);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new APIError(403, '只接受当前项目目录内的文件');
    const stat = statSync(actual);
    if (!stat.isFile() || stat.size > maxBytes) throw new APIError(400, `必须是小于 ${maxBytes} 字节的普通文件`);
    return { actual, bytes: readFileSync(actual) };
  }
  mutate(scope: Scope, operation: string, input: Record<string, any>, key: string, pendingReview?: string): unknown {
    const { project } = this.scope(scope);
    const time = now();
    if (operation === 'execution.prepare') return this.executions.prepare(scope, input);
    if (operation === 'verification.request') {
      // Requesting a review of an item is advancing it, so the same ownership rule applies here.
      // Internal requests (a deferred `feature.upsert`/`decision.review` completion) already own it.
      const item = input.itemId === undefined ? undefined : this.item(scope, input.itemId, false);
      if (item) this.assign(scope, item);
      return this.verification.request(scope, input);
    }
    if (operation === 'verification.retry') return this.verification.retry(scope, input);
    if (['understanding.upsert', 'decision.choose', 'decision.review'].includes(operation))
      return this.strategy.mutate(scope, operation, input);
    if (operation === 'feature.complete') {
      keys(input, ['id', 'revision', 'status', 'summary', 'nextStep', 'evidenceIds', 'review']);
      const item = this.item(scope, input.id, false)!;
      this.requireOwner(scope, item);
      if (item.revision !== input.revision) throw new APIError(409, 'feature 已更新，请读取最新版本再合并');
      const status = choice(input.status ?? 'resolved', 'status', ['verified', 'resolved'] as const);
      const evidenceIds = this.refs(scope, input.evidenceIds || []);
      if (!evidenceIds.length) throw new APIError(400, '完成事项需要证据引用');
      const decision = this.strategy.active(project.id).find((row) => row.channelId === scope.channelId);
      let reviewResult: any;
      if (decision) {
        const review = object(input.review);
        if (decision.itemId !== item.id || review.id !== decision.id)
          throw new APIError(409, '完成请求必须核对本频道当前行动及其事项');
        // Freeze both intents in the outer call transaction. The review includes the completion
        // evidence too, so the later item request reuses exactly this review rather than buying another.
        reviewResult = this.strategy.review(scope, {
          ...review,
          evidenceIds: [...new Set([...this.refs(scope, review.evidenceIds || []), ...evidenceIds])],
        });
      } else if (input.review !== undefined) {
        throw new APIError(409, '当前没有待复盘行动；请刷新后仅提交事项完成');
      }
      return this.mutate(
        scope,
        'feature.upsert',
        {
          id: item.id,
          revision: item.revision,
          title: item.title,
          kind: item.kind,
          summary: input.summary,
          nextStep: input.nextStep,
          status,
          evidenceIds,
        },
        key,
        reviewResult?.pendingVerification ? reviewResult.verificationId : undefined
      );
    }
    // Only the atomic completion above may cross this gate while its own review is pending.
    // Ordinary updates and publication still require the current action to have been reviewed.
    if ((operation === 'feature.upsert' && !pendingReview) || operation === 'release.propose')
      this.strategy.requireCurrent(scope);
    const base = {
      id: randomUUID(),
      projectId: scope.projectId,
      channelId: scope.channelId,
      runId: scope.runId,
      createdAt: time,
    };
    if (operation === 'feature.upsert') {
      keys(input, ['id', 'revision', 'title', 'summary', 'kind', 'status', 'evidenceIds', 'nextStep']);
      const old = input.id ? this.item(scope, input.id, false) : undefined;
      if (old) this.requireOwner(scope, old);
      if (old && input.revision !== old.revision) throw new APIError(409, 'feature 已更新，请读取最新版本再合并');
      const evidenceIds = this.refs(scope, input.evidenceIds || []);
      const title = text(input.title, 'title', 300);
      const status = choice(input.status, 'status', itemStatuses);
      if (['verified', 'resolved'].includes(status) && !evidenceIds.length)
        throw new APIError(400, '已验证/已解决需要证据引用');
      if (
        !old &&
        this.store
          .projectItems(project.id)
          .some((v) => v.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase())
      )
        throw new APIError(409, '同名 feature 已存在，请沿用其 ID');
      const evidence = evidenceIds.map((id) => {
        const e = this.store.get<Evidence>('loop_evidence', id)!;
        return `[${e.id}] ${e.summary}\n来源：${e.source}`;
      });
      const item: WorkItem = {
        id: old?.id || base.id,
        projectId: project.id,
        origin: old?.origin || 'agent',
        ...(old?.ownerChannelId ? { ownerChannelId: old.ownerChannelId } : {}),
        number: old?.number || this.store.nextItemNumber(project.id),
        channelId: old?.channelId || scope.channelId,
        sourceChannelIds: [...new Set([...(old?.sourceChannelIds || []), scope.channelId])],
        lastRunId: scope.runId,
        revision: (old?.revision || 0) + 1,
        title,
        summary: text(input.summary, 'summary'),
        kind: choice(input.kind, 'kind', itemKinds),
        status,
        evidence: [...new Set([...(old?.evidence || []), ...evidence])],
        nextStep: string(input.nextStep ?? '', 'nextStep', 5000, true),
        createdAt: old?.createdAt || time,
        updatedAt: time,
      };
      return this.store.transaction(() => {
        this.store.put('items', {
          ...item,
          status: ['verified', 'resolved'].includes(status) ? 'investigating' : status,
        });
        let verification, completion;
        if (['verified', 'resolved'].includes(status)) {
          const decision = this.strategy.view(project.id, item.id).decisions.at(-1);
          const latest = this.verification.rows(project.id, item.id).at(-1);
          const afterHistory =
            latest &&
            !latest.decisionId &&
            decision?.status === 'reviewed' &&
            decision.createdAt <= latest.createdAt &&
            decision.updatedAt <= latest.createdAt &&
            !!decision.expectations?.length &&
            decision.expectations.every((expected) => expected.deadline < latest.createdAt);
          if (afterHistory) {
            // A later standalone review validates the current item, not the expired historical experiment.
            const uncovered = this.rows<Evidence>('loop_evidence', project.id).some(
              (row) =>
                row.origin !== 'agent' &&
                row.createdAt >= latest.createdAt &&
                (row.itemId === item.id ||
                  decision.expectations!.some((expected) => this.strategy.evaluation.matches(expected, row))) &&
                !latest.evidenceIds.includes(row.id)
            );
            if (
              latest.status !== 'passed' ||
              !this.verification.current(latest) ||
              uncovered ||
              !evidenceIds.every((id) => latest.evidenceIds.includes(id))
            )
              throw new APIError(409, '当前事项复核未通过、已变化或未覆盖新证据；先核验当前事项，不能回选旧行动结论');
            verification = latest;
          } else {
            verification = this.verification.request(scope, {
              itemId: item.id,
              ...(decision ? { decisionId: decision.id } : {}),
              evidenceIds: [...new Set([...(decision?.review?.evidenceIds || []), ...evidenceIds])],
            });
            if (verification.status === 'passed' && latest && latest.id !== verification.id)
              throw new APIError(409, '已有更新的事项复核，不能回选较早通过记录完成事项');
          }
          if (pendingReview && verification.id !== pendingReview)
            throw new APIError(409, '完成请求与复盘材料不一致，请重新核对');
          if (verification.status !== 'passed' || !this.verification.current(verification)) {
            item.status = 'investigating';
            completion = this.verification.defer(scope, verification, 'feature.complete', item.id, item.revision, {
              status,
            });
          }
        }
        // The stored status is what ownership follows: a deferred completion keeps the item claimed.
        const responsible = this.owner(scope, old ?? item, item.status);
        if (responsible) item.ownerChannelId = responsible;
        else delete item.ownerChannelId;
        this.store.put('items', item);
        this.auditChange(
          scope,
          old ? 'feature.updated' : 'feature.created',
          `${old ? '更新' : '建立'} #${item.number}「${item.title}」`,
          item.id,
          // `old` is read from storage and nothing here writes into it (`item` is built field by
          // field, never spread over it), so it is still the row this write replaced; `item` is the
          // row just stored, ownership and any deferred status included. A creation has no before.
          { ...(old ? { before: old } : {}), after: item }
        );
        // A receipt, not a copy of the board: the turn wrote these fields and reads the rest back
        // through `context`. The verification ids are what decides whether the change is complete.
        return {
          id: item.id,
          number: item.number,
          revision: item.revision,
          kind: item.kind,
          status: item.status,
          title: item.title,
          // Who is responsible now: this channel after a claim, `null` once the item was released.
          ownerChannelId: item.ownerChannelId ?? null,
          ...(verification
            ? { verificationId: verification.id, pendingVerification: item.status === 'investigating' }
            : {}),
          ...(completion ? { finalizationId: completion.id } : {}),
        };
      });
    }
    if (operation === 'evidence.link') {
      const item = this.item(scope, input.itemId);
      const snapshot = nativeEvidenceSnapshot(this, scope, input);
      const entry: Evidence = {
        ...base,
        ...(item ? { itemId: item.id } : {}),
        summary: text(input.summary, 'summary', 5000),
        observedAt: time,
        origin: 'native',
        ...snapshot,
      };
      this.store.put('loop_evidence', entry);
      this.linkEvidence(entry);
      this.strategy.evidenceObserved(entry);
      this.audit(scope, 'evidence.recorded', entry.summary, item?.id, {
        id: entry.id,
        origin: entry.origin,
        source: entry.source,
      });
      return evidenceRow(entry);
    }
    if (operation === 'evidence.record' || operation === 'evidence.capture') {
      keys(
        input,
        operation === 'evidence.capture'
          ? ['itemId', 'summary', 'path']
          : ['itemId', 'summary', 'source', 'observedAt', 'data']
      );
      const item = this.item(scope, input.itemId);
      let source: string,
        data: unknown,
        origin: Evidence['origin'],
        hash: string | undefined,
        observedAt = time;
      if (operation === 'evidence.capture') {
        const file = this.file(scope, input.path, 512 * 1024);
        source = file.actual;
        data = file.bytes.toString('utf8');
        origin = 'file';
        hash = digest(file.bytes);
      } else {
        source = text(input.source, 'source', 4096);
        data = input.data ?? null;
        if (JSON.stringify(data).length > 512 * 1024) throw new APIError(413, '证据超过 512 KB');
        origin = 'agent';
        observedAt = timestamp(input.observedAt, 'observedAt');
      }
      const entry: Evidence = {
        ...base,
        ...(item ? { itemId: item.id } : {}),
        summary: text(input.summary, 'summary', 5000),
        source,
        observedAt,
        origin,
        data,
        ...(hash ? { digest: hash } : {}),
      };
      this.store.put('loop_evidence', entry);
      this.linkEvidence(entry);
      this.strategy.evidenceObserved(entry);
      this.audit(scope, 'evidence.recorded', entry.summary, item?.id, { id: entry.id, origin, source });
      // The content is already the agent's own input or a file it can read again; echoing it back
      // only doubles the turn's context. `evidence.read {id}` returns the preserved record.
      return evidenceRow(entry);
    }
    if (operation === 'learning.upsert') {
      keys(input, [
        'id',
        'revision',
        'itemId',
        'kind',
        'title',
        'rationale',
        'expectedResult',
        'evaluation',
        'conclusion',
        'status',
        'evidenceIds',
      ]);
      const item = this.item(scope, input.itemId);
      const old = input.id ? this.store.get<Learning>('loop_learning', text(input.id, 'id', 200)) : undefined;
      if (input.id && old?.projectId !== scope.projectId) throw new APIError(404, '认识记录不属于当前项目');
      if (old && input.revision !== old.revision) throw new APIError(409, '认识已更新，请先读取最新证据');
      const evidenceIds = this.refs(scope, input.evidenceIds || []);
      const status = choice(input.status, 'status', [
        'active',
        'supported',
        'refuted',
        'inconclusive',
        'stopped',
      ] as const);
      if (['supported', 'refuted'].includes(status) && !evidenceIds.length)
        throw new APIError(400, '支持或推翻判断需要证据');
      const row: Learning = {
        ...base,
        id: old?.id || base.id,
        itemId: item?.id || old?.itemId,
        kind: choice(input.kind, 'kind', ['outcome', 'hypothesis', 'experiment'] as const),
        title: text(input.title, 'title', 300),
        rationale: text(input.rationale, 'rationale'),
        expectedResult: text(input.expectedResult, 'expectedResult'),
        evaluation: text(input.evaluation, 'evaluation'),
        conclusion: string(input.conclusion ?? '', 'conclusion', 10000, true),
        status,
        evidenceIds,
        revision: (old?.revision || 0) + 1,
        createdAt: old?.createdAt || time,
        updatedAt: time,
      };
      return this.store.transaction(() => {
        if (old && !this.store.get('strategy_revisions', `learning:${old.id}:${old.revision}`))
          this.strategy.checkpoint('learning', old);
        this.strategy.checkpoint('learning', row);
        this.strategy.memoryChanged(project.id, 'learning', row.id);
        this.audit(scope, 'learning.updated', `${row.title}：${row.status}`, row.itemId, row);
        return row;
      });
    }
    if (operation === 'watch.create') {
      keys(input, [
        'kind',
        'path',
        'itemId',
        'title',
        'url',
        'pointer',
        'condition',
        'expected',
        'intervalSeconds',
        'deadline',
        'releaseId',
        'continuous',
      ]);
      const item = this.item(scope, input.itemId);
      const kind = choice(input.kind ?? 'http', 'kind', ['http', 'file'] as const);
      if (kind === 'file' ? input.url !== undefined : input.path !== undefined)
        throw new APIError(400, 'file 观察只接受 path，http 观察只接受 url');
      const source =
        kind === 'file' ? { kind, path: fileWatchPath(project.path, input.path) } : { kind, url: endpoint(input.url) };
      const pointer = string(input.pointer ?? '', 'pointer', 1000, true);
      valueAt({}, pointer);
      if (input.continuous !== undefined && typeof input.continuous !== 'boolean')
        throw new APIError(400, 'continuous 必须为布尔值');
      const condition = choice(input.condition, 'condition', ['changed', 'gte', 'lte', 'equals'] as const);
      if (
        ['gte', 'lte'].includes(condition) &&
        (typeof input.expected !== 'number' || !Number.isFinite(input.expected))
      )
        throw new APIError(400, '数值条件需要有限数值 expected');
      if (condition === 'equals' && !['string', 'number', 'boolean'].includes(typeof input.expected))
        throw new APIError(400, 'equals 需要标量 expected');
      const deadline = timestamp(input.deadline, 'deadline');
      if (deadline <= time) throw new APIError(400, '观察截止时间必须在未来');
      const release = input.releaseId ? this.release(text(input.releaseId, 'releaseId', 200)) : undefined;
      if (release && release.projectId !== project.id) throw new APIError(404, '发布不属于当前项目');
      if (
        this.rows<FeedbackWatch>('loop_watches', project.id).filter(
          (w) => w.status === 'watching' || (w.continuous !== false && w.status !== 'cancelled')
        ).length >= 50
      )
        throw new APIError(409, '项目同时最多保留 50 个观察条件；不再有价值的监测请显式取消');
      const row: FeedbackWatch = {
        ...base,
        itemId: item?.id,
        title: text(input.title, 'title', 300),
        ...source,
        ...(source.kind === 'file' ? { initiallyMissing: !existsSync(source.path) } : {}),
        pointer,
        condition,
        ...(input.expected === undefined ? {} : { expected: input.expected }),
        intervalSeconds: integer(input.intervalSeconds ?? 60, 'intervalSeconds', 30, 86400),
        deadline,
        continuous: input.continuous !== false,
        releaseId: release?.id,
        status: 'watching',
        nextPollAt: time,
        updatedAt: time,
      };
      this.store.put('loop_watches', row);
      this.audit(scope, 'watch.created', row.title, item?.id, row);
      return row;
    }
    if (operation === 'watch.cancel') {
      keys(input, ['id']);
      const watch = this.store.get<FeedbackWatch>('loop_watches', text(input.id, 'id', 200));
      if (watch?.projectId !== project.id) throw new APIError(404, '观察条件不属于当前项目');
      const row = { ...watch, status: 'cancelled' as const, updatedAt: time };
      this.store.put('loop_watches', row);
      this.signal(watch.channelId, watch.id, '观察已取消');
      return row;
    }
    if (operation === 'wait') {
      keys(input, ['watchIds', 'releaseIds', 'deadline', 'reason']);
      const watchIds = list(input.watchIds || [], 'watchIds'),
        releaseIds = list(input.releaseIds || [], 'releaseIds');
      for (const id of watchIds)
        if (this.store.get<FeedbackWatch>('loop_watches', id)?.projectId !== project.id)
          throw new APIError(404, '观察条件不属于当前项目');
      for (const id of releaseIds)
        if (this.release(id).projectId !== project.id) throw new APIError(404, '发布不属于当前项目');
      const deadline = timestamp(input.deadline, 'deadline');
      if (deadline <= time) throw new APIError(400, '等待截止时间必须在未来');
      const row: Wait = {
        id: scope.channelId,
        projectId: project.id,
        runId: scope.runId,
        watchIds,
        releaseIds,
        deadline,
        reason: text(input.reason, 'reason'),
        status: 'waiting',
      };
      this.store.put('loop_waits', row);
      this.audit(scope, 'work.waiting', row.reason, undefined, row);
      return row;
    }
    if (operation === 'release.propose') return this.propose(scope, input, key);
    throw new APIError(400, '未知操作；原生工作接口没有上线批准权限');
  }
  release(id: string) {
    const row = this.store.get<Release>('loop_releases', id);
    if (!row) throw new APIError(404, '发布记录不存在');
    return row;
  }
  artifactPath(id: string) {
    return join(this.home, 'releases', id, 'artifact');
  }
  /** The sealed copy of the human-written script; the project's own file is never executed. */
  scriptPath(id: string) {
    return join(this.home, 'releases', id, 'script');
  }
  statusScriptPath(id: string) {
    return join(this.home, 'releases', id, 'status-script');
  }
  /** Fixed receipt location a `local-script` release writes and reconciliation reads. */
  receiptPath(id: string) {
    return join(this.home, 'releases', id, 'receipt.json');
  }
  /**
   * A project-relative path to a regular file inside the project, small enough for a human to read
   * before approving. `file()` resolves symlinks first, so a link pointing outside is rejected.
   */
  projectScript(scope: Scope, value: unknown, field: string) {
    const { project } = this.scope(scope);
    const file = this.file(scope, value, scriptLimit);
    const path = relative(realpathSync(project.path), file.actual);
    if (!path || path.startsWith('..') || isAbsolute(path)) throw new APIError(403, `${field} 必须是项目内的脚本文件`);
    return { path, bytes: file.bytes, sha256: digest(file.bytes) };
  }
  /** Compares one sealed file with the digest bound into `reviewHash`; a mismatch executes nothing. */
  sealedDigest(path: string, expected: string, label: string) {
    let actual: string;
    try {
      actual = digest(readFileSync(path));
    } catch {
      return `${label}已丢失，需要重新准备发布`;
    }
    return actual === expected ? undefined : `${label}校验失败，需要重新准备发布`;
  }
  sealedScriptError(row: Release) {
    if (row.target.kind !== 'local-script') return undefined;
    return (
      this.sealedDigest(this.scriptPath(row.id), row.target.scriptSha256, '封存发布脚本') ||
      (row.target.statusScriptSha256
        ? this.sealedDigest(this.statusScriptPath(row.id), row.target.statusScriptSha256, '封存状态脚本')
        : undefined)
    );
  }
  /** The sealed script text a human reads before approving; the agent grant cannot reach this route. */
  scriptText(id: string): ReleaseScript {
    const row = this.release(id);
    if (row.target.kind !== 'local-script') throw new APIError(409, '该发布不使用本地脚本目标');
    const read = (path: string, relativePath: string, expected: string, label: string) => {
      const mismatch = this.sealedDigest(path, expected, label);
      if (mismatch) throw new APIError(409, mismatch);
      const bytes = readFileSync(path);
      if (bytes.length > scriptLimit) throw new APIError(409, `${label}超过 ${scriptLimit} 字节`);
      return { path: relativePath, sha256: expected, bytes: bytes.length, text: bytes.toString('utf8') };
    };
    const target = row.target;
    return {
      releaseId: row.id,
      label: target.label,
      args: target.args,
      timeoutSeconds: target.timeoutSeconds,
      script: read(this.scriptPath(id), target.script, target.scriptSha256, '封存发布脚本'),
      ...(target.statusScript && target.statusScriptSha256
        ? {
            statusScript: read(
              this.statusScriptPath(id),
              target.statusScript,
              target.statusScriptSha256,
              '封存状态脚本'
            ),
          }
        : {}),
    };
  }
  propose(scope: Scope, input: Record<string, any>, key: string): Release {
    keys(input, [
      'itemIds',
      'title',
      'changes',
      'rationale',
      'expectedBenefit',
      'checks',
      'risks',
      'rollback',
      'observationPlan',
      'artifactPath',
      'target',
    ]);
    const itemIds = list(input.itemIds, 'itemIds');
    if (!itemIds.length) throw new APIError(400, '发布至少关联一个 feature');
    for (const id of itemIds) this.item(scope, id, false);
    // Each item keeps the review made at the version it changed; the candidate itself is reviewed once.
    const verificationIds = [...new Set(itemIds.map((id) => this.verification.requirePassedEver(scope, id).id))];
    const releaseVerificationId = this.verification.requireReleasePassed(scope, itemIds).id;
    if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > 30)
      throw new APIError(400, '请提供发布验证结果');
    const checks: Release['checks'] = input.checks.map((v: unknown) => {
      const check = object(v);
      keys(check, ['name', 'result', 'evidenceIds']);
      return {
        name: text(check.name, 'name', 300),
        result: choice(check.result, 'result', ['passed', 'not_verified'] as const),
        evidenceIds: this.refs(scope, check.evidenceIds),
      };
    });
    if (
      !checks.some(
        (c) =>
          c.result === 'passed' &&
          c.evidenceIds.some((id) => this.store.get<Evidence>('loop_evidence', id)?.origin !== 'agent')
      )
    )
      throw new APIError(400, '至少一项通过的检查需要实际文件或 HTTP 采集证据');
    const target = object(input.target);
    const kind =
      target.kind === undefined ? 'http' : choice(target.kind, 'target.kind', ['http', 'local-script'] as const);
    // Sealed copies are written after the release id exists; nothing runs at proposal time.
    const sealedScripts: Array<{ status: boolean; bytes: Buffer }> = [];
    let stored: Release['target'];
    if (kind === 'local-script') {
      keys(target, ['kind', 'label', 'script', 'args', 'timeoutSeconds', 'statusScript']);
      const script = this.projectScript(scope, target.script, 'script');
      const status =
        target.statusScript === undefined ? undefined : this.projectScript(scope, target.statusScript, 'statusScript');
      sealedScripts.push({ status: false, bytes: script.bytes });
      if (status) sealedScripts.push({ status: true, bytes: status.bytes });
      stored = {
        kind: 'local-script',
        label: text(target.label, 'label', 100),
        script: script.path,
        scriptSha256: script.sha256,
        args: scriptArgs(target.args),
        // A short cap keeps the timeout test fast; the sealed contract keeps whatever the agent set.
        timeoutSeconds: integer(
          target.timeoutSeconds,
          'timeoutSeconds',
          process.env.MORROW_TEST_MODE === '1' ? 1 : 30,
          3600
        ),
        ...(status ? { statusScript: status.path, statusScriptSha256: status.sha256 } : {}),
      };
    } else {
      keys(target, ['kind', 'url', 'statusUrl', 'label']);
      stored = {
        ...(target.kind === undefined ? {} : { kind: 'http' as const }),
        url: endpoint(target.url),
        statusUrl: endpoint(target.statusUrl),
        label: text(target.label, 'label', 200),
      };
    }
    const file = this.file(scope, input.artifactPath, 8 * 1024 * 1024);
    const id = digest(key).slice(0, 32);
    const existing = this.store.get<Release>('loop_releases', id);
    if (existing) return existing;
    const contents = {
      projectId: scope.projectId,
      channelId: scope.channelId,
      runId: scope.runId,
      itemIds,
      title: text(input.title, 'title', 300),
      changes: text(input.changes, 'changes', 20000),
      rationale: text(input.rationale, 'rationale'),
      expectedBenefit: text(input.expectedBenefit, 'expectedBenefit'),
      checks,
      verificationIds,
      releaseVerificationId,
      risks: text(input.risks, 'risks'),
      rollback: text(input.rollback, 'rollback'),
      observationPlan: text(input.observationPlan, 'observationPlan'),
      artifact: { name: basename(file.actual), sha256: digest(file.bytes), bytes: file.bytes.length },
      target: stored,
    };
    const directory = join(this.home, 'releases', id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(this.artifactPath(id), file.bytes, { mode: 0o600 });
    for (const entry of sealedScripts) {
      const path = entry.status ? this.statusScriptPath(id) : this.scriptPath(id);
      writeFileSync(path, entry.bytes, { mode: 0o700 });
      chmodSync(path, 0o700);
    }
    const row: Release = {
      id,
      ...contents,
      reviewHash: digest(JSON.stringify(contents)),
      status: 'awaiting_approval',
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.transaction(() => {
      this.store.put('loop_releases', row);
      for (const itemId of itemIds)
        this.audit(scope, 'release.proposed', `待上线确认：${row.title}`, itemId, {
          releaseId: id,
          reviewHash: row.reviewHash,
        });
    });
    return row;
  }
  review(id: string, hash: string, decision: 'approve' | 'reject', feedback = ''): Release {
    const row = this.release(id);
    if (row.reviewHash !== hash) throw new APIError(409, '待发布内容已变化，请重新查看');
    if (decision === 'approve' && ['approved', 'publishing', 'published', 'unknown'].includes(row.status)) return row;
    if (decision === 'reject' && row.status === 'rejected') return row;
    if (row.status !== 'awaiting_approval') throw new APIError(409, '该版本已经处理');
    // A new publication would start work the switch is waiting to finish; declining one never does.
    if (decision === 'approve') this.upgrade?.require('切换完成后再确认上线，本次确认尚未记录');
    if (decision === 'approve') {
      if (digest(readFileSync(this.artifactPath(id))) !== row.artifact.sha256)
        throw new APIError(409, '封存产物校验失败，需要重新准备发布');
      const mismatch = this.sealedScriptError(row);
      if (mismatch) throw new APIError(409, mismatch);
    }
    const updated: Release = {
      ...row,
      status: decision === 'approve' ? 'approved' : 'rejected',
      feedback,
      updatedAt: now(),
      ...(decision === 'approve' ? { approvedAt: now() } : {}),
    };
    this.store.transaction(() => {
      this.store.put('loop_releases', updated);
      for (const itemId of row.itemIds)
        this.audit(
          row,
          decision === 'approve' ? 'release.approved' : 'release.rejected',
          decision === 'approve' ? `已确认上线：${row.title}` : `暂不上线：${feedback || row.title}`,
          itemId,
          { releaseId: id, reviewHash: hash },
          'human'
        );
    });
    if (decision === 'approve') this.track(this.publish(id));
    else this.signal(row.channelId, id, '发布未获确认，读取意见并调整');
    return updated;
  }
  track(promise: Promise<unknown>) {
    this.pending.add(promise);
    void promise.catch(() => {}).finally(() => this.pending.delete(promise));
  }
  async publish(id: string) {
    // While a switch is on its way, an approved publication keeps waiting: the new daemon publishes
    // it after the restart instead of starting a release script that would extend the wait.
    if (this.closed || this.inFlight.has(id) || this.upgrade?.draining()) return;
    const row = this.release(id);
    if (row.status !== 'approved') return;
    this.inFlight.add(id);
    try {
      const bytes = readFileSync(this.artifactPath(id));
      const sealError =
        digest(bytes) !== row.artifact.sha256 ? '封存产物校验失败，未发送发布请求' : this.sealedScriptError(row);
      if (sealError) {
        this.store.put('loop_releases', { ...row, status: 'failed', error: sealError, updatedAt: now() });
        for (const itemId of row.itemIds)
          this.audit(row, 'release.failed', `未执行上线：${sealError}`, itemId, { releaseId: id }, 'system');
        return;
      }
      this.store.put('loop_releases', { ...row, status: 'publishing', updatedAt: now() });
      if (row.target.kind === 'local-script') {
        for (const itemId of row.itemIds)
          this.audit(
            row,
            'release.publishing',
            `开始执行封存的发布脚本：${row.target.script}`,
            itemId,
            { releaseId: id, script: row.target.script, args: row.target.args },
            'system'
          );
        this.receipt(
          id,
          await this.runSealed(row, {
            script: this.scriptPath(id),
            args: row.target.args,
            timeoutSeconds: row.target.timeoutSeconds,
            storeLog: true,
          })
        );
        return;
      }
      const { data } = await jsonRequest(row.target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': row.id },
        body: JSON.stringify({
          releaseId: row.id,
          reviewHash: row.reviewHash,
          artifact: { ...row.artifact, base64: bytes.toString('base64') },
        }),
      });
      this.receipt(id, data);
    } catch (error) {
      this.store.put('loop_releases', {
        ...this.release(id),
        status: 'unknown',
        error: `发布结果待核对：${error instanceof Error ? error.message : '连接中断'}；不会重复发送。`,
        updatedAt: now(),
      });
      this.signal(row.channelId, id, '发布结果待核对');
    } finally {
      this.inFlight.delete(id);
    }
  }
  /**
   * Runs one sealed script and returns the receipt JSON parsed from its last non-empty stdout line.
   * The environment holds only the fixed keys below: never the service token, never the rest of
   * `process.env`. `TMPDIR` is the single optional key, forwarded only when the service itself has
   * one, so build tools and tests under the script write their temporary files where the service
   * does instead of falling back to `/tmp`. A non-zero exit, unparsable output or the timeout
   * throws, so the caller records an unconfirmed outcome exactly like a lost HTTP response instead
   * of running anything again.
   */
  async runSealed(
    row: Release,
    options: { script: string; args: string[]; timeoutSeconds: number; storeLog: boolean }
  ): Promise<unknown> {
    const project = this.store.get<Project>('projects', row.projectId);
    if (!project) throw new Error('项目已不存在，未执行发布脚本');
    const cache = join(this.home, 'runtime-cache');
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const child = spawn(options.script, options.args, {
      cwd: project.path,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME || homedir(),
        NO_COLOR: '1',
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        MORROW_RELEASE_ID: row.id,
        MORROW_ARTIFACT_PATH: this.artifactPath(row.id),
        MORROW_ARTIFACT_SHA256: row.artifact.sha256,
        MORROW_REVIEW_HASH: row.reviewHash,
        MORROW_PROJECT_PATH: project.path,
        MORROW_RECEIPT_PATH: this.receiptPath(row.id),
        MORROW_RUNTIME_CACHE: cache,
      },
    });
    // Combined output, capped at 1 MiB with the tail kept; stdout is re-read separately for the receipt.
    const chunks: Array<{ out: boolean; data: Buffer }> = [];
    let bytes = 0;
    const collect = (out: boolean) => (data: Buffer) => {
      chunks.push({ out, data });
      bytes += data.length;
      while (bytes > logLimit && chunks.length) {
        const excess = bytes - logLimit;
        if (chunks[0].data.length <= excess) {
          bytes -= chunks[0].data.length;
          chunks.shift();
        } else {
          chunks[0] = { out: chunks[0].out, data: chunks[0].data.subarray(excess) };
          bytes -= excess;
        }
      }
    };
    child.stdout.on('data', collect(true));
    child.stderr.on('data', collect(false));
    let timedOut = false;
    const stop = (signal: 'SIGTERM' | 'SIGKILL') => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {}
    };
    let escalation: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      escalation = setTimeout(() => stop('SIGKILL'), 5000);
      escalation.unref();
    }, options.timeoutSeconds * 1000);
    timer.unref();
    type Outcome = { code: number | null; signal: string | null; failure?: string; abandoned?: boolean };
    const outcome = await new Promise<Outcome>((resolve) => {
      let settled = false;
      // The script is detached on purpose: a service shutdown stops waiting for it and leaves the
      // release unconfirmed, so a restart reconciles instead of publishing anything a second time.
      const shutdown = setInterval(() => {
        if (this.closed) settle({ code: null, signal: null, failure: '服务已关闭，发布结果待核对', abandoned: true });
      }, 200);
      shutdown.unref();
      const settle = (value: Outcome) => {
        if (settled) return;
        settled = true;
        clearInterval(shutdown);
        resolve(value);
      };
      child.once('error', (e) => settle({ code: null, signal: null, failure: `发布脚本未能启动：${e.message}` }));
      child.once('close', (code, signal) => settle({ code, signal }));
      // A stray grandchild outside the group can hold the pipes open after the script itself exited;
      // prefer the complete output, but never wait for it indefinitely.
      child.once('exit', (code, signal) => setTimeout(() => settle({ code, signal }), 2000).unref());
    });
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    const pipes = [child.stdout, child.stderr] as unknown as Array<{ unref?: () => void; destroy(): void }>;
    // A script that outlives the service keeps its pipes so it does not take a SIGPIPE; either way
    // they stop holding this event loop open.
    for (const pipe of pipes)
      if (outcome.abandoned) pipe.unref?.();
      else pipe.destroy();
    child.unref();
    const log = this.redact(Buffer.concat(chunks.map((entry) => entry.data)).toString('utf8'));
    if (options.storeLog) this.store.put('loop_releases', { ...this.release(row.id), log, updatedAt: now() });
    if (outcome.failure) throw new Error(outcome.failure);
    if (timedOut) throw new Error(`发布脚本超过 ${options.timeoutSeconds} 秒未结束，已停止其进程组`);
    if (outcome.code !== 0)
      throw new Error(`发布脚本退出码 ${outcome.code ?? '未知'}${outcome.signal ? `（${outcome.signal}）` : ''}`);
    const line = this.redact(Buffer.concat(chunks.filter((e) => e.out).map((e) => e.data)).toString('utf8'))
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
      .at(-1);
    if (!line) throw new Error('发布脚本没有输出回执 JSON');
    try {
      return JSON.parse(line);
    } catch {
      throw new Error('发布脚本最后一行不是有效的回执 JSON');
    }
  }
  /**
   * How a local publication reports itself: the fixed receipt file first, then the sealed status
   * script (60 s, the same fixed environment and no argv). Neither available keeps the outcome unknown.
   */
  async localOutcome(row: Release): Promise<unknown> {
    if (row.target.kind !== 'local-script') throw new Error('该发布不是本地脚本目标');
    const path = this.receiptPath(row.id);
    if (existsSync(path)) {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > receiptLimit) throw new Error('回执文件不是有界的普通文件');
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        throw new Error('回执文件不是有效的 JSON');
      }
    }
    if (!row.target.statusScript || !row.target.statusScriptSha256)
      throw new Error('尚无回执文件，也没有可核对的状态脚本');
    const mismatch = this.sealedDigest(this.statusScriptPath(row.id), row.target.statusScriptSha256, '封存状态脚本');
    if (mismatch) throw new Error(mismatch);
    return this.runSealed(row, {
      script: this.statusScriptPath(row.id),
      args: [],
      timeoutSeconds: 60,
      storeLog: false,
    });
  }
  receipt(id: string, data: any) {
    const row = this.release(id);
    if (
      data?.releaseId !== id ||
      data?.artifactSha256 !== row.artifact.sha256 ||
      !['published', 'failed'].includes(data?.status)
    )
      throw new Error('回执未确认同一发布版本');
    // What a local publication installed, kept only when it is usable: an unreadable or malformed
    // value is dropped, so it can never be mistaken for a version this service could switch to.
    const installedBundle =
      typeof data.installedBundle === 'string' &&
      isAbsolute(data.installedBundle) &&
      data.installedBundle.length <= 4096 &&
      !data.installedBundle.includes('\0')
        ? data.installedBundle
        : undefined;
    const buildFingerprint = isFingerprint(data.buildFingerprint) ? data.buildFingerprint : undefined;
    const result: Release = {
      ...row,
      status: data.status,
      publishedAt: data.status === 'published' ? now() : undefined,
      publishedUrl: typeof data.url === 'string' ? endpoint(data.url) : undefined,
      error: data.status === 'failed' ? '发布端报告失败，尚未上线' : undefined,
      installedBundle,
      buildFingerprint,
      updatedAt: now(),
    };
    // One transaction: the published release, its audit trail and any request to switch this service
    // to the build it just installed are stored together or not at all.
    this.store.transaction(() => {
      this.store.put('loop_releases', result);
      const requested =
        result.status === 'published' && installedBundle && buildFingerprint
          ? this.upgrade?.consider(result, { ...data, installedBundle, buildFingerprint })
          : undefined;
      for (const itemId of row.itemIds)
        this.audit(
          row,
          `release.${result.status}`,
          result.status === 'published' ? `已上线，继续观察：${row.title}` : `上线失败：${row.title}`,
          itemId,
          { releaseId: id, receipt: data },
          'system'
        );
      if (requested)
        this.audit(
          row,
          'upgrade.requested',
          `新版本已安装，将在当前工作结束后自动切换（目标 ${requested.targetFingerprint.slice(0, 12)}）`,
          undefined,
          { releaseId: id, targetFingerprint: requested.targetFingerprint, targetCommit: requested.targetCommit },
          'system'
        );
    });
    this.signal(
      row.channelId,
      id,
      result.status === 'published' ? '已上线，读取实际回执并观察效果' : '上线失败，调查回执'
    );
    return result;
  }
  async reconcile(id: string) {
    const row = this.release(id);
    if (!['unknown', 'publishing'].includes(row.status) || this.inFlight.has(id) || this.upgrade?.draining())
      return row;
    this.inFlight.add(id);
    try {
      if (row.target.kind === 'local-script') return this.receipt(id, await this.localOutcome(row));
      const url = new URL(row.target.statusUrl);
      url.searchParams.set('releaseId', id);
      const { data } = await jsonRequest(url.href);
      return this.receipt(id, data);
    } catch (error) {
      const result = {
        ...this.release(id),
        status: 'unknown' as const,
        error: `仍未确认发布结果：${error instanceof Error ? error.message : '查询失败'}`,
        updatedAt: now(),
      };
      this.store.put('loop_releases', result);
      return result;
    } finally {
      this.inFlight.delete(id);
    }
  }
  signal(channelId: string, sourceId: string, reason: string) {
    this.strategy.sourceChanged(sourceId, reason);
    const channels = new Set([channelId]);
    for (const wait of this.store.all<Wait>('loop_waits'))
      if (wait.status === 'waiting' && [...wait.watchIds, ...wait.releaseIds].includes(sourceId)) {
        this.store.put('loop_waits', { ...wait, status: 'ready', event: reason });
        channels.add(wait.id);
      }
    for (const id of channels) this.wake(id, reason);
  }
  wake(channelId: string, reason: string) {
    const channel = this.store.get<Channel>('channels', channelId);
    if (!channel || !this.store.get<Control>('controls', channelId)?.enabled) return;
    if (channel.status === 'running') {
      this.store.put('channels', {
        ...channel,
        pendingWake: { reason: this.redact(reason).slice(0, 1000), at: now() },
      });
      return;
    }
    this.store.put('channels', { ...channel, status: 'waiting', nextRunAt: new Date(Date.now() + 5000).toISOString() });
  }
  finish(run: Run) {
    const wait = this.store.get<Wait>('loop_waits', run.channelId);
    if (!wait || wait.runId !== run.id) return;
    const c = this.store.get<Channel>('channels', run.channelId)!;
    if (run.workDirection !== undefined && run.workDirection !== c.goal) return;
    if (!this.store.get<Control>('controls', c.id)?.enabled) return;
    const ready =
      wait.status === 'ready' ||
      wait.deadline <= now() ||
      wait.watchIds.some((id) => this.store.get<FeedbackWatch>('loop_watches', id)?.status !== 'watching') ||
      wait.releaseIds.some((id) => ['published', 'rejected', 'failed', 'unknown'].includes(this.release(id).status));
    this.store.put('channels', {
      ...c,
      status: 'waiting',
      nextRunAt: ready ? new Date(Date.now() + 5000).toISOString() : wait.deadline,
      work: {
        state: 'wait',
        focus: c.work?.focus || '跟踪工作结果',
        reason: wait.reason,
        nextStep: ready ? wait.event || '已收到变化，评估下一步' : wait.reason,
        runId: run.id,
        updatedAt: now(),
        awaitingReply: false,
      },
    });
  }
  /**
   * When a watch is polled again, or nothing at all: a watch that reached a terminal state and is
   * not continuous is never polled again, and `poll` refuses it, so it must not keep a poll time the
   * tick's `(status, nextPollAt)` ranges would hand back on every tick for the rest of the project's
   * life. The field is left out rather than emptied — `''` compares before every timestamp, so it
   * would fall inside every `nextPollAt<=?` range instead of outside all of them.
   */
  pollAgainAt(watch: FeedbackWatch, status: FeedbackWatch['status']): { nextPollAt?: string } {
    return status !== 'watching' && watch.continuous === false
      ? { nextPollAt: undefined }
      : { nextPollAt: new Date(Date.now() + watch.intervalSeconds * 1000).toISOString() };
  }
  async poll(id: string) {
    if (this.closed || this.inFlight.has(id)) return;
    const watch = this.store.get<FeedbackWatch>('loop_watches', id);
    if (!watch || watch.status === 'cancelled' || (watch.status !== 'watching' && watch.continuous === false)) return;
    if (watch.status === 'watching' && watch.deadline <= now()) {
      this.store.put('loop_watches', {
        ...watch,
        status: 'expired',
        ...this.pollAgainAt(watch, 'expired'),
        updatedAt: now(),
      });
      this.signal(watch.channelId, id, '观察已到复查时间，证据仍不足时不要宣称有效；持续监测仍接收后续变化');
      return;
    }
    if (watch.releaseId && this.release(watch.releaseId).status !== 'published') return;
    this.inFlight.add(id);
    try {
      const sample =
        watch.kind === 'file'
          ? readWatchFile(this.store.get<Project>('projects', watch.projectId)!.path, watch.path, watch.pointer)
          : await jsonRequest(watch.url);
      if (!sample) {
        const current = this.store.get<FeedbackWatch>('loop_watches', id)!;
        if (current.status !== 'cancelled')
          this.store.put('loop_watches', {
            ...current,
            missing: true,
            error: undefined,
            ...this.pollAgainAt(watch, current.status),
            updatedAt: now(),
          });
        return;
      }
      const { data, hash } = sample;
      const value = valueAt(data, watch.pointer);
      if (value === undefined) throw new Error('数据中不存在指定字段');
      const valueHash =
        watch.kind === 'file' ? (watch.pointer ? fileValueDigest(value) : hash) : digest(JSON.stringify(value));
      // Older file watches stored a whole-file digest even with a pointer. Use
      // their saved value so switching comparison methods does not create a wakeup.
      const previousDigest =
        watch.kind === 'file' && watch.pointer && watch.lastDigest && watch.lastValue !== undefined
          ? fileValueDigest(watch.lastValue)
          : watch.lastDigest;
      const changed = previousDigest !== valueHash;
      let evidenceId = watch.lastEvidenceId;
      if (changed || watch.error || this.strategy.needsObservation(watch, data)) {
        const e: Evidence = {
          id: randomUUID(),
          projectId: watch.projectId,
          channelId: watch.channelId,
          runId: watch.runId,
          itemId: watch.itemId,
          watchId: id,
          summary: `${watch.title}：收到实际反馈`,
          source: watch.kind === 'file' ? watch.path : watch.url,
          observedAt: now(),
          createdAt: now(),
          origin: watch.kind === 'file' ? 'file' : 'http',
          ...(watch.kind === 'file' ? { pointer: watch.pointer, value } : {}),
          data,
          digest: hash,
        };
        this.store.transaction(() => {
          this.store.put('loop_evidence', e);
          this.linkEvidence(e);
          this.strategy.evidenceObserved(e);
        });
        evidenceId = e.id;
        this.audit(watch, 'feedback.observed', e.summary, watch.itemId, { evidenceId: e.id, watchId: id }, 'system');
      }
      const met =
        watch.condition === 'changed'
          ? (!!watch.lastDigest || (watch.kind === 'file' && watch.initiallyMissing === true)) && changed
          : watch.condition === 'equals'
            ? value === watch.expected
            : typeof value === 'number' &&
              Number.isFinite(value) &&
              (watch.condition === 'gte' ? value >= Number(watch.expected) : value <= Number(watch.expected));
      const current = this.store.get<FeedbackWatch>('loop_watches', id)!;
      if (current.status === 'cancelled') return;
      const status = current.status === 'watching' ? (met ? 'triggered' : 'watching') : current.status;
      this.store.put('loop_watches', {
        ...current,
        lastValue: value,
        lastDigest: valueHash,
        lastEvidenceId: evidenceId,
        error: undefined,
        missing: false,
        status,
        updatedAt: now(),
        ...this.pollAgainAt(watch, status),
      });
      if (watch.error) this.signal(watch.channelId, id, `反馈来源已恢复：${watch.title}`);
      if (current.status === 'watching' ? met : !!watch.lastDigest && changed)
        this.signal(watch.channelId, id, `收到新的反馈：${watch.title}`);
    } catch (error) {
      const current = this.store.get<FeedbackWatch>('loop_watches', id)!;
      if (current.status !== 'cancelled') {
        const message = error instanceof Error ? error.message : '反馈查询失败';
        this.store.put('loop_watches', {
          ...current,
          error: message,
          updatedAt: now(),
          ...this.pollAgainAt(watch, current.status),
        });
        if (current.error !== message) {
          this.audit(
            watch,
            'feedback.unavailable',
            `反馈暂不可用：${watch.title} · ${message}`,
            watch.itemId,
            undefined,
            'system'
          );
          this.signal(watch.channelId, id, `反馈暂不可用，检查数据来源：${watch.title}`);
        }
      }
    } finally {
      this.inFlight.delete(id);
    }
  }
  tick() {
    if (this.closed) return;
    this.verification.tick();
    const time = now();
    // A tick asks for the few rows in a state that needs work, never for the whole table: these two
    // run once a second for as long as a project is open.
    for (const row of this.store.byStatus<Release>('loop_releases', ['approved', 'unknown'])) {
      if (row.status === 'approved') this.track(this.publish(row.id));
      else if (row.status === 'unknown' && Date.parse(row.updatedAt) < Date.now() - 60000)
        this.track(this.reconcile(row.id));
    }
    // A watch's due condition mixes two ranges, which no single index answers, so each state asks
    // `loop_watches_status_next` for its own range: a watch still being watched is due by its poll
    // time or by its deadline, and there are at most 50 of those per project; one already triggered
    // or expired is due only by its poll time, so the terminal rows a long-lived project piles up
    // are bounded by that range rather than read whole. `cancelled` is never read at all, and a row
    // written before `status` existed stays pollable as it was. Same rows, same order as the scan
    // this replaces; only the rows actually due are parsed and turned into objects.
    const rows = this.store.db
      .prepare(
        `SELECT data FROM (
           SELECT rowid AS rid, data FROM loop_watches
             WHERE json_extract(data,'$.status')='watching'
               AND (json_extract(data,'$.nextPollAt')<=? OR json_extract(data,'$.deadline')<=?)
           UNION ALL
           SELECT rowid AS rid, data FROM loop_watches
             WHERE (json_extract(data,'$.status') IN ('triggered','expired')
                 OR json_extract(data,'$.status') IS NULL)
               AND json_extract(data,'$.nextPollAt')<=?
         ) ORDER BY rid`
      )
      .all(time, time, time);
    const due = parseRows<FeedbackWatch>(rows);
    for (const watch of due)
      if (
        this.inFlight.size < 4 &&
        this.store.get<Control>('controls', watch.channelId)?.enabled &&
        (watch.status === 'watching' || watch.continuous !== false)
      )
        this.track(this.poll(watch.id));
  }
  recover() {
    this.executions.recover();
    this.verification.recover();
    for (const row of this.store.all<Release>('loop_releases'))
      if (row.status === 'publishing')
        this.store.put('loop_releases', {
          ...row,
          status: 'unknown',
          error: '服务重启，先核对发布回执，不重复发送',
          updatedAt: now(),
        });
    if (!this.store.get('migrations', 'loop-evidence-links-v1'))
      this.store.transaction(() => {
        for (const evidence of this.store.all<Evidence>('loop_evidence')) this.linkEvidence(evidence);
        this.store.put('migrations', { id: 'loop-evidence-links-v1', createdAt: now() });
      });
  }
  async close() {
    this.closed = true;
    this.verification.close();
    await Promise.allSettled([...this.pending]);
  }
}
