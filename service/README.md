# Morrow execution service

## Goal-driven work and release review (0.6.0)

Scheduled native Codex turns receive a private `agent-cli.ts --context …` entry point. The CLI executes inside the same native task and calls `/api/agent` using a run-scoped credential; it cannot call desktop review endpoints. Credentials expire and new writes require a currently running, matching project/channel/run. The desktop token is never included in the prompt. Use `--operation context` for the current project state and operation contracts. Mutations require `--request-id`; retries use the same ID and JSON. `--input -` reads JSON from stdin, so work records do not require writing temporary files in a read-only workspace.

The agent can maintain the shared feature board, capture evidence, revise outcome/hypothesis/experiment records, create JSON feedback watches and persist a wait. All records reference their project, channel, native run and, where applicable, feature. Captured evidence also updates that feature's evidence list. Optimistic revisions protect concurrent changes. HTTP observations are distinguishable from agent-reported claims; file capture preserves actual bytes and their digest. A captured log is evidence to review, not independent proof of every conclusion an agent draws from it.

Feedback watches currently support HTTP(S) GET JSON, JSON Pointer selection and `changed`, `equals`, `gte` or `lte` conditions. `changed` takes a baseline before triggering. Watch deadlines, fetch failures and matching feedback can wake the relevant enabled channels; cross-channel subscriptions share the same project evidence. Unchanged failures do not repeatedly wake work. Paused channels are not automatically re-enabled. A watch linked to a release begins reading after that release is confirmed as published. No arbitrary user project is started by migration or installation.

`release.propose` copies a prepared project file (maximum 8 MiB) into private storage and seals the review content and artifact with SHA256. It requires linked features, concrete changes, expected benefit, check evidence, impact, rollback and an observation plan. This first release adapter uses a project-provided HTTP endpoint; larger deployments can use a small immutable deployment manifest as the artifact. The endpoint must implement the following contract and have its own appropriate deployment authorization. Provider-specific deployment integrations and authenticated analytics connectors are not bundled yet.

* POST the configured URL with `Idempotency-Key: <releaseId>` and JSON `{releaseId, reviewHash, artifact:{name, sha256, bytes, base64}}`.
* Return `{releaseId, artifactSha256, status:"published", url?}` only after publishing that exact artifact; an explicit unsuccessful deployment can return `status:"failed"`.
* GET the configured status URL with a `releaseId` query parameter returns the same receipt. Responses are limited to 512 KiB. Redirects are not followed.

The App's `POST /api/releases/:id/review` requires the displayed review hash and human decision. It is inaccessible to the scoped agent credential. Approval dispatches the sealed artifact; subsequent edits to the source file do not change it. A timeout or lost receipt becomes `unknown` and is reconciled using GET, never by repeating the deployment POST. New content requires a new proposal. HTTP success alone does not mark the release published: release ID, artifact digest and deployment status must match. This gate covers the Morrow release interface; native tools and credentials remain subject to the Codex App's own permissions.

`GET /api/projects/:id/work` returns the project records, optionally scoped with `itemId`. The shared board's “上线确认” tab presents reviewable releases; each feature shows its attempts, evidence, deployment state and feedback. Existing records and automatic-work permissions are preserved. An explicit Codex-only `native` scope can inherit the App's actual sandbox; selecting it does not modify the native task's permissions or create another session.

The automated suite and native UI acceptance use isolated databases, fake native transport and a local deployment/feedback receiver. They prove the state and execution mechanisms; they do not establish autonomous real-model performance or real business benefits. Real project acceptance requires a working native bridge plus that project's actual deployment and observation endpoints.

The daemon uses Node.js 24 or later and built-in SQLite. Codex connects to the existing local macOS App; Claude Code and Trae use their installed CLI runtimes. The service has no npm dependencies. Start it with `node service/server.ts`; `npm test` uses isolated databases, fake CLIs and simulated desktop IPC, without contacting a model provider.

## Local operation

The HTTP server binds exclusively to `127.0.0.1`. Defaults:

| Setting | Default |
| --- | --- |
| `MORROW_HOME` | `~/Library/Application Support/Morrow` |
| `MORROW_PORT` | `43821` |

