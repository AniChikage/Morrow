export type ChannelWork = {
  state: 'continue' | 'wait' | 'needs_input';
  focus: string;
  reason: string;
  nextStep: string;
  waitMinutes?: number;
  runId: string;
  updatedAt: string;
  awaitingReply: boolean;
};
export const engines = ['codex'] as const;
/** Runtimes that older databases may still reference. Their records stay readable but never execute. */
export const legacyEngines = ['claude', 'trae'] as const;
export const itemStatuses = ['open', 'investigating', 'verified', 'resolved', 'blocked'] as const;
export const itemKinds = ['feature', 'issue', 'opportunity', 'hypothesis'] as const;
export type RuntimeID = (typeof engines)[number];
export type LegacyRuntimeID = (typeof legacyEngines)[number];
export type AnyRuntimeID = RuntimeID | LegacyRuntimeID;
export const isLegacyRuntime = (value: string): value is LegacyRuntimeID =>
  (legacyEngines as readonly string[]).includes(value);
/** Account rate-limit windows Codex reports: a rolling five-hour window and a weekly one. */
export const usageWindows = ['5h', 'weekly'] as const;
export type UsageWindow = (typeof usageWindows)[number];
export type UsageWindowReading = { name: UsageWindow; usedPercent: number; resetsAt?: string; windowMinutes?: number };
/** One account reading. `protocol` readings come straight from the shared backend; `native-tool` is reserved for a later fallback. */
export type UsageReading = { at: string; source: 'protocol' | 'native-tool'; windows: UsageWindowReading[] };
export type UsageSample = UsageReading & {
  id: string;
  phase: 'before' | 'after' | 'poll';
  projectId?: string;
  channelId?: string;
  runId?: string;
};
/** Project-level cap on the usage Morrow attributes to this project's runs; an estimate, since the account is shared. */
export type UsageBudget = { window: UsageWindow; limitPercent: number };
/** Global line kept for the user's own work; compared against the exact account reading. */
export type UsageReserve = { window: UsageWindow; keepPercent: number };
export type Settings = { id: 'global'; usageReserve?: UsageReserve; stopWhenUsageUnknown?: boolean; updatedAt: string };
/** Usage attributed to one run: the account readings around it and their per-window difference. */
export type RunUsage = {
  before?: UsageReading;
  after?: UsageReading;
  delta?: Partial<Record<UsageWindow, number>>;
  attribution: 'estimated';
};
/** Why a channel is waiting on usage rather than on its own schedule. */
export type UsageWait = {
  kind: 'budget' | 'reserve' | 'unknown';
  window?: UsageWindow;
  resetsAt?: string;
  since: string;
};
/**
 * The latest account reading as the UI sees it; `stale` when older than the freshness window or past
 * its reset. `attempted` separates "no read has been tried yet" from "a read was tried and produced
 * nothing", and `lastError` carries the redacted reason of the most recent failed attempt.
 */
export type UsageStatus = { reading?: UsageReading; stale: boolean; attempted: boolean; lastError?: string };
export type Project = {
  id: string;
  name: string;
  path: string;
  goal: string;
  /** The user's own written requirements (Markdown, at most 64 KiB). Read by every turn, never edited by the agent. */
  brief?: string;
  /** Counts saved goal/brief versions; missing on rows written before the brief existed and treated as 0. */
  briefRevision?: number;
  usageBudget?: UsageBudget;
  createdAt: string;
  isDemo: boolean;
  runtime: AnyRuntimeID;
};
export const projectBriefLimit = 65536;
/** One row per saved goal/brief version; the human is the only author. */
export type ProjectBriefRevision = {
  id: string;
  projectId: string;
  revision: number;
  goal: string;
  brief: string;
  updatedAt: string;
  actor: 'human';
};
/**
 * What this channel's bound native task was last told as its long-lived charter (role, goal, brief,
 * direction, rules), so later turns can send only a short note. `hash` digests the charter text;
 * `turnsSince` counts the turns delivered under it, including the turn that carried it.
 */
