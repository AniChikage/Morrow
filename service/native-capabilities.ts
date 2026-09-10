/** Dated evidence, not a live capability probe. Browser/App tools were re-tested on the
 * official App follower path on 2026-09-09; historical observations remain explicitly scoped.
 * See docs/CODEX-CONNECTION-VALIDATION-2026-09-09.md. */
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
    status: 'available',
    measuredAt: nativeCapabilitiesMeasuredAt,
    note: 'App 创建并加载的任务，经 follower 发起完整访问轮次后，真实读取本机页面的随机标记、点击按钮并读到对应结果。旧转接方案下的不可用记录已被此路径实测更新；仍取决于 App 权限和插件状态。',
    howTo:
      '按 Browser skill 使用 agent.browsers.get("iab")。只有实际取得页面与操作结果后才能作为证据；连接不可用时如实记录。',
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
    note: '此前在完整访问轮次验证可用；工作区断网会阻止本机 HTTP 接口并可能触发原生审批。现在 native 频道沿用 App 权限，Morrow 不自动提升为完整访问；需要由用户在 App 设置适当权限。',
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
