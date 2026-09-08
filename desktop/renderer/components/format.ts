export const statuses: Record<string, string> = { open: '待处理', investigating: '调查中', blocked: '需要关注', verified: '已验证', resolved: '已解决', paused: '已暂停', idle: '等待复查', running: '运行中', waiting: '等待执行', completed: '已完成', failed: '运行失败', interrupted: '已中断' };
export const kinds: Record<string, string> = { feature: '功能', issue: '问题', opportunity: '机会', hypothesis: '假设' };
export const engines: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', trae: 'Trae CLI' };
export const statusLabel = (value: string) => statuses[value] || value;
export const kindLabel = (value: string) => kinds[value] || value;
export const runtimeLabel = (value: string) => engines[value] || value;
const timeFormatter = new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
export function formatDate(value: string) { const date = new Date(value); return !value || Number.isNaN(date.getTime()) ? '尚未运行' : timeFormatter.format(date); }
export function shortId(value: string) { return (value.startsWith('demo-') ? value.slice(-3) : value.slice(0, 6)).toUpperCase(); }
