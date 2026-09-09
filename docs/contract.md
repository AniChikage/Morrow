# Morrow 0.3 desktop and daemon contract

The 0.6.0 autonomous work and release additions are specified in [Project work loop](PROJECT-WORK-CONTRACT.md). The sections below also preserve older client compatibility details.

Electron + React + TypeScript macOS desktop, independent Node.js >=24 TypeScript daemon, and SQLite. The app uses installed/authenticated Codex, Claude Code or Trae CLIs; provider sessions, model I/O and native history remain owned by those CLIs. The UI is independently implemented with Multica as a reference. Legacy SwiftUI sources remain available as a separate build.

## Ownership and execution model

A project attaches one existing canonical filesystem directory and owns one feature board. A channel is a continuous responsibility and a source of findings, not a separate board. Sibling channels see the same project items and may advance them. `WorkItem.channelId` remains the first source channel; `sourceChannelIds` records contributing channels. Manually created items may have an empty first-source channel.

Each Morrow run starts or resumes a bounded, noninteractive native CLI turn in the project directory. Scheduling uses intervals, not filesystem-change notifications. Messages are saved for the next round; there is no live custom chat/PTY stdin injection. Manual interaction after a native-terminal handoff remains in the provider's native history and is not streamed back as a Morrow run.

## Transport and conventions

Start with `node service/server.ts`. `MORROW_HOME` defaults to `~/Library/Application Support/Morrow`; `MORROW_PORT` defaults to `43821`. The server listens only on `127.0.0.1`. The data directory is private (0700), and the generated `token` file is 0600. All `/api/` requests require `Authorization: Bearer <token>` and reject browser Origin headers. Public `GET /health` returns `{ok:true,service:"morrow"}`.

JSON responses use ISO8601 dates, UUID record IDs, and empty strings for absent textual values on existing required fields. Additional metadata fields may be omitted, especially in legacy records. No textual nulls are introduced. Errors are non-2xx `{error:string}`. Request bodies are limited to 1 MiB; mutation fields are allowlisted and validated. Tokens are not included in snapshots or exposed to the renderer.

## Data records

The executable service definitions are in `service/protocol.ts`; backward-compatible desktop interfaces are in `desktop/shared/types.ts`. New service items include all board fields, while desktop interfaces keep newly introduced fields optional to read older data.

```ts
RuntimeID = "codex" | "claude" | "trae"
ItemStatus = "open" | "investigating" | "verified" | "resolved" | "blocked"
ItemKind = "feature" | "issue" | "opportunity" | "hypothesis"

Project = {id,name,path,goal,createdAt,isDemo:boolean,runtime:RuntimeID}
Channel = {
  id,projectId,name,goal,runtime:RuntimeID,model,
  status:"paused"|"idle"|"running"|"waiting"|"blocked",
  intervalMinutes:number,maxRunsPerDay:number,
  permission:"read-only"|"workspace-write",
  nextRunAt,lastRunAt,sessionId
}
WorkItem = {
  id,projectId,number:number,channelId,sourceChannelIds:string[],lastRunId,
  revision:number,title,summary,status:ItemStatus,kind:ItemKind,
  evidence:string[],nextStep,createdAt,updatedAt
}
Run = {
  id,projectId,channelId,runtime:RuntimeID,model,
  permission:"read-only"|"workspace-write",trigger:"manual"|"schedule",
  resumedFromSessionId,sessionId,
  status:"running"|"completed"|"failed"|"interrupted",
  reportStatus:"pending"|"valid"|"missing"|"invalid"|"conflict",reportError,
  exitCode?:number,signal?:string,startedAt,finishedAt,summary
}
Event = {
  id,projectId,channelId,runId,
  kind:"message"|"system"|"assistant"|"tool"|"result"|"error",
  text,createdAt,itemId?:string,actor?:"human"|"agent"|"system",action?:string,
  changes?:{before?:unknown,after?:unknown},
  detail?:{type:string,tool?:string,input?:unknown,output?:unknown,
           status?:string,sequence?:number,toolCallId?:string}
}
Runtime = {id,name,available:boolean,path,version,detail,canWrite:boolean}
RunOutputChunk = {
  id,runId,stream:"prompt"|"stdout"|"stderr"|"final"|"report",
  text,createdAt,sequence:number
}
```

