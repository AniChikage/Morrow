# Morrow 0.3.0 validation

Date: 2026-09-07. Platform: macOS, Apple Silicon.

## Product changes

The accepted gray-white Electron layout is preserved in `AGENTS.md` and `PRODUCT-DIRECTION.md`. The runtime page now presents a compact machine header and CLI rows with separate installation and unverified login status. Each project owns one feature board; channels provide origin and participation. Manual features, stable project numbers, edits, revision conflicts and before/after audit records are connected through validated business IPC.

Opening a project starts from an existing folder and a default native runtime. Native handoff opens the exact saved session or an interactive CLI in that folder; it requires the entire project to be paused and local. Native authentication and session history stay with the CLI. Morrow schedules bounded rounds and mirrors the I/O it manages; manually continued terminal sessions are not silently imported.

New service records persist project/channel/item associations, trigger, permissions, native session, exit status, input, raw output and optional board report. CLI success and board synchronization are independent. Public output chunks are immutable: an unfinished bearer prefix remains in a private SQLite pending row until it can be finalized without leaking it or changing a previously read cursor.

## Automated verification

- `npm run typecheck`: passed.
- `npm run test:ui`: 103 tests across 11 files passed.
- Bundled Node 24 `node --test tests/*.test.ts`: 25 tests passed.
- Service-specific TypeScript check: passed.
- `npm run build:app`: production Electron 0.3.0 build and arm64 packaging passed.
- `codesign --verify --deep --strict dist/Morrow.app`: passed.
- Final `hdiutil verify dist/Morrow.dmg`: checksum valid (190,555,700 bytes).
- Packaged service files match the current source byte-for-byte, including the new report parser.
- The 128 tests use temporary databases and fake CLI adapters; none launched a paid provider run or modified user projects.

Coverage includes folder selection and duplicate project navigation; manual feature creation and conflict reload; whole-project cross-channel updates; refusal of cross-project IDs and stale revisions; immutable raw-output pagination; all 63 split points of a synthetic daemon bearer; interrupted-output recovery; CLI success without a usable report; native handoff preconditions and shell quoting; durable history beyond the snapshot; UI pagination, error recovery and stale async response isolation. Channel history is fetched even when no events for that channel remain in the recent snapshot. Project/channel/run pagination treats the API page as authoritative, merges only loaded-ID updates and new live records, and does not leak hundreds of older snapshot entries ahead of the cursor. Same-timestamp large-history tests confirm that every subsequent page actually advances.

## Rendered verification

CUA browser checks at 1280×720 and 1000×720 covered compact runtime rows, project board/list switching, source labels, manual creation, editing, version and audit display, input and output inspection. Neither the document nor the compact toolbar/runtime table overflowed their viewport. A final clean page produced no console errors. Temporary viewport override was reset and the preview tab/server were closed.

Preview artifacts are clearly example data, not real CLI evidence:

- [Runtime rows](../artifacts/product-v030/runtime-preview.jpg)
- [Unified project board](../artifacts/product-v030/unified-board-preview.jpg)
- [Feature editing and audit](../artifacts/product-v030/feature-history-preview.jpg)
- [Run input](../artifacts/product-v030/run-input-preview.jpg)
- [Raw output](../artifacts/product-v030/run-output-preview.jpg)

## Backup and installation

An online SQLite backup was created at `~/Library/Application Support/Morrow/backups/product-v030-20260907T041607Z/`. Pre-upgrade counts: 2 projects, 4 paused channels, 5 items, 0 runs, 6 events; no enabled schedules. No user records were changed during tests.

The bundled Node v24.20.0 service was run against a temporary copy of this backup. Every existing field in projects/channels/items/runs/events was retained; all board project IDs, numbers, source IDs and revisions were backfilled. A second open was identical and SQLite integrity_check returned ok. See [copy migration check](../artifacts/product-v030/migration-copy-check.json).

Installation completed later on 2026-09-07 after the Mac was unlocked. A new online backup was created at `~/Library/Application Support/Morrow/backups/install-v030-20260907T060046Z/`. The installer preserved the previous application bundle, and installed `~/Applications/Morrow.app` version 0.3.0. The installed asar and all eight service source files match the build byte-for-byte; signature verification passed.

A fresh check confirmed all channels paused and schedules disabled before stopping the old idle daemon (PID 87674). The installed app started its bundled Node 24 service (PID 47758 at initial verification). No active run was interrupted. Existing project/channel/item/run/event counts remained 2/4/5/0/6 immediately after migration, and every preexisting field was retained. Project IDs, stable numbers, source IDs and revisions were backfilled; SQLite integrity_check returned ok. Authenticated project event history and run history endpoints responded correctly. See [installed migration verification](../artifacts/product-v030/installed-migration-check.json).

Native CUA verification covered the real runtime list (three installed CLIs with exact versions and paths), project-wide board and source labels, complete legacy feature/evidence display, new-project dialog, and the macOS folder picker. The picker and empty form were cancelled without creating test records. Native captures:

- [Installed runtime list](../artifacts/product-v030/installed-runtimes.jpg)
- [Runtime path details](../artifacts/product-v030/installed-runtime-details.jpg)
- [Installed feature detail](../artifacts/product-v030/installed-feature.jpg)
- [Folder-first project dialog](../artifacts/product-v030/installed-open-folder.jpg)

During acceptance the user independently created the `wanted` project and a `测试` channel, entered a note, and started a Codex run. These records, the native session ID, the 2,142-character prompt and seven prompt/stdout/stderr chunks were verified through the authenticated installed service. All preexisting records remained intact. The agent did not start, retry or interrupt this user run. The installed UI displayed its run-history entry and failed state.

This real execution did **not** pass: the provider returned HTTP 400 stating that `gpt-6-astra` requires a newer Codex version. Morrow selected the user's existing `~/.local/bin/codex`, version 0.150.1. A newer binary exists at `/Applications/ChatGPT.app/Contents/Resources/codex` and reports 0.153.3, but its model compatibility has not been exercised and the user's global CLI entry/configuration was not changed. Installation, migration, UI and error/I/O persistence passed; successful execution with the chosen native model remains an environment compatibility follow-up. See [observed user run](../artifacts/product-v030/user-session-observation.json) and [final installed state](../artifacts/product-v030/final-install-state.json).

## Evidence boundaries

The agent launched no live model call or SSH-host session during installation. The user-initiated live call observed above failed for the stated CLI/model compatibility reason. Native launch arguments and process behavior were verified with executable fixtures and Electron shell mocks. Claude automation keeps its restricted tool policy; native terminal handoff uses the CLI's own interactive configuration. Existing historical artifacts are imported up to 24 MiB per run, and new stdout/stderr retains the existing 20 MiB execution ceiling. Native manual-session I/O remains owned by the CLI. The package is locally ad-hoc signed, not Apple-notarized.
