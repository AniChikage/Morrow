import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { APIError } from './protocol.ts';
import type { TreeState } from './protocol.ts';
import type { SourceVersion } from './verification-types.ts';

/** The same bounded, lock-free `git` invocation the source seal uses; stderr is dropped. */
function git(root: string, args: string[]) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}
/** Paths kept in a tree reading, so one wait event and one turn note stay readable. */
const treeFileLimit = 50;
/**
 * Whether a project directory has uncommitted changes right now, with up to 50 repo-relative paths.
 * Read-only and never throwing: a directory that is not a repository, or any git failure, reads as
 * `{dirty:false, files:[], unknown:true}` so a missing reading can never block a channel.
 */
export function projectTreeState(directory: string): TreeState {
  try {
    const files = git(directory, ['status', '--porcelain', '--untracked-files=normal'])
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim());
    return { dirty: files.length > 0, files: files.slice(0, treeFileLimit) };
  } catch {
    return { dirty: false, files: [], unknown: true };
  }
}

/** No project commands/hooks are run. Ignored dependencies/build products are outside this source seal. */
export function sourceVersion(directory: string): SourceVersion {
  const root = realpathSync(directory),
    maxBytes = 1024 * 1024 * 1024,
    started = performance.now();
  // Dependencies are outside this source-only seal even when accidentally tracked
  // by Git. Keep assets and tracked build inputs; never silently sample large files.
  const dependencies = new Set(['node_modules', '.pnpm-store']);
  const read = (args: string[]) => git(root, args);
  let paths: string[] = [],
    head = '',
    coverage: SourceVersion['coverage'] = 'folder';
  try {
    const top = realpathSync(read(['rev-parse', '--show-toplevel']).trim());
    if (top === root) {
      paths = read(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
      head = read(['rev-parse', '--verify', 'HEAD']).trim();
      coverage = 'git-tracked-and-unignored';
    }
  } catch {
    /* Unborn repositories and plain local folders use the bounded traversal. */
  }
  if (coverage === 'folder') {
    const excluded = new Set(['.git', ...dependencies, '.build', 'dist', 'build', '.next', '.cache', '.DS_Store']);
    const visit = (dir: string) => {
      for (const row of readdirSync(dir, { withFileTypes: true })) {
        if (excluded.has(row.name)) continue;
        const path = join(dir, row.name);
        if (row.isDirectory()) visit(path);
        else paths.push(relative(root, path));
        if (paths.length > 5000) throw new APIError(409, '源版本超过 5000 个文件，无法完整封存，不能报告验证通过');
      }
    };
    visit(root);
  }
  paths = [...new Set(paths)].filter((path) => !path.split('/').some((part) => dependencies.has(part))).sort();
  if (paths.length > 5000) throw new APIError(409, '源版本超过 5000 个文件，无法完整封存');
  // Keep the v2 salt stable so the rebrand does not invalidate sealed historical evidence.
  const hash = createHash('sha256').update('nohuman-source-v2\0'),
    buffer = Buffer.allocUnsafe(512 * 1024);
  let bytes = 0;
  for (const path of paths) {
    if (performance.now() - started > 5000)
      throw new APIError(409, '源版本读取超过 5 秒，无法完整核验，请检查本地磁盘或项目规模');
    const full = join(root, path);
    let stat;
    try {
      stat = lstatSync(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        hash.update(JSON.stringify([path, 'deleted']));
        continue;
      }
      throw error;
    }
    if (stat.isDirectory()) throw new APIError(409, '源版本包含子模块目录，尚不能完整核验');
    if (!stat.isFile()) throw new APIError(409, '源版本包含链接或特殊文件，尚不能完整核验目标内容');
    if (realpathSync(full) !== full) throw new APIError(409, '源文件父目录包含链接，不能核验项目外内容');
    bytes += stat.size;
    if (bytes > maxBytes) throw new APIError(409, '源版本超过 1 GiB，无法完整封存');
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW),
      content = createHash('sha256');
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size)
        throw new APIError(409, '读取期间源文件发生变化，请重新核验');
      let read = 0,
        length;
      while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        read += length;
        if (read > stat.size || performance.now() - started > 5000)
          throw new APIError(409, '源文件变化或读取超时，无法完整核验');
        content.update(buffer.subarray(0, length));
      }
      const after = fstatSync(fd);
      if (
        read !== stat.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new APIError(409, '读取期间源文件发生变化，请重新核验');
      hash.update(JSON.stringify([path, stat.mode & 0o777, content.digest('hex')]));
    } finally {
      closeSync(fd);
    }
  }
  return { digest: hash.digest('hex'), head, files: paths.length, bytes, coverage, scheme: 'source-v2' };
}

