import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store } from "../service/store.ts";
import { eventHistory } from "../service/event-history.ts";
import { startServer } from "../service/server.ts";
import { invocation, diagnoseFailure } from "../service/runtimes.ts";
import { validateResult } from "../service/protocol.ts";
const fixture = resolve("tests/fixtures/runtime.mjs");
process.env.NOHUMAN_TEST_MODE = "1";
for (const id of ["CODEX", "CLAUDE", "TRAE"])
  process.env[`NOHUMAN_TEST_${id}_PATH`] = fixture;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => any, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await pause(25);
  }
  throw new Error("Timed out");
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "nohuman-test-"));
  const home = join(root, "home");
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  const service = await startServer({ home, port: 0 });
  const token = readFileSync(join(home, "token"), "utf8");
  const base = `http://127.0.0.1:${service.port}`;
  const api = async (
    method: string,
    path: string,
    data?: any,
    expected = 200,
  ) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await res.json();
    assert.equal(res.status, expected, JSON.stringify(value));
    return value;
  };
  const project = await api(
    "POST",
    "/api/projects",
    { name: "Test Project", path: projectPath, goal: "验证完整项目循环" },
    201,
  );
  const state = await api("GET", "/api/state");
  const channels = state.channels;
  assert.equal(channels.length,1);
  assert.equal(channels[0].name,'自主推进');
  channels.push(await api('POST','/api/channels',{projectId:project.id,name:'独立验收职责',goal:'验证共享项目上下文',runtime:'codex',permission:'workspace-write'},201));
  const config = (value: any) =>
    writeFileSync(join(projectPath, ".fixture.json"), JSON.stringify(value));
  return {
    ...service,
    root,
    home,
    base,
    token,
    api,
    project,
    projectPath,
    channels,
    config,
    cleanup: async () => {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("local auth, schema validation, paused defaults and idempotent explicit demo", async () => {
  const s = await setup();
  try {
    assert.deepEqual(await (await fetch(s.base + "/health")).json(), {
      ok: true,
      service: "nohuman",
    });
    assert.equal((await fetch(s.base + "/api/state")).status, 401);
    assert.equal(statSync(join(s.home, "token")).mode & 0o777, 0o600);
    assert.equal(
      (
        await fetch(s.base + "/api/state", {
          headers: {
            Authorization: `Bearer ${s.token}`,
            Origin: "https://example.com",
          },
        })
      ).status,
      403,
    );
    assert(
      s.channels.every(
        (c: any) =>
          c.status === "paused" &&
          c.permission === "workspace-write" &&
          c.sessionId === "",
      ),
    );
    await s.api(
      "POST",
      "/api/projects",
      { name: "Again", path: s.projectPath, goal: "Duplicate" },
      409,
    );
    await s.api(
      "PATCH",
      `/api/channels/${s.channels[0].id}`,
      { model: "--dangerous" },
      400,
    );
    await s.api(
      "PATCH",
      `/api/channels/${s.channels[0].id}`,
      { maxRunsPerDay: 0 },
      400,
    );
    await s.api(
      "POST",
      "/api/channels",
      { projectId: s.project.id, name: "A", goal: "B", runtime: "unknown" },
      400,
    );
    await s.api("POST", "/api/demo", {});
    await s.api("POST", "/api/demo", {});
    const state = await s.api("GET", "/api/state");
    assert.equal(state.projects.filter((p: any) => p.isDemo).length, 1);
    assert(state.items.every((i: any) => i.evidence.length));
    const demo = state.channels.find((c: any) => c.projectId !== s.project.id);
    await s.api(
      "POST",
      `/api/channels/${demo.id}/action`,
      { action: "run" },
      409,
    );
    assert(!JSON.stringify(state).includes(s.token));
  } finally {
    await s.cleanup();
  }
});
test("one-shot persists valid results, shared sourced knowledge, messages, native resume and engine handoff", async () => {
  const s = await setup();
  try {
    const c = s.channels[0];
    await s.api("PATCH", `/api/channels/${c.id}`, {permission:"read-only"});
    await s.api(
      "POST",
      `/api/channels/${c.id}/messages`,
      { text: "请重点检查导入流程" },
      201,
    );
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "run" });
    await until(() =>
      s.store.all<any>("runs").find((r) => r.status === "completed"),
    );
    let state = await s.api("GET", "/api/state");
    assert.equal(state.channels[0].status, "paused");
    assert.equal(state.channels[0].sessionId, "fixture-session-1");
    assert.equal(state.items.length, 1);
    assert.equal(s.store.all("results").length, 1);
    const capture = JSON.parse(
      readFileSync(join(s.projectPath, ".fixture-capture.json"), "utf8"),
    );
    assert(capture.input.includes("请重点检查导入流程"));
    assert(capture.args.includes('sandbox_mode="read-only"'));
    assert(s.engine.prompt(s.project, s.channels[1]).includes("共享确认事实"));
    assert(!s.engine.prompt(s.project, s.channels[1]).includes("未验证的猜想"));
    assert(s.store.all<any>("knowledge").every((k) => k.source && k.createdAt));
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "run" });
    await until(
      () =>
        s.store.all<any>("runs").filter((r) => r.status === "completed")
          .length === 2,
    );
    assert(
      JSON.parse(
        readFileSync(join(s.projectPath, ".fixture-capture.json"), "utf8"),
      ).args.includes("resume"),
    );
    const updated = await s.api("PATCH", `/api/channels/${c.id}`, {
      runtime: "claude",
    });
    assert.equal(updated.sessionId, "");
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "run" });
    await until(
      () =>
        s.store.all<any>("runs").filter((r) => r.status === "completed")
          .length === 3,
    );
    const nextCapture = JSON.parse(
      readFileSync(join(s.projectPath, ".fixture-capture.json"), "utf8"),
    );
    assert(!nextCapture.args.includes("--resume"));
    assert(nextCapture.input.includes("Fixture 发现"));
    assert(nextCapture.args.includes("--restricted"));
    assert.equal(
      nextCapture.args[nextCapture.args.indexOf("--tools") + 1],
      "Read,Grep,Glob",
    );
    state = await s.api("GET", "/api/state");
    assert.equal(state.runs.at(-1).runtime, "claude");
  } finally {
    await s.cleanup();
  }
});
test("successful native output without a report does not invent findings or fail execution", async () => {
  const s = await setup();
  try {
    s.config({ malformed: true });
    const c = s.channels[0];
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "run" });
    await until(() =>
      s.store.all<any>("runs").some((r) => r.status === "completed"),
    );
    const state = await s.api("GET", "/api/state");
    assert.equal(state.items.length, 0);
    assert.equal(state.channels[0].status, "paused");
    assert.equal(state.runs[0].reportStatus, "missing");
    assert(state.runs[0].summary.includes("No structured output"));
    assert.equal(s.store.all("results").length, 0);
  } finally {
    await s.cleanup();
  }
});
test("daily budget applies to manual runs and scheduled continuation", async () => {
  const s = await setup();
  try {
    const c = s.channels[0];
    await s.api("PATCH", `/api/channels/${c.id}`, { maxRunsPerDay: 1 });
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "run" });
    await until(() =>
      s.store.all<any>("runs").some((r) => r.status === "completed"),
    );
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "run" }, 429);
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "resume" });
    const current = s.store.get<any>("channels", c.id);
    assert.equal(current.status, "waiting");
    assert(current.nextRunAt > new Date().toISOString());
    assert.equal(s.store.all("runs").length, 1);
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "pause" });
  } finally {
    await s.cleanup();
  }
});
test("project execution lock, settings guard, pause cancels complete process group", async () => {
  const s = await setup();
  try {
    s.config({ sleep: true, ignoreTerm: true });
    const [a, b] = s.channels;
    await s.api("POST", `/api/channels/${a.id}/action`, { action: "run" });
    await until(() => existsSync(join(s.projectPath, ".fixture-child-ready")));
    const child = Number(
      readFileSync(join(s.projectPath, ".fixture-child.pid"), "utf8"),
    );
    await s.api("POST", `/api/channels/${b.id}/action`, { action: "run" }, 409);
    await s.api("PATCH", `/api/channels/${a.id}`, { runtime: "claude" }, 409);
    await s.api("POST", `/api/channels/${a.id}/action`, { action: "pause" });
    await until(() =>
      s.store.all<any>("runs").some((r) => r.status === "interrupted"),
    );
    await until(() => {
      try {
        process.kill(child, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(s.store.get<any>("channels", a.id).status, "paused");
    assert.equal(s.engine.active.size, 0);
  } finally {
    await s.cleanup();
  }
});
test("resume scheduling, per-project queued work, and human-needed results stop continuation", async () => {
  const s = await setup();
  try {
    const c = s.channels[0];
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "resume" });
    await until(() =>
      s.store.all<any>("runs").some((r) => r.status === "completed"),
    );
    assert.equal(s.store.get<any>("channels", c.id).status, "waiting");
    assert(s.engine.control(c.id).enabled);
    s.config({
      result: {
        summary: "需要人类提供样本数据。",
        items: [],
        nextCheckMinutes: 60,
        knowledge: [],
        needsHuman: true,
      },
    });
    s.store.put("channels", {
      ...s.store.get<any>("channels", c.id),
      nextRunAt: "2000-01-01T00:00:00.000Z",
    });
    s.engine.tick();
    await until(
      () =>
        s.store.all<any>("runs").filter((r) => r.status === "completed")
          .length === 2,
    );
    assert.equal(s.store.get<any>("channels", c.id).status, "blocked");
    assert(!s.engine.control(c.id).enabled);
  } finally {
    await s.cleanup();
  }
});
test("safe adapters and evidence validation", () => {
  const channel: any = {
    runtime: "codex",
    permission: "read-only",
    sessionId: "previous-session",
    model: "",
  };
  for (const runtime of ["codex", "trae"]) {
    const args = invocation({ ...channel, runtime }, "run", "schema", "output");
    assert(args.includes("resume"));
    assert(args.includes('sandbox_mode="read-only"'));
    assert(args.includes('approval_policy="never"'));
    assert(!args.some((a) => a.includes("dangerously")));
  }
  const args = invocation(
    { ...channel, runtime: "claude", permission: "workspace-write" },
    "run",
    "schema",
    "output",
  );
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob,Edit,Write");
  assert(args.includes("acceptEdits"));
  assert(!args.includes("Bash"));
  assert.throws(() =>
    validateResult({
      summary: "Claim",
      items: [
        {
          id: "",
          title: "Claim",
          summary: "",
          status: "verified",
          kind: "issue",
          evidence: [],
          nextStep: "",
        },
      ],
      nextCheckMinutes: 1,
      knowledge: [],
      needsHuman: false,
    }),
  );
});
test("restart recovers unfinished run, kills verified orphan and pauses channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "nohuman-restart-"));
  const home = join(root, "home");
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  writeFileSync(
    join(projectPath, ".fixture.json"),
    JSON.stringify({ sleep: true }),
  );
  let daemon: any;
  let recovered: any;
  try {
    daemon = spawn(process.execPath, ["service/server.ts"], {
      cwd: resolve("."),
      env: { ...process.env, NOHUMAN_HOME: home, NOHUMAN_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    daemon.stdout.on("data", (c: any) => (output += c));
    await until(() => output.includes("listening"));
    const port = output.match(/127\.0\.0\.1:(\d+)/)![1];
    const token = readFileSync(join(home, "token"), "utf8");
    const api = async (path: string, data?: any) => {
      const r = await fetch(`http://127.0.0.1:${port}` + path, {
        method: data ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return r.json();
    };
    await api("/api/projects", {
      name: "Recovery",
      path: projectPath,
      goal: "Recover safely",
    });
    const state: any = await api("/api/state");
    const id = state.channels[0].id;
    await api(`/api/channels/${id}/action`, { action: "resume" });
    await until(() => existsSync(join(projectPath, ".fixture-capture.json")));
    const pid = JSON.parse(
      readFileSync(join(projectPath, ".fixture-capture.json"), "utf8"),
    ).pid;
    daemon.kill("SIGKILL");
    await new Promise((resolve) => daemon.once("close", resolve));
    daemon = undefined;
    recovered = await startServer({ home, port: 0 });
    assert.equal(recovered.store.all("runs")[0].status, "interrupted");
    assert.equal(recovered.store.get("channels", id).status, "paused");
    assert(!recovered.engine.control(id).enabled);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    if (daemon) {
      daemon.kill("SIGKILL");
      await new Promise((resolve) => daemon.once("close", resolve));
    }
    if (recovered) await recovered.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("split UTF-8 stream preserves Chinese structured output", async () => {
  const s = await setup();
  try {
    s.config({ splitUTF8: true });
    await s.api("POST", `/api/channels/${s.channels[0].id}/action`, {
      action: "run",
    });
    await until(() =>
      s.store.all<any>("runs").some((r) => r.status === "completed"),
    );
    assert.equal(s.store.all<any>("runs")[0].summary, "中文证据完整");
  } finally {
    await s.cleanup();
  }
});

test("execution timeout interrupts and disables scheduling", async () => {
  process.env.NOHUMAN_TEST_TIMEOUT_MS = "150";
  const s = await setup();
  try {
    s.config({ sleep: true });
    await s.api("POST", `/api/channels/${s.channels[0].id}/action`, {
      action: "resume",
    });
    await until(() =>
      s.store.all<any>("runs").some((r) => r.status === "interrupted"),
    );
    assert.equal(
      s.store.get<any>("channels", s.channels[0].id).status,
      "paused",
    );
    assert(!s.engine.control(s.channels[0].id).enabled);
    assert(s.store.all<any>("runs")[0].summary.includes("超时"));
  } finally {
    await s.cleanup();
    delete process.env.NOHUMAN_TEST_TIMEOUT_MS;
  }
});

test("authentication failures are actionable and never reported as valid results", async () => {
  const s = await setup();
  try {
    s.config({ fail: true, authFailure: true });
    const c = s.channels[0];
    await s.api("PATCH", `/api/channels/${c.id}`, { runtime: "claude" });
    await s.api("POST", `/api/channels/${c.id}/action`, { action: "run" });
    await until(() =>
      s.store.all<any>("runs").some((r) => r.status === "failed"),
    );
    assert(s.store.all<any>("runs")[0].summary.includes("claude auth login"));
    assert.equal(s.store.all("results").length, 0);
    assert.equal(s.store.all("items").length, 0);
    assert(
      diagnoseFailure(
        "trae",
        "get_detail_param returned 401",
      )?.summary.includes("traex login"),
    );
    assert(
      diagnoseFailure("codex", "429 rate_limit")?.summary.includes("配额"),
    );
  } finally {
    await s.cleanup();
  }
});


test("event history uses scoped stable cursors and includes legacy events", async () => {
  const s = await setup();
  try {
    const channelId = s.channels[0].id;
    const runId = randomUUID();
    s.store.put("runs", { id: runId, channelId, status: "completed" });
    const otherRunId = randomUUID();
    s.store.put("runs", { id: otherRunId, channelId, status: "completed" });
    const first = s.store.event(channelId, runId, "system", "legacy plain log");
    const second = s.engine.event(channelId, runId, "tool", "tool input", { type: "tool_use", tool: "Read", input: { path: "a.txt" }, toolCallId: "read-1" });
    s.store.event(s.channels[1].id, "", "system", "another channel");
    const third = s.engine.event(channelId, runId, "tool", "tool result", { type: "tool_result", toolCallId: "read-1", output: "result" });
    s.store.event(channelId, otherRunId, "system", "another run");
    const fourth = s.store.event(channelId, runId, "result", "finished");
    for (const event of [first, second, third, fourth]) s.store.put("events", { ...event, createdAt: "2026-01-01T00:00:00.000Z" });
    const query = `/api/events?channelId=${channelId}&runId=${runId}&limit=2`;
    const latest = await s.api("GET", query);
    assert.deepEqual(latest.events.map((e: any) => e.id), [third.id, fourth.id]);
    assert.equal(latest.hasMore, true); assert.equal(latest.cursor, third.id);
    const previous = await s.api("GET", `${query}&before=${latest.cursor}`);
    assert.deepEqual(previous.events.map((e: any) => e.id), [first.id, second.id]);
    assert.equal(previous.hasMore, false); assert.equal(previous.events[0].detail, undefined);
    assert.equal(previous.events[1].detail.sequence, 2);
    const incremental = await s.api("GET", `${query}&after=${first.id}`);
    assert.deepEqual(incremental.events.map((e: any) => e.id), [second.id, third.id]);
    assert.equal(incremental.cursor, third.id); assert.equal(incremental.hasMore, true);
    const remainder = await s.api("GET", `${query}&after=${incremental.cursor}`);
    assert.deepEqual(remainder.events.map((e: any) => e.id), [fourth.id]); assert.equal(remainder.hasMore, false);
    const empty = await s.api("GET", `${query}&after=${fourth.id}`);
    assert.deepEqual(empty, { events: [], hasMore: false });
    const snapshot = await s.api("GET", "/api/state");
    assert.equal(snapshot.events.find((e: any) => e.id === third.id).detail.sequence, 3);
    assert.equal((await fetch(s.base + query)).status, 401);
    assert.equal((await fetch(s.base + query, { headers: { Authorization: `Bearer ${s.token}`, Origin: "http://example.com" } })).status, 403);
    for (const suffix of ["&limit=201", "&limit=0", "&limit=1.5", "&limit=abc", "&unknown=yes", `&before=${first.id}&after=${third.id}`, "&after=invalid"]) await s.api("GET", `/api/events?channelId=${channelId}&runId=${runId}${suffix}`, undefined, 400);
    await s.api("GET", `${query}&limit=3`, undefined, 400);
    for (let index = 0; index < 205; index++) s.store.event(s.channels[1].id, "", "system", `history ${index}`);
    const bounded = await s.api("GET", `/api/events?channelId=${s.channels[1].id}&limit=200`);
    assert.equal(bounded.events.length, 200); assert.equal(bounded.hasMore, true);
    const defaultPage = await s.api("GET", `/api/events?channelId=${s.channels[1].id}`);
    assert.equal(defaultPage.events.length, 50);
    await s.api("GET", "/api/events", undefined, 400);
    await s.api("GET", `/api/events?channelId=${randomUUID()}`, undefined, 404);
    await s.api("GET", `${query}&before=${randomUUID()}`, undefined, 404);
    await s.api("GET", `/api/events?channelId=${s.channels[1].id}&runId=${runId}`, undefined, 404);
    await s.api("GET", `/api/events?channelId=${s.channels[1].id}&before=${first.id}`, undefined, 404);
    await s.api("GET", `/api/events?channelId=${channelId}&runId=${otherRunId}&before=${first.id}`, undefined, 404);
    // Reopen only this test's temporary database; production daemons are untouched.
    await s.close();
    const reopened = new Store(join(s.home, "workspace.sqlite"));
    try {
      const persisted = eventHistory(reopened, new URLSearchParams({ channelId, runId, after: second.id }));
      assert.deepEqual(persisted.events.map(event => event.id), [third.id, fourth.id]);
      assert.equal(persisted.events[0].detail?.sequence, 3);
      const next = reopened.event(channelId, runId, "tool", "continued", { type: "tool_use", tool: "Read" });
      assert.equal(next.detail?.sequence, 5);
    } finally { reopened.close(); }
  } finally { await s.cleanup(); }
});

test("streamed Claude tools persist multiple details, matched names and sanitized output", async () => {
  const s = await setup();
  try {
    const channelId = s.channels[0].id;
    await s.api("PATCH", `/api/channels/${channelId}`, { runtime: "claude" });
    s.config({ events: [
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "read-a", name: "Read", input: { path: "a.txt" } },
        { type: "tool_use", id: "read-b", name: "Grep", input: { pattern: "TODO" } }
      ] } },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "read-a", content: `visible ${s.token}`, is_error: false },
        { type: "tool_result", tool_use_id: "read-b", content: "no matches", is_error: false }
      ] } }
    ] });
    await s.api("POST", `/api/channels/${channelId}/action`, { action: "run" });
    await until(() => s.store.all<any>("runs").some(r => r.status === "completed"));
    const runId = s.store.all<any>("runs")[0].id;
    const page = await s.api("GET", `/api/events?channelId=${channelId}&runId=${runId}`);
    const details = page.events.filter((e: any) => e.detail).map((e: any) => e.detail);
    assert.equal(details.length, 4);
    assert.deepEqual(details.map((d: any) => d.tool), ["Read", "Grep", "Read", "Grep"]);
    assert(details.every((d: any, i: number) => i === 0 || d.sequence > details[i - 1].sequence));
    assert(!JSON.stringify(page).includes(s.token));
    assert(!JSON.stringify(s.store.all("events")).includes(s.token));
    assert(details[2].output.includes("[REDACTED]"));
  } finally { await s.cleanup(); }
});

test('project board creation, provenance, optimistic edits and project audit are durable', async () => {
  const s = await setup();
  try {
    const item = await s.api('POST', `/api/projects/${s.project.id}/items`, {title:'统一导入流程'}, 201);
    assert.equal(item.projectId,s.project.id); assert.equal(item.channelId,''); assert.equal(item.number,1); assert.equal(item.kind,'feature'); assert.equal(item.revision,1);
    const updated = await s.api('PATCH', `/api/items/${item.id}`, {summary:'手工描述',nextStep:'验证导入',revision:1});
    assert.equal(updated.revision,2);
    await s.api('PATCH', `/api/items/${item.id}`, {title:'旧版本覆盖',revision:1},409);
    const legacy = await s.api('PATCH', `/api/items/${item.id}`, {status:'investigating'});
    assert.equal(legacy.revision,3);
    await s.api('PATCH', `/api/items/${item.id}`, {projectId:'elsewhere'},400);
    const history = await s.api('GET', `/api/events?projectId=${s.project.id}&itemId=${item.id}&limit=2`);
    assert.equal(history.events.length,2); assert.equal(history.hasMore,true);
    assert.equal(history.events.at(-1).changes.before.status,'open');
    assert.equal(history.events.at(-1).changes.after.status,'investigating');
    assert(history.events.every((event:any)=>event.actor==='human' && event.itemId===item.id));
    const first = await s.api('GET', `/api/events?projectId=${s.project.id}&itemId=${item.id}&before=${history.cursor}`);
    assert.equal(first.events[0].action,'item.created'); assert.equal(first.hasMore,false);
    await s.api('GET', `/api/events?projectId=${s.project.id}&itemId=${randomUUID()}`,undefined,404);
    await s.api('GET', `/api/events?projectId=${s.project.id}&before=${randomUUID()}`,undefined,404);
    assert.equal((await fetch(s.base+`/api/events?projectId=${s.project.id}`)).status,401);
    const rootPath=join(s.root,'second');mkdirSync(rootPath);
    const project=await s.api('POST','/api/projects',{name:'Other',path:rootPath,goal:'other',runtime:'claude'},201);
    const state=await s.api('GET','/api/state');
    assert.equal(project.runtime,'claude');assert(state.channels.filter((c:any)=>c.projectId===project.id).every((c:any)=>c.runtime==='claude'));
    await s.api('POST',`/api/projects/${project.id}/items`,{title:'Wrong provenance',channelId:s.channels[0].id},404);
    await s.api('GET',`/api/events?projectId=${project.id}&channelId=${s.channels[0].id}`,undefined,404);
  } finally {await s.cleanup();}
});

test('sibling channels advance one project item, preserve origin, reject other projects and protect human edits', async () => {
  const s=await setup();
  const report=(item:any,title:string)=>({summary:'更新功能',items:[{id:item.id,title,summary:'验证后的内容',status:'investigating',kind:'feature',evidence:['fixture.txt:1'],nextStep:'下一步'}],nextCheckMinutes:60,knowledge:[],needsHuman:false});
  const waitRuns=(count:number)=>until(()=>s.store.all<any>('runs').filter(r=>r.status==='completed').length===count);
  try {
    const [a,b]=s.channels;
    const item=await s.api('POST',`/api/projects/${s.project.id}/items`,{title:'Shared feature',channelId:a.id},201);
    s.config({markdown:true,result:report(item,'Shared feature updated')});
    await s.api('POST',`/api/channels/${b.id}/action`,{action:'run'});await waitRuns(1);
    let updated=s.store.get<any>('items',item.id);
    assert.equal(s.store.all('items').length,1);assert.equal(updated.channelId,a.id);assert.deepEqual(updated.sourceChannelIds,[a.id,b.id]);assert.equal(updated.revision,2);
    assert(s.engine.prompt(s.project,a).includes('Shared feature updated'));
    const run=s.store.all<any>('runs')[0];assert.equal(updated.lastRunId,run.id);assert.equal(run.reportStatus,'valid');
    const history=await s.api('GET',`/api/events?projectId=${s.project.id}&itemId=${item.id}`);
    assert.equal(history.events.at(-1).actor,'agent');assert.equal(history.events.at(-1).channelId,b.id);
    s.config({delay:300,result:report(updated,'Agent stale overwrite')});
    await s.api('POST',`/api/channels/${a.id}/action`,{action:'run'});
    await s.api('PATCH',`/api/items/${item.id}`,{title:'Human latest',revision:updated.revision});
    await waitRuns(2);updated=s.store.get<any>('items',item.id);
    assert.equal(updated.title,'Human latest');assert.equal(s.store.all<any>('runs').at(-1).reportStatus,'conflict');
    assert(s.store.all<any>('events').some(e=>e.action==='item.conflict' && e.itemId===item.id));
    const otherPath=join(s.root,'other');mkdirSync(otherPath);
    const other=await s.api('POST','/api/projects',{name:'Other',path:otherPath,goal:'Other'},201);
    const foreign=await s.api('POST',`/api/projects/${other.id}/items`,{title:'Foreign item'},201);
    s.config({result:report(foreign,'Should never apply')});
    await s.api('POST',`/api/channels/${a.id}/action`,{action:'run'});await waitRuns(3);
    assert.equal(s.store.get<any>('items',foreign.id).title,'Foreign item');assert.equal(s.store.all<any>('runs').at(-1).reportStatus,'invalid');
  } finally {await s.cleanup();}
});

test('optional invalid reports do not fail native work and terminal success overrides transient diagnostics',async()=>{
  const s=await setup();
  try {
    const c=s.channels[0];
    s.config({finalText:'Native work finished.\n```nohuman-report\n{broken}\n```',events:[{type:'error',message:'Transient retry'}],recovered:true});
    await s.api('POST',`/api/channels/${c.id}/action`,{action:'resume'});
    await until(()=>s.store.all<any>('runs').some(r=>r.status==='completed'));
    const run=s.store.all<any>('runs')[0];
    assert.equal(run.reportStatus,'invalid');assert.equal(run.exitCode,0);assert.equal(run.trigger,'schedule');
    assert.equal(s.store.get<any>('channels',c.id).status,'waiting');assert(s.engine.control(c.id).enabled);assert.equal(s.store.all('items').length,0);
    const detail=await s.api('GET',`/api/runs/${run.id}`);
    assert(detail.finalOutput.includes('Native work finished.'));assert(detail.prompt.includes('可选'));assert.equal(detail.report,undefined);
    await s.api('POST',`/api/channels/${c.id}/action`,{action:'pause'});
    const args=invocation({...c,sessionId:'exact-session'},run.id,'schema','output');
    for(const flag of ['--ignore-user-config','--ignore-rules','--output-schema','--last'])assert(!args.includes(flag));
    assert(args.includes('exact-session'));assert(args.includes('approval_policy="never"'));assert(args.includes('sandbox_workspace_write.network_access=false'));
    const claude=invocation({...c,runtime:'claude',sessionId:'exact-claude'},run.id,'schema','output');
    assert(!claude.includes('--json-schema'));assert(claude.includes('--resume'));assert(claude.includes('exact-claude'));assert(!claude.includes('Bash'));
  } finally {await s.cleanup();}
});

test('full run records and raw I/O page beyond snapshots with auth and scoped cursors',async()=>{
  const s=await setup();
  try {
    const c=s.channels[0];
    await s.api('POST',`/api/channels/${c.id}/action`,{action:'run'});
    await until(()=>s.store.all<any>('runs').some(r=>r.status==='completed'));
    const run=s.store.all<any>('runs')[0];
    const detail=await s.api('GET',`/api/runs/${run.id}`);
    assert.equal(detail.run.permission,'workspace-write');assert.equal(detail.run.projectId,s.project.id);assert(detail.prompt.includes('验证完整项目循环'));assert.equal(detail.report.summary,run.summary);
    for(let index=0;index<112;index++)s.store.io(run.id,'stdout',`chunk${index}\n`);
    let page=await s.api('GET',`/api/runs/${run.id}/output?limit=100`);assert.equal(page.hasMore,true);const chunks=[...page.chunks];
    while(page.hasMore){page=await s.api('GET',`/api/runs/${run.id}/output?after=${page.cursor}&limit=100`);chunks.push(...page.chunks);}
    assert(chunks.some((chunk:any)=>chunk.stream==='prompt'));assert(chunks.some((chunk:any)=>chunk.stream==='report'));assert(chunks.some((chunk:any)=>chunk.stream==='final'));
    assert(chunks.map((chunk:any)=>chunk.text).join('').includes('chunk111'));
    assert.deepEqual(chunks.map((chunk:any)=>chunk.sequence),chunks.map((_:any,index:number)=>index+1));
    await s.api('GET',`/api/runs/${run.id}/output?limit=101`,undefined,400);
    await s.api('GET',`/api/runs/${run.id}/output?after=${randomUUID()}`,undefined,404);
    assert.equal((await fetch(s.base+`/api/runs/${run.id}/output`)).status,401);
    for(let index=0;index<505;index++)s.store.put('runs',{...run,id:randomUUID(),summary:`historic-${index}`});
    assert(!(await s.api('GET','/api/state')).runs.some((r:any)=>r.id===run.id));
    assert.equal((await s.api('GET',`/api/runs/${run.id}`)).run.id,run.id);
    const recent=await s.api('GET',`/api/runs?projectId=${s.project.id}&limit=200`);assert.equal(recent.runs.length,200);assert(recent.hasMore);
    const older=await s.api('GET',`/api/runs?projectId=${s.project.id}&before=${recent.cursor}&limit=200`);assert(!older.runs.some((r:any)=>recent.runs.some((n:any)=>n.id===r.id)));
    await s.api('GET',`/api/runs?projectId=${s.project.id}&before=${randomUUID()}`,undefined,404);
  }finally{await s.cleanup();}
});

test('unfinished native stdout and stderr persist before exit and split tokens remain redacted',async()=>{
  const s=await setup();
  try {
    const c=s.channels[0];s.config({partial:true});
    await s.api('POST',`/api/channels/${c.id}/action`,{action:'run'});
    await until(()=>s.store.all<any>('run_io').some(chunk=>chunk.stream==='stderr'));
    const run=s.store.all<any>('runs')[0];assert.equal(run.status,'running');
    const page=await s.api('GET',`/api/runs/${run.id}/output`);
    for (const [stream, expected] of [['stdout','partial native output without newline'],['stderr','partial diagnostic without newline']]) {
      const publicText=page.chunks.filter((chunk:any)=>chunk.stream===stream).map((chunk:any)=>chunk.text).join('');
      const pending=s.store.get<any>('run_io_pending',`${run.id}:${stream}`)?.text || '';
      assert.equal(publicText+pending,expected);
    }
    for(const text of ['prefix ',s.token.slice(0,20),s.token.slice(20,40),s.token.slice(40),' suffix'])s.store.ioStream(run.id,'stdout',text,s.token);
    const text=s.store.runText(run.id,'stdout');assert(!text.includes(s.token));assert(text.includes('prefix [REDACTED] suffix'));
    await s.api('POST',`/api/channels/${c.id}/action`,{action:'pause'});
    await until(()=>s.store.get<any>('runs',run.id).status==='interrupted');
  }finally{await s.cleanup();}
});

test('native handoff requires every project channel paused and records intent with exact native session',async()=>{
  const s=await setup();
  try {
    const [a,b]=s.channels;s.store.put('channels',{...a,sessionId:'native-exact'});
    const result=await s.api('POST',`/api/channels/${a.id}/native-handoff`,{});
    assert.equal(result.sessionId,'native-exact');assert.equal(result.projectPath,s.project.path);assert.equal(result.executable,fixture);
    assert(s.store.all<any>('events').some(e=>e.action==='native-session-opened' && e.actor==='human'));
    s.engine.setControl(b.id,{enabled:true});
    await s.api('POST',`/api/channels/${a.id}/native-handoff`,{},409);
    s.engine.setControl(b.id,{enabled:false});
    s.config({sleep:true});await s.api('POST',`/api/channels/${a.id}/action`,{action:'run'});
    await until(()=>s.store.get<any>('channels',a.id).sessionId==='fixture-session-1');
    await s.api('POST',`/api/channels/${a.id}/native-handoff`,{},409);
    await s.api('POST',`/api/channels/${a.id}/action`,{action:'pause'});
    await until(()=>s.store.all<any>('runs').some(run=>run.status==='interrupted'));
    assert.equal(s.store.get<any>('channels',a.id).sessionId,'fixture-session-1');
  }finally{await s.cleanup();}
});

test('legacy project board migration is idempotent and mirrors existing artifacts',()=>{
  const home=mkdtempSync(join(tmpdir(),'nohuman-migration-'));const path=join(home,'workspace.sqlite');let store=new Store(path);
  try{
    const projectId=randomUUID(),channelId=randomUUID(),itemId=randomUUID(),runId=randomUUID(),eventId=randomUUID();
    store.put('projects',{id:projectId,name:'legacy'});store.put('channels',{id:channelId,projectId,runtime:'trae',sessionId:'provider-native'});
    store.put('items',{id:itemId,channelId,title:'legacy item'});store.put('runs',{id:runId,channelId,status:'completed',sessionId:'provider-native'});store.put('events',{id:eventId,channelId,runId,kind:'assistant',text:'Legacy'});
    store.db.exec('DELETE FROM migrations');const dir=join(home,'runs',runId);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'prompt.txt'),'legacy prompt');writeFileSync(join(dir,'stdout.jsonl'),'legacy stdout\n');store.close();
    store=new Store(path);const first=store.get<any>('items',itemId);assert.equal(first.projectId,projectId);assert.equal(first.number,1);assert.equal(first.revision,1);assert.deepEqual(first.sourceChannelIds,[channelId]);
    assert.equal(store.get<any>('projects',projectId).runtime,'trae');assert.equal(store.get<any>('events',eventId).projectId,projectId);assert.equal(store.get<any>('channels',channelId).sessionId,'provider-native');assert.equal(store.runText(runId,'prompt'),'legacy prompt');
    const count=store.all('run_io').length;store.close();store=new Store(path);assert.deepEqual(store.get('items',itemId),first);assert.equal(store.all('run_io').length,count);
  }finally{store.close();rmSync(home,{recursive:true,force:true});}
});

