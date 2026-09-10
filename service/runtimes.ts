import { constants, accessSync, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Channel, EventDetail, Runtime, RuntimeID } from "./protocol.ts";
import { providerEventDetails } from "./event-details.ts";
const execute = promisify(execFile);
const titles = { codex: "Codex", claude: "Claude Code", trae: "Trae CLI" };
export function runtimePath(id: RuntimeID): string {
  if (process.env.MORROW_TEST_MODE === "1") {
    const p = process.env[`MORROW_TEST_${id.toUpperCase()}_PATH`];
    return p && existsSync(p) ? p : "";
  }
  const directories = [
    ...(process.env.PATH || "").split(delimiter),
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  for (const name of id === "trae" ? ["traex", "traecli"] : [id])
    for (const d of directories) {
      const p = join(d, name);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {}
    }
  return "";
}
export async function discoverRuntimes(): Promise<Runtime[]> {
  return await Promise.all(
    (["codex", "claude", "trae"] as RuntimeID[]).map(async (id) => {
      const path = runtimePath(id);
      const base = {
        id,
        name: titles[id],
        path,
        version: "",
        available: false,
        canWrite: false,
        detail: "未找到命令行运行时，请安装并在终端登录。",
      };
      if (!path) return base;
      try {
        const [version, help] = await Promise.all([
          execute(path, ["--version"], { timeout: 8000, maxBuffer: 64 * 1024 }),
          execute(path, id === "claude" ? ["--help"] : [id === "codex" ? "app-server" : "exec", "--help"], {
            timeout: 8000,
            maxBuffer: 256 * 1024,
          }),
        ]);
        const required = id === "codex" ? ["--listen"] :
          id === "claude"
            ? [
                "--restricted",
                "--tools",
                "--safe-mode",
                "--permission-prompts",
                "--permission-mode",
                "--strict-mcp-config",
                "--mcp-config",
                "--allowedTools",
                "--name",
                "--resume",
                "--verbose",
                "--output-format",
              ]
            : [
                "--json",
                "--sandbox",
                "--output-last-message",
              ];
        if (!required.every((flag) => help.stdout.includes(flag)))
          return {
            ...base,
            version: version.stdout.trim().slice(0, 300),
            detail: "当前 CLI 版本缺少必要的安全或结构化输出选项，请升级。",
          };
        return {
          ...base,
          version: version.stdout.trim().slice(0, 300),
          available: true,
          canWrite: true,
          detail: "CLI 已安装，尚未验证登录和配额；执行时将使用本机登录状态。",
        };
      } catch {
        return { ...base, detail: "CLI 探测失败或超时，请在终端检查安装。" };
      }
    }),
  );
}
export function invocation(
  channel: Channel,
  runId: string,
  schemaPath: string,
  outputPath: string,
): string[] {
  if (channel.runtime === "claude") {
    const tools =
      channel.permission === "read-only"
        ? "Read,Grep,Glob"
        : "Read,Grep,Glob,Edit,Write";
    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--safe-mode",
      "--restricted",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      tools,
      "--allowedTools",
      tools,
      "--permission-mode",
      channel.permission === "read-only" ? "dontAsk" : "acceptEdits",
      "--permission-prompts",
      "none",
      "--name",
      `Morrow:${runId}`,
    ];
    if (channel.model) args.push("--model", channel.model);
    if (channel.sessionId) args.push("--resume", channel.sessionId);
    return args;
  }
  // Config overrides apply on fresh and resumed sessions; no bypass switches are used.
  const args = ["exec"];
  if (channel.sessionId) args.push("resume");
  args.push(
    "--json",
    "--skip-git-repo-check",
    "-c",
    `sandbox_mode="${channel.permission}"`,
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    "--output-last-message",
    outputPath,
  );
  if (!channel.sessionId) args.push("--sandbox", channel.permission);
  if (channel.model) args.push("--model", channel.model);
  if (channel.sessionId) args.push(channel.sessionId);
  args.push("-");
  return args;
}
export function decodeLine(line: string): {
  kind: string;
  text: string;
  sessionId?: string;
  final?: unknown;
  finalText?: string;
  error?: boolean;
  terminalOutcome?: "completed" | "failed";
  detail?: EventDetail;
  additionalDetails?: EventDetail[];
} {
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return { kind: "system", text: line };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "system", text: line };
  const details = providerEventDetails(data);
  const detailFields = details.length ? { detail: details[0], ...(details.length > 1 ? { additionalDetails: details.slice(1) } : {}) } : {};
  const sessionId =
    typeof (data.thread_id || data.session_id) === "string"
      ? data.thread_id || data.session_id
      : undefined;
  if (data.type === "result")
    return {
      kind: data.is_error ? "error" : "result",
      text:
        typeof data.result === "string"
          ? data.result
          : JSON.stringify(data.structured_output || data),
      sessionId,
      final: data.structured_output,
      finalText: typeof data.result === "string" ? data.result : undefined,
      error: !!data.is_error,
      terminalOutcome: data.is_error ? "failed" : "completed",
    };
  if (data.item?.type === "agent_message")
    return {
      kind: "assistant",
      text: typeof data.item.text === "string" ? data.item.text : JSON.stringify(data.item),
      sessionId,
      finalText: typeof data.item.text === "string" ? data.item.text : undefined,
    };
  if (data.type === "assistant") {
    const content = Array.isArray(data.message?.content)
      ? data.message.content.filter((block: any) => block && typeof block === "object")
      : [];
    const text = content
      .filter((b: any) => b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
    return {
      kind: content.some((b: any) => b.type === "tool_use")
        ? "tool"
        : "assistant",
      text: text || JSON.stringify(data),
      sessionId,
      ...detailFields,
    };
  }
  if (data.summary && Array.isArray(data.items))
    return {
      kind: "result",
      text: JSON.stringify(data),
      final: data,
      sessionId,
    };
  return {
    kind:
      data.type === "error" || data.type === "turn.failed"
        ? "error"
        : data.item || details.length
          ? "tool"
          : "system",
    text: JSON.stringify(data),
    sessionId,
    ...detailFields,
    error: data.type === "error" || data.type === "turn.failed",
    ...(data.type === "turn.failed" ? { terminalOutcome: "failed" as const } : data.type === "turn.completed" ? { terminalOutcome: "completed" as const } : {}),
  };
}

