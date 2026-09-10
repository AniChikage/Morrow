/**
 * What the native Codex App actually offered a Morrow-scheduled turn, as measured on 2026-09-09 by
 * one real turn against the shared App backend (isolated data directory, channel permission
 * `native`, model gpt-6-astra). This is a dated record of that probe, not a live capability query:
 * nothing here is re-checked at runtime, and `untested` means exactly that — no measurement exists.
 * Re-run the probe and edit this file rather than inferring a status from a later failure.
 */
export type NativeCapabilityStatus = 'available' | 'unavailable' | 'partial' | 'untested';
export type NativeCapability = {
  id: string;
  name: string;
  status: NativeCapabilityStatus;
  /** The date the status was measured, so a stale entry is visible as stale. */
  measuredAt: string;
  /** What was observed, including the part that was not observed. */
  note: string;
  /** How a turn reaches the capability, or what to do instead when it is unavailable. */
  howTo: string;
};
export const nativeCapabilitiesMeasuredAt = '2026-09-09';
const statusLabels: Record<NativeCapabilityStatus, string> = {
  available: '可用',
  partial: '部分可用',
  unavailable: '不可用',
  untested: '未实测',
};
export const nativeCapabilities: NativeCapability[] = [
  {
    id: 'in-app-browser',
    name: '应用内浏览器插件',
    status: 'unavailable',
    measuredAt: nativeCapabilitiesMeasuredAt,
    note: 'Morrow 创建的任务里 setupBrowserRuntime() 能加载，但 agent.browsers.getForUrl(url) 返回「No browser is available」，agent.browsers.list() 为空。显式 agent.browsers.get("iab") 在 Morrow 任务中尚未实测。',
    howTo:
      '插件技能文档给出的入口是 agent.browsers.get("iab")；取不到浏览器时不要把网页截图或页面状态当作可获得的证据，改用可回看的文件或 HTTP 观测。',
  },
  {
    id: 'chrome-browser',
    name: 'Chrome / Edge 浏览器',
    status: 'untested',
    measuredAt: nativeCapabilitiesMeasuredAt,
    note: '需要 ChatGPT 浏览器扩展；这次实测没有覆盖，能否在 Morrow 创建的任务里选中未知。',
    howTo: 'agent.browsers.get("chrome") 或 agent.browsers.get("edge")，前提是已安装并连接 ChatGPT 浏览器扩展。',
  },
  {
    id: 'computer-use',
    name: 'Computer Use（@oai/sky）',
    status: 'available',
    measuredAt: nativeCapabilitiesMeasuredAt,
    note: 'sky.list_apps() 与 sky.get_app_state({ app: "Morrow" }) 返回了无障碍树和截图。ChatGPT 应用本身以安全理由被拒绝；同一 bundle id 有两份安装副本时定位有歧义。',
    howTo: '在 node_repl 里使用 @oai/sky，用应用名而不是 bundle id 定位窗口。',
  },
  {
    id: 'native-memory',
    name: '原生记忆',
    status: 'partial',
    measuredAt: nativeCapabilitiesMeasuredAt,
    note: '读取 ~/.codex/memories/MEMORY.md 可用，当时没有 Morrow 相关条目。没有显式的写入工具：记忆由 App 在会话结束后自行抽取，Morrow 创建的任务是否会被总结未实测。',
    howTo: '直接读取记忆文件；跨轮次的个人经验优先交给原生记忆，不要假设本轮写入会立即出现。',
  },
  {
    id: 'web-search',
    name: 'Web 搜索',
    status: 'available',
    measuredAt: nativeCapabilitiesMeasuredAt,
    note: '实测可用；官方 app-server 文档确实存在（https://learn.chatgpt.com/zh-Hans/docs/app-server）。',
    howTo: '直接使用原生 web 搜索工具；引用时保留可回看的链接。',
  },
  {
    id: 'morrow-work-interface',
    name: 'Morrow 工作接口（agent-cli.ts）',
    status: 'available',
    measuredAt: nativeCapabilitiesMeasuredAt,
    note: '需要完整访问沙箱。App 默认沙箱（workspace-write、断网）下回环网络被挡，第一次 --context 调用报 fetch failed，之后每次调用都要走一次 requestApproval，auto_review 每次约一分钟。native 频道现在由 Morrow 显式请求完整访问。',
    howTo: '按本轮提示里的 agent-cli.ts --context <文件> --operation <操作> 调用；写操作带稳定的 --request-id。',
  },
];
/** One prompt line: what this probe found available, and what it found missing or never tried. */
export function nativeCapabilityLine(capabilities: NativeCapability[] = nativeCapabilities): string {
  const groups = (['available', 'partial', 'unavailable', 'untested'] as const)
    .map((status) => ({
      status,
      names: capabilities.filter((entry) => entry.status === status).map((entry) => entry.name),
    }))
    .filter((group) => group.names.length)
    .map((group) => `${statusLabels[group.status]} ${group.names.join('、')}`);
  return `原生能力（${nativeCapabilitiesMeasuredAt} 实测）：${groups.join('；')}。以 context.nativeCapabilities 的说明为准，不要假设未实测的能力可用，也不要凭它汇报没做过的观察。`;
}
