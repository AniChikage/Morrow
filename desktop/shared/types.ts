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
import type { ProjectLoop as ServiceProjectLoop, Release, ReleaseScript } from '../../service/autonomy-types';
export type {
  Release,
  ReleaseTarget,
  ReleaseScript,
  Evidence,
  Learning,
  FeedbackWatch,
} from '../../service/autonomy-types';
/**
 * The work page as `GET /api/projects/:id/work` sends it. `service/project-loop.ts` adds the two
 * source fields when the project's source version cannot be read at all — which is why no
 * verification can read as current — and `service/autonomy-types.ts` does not declare them.
 */
export type ProjectLoop = ServiceProjectLoop & { sourceStale?: boolean; sourceReason?: string };
export type { Understanding, StrategyDecision, DecisionView, StrategyView } from '../../service/strategy-types';
export type { UpgradeBlocker, UpgradePhase, UpgradeRecord, UpgradeState } from '../../service/upgrade';
/** Both handshake routes carry the boot they were issued for and the version they mean. */
export interface UpgradeHandshake {
  fromBootId: string;
  targetFingerprint: string;
}
export type RuntimeID = 'codex' | 'claude' | 'trae';
/** Account rate-limit windows Codex reports: a rolling five-hour window and a weekly one. */
export const usageWindows = ['5h', 'weekly'] as const;
export type UsageWindow = (typeof usageWindows)[number];
export interface UsageWindowReading {
  name: UsageWindow;
  usedPercent: number;
  resetsAt?: string;
  windowMinutes?: number;
}
export interface UsageReading {
  at: string;
  source: 'protocol' | 'native-tool';
  windows: UsageWindowReading[];
}
/** Project-level cap on the usage Morrow attributes to this project's runs (an estimate: the account is shared). */
export interface UsageBudget {
  window: UsageWindow;
  limitPercent: number;
}
/** Global line kept for the user's own work; compared against the exact account reading. */
export interface UsageReserve {
  window: UsageWindow;
  keepPercent: number;
}
export interface Settings {
  id: 'global';
  usageReserve?: UsageReserve;
  stopWhenUsageUnknown?: boolean;
  updatedAt: string;
}
export interface SettingsPatch {
  /** `null` clears the reserve line. */
  usageReserve?: UsageReserve | null;
  stopWhenUsageUnknown?: boolean;
}
export interface RunUsage {
  before?: UsageReading;
  after?: UsageReading;
  delta?: Partial<Record<UsageWindow, number>>;
  attribution: 'estimated';
}
/**
 * Why a channel is waiting on usage rather than on its own schedule. `account` is the provider's own
 * spent-quota message, which no rate-limit reading reports.
 */
export interface UsageWait {
  kind: 'budget' | 'reserve' | 'unknown' | 'account';
  window?: UsageWindow;
  resetsAt?: string;
  since: string;
}
/** The latest account reading; `stale` when older than ten minutes, past its reset, or absent. */
export interface UsageStatus {
  reading?: UsageReading;
  stale: boolean;
  /** Whether a read has been attempted at all since the service started: never read ≠ read and refused. */
  attempted?: boolean;
  /** Redacted reason of the most recent failed read, at most 200 characters. */
  lastError?: string;
}
export type UsageGate =
  | { blocked: false }
  | {
      blocked: true;
      kind: 'reserve' | 'budget' | 'unknown' | 'account';
      window?: UsageWindow;
      resetsAt?: string;
      until: string;
      pending?: boolean;
      message: string;
    };
/** `GET /api/projects/:id/usage`: the account reading, the limits that apply and this project's estimated share. */
export interface ProjectUsage extends UsageStatus {
  budget?: UsageBudget;
  reserve?: UsageReserve;
  project?: { usedPercent: number; runs: number; windowStart: string };
  gate: UsageGate;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  goal: string;
  /** The user's own written requirements. Absent from the polled snapshot; read through getProjectBrief. */
  brief?: string;
  /** Saved goal/brief version; 0 or absent until the user writes one. */
  briefRevision?: number;
  usageBudget?: UsageBudget;
  createdAt: string;
  isDemo: boolean;
  runtime?: RuntimeID;
}
export interface ProjectBrief {
  goal: string;
  brief: string;
  briefRevision: number;
}
export interface ProjectPatch {
  goal?: string;
  brief?: string;
  /** Must equal the current briefRevision; the service rejects a stale version. */
  revision: number;
}
/** Service bookkeeping for the long-lived task charter; the renderer only carries it along. */
export interface PromptCharter {
  threadId: string;
  hash: string;
  sentAt: string;
  turnsSince: number;
}
/**
 * What the channel page shows about an interrupted turn the Codex App continued on its own: the
 * current state and one expandable reason. The record's ids stay in the work-log detail.
 */
