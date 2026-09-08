# NoHuman project guide

Read `docs/PRODUCT-DIRECTION.md` before changing product behavior or visual design. It records the user's accepted design and operating model.

- Preserve the accepted Electron/React gray-white Multica-inspired shell, compact rows, tabs, readable central document, and narrow properties panel. Reference `artifacts/electron-20260907/project.jpg` and `finding-v020.jpg`; do not replace this with a dashboard/card-heavy redesign.
- Each project is an existing local or remote folder and owns one shared feature board. Channels represent continuing responsibilities and feature provenance, not separate task databases or boards.
- Native CLIs own authentication, model/provider configuration, tools, session history and execution. NoHuman orchestrates bounded ongoing work, resumes exact native sessions, records observations and maintains the project board. Never invent successful runs, findings, test evidence or login status.
- Persist operational records and full bounded run I/O in SQLite, with native session/run/channel/project references. Renderer localStorage is for view preferences only. Preserve old data with additive, idempotent migrations.
- Test meaningful service/UI flows with isolated databases and fake CLIs. Use CUA for rendered/native UI verification. Do not run user projects or restart a working daemon merely to test a UI change.
- `npm run typecheck`, `npm test`, `npm run test:ui`, `npm run build:app` validate and package the default Electron app. SwiftUI is a legacy fallback, not the current product.