export type PromptCharter = { threadId: string; hash: string; sentAt: string; turnsSince: number };
export type Channel = {
  work?: ChannelWork;
  /** A bounded latest signal received while this channel's scheduled turn was running. */
  pendingWake?: { reason: string; at: string };
  promptCharter?: PromptCharter;
  autonomyEnabled?: boolean;
  id: string;
  projectId: string;
  name: string;
  goal: string;
  runtime: AnyRuntimeID;
  model: string;
  status: string;
  intervalMinutes: number;
  maxRunsPerDay: number;
  permission: 'read-only' | 'workspace-write' | 'native';
  nextRunAt: string;
  lastRunAt: string;
  sessionId: string;
  usageWait?: UsageWait;
};
export type WorkItem = {
  id: string;
  projectId: string;
  number: number;
  /** Who opened the item. Older rows are inferred once from their `item.created` audit event. */
  origin?: 'human' | 'agent';
  /**
   * The channel responsible for this item right now; absent means 无人负责. A channel claims an
   * unowned item by advancing it through the work interface and releases it once it is resolved; a
   * human assigns or releases it through `PATCH /api/items/:id`. Only the owner (or nobody) may
   * advance it, so two channels of one project cannot work on the same item.
   */
  ownerChannelId?: string;
  channelId: string;
  sourceChannelIds: string[];
  lastRunId: string;
  revision: number;
  title: string;
  summary: string;
  status: string;
  kind: string;
  evidence: string[];
  nextStep: string;
  createdAt: string;
  updatedAt: string;
};
/**
 * What one scheduled turn left in the project's shared working tree, read with `git status` when the
 * turn is finalized. `unknown` marks a reading that could not be taken (no repository, git failure),
 * which never blocks another channel.
 */
