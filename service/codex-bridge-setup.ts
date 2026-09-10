import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** The command-line runtime the Codex App launches for its own tasks. */
export const codexAppBinary = '/Applications/ChatGPT.app/Contents/Resources/codex';
const currentAgentLabel = 'ai.morrow.codex-bridge';
const legacyAgentLabel = 'ai.nohuman.codex-bridge';
export function bridgeLauncher(node: string, script: string, binary: string, directory: string) {
  return `#!/bin/sh\nexport MORROW_CODEX_BINARY=${shellQuote(binary)}\nexport MORROW_CODEX_BRIDGE_HOME=${shellQuote(directory)}\nexec ${shellQuote(node)} ${shellQuote(script)} "$@"\n`;
}
export function bridgeLoginAgent(launcher: string, label = currentAgentLabel) {
  const escaped = launcher.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${escaped}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`;
}
const loginAgentPath = (label = currentAgentLabel) => join(homedir(), `Library/LaunchAgents/${label}.plist`);
/** Retired: changing the App CLI path breaks its signed local tool connections. */
export function configureCodexBridge(_home: string): never {
  throw new Error('旧后台转接已退役。请在 Codex App 创建任务并在 Morrow 关联。');
}
export function restoreCodexBridge(home: string) {
  const launcher = join(home, 'codex-bridge', 'codex');
  let current = '';
  let changed = false;
  try {
    current = execFileSync('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* Already restored. */
  }
  if (current === launcher) {
    execFileSync('/bin/launchctl', ['unsetenv', 'CODEX_CLI_PATH'], { stdio: 'pipe' });
    changed = true;
  }
  for (const label of [currentAgentLabel, legacyAgentLabel]) {
    const agentPath = loginAgentPath(label);
    if (existsSync(agentPath) && readFileSync(agentPath, 'utf8') === bridgeLoginAgent(launcher, label)) {
      try {
        execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid!()}/${label}`], { stdio: 'ignore' });
      } catch {
        /* It may not have been loaded since login. */
      }
      unlinkSync(agentPath);
      changed = true;
    }
  }
  // Leave the running App's executable and sockets intact until it exits itself.
  return {
    restartRequired: changed,
    detail: changed
      ? '已撤销旧转接设置。当前会话保持运行；当前任务结束后重开 Codex App。'
      : '未检测到 Morrow 旧转接启动设置，App 使用原连接方式。',
  };
}

/** Read only the receipts belonging to this old installation; never stop the App or its runtime. */
export function legacyBridgeRunning(home: string): boolean {
  const dir = join(home, 'codex-bridge');
  if (process.platform !== 'darwin' || !existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((name) => /^host-[0-9]+\.json$/.test(name))
    .some((name) => {
      try {
        const { bridgePid } = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (!Number.isInteger(bridgePid) || bridgePid < 1) return false;
        return execFileSync('/bin/ps', ['-p', String(bridgePid), '-o', 'command='], {
          encoding: 'utf8',
          timeout: 1000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).includes('codex-app-host-bridge.ts');
      } catch {
        return false;
      }
    });
}