`number` is stable within a project. `channelId` and `projectId` cannot be edited through an item patch. New native runs persist their selected model/permission/trigger; migration does not invent these values for historical runs that never recorded them. Existing text-only events remain valid and have no fabricated tool details or before/after audit values.

## Reading state and history

- `GET /api/state` → `{projects,channels,items,runs,events,runtimes}`. Projects/channels/items are current state; runs are the latest 500 and events the latest 1,500. Bulk I/O is excluded.
- `GET /api/events?projectId=&channelId=&itemId=&runId=&before=&after=&limit=` → `{events,hasMore,cursor?}`. Require projectId or channelId; when both are supplied they must agree. Item and run filters must belong to that scope. Limit defaults to 50, accepts 1–200.
- `GET /api/runs?projectId=&channelId=&before=&after=&limit=` → `{runs,hasMore,cursor?}`. Project/channel filters are optional. Limit defaults to 50, accepts 1–200.
- `GET /api/runs/:id` → `{run,prompt:string,finalOutput:string,report?:AgentResult}`. This reads persisted records beyond the snapshot window; missing historical artifacts remain empty, not reconstructed from guesses.
- `GET /api/runs/:id/output?after=&limit=` → `{chunks:RunOutputChunk[],hasMore,cursor?}`. Limit defaults to 50, accepts 1–100. Only an `after` cursor is supported; output is read from the beginning when omitted.

Event/run pages are chronological in durable SQLite insertion order, including equal timestamps. `before` and `after` are exclusive. A page without `after` returns the latest matching records; its cursor is the oldest returned ID for the next earlier page. With `after`, the earliest following records are returned and the cursor is the newest returned ID. Empty pages omit cursor. Initial incremental clients use the last record ID in their initial history page.

Raw output chunks are immutable once published. Their cursor is the last returned chunk ID. A possible split-token prefix is stored immediately in private `run_io_pending`, withheld from the public stream, and finalized by more input or stream termination/recovery. This prevents temporary token disclosure and avoids rewriting chunks already read by a cursor client. The original CLI stream, subject to token redaction and output limits, can be reconstructed by concatenating each stream's finalized chunks. Raw chunks and higher-level events are separate representations.

Unknown or out-of-scope filters/cursors return 404; malformed, duplicate or unsupported query fields return 400. The desktop can fall back to retained snapshot events only when an older daemon completely lacks the event endpoint. It cannot synthesize missing project audits, full run records or I/O from an older snapshot; new mutation and handoff APIs require the new service.

## Project, channel and board mutations

| Endpoint | Body | Result and behavior |
| --- | --- | --- |
| `POST /api/projects` | `{name,path,goal,runtime?}` | Project. Directory must exist; canonical duplicate returns 409. Runtime defaults to Codex; two default paused/read-only channels, 系统完善 and 运营洞察, use that runtime. No automatic execution. |
| `POST /api/channels` | `{projectId,name,goal,runtime,model?,intervalMinutes?,maxRunsPerDay?,permission?}` | Paused channel. |
| `PATCH /api/channels/:id` | `{name?,goal?,runtime?,model?,intervalMinutes?,maxRunsPerDay?,permission?}` | Updated channel. Runtime/model/permission changes are rejected while active; changing them clears the current session reference for the next round, while prior runs and provider history remain. |
| `POST /api/channels/:id/action` | `{action:"run"|"pause"|"resume"}` | `{ok:true}`. Run once; pause pending and active execution; or enable continuous scheduling. |
| `POST /api/channels/:id/messages` | `{text}` | Persisted message event, included in next round. Does not auto-launch. |
| `POST /api/projects/:id/items` | `{title,summary?,kind?,status?,evidence?,nextStep?,channelId?}` | New project item. Defaults: feature/open, empty description/evidence/next step, empty channel origin. Supplied source channel must belong to project. |
| `PATCH /api/items/:id` | `{title?,summary?,kind?,status?,evidence?,nextStep?,revision?}` | Updated item and incremented revision. Stale supplied revision returns 409. Legacy `{status}` remains accepted. |
| `POST /api/runtimes/refresh` | `{}` | Runtime installation/capability list; does not prove account login or quota. |
| `POST /api/demo` | `{}` | `{ok:true}`; idempotent, explicitly labeled Atlas example project. Demo channels never execute. |