export type TreeState = { dirty: boolean; files: string[]; unknown?: boolean };
export type Run = {
  workDirection?: string;
  /** The working tree as this turn left it; absent on rows written before it was recorded. */
  treeState?: TreeState;
  id: string;
  projectId: string;
  channelId: string;
  runtime: AnyRuntimeID;
  model: string;
  permission: 'read-only' | 'workspace-write' | 'native';
  executionOwner?: 'cli' | 'codex-app';
  nativeTurnId?: string;
  nativeItemRevisions?: Record<string, number>;
  source?: 'morrow-schedule' | 'morrow-chat' | 'nohuman-schedule' | 'nohuman-chat' | 'native-app';
  trigger: 'manual' | 'schedule';
  resumedFromSessionId: string;
  reportStatus: 'pending' | 'valid' | 'missing' | 'invalid' | 'conflict';
  reportError: string;
  exitCode?: number;
  signal?: string;
  usage?: RunUsage;
  status: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
  sessionId: string;
};
export type NativeConnectionStatus = {
  available: boolean;
  connected: boolean;
  detail: string;
  /** The Codex App bundle is present on the machine running the service. */
  appInstalled?: boolean;
  /** Version of the installed Codex App bundle, when it can be read. */
  appVersion?: string;
  /** Version the shared native backend reported in its handshake; known only once the bridge is in effect. */
  runtimeVersion?: string;
  backgroundReady?: boolean;
  /** Legacy installation record; never authorizes installing the retired bridge. */
  backgroundConfigured?: boolean;
  connectionMode?: 'app-follower';
  boundThreadCount?: number;
  readyThreadCount?: number;
  restartRequired?: boolean;
  /** Latest account usage reading known to the service, when any. */
  usage?: UsageStatus;
  capabilities: { list: boolean; read: boolean; send: boolean; create: boolean; interrupt: boolean; respond: boolean };
};
export type NativeThreadSummary = {
  id: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt?: string;
  activeTurnId?: string;
  model?: string;
};
export type NativeItem = {
  autonomousContext?: boolean;
  id: string;
  turnId: string;
  type: string;
  role?: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  status?: string;
  createdAt?: string;
  input?: unknown;
  output?: unknown;
  raw: Record<string, unknown>;
};
export type NativeRequest = {
  id: string;
  type: string;
  turnId?: string;
  status: string;
  title?: string;
  raw: Record<string, unknown>;
};
export type NativeConversation = {
  canRecreateEmpty?: boolean;
  channelId: string;
  threadId?: string;
  status: NativeConnectionStatus;
  thread?: NativeThreadSummary;
  items: NativeItem[];
  requests: NativeRequest[];
  hasMore: boolean;
  cursor?: string;
  lastSyncedAt?: string;
  syncError?: string;
};
export type NativeMessageReceipt = {
  requestId: string;
  state: 'pending' | 'accepted' | 'unknown' | 'failed';
  turnId?: string;
  error?: string;
};
export type EventDetail = {
  type: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  sequence?: number;
  toolCallId?: string;
};
export type Event = {
  detail?: EventDetail;
  projectId: string;
  itemId?: string;
  actor?: 'human' | 'agent' | 'system';
  action?: string;
  changes?: { before?: unknown; after?: unknown };
  id: string;
  channelId: string;
  runId: string;
  kind: string;
  text: string;
  createdAt: string;
};
export type RunIO = {
  id: string;
  runId: string;
  stream: 'prompt' | 'stdout' | 'stderr' | 'final' | 'report';
  text: string;
  createdAt: string;
  sequence: number;
};
export type Runtime = {
  id: RuntimeID;
  name: string;
  available: boolean;
  path: string;
  version: string;
  detail: string;
  canWrite: boolean;
  /** The executable is the one bundled inside the installed Codex App. */
  bundled?: boolean;
  /** Version of the installed Codex App bundle, when it can be read. */
  appVersion?: string;
};
export type AgentResult = {
  summary: string;
  items: {
    id?: string;
    title: string;
    summary: string;
    status: string;
    kind: string;
    evidence: string[];
    nextStep: string;
  }[];
  nextCheckMinutes: number;
  knowledge: { text: string; source: string; confirmed: boolean }[];
  needsHuman: boolean;
};
export class APIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new APIError(400, '请求必须是 JSON 对象');
  return value as Record<string, any>;
}
export function keys(value: Record<string, any>, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k))) throw new APIError(400, '请求包含不支持的字段');
}
export function string(value: unknown, field: string, max = 10000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0'))
    throw new APIError(400, `${field} 格式无效`);
  return value.trim();
}
export function integer(value: unknown, field: string, min = 1, max = 1440): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new APIError(400, `${field} 必须在 ${min}–${max} 之间`);
  return value as number;
}
export function choice<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new APIError(400, `${field} 无效`);
  return value as T;
}
const stringSchema = { type: 'string' };
export const resultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'items', 'nextCheckMinutes', 'knowledge', 'needsHuman'],
  properties: {
    summary: stringSchema,
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'summary', 'status', 'kind', 'evidence', 'nextStep'],
        properties: {
          id: stringSchema,
          title: stringSchema,
          summary: stringSchema,
          status: { enum: itemStatuses },
          kind: { enum: itemKinds },
          evidence: { type: 'array', items: stringSchema },
          nextStep: stringSchema,
        },
      },
    },
    nextCheckMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
    knowledge: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'source', 'confirmed'],
        properties: {
          text: stringSchema,
          source: stringSchema,
          confirmed: { type: 'boolean' },
        },
      },
    },
    needsHuman: { type: 'boolean' },
  },
};
export function validateResult(value: unknown): AgentResult {
  const v = object(value);
  keys(v, ['summary', 'items', 'nextCheckMinutes', 'knowledge', 'needsHuman']);
  const summary = string(v.summary, 'summary', 20000);
  const nextCheckMinutes = integer(v.nextCheckMinutes, 'nextCheckMinutes');
  if (
    !Array.isArray(v.items) ||
    v.items.length > 100 ||
    !Array.isArray(v.knowledge) ||
    v.knowledge.length > 100 ||
    typeof v.needsHuman !== 'boolean'
  )
    throw new APIError(400, '结果结构无效');
  const seen = new Set<string>();
  const items = v.items.map((raw: unknown) => {
    const i = object(raw);
    keys(i, ['id', 'title', 'summary', 'status', 'kind', 'evidence', 'nextStep']);
    if (!Array.isArray(i.evidence) || i.evidence.length > 50) throw new APIError(400, 'evidence 必须为数组');
    const id = i.id === undefined ? '' : string(i.id, 'id', 100, true);
    if (id && seen.has(id)) throw new APIError(400, '结果包含重复事项 ID');
    if (id) seen.add(id);
    const status = choice(i.status, 'status', itemStatuses);
    const evidence = i.evidence.map((e: unknown) => string(e, 'evidence', 5000));
    if (['verified', 'resolved'].includes(status) && !evidence.length)
      throw new APIError(400, '已验证或已解决的事项必须提供证据');
    return {
      id,
      title: string(i.title, 'title', 300),
      summary: string(i.summary, 'summary', 10000, true),
      status,
      kind: choice(i.kind, 'kind', itemKinds),
      evidence,
      nextStep: string(i.nextStep, 'nextStep', 5000, true),
    };
  });
  const knowledge = v.knowledge.map((raw: unknown) => {
    const k = object(raw);
    keys(k, ['text', 'source', 'confirmed']);
    if (typeof k.confirmed !== 'boolean') throw new APIError(400, 'knowledge.confirmed 无效');
    return {
      text: string(k.text, 'knowledge.text', 10000),
      source: string(k.source, 'knowledge.source', 5000),
      confirmed: k.confirmed,
    };
  });
  return {
    summary,
    items,
    nextCheckMinutes,
    knowledge,
    needsHuman: v.needsHuman,
  };
}
export function parseResult(text: string): AgentResult {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  return validateResult(JSON.parse(cleaned));
}
