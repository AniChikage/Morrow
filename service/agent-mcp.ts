#!/usr/bin/env node
/**
 * Host-side stdio MCP for one CLI turn. Codex and Claude spawn this outside the sandbox; it wraps
 * that run's `tool.sh` / `agent-cli.ts` so the grant token stays in `agent-context.json` and never
 * enters the prompt or the MCP handshake. Imports only `node:` builtins so a pinned copy runs alone.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const workMcpServer = 'morrow';
export const workMcpTool = 'call';
export const claudeWorkMcpTool = `mcp__${workMcpServer}__${workMcpTool}`;

type JsonRpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: any };

export type WorkMcpLaunch = { command: string; args: string[] };

export type AgentMcpInvoke = (
  operation: string,
  input: unknown,
  requestId?: string
) => Promise<{ ok: boolean; text: string }>;

const toolSchema = {
  name: workMcpTool,
  description:
    'Morrow work interface for this turn. Pass operation (context, contract, feature.upsert, release.propose, …) and JSON input. Writes need a stable requestId. Cannot approve a release. evidence.native and execution.prepare need a bound App task.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string' },
      input: { type: 'object' },
      requestId: { type: 'string' },
    },
    required: ['operation'],
  },
};

/** Claude `--mcp-config`: Morrow-only stdio server. Pair with `--strict-mcp-config`. */
export function claudeWorkMcpConfig(launch: WorkMcpLaunch): string {
  return JSON.stringify({
    mcpServers: {
      [workMcpServer]: { type: 'stdio', command: launch.command, args: launch.args },
    },
  });
}

/** Codex/Trae `-c` overlays. Keep `sandbox_workspace_write.network_access=false` beside these. */
export function workMcpOverlays(launch: WorkMcpLaunch): string[] {
  const prefix = `mcp_servers.${workMcpServer}`;
  return [
    '-c',
    `${prefix}.command=${JSON.stringify(launch.command)}`,
    '-c',
    `${prefix}.args=${JSON.stringify(launch.args)}`,
    '-c',
    `${prefix}.default_tools_approval_mode="approve"`,
  ];
}

export function workMcpLaunch(node: string, helper: string, launcher: string): WorkMcpLaunch {
  return { command: node, args: [helper, '--launcher', launcher] };
}

export function invokeLauncher(
  launcher: string,
  operation: string,
  input: unknown,
  requestId?: string
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const args = ['--operation', operation];
    if (requestId) args.push('--request-id', requestId);
    args.push('--input', '-');
    const child = spawn('/bin/sh', [launcher, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, text: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      resolve({ ok: code === 0, text: code === 0 ? out : err || out || `exit ${code}` });
    });
    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

export async function handleAgentMessage(message: JsonRpc, invoke: AgentMcpInvoke): Promise<object | undefined> {
  const method = typeof message.method === 'string' ? message.method : '';
  if (method === 'initialize') {
    const protocolVersion =
      typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2024-11-05';
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'morrow-work', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'initialized' || method === 'notifications/cancelled')
    return undefined;
  if (method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: message.id, result: { tools: [toolSchema] } };
  }
  if (method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name !== workMcpTool) {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown tool ${String(name)}` } };
    }
    const operation = typeof args.operation === 'string' ? args.operation : '';
    if (!operation) {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'operation is required' } };
    }
    const requestId = typeof args.requestId === 'string' ? args.requestId : undefined;
    const result = await invoke(operation, args.input ?? {}, requestId);
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: result.text }], ...(result.ok ? {} : { isError: true }) },
    };
  }
  if (message.id !== undefined && message.id !== null) {
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${method}` } };
  }
  return undefined;
}

const isMain = process.argv.includes('--launcher');
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const launcher = flag('--launcher');
  if (!launcher) {
    process.stderr.write('缺少 --launcher\n');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    queue = queue.then(async () => {
      let message: JsonRpc;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const reply = await handleAgentMessage(message, (operation, input, requestId) =>
        invokeLauncher(launcher, operation, input, requestId)
      );
      if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
    });
  });
}
