import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearSourceVersionCache, readSourceVersion, sourceVersion } from '../service/source-version.ts';

test('asset-rich projects hash complete large files with bounded buffers and detect tail changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-source-assets-'));
  try {
    const path = join(root, 'video.mp4'),
      fd = openSync(path, 'w');
    ftruncateSync(fd, 65 * 1024 * 1024);
    closeSync(fd);
    const before = sourceVersion(root);
    assert.equal(before.bytes, 65 * 1024 * 1024);
    assert.equal(before.scheme, 'source-v2');
    const changed = openSync(path, 'r+');
    writeSync(changed, Buffer.from('changed tail'), 0, 12, 65 * 1024 * 1024 - 12);
    closeSync(changed);
    assert.notEqual(sourceVersion(root).digest, before.digest);
    const oversized = openSync(path, 'r+');
    ftruncateSync(oversized, 1024 * 1024 * 1024 + 1);
    closeSync(oversized);
    assert.throws(() => sourceVersion(root), /1 GiB/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nested dependency links and package caches stay outside Git source seals while application links still fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-source-deps-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], {
      stdio: 'ignore',
    });
  try {
    git('init');
    git('config', 'user.email', 'acceptance@localhost');
    git('config', 'user.name', 'Morrow test');
    writeFileSync(join(root, 'app.js'), 'original');
    mkdirSync(join(root, 'packages/cli/node_modules'), { recursive: true });
    mkdirSync(join(root, '.pnpm-store'));
    symlinkSync('/outside-dependency', join(root, 'packages/cli/node_modules/dependency'));
    writeFileSync(join(root, '.pnpm-store/index.db'), 'cache');
    git('add', '.');
    git('commit', '-m', 'fixture');
    const before = sourceVersion(root);
    assert.equal(before.coverage, 'git-tracked-and-unignored');
    assert.equal(before.files, 1);
    writeFileSync(join(root, '.pnpm-store/index.db'), 'updated cache');
    assert.equal(sourceVersion(root).digest, before.digest);
    writeFileSync(join(root, 'app.js'), 'changed');
    assert.notEqual(sourceVersion(root).digest, before.digest);
    symlinkSync('/etc/hosts', join(root, 'application-link'));
    assert.throws(() => sourceVersion(root), /链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cached source seal is reused only while Git reports the same commit and working tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-source-cache-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], {
      stdio: 'ignore',
    });
  try {
    clearSourceVersionCache();
    git('init');
    git('config', 'user.email', 'acceptance@localhost');
    git('config', 'user.name', 'Morrow test');
    writeFileSync(join(root, 'app.js'), 'original');
    git('add', '.');
    git('commit', '-m', 'fixture');
    const first = readSourceVersion(root);
    assert.equal(first.cached, false);
    assert.equal(first.version!.digest, sourceVersion(root).digest);
    // An unchanged tree is answered from the cache instead of hashing every file again.
    const again = readSourceVersion(root);
    assert.equal(again.cached, true);
    assert.equal(again.version!.digest, first.version!.digest);
    // Every way the sealed content can change moves the key: an edit, a new untracked file, a commit.
    writeFileSync(join(root, 'app.js'), 'changed');
    const edited = readSourceVersion(root);
    assert.equal(edited.cached, false);
    assert.notEqual(edited.version!.digest, first.version!.digest);
    assert.equal(readSourceVersion(root).cached, true);
    writeFileSync(join(root, 'extra.js'), 'new');
    const untracked = readSourceVersion(root);
    assert.equal(untracked.cached, false);
    // An already-dirty file edited again leaves the status line identical; the stat in the key moves.
    writeFileSync(join(root, 'app.js'), 'changed twice');
    const rewritten = readSourceVersion(root);
    assert.equal(rewritten.cached, false);
    assert.notEqual(rewritten.version!.digest, untracked.version!.digest);
    git('add', '.');
    git('commit', '-m', 'second');
    const committed = readSourceVersion(root);
    assert.equal(committed.cached, false);
    assert.equal(committed.version!.head, sourceVersion(root).head);
    // A version that cannot be read carries its reason instead of throwing, and is not re-read either.
    symlinkSync('/etc/hosts', join(root, 'application-link'));
    const broken = readSourceVersion(root);
    assert.equal(broken.version, undefined);
    assert.match(broken.reason!, /链接/);
    assert.equal(readSourceVersion(root).cached, true);
    // A path that is not a directory at all reports the reason without caching anything.
    const missing = readSourceVersion(join(root, 'no-such-directory'));
    assert.equal(missing.version, undefined);
    assert(missing.reason);
  } finally {
    clearSourceVersionCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a plain folder outside Git has no cheap invalidation key and is always read fresh', () => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-source-folder-'));
  try {
    clearSourceVersionCache();
    writeFileSync(join(root, 'notes.md'), 'first');
    const first = readSourceVersion(root);
    assert.equal(first.cached, false);
    assert.equal(first.version!.coverage, 'folder');
    // Nothing is cached, so an edit Git cannot report is still seen on the next reading.
    assert.equal(readSourceVersion(root).cached, false);
    writeFileSync(join(root, 'notes.md'), 'second');
    assert.notEqual(readSourceVersion(root).version!.digest, first.version!.digest);
  } finally {
    clearSourceVersionCache();
    rmSync(root, { recursive: true, force: true });
  }
});
