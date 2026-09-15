import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildIdentity } from '../service/build-identity.ts';
import { helperDirectory, pinHelpers, pruneHelpers } from '../service/runtime-helpers.ts';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';

/**
 * `scripts/install-app.sh` replaces the bundle at the path the running daemon was started from, so
 * until the automatic switch completes the old daemon would spawn the new helper out of its own
 * installation directory. Each build's helpers are copied into the data directory at boot instead,
 * and the copy is never refreshed under a daemon that is already running.
 */
const source = fileURLToPath(new URL('../service/agent-cli.ts', import.meta.url));
const fingerprint = 'a'.repeat(64);
const identity = (value = fingerprint, bundlePath = '/Applications/Morrow.app'): BuildIdentity => ({
  bootId: 'boot-under-test',
  commit: 'd'.repeat(40),
  version: '0.9.6',
  fingerprint: value,
  bundlePath,
});

test('an installed build spawns the work-interface helper from its own copy, not from the bundle', async () => {
  const s = await startIsolated({ identity: identity() });
  try {
    const pinned = join(helperDirectory(s.home, fingerprint), 'agent-cli.ts');
    assert.equal(s.engine.loop.helpers['agent-cli.ts'], pinned);
    assert.deepEqual(readFileSync(pinned), readFileSync(source));
    assert.equal(statSync(pinned).mode & 0o777, 0o600);
    // The launcher every turn is told to run points at that copy, which no installer touches.
    const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    const launcher = readFileSync(join(s.home, 'runs', grant.run.id, 'tool.sh'), 'utf8');
    assert(launcher.includes(`'${pinned}'`), launcher);
    assert(!launcher.includes(source), launcher);
  } finally {
    await s.cleanup();
  }
});

test('a development checkout keeps spawning the helper from the source tree', async () => {
  const s = await startIsolated({ identity: identity('unknown', '') });
  try {
    assert.equal(s.engine.loop.helpers['agent-cli.ts'], source);
    assert.equal(existsSync(join(s.home, 'runtime')), false);
    const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    const launcher = readFileSync(join(s.home, 'runs', grant.run.id, 'tool.sh'), 'utf8');
    assert(launcher.includes(`'${source}'`), launcher);
  } finally {
    await s.cleanup();
  }
});

test('a copy already in place survives a new install, and other builds are pruned once this one is up', async () => {
  const s = await startIsolated({ identity: identity(), project: false });
  try {
    const pinned = join(helperDirectory(s.home, fingerprint), 'agent-cli.ts');
    // Stand in for the helper of the build that was running when a new bundle was installed: a
    // second resolution must keep it rather than copy the newly installed source over it.
    writeFileSync(pinned, '// the running build\n');
    assert.deepEqual(pinHelpers(s.home, fingerprint), { 'agent-cli.ts': pinned });
    assert.equal(readFileSync(pinned, 'utf8'), '// the running build\n');
    // A previous build's copies stay until a boot comes up with its own, and then go.
    const older = helperDirectory(s.home, 'b'.repeat(64));
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, 'agent-cli.ts'), '// an older build\n');
    await s.restart({ identity: identity() });
    assert.equal(existsSync(older), false);
    assert.equal(readFileSync(pinned, 'utf8'), '// the running build\n');
    // A dev run prunes nothing, so an installed build's copies survive a development daemon.
    pruneHelpers(s.home, 'unknown');
    assert.equal(existsSync(pinned), true);
  } finally {
    await s.cleanup();
  }
});
