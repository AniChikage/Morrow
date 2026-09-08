export type ChannelWork = { state:'continue'|'wait'|'needs_input';focus:string;reason:string;nextStep:string;waitMinutes?:number;runId:string;updatedAt:string;awaitingReply:boolean };
import type { ProjectLoop, Release } from '../../service/autonomy-types';
export type { ProjectLoop, Release, Evidence, Learning, FeedbackWatch } from '../../service/autonomy-types';
export type RuntimeID = 'codex' | 'claude' | 'trae';
export interface Project { id: string; name: string; path: string; goal: string; createdAt: string; isDemo: boolean; runtime?: RuntimeID }
export interface Channel { work?:ChannelWork; autonomyEnabled?:boolean; id: string; projectId: string; name: string; goal: string; runtime: RuntimeID; model: string; status: string; intervalMinutes: number; maxRunsPerDay: number; permission: 'read-only' | 'workspace-write' | 'native'; nextRunAt: string; lastRunAt: string; sessionId: string }
export interface WorkItem { projectId?: string; number?: number; sourceChannelIds?: string[]; lastRunId?: string; revision?: number; id: string; channelId: string; title: string; summary: string; status: string; kind: string; evidence: string[]; nextStep: string; createdAt: string; updatedAt: string }
export interface Run { projectId?: string; model?: string; permission?: Channel['permission'] | 'native'; executionOwner?: 'codex-app' | 'cli'; source?: 'nohuman-schedule' | 'nohuman-chat' | 'native-app'; nativeSettings?: Record<string, unknown>; trigger?: 'manual' | 'schedule'; resumedFromSessionId?: string; reportStatus?: 'pending' | 'valid' | 'missing' | 'invalid' | 'conflict'; reportError?: string; exitCode?: number; signal?: string; id: string; channelId: string; runtime: string; status: string; startedAt: string; finishedAt: string; summary: string; sessionId: string }
export interface EventDetail { type: string; tool?: string; input?: unknown; output?: unknown; status?: string; sequence?: number; toolCallId?: string }
export interface WorkspaceEvent { projectId?: string; itemId?: string; actor?: 'human' | 'agent' | 'system'; action?: string; changes?: { before?: unknown; after?: unknown }; id: string; channelId: string; runId: string; kind: string; text: string; createdAt: string; detail?: EventDetail }
export interface Runtime { id: string; name: string; available: boolean; path: string; version: string; detail: string; canWrite: boolean }
export interface Snapshot { projects: Project[]; channels: Channel[]; items: WorkItem[]; runs: Run[]; events: WorkspaceEvent[]; runtimes: Runtime[]; releases?: Release[] }
export const emptySnapshot: Snapshot = { projects: [], channels: [], items: [], runs: [], events: [], runtimes: [] };
export interface ConnectionConfig { mode: 'local' | 'ssh'; host: string; port: number; directory: string }
export interface ConnectionInfo { config: ConnectionConfig; connected: boolean; name: string; error?: string }
export interface CreateProject { name: string; path: string; goal: string; runtime?: RuntimeID }
export interface CreateChannel { projectId: string; name: string; goal: string; runtime: RuntimeID; model?: string; intervalMinutes?: number; maxRunsPerDay?: number; permission?: Channel['permission'] }
export type ChannelPatch = Partial<Pick<Channel, 'name' | 'goal' | 'runtime' | 'model' | 'intervalMinutes' | 'maxRunsPerDay' | 'permission'>>;
export interface EventsQuery { projectId?: string; channelId?: string; itemId?: string; runId?: string; before?: string; after?: string; limit?: number }
export interface EventsPage { events: WorkspaceEvent[]; hasMore: boolean; cursor?: string }
export interface CreateItem { projectId: string; title: string; summary?: string; kind?: string; status?: string; evidence?: string[]; nextStep?: string; channelId?: string }
export type ItemPatch = Partial<Pick<WorkItem, 'title' | 'summary' | 'kind' | 'status' | 'evidence' | 'nextStep' | 'revision'>>;
export interface RunsQuery { projectId?: string; channelId?: string; before?: string; after?: string; limit?: number }
export interface RunsPage { runs: Run[]; hasMore: boolean; cursor?: string }
export interface RunDetails { run: Run; prompt: string; finalOutput: string; report?: unknown }
export interface RunOutputQuery { after?: string; limit?: number }
export interface RunOutputChunk { id: string; runId: string; stream: 'prompt' | 'stdout' | 'stderr' | 'final' | 'report'; text: string; createdAt: string; sequence: number }
export interface RunOutputPage { chunks: RunOutputChunk[]; hasMore: boolean; cursor?: string }
export interface NativeSessionTarget { projectPath: string; runtime: RuntimeID; executable: string; sessionId: string }
export interface NativeConnectionStatus {
  available: boolean; connected: boolean; detail: string; appVersion?: string; backgroundReady?: boolean; backgroundConfigured?: boolean;
  capabilities: { list: boolean; read: boolean; send: boolean; create: boolean; interrupt: boolean; respond: boolean };
}
export interface NativeThreadSummary { id: string; title: string; cwd: string; status: string; updatedAt?: string; activeTurnId?: string; model?: string }
export interface NativeItem { autonomousContext?:boolean; id: string; turnId: string; type: string; role?: 'user' | 'assistant' | 'system' | 'tool'; text: string; status?: string; createdAt?: string; input?: unknown; output?: unknown; raw: Record<string, unknown> }
export interface NativeRequest { id: string; type: string; turnId?: string; status: string; title?: string; raw: Record<string, unknown> }
export interface NativeConversation {
  canRecreateEmpty?: boolean;
  channelId: string; threadId?: string; status: NativeConnectionStatus; thread?: NativeThreadSummary;
  items: NativeItem[]; requests: NativeRequest[]; hasMore: boolean; cursor?: string; lastSyncedAt?: string; syncError?: string;
}
export interface NativeAttachment { id: string; name: string; mimeType: string; previewUrl?: string }
export interface NativeMessageInput { text: string; requestId: string; attachments?: NativeAttachment[] }
export interface NativeMessageReceipt { requestId: string; state: 'pending' | 'accepted' | 'unknown' | 'failed'; turnId?: string; error?: string }
export interface NativeHistoryQuery { before?: string; limit?: number }
export interface DesktopAPI {
  getProjectWork?(projectId:string, itemId?:string):Promise<ProjectLoop>;
  reviewRelease?(id:string, reviewHash:string, decision:'approve'|'reject', feedback:string):Promise<Release>;
  reconcileRelease?(id:string):Promise<Release>;
  getState(): Promise<Snapshot>;
  getConnection(): Promise<ConnectionInfo>;
  connect(config: ConnectionConfig): Promise<ConnectionInfo>;
  createProject(data: CreateProject): Promise<Project>;
  createChannel(data: CreateChannel): Promise<Channel>;
  updateChannel(id: string, data: ChannelPatch): Promise<Channel>;
  channelAction(id: string, action: 'run' | 'pause' | 'resume'): Promise<unknown>;
  sendMessage(id: string, text: string): Promise<WorkspaceEvent>;
  getNativeStatus(): Promise<NativeConnectionStatus>;
  setupNativeBackground?(): Promise<{restartRequired:boolean;detail:string}>;
  restoreNativeBackground?(): Promise<{restartRequired:boolean;detail:string}>;
  listNativeThreads(channelId: string): Promise<{ status: NativeConnectionStatus; threads: NativeThreadSummary[] }>;
  getNativeConversation(channelId: string, query?: NativeHistoryQuery): Promise<NativeConversation>;
  bindNativeThread(channelId: string, threadId: string): Promise<NativeConversation>;
  createNativeThread(channelId: string): Promise<NativeConversation>;
  sendNativeMessage(channelId: string, input: NativeMessageInput): Promise<NativeMessageReceipt>;
  interruptNativeTurn(channelId: string, turnId: string): Promise<unknown>;
  respondNativeRequest(channelId: string, requestId: string, response: unknown): Promise<unknown>;
  openNativeApp(channelId: string): Promise<void>;
  chooseNativeImages(channelId: string): Promise<NativeAttachment[]>;
  getNativeImage(channelId: string, itemId: string, index: number): Promise<{ dataUrl: string }>;
  updateItem(id: string, status: string): Promise<WorkItem>;
  createItem(data: CreateItem): Promise<WorkItem>;
  patchItem(id: string, data: ItemPatch): Promise<WorkItem>;
  getRuns(query: RunsQuery): Promise<RunsPage>;
  getRun(id: string): Promise<RunDetails>;
  getRunOutput(id: string, query: RunOutputQuery): Promise<RunOutputPage>;
  openNativeSession(channelId: string): Promise<void>;
  loadDemo(): Promise<unknown>;
  refreshRuntimes(): Promise<Runtime[]>;
  getEvents(query: EventsQuery): Promise<EventsPage>;
  chooseFolder(): Promise<string | null>;
  openProjectFolder(projectId: string): Promise<void>;
  openDataFolder(): Promise<void>;
  openExternal(url: string): Promise<void>;
  onCommand(callback: (command: string) => void): () => void;
}
declare global { interface Window { nohuman?: DesktopAPI } }
export type Route = { kind: 'project'; id: string } | { kind: 'finding'; id: string } | { kind: 'channel'; id: string } | { kind: 'runs' } | { kind: 'runtimes' };