Project/channel creation, channel settings and accepted actions, messages, item changes/conflicts, run lifecycle/output and native handoff intents are persisted. Item and configuration changes include actual before/after values; item changes and their audits commit in the same transaction. Audit actions include `project.created`, `channel.created`, `channel.updated`, `channel.action`, `message.created`, `item.created`, `item.updated`, `item.conflict` and `native-session-opened`. The machine action code is separate from user-facing text.

## Native execution and optional reports

A run receives the project objective, channel responsibility, entire project board, recent human notes, previous run summaries and sourced knowledge. Work should produce a normal native Markdown response. It may include a fenced `morrow-report` block with:

```ts
AgentResult = {
  summary:string,
  items:{id?:string,title:string,summary:string,status:ItemStatus,kind:ItemKind,
         evidence:string[],nextStep:string}[],
  nextCheckMinutes:number,
  knowledge:{text:string,source:string,confirmed:boolean}[],
  needsHuman:boolean
}
```

Legacy JSON-only results and provider structured output are also accepted. Validated reports update only same-project item IDs. First-source channel is preserved, the acting channel is added as a contributor, and agent verified/resolved items require evidence. Item revisions captured at run start prevent overwriting later edits; conflicting proposed changes remain in the report/audit and `reportStatus` becomes conflict. Confirmed knowledge is shared across project channels with source, time and origin; hypotheses retain `confirmed:false`.

`Run.status` describes native execution. CLI exit success with absent or invalid optional report remains completed, preserves the native answer, and does not fabricate board updates. When continuous scheduling is enabled it uses the configured interval. `reportStatus` and `reportError` separately explain report availability, validation or conflicts. A terminal provider failure/nonzero exit remains failed; interruption remains interrupted. Recoverable diagnostics do not override a later successful terminal event. Valid `needsHuman:true` stops scheduling.

Codex/Trae use `exec --json`, or `exec resume <exact-session-id>`, with the chosen sandbox, `approval_policy="never"` and sandboxed workspace-command network access disabled. No `--last`, dangerous bypass, `--ignore-user-config`, `--ignore-rules` or forced `--output-schema` is used. Native provider/model configuration, project rules and skills remain loadable; an explicit Morrow model overrides the native default. The local-only execution prompt prohibits MCP/remote tools and external publication, but is not an independent OS policy engine for every native integration.

Claude uses `--print --verbose --output-format stream-json` and an exact `--resume` ID when present, without forced `--json-schema`. It retains `--safe-mode --restricted`, strict empty MCP configuration and explicit allowed tool lists: Read/Grep/Glob for read-only, plus Edit/Write for workspace editing. No Bash or MCP is available, so this adapter cannot run test commands. Native login and session reuse do not imply unchanged inheritance of Claude custom configuration, plugins or tools.

Only one Morrow run holds a project-path lock at a time. Other projects may run independently. A conflicting manual run returns 409; continuous work waits. Budgets count started attempts per UTC date (1–100 runs/day), intervals are 1–1440 minutes, and suggested rechecks cannot shorten the configured minimum. Single runs time out after 15 minutes; combined stdout/stderr is capped at 20 MiB, individual unbroken log lines at 1 MiB, and input context at 1 MiB. These limits are not token/dollar metering. Pause terminates the CLI process group and disables scheduling. Crash recovery marks unfinished runs interrupted and pauses channels, retaining exact native session IDs for explicit continuation.

## Native-terminal handoff

`POST /api/channels/:id/native-handoff {}` returns `{projectPath,runtime,executable,sessionId}`. The project must be real, the CLI available, every project channel paused/blocked/idle with scheduling disabled, and no project run active. Otherwise the service rejects the request. It persists a human `native-session-opened` intent but does not launch the terminal or claim launch succeeded.

Desktop `openNativeSession(channelId)` obtains that metadata and launches the native CLI through the main process for local connections. Remote mode requires continuing in a terminal on the execution host. An existing exact session ID is used rather than selecting an unrelated latest session. Morrow does not capture subsequent interactive terminal I/O or automatically infer completion of that manual session.

## Desktop bridge and connection state

