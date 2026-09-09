#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("fixture-runtime 1.0.0");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(
    "--restricted --tools --safe-mode --json-schema --permission-prompts --permission-mode --strict-mcp-config --mcp-config --allowedTools --name --resume --verbose --output-format --json --sandbox --output-last-message --ignore-user-config",
  );
  process.exit(0);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
let config = {};
try {
  config = JSON.parse(
    readFileSync(join(process.cwd(), ".fixture.json"), "utf8"),
  );
} catch {}
writeFileSync(
  join(process.cwd(), ".fixture-capture.json"),
  JSON.stringify({ args, input, pid: process.pid }),
);
if (config.sleep) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      config.ignoreTerm
        ? 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)'
        : 'require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)',
      join(process.cwd(), ".fixture-child-ready"),
    ],
    { stdio: "ignore" },
  );
  writeFileSync(join(process.cwd(), ".fixture-child.pid"), String(child.pid));
  console.log(
    JSON.stringify({ type: "thread.started", thread_id: "fixture-session-1" }),
  );
  setInterval(() => {}, 1000);
} else if (config.partial) {
  process.stdout.write('partial native output without newline');
  process.stderr.write('partial diagnostic without newline');
  setInterval(() => {}, 1000);
} else if (config.splitUTF8) {
  const result = {
    summary: "中文证据完整",
    items: [],
    nextCheckMinutes: 60,
    knowledge: [],
    needsHuman: false,
  };
  const buffer = Buffer.from(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(result) },
    }) + "\n",
  );
  for (const byte of buffer) {
    process.stdout.write(Buffer.from([byte]));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
} else if (config.fail) {
  console.error(
    config.authFailure
      ? "get_detail_param returned 401; authentication_failed"
      : "Fixture provider failure",
  );
  process.exit(2);
} else if (config.malformed) {
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "No structured output available." },
    }),
  );
} else {
  if (Array.isArray(config.events)) for (const event of config.events) console.log(JSON.stringify(event));
  if (config.delay) await new Promise(resolve => setTimeout(resolve, config.delay));
  const result = config.result || {
    summary: "检查完成，已验证一个真实 fixture 事项。",
    items: [
      {
        id: "",
        title: "Fixture 发现",
        summary: "根据测试文件确认。",
        status: "verified",
        kind: "issue",
        evidence: ["fixture.txt:1 — 可复查的测试证据"],
        nextStep: "继续核对",
      },
    ],
    nextCheckMinutes: 60,
    knowledge: [
      { text: "共享确认事实", source: "fixture.txt:1", confirmed: true },
      { text: "未验证的猜想", source: "fixture-notes.md", confirmed: false },
    ],
    needsHuman: false,
  };
  const claude = args.includes("--print");
  const finalText = config.finalText ?? (config.markdown ? 'Implemented the requested work.\n\n```morrow-report\n' + JSON.stringify(result) + '\n```' : JSON.stringify(result));
  console.log(
    JSON.stringify({
      type: claude ? "system" : "thread.started",
      session_id: "fixture-session-1",
      thread_id: "fixture-session-1",
    }),
  );
  if (claude)
    console.log(
      JSON.stringify({
        type: "result",
        is_error: false,
        session_id: "fixture-session-1",
        ...(config.finalText !== undefined || config.markdown ? {} : {structured_output: result}),
        result: finalText,
      }),
    );
  else {
    const output = args[args.indexOf("--output-last-message") + 1];
    if (output) writeFileSync(output, finalText);
    console.log(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: finalText },
      }),
    );
  }
  if (config.recovered) console.log(JSON.stringify({type:'turn.completed'}));
}
