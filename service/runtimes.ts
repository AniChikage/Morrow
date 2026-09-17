import { constants, accessSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { engines, usesApp } from './protocol.ts';
import type { Channel, EventDetail, Runtime, RuntimeID } from './protocol.ts';
import { providerEventDetails } from './event-details.ts';
import { codexAppBinary } from './codex-bridge-setup.ts';
const execute = promisify(execFile);
/** Display names, shared with the engine so a refusal can name the CLI a channel actually needs. */
export const runtimeTitles: Record<RuntimeID, string> = { codex: 'Codex', claude: 'Claude Code', trae: 'Trae CLI' };
const titles = runtimeTitles;
/** Where a person logs each runtime in; quoted back whenever a turn fails on authentication. */
const loginCommands: Record<RuntimeID, string> = {
  codex: 'codex login',
  claude: 'claude auth login',
  trae: 'traex login',
};
/** Executable names to look for, in order. The Trae graphical app's own `trae` is deliberately not one. */
const executables: Record<RuntimeID, string[]> = { codex: ['codex'], claude: ['claude'], trae: ['traex', 'traecli'] };
const codexAppBundle = '/Applications/ChatGPT.app';
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export function runtimePath(id: RuntimeID): string {
  if (process.env.MORROW_TEST_MODE === '1') {
    const p = process.env[`MORROW_TEST_${id.toUpperCase()}_PATH`];
    return p && existsSync(p) ? p : '';
  }
  // The Codex App bundles the exact runtime it launches for its own tasks. Prefer it over an older
  // PATH installation so any terminal fallback matches the native task Morrow shares.
  if (id === 'codex' && executable(codexAppBinary)) return codexAppBinary;
  const directories = [
    ...(process.env.PATH || '').split(delimiter),
    join(homedir(), '.local/bin'),
    // Claude Code's own native installer puts its launcher here, outside a login shell's PATH.
    join(homedir(), '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const name of executables[id])
    for (const d of directories) {
      const p = join(d, name);
      if (executable(p)) return p;
    }
  return '';
}
/**
 * Whether the Codex App bundle is present on this Mac. Test mode never probes the machine; setting
 * MORROW_TEST_CODEX_APP_VERSION fakes an installed App with that version.
 */
export function codexAppInstalled(): boolean {
  if (process.env.MORROW_TEST_MODE === '1') return !!process.env.MORROW_TEST_CODEX_APP_VERSION;
  return existsSync(codexAppBundle);
}
/** Version of the installed Codex App bundle, read from its Info.plist without launching anything. */
export async function codexAppVersion(): Promise<string> {
  if (process.env.MORROW_TEST_MODE === '1') return (process.env.MORROW_TEST_CODEX_APP_VERSION || '').slice(0, 100);
  const plist = join(codexAppBundle, 'Contents/Info.plist');
  if (process.platform !== 'darwin' || !existsSync(plist)) return '';
  try {
    const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const info = JSON.parse(stdout);
    return typeof info.CFBundleShortVersionString === 'string' ? info.CFBundleShortVersionString.slice(0, 100) : '';
  } catch {
    return '';
  }
}
/**
 * Flags a runtime's `--help` must advertise before Morrow will drive it. They are exactly the ones
 * `invocation` passes, so a CLI that renamed or dropped one is reported as too old instead of being
 * spawned with arguments it would reject.
 */
const requiredFlags: Record<RuntimeID, string[]> = {
  codex: ['--json', '--sandbox', '--output-last-message'],
  claude: [
    '--print',
    '--output-format',
    '--verbose',
    '--permission-mode',
    '--tools',
    '--allowedTools',
    '--strict-mcp-config',
    '--mcp-config',
    '--safe-mode',
    '--name',
    '--resume',
    '--model',
  ],
  trae: ['--json', '--sandbox', '--output-last-message'],
};
export async function discoverRuntimes(): Promise<Runtime[]> {
  const appVersion = await codexAppVersion();
  return await Promise.all(
    engines.map(async (id): Promise<Runtime> => {
      const path = runtimePath(id);
      const bundled = id === 'codex' && !!path && path === codexAppBinary;
      const base: Runtime = {
        id,
        name: titles[id],
        path,
        version: '',
        available: false,
        canWrite: false,
        detail:
          id === 'codex'
            ? '未找到 Codex 命令行运行时。安装并登录 Codex App 后重新检测。'
            : `未找到 ${titles[id]} 命令行运行时。安装后在终端运行 ${loginCommands[id]} 登录，再重新检测。`,
        ...(bundled ? { bundled: true } : {}),
        ...(id === 'codex' && appVersion ? { appVersion } : {}),
      };
      if (!path) return base;
      try {
        const [version, help] = await Promise.all([
          execute(path, ['--version'], { timeout: 8000, maxBuffer: 64 * 1024 }),
          // Claude Code advertises its turn flags on the root command; the exec-style CLIs on `exec`.
          execute(path, id === 'claude' ? ['--help'] : ['exec', '--help'], {
            timeout: 8000,
            maxBuffer: 256 * 1024,
          }),
        ]);
        if (!requiredFlags[id].every((flag) => help.stdout.includes(flag)))
          return {
            ...base,
            version: version.stdout.trim().slice(0, 300),
            detail: '当前 CLI 版本缺少必要的安全或结构化输出选项，请升级。',
          };
        return {
          ...base,
          version: version.stdout.trim().slice(0, 300),
          available: true,
          canWrite: true,
          detail: bundled
            ? 'Codex App 自带的命令行运行时；登录、模型与配额由 App 管理。'
            : id === 'codex'
              ? 'CLI 已安装，尚未验证登录和配额；执行时将使用本机登录状态。'
              : `CLI 已安装，尚未验证登录和配额；Morrow 用它执行有界轮次，沿用本机 ${loginCommands[id]} 的登录状态。`,
        };
      } catch {
        return { ...base, detail: 'CLI 探测失败或超时，请在终端检查安装。' };
      }
    })
  );
}
/**
 * How long one bounded CLI turn may run before the engine interrupts it and pauses the channel. The
 * turn prompt states the same number, so a turn can size its own step instead of being cut off with
 * no report: a Claude Code turn that merged a branch and ran a full test suite before starting the
 * real work spent the old 15-minute budget on preparation and left the board untouched.
 */
export const cliTurnMinutes = 45;
/** The built-in tools a Claude Code turn may use, by channel scope. Workspace write includes Bash. */
const claudeTools = {
  'read-only': 'Read,Grep,Glob',
  'workspace-write': 'Read,Grep,Glob,Edit,Write,MultiEdit,NotebookEdit,Bash',
};
/**
 * The command line for one bounded turn. Claude Code and Trae channels run this way, and so does a
 * Codex channel whose transport is `cli`; an `app` Codex channel reaches it only under
 * MORROW_TEST_MODE, because its production work happens inside the shared App task instead.
 */
export function invocation(channel: Channel, runId: string, outputPath: string): string[] {
  if (channel.runtime === 'claude') {
    // No project hooks, plugins or MCP servers are loaded, and the tool list is stated twice: `--tools`
    // bounds what exists, `--allowedTools` what runs without asking. The prompt arrives on stdin.
    const tools = channel.permission === 'read-only' ? claudeTools['read-only'] : claudeTools['workspace-write'];
    const args = [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      tools,
      '--allowedTools',
      tools,
      '--permission-mode',
      channel.permission === 'read-only' ? 'dontAsk' : 'acceptEdits',
      '--name',
      `Morrow:${runId}`,
    ];
    if (channel.model) args.push('--model', channel.model);
    if (channel.sessionId) args.push('--resume', channel.sessionId);
    return args;
  }
  // Codex and Trae share the `exec` shape. A Codex channel that follows the App's own settings maps
  // to full access here; every other scope keeps the sandbox and stays offline. Trae never carries
  // the native scope — the server refuses it — so it always runs sandboxed. No bypass switches are
  // used on fresh or resumed sessions.
  //
  // `native` means "inherit the App task's own sandbox and approvals", so it belongs to the App
  // transport: a CLI-direct Codex channel has no App settings to inherit and the server refuses the
  // scope on it. Asking `usesApp` rather than the runtime keeps that true here too — a row that
  // somehow carried both would fall to the sandboxed `workspace-write` line below, not to full
  // access.
  const native = usesApp(channel) && channel.permission === 'native';
  const sandbox = native
    ? 'danger-full-access'
    : channel.permission === 'native'
      ? 'workspace-write'
      : channel.permission;
  const args = ['exec'];
  if (channel.sessionId) args.push('resume');
  args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"');
  if (!native) args.push('-c', 'sandbox_workspace_write.network_access=false');
  args.push('--output-last-message', outputPath);
  if (!channel.sessionId) args.push('--sandbox', sandbox);
  if (channel.model) args.push('--model', channel.model);
  if (channel.sessionId) args.push(channel.sessionId);
  args.push('-');
  return args;
}
export function decodeLine(line: string): {
  kind: string;
  text: string;
  sessionId?: string;
  final?: unknown;
  finalText?: string;
  error?: boolean;
  terminalOutcome?: 'completed' | 'failed';
  detail?: EventDetail;
  additionalDetails?: EventDetail[];
  /**
   * Progress chatter with nothing a work log can show. The caller drops the line after writing it
   * to the raw log: no event, no failure diagnosis and no session id are taken from it.
   */
  skip?: true;
  /**
   * A background task announcing itself. The wording is the name the model gave the task, which is
   * tool input in all but shape, so the caller keeps the line out of failure diagnosis the way it
   * keeps a tool line out. The event itself is shown like any other.
   */
  backgroundTask?: true;
} {
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return { kind: 'system', text: line };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'system', text: line };
  const details = providerEventDetails(data);
  const detailFields = details.length
    ? { detail: details[0], ...(details.length > 1 ? { additionalDetails: details.slice(1) } : {}) }
    : {};
  const sessionId =
    typeof (data.thread_id || data.session_id) === 'string' ? data.thread_id || data.session_id : undefined;
  // Claude Code reports its own progress on a cadence of its own — a thinking-token tally roughly
  // every second, plus tool-progress notices. None of it is work a person reads, and on a real turn
  // it was the large majority of the log. The raw line still reaches stdout.jsonl.
  if ((data.type === 'system' && data.subtype === 'thinking_tokens') || data.type === 'tool_progress')
    return { kind: 'system', text: line, sessionId, skip: true };
  // A rate-limit notice arrives on every turn, almost always only to say the account is still fine.
  // Those `allowed*` ones are chatter; anything else is a real limit a person has to see, and
  // staying visible is also what keeps it readable by `diagnoseFailure`.
  if (data.type === 'rate_limit_event') {
    const info = data.rate_limit_info;
    const status = typeof info?.status === 'string' ? info.status : '';
    if (status.startsWith('allowed')) return { kind: 'system', text: line, sessionId, skip: true };
    const window = typeof info?.rateLimitType === 'string' ? info.rateLimitType : '';
    return {
      kind: 'system',
      text: status ? `速率限制：${status}${window ? `（${window}）` : ''}` : line,
      sessionId,
    };
  }
  // The session announcement carries the whole CLI startup inventory (commands, skills, plugins,
  // capabilities); the work log needs only what the turn actually runs with, and the session id.
  if (data.type === 'system' && data.subtype === 'init') {
    const tools = (Array.isArray(data.tools) ? data.tools : []).filter((t: unknown) => typeof t === 'string');
    const parts = ['会话已开始'];
    if (typeof data.model === 'string' && data.model) parts.push(`模型 ${data.model}`);
    if (typeof data.permissionMode === 'string' && data.permissionMode) parts.push(`权限 ${data.permissionMode}`);
    if (tools.length) parts.push(`工具 ${tools.join(' / ')}`);
    return { kind: 'system', text: parts.join(' · '), sessionId };
  }
  // A background task (Claude Code's `run_in_background`) reports its own start and finish on these
  // two lines. The Bash call that launched one is already an entry of its own, so the wording names
  // the background task's lifecycle instead of repeating the command. Every field here is provider
  // data: a missing or non-string one drops its own part, and never falls back to the raw line.
  if (data.type === 'system' && (data.subtype === 'task_started' || data.subtype === 'task_notification')) {
    const started = data.subtype === 'task_started';
    const phrase = (value: unknown) =>
      typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const status = phrase(data.status);
    const head = started
      ? '后台任务已开始'
      : status === 'completed'
        ? '后台任务已完成'
        : status === 'failed'
          ? '后台任务失败'
          : status
            ? `后台任务已结束（${status}）`
            : '后台任务已结束';
    const what = phrase(started ? data.description : data.summary);
    return { kind: 'system', text: what ? `${head} · ${what}` : head, sessionId, backgroundTask: true };
  }
  // Claude Code's terminal line for the whole turn: the answer text, and structured output when a
  // schema was in force. `is_error` is the turn's own verdict, not a single failed tool call.
  if (data.type === 'result')
    return {
      kind: data.is_error ? 'error' : 'result',
      text: typeof data.result === 'string' ? data.result : JSON.stringify(data.structured_output || data),
      sessionId,
      final: data.structured_output,
      finalText: typeof data.result === 'string' ? data.result : undefined,
      error: !!data.is_error,
      terminalOutcome: data.is_error ? 'failed' : 'completed',
    };
  if (data.item?.type === 'agent_message')
    return {
      kind: 'assistant',
      text: typeof data.item.text === 'string' ? data.item.text : JSON.stringify(data.item),
      sessionId,
      finalText: typeof data.item.text === 'string' ? data.item.text : undefined,
    };
  // One Claude assistant message can carry several text and tool blocks at once.
  if (data.type === 'assistant') {
    const content = Array.isArray(data.message?.content)
      ? data.message.content.filter((block: any) => block && typeof block === 'object')
      : [];
    const text = content
      .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
    const usesTool = content.some((b: any) => b.type === 'tool_use');
    // Extended thinking arrives as assistant messages of its own. Without an answer or a tool call
    // there is nothing to show, and the fallback below would dump the raw thinking into the log.
    if (!text && !usesTool && content.some((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking'))
      return { kind: 'assistant', text: line, sessionId, skip: true };
    return {
      kind: usesTool ? 'tool' : 'assistant',
      text: text || JSON.stringify(data),
      sessionId,
      ...detailFields,
    };
  }
  if (data.summary && Array.isArray(data.items))
    return {
      kind: 'result',
      text: JSON.stringify(data),
      final: data,
      sessionId,
    };
  return {
    kind:
      data.type === 'error' || data.type === 'turn.failed' ? 'error' : data.item || details.length ? 'tool' : 'system',
    text: JSON.stringify(data),
    sessionId,
    ...detailFields,
    error: data.type === 'error' || data.type === 'turn.failed',
    ...(data.type === 'turn.failed'
      ? { terminalOutcome: 'failed' as const }
      : data.type === 'turn.completed'
        ? { terminalOutcome: 'completed' as const }
        : {}),
  };
}

/**
 * A failure that is about the account's quota or rate limit rather than about the project: the same
 * classification `diagnoseFailure` reports on a turn, reused where a spent account must not be
 * recorded as a result of the work (`service/work-verification.ts`).
 */
export const quotaFailure = /insufficient[_ -]quota|quota exceeded|usage limit|rate[_ -]limit|\b429\b|credit balance/i;

export function diagnoseFailure(runtime: RuntimeID, text: string): { priority: number; summary: string } | undefined {
  const command = loginCommands[runtime];
  if (
    /not logged in|authentication[_ -]failed|unauthenticated|unauthorized|\b401\b|invalid[_ -](?:api[_ -])?(?:key|token)|login required/i.test(
      text
    )
  )
    return {
      priority: 100,
      summary: `${titles[runtime]} 登录无效或已过期。请在执行主机的终端运行 ${command}，完成登录后重试；未产生有效分析结果。`,
    };
  if (quotaFailure.test(text))
    return {
      priority: 90,
      summary: `${titles[runtime]} 配额不足或触发速率限制。请检查该 CLI 账户的用量与重置时间后重试。`,
    };
  if (
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network is unreachable|failed to connect|connection timed out/i.test(
      text
    )
  )
    return {
      priority: 70,
      summary: `${titles[runtime]} 无法连接模型服务。请在执行主机检查网络、代理和 CLI 服务连接后重试。`,
    };
  if (
    /model.*(?:not found|does not exist|unsupported|unavailable)|(?:empty|missing).*model.*(?:metadata|config)|model.*metadata.*(?:empty|missing)/i.test(
      text
    )
  )
    return {
      priority: 50,
      summary: `${titles[runtime]} 无法加载所选模型。请检查模型名称与账户访问权限；可清空模型字段，使用该 CLI 的默认模型后重试。`,
    };
  return undefined;
}
