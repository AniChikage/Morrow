// Explicit opt-in integration smoke; invokes the user's already-authenticated CLIs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { startServer } from "../service/server.ts";

if (!process.argv.includes("--run"))
  throw new Error("Use --run to invoke real authenticated CLI runtimes.");
const root = resolve("artifacts/live-smoke-" + Date.now());
mkdirSync(root, { recursive: true });
const service = await startServer({ home: join(root, "state"), port: 0 });
const token = readFileSync(join(root, "state/token"), "utf8");
async function api(path: string, data?: unknown, method = "POST") {
  const response = await fetch(`http://127.0.0.1:${service.port}/api/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
const reports: unknown[] = [];
try {
  await Promise.all(
    service.engine.runtimes.map(async (runtime) => {
      const filter = process.argv
        .find((arg) => arg.startsWith("--runtime="))
        ?.split("=")[1];
      if (filter && runtime.id !== filter) return;
      const began = Date.now();
      if (!runtime.available) {
        reports.push({
          runtime: runtime.id,
          status: "unavailable",
          detail: runtime.detail,
        });
        return;
      }
      const dir = join(root, runtime.id);
      mkdirSync(dir);
      const source =
        "export function ratio(done, total) { return done / total; }\n";
      writeFileSync(join(dir, "ratio.js"), source);
      writeFileSync(
        join(dir, "README.md"),
        "# Ratio fixture\nContract: ratio(done, total) returns completion ratio. When total equals 0 it must return 0.\n",
      );
      const project = await api("projects", {
        name: `CLI smoke ${runtime.name}`,
        path: dir,
        goal: "仅检查本目录 README.md 和 ratio.js 的一致性；这是合成测试，不是线上系统。保持只读，不读取其他目录。报告可从文件直接验证的发现，快速完成单轮。",
      });
      const channel = service.store
        .all<any>("channels")
        .find((c) => c.projectId === project.id);
      await api(
        `channels/${channel.id}`,
        {
          runtime: runtime.id,
          maxRunsPerDay: 1,
          goal: "快速核对 ratio.js 是否满足 README.md 的零分母约定。只需读取这两个文件，可使用 cat 等只读命令读取，不修改文件。用文件和表达式作为证据，返回指定 JSON。",
        },
        "PATCH",
      );
      await api(`channels/${channel.id}/action`, { action: "run" });
      console.log(`${runtime.id}: started bounded read-only fixture`);
      while (Date.now() - began < 150000) {
        const run = service.store
          .all<any>("runs")
          .find((r) => r.channelId === channel.id);
        if (run && run.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (service.engine.active.has(channel.id))
        await api(`channels/${channel.id}/action`, { action: "pause" });
      const active = service.engine.active.get(channel.id);
      if (active) await active.done;
      const run = service.store
        .all<any>("runs")
        .find((r) => r.channelId === channel.id);
      const intact = readFileSync(join(dir, "ratio.js"), "utf8") === source;
      const report = {
        runtime: runtime.id,
        status: run?.status,
        summary: run?.summary,
        findings: service.store
          .all<any>("items")
          .filter((i) => i.channelId === channel.id).length,
        fixtureUnchanged: intact,
        seconds: Math.round((Date.now() - began) / 1000),
      };
      reports.push(report);
      console.log(JSON.stringify(report));
      if (!intact)
        throw new Error(`${runtime.id}: read-only fixture was modified`);
    }),
  );
} finally {
  await service.close();
  writeFileSync(join(root, "report.json"), JSON.stringify(reports, null, 2));
  console.log(`Report: ${root}/report.json`);
}
