import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureNotice, runScenario } from '../scripts/acceptance/fixture.ts';
import smoke from '../scripts/acceptance/scenarios/smoke.ts';
import type { RunResult } from '../scripts/acceptance/fixture.ts';

const readLines = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** Runs the scenario into a throwaway report directory and hands back the report plus its files. */
async function run(): Promise<{ result: RunResult; out: string; remove(): void }> {
  const out = mkdtempSync(join(tmpdir(), 'morrow-acceptance-'));
  const result = await runScenario(smoke, { mode: 'fixture', policy: 'careful', out });
  return { result, out, remove: () => rmSync(out, { recursive: true, force: true }) };
}

test('the smoke scenario runs end to end in fixture mode with every invariant holding', async () => {
  const { result, out, remove } = await run();
  try {
    assert.deepEqual(result.failures, []);
    assert.equal(result.ok, true);
    assert.equal(result.invariants.length, smoke.invariants.length);
    for (const row of result.invariants) assert.equal(row.ok, true, `${row.name}: ${row.detail}`);

    const scheduled = smoke.timeline.filter((step) => step.verb === 'turn').length;
    assert.equal(result.turns, scheduled);
    assert.equal(result.turns, smoke.budget.turns);
    assert.equal(result.reviews, smoke.budget.reviews);
    assert.equal(result.timeline.length, smoke.timeline.length);
    assert.deepEqual(
      result.timeline.map((row) => row.verb),
      smoke.timeline.map((step) => step.verb)
    );

    // The loop actually closed: a sealed release, a human approval, and two contract reviews.
    const operations = result.calls.map((row) => row.operation);
    assert.equal(operations.filter((name) => name === 'release.propose').length, 1);
    assert.equal(operations.filter((name) => name === 'decision.choose').length, 2);
    assert.equal(operations.filter((name) => name === 'decision.review').length, 2);
    assert.equal(operations.filter((name) => name === 'verification.request').length, 1);
    assert(
      result.calls.every((row) => row.status === 200),
      'every work-interface call was accepted'
    );

    const timeline = readLines(join(out, 'timeline.jsonl'));
    assert.equal(timeline.length, smoke.timeline.length);
    assert.deepEqual(
      timeline.map((row) => row.verb),
      smoke.timeline.map((step) => step.verb)
    );
    assert(timeline.every((row) => typeof row.virtualTime === 'string' && row.virtualTime.endsWith('Z')));
    const calls = readLines(join(out, 'calls.jsonl'));
    assert.deepEqual(
      calls.map((row) => row.operation),
      operations
    );
    assert(existsSync(join(out, 'summary.md')));
    assert(result.summary.includes(fixtureNotice), 'the report states what a fixture run does not prove');
    assert.equal(readFileSync(join(out, 'summary.md'), 'utf8'), result.summary);

    const cleanup = JSON.parse(readFileSync(join(out, 'cleanup.json'), 'utf8'));
    assert.equal(cleanup.serviceClosed, true);
    assert.equal(cleanup.directoriesRemoved, true);
    assert(cleanup.channelsPaused >= 1);
    assert.equal(existsSync(cleanup.root), false, 'the temporary data directory is gone');
  } finally {
    remove();
  }
});

test('two runs of the same scenario issue the same sequence of work-interface operations', async () => {
  const first = await run();
  const second = await run();
  try {
    assert.equal(first.result.ok, true);
    assert.equal(second.result.ok, true);
    // Ids and timestamps differ every run; the sequence of operations and their outcomes must not.
    assert.deepEqual(
      second.result.calls.map((row) => `${row.operation}:${row.status}`),
      first.result.calls.map((row) => `${row.operation}:${row.status}`)
    );
    assert.deepEqual(
      second.result.timeline.map((row) => `${row.verb}:${row.virtualTime}`),
      first.result.timeline.map((row) => `${row.verb}:${row.virtualTime}`)
    );
    assert.deepEqual(
      second.result.invariants.map((row) => row.name + row.ok),
      first.result.invariants.map((row) => row.name + row.ok)
    );
    assert.equal(second.result.turns, first.result.turns);
    assert.equal(second.result.reviews, first.result.reviews);
  } finally {
    first.remove();
    second.remove();
  }
});
