/**
 * Test-mode preamble shared by every service test that starts a server. Import it before any
 * `service/` module so runtime discovery finds the fixture CLI instead of probing this Mac.
 * `node --test` runs one process per file, so these settings never leak between files, and the
 * fixture path is resolved from this module rather than the working directory.
 */
import { fileURLToPath } from 'node:url';
process.env.MORROW_TEST_MODE = '1';
const fixture = fileURLToPath(new URL('../fixtures/runtime.mjs', import.meta.url));
// One fixture stands in for every runtime; it answers both CLI shapes and reports which one it saw.
for (const id of ['CODEX', 'CLAUDE', 'TRAE']) process.env[`MORROW_TEST_${id}_PATH`] = fixture;
