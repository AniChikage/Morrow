import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logError } from './log.ts';
import { projectTreeState, readSourceVersion } from './source-version.ts';
import type { SourceVersion } from './verification-types.ts';

/** The same bounded, lock-free `git` the source seal uses; stderr is dropped, failures throw. */
function git(root: string, args: string[], timeout = 20_000) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}
/** Where every disposable review checkout lives, inside the data directory and nowhere else. */
export const reviewCheckoutRoot = (home: string) => join(home, 'reviews');
/** One live checkout: where the reviewer runs, and the commit it holds. */
export type ReviewCheckout = { path: string; commit: string; projectPath: string };
/** Linked to the project's own installed dependencies, which are outside the source seal. */
const modulesLink = (path: string) => join(path, 'node_modules');

/**
 * A throwaway Git worktree holding exactly the source version under review, so the reviewer reads
 * and runs that version instead of whatever the shared project directory contains right now, and
 * can rerun the project's own checks rather than take 「测试通过」 on the implementer's word.
 *
 * It is created only when the checkout provably reproduces the reviewed version: the project is a
 * Git repository whose whole tree is sealed by Git, its working tree is clean (no uncommitted or
 * untracked file could differ from the commit), and the seal read now still matches the digest this
 * review is bound to. Anything else — a plain folder, an unborn repository, a dirty tree, a commit
 * that is gone, a failing `git` — returns `undefined`, and the review runs in the project directory
 * exactly as it did before. The version-currency rules (`WorkVerification.current`) are untouched:
 * this only decides where the reviewer looks and what it may run.
 */
export function createReviewCheckout(options: {
  home: string;
  projectPath: string;
  verificationId: string;
  /** The version the review is bound to; a checkout is made only for this exact digest. */
  version: SourceVersion;
}): ReviewCheckout | undefined {
  const { home, projectPath, verificationId } = options;
  const current = readSourceVersion(projectPath).version;
  if (
    !current ||
    current.digest !== options.version.digest ||
    current.coverage !== 'git-tracked-and-unignored' ||
    !current.head
  )
    return undefined;
  const tree = projectTreeState(projectPath);
  if (tree.unknown || tree.dirty) return undefined;
  const path = join(reviewCheckoutRoot(home), verificationId);
  try {
    mkdirSync(reviewCheckoutRoot(home), { recursive: true, mode: 0o700 });
    rmSync(path, { recursive: true, force: true });
    git(projectPath, ['rev-parse', '--verify', `${current.head}^{commit}`]);
    git(projectPath, ['worktree', 'add', '--detach', path, current.head]);
  } catch (error) {
    logError('review.checkout.failed', error, { verificationId });
    removeReviewCheckout(projectPath, path);
    return undefined;
  }
  // Installed dependencies are ignored by Git and outside the source seal, so the checkout has
  // none: link the project's own instead of leaving the reviewer unable to run `npm test`.
  try {
    if (existsSync(join(projectPath, 'node_modules')) && !existsSync(modulesLink(path)))
      symlinkSync(join(projectPath, 'node_modules'), modulesLink(path), 'dir');
  } catch (error) {
    logError('review.checkout.modules', error, { verificationId });
  }
  return { path, commit: current.head, projectPath };
}

/** Removes one checkout and its registration. Safe to call twice, and on a path that never existed. */
export function removeReviewCheckout(projectPath: string, path: string) {
  // The link is unlinked first so no removal can ever walk into the project's real dependencies.
  try {
    unlinkSync(modulesLink(path));
  } catch {
    /* Absent, or never created. */
  }
  try {
    git(projectPath, ['worktree', 'remove', '--force', path]);
  } catch {
    /* Not a registered worktree, or already gone; the directory is removed either way. */
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    logError('review.checkout.remove.failed', error, { path });
  }
  try {
    git(projectPath, ['worktree', 'prune']);
  } catch {
    /* Pruning is bookkeeping; a project that cannot be read keeps its stale registration. */
  }
}

/**
 * Boot-time cleanup: a service that was killed mid-review leaves its checkout and the registration
 * behind. Every directory without a review still running is removed, and each project's worktree
 * list is pruned. Nothing runs when no checkout was ever made.
 */
export function pruneReviewCheckouts(home: string, projectPaths: string[], running: Set<string>) {
  const root = reviewCheckoutRoot(home);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (running.has(entry)) continue;
    try {
      unlinkSync(modulesLink(join(root, entry)));
    } catch {
      /* Absent, or never created. */
    }
    try {
      rmSync(join(root, entry), { recursive: true, force: true });
    } catch (error) {
      logError('review.checkout.prune.failed', error, { entry });
    }
  }
  for (const projectPath of projectPaths)
    try {
      git(projectPath, ['worktree', 'prune']);
    } catch {
      /* A project that is not a repository, or has moved, has nothing to prune. */
    }
}
