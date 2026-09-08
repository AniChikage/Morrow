import { app, shell } from 'electron';
import { access, lstat, mkdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export interface NativeSessionTarget {
  projectPath: string;
  runtime: 'codex' | 'claude' | 'trae';
  executable: string;
  sessionId: string;
}

function absolutePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${label}必须是有效的本机绝对路径。`);
}
function validate(target: NativeSessionTarget): void {
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['projectPath', 'runtime', 'executable', 'sessionId'].includes(key))) throw new Error('原生会话参数无效。');
  absolutePath(target.projectPath, '项目目录');
  absolutePath(target.executable, '运行时命令');
  if (!['codex', 'claude', 'trae'].includes(target.runtime)) throw new Error('不支持此运行时的原生会话。');
  if (typeof target.sessionId !== 'string' || (target.sessionId !== '' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(target.sessionId))) throw new Error('原生会话标识无效。');
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Generate only a native interactive invocation, never a prompt, headless run or permission override. */
export function prepareScript(target: NativeSessionTarget): string {
  validate(target);
  const args = target.sessionId ? [target.runtime === 'claude' ? '--resume' : 'resume', target.sessionId] : [];
  return [
    '#!/bin/bash',
    '# NoHuman opens the CLI native session. Authentication and settings remain with the CLI.',
    'set -e',
    `cd -- ${quote(target.projectPath)}`,
    `exec -- ${[target.executable, ...args].map(quote).join(' ')}`,
    '',
  ].join('\n');
}

/** Caller resolves persisted project/runtime IDs and checks project execution is paused before handoff. */
export async function launchNativeSession(target: NativeSessionTarget): Promise<void> {
  const script = prepareScript(target);
  try {
    if (!(await stat(target.projectPath)).isDirectory()) throw new Error('not a directory');
  } catch { throw new Error('项目目录不存在或无法访问，无法打开原生会话。'); }
  try {
    if (!(await stat(target.executable)).isFile()) throw new Error('not a file');
    await access(target.executable, constants.X_OK);
  } catch { throw new Error('运行时命令不存在或不可执行，请重新检测运行时。'); }

  const directory = join(app.getPath('userData'), 'native-launches');
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Do not follow an existing symlink or loosen permissions on unrelated user files.
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('unsafe launch directory');
  } catch { throw new Error('无法创建私有原生会话启动目录。'); }
  const file = join(directory, `${target.runtime}-${randomUUID()}.command`);
  try { await writeFile(file, script, { mode: 0o700, flag: 'wx' }); }
  catch { throw new Error('无法保存原生会话启动文件。'); }
  let error: string;
  try { error = await shell.openPath(file); }
  catch { throw new Error('无法打开终端原生会话，请检查 .command 文件的默认打开方式。'); }
  if (error) throw new Error(`无法打开终端原生会话：${error}`);
}
