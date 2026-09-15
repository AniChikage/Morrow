import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { CodexCliReviewRunner, type ReviewObservation } from '../service/codex-cli-review.ts';
import { CodexUsageReader, parseUsageReading } from '../service/codex-usage.ts';
import { until } from './harness/wait.ts';
const executable = resolve('tests/fixtures/codex-review.mjs');
const worker = resolve('service/codex-cli-worker.ts');
const runner = (maxBytes?: number) =>
  new CodexCliReviewRunner({
    executable: () => executable,
    env: { ...process.env, MORROW_SECRET_GRANT: 'must-not-leak', CODEX_APP_TOOLS_PIPE_PATH: '/private/app.sock' },
    maxBytes,
  });
/**
 * The pid of the CLI the fixture started. `writeFileSync` creates the file before it holds the pid,
 * so a test that only waits for the path can read `''`, and `process.kill(0, 0)` addresses this
 * process group instead of a dead CLI — it never throws. Waiting for the digits reads the real pid.
 */
const ownedPid = (pidFile: string, timeoutMs = 5000) =>
  until(() => {
    const text = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '';
    return /^[0-9]+$/.test(text) ? Number(text) : 0;
  }, timeoutMs);
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
};
test('only ESRCH proves that the owned process disappeared', (t) => {
  for (const [code, expected] of [
    ['ESRCH', true],
    ['EPERM', false],
    ['EINVAL', false],
    [undefined, false],
  ] as const) {
    t.mock.method(process, 'kill', () => {
      throw Object.assign(new Error('probe failed'), { code });
    });
    assert.equal(gone(123), expected, String(code));
    t.mock.restoreAll();
  }
  t.mock.method(process, 'kill', () => true);
  assert.equal(gone(123), false);
});

async function run(mode: string, maxBytes?: number) {
  const observations: ReviewObservation[] = [];
  const r = runner(maxBytes).start({
    cwd: tmpdir(),
    prompt: JSON.stringify({ mode }),
    timeoutMs: 5000,
    observe: (o) => observations.push(o),
  });
  await r.done;
  return observations;
}
test('read-only CLI review requires native completion and successful exit; session IDs are real and missing turn IDs stay missing', async () => {
  const rows = await run('success');
  const last = rows.at(-1)!;
  assert.equal(last.status, 'completed');
  assert.equal(last.threadId, 'fixture-cli-session');
  assert.equal(last.turnId, undefined);
  assert.equal(last.items[0].type, 'commandExecution');
  assert.equal(last.items[0].exitCode, 0);
  assert.match(last.items[1].text, /morrow-verification/);
  for (const mode of ['nonzero', 'missing-completion', 'malformed', 'oversized']) {
    const last = (await run(mode, mode === 'oversized' ? 2048 : undefined)).at(-1)!;
    assert.equal(last.status, 'failed', mode);
    assert(last.error);
  }
});
test('review cancellation stops the initialized owned CLI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-review-cancel-'));
  const pidFile = join(root, 'cancel.pid');
  const observations: ReviewObservation[] = [];
  const execution = runner().start({
    cwd: root,
    prompt: JSON.stringify({ mode: 'hang', pidFile }),
    timeoutMs: 5000,
    observe: (o) => observations.push(o),
  });
  try {
    const pid = await ownedPid(pidFile, 4000);
    execution.cancel();
    await execution.done;
    assert.equal(observations.at(-1)!.status, 'failed');
    await until(() => gone(pid) && gone(-pid), 5000);
  } finally {
    execution.cancel();
    await execution.done;
    rmSync(root, { recursive: true, force: true });
  }
});
for (const mode of ['hang', 'initializing']) {
  test(`worker deadline ends the CLI without requiring initialization (${mode})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'morrow-review-deadline-'));
    const pidFile = join(root, 'initialized.pid');
    const spawnedPidFile = join(root, 'spawned.pid');
    const observations: ReviewObservation[] = [];
    const execution = runner().start({
      cwd: root,
      prompt: JSON.stringify({ mode, pidFile, spawnedPidFile }),
      timeoutMs: 600,
      observe: (o) => observations.push(o),
    });
    let finished = false;
    void execution.done.then(() => (finished = true));
    try {
      // The deadline starts before CLI initialization. A missing PID is valid if it expired first.
      // This watchdog fails if the worker never finishes; cancellation happens only in cleanup.
      await until(() => finished, 5000);
      assert.equal(observations.at(-1)!.status, 'failed');
      if (mode === 'initializing') {
        assert.equal(observations.at(-1)!.threadId, undefined);
        assert.equal(existsSync(pidFile), false);
      }
      for (const path of [spawnedPidFile, pidFile]) {
        if (!existsSync(path)) continue;
        const pid = Number(readFileSync(path, 'utf8').trim());
        assert(Number.isSafeInteger(pid) && pid > 0, 'published PID must identify an owned process');
        await until(() => gone(pid) && gone(-pid), 5000);
      }
    } finally {
      execution.cancel();
      await execution.done;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test('a killed service cannot leave its review CLI running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-review-parent-')),
    pidFile = join(root, 'child.pid');
  const module = resolve('service/codex-cli-review.ts');
  const code = `const {CodexCliReviewRunner}=await import(${JSON.stringify(module)}); await new CodexCliReviewRunner({executable:()=>${JSON.stringify(executable)}}).start({cwd:${JSON.stringify(root)},prompt:${JSON.stringify(JSON.stringify({ mode: 'hang', pidFile }))},timeoutMs:10000,observe:()=>{}}).done;`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
  try {
    const pid = await ownedPid(pidFile);
    parent.kill('SIGKILL');
    await until(() => gone(pid), 5000);
  } finally {
    parent.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
/**
 * `service/runtime-helpers.ts` copies the supervisor into the data directory at boot and the daemon
 * spawns that copy for as long as it runs, so an install cannot replace it under a review in flight.
 * The copy has neither the source tree nor its `package.json` around it, which is what these two
 * tests hold in place: it must run standalone, and it must keep importing `node:` builtins only.
 */
test('a supervisor copied out of the source tree runs a whole review on its own', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-review-pinned-'));
  const copy = join(root, 'codex-cli-worker.ts');
  copyFileSync(worker, copy);
  try {
    const pinned = new CodexCliReviewRunner({ executable: () => executable, worker: () => copy });
    assert.equal(pinned.worker, copy);
    const observations: ReviewObservation[] = [];
    await pinned.start({
      cwd: tmpdir(),
      prompt: JSON.stringify({ mode: 'success' }),
      timeoutMs: 5000,
      observe: (o) => observations.push(o),
    }).done;
    const last = observations.at(-1)!;
    assert.equal(last.status, 'completed', last.error);
    assert.equal(last.threadId, 'fixture-cli-session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('the supervisor imports node: builtins only, so the pinned copy cannot lose a dependency', () => {
  const specifiers = [...readFileSync(worker, 'utf8').matchAll(/\b(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1]
  );
  assert(specifiers.length > 0, 'the supervisor must still declare the imports it runs on');
  for (const specifier of specifiers) assert(specifier.startsWith('node:'), specifier);
});
test('usage is read without creating a task, unknown percentages stay unknown, and concurrent reads share one request', async () => {
  const reader = new CodexUsageReader({ executable: () => executable, timeoutMs: 3000 });
  try {
    const a = reader.read(),
      b = reader.read();
    assert.equal(a, b);
    assert.equal((await a)?.windows[0].usedPercent, 31);
    assert.equal(parseUsageReading({ rateLimits: { primary: { usedPercent: null } } }), undefined);
  } finally {
    reader.close();
  }
});
