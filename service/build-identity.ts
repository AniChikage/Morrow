import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The read-only build identity `scripts/build-info.ts` writes into a packaged bundle. `fingerprint`
 * covers the whole build (service sources, compiled main/renderer, package metadata) so a pure UI
 * change is a new version too; `build-info.json` itself and every signature are outside it.
 */
export type BuildInfo = {
  scheme: string;
  commit: string;
  version: string;
  dirty: boolean;
  fingerprint: string;
  files: number;
  bytes: number;
  builtAt: string;
};
/** What one running process knows about itself: a fresh boot id plus the build it was started from. */
export type BuildIdentity = {
  /** Random per process. It identifies this boot of the daemon, never the build. */
  bootId: string;
  commit: string;
  version: string;
  /** Whole-bundle fingerprint, or `unknown` without a readable build-info (a dev run). */
  fingerprint: string;
  /** Absolute path of the `.app` this process runs from; empty in a dev checkout. */
  bundlePath: string;
};
export const unknownFingerprint = 'unknown';
export const buildInfoName = 'build-info.json';
/** A build-info file a human can read; anything larger is treated as absent. */
const buildInfoLimit = 8 * 1024;
export const isFingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{16,128}$/.test(value);
export const isCommit = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{7,40}$/.test(value);

/** `<bundle>.app` for a `<bundle>.app/Contents/Resources` path, or '' when the path is not one. */
export function bundlePathFromResources(resources: string): string {
  const parts = resources.split(sep);
  if (parts.length < 3 || parts.at(-1) !== 'Resources' || parts.at(-2) !== 'Contents') return '';
  const bundle = parts.slice(0, -2).join(sep);
  return bundle.endsWith('.app') ? bundle : '';
}
/** The `.app` a module of this service lives in. A dev checkout has no such ancestor and returns ''. */
export function bundlePathFromModule(moduleURL: string): string {
  let directory: string;
  try {
    directory = dirname(fileURLToPath(moduleURL));
  } catch {
    return '';
  }
  for (let depth = 0; depth < 16; depth += 1) {
    const bundle = bundlePathFromResources(directory);
    if (bundle) return bundle;
    const parent = dirname(directory);
    if (parent === directory) return '';
    directory = parent;
  }
  return '';
}
/** The fingerprint decides; a missing or malformed commit/version only makes the labels weaker. */
export function validBuildInfo(value: unknown): BuildInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!isFingerprint(row.fingerprint)) return undefined;
  return {
    scheme: typeof row.scheme === 'string' ? row.scheme.slice(0, 60) : '',
    commit: isCommit(row.commit) ? row.commit : unknownFingerprint,
    version: typeof row.version === 'string' ? row.version.slice(0, 60) : '',
    dirty: row.dirty === true,
    fingerprint: row.fingerprint,
    files: Number.isInteger(row.files) ? (row.files as number) : 0,
    bytes: Number.isInteger(row.bytes) ? (row.bytes as number) : 0,
    builtAt: typeof row.builtAt === 'string' ? row.builtAt.slice(0, 40) : '',
  };
}
/** Reads `<bundle>/Contents/Resources/build-info.json`; any problem reads as absent, never as a version. */
export function readBuildInfo(bundlePath: string): BuildInfo | undefined {
  if (!bundlePath) return undefined;
  const path = join(bundlePath, 'Contents', 'Resources', buildInfoName);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > buildInfoLimit) return undefined;
    return validBuildInfo(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}
/**
 * Read once per process and kept in memory: the installed build this daemon or Electron main is
 * actually running, not whatever is on disk later. `MORROW_BUILD_IDENTITY` is honoured only in test
 * mode, so an isolated daemon can stand in for an installed bundle without one being built.
 */
export function buildIdentity(moduleURL: string = import.meta.url): BuildIdentity {
  const bootId = randomUUID();
  if (process.env.MORROW_TEST_MODE === '1' && process.env.MORROW_BUILD_IDENTITY) {
    try {
      const override = JSON.parse(process.env.MORROW_BUILD_IDENTITY) as Record<string, unknown>;
      return {
        bootId,
        commit: isCommit(override.commit) ? override.commit : unknownFingerprint,
        version: typeof override.version === 'string' ? override.version.slice(0, 60) : '',
        fingerprint: isFingerprint(override.fingerprint) ? override.fingerprint : unknownFingerprint,
        bundlePath: typeof override.bundlePath === 'string' ? override.bundlePath : '',
      };
    } catch {
      /* A malformed override leaves the real derivation below in place. */
    }
  }
  const bundlePath = bundlePathFromModule(moduleURL);
  const info = readBuildInfo(bundlePath);
  return {
    bootId,
    commit: info?.commit || unknownFingerprint,
    version: info?.version || '',
    fingerprint: info?.fingerprint || unknownFingerprint,
    bundlePath,
  };
}
