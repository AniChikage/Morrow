export const connectionFallback = 'App 连接暂时不可用，请在运行时页重新检测。';

/** Older services may still return transport text. Keep it out of the ordinary connection hint. */
export function connectionDetail(detail?: string) {
  if (!detail || /[/\\]|\bE(?!RROR\b)[A-Z][A-Z0-9_]{2,}\b/.test(detail)) return connectionFallback;
  const firstLine = detail.split(/[\r\n]+/, 1)[0].trim();
  return firstLine === '原生会话连接已建立' ? 'App 任务连接已建立' : firstLine || connectionFallback;
}