export interface AppResumeSummary {
  state: 'observing' | 'unconfirmed' | 'linked' | 'resumed' | 'kept-paused';
  reason: string;
  recordId: string;
}
/**
 * How a Codex channel's turns reach Codex. `app` hands each turn to the shared Codex App task; `cli`
 * starts `codex exec` as a bounded subprocess, like a Claude Code or Trae channel. Only `app` has
 * the in-app browser, Computer Use, the App's dynamic tools, App approvals and the work interface.
 */
export const channelTransports = ['app', 'cli'] as const;
export type ChannelTransport = (typeof channelTransports)[number];
/**
 * Whether this channel has an App task behind it. A channel with no stored transport means `app`, so
 * rows written before the field existed read as they always did. Ask this — not `runtime === 'codex'`
 * — for anything App-shaped: the native conversation, linking and opening a task, App-resume state,
 * approvals, and whether notes are this channel's way in. Usage is the other question: it follows the
 * runtime, because a CLI-direct Codex turn spends the same Codex account an App one does.
 */
export const usesApp = (channel: Pick<Channel, 'runtime' | 'transport'>) =>
  channel.runtime === 'codex' && (channel.transport || 'app') === 'app';
export interface Channel {
  work?: ChannelWork;
  promptCharter?: PromptCharter;
  autonomyEnabled?: boolean;
  /** Present only while there is an App-resume observation on this channel. */
  appResume?: AppResumeSummary;
  id: string;
  projectId: string;
  name: string;
  goal: string;
  runtime: RuntimeID;
  /** Codex only, and absent means `app`; the service refuses the field on the other runtimes. */
  transport?: ChannelTransport;
  model: string;
  status: string;
  intervalMinutes: number;
  maxRunsPerDay: number;
  permission: 'read-only' | 'workspace-write' | 'native';
  nextRunAt: string;
  lastRunAt: string;
  sessionId: string;
  usageWait?: UsageWait;
}
export interface WorkItem {
  projectId?: string;
  number?: number;
  /** Who opened the item; absent on rows written before it was recorded. */
  origin?: 'human' | 'agent';
  /** The channel responsible for the item right now; absent means 无人负责. */
  ownerChannelId?: string;
  sourceChannelIds?: string[];
  lastRunId?: string;
  revision?: number;
  id: string;
  channelId: string;
  title: string;
  summary: string;
  status: string;
  kind: string;
  evidence: string[];
  nextStep: string;
  createdAt: string;
  updatedAt: string;
}
export interface Run {
  log?: import('../../service/run-log').RunLog;
  /** The shared working tree as the turn left it; absent on rows written before it was recorded. */
  treeState?: { dirty: boolean; files: string[]; unknown?: boolean };
  projectId?: string;
  model?: string;
  permission?: Channel['permission'] | 'native';
  executionOwner?: 'codex-app' | 'cli';
  source?: 'morrow-schedule' | 'morrow-chat' | 'nohuman-schedule' | 'nohuman-chat' | 'native-app';
  nativeSettings?: Record<string, unknown>;
  trigger?: 'manual' | 'schedule';
  resumedFromSessionId?: string;
  reportStatus?: 'pending' | 'valid' | 'missing' | 'invalid' | 'conflict';
  reportError?: string;
  exitCode?: number;
  signal?: string;
  usage?: RunUsage;
  id: string;
  channelId: string;
  runtime: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
  sessionId: string;
}
export interface EventDetail {
  type: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  sequence?: number;
  toolCallId?: string;
}
export interface WorkspaceEvent {
  projectId?: string;
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
  detail?: EventDetail;
}
export interface Runtime {
  id: string;
  name: string;
  available: boolean;
  path: string;
  version: string;
  detail: string;
  canWrite: boolean;
}
export interface Snapshot {
  projects: Project[];
  channels: Channel[];
  items: WorkItem[];
  runs: Run[];
  events: WorkspaceEvent[];
  runtimes: Runtime[];
  releases?: Release[];
  settings?: Settings;
  usage?: UsageStatus;
  /** The automatic version switch; absent from services older than this field. */
  upgrade?: import('../../service/upgrade').UpgradeState;
}
export const emptySnapshot: Snapshot = { projects: [], channels: [], items: [], runs: [], events: [], runtimes: [] };
export interface ConnectionConfig {
  mode: 'local' | 'ssh';
  host: string;
  port: number;
  directory: string;
}
export interface ConnectionInfo {
  config: ConnectionConfig;
  connected: boolean;
  name: string;
  error?: string;
}
export interface CreateProject {
  name: string;
  path: string;
  goal: string;
  runtime?: RuntimeID;
  brief?: string;
}
export interface CreateChannel {
  projectId: string;
  name: string;
  goal: string;
  runtime: RuntimeID;
  transport?: ChannelTransport;
  model?: string;
  intervalMinutes?: number;
  maxRunsPerDay?: number;
  permission?: Channel['permission'];
}
export type ChannelPatch = Partial<
  Pick<Channel, 'name' | 'goal' | 'model' | 'intervalMinutes' | 'maxRunsPerDay' | 'permission' | 'transport'> & {
    runtime: RuntimeID;
  }
