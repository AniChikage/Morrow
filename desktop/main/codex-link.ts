import { isAbsolute } from 'node:path';

/** The installed Codex App parser supports these two local conversation routes. */
export function codexAppLink(target: { threadId?: string; projectPath: string }): string {
  if (target.threadId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.threadId)) throw new Error('Codex 原生会话标识无效。');
    return `codex://threads/${target.threadId}`;
  }
  if (typeof target.projectPath !== 'string' || !isAbsolute(target.projectPath) || /[\0\r\n]/.test(target.projectPath)) throw new Error('项目目录无效。');
  const params = new URLSearchParams({ path: target.projectPath, mode: 'codex' });
  return `codex://threads/new?${params}`;
}