/**
 * A key that changes whenever the sealed content can have changed, for far less than reading every
 * file: the commit HEAD points at, the porcelain status naming every staged, modified, deleted and
 * untracked path, and the size and timestamps of exactly those paths. A committed file can only
 * change by appearing in that status or by HEAD moving; an already-dirty one can be edited again
 * without the status line moving at all, which is what the stat covers. Only the dirty paths are
 * stat'd, so the key costs two git reads and a few `lstat` calls.
 *
 * Returns undefined outside a repository — a plain folder has no cheap key, so nothing is cached
 * for it and every reading is taken fresh.
 */
function sourceKey(root: string): string | undefined {
  try {
    const top = realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim());
    if (top !== root) return undefined;
    // `-z` keeps paths unquoted and `--untracked-files=all` names files rather than directories, so
    // every changed path can be stat'd. A rename entry adds its source as a second NUL-terminated
    // token, which needs no prefix stripping; anything unparsed is still part of the key verbatim.
    const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
    const stats = status
      .split('\0')
      .filter(Boolean)
      .map((entry) => (entry.length > 3 && entry[2] === ' ' ? entry.slice(3) : entry))
      .map((path) => {
        try {
          const stat = lstatSync(join(root, path));
          return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        } catch {
          return `${path}:gone`;
        }
      });
    return [git(root, ['rev-parse', '--verify', 'HEAD']).trim(), status, ...stats].join('\0');
  } catch {
    return undefined;
  }
}
type CacheEntry = { key: string; version?: SourceVersion; reason?: string };
const cache = new Map<string, CacheEntry>();
/** A handful of projects are open at a time; the oldest key is dropped rather than grown without end. */
const cacheLimit = 16;
export type SourceVersionReading = {
  version?: SourceVersion;
  /** Why there is no version. Present exactly when `version` is absent. */
  reason?: string;
  /** Whether this reading came from the cache rather than from reading every file again. */
  cached: boolean;
};
/**
 * The same seal as `sourceVersion`, reused while Git reports the identical HEAD and working tree.
 * The 5-second interface poll reads through here so it does not hash up to 5000 files on every
 * request, and gets the reason back instead of an exception when there is no readable version.
 * A failure is cached too, so an unreadable project is not re-read every five seconds.
 *
 * Gates that decide whether work may pass keep calling `sourceVersion` directly: they must compare
 * against a reading taken now, not one a cheap key happened to still match.
 */
export function readSourceVersion(directory: string): SourceVersionReading {
  let root: string;
  try {
    root = realpathSync(directory);
  } catch (error) {
    return { reason: error instanceof Error ? error.message : '项目目录不可读', cached: false };
  }
  const key = sourceKey(root);
  const hit = key ? cache.get(root) : undefined;
  if (hit && hit.key === key)
    return {
      ...(hit.version ? { version: hit.version } : {}),
      ...(hit.reason ? { reason: hit.reason } : {}),
      cached: true,
    };
  const remember = (entry: Omit<CacheEntry, 'key'>) => {
    if (!key) return;
    cache.delete(root);
    if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value!);
    cache.set(root, { key, ...entry });
  };
  try {
    const version = sourceVersion(root);
    remember({ version });
    return { version, cached: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '源版本不可读';
    remember({ reason });
    return { reason, cached: false };
  }
}
/** Tests and any caller that changed a tree behind Git's back start from an empty cache. */
export function clearSourceVersionCache() {
  cache.clear();
}