The state directory is mode `0700`. A randomly generated `token` file is mode `0600`; clients send its contents using `Authorization: Bearer …`. `/health` is public and returns only service identity. All `/api/` routes require authentication, reject browser Origin headers, and accept JSON requests up to 1 MB. API snapshots never contain the access token. Do not put the token in a URL or command-line argument.

The directory contains `workspace.sqlite`, SQLite WAL files, `daemon.lock`, `token`, CLI artifacts under `runs/<run-id>/`, and selected-image copies under `native-images/`. Codex App conversation history and native records are authoritative in SQLite; they do not require a CLI artifact directory. These files contain private project context. Use SQLite's online backup facility for a running database, or stop the service before copying its files. There is no automatic history pruning.

Stop the daemon with SIGTERM or SIGINT. It stops scheduling and terminates only CLI process groups that it owns. A second daemon using the same data directory is rejected. After a crash, unfinished owned CLI runs are marked interrupted and their channels are paused; an orphan is killed only if its command still identifies the recorded run. Shared Codex App work continues when Morrow stops. On restart, Morrow reconnects to the App, reconciles native state, and distinguishes its scheduled turns from ordinary chat and externally started App turns. An uncertain submission is never automatically repeated.

## Linux and remote hosts

For the supported remote CLI adapters, install Node.js 24+ and authenticate the desired CLI on the remote host. Copy the complete `service/` directory; the TypeScript files import one another. No install or transpilation step is needed. Codex App conversation synchronization currently requires the same local Mac and user session; an SSH daemon does not connect back to the Mac's App or fall back to an independent Codex CLI.

```bash
mkdir -p "$HOME/.local/share/morrow"
MORROW_HOME="$HOME/.local/share/morrow" node service/server.ts
```

