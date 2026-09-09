import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchNativeSession, prepareScript, type NativeSessionTarget } from './native-session';

const mocked = vi.hoisted(() => ({ userData: '', openPath: vi.fn(async (_path: string) => '') }));
vi.mock('electron', () => ({ app: { getPath: (name: string) => { if (name !== 'userData') throw new Error('Unexpected app path'); return mocked.userData; } }, shell: { openPath: mocked.openPath } }));
const execute = promisify(execFile);
let temporary = '';
let target: NativeSessionTarget;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'morrow-native-session-'));
  mocked.userData = join(temporary, 'user data');
  mocked.openPath.mockReset().mockResolvedValue('');
  const projectPath = join(temporary, "project 'quoted' $(touch UNSAFE_PROJECT) `touch UNSAFE_BACKTICK`");
  const executable = join(temporary, "fake 'cli' $(touch UNSAFE_EXEC).sh");
  await mkdir(projectPath);
  await writeFile(executable, '#!/bin/bash\nprintf "cwd=%s\\n" "$PWD"\nfor argument in "$@"; do printf "arg=%s\\n" "$argument"; done\n', { mode: 0o700 });
  target = { projectPath, executable, runtime: 'codex', sessionId: '019a1267-87af-70d7-85cc-884dd88ccb14' };
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

test.each([['codex', 'resume'], ['claude', '--resume'], ['trae', 'resume']] as const)('%s resumes the exact native session with safely quoted paths and no extra flags', async (runtime, resume) => {
  const scriptPath = join(temporary, 'prepared.command');
  await writeFile(scriptPath, prepareScript({ ...target, runtime }));
  const result = await execute('/bin/bash', [scriptPath], { cwd: temporary });
  expect(result.stdout.trim().split('\n')).toEqual([`cwd=${target.projectPath}`, `arg=${resume}`, `arg=${target.sessionId}`]);
  expect((await readdir(temporary)).filter(name => name.startsWith('UNSAFE_'))).toEqual([]);
  expect(await readdir(target.projectPath)).toEqual([]);
});

test.each(['codex', 'claude', 'trae'] as const)('%s without a session starts the native interactive CLI without prompt or config overrides', async runtime => {
  const scriptPath = join(temporary, 'fresh.command');
  await writeFile(scriptPath, prepareScript({ ...target, runtime, sessionId: '' }));
  const result = await execute('/bin/bash', [scriptPath]);
  expect(result.stdout.trim()).toBe(`cwd=${target.projectPath}`);
});

test('invalid destinations, runtimes and session options cannot become shell commands', () => {
  for (const patch of [
    { projectPath: 'relative/path' }, { executable: 'codex' }, { projectPath: '/tmp/one\ntwo' },
    { runtime: 'shell' }, { sessionId: '--last' }, { sessionId: 'id; touch unsafe' }, { sessionId: 'id$(touch unsafe)' },
    { sessionId: 'x'.repeat(129) }, { prompt: 'must not run automatically' },
  ]) expect(() => prepareScript({ ...target, ...patch } as NativeSessionTarget)).toThrow();
});

test('native launch creates a private script then hands only its path to the shell', async () => {
  await launchNativeSession(target);
  expect(mocked.openPath).toHaveBeenCalledTimes(1);
  const scriptPath = mocked.openPath.mock.calls[0][0];
  expect(scriptPath.startsWith(join(mocked.userData, 'native-launches') + '/')).toBe(true);
  expect(scriptPath.endsWith('.command')).toBe(true);
  expect((await stat(scriptPath)).mode & 0o777).toBe(0o700);
  expect((await stat(join(mocked.userData, 'native-launches'))).mode & 0o777).toBe(0o700);
  expect(await readFile(scriptPath, 'utf8')).toBe(prepareScript(target));
});

test('missing executable fails before native shell handoff', async () => {
  await expect(launchNativeSession({ ...target, executable: join(temporary, 'missing-cli') })).rejects.toThrow('运行时命令不存在或不可执行');
  expect(mocked.openPath).not.toHaveBeenCalled();
});

test('shell launch errors surface and the prepared script is retained for review', async () => {
  mocked.openPath.mockResolvedValue('No application is associated with this file');
  await expect(launchNativeSession(target)).rejects.toThrow('无法打开终端原生会话');
  const files = await readdir(join(mocked.userData, 'native-launches'));
  expect(files).toHaveLength(1);
  expect((await readdir(target.projectPath))).toEqual([]);
});

test('an existing launch-directory symlink is rejected without touching its target', async () => {
  await mkdir(mocked.userData);
  await symlink(target.projectPath, join(mocked.userData, 'native-launches'));
  await expect(launchNativeSession(target)).rejects.toThrow('无法创建私有原生会话启动目录');
  expect(mocked.openPath).not.toHaveBeenCalled();
  expect(await readdir(target.projectPath)).toEqual([]);
});