>;
export interface EventsQuery {
  projectId?: string;
  channelId?: string;
  itemId?: string;
  runId?: string;
  before?: string;
  after?: string;
  limit?: number;
}
export interface EventsPage {
  events: WorkspaceEvent[];
  hasMore: boolean;
  cursor?: string;
}
export interface CreateItem {
  projectId: string;
  title: string;
  summary?: string;
  kind?: string;
  status?: string;
  evidence?: string[];
  nextStep?: string;
  channelId?: string;
}
export type ItemPatch = Partial<
  Pick<WorkItem, 'title' | 'summary' | 'kind' | 'status' | 'evidence' | 'nextStep' | 'revision'>
> & {
  /** Assign the item to a channel of the same project, or `null` to leave it 无人负责. */
  ownerChannelId?: string | null;
};
export interface RunsQuery {
  projectId?: string;
  channelId?: string;
  before?: string;
  after?: string;
  limit?: number;
}
export interface RunsPage {
  runs: Run[];
  hasMore: boolean;
  cursor?: string;
}
export interface RunDetails {
  run: Run;
  prompt: string;
  finalOutput: string;
  report?: unknown;
}
export interface RunOutputQuery {
  after?: string;
  limit?: number;
}
export interface RunOutputChunk {
  id: string;
  runId: string;
  stream: 'prompt' | 'stdout' | 'stderr' | 'final' | 'report';
  text: string;
  createdAt: string;
  sequence: number;
}
export interface RunOutputPage {
  chunks: RunOutputChunk[];
  hasMore: boolean;
  cursor?: string;
}
export interface NativeConnectionStatus {
  available: boolean;
  connected: boolean;
  /** One short human sentence about the connection; never a filesystem path and never an errno. */
  detail: string;
  /** The transport's original text, kept for diagnosis; present only when `detail` differs from it. */
  rawDetail?: string;
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
}
export interface NativeThreadSummary {
  id: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt?: string;
  activeTurnId?: string;
  model?: string;
}
export interface NativeItem {
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
}
export interface NativeRequest {
  id: string;
  type: string;
  turnId?: string;
  status: string;
  title?: string;
  raw: Record<string, unknown>;
}
export interface NativeConversation {
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
  /** Why this task is not syncing, as one short human sentence; mapped the same way as `detail`. */
  syncError?: string;
  /** The original sync failure text, kept for diagnosis; present only when `syncError` differs. */
  rawSyncError?: string;
}
export interface NativeAttachment {
  id: string;
  name: string;
  mimeType: string;
  previewUrl?: string;
}
export interface NativeMessageInput {
  text: string;
  requestId: string;
  attachments?: NativeAttachment[];
}
export interface NativeMessageReceipt {
  requestId: string;
  state: 'pending' | 'accepted' | 'unknown' | 'failed';
  turnId?: string;
  error?: string;
}
export interface NativeHistoryQuery {
  before?: string;
  limit?: number;
}
export interface DesktopAPI {
  getProjectWork?(projectId: string, itemId?: string, verificationBefore?: string): Promise<ProjectLoop>;
  getProjectBrief?(projectId: string): Promise<ProjectBrief>;
  updateProject?(id: string, data: ProjectPatch): Promise<Project>;
  getSettings?(): Promise<Settings>;
  updateSettings?(data: SettingsPatch): Promise<Settings>;
  updateProjectUsageBudget?(id: string, usageBudget: UsageBudget | null): Promise<Project>;
  getProjectUsage?(id: string): Promise<ProjectUsage>;
  reviewRelease?(id: string, reviewHash: string, decision: 'approve' | 'reject', feedback: string): Promise<Release>;
  reconcileRelease?(id: string): Promise<Release>;
  /** The sealed script text of a `local-script` release, so a human can read it before approving. */
  getReleaseScript?(id: string): Promise<ReleaseScript>;
  /** Asking the automatic version switch to happen now. Absent on older desktops. */
  requestUpgradeRestart?(): Promise<void>;
  getState(): Promise<Snapshot>;
  getConnection(): Promise<ConnectionInfo>;
  connect(config: ConnectionConfig): Promise<ConnectionInfo>;
  createProject(data: CreateProject): Promise<Project>;
  createChannel(data: CreateChannel): Promise<Channel>;
  updateChannel(id: string, data: ChannelPatch): Promise<Channel>;
  channelAction(id: string, action: 'run' | 'pause' | 'resume'): Promise<unknown>;
  /** One note left for a CLI channel; it becomes context for the next turn and starts nothing. */
  sendMessage(channelId: string, text: string): Promise<WorkspaceEvent>;
  /** The channel's notes, oldest first. */
  getMessages(channelId: string): Promise<{ messages: WorkspaceEvent[] }>;
  getNativeStatus(refreshUsage?: boolean): Promise<NativeConnectionStatus>;
  restoreNativeBackground?(): Promise<{ restartRequired: boolean; detail: string }>;
  listNativeThreads(channelId: string): Promise<{ status: NativeConnectionStatus; threads: NativeThreadSummary[] }>;
  getNativeConversation(channelId: string, query?: NativeHistoryQuery): Promise<NativeConversation>;
  bindNativeThread(channelId: string, threadId: string): Promise<NativeConversation>;
  sendNativeMessage(channelId: string, input: NativeMessageInput): Promise<NativeMessageReceipt>;
  interruptNativeTurn(channelId: string, turnId: string): Promise<unknown>;
  openNativeApp(channelId: string): Promise<void>;
  createItem(data: CreateItem): Promise<WorkItem>;
  patchItem(id: string, data: ItemPatch): Promise<WorkItem>;
  getRuns(query: RunsQuery): Promise<RunsPage>;
  getRun(id: string): Promise<RunDetails>;
  getRunOutput(id: string, query: RunOutputQuery): Promise<RunOutputPage>;
  loadDemo(): Promise<unknown>;
  refreshRuntimes(): Promise<Runtime[]>;
  getEvents(query: EventsQuery): Promise<EventsPage>;
  chooseFolder(): Promise<string | null>;
  openProjectFolder(projectId: string): Promise<void>;
  openDataFolder(): Promise<void>;
  openExternal(url: string): Promise<void>;
  onCommand(callback: (command: string) => void): () => void;
}
declare global {
  interface Window {
    morrow?: DesktopAPI;
    nohuman?: DesktopAPI;
  }
}
export type Route =
  | { kind: 'project'; id: string }
  | { kind: 'finding'; id: string }
  | { kind: 'channel'; id: string }
  | { kind: 'runs' }
  | { kind: 'runtimes' };