test('incremental raw output cursors never revise prior chunks, lose suffixes or expose pending token prefixes',()=>{
  const home=mkdtempSync(join(tmpdir(),'nohuman-output-cursors-'));const path=join(home,'workspace.sqlite');let store=new Store(path);
  const secret='0123456789abcdef'.repeat(4),runId=randomUUID();
  try{
    store.ioStream(runId,'stdout','prefix '+secret.slice(0,32),secret);
    const first=store.ioPage(runId,undefined,100);
    assert.equal(first.chunks.map(chunk=>chunk.text).join(''),'prefix ');
    assert(!JSON.stringify(first).includes(secret.slice(0,32)));
    assert.equal(store.get<any>('run_io_pending',`${runId}:stdout`).text,secret.slice(0,32));
    const frozen=JSON.stringify(first.chunks);
    // Pending bytes survive a restart without publishing incomplete secrets.
    store.close();store=new Store(path);
    store.ioStream(runId,'stdout',secret.slice(32)+' suffix',secret);
    const next=store.ioPage(runId,first.cursor,100);
    assert.equal([...first.chunks,...next.chunks].map(chunk=>chunk.text).join(''),'prefix [REDACTED] suffix');
    assert.equal(JSON.stringify(store.ioPage(runId,undefined,1).chunks),frozen);
    assert.equal(store.runText(runId,'stdout'),'prefix [REDACTED] suffix');
    for(let split=1;split<secret.length;split++){
      const id=randomUUID();store.ioStream(id,'stdout','begin '+secret.slice(0,split),secret);
      const before=store.ioPage(id,undefined,100);assert.equal(before.chunks.map(chunk=>chunk.text).join(''),'begin ');
      store.ioStream(id,'stdout',secret.slice(split)+' end0',secret);
      store.ioStream(id,'stdout','',secret,true);
      const after=store.ioPage(id,before.cursor,100);
      assert.equal([...before.chunks,...after.chunks].map(chunk=>chunk.text).join(''),'begin [REDACTED] end0');
      assert.equal(JSON.stringify(store.ioPage(id,undefined,1).chunks),JSON.stringify(before.chunks));
    }
  }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
