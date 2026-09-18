import { startServer } from '../service/server.ts';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
// Explicitly opt into one real App turn. Never creates a Codex task or runs as part of npm test.
const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1];
if (args.includes('--help') || !args.includes('--thread') || !args.includes('--project')) {
  console.log(
    'Usage: node scripts/probe-app-follower.ts --thread <existing App task UUID> --project <absolute matching directory> [--out <private directory>]\nRuns one bounded real model turn, reads Morrow context, clicks a synthetic browser page, then pauses. Use an isolated App test task.'
  );
  process.exit(args.includes('--help') ? 0 : 2);
}
const threadId = flag('--thread');
const path = flag('--project');
if (!/^[0-9a-f-]{36}$/i.test(threadId) || !path || !isAbsolute(path))
  throw new Error('An existing task UUID and absolute project directory are required.');
if (process.env.MORROW_TEST_MODE === '1') throw new Error('This live probe cannot run in fixture test mode.');
const out = args.includes('--out') ? flag('--out') : tmpdir();
if (!out || !isAbsolute(out)) throw new Error('--out must be an absolute directory.');
mkdirSync(out, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(out, 'morrow-follower-service-'));
const marker = randomUUID(),
  requests: string[] = [];
const page = createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  requests.push(req.url || '');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    `<h1>Morrow adapter validation</h1><p id="marker">${marker}</p><button onclick="document.querySelector('#result').textContent='ADAPTER_CLICK_OK:'+document.querySelector('#marker').textContent">Check adapter</button><p id="result">NOT_CLICKED</p>`
  );
});
await new Promise((r) => page.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
console.log('evidence', root);
const s = await startServer({ home: root + '/state', port: 0 });
const token = readFileSync(root + '/state/token', 'utf8').trim();
const api = async (method: string, route: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${s.port}${route}`, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
let channel: any;
try {
  const project = (
    await api('POST', '/api/projects', {
      name: 'Morrow follower 适配器隔离验收',
      path,
      goal: '只完成一次连接验收：读取 Morrow 工作上下文，并用应用内浏览器操作指定的合成网页。',
      brief: `这是隔离验收，禁止修改源文件、发布、外发、创建其他任务或自主扩展范围。先按本轮工作接口命令读取 context。然后按 Browser skill 使用应用内浏览器，打开 ${url}/probe，读取 marker，真实点击 Check adapter，再读取 result，并关闭本轮创建的 tab。不要使用 HTTP 或 shell 代替浏览器控制。最终报告实际 marker 与结果，并附一个 morrow-next 代码块：state=wait，说明测试完成，waitMinutes=1440。无需维护 feature 或创建新的长期工作。`,
    })
  ).body;
  channel = s.store.all<any>('channels').find((c) => c.projectId === project.id);
  const status = await s.native.status();
  const unbound = await api('POST', `/api/channels/${channel.id}/action`, { action: 'run' });
  if (unbound.status !== 409 || status.capabilities.create !== false) throw Error('unbound creation guard failed');
  const bound = await api('POST', `/api/channels/${channel.id}/native/bind`, { threadId });
  if (bound.status !== 200) throw Error(JSON.stringify(bound));
  await api('PATCH', `/api/channels/${channel.id}`, { maxRunsPerDay: 1 });
  await s.engine.usage.refresh();
  const start = await api('POST', `/api/channels/${channel.id}/action`, { action: 'run' });
  if (start.status !== 200) throw Error(JSON.stringify(start));
  console.log('started', channel.id);
  const deadline = Date.now() + 240000;
  let run;
  while (Date.now() < deadline) {
    run = s.store.all<any>('runs').find((r) => r.channelId === channel.id && r.source === 'morrow-schedule');
    if (run && run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!run || run.status === 'running') {
    await s.engine.action(channel.id, 'pause');
    throw Error('live follower turn timed out');
  }
  await s.engine.action(channel.id, 'pause');
  const final = s.store.runText(run.id, 'final');
  const result = {
    status: run.status,
    threadId: run.sessionId,
    turnId: run.nativeTurnId,
    permission: run.permission,
    unboundStatus: unbound.status,
    connectionMode: status.connectionMode,
    createCapability: status.capabilities.create,
    usageAvailable: !!s.engine.usage.status().reading,
    expectedMarker: marker,
    pageRequests: requests,
    final,
    items: s.store
      .nativeRows<any>('native_items', run.sessionId)
      .filter((i) => i.turnId === run.nativeTurnId)
      .map((i) => ({ type: i.type, status: i.status, tool: i.raw?.tool, server: i.raw?.server })),
  };
  writeFileSync(root + '/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (run.status !== 'completed' || !requests.includes('/probe') || !final.includes('ADAPTER_CLICK_OK:' + marker))
    throw Error('live adapter browser evidence missing');
} finally {
  if (channel) await s.engine.action(channel.id, 'pause').catch(() => {});
  await s.close();
  await new Promise((r) => page.close(r));
}