For persistent operation, run that command using your existing user service manager with the same environment and a PATH containing the authenticated CLI installations. Runtime discovery also checks `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, and `/usr/bin`. The Trae adapter searches `traex` then `traecli`; the graphical `trae` executable is not used.

Use an SSH local port forward to connect remotely. For example, forward local port 43822 to remote `127.0.0.1:43821`; authenticate the local client with the remote host's private token. Do not expose the daemon port publicly or copy provider credentials to the Mac. SSH and host authentication remain the responsibility of the connection layer; the daemon itself is a loopback HTTP service.

## Execution and permission boundaries

Projects use canonical existing directory paths. New projects create two paused channels with a read-only automatic-work scope, using the selected project runtime (Codex by default). A project owns one shared feature board; channel IDs record discovery provenance and ongoing responsibility. Creating a project or binding a task does not start model work. A user must send a message, start a round or enable scheduling. Explicit demo projects cannot run.

- **Codex App:** `codex-desktop-transport.ts` follows the existing App owner through its private local IPC protocol. It does not launch `codex exec`, a separate App Server, or a replacement owner. Normal chat inherits the task's actual model, tools, permissions and approval settings, and sends the original text and native image inputs without a scheduler wrapper. Input during a running turn uses the App's native steering path. Before a scheduled or manual responsibility round, Morrow checks that the current native sandbox is no broader than the channel's saved read-only/workspace-write scope. If the scope cannot be verified, or the App is disconnected or busy, Morrow refuses or postpones orchestration instead of widening permissions. Bound task IDs survive channel model and scope edits; these edits do not rewrite App settings.
- **Trae:** `exec --json` uses a read-only or workspace-write sandbox, `approval_policy="never"`, network access disabled for sandboxed workspace commands, and no dangerous bypass flags. The adapter does not set `--ignore-user-config`, `--ignore-rules` or `--output-schema`, retaining native provider/model configuration and project instructions. An explicitly selected Morrow model overrides the Trae default. Native configuration may initialize integrations, including MCP servers; the bounded-work prompt forbids using MCP, connectors, browser control, or remote tools. Runtime detection checks installation and command options, not login or quota. Authentication, quota and execution errors are recorded. Resumed CLI sessions receive the same permission overrides.
- **Claude Code:** `--safe-mode --restricted` keeps native authentication while disabling customizations. Strict empty MCP configuration and an explicit tool list constrain read-only runs to `Read,Grep,Glob`. Workspace editing adds only `Edit,Write` with `acceptEdits`; Bash and code execution are unavailable. Permission prompts are denied rather than bypassed. Consequently Claude cannot run a test command in this MVP; it should report verification limits honestly.

Responsibility rounds receive the project goal, channel objective, whole-project board, recent human notes and run summaries. Codex submits this bounded-work prompt to the bound App task; normal Codex chat does not receive it. The other adapters start or resume one noninteractive CLI round, and their human-note endpoint remains next-round context rather than live stdin. This is interval orchestration, not a filesystem watcher. Knowledge retains source, timestamp, origin channel/run and confirmation state; confirmed entries can be shared across sibling channels. Changing runtime/model/permission on an unbound legacy CLI channel clears its resume ID while keeping persisted context. A bound Codex channel retains its original App task; switching it to another runtime requires a separate channel.

Native Markdown output is retained. An optional fenced `morrow-report` JSON block can synchronize the project board; legacy JSON-only responses are still accepted. Reports must pass `protocol.ts` validation; verified/resolved agent findings need evidence and existing IDs must belong to the same project. Cross-channel updates preserve the first source channel and add the participating channel. Per-item revisions protect edits made after a run began: conflicting suggestions remain in the report and do not overwrite the current item.

Execution status and report status are independent. A successful responsibility round with a missing/invalid report remains completed, retains its original answer, changes no board items and continues at the configured interval when enabled. A failed native turn, terminal CLI failure or interruption retains failure semantics. Recoverable intermediate CLI diagnostics do not override terminal success. `needsHuman` in a valid report stops continuation. Normal Codex chat and externally started App turns are recorded without automatically interpreting their replies as board updates. Only final native assistant answers are treated as final run output; commentary stays in the conversation history.

Morrow serializes its responsibility rounds per project directory and waits for already-bound App tasks to become idle. A conflicting manual round returns HTTP 409. Independent App tasks remain owned by the App. Daily budgets count started Morrow orchestration attempts, including failures and interruptions, per UTC calendar day; normal Codex chat and external App turns do not consume that budget. Limits are 1–100 rounds/day and 1–1440 minutes between checks. An agent may suggest a longer interval but cannot shorten the configured minimum.

The owned CLI adapters have a 15-minute timeout, a 20 MiB combined stdout/stderr ceiling and a 1 MiB assembled-prompt limit. Those process limits are not applied to shared Codex App turns. Human-needed reports, definitive execution failures and unknown submissions stop automatic continuation. Pausing a CLI channel cancels its pending schedule and owned process group, including lingering tool subprocesses. Pausing an owned Codex responsibility round sends an interrupt for its exact native turn ID; it never kills the App or another App task.

A bounded-work prompt requires reviewable work and prohibits autonomous publication, deployment, external messages and destructive actions; this is not an independent OS policy engine and does not constrain every integration initialized by native configuration. Codex chat and native approval requests follow the App's own permission system. Morrow forwards supported approvals and structured questions using the exact pending native request ID; unsupported requests must be handled in the App. Morrow does not add its own file rollback, deployment permissions, token metering or dollar budget. Round quotas are the orchestration budget control.

## Test-only configuration

`MORROW_TEST_MODE=1` enables fake runtime executable paths via `MORROW_TEST_CODEX_PATH`, `MORROW_TEST_CLAUDE_PATH`, and `MORROW_TEST_TRAE_PATH`, plus `MORROW_TEST_TIMEOUT_MS` for fast CLI timeout testing. Unbound fake Codex CLI execution remains available only for these adapter regressions; ordinary installations require App binding. Native tests inject a fake desktop transport or use an isolated IPC server and temporary native catalog. Tests cover thread scope, native patches, complete/partial history, exact text, steering-message reconciliation, duplicate delivery, unknown outcomes, permissions, images, ownership-aware restart and report handling. They do not launch user projects or restart a user's App or daemon.

## Codex App conversation protocol

The transport attaches to the currently installed App's private local owner/follower IPC. It validates local socket ownership, performs the protocol handshake, subscribes to versioned snapshots and patches, and never takes ownership of the task. This is not a public compatibility promise: an unsupported protocol version or invalid revision sequence disables sending until synchronization can be restored. Global socket availability and individual thread readiness are separate; cached history remains readable during a disconnect without claiming the thread is connected.

Only explicitly bound tasks are mirrored. The read-only task catalog is filtered to the project's canonical directory. A listed task that is not currently open in the App may be bound with a synchronization error; opening it in the App activates its owner. The shared interface does not expose task creation. The desktop opens the App's project composer, the user starts the native task there, and then selects it for binding. Morrow does not pretend an independent CLI session is the same task.

Authenticated routes:

| Route | Behavior |
| --- | --- |
| `GET /api/native/status` | App connection state and currently supported capabilities |
| `GET /api/channels/:id/native/threads` | Catalog entries in this channel's project directory |
| `POST /api/channels/:id/native/bind {threadId}` | Persist an exact task binding; return its current conversation or synchronization error |
| `GET /api/channels/:id/native/conversation?before=<item-id>&limit=80` | Current native messages, tools, pending requests, thread readiness and paged history; limit 1–200 |
| `POST /api/channels/:id/native/messages {text,requestId,attachments?}` | Submit original input or steer the running turn; persist a pending/accepted/unknown/failed receipt |
| `POST /api/channels/:id/native/interrupt {turnId}` | Stop only the matching active native turn |
| `POST /api/channels/:id/native/respond {requestId,response}` | Answer the exact still-pending native approval or question |
| `GET /api/channels/:id/native/open` | Return project path and optional bound thread ID for the desktop's App deep link |
| `POST /api/channels/:id/native/create {}` | Return an explicit unsupported response; creation happens in the App composer |
| `POST /api/channels/:id/native/images {paths}` | Import images selected through the native desktop file picker |
| `GET /api/channels/:id/native/images/:itemId/:index` | Read an image referenced by the current bound native message |

Message request IDs are idempotency keys. Reusing one with changed text or attachment IDs is rejected. Lost acknowledgements remain unknown and are reconciled against native client/server message IDs; the service does not blindly retry. Native steering placeholders render as user messages and are merged with their canonical server messages without duplicate text. Protocol markers remain available in raw records without becoming extra chat bubbles.

Supported image imports are PNG, JPEG, WebP and GIF: at most five images, 10 MiB each and 20 MiB per import batch. Opaque attachment IDs are scoped to a channel and resolve to immutable private file copies with verified hashes. The App receives its native image input and manages model consumption. Native hosted images that cannot be retrieved through a supported local/data reference remain explicit App-only content.

SQLite `native_bindings`, `native_threads`, `native_items`, `native_turns`, `native_events`, `native_requests`, `native_outbox` and `native_attachments` retain task associations, full raw state, message projections, canonical turns, changed-record journals, pending requests, submission receipts and images. Duplicate revisions do not rewrite the journal; partial App history does not erase previously mirrored older messages. Projection versions allow an upgraded parser to rebuild existing records from the same native snapshot. Normal chat and external turns also appear in `runs` with `executionOwner: codex-app`, native turn IDs and `source: morrow-chat|native-app`; scheduled turns use `source: morrow-schedule`. Missing original timestamps are left unknown rather than invented.

## Structured events and history

CLI tool events optionally include `detail: {type, tool?, input?, output?, status?, sequence?, toolCallId?}`. `type` is `tool_use` or `tool_result`; Trae and historical Codex CLI command execution use `tool: "shell"`, file changes use `apply_patch`, and Claude tool names are retained. `toolCallId` links starts/results within a run. Multiple Claude tool blocks are retained as separate events (up to 40 per provider message). `sequence` is the durable event ordinal within its channel/run, including earlier plain events; it is assigned by the service, not accepted from provider output. Existing `text` is retained and legacy events remain readable without `detail`. Current Codex App conversation items use their separate full native representation described above.

Details are bounded to six nested levels, 40 entries per collection and a shared 6,000-character content budget. Sensitive credential fields and the daemon bearer are redacted before persistence. This is additional display metadata; tool metadata does not change execution permissions.

`GET /api/events?channelId=<id>&runId=<id>&before=<event-id>&limit=50` returns `{events, hasMore, cursor?}`. Provide `projectId` or `channelId`; if both are given they must agree. Optional `itemId` and `runId` further scope history. Omit `before` to get the latest events; use `after=<event-id>` instead for incremental reads. `before` and `after` are exclusive. `limit` defaults to 50 and accepts 1–200. All pages are returned oldest first in persistent write order, including events with identical timestamps.

For default/history pages, `cursor` is the oldest returned ID for the next `before` request. For `after` pages it is the newest returned ID for the next incremental request. Empty pages omit `cursor`. An initial incremental client should remember the last event ID of its initial page. Unknown or out-of-scope projects, channels, items, runs and cursors return 404; malformed, duplicate or unsupported parameters return 400. Authentication is identical to the other API routes. Desktop renderers should call through the main-process IPC proxy, preserving the daemon's browser Origin restriction.


## Project board and durable records

`POST /api/projects` accepts optional `runtime: codex|claude|trae`. Existing canonical folders return 409 without duplicating the project. `POST /api/projects/:id/items` accepts `{title,summary?,kind?,status?,evidence?,nextStep?,channelId?}`; kind defaults to `feature`, status to `open`, and omitted source channel becomes `""`. `PATCH /api/items/:id` accepts those editable content fields plus optional `revision`; the original `{status}` call remains supported. Project/first-source IDs cannot be edited. A stale supplied revision returns 409.

Items additionally store `projectId`, a stable project-local `number`, `sourceChannelIds`, `lastRunId`, and `revision`. Existing item IDs and first-source channel IDs are preserved by idempotent boot migration. Migration adds project ownership from each original channel; it does not merge items or invent historical run permissions/models that were not recorded.

Project/channel creation, channel configuration, accepted actions, messages, item changes/conflicts, and native handoff intents are persisted as events. Optional `projectId`, `itemId`, `actor` (`human|agent|system`), `action`, and `changes:{before?,after?}` associate audit entries with real records. Item mutations and their before/after audits commit together. Older plain events remain available without invented audit fields.

`GET /api/runs?projectId=<id>&channelId=<id>&before=<id>&limit=50` returns `{runs,hasMore,cursor?}`; filters are optional, `before/after` are exclusive, and limits are 1–200. Ordering/cursor behavior matches event history. `GET /api/runs/:id` returns `{run,prompt,finalOutput,report?}`, including old runs beyond the snapshot's latest 500. New runs persist project/runtime/model/permission/trigger, exact resumed session ID, native exit/signal and separate `reportStatus`/`reportError`.

CLI inputs and raw stdout/stderr chunks are mirrored in private SQLite `run_io` before the corresponding file copies. Unfinished output lines are persisted immediately. Final output and valid reports are mirrored too; file-export failure does not turn a durable successful run into failure. The CLI adapter's 20 MiB combined stdout/stderr ceiling applies only to these owned processes. Daemon bearer redaction handles CLI cross-chunk boundaries. Existing private run artifacts are mirrored once on migration within a 24 MiB per-run import bound. Codex App activity is persisted in the native tables during execution; associated runs also retain original user input, complete native turn data and final assistant output in `run_io`, with full raw records separate from display summaries.

`GET /api/runs/:id/output?after=<chunk-id>&limit=50` returns `{chunks,hasMore,cursor?}` with chronological `{id,runId,stream,text,createdAt,sequence}` chunks. Streams are `prompt|stdout|stderr|final|report`; limits are 1–100 and cursor IDs must belong to that run. All routes require the same bearer authentication. Snapshots do not contain bulk raw I/O.

`POST /api/channels/:id/native-handoff {}` is the legacy CLI terminal handoff. It requires a real project, available CLI, and every project channel paused/blocked/idle with scheduling disabled and no active execution. It records intent and returns `{projectPath,runtime,executable,sessionId}` without claiming a terminal opened. Session IDs survive pause/recovery; changing runtime/model/permission on those unbound CLI channels starts a separate session while retaining prior records. Bound Codex App channels use `/native/open` instead and do not detach their task on model or automatic-scope edits. Work performed after a Claude/Trae terminal handoff is owned by that CLI and is not mirrored live; this limitation does not apply to an already-bound Codex App conversation.
