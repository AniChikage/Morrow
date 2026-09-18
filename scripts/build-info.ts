/**
 * Writes the read-only build identity of one Morrow build: `build-info.json`, carrying the commit and
 * a stable whole-bundle fingerprint. `scripts/build-electron.sh` runs it after `npm run build` and
 * before signing, so the signature covers the file and the running daemon can read it from its own
 * bundle.
 *
 * The fingerprint covers everything that makes one Morrow build behave differently from another: the
 * service TypeScript shipped as bundle resources, the compiled Electron main/preload/renderer output,
 * and the package metadata. A pure interface change therefore is a new version too. It deliberately
 * excludes this file, the packaged Node/Electron runtimes and every signature, so signing a bundle
 * twice does not invent a new version. Nothing here reads the installed app or the data directory.
 *
 *   node scripts/build-info.ts --root <checkout> --out <bundle>/Contents/Resources/build-info.json
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const scheme = 'morrow-bundle-v1';
/** Build inputs and outputs, in a fixed order. Directories are walked; missing ones are an error. */
const contents = [
  { path: 'service', extension: '.ts' },
  { path: 'out/main' },
  { path: 'out/preload' },
  { path: 'out/renderer' },
  { path: 'package.json' },
  { path: 'electron-builder.yml' },
];
/** Never part of a build's identity: dependencies, source maps, editor and Finder leftovers. */
const skipped = new Set(['node_modules', '.DS_Store', 'build-info.json']);

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : '';
};
const root = resolve(option('--root') || process.cwd());
const out = option('--out');
if (!out) {
  console.error('usage: build-info.ts --root <checkout> --out <path>');
  process.exit(2);
}

function collect(entry: { path: string; extension?: string }): string[] {
  const full = join(root, entry.path);
  const stat = statSync(full);
  if (stat.isFile()) return [entry.path];
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const row of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (skipped.has(row.name)) continue;
      const path = join(directory, row.name);
      if (row.isDirectory()) visit(path);
      else if (row.isFile() && !row.name.endsWith('.map') && (!entry.extension || row.name.endsWith(entry.extension)))
        found.push(relative(root, path));
    }
  };
  visit(full);
  return found;
}

const paths: string[] = [];
for (const entry of contents) {
  try {
    paths.push(...collect(entry));
  } catch {
    console.error(`build-info: ${entry.path} is missing; run npm run build first.`);
    process.exit(1);
  }
}
const ordered = [...new Set(paths)].sort();
const hash = createHash('sha256').update(`${scheme}\0`);
let bytes = 0;
for (const path of ordered) {
  const full = join(root, path);
  const stat = statSync(full);
  bytes += stat.size;
  hash.update(JSON.stringify([path, stat.mode & 0o777, createHash('sha256').update(readFileSync(full)).digest('hex')]));
}
const git = (parameters: string[]) => {
  try {
    return execFileSync('git', ['-C', root, ...parameters], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};
const info = {
  scheme,
  commit: git(['rev-parse', '--verify', 'HEAD']),
  version: String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || ''),
  dirty: git(['status', '--porcelain', '--untracked-files=normal']).length > 0,
  fingerprint: hash.digest('hex'),
  files: ordered.length,
  bytes,
  builtAt: new Date().toISOString(),
};
mkdirSync(dirname(out), { recursive: true });
// The written file is read-only, so a rerun replaces it instead of failing to open it.
rmSync(out, { force: true });
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o444 });
chmodSync(out, 0o444);
console.log(
  `build-info ${info.fingerprint.slice(0, 12)} · ${info.files} files · ${info.commit.slice(0, 12) || 'no git'}`
);
