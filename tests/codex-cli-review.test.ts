import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { CodexCliReviewRunner, type ReviewObservation } from '../service/codex-cli-review.ts';
import { CodexUsageReader, parseUsageReading } from '../service/codex-usage.ts';
import { until } from './harness/wait.ts';
const executable = resolve('tests/fixtures/codex-review.mjs');
const runner = (maxBytes?: number) =>
  new CodexCliReviewRunner({
    executable: () => executable,
    env: { ...process.env, MORROW_SECRET_GRANT: 'must-not-leak', CODEX_APP_TOOLS_PIPE_PATH: '/private/app.sock' },
    maxBytes,
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
test('review cancellation stops only the owned CLI and the worker deadline independently bounds it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-review-cancel-'));
  try {
    for (const deadline of [false, true]) {
      const pidFile = join(root, deadline ? 'deadline.pid' : 'cancel.pid');
      const observations: ReviewObservation[] = [];
      const execution = runner().start({
        cwd: root,
        prompt: JSON.stringify({ mode: 'hang', pidFile }),
        timeoutMs: deadline ? 600 : 5000,
        observe: (o) => observations.push(o),
      });
      await until(() => existsSync(pidFile), 4000, 20);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (!deadline) execution.cancel();
      await execution.done;
      assert.equal(observations.at(-1)!.status, 'failed');
      assert.throws(() => process.kill(pid, 0));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('a killed service cannot leave its review CLI running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-review-parent-')),
    pidFile = join(root, 'child.pid');
  const module = resolve('service/codex-cli-review.ts');
  const code = `const {CodexCliReviewRunner}=await import(${JSON.stringify(module)}); await new CodexCliReviewRunner({executable:()=>${JSON.stringify(executable)}}).start({cwd:${JSON.stringify(root)},prompt:${JSON.stringify(JSON.stringify({ mode: 'hang', pidFile }))},timeoutMs:10000,observe:()=>{}}).done;`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
  try {
    await until(() => existsSync(pidFile), 5000, 20);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    parent.kill('SIGKILL');
    await until(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      5000,
      20
    );
  } finally {
    parent.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
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
