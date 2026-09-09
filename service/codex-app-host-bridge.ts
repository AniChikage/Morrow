import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

/** Installed as CODEX_CLI_PATH. The App still supplies every runtime option. */
export function sharedRuntimeArgs(args: string[], socket: string): string[] | null {
  // The App may place global configuration before its subcommand. Preserve it
  // verbatim; a config value containing "app-server" is not the subcommand.
  let commandIndex=0;
  while(commandIndex<args.length&&args[commandIndex]!=='app-server'){
    const arg=args[commandIndex];
    if(['-c','--config','--enable','--disable'].includes(arg)){
      if(!args[commandIndex+1])return null;
      commandIndex+=2;
    }else if(/^(?:--config|--enable|--disable)=.+/.test(arg)||/^-c.+?=.+/.test(arg)||arg==='--strict-config')commandIndex++;
    else return null;
  }
  if (args[commandIndex] !== 'app-server' || args.slice(commandIndex+1).some(arg => ['daemon', 'proxy', 'generate-ts', 'generate-json-schema', '--help', '-h'].includes(arg))) return null;
  const result = args.slice(0,commandIndex+1);
  for (let index = commandIndex+1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--stdio') continue;
    if (arg === '--listen') { if (args[++index] !== 'stdio://') return null; continue; }
    if (arg.startsWith('--listen=')) { if (arg !== '--listen=stdio://') return null; continue; }
    result.push(arg);
  }
  return [...result, '--listen', `unix://${socket}`];
}

export async function runAppHostBridge(args = process.argv.slice(2)): Promise<void> {
  const executable = process.env.MORROW_CODEX_BINARY || process.env.NOHUMAN_CODEX_BINARY;
  if (!executable || resolve(executable) === resolve(process.argv[1])) throw new Error('Morrow Codex bridge has no native executable.');
  const directory = process.env.MORROW_CODEX_BRIDGE_HOME || process.env.NOHUMAN_CODEX_BRIDGE_HOME || join(homedir(), 'Library/Application Support/Morrow/codex-bridge');
  const launchId = randomUUID();
  // Unix socket paths have a small OS limit. The private directory is kept short.
  const socketDirectory = process.env.MORROW_CODEX_SOCKET_DIRECTORY || process.env.NOHUMAN_CODEX_SOCKET_DIRECTORY || join(homedir(), '.morrow-codex');
  const socketPath = join(socketDirectory, `${process.pid}.sock`);
  const runtimeArgs = sharedRuntimeArgs(args, socketPath);
  if (!runtimeArgs) {
    const child = spawn(executable, args, { stdio: 'inherit', env: process.env });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => child.kill(signal));
    await new Promise<void>((done, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; done(); }); });
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 }); chmodSync(socketDirectory, 0o700);
  const manifestPath = join(directory, `host-${process.pid}.json`);
  const child = spawn(executable, runtimeArgs, { stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
  let socket: WebSocket | undefined;
  let stopped = false;
  let initialized = false;
  const queued: string[] = [];
  let queuedBytes = 0;
  const cleanup = () => {
    if (stopped) return;
    stopped = true; socket?.terminate(); input.close(); child.kill('SIGTERM');
    try { unlinkSync(manifestPath); } catch { /* This process only removes its own receipt. */ }
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (stopped) return;
    if (socket?.readyState === WebSocket.OPEN) socket.send(line);
    else { queuedBytes += Buffer.byteLength(line); if (queuedBytes > 64 * 1024 * 1024) { cleanup(); return; } queued.push(line); }
  });
  input.on('close', cleanup);
  process.once('SIGTERM', cleanup); process.once('SIGINT', cleanup);
  child.once('error', error => { process.stderr.write(`Morrow native host failed: ${error.message}\n`); process.exitCode = 1; cleanup(); });
  child.once('exit', code => { process.exitCode = code ?? (stopped ? 0 : 1); cleanup(); });
  try {
    for (let count = 0; count < 300 && !stopped && !existsSync(socketPath); count++) await new Promise(done => setTimeout(done, 50));
    if (stopped) return;
    if (!existsSync(socketPath)) throw new Error('The App native runtime did not create its local socket.');
    chmodSync(socketPath, 0o600);
    socket = new WebSocket('ws://localhost/rpc', { createConnection: () => createConnection(socketPath), perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    socket.on('message', data => {
      const line = data.toString();
      // Publish only after the App has completed a real native handshake.
      if (!initialized) {
        try {
          const response = JSON.parse(line);
          if (response.result?.codexHome && response.result?.userAgent) {
            initialized = true;
            const manifest = { version: 1, launchId, bridgePid: process.pid, appPid: process.ppid, runtimePid: child.pid, codexHome: response.result.codexHome, executable, socketPath, startedAt: new Date().toISOString() };
            const temporary = `${manifestPath}.tmp`;
            writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 }); renameSync(temporary, manifestPath);
          }
        } catch { /* Runtime JSON is forwarded intact; the App handles protocol errors. */ }
      }
      if (!process.stdout.write(`${line}\n`)) socket?.pause();
    });
    process.stdout.on('drain', () => socket?.resume());
    socket.once('error', error => { process.stderr.write(`Morrow native connection failed: ${error.message}\n`); process.exitCode = 1; cleanup(); });
    socket.once('close', cleanup);
    await new Promise<void>((done, reject) => { socket!.once('open', done); socket!.once('error', reject); });
    for (const line of queued) socket.send(line);
    queued.length = 0;
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runAppHostBridge();
