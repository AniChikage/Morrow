export type ChannelWork = { state:'continue'|'wait'|'needs_input';focus:string;reason:string;nextStep:string;waitMinutes?:number;runId:string;updatedAt:string;awaitingReply:boolean };
export const engines = ["codex", "claude", "trae"] as const;
export const itemStatuses = [
  "open",
  "investigating",
  "verified",
  "resolved",
  "blocked",
] as const;
export const itemKinds = ["feature", "issue", "opportunity", "hypothesis"] as const;
export type RuntimeID = (typeof engines)[number];
export type Project = {
  id: string;
  name: string;
  path: string;
  goal: string;
  createdAt: string;
  isDemo: boolean;
  runtime: RuntimeID;
};
export type Channel = {
  work?:ChannelWork;
  autonomyEnabled?:boolean;
  id: string;
  projectId: string;
  name: string;
  goal: string;
  runtime: RuntimeID;
  model: string;
  status: string;
  intervalMinutes: number;
  maxRunsPerDay: number;
  permission: "read-only" | "workspace-write" | "native";
  nextRunAt: string;
  lastRunAt: string;
  sessionId: string;
};
export type WorkItem = {
  id: string;
  projectId: string;
  number: number;
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
export type Run = {
  workDirection?:string;
  id: string;
  projectId: string;
  channelId: string;
  runtime: RuntimeID;
  model: string;
  permission: "read-only" | "workspace-write" | "native";
  executionOwner?: "cli" | "codex-app";
  nativeTurnId?: string;
  nativeItemRevisions?: Record<string,number>;
  source?: "morrow-schedule" | "morrow-chat" | "nohuman-schedule" | "nohuman-chat" | "native-app";
  trigger: "manual" | "schedule";
  resumedFromSessionId: string;
  reportStatus: "pending" | "valid" | "missing" | "invalid" | "conflict";
  reportError: string;
  exitCode?: number;
  signal?: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
  sessionId: string;
};
export type NativeConnectionStatus = { available: boolean; connected: boolean; detail: string; appVersion?: string; backgroundReady?:boolean; backgroundConfigured?:boolean; capabilities: {list:boolean;read:boolean;send:boolean;create:boolean;interrupt:boolean;respond:boolean} };
export type NativeThreadSummary = { id:string;title:string;cwd:string;status:string;updatedAt?:string;activeTurnId?:string;model?:string };
export type NativeItem = { autonomousContext?:boolean; id:string;turnId:string;type:string;role?:'user'|'assistant'|'system'|'tool';text:string;status?:string;createdAt?:string;input?:unknown;output?:unknown;raw:Record<string,unknown> };
export type NativeRequest = { id:string;type:string;turnId?:string;status:string;title?:string;raw:Record<string,unknown> };
export type NativeConversation = { canRecreateEmpty?:boolean;channelId:string;threadId?:string;status:NativeConnectionStatus;thread?:NativeThreadSummary;items:NativeItem[];requests:NativeRequest[];hasMore:boolean;cursor?:string;lastSyncedAt?:string;syncError?:string };
export type NativeMessageReceipt = { requestId:string;state:'pending'|'accepted'|'unknown'|'failed';turnId?:string;error?:string };
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
  actor?: "human" | "agent" | "system";
  action?: string;
  changes?: { before?: unknown; after?: unknown };
  id: string;
  channelId: string;
  runId: string;
  kind: string;
  text: string;
  createdAt: string;
};
export type RunIO = { id: string; runId: string; stream: "prompt" | "stdout" | "stderr" | "final" | "report"; text: string; createdAt: string; sequence: number };
export type Runtime = {
  id: RuntimeID;
  name: string;
  available: boolean;
  path: string;
  version: string;
  detail: string;
  canWrite: boolean;
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
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new APIError(400, "请求必须是 JSON 对象");
  return value as Record<string, any>;
}
export function keys(value: Record<string, any>, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    throw new APIError(400, "请求包含不支持的字段");
}
export function string(
  value: unknown,
  field: string,
  max = 10000,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    value.includes("\0")
  )
    throw new APIError(400, `${field} 格式无效`);
  return value.trim();
}
export function integer(
  value: unknown,
  field: string,
  min = 1,
  max = 1440,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new APIError(400, `${field} 必须在 ${min}–${max} 之间`);
  return value as number;
}
export function choice<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new APIError(400, `${field} 无效`);
  return value as T;
}
const stringSchema = { type: "string" };
export const resultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "items", "nextCheckMinutes", "knowledge", "needsHuman"],
  properties: {
    summary: stringSchema,
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "summary",
          "status",
          "kind",
          "evidence",
          "nextStep",
        ],
        properties: {
          id: stringSchema,
          title: stringSchema,
          summary: stringSchema,
          status: { enum: itemStatuses },
          kind: { enum: itemKinds },
          evidence: { type: "array", items: stringSchema },
          nextStep: stringSchema,
        },
      },
    },
    nextCheckMinutes: { type: "integer", minimum: 1, maximum: 1440 },
    knowledge: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "source", "confirmed"],
        properties: {
          text: stringSchema,
          source: stringSchema,
          confirmed: { type: "boolean" },
        },
      },
    },
    needsHuman: { type: "boolean" },
  },
};
export function validateResult(value: unknown): AgentResult {
  const v = object(value);
  keys(v, ["summary", "items", "nextCheckMinutes", "knowledge", "needsHuman"]);
  const summary = string(v.summary, "summary", 20000);
  const nextCheckMinutes = integer(v.nextCheckMinutes, "nextCheckMinutes");
  if (
    !Array.isArray(v.items) ||
    v.items.length > 100 ||
    !Array.isArray(v.knowledge) ||
    v.knowledge.length > 100 ||
    typeof v.needsHuman !== "boolean"
  )
    throw new APIError(400, "结果结构无效");
  const seen = new Set<string>();
  const items = v.items.map((raw: unknown) => {
    const i = object(raw);
    keys(i, [
      "id",
      "title",
      "summary",
      "status",
      "kind",
      "evidence",
      "nextStep",
    ]);
    if (!Array.isArray(i.evidence) || i.evidence.length > 50)
      throw new APIError(400, "evidence 必须为数组");
    const id = i.id === undefined ? "" : string(i.id, "id", 100, true);
    if (id && seen.has(id)) throw new APIError(400, "结果包含重复事项 ID");
    if (id) seen.add(id);
    const status = choice(i.status, "status", itemStatuses);
    const evidence = i.evidence.map((e: unknown) =>
      string(e, "evidence", 5000),
    );
    if (["verified", "resolved"].includes(status) && !evidence.length)
      throw new APIError(400, "已验证或已解决的事项必须提供证据");
    return {
      id,
      title: string(i.title, "title", 300),
      summary: string(i.summary, "summary", 10000, true),
      status,
      kind: choice(i.kind, "kind", itemKinds),
      evidence,
      nextStep: string(i.nextStep, "nextStep", 5000, true),
    };
  });
  const knowledge = v.knowledge.map((raw: unknown) => {
    const k = object(raw);
    keys(k, ["text", "source", "confirmed"]);
    if (typeof k.confirmed !== "boolean")
      throw new APIError(400, "knowledge.confirmed 无效");
    return {
      text: string(k.text, "knowledge.text", 10000),
      source: string(k.source, "knowledge.source", 5000),
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
  if (cleaned.startsWith("```"))
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  return validateResult(JSON.parse(cleaned));
}
