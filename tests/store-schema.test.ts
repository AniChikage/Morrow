import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_TABLES, Store, TABLES } from '../service/store.ts';

/**
 * The tables a fresh data directory ends up with, written out once. `TABLES` is now the single list
 * the constructor, the project indexes and the `table()` allow-list all read, so this literal is the
 * independent copy: a table added, removed or renamed by accident shows up here, and a deliberate
 * one is added in the same commit as the migration that keeps the old rows readable.
 */
const expected = [
  'app_resumes',
  'channel_intents',
  'channels',
  'controls',
  'events',
  'items',
  'knowledge',
  'loop_calls',
  'loop_evidence',
  'loop_executions',
  'loop_finalizations',
  'loop_grants',
  'loop_learning',
  'loop_releases',
  'loop_verification_events',
  'loop_verifications',
  'loop_waits',
  'loop_watches',
  'migrations',
  'native_attachments',
  'native_bindings',
  'native_events',
  'native_items',
  'native_outbox',
  'native_requests',
  'native_threads',
  'native_turns',
  'project_brief_revisions',
  'projects',
  'results',
  'run_io',
  'run_io_pending',
  'runs',
  'settings',
  'strategy_decisions',
  'strategy_revisions',
  'strategy_runs',
  'strategy_signals',
  'strategy_understanding',
  'upgrades',
  'usage_samples',
];

function open() {
  const root = mkdtempSync(join(tmpdir(), 'morrow-store-'));
  const store = new Store(join(root, 'workspace.sqlite'));
  return { store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a fresh store creates exactly the declared tables, and the project index covers the declared subset', () => {
  const { store, cleanup } = open();
  try {
    const created = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.deepEqual(created, expected);
    assert.deepEqual([...TABLES].sort(), expected);
    // One `$.projectId` index per project-scoped table, and no project index on any other table.
    const indexed = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%_project' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.deepEqual(
      indexed,
      [...PROJECT_TABLES, 'events', 'items', 'knowledge', 'runs'].map((t) => `${t}_project`).sort()
    );
    assert.ok(PROJECT_TABLES.every((table) => (TABLES as readonly string[]).includes(table)));
  } finally {
    cleanup();
  }
});

test('the store only interpolates a declared table name into SQL', () => {
  const { store, cleanup } = open();
  try {
    for (const table of TABLES) assert.equal(store.table(table), table);
    for (const name of ['sqlite_master', 'items;drop', 'Items', '', 'unknown_table'])
      assert.throws(() => store.table(name), /Unknown table/);
  } finally {
    cleanup();
  }
});