export function diagnoseFailure(
  runtime: RuntimeID,
  text: string,
): { priority: number; summary: string } | undefined {
  const command =
    runtime === "claude"
      ? "claude auth login"
      : runtime === "trae"
        ? "traex login"
        : "codex login";
  if (
    /not logged in|authentication[_ -]failed|unauthenticated|unauthorized|\b401\b|invalid[_ -](?:api[_ -])?(?:key|token)|login required/i.test(
      text,
    )
  )
    return {
      priority: 100,
      summary: `${titles[runtime]} 登录无效或已过期。请在执行主机的终端运行 ${command}，完成登录后重试；未产生有效分析结果。`,
    };
  if (
    /insufficient[_ -]quota|quota exceeded|usage limit|rate[_ -]limit|\b429\b|credit balance/i.test(
      text,
    )
  )
    return {
      priority: 90,
      summary: `${titles[runtime]} 配额不足或触发速率限制。请检查该 CLI 账户的用量与重置时间后重试。`,
    };
  if (
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network is unreachable|failed to connect|connection timed out/i.test(
      text,
    )
  )
    return {
      priority: 70,
      summary: `${titles[runtime]} 无法连接模型服务。请在执行主机检查网络、代理和 CLI 服务连接后重试。`,
    };
  if (
    /model.*(?:not found|does not exist|unsupported|unavailable)|(?:empty|missing).*model.*(?:metadata|config)|model.*metadata.*(?:empty|missing)/i.test(
      text,
    )
  )
    return {
      priority: 50,
      summary: `${titles[runtime]} 无法加载所选模型。请检查模型名称与账户访问权限；可清空模型字段，使用该 CLI 的默认模型后重试。`,
    };
  return undefined;
}