`desktop/preload/index.ts` exposes the methods in `desktop/shared/types.ts`, with promises except the command subscription:

- `getState`, `getConnection`, `connect`.
- `createProject`, `createChannel`, `updateChannel`, `channelAction`, `sendMessage`.
- `createItem`, `patchItem`, legacy `updateItem(id,status)`, `getEvents`.
- `getRuns`, `getRun`, `getRunOutput`, `openNativeSession`.
- `loadDemo`, `refreshRuntimes`, `chooseFolder`, `openProjectFolder`, `openDataFolder`, `openExternal`.
- `onCommand(callback) -> unsubscribe` for new-project/search/settings/close-tab/back/forward/toggle-sidebar.

ConnectionConfig is `{mode:"local"|"ssh",host,port,directory}`; ConnectionInfo is `{config,connected,name,error?}`. Main owns daemon HTTP, tokens, SSH, directory dialogs and native launch. IPC validates the sender/main frame, argument counts and allowlisted fields. Renderer receives no generic HTTP, filesystem, raw IPC or token capability. Production loads `morrow://app/index.html` with sandbox/contextIsolation, no nodeIntegration or webviews, and restrictive CSP. External links accept HTTP(S) without credentials.

SSH uses existing noninteractive OpenSSH configuration, strict known-host checking and a local tunnel at `127.0.0.1:43822`; remote bearer text stays in main memory. The app does not install/start remote daemons or transfer provider credentials. Folder dialogs, Finder operations and desktop native-session opening are local-only.

Workspace snapshots refresh every two seconds while visible and on focus. Mutation completion forces a new read; connection reset clears the old snapshot and invalidates prior requests. Failed polling still retrieves connection status. Local view preferences, tab histories and panel sizes remain renderer state, not daemon operational records. Browser-only preview uses an explicit development API; the packaged app does not silently fall back to example data.

## Persistence, migration and lifecycle

SQLite retains projects, channels, items, runs, events, knowledge, results, scheduler controls, raw `run_io`, private `run_io_pending`, and migration markers. Prompt/stdout/stderr/final/report streams are mirrored to the database before corresponding private file copies where applicable. Export failure does not reclassify an already durable execution. Existing private run files are imported once within a 24 MiB per-run bound, with per-file transactional migration markers. There is no automatic history pruning.

Boot migration derives legacy item project ownership from its source channel, fills stable numbering/provenance/revisions, adds known event/run project IDs and preserves original IDs. It does not merge items, invent missing old audit diffs or reconstruct unknown historical model/permission/trigger values. Provider history stays in the provider's native storage.

Electron reuses an identifiable healthy daemon and starts bundled Node only when the configured local port refuses connection; it does not replace an active or unrecognized service. Quitting the UI leaves the local daemon running; it closes only its own SSH tunnel. New daemon capabilities require an actual service upgrade, not only a renderer update.

Both desktop generations default to the same data directory, preserving workspace.sqlite, token and run files. Successful Electron connection preferences go to `desktop-connection.json` (0600). If absent/invalid, main can read the old `ai.morrow.desktop` connection keys usingRemote/remoteHost/remotePort/remoteDirectory. No provider credentials are imported.

## Build entry points and verification scope

`npm ci` installs locked dependencies; `npm run dev` launches Electron with the real bridge; `npm run dev:ui` launches a browser preview. `npm run build` writes out/main, out/preload and out/renderer. `scripts/build-app.sh` delegates to `scripts/build-electron.sh` and builds dist/Morrow.app (appId ai.morrow.desktop, version 0.3.0). Install/DMG scripts consume that artifact. Official Node 24 is bundled after SHA-256 verification. Ad-hoc signing is local; Developer ID signing and notarization remain separate distribution work.

Legacy `Sources/Morrow` and Package.swift remain independently buildable; `scripts/build-swiftui.sh` writes dist/Morrow-SwiftUI.app. Legacy clients ignore additive fields but do not acquire the new project-board and full-records UI.

Verification commands include `npm run typecheck`, `npm test`, `npm run test:ui -- desktop`, and `bash scripts/build-app.sh`. Service tests use isolated databases and fixture CLIs; actual CLI/SSH integration and installed native-window UI acceptance are separate checks. This contract does not claim a completed 0.3.0 installation or UI acceptance run.
