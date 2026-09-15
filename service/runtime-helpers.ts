import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFingerprint } from './build-identity.ts';
import { logError } from './log.ts';

/**
 * The helper scripts the daemon starts as separate processes, resolved once per boot.
 *
 * `scripts/install-app.sh` puts the new bundle at the same path the running daemon was started
 * from, so a daemon that is still working after an install would spawn the *new* helper out of its
 * own old installation directory. That window lasts until the automatic switch finishes (up to the
 * 60-second detection plus the drain), and a native turn calls the work-interface helper several
 * times a turn, so it is long enough to matter: a helper whose argument or context-file contract
 * moved on would fail, or worse, half-succeed, against the daemon that is still running.
 *
 * Each helper is therefore copied once at boot into `$MORROW_HOME/runtime/<fingerprint>/`, which no
 * installer touches, and the daemon spawns its own copy for as long as it runs. A copy that is
 * already there is kept rather than refreshed, so an install cannot change it under an in-flight
 * run. The copies of other builds are removed once this boot has come up.
 *
 * A development checkout has no bundle and an `unknown` fingerprint; it keeps spawning from the
 * source tree, so an edit takes effect on the next turn exactly as it does today.
 *
 * `service/codex-cli-worker.ts` is spawned by `service/codex-cli-review.ts` from its own module
 * path and is not pinned here — see `docs/UPGRADING.md`.
 */
export const helperNames = ['agent-cli.ts'] as const;
export type HelperName = (typeof helperNames)[number];
export type Helpers = Record<HelperName, string>;

const sourcePath = (name: HelperName) => fileURLToPath(new URL(`./${name}`, import.meta.url));
/** One build's copies. Named by fingerprint, so two builds never share a directory. */
export const helperDirectory = (home: string, fingerprint: string) => join(home, 'runtime', fingerprint);
/** The source tree's own helpers: what a dev run spawns, and the fallback when a copy cannot be made. */
export const helperSources = (): Helpers =>
  Object.fromEntries(helperNames.map((name) => [name, sourcePath(name)])) as Helpers;

/** Copies this build's helpers if they are not there yet, and says where to spawn each of them from. */
export function pinHelpers(home: string, fingerprint: string): Helpers {
  const resolved = helperSources();
  if (!isFingerprint(fingerprint)) return resolved;
  const directory = helperDirectory(home, fingerprint);
  for (const name of helperNames) {
    const target = join(directory, name);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!existsSync(target)) copyFileSync(sourcePath(name), target);
      chmodSync(target, 0o600);
      resolved[name] = target;
    } catch (error) {
      // A copy that cannot be made leaves the source path in place: the mixed-version window stays
      // open, which is the behaviour without this at all, rather than a boot that fails over a
      // helper it has not spawned yet.
      logError('runtime.helper.failed', error, { helper: name, fingerprint });
    }
  }
  return resolved;
}

/**
 * Removes every other build's copies, called once this boot is up. A run that ended keeps a
 * `tool.sh` pointing into a pruned directory, which is harmless: its grant is already over.
 */
export function pruneHelpers(home: string, fingerprint: string) {
  if (!isFingerprint(fingerprint)) return;
  try {
    for (const entry of readdirSync(join(home, 'runtime')))
      if (entry !== fingerprint) rmSync(join(home, 'runtime', entry), { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError('runtime.prune.failed', error, { fingerprint });
  }
}
