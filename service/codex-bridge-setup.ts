import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function bridgeLauncher(node: string, script: string, binary: string, directory: string) {
  return `#!/bin/sh\nexport NOHUMAN_CODEX_BINARY=${shellQuote(binary)}\nexport NOHUMAN_CODEX_BRIDGE_HOME=${shellQuote(directory)}\nexec ${shellQuote(node)} ${shellQuote(script)} "$@"\n`;
}
export function bridgeLoginAgent(launcher:string) {
  const escaped=launcher.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>ai.nohuman.codex-bridge</string><key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${escaped}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`;
}
const loginAgentPath=()=>join(homedir(),'Library/LaunchAgents/ai.nohuman.codex-bridge.plist');
export function configureCodexBridge(home: string) {
  if (process.platform !== 'darwin') throw new Error('Codex App 后台连接目前只支持本机 Mac。');
  const binary = '/Applications/ChatGPT.app/Contents/Resources/codex';
  if (!existsSync(binary)) throw new Error('未找到已安装的 Codex App。');
  const directory = join(home, 'codex-bridge'), launcher = join(directory, 'codex');
  let previous: string | null = null;
  try { previous = execFileSync('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* Unset is normal. */ }
  if (previous && previous !== launcher) throw new Error('已有自定义 CODEX_CLI_PATH，已保留原配置；需要先确认该运行时如何与后台桥接兼容。');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const source = bridgeLauncher(process.execPath, fileURLToPath(new URL('./codex-app-host-bridge.ts', import.meta.url)), binary, directory);
  const temporary = `${launcher}.tmp`;
  writeFileSync(temporary, source, { mode: 0o700 }); chmodSync(temporary, 0o700); renameSync(temporary, launcher);
  const receiptPath = join(directory, 'setup.json');
  const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : { previousCliPath: previous, installedAt: new Date().toISOString() };
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, launcher, binary, configuredAt: new Date().toISOString() }), { mode: 0o600 });
  const agentPath=loginAgentPath(),agentSource=bridgeLoginAgent(launcher);
  if(existsSync(agentPath)&&readFileSync(agentPath,'utf8')!==agentSource)throw new Error('后台启动项已有其他配置，已保留；请检查 ai.nohuman.codex-bridge.plist。');
  mkdirSync(join(homedir(),'Library/LaunchAgents'),{recursive:true});writeFileSync(agentPath,agentSource,{mode:0o600});
  execFileSync('/bin/launchctl', ['setenv', 'CODEX_CLI_PATH', launcher], { stdio: 'pipe' });
  return { launcher, restartRequired: true, detail: '后台桥接已配置。请在当前任务结束后重新打开一次 Codex App，之后可直接在 NoHuman 新建和恢复对话。' };
}
export function restoreCodexBridge(home: string) {
  const launcher = join(home, 'codex-bridge', 'codex');
  let current = '';
  try { current = execFileSync('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Already restored. */ }
  if (current === launcher) execFileSync('/bin/launchctl', ['unsetenv', 'CODEX_CLI_PATH'], { stdio: 'pipe' });
  const agentPath=loginAgentPath();
  if(existsSync(agentPath)&&readFileSync(agentPath,'utf8')===bridgeLoginAgent(launcher)){
    try{execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid!()}/ai.nohuman.codex-bridge`],{stdio:'ignore'});}catch{/* It may not have been loaded since login. */}
    unlinkSync(agentPath);
  }
  // Leave the running App's executable and sockets intact until it exits itself.
  return { restartRequired: true, detail: '已撤销后台启动设置，当前会话保持运行，下次打开 Codex App 时恢复原连接方式。' };
}
