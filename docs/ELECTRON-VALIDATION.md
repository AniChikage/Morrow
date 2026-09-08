# NoHuman 0.2.0 — Electron migration validation

Date: 2026-09-07. Platform: macOS, Apple Silicon.

## Delivered architecture

The desktop UI now uses Electron + React + TypeScript. Shared tokens, Radix primitives, Lucide icons and Markdown presentation replace the SwiftUI interface. Main-process business IPC connects to the independent Node 24 + SQLite service; daemon credentials never enter the renderer. The layout was independently implemented from Multica's visual reference and source architecture review, without copying its components or branding assets.

## Automated validation

- `npm run typecheck`: passed.
- `npm run test:ui`: 46 tests in 7 files passed (14 main-process validation/connection tests; 32 renderer, navigation, connection-state and event presentation tests).
- `npm test`: 17 service tests passed using temporary databases and fake CLI adapters.
- `npm run build:app`: production renderer/preload/main build and arm64 application packaging passed.
- `codesign --verify --deep --strict`: installed app passed ad-hoc signature verification.
- `hdiutil verify dist/NoHuman.dmg`: image checksum valid; approximately 182 MiB.

## Interactive validation

The local browser preview was checked at 1320×840 and 1000×760: project filtering, board/list switching, search and result opening, full finding document, channel note submission and clearing, channel settings, dialog dismissal and SSH directory defaults. Final clean page reload produced no warning/error console entries. Temporary preview server and viewport override were cleaned up.

The installed application was opened from `~/Applications/NoHuman.app`. It loaded the existing real workspace, displayed the project list and complete finding document, opened search through the native File menu and Command-K, opened the new-project dialog with Command-N, and displayed the native folder picker. The picker was cancelled without creating a project. Application reopening restored the active finding tab and history. The independent service continued responding after UI shutdown.

Native window captures (the Atlas content is explicitly labelled example data):

- [Project list](../artifacts/electron-20260907/project.jpg)
- [Complete finding](../artifacts/electron-20260907/finding-v020.jpg)

## Data migration verification

An online SQLite backup was created before replacement in the application's private `backups/electron-migration-2026-09-07T03-01-21.740Z` directory. The installer also preserved the previous application bundle.

Before the daemon upgrade, a fresh check confirmed all four channels paused and no active runs. Only that idle daemon was stopped; the new application started its bundled service. After migration, the complete projects, channels, items, runs and events arrays matched the backup exactly: 2 projects, 4 paused channels, 5 findings, 0 runs, 6 events. The new authenticated event-history endpoint returned HTTP 200 with an event cursor and `hasMore`.

## Scope of evidence

SSH validation, failed connections and fallback logic have automated coverage; a connection to a real remote host was not performed. No paid provider run was launched during this migration. Streaming tool presentation is covered by fixture and service-adapter tests, not a new live CLI session. The build is locally ad-hoc signed and has not been Apple-notarized. Legacy SwiftUI source remains available through `scripts/build-swiftui.sh` and does not replace the default Electron artifact.
