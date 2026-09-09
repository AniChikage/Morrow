import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  APIError,
  choice,
  engines,
  integer,
  itemStatuses,
  itemKinds,
  keys,
  object,
  string,
} from "./protocol.ts";
import type { Channel, Project, Run, WorkItem } from "./protocol.ts";
import { now, Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { eventHistory, runHistory, runOutput } from "./event-history.ts";
import { discoverRuntimes } from "./runtimes.ts";
import { NativeConversations } from './native-conversations.ts';
import type { NativeTransport } from './native-conversations.ts';
import { importNativeImages, readNativeImage } from './native-media.ts';
function model(value: unknown) {
  const text = string(value, "model", 120, true);
  if (text && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text))
    throw new APIError(400, "model 格式无效");
  return text;
}
function defaultChannel(
  projectId: string,
  name: string,
  goal: string,
): Channel {
  return {
    id: randomUUID(),
    projectId,
    name,
    goal,
    runtime: "codex",
    model: "",
    status: "paused",
    intervalMinutes: 60,
    maxRunsPerDay: 8,
    permission: "workspace-write",
    nextRunAt: "",
    lastRunAt: "",
    sessionId: "",
  };
}
function itemFields(data: Record<string, any>, old?: WorkItem) {
  if (data.evidence !== undefined && (!Array.isArray(data.evidence) || data.evidence.length > 50)) throw new APIError(400, 'evidence 必须为数组，最多 50 项');
  return {
    title: data.title === undefined && old ? old.title : string(data.title, 'title', 300),
    summary: data.summary === undefined ? old?.summary || '' : string(data.summary, 'summary', 10000, true),
    kind: data.kind === undefined ? old?.kind || 'feature' : choice(data.kind, 'kind', itemKinds),
    status: data.status === undefined ? old?.status || 'open' : choice(data.status, 'status', itemStatuses),
    evidence: data.evidence === undefined ? old?.evidence || [] : data.evidence.map((entry: unknown) => string(entry, 'evidence', 5000)),
    nextStep: data.nextStep === undefined ? old?.nextStep || '' : string(data.nextStep, 'nextStep', 5000, true),
  };
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new APIError(413, "请求正文超过 1 MB");
    chunks.push(chunk);
  }
  if (!length) return {};
  if (!req.headers["content-type"]?.includes("application/json"))
    throw new APIError(415, "请使用 application/json");
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (e) {
    if (e instanceof APIError) throw e;
    throw new APIError(400, "JSON 格式无效");
  }
}
export async function startServer(
  options: { home?: string; port?: number; nativeTransport?: NativeTransport } = {},
) {
  const currentHome = join(homedir(), "Library/Application Support/Morrow");
  const legacyHome = join(homedir(), "Library/Application Support/NoHuman");
  const home = options.home || process.env.MORROW_HOME || process.env.NOHUMAN_HOME ||
    (existsSync(currentHome) || !existsSync(legacyHome) ? currentHome : legacyHome);
  const port = options.port ?? Number(process.env.MORROW_PORT || process.env.NOHUMAN_PORT || 43821);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("MORROW_PORT 无效");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const lockPath = join(home, "daemon.lock");
  const lockText = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const acquire = () =>
    writeFileSync(lockPath, lockText, { flag: "wx", mode: 0o600 });
  try {
    acquire();
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    let live = true;
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      if (!Number.isInteger(lock.pid) || lock.pid <= 0)
        throw new Error("Invalid lock");
      try {
        process.kill(lock.pid, 0);
      } catch (error: any) {
        if (error.code === "ESRCH") live = false;
        else throw error;
      }
    } catch {
      throw new Error("服务锁无效，请检查 daemon.lock");
    }
    if (live) throw new Error("同一数据目录的服务已在运行");
    unlinkSync(lockPath);
    acquire();
  }
  const release = () => {
    try {
      if (readFileSync(lockPath, "utf8") === lockText) unlinkSync(lockPath);
    } catch {}
  };
  let token = "";
  try {
    token = readFileSync(join(home, "token"), "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("令牌文件无效");
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      release();
      throw e;
    }
    token = randomBytes(32).toString("hex");
    writeFileSync(join(home, "token"), token, { flag: "wx", mode: 0o600 });
  }
  chmodSync(join(home, "token"), 0o600);
  const store = new Store(join(home, "workspace.sqlite"));
  const engine = new Engine(store, home, token);
  const native = new NativeConversations(store,engine,options.nativeTransport);
  engine.native = native;
  engine.loop.verification.connect(native.transport,value=>engine.redact(value));
  engine.recover();
  engine.runtimes = await discoverRuntimes();
  const respond = (res: ServerResponse, status: number, data: any) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(data).replaceAll(token, "[REDACTED]"));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const path = url.pathname;
      if (req.method === "GET" && path === "/health") {
        respond(res, 200, { ok: true, service: "morrow" });
        return;
      }
      if (!path.startsWith("/api/")) throw new APIError(404, "接口不存在");
      if (req.headers.origin) throw new APIError(403, "不接受浏览器跨域请求");
      if(req.method==='POST'&&path==='/api/agent') {
        const scope=engine.loop.authenticate(req.headers.authorization||'');
        respond(res,200,await engine.loop.call(scope,await body(req)));return;
      }
      const supplied = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new APIError(401, "需要本机访问令牌");
      if (req.method === "GET" && path === "/api/state") {
        respond(res, 200, store.snapshot(engine.runtimes));
        return;
      }
      if (req.method === 'GET' && path === '/api/native/status') {respond(res,200,await native.status());return;}
      const loopMatch=path.match(/^\/api\/projects\/([^/]+)\/work$/);
      if(req.method==='GET'&&loopMatch){if(!store.get<Project>('projects',loopMatch[1]))throw new APIError(404,'项目不存在');const itemId=url.searchParams.get('itemId')||undefined;if(itemId&&store.get<WorkItem>('items',itemId)?.projectId!==loopMatch[1])throw new APIError(404,'feature 不属于该项目');respond(res,200,engine.loop.view(loopMatch[1],itemId));return;}
      if (req.method === "GET" && path === "/api/events") {
        respond(res, 200, eventHistory(store, url.searchParams));
        return;
      }
      if (req.method === 'GET' && path === '/api/runs') { respond(res, 200, runHistory(store, url.searchParams)); return; }
      const runMatch = path.match(/^\/api\/runs\/([^/]+)(?:\/(output))?$/);
      if (req.method === 'GET' && runMatch) {
        const run = store.get<Run>('runs', runMatch[1]);
        if (!run) throw new APIError(404, '运行记录不存在');
        if (runMatch[2]) respond(res, 200, runOutput(store, run.id, url.searchParams));
        else { const result = store.get('results', run.id); respond(res, 200, {run, prompt:store.runText(run.id, 'prompt'), finalOutput:store.runText(run.id, 'final'), ...(result ? {report:result.result} : {})}); }
        return;
      }
      const data = await body(req);
      const reviewMatch=path.match(/^\/api\/releases\/([^/]+)\/(review|reconcile)$/);
      if(req.method==='POST'&&reviewMatch){if(reviewMatch[2]==='reconcile'){keys(data,[]);respond(res,200,await engine.loop.reconcile(reviewMatch[1]));}else{keys(data,['reviewHash','decision','feedback']);respond(res,200,engine.loop.review(reviewMatch[1],string(data.reviewHash,'reviewHash',64),choice(data.decision,'decision',['approve','reject'] as const),data.feedback===undefined?'':string(data.feedback,'feedback',10000,true)));}return;}
      if(req.method==='POST'&&path==='/api/native/background/setup'){keys(data,[]);respond(res,200,native.configureBackground());return;}
      if(req.method==='POST'&&path==='/api/native/background/restore'){keys(data,[]);respond(res,200,native.restoreBackground());return;}
      const nativeImageMatch=path.match(/^\/api\/channels\/([^/]+)\/native\/images(?:\/([^/]+)\/([0-9]+))?$/);
      if(nativeImageMatch){const [,id,itemId,index]=nativeImageMatch;if(req.method==='POST'&&!itemId){keys(data,['paths']);respond(res,200,importNativeImages(store,home,id,data.paths));return;}if(req.method==='GET'&&itemId){respond(res,200,readNativeImage(store,id,itemId,Number(index)));return;}throw new APIError(405,'图片操作不支持此请求方法');}
      const nativeMatch=path.match(/^\/api\/channels\/([^/]+)\/native\/(threads|conversation|bind|create|messages|interrupt|respond|open)$/);
      if(nativeMatch) {
        const id=nativeMatch[1], action=nativeMatch[2];
        if(req.method==='GET' && action==='threads'){respond(res,200,await native.list(id));return;}
        if(req.method==='GET' && action==='conversation'){
          for(const key of url.searchParams.keys())if(!['before','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw new APIError(400,'原生历史查询参数无效');
          const before=url.searchParams.get('before')||undefined;if(before&&!/^[a-f0-9]{64}$/.test(before))throw new APIError(400,'原生消息游标无效');
          const rawLimit=url.searchParams.get('limit');if(rawLimit!==null&&!/^[1-9][0-9]{0,2}$/.test(rawLimit))throw new APIError(400,'原生历史 limit 无效');const limit=rawLimit===null?80:integer(Number(rawLimit),'limit',1,200);
          respond(res,200,await native.conversation(id,{before,limit}));return;
        }
        if(req.method==='GET' && action==='open'){const {project}=native.channel(id);const binding=native.binding(id);respond(res,200,{projectPath:project.path,...(binding?{threadId:binding.threadId}:{})});return;}
        if(req.method==='POST' && action==='bind'){keys(data,['threadId']);respond(res,200,await native.bind(id,string(data.threadId,'threadId',200)));return;}
        if(req.method==='POST' && action==='create'){keys(data,[]);respond(res,200,await native.create(id));return;}
        if(req.method==='POST' && action==='messages'){
          keys(data,['text','requestId','attachments']);if(typeof data.text!=='string'||(!data.text.trim()&&(!Array.isArray(data.attachments)||!data.attachments.length))||data.text.length>200000||data.text.includes('\0'))throw new APIError(400,'消息正文无效');
          const requestId=string(data.requestId,'requestId',200);if(!/^[a-zA-Z0-9_-]+$/.test(requestId))throw new APIError(400,'消息请求 ID 无效');respond(res,200,await native.send(id,data.text,requestId,'chat',undefined,data.attachments||[]));return;
        }
        if(req.method==='POST' && action==='interrupt'){keys(data,['turnId']);respond(res,200,await native.interrupt(id,string(data.turnId,'turnId',200)));return;}
        if(req.method==='POST' && action==='respond'){keys(data,['requestId','response']);if(!Object.hasOwn(data,'response'))throw new APIError(400,'缺少原生请求答复');respond(res,200,await native.respond(id,string(data.requestId,'requestId',200),data.response));return;}
        throw new APIError(405,'原生对话操作不支持此请求方法');
      }
      if (req.method === "POST" && path === "/api/projects") {
        keys(data, ["name", "path", "goal", "runtime"]);
        const name = string(data.name, "name", 100);
        const goal = string(data.goal, "goal", 20000);
        let projectPath = "";
        try {
          projectPath = realpathSync(string(data.path, "path", 4096));
          if (!statSync(projectPath).isDirectory()) throw new Error();
        } catch {
          throw new APIError(400, "请选择存在的项目文件夹");
        }
        if (
          store
            .all<Project>("projects")
            .some((p) => !p.isDemo && p.path === projectPath)
        )
          throw new APIError(409, "该文件夹已添加为项目");
        const project: Project = {
          id: randomUUID(),
          name,
          path: projectPath,
          goal,
          createdAt: now(),
          isDemo: false,
          runtime: data.runtime === undefined ? 'codex' : choice(data.runtime, 'runtime', engines),
        };
        store.transaction(() => {
          store.put("projects", project);
          engine.audit({projectId:project.id,actor:'human',action:'project.created',text:`已添加项目「${project.name}」。`,after:project});
          for (const c of [
            defaultChannel(
              project.id,
              "自主推进",
              "围绕项目目标理解现状与关键未知，自主选择有价值的行动，获取真实反馈并调整策略；按需要补齐工作能力，合理使用资源。",
            ),
          ]) {
            c.runtime = project.runtime;
            c.maxRunsPerDay = 32;
            store.put("channels", c);
            engine.event(
              c.id,
              "",
              "system",
              "已准备自主推进频道。开始工作后，Codex 会先理解项目并选择下一步；当前保持暂停。",
              undefined,
              {projectId:project.id,actor:'human',action:'channel.created',changes:{after:c}},
            );
          }
        });
        respond(res, 201, project);
        return;
      }
      const createItemMatch = path.match(/^\/api\/projects\/([^/]+)\/items$/);
      if (req.method === 'POST' && createItemMatch) {
        keys(data, ['title','summary','kind','status','evidence','nextStep','channelId']);
        const project = store.get<Project>('projects', createItemMatch[1]);
        if (!project) throw new APIError(404, '项目不存在');
        const channelId = data.channelId === undefined ? '' : string(data.channelId, 'channelId', 100, true);
        if (channelId && store.get<Channel>('channels', channelId)?.projectId !== project.id) throw new APIError(404, '来源频道不属于该项目');
        const time = now();
        const item: WorkItem = {id:randomUUID(),projectId:project.id,number:store.nextItemNumber(project.id),channelId,sourceChannelIds:channelId ? [channelId] : [],lastRunId:'',revision:1,...itemFields(data),createdAt:time,updatedAt:time};
        store.transaction(() => {store.put('items',item); engine.audit({projectId:project.id,channelId,itemId:item.id,actor:'human',action:'item.created',text:`创建功能事项 #${item.number}「${item.title}」。`,after:item});});
        respond(res,201,item); return;
      }
      if (req.method === "POST" && path === "/api/channels") {
        keys(data, [
          "projectId",
          "name",
          "goal",
          "runtime",
          "model",
          "intervalMinutes",
          "maxRunsPerDay",
          "permission",
        ]);
        const projectId = string(data.projectId, "projectId", 100);
        const project = store.get<Project>("projects", projectId);
        if (!project) throw new APIError(404, "项目不存在");
        const c = {
          ...defaultChannel(
            projectId,
            string(data.name, "name", 100),
            string(data.goal, "goal", 20000),
          ),
          runtime: choice(data.runtime, "runtime", engines),
          model: data.model === undefined ? "" : model(data.model),
          intervalMinutes:
            data.intervalMinutes === undefined
              ? 60
              : integer(data.intervalMinutes, "intervalMinutes"),
          maxRunsPerDay:
            data.maxRunsPerDay === undefined
              ? 8
              : integer(data.maxRunsPerDay, "maxRunsPerDay", 1, 100),
          permission:
            data.permission === undefined
              ? ("read-only" as const)
              : choice(data.permission, "permission", [
                  "read-only",
                  "workspace-write", "native",
                ] as const),
        };
        if(c.permission==='native'&&c.runtime!=='codex')throw new APIError(400,'仅 Codex App 支持沿用原生权限');
        store.transaction(() => {store.put("channels", c); engine.audit({projectId,channelId:c.id,actor:'human',action:'channel.created',text:'频道已创建，等待手动运行。',after:c});});
        respond(res, 201, c);
        return;
      }
      const channelMatch = path.match(
        /^\/api\/channels\/([^/]+)(?:\/(action|messages|native-handoff))?$/,
      );
      if (channelMatch) {
        const id = channelMatch[1];
        const c = store.get<Channel>("channels", id);
        if (!c) throw new APIError(404, "频道不存在");
        if (req.method === "PATCH" && !channelMatch[2]) {
          keys(data, [
            "name",
            "goal",
            "runtime",
            "model",
            "intervalMinutes",
            "maxRunsPerDay",
            "permission",
          ]);
          if (
            (engine.active.has(id) || native.isBusy(id)) &&
            ["runtime", "model", "permission"].some(
              (k) => data[k] !== undefined,
            )
          )
            throw new APIError(409, "请先暂停执行再更改运行时、模型或权限");
          const updated = { ...c };
          if(native.binding(id)&&data.runtime!==undefined&&data.runtime!==c.runtime)throw new APIError(409,'频道已绑定 Codex App 原生任务；请新建频道使用其他运行时，避免丢失会话关联');
          if (data.name !== undefined)
            updated.name = string(data.name, "name", 100);
          if (data.goal !== undefined)
            updated.goal = string(data.goal, "goal", 20000);
          if (data.runtime !== undefined)
            updated.runtime = choice(data.runtime, "runtime", engines);
          if (data.model !== undefined) updated.model = model(data.model);
          if (data.permission !== undefined)
            updated.permission = choice(data.permission, "permission", [
              "read-only",
              "workspace-write", "native",
            ] as const);
          if (data.intervalMinutes !== undefined)
            updated.intervalMinutes = integer(
              data.intervalMinutes,
              "intervalMinutes",
            );
          if (data.maxRunsPerDay !== undefined)
            updated.maxRunsPerDay = integer(
              data.maxRunsPerDay,
              "maxRunsPerDay",
              1,
              100,
            );
          if(updated.permission==='native'&&updated.runtime!=='codex')throw new APIError(400,'仅 Codex App 支持沿用原生权限');
          if (updated.runtime !== c.runtime) {
            updated.sessionId = "";
            if (data.model === undefined) updated.model = "";
            engine.event(
              id,
              "",
              "system",
              `运行时已切换为 ${updated.runtime}。保留事项、证据和消息，下次使用完整上下文开始新会话。`,
            );
          } else if (
            !native.binding(id) && (updated.model !== c.model ||
            updated.permission !== c.permission)
          )
            updated.sessionId = "";
          store.transaction(() => {store.put("channels", updated); engine.audit({projectId:c.projectId,channelId:id,actor:'human',action:'channel.updated',text:`已更新持续职责「${updated.name}」设置。`,before:c,after:updated});});
          respond(res, 200, updated);
          return;
        }
        if (req.method === "POST" && channelMatch[2] === "action") {
          keys(data, ["action"]);
          await engine.action(
            id,
            choice(data.action, "action", ["run", "pause", "resume"]),
          );
          engine.audit({projectId:c.projectId,channelId:id,actor:'human',action:'channel.action',text:`频道操作：${({run:'运行一次',pause:'暂停',resume:'持续运行'} as Record<string,string>)[data.action]}。`,before:c,after:store.get('channels',id)});
          respond(res, 200, { ok: true });
          return;
        }
        if (req.method === "POST" && channelMatch[2] === "messages") {
          if(native.binding(id))throw new APIError(409,'已绑定原生任务，请使用原生对话发送消息');
          keys(data, ["text"]);
          respond(
            res,
            201,
            engine.event(id, "", "message", string(data.text, "text", 10000), undefined, {projectId:c.projectId,actor:'human',action:'message.created'}),
          );
          return;
        }
        if (req.method === 'POST' && channelMatch[2] === 'native-handoff') {
          if(native.binding(id))throw new APIError(409,'此频道使用 Codex App 共享会话，请在原生 App 中打开');
          keys(data, []);
          const project = store.get<Project>('projects',c.projectId)!;
          if (project.isDemo) throw new APIError(409,'示例项目不能打开原生会话');
          if (store.all<Channel>('channels').some(other => other.projectId === project.id && (engine.active.has(other.id) || engine.control(other.id).enabled || !['paused','blocked','idle'].includes(other.status)))) throw new APIError(409,'请先暂停项目全部频道，等待运行结束后再打开原生会话');
          const runtime = engine.runtimes.find(runtime => runtime.id === c.runtime);
          if (!runtime?.available) throw new APIError(409,'原生 CLI 不可用，请检查安装');
          engine.audit({projectId:project.id,channelId:id,actor:'human',action:'native-session-opened',text:`已请求打开 ${runtime.name} 原生${c.sessionId ? '会话' : '终端'}；项目持续执行保持暂停。`,after:{runtime:c.runtime,sessionId:c.sessionId}});
          respond(res,200,{projectPath:project.path,runtime:c.runtime,executable:runtime.path,sessionId:c.sessionId});return;
        }
      }
      const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
      if (req.method === "PATCH" && itemMatch) {
        keys(data, ["status", "title", "summary", "kind", "evidence", "nextStep", "revision"]);
        const item = store.get<WorkItem>("items", itemMatch[1]);
        if (!item) throw new APIError(404, "事项不存在");
        if (data.revision !== undefined && integer(data.revision, 'revision', 1, Number.MAX_SAFE_INTEGER) !== item.revision) throw new APIError(409,'事项已被更新，请刷新后再保存');
        const updated = {
          ...item,
          ...itemFields(data, item),
          revision: item.revision + 1,
          updatedAt: now(),
        };
        store.transaction(() => {store.put("items", updated); engine.audit({projectId:item.projectId,channelId:item.channelId,itemId:item.id,actor:'human',action:'item.updated',text:`更新功能事项 #${item.number}「${updated.title}」。`,before:item,after:updated});});
        respond(res, 200, updated);
        return;
      }
      if (req.method === "POST" && path === "/api/runtimes/refresh") {
        keys(data, []);
        engine.runtimes = await discoverRuntimes();
        respond(res, 200, engine.runtimes);
        return;
      }
      if (req.method === "POST" && path === "/api/demo") {
        keys(data, []);
        createDemo(store, engine);
        respond(res, 200, { ok: true });
        return;
      }
      throw new APIError(404, "接口不存在");
    } catch (e) {
      respond(res, e instanceof APIError ? e.status : 500, {
        error:
          e instanceof APIError ? e.message : "服务内部错误，请查看本机日志",
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    store.close();
    release();
    throw e;
  }
  engine.loop.baseURL=`http://127.0.0.1:${(server.address() as any).port}`;
  engine.startScheduler();
  void native.start();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await engine.close();
    await engine.loop.close();
    native.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    release();
  };
  return {
    server,
    store,
    engine,
    native,
    home,
    port: (server.address() as any).port,
    close,
  };
}
function createDemo(store: Store, engine: Engine) {
  if (store.all<Project>("projects").some((p) => p.isDemo)) return;
  const createdAt = now();
  const p: Project = {
    id: randomUUID(),
    name: "Atlas 示例项目",
    path: "",
    goal: "让每个产品团队都能把客户反馈转化为清晰、可验证的产品改进。",
    createdAt,
    isDemo: true,
    runtime: 'codex',
  };
  const system = defaultChannel(
    p.id,
    "系统完善",
    "持续提升 Atlas 的可靠性与产品体验。",
  );
  const operations = {
    ...defaultChannel(
      p.id,
      "运营洞察",
      "从用户反馈中发现增长机会，记录证据并验证假设。",
    ),
    runtime: "claude" as const,
  };
  store.transaction(() => {
    store.put("projects", p);
    store.put("channels", system);
    store.put("channels", operations);
    const add = (
      c: Channel,
      title: string,
      summary: string,
      status: string,
      kind: string,
      evidence: string[],
      nextStep: string,
    ) =>
      store.put("items", {
        id: randomUUID(),
        projectId: p.id,
        channelId: c.id,
        number: store.nextItemNumber(p.id),
        sourceChannelIds: [c.id],
        lastRunId: '',
        revision: 1,
        title,
        summary,
        status,
        kind,
        evidence,
        nextStep,
        createdAt,
        updatedAt: createdAt,
      });
    add(
      system,
      "空状态缺少下一步指引",
      "示例分析：首次进入反馈看板时，没有数据的团队难以找到导入入口。",
      "verified",
      "issue",
      [
        "[示例证据] onboarding/review.md：5 位试用者中 3 位未找到导入入口。",
        "[示例证据] 截图核对：空状态仅显示“暂无反馈”。",
      ],
      "设计带导入入口的空状态，并进行一次可用性验证。",
    );
    add(
      system,
      "导入失败需要可恢复的错误提示",
      "示例分析：CSV 字段不匹配时，当前提示没有指出具体列名。",
      "investigating",
      "issue",
      ["[示例证据] fixtures/import-invalid.csv：第 4 列字段不匹配。"],
      "补充错误定位，并验证重复导入是否安全。",
    );
    add(
      system,
      "反馈列表加载状态已统一",
      "示例结论：统一了列表首次加载与筛选切换时的反馈。",
      "resolved",
      "issue",
      ["[示例证据] UI 回归记录：加载、空列表和错误三种状态均已人工核对。"],
      "观察真实用户反馈，确认是否存在遗漏状态。",
    );
    add(
      operations,
      "把首条反馈变成激活时刻",
      "示例假设：缩短从创建空间到导入首条反馈的路径，可能提高激活率。",
      "open",
      "hypothesis",
      ["[示例证据] 访谈摘要：团队希望尽快看到自己的客户反馈。"],
      "先定义激活指标，再设计小范围实验；尚无真实转化率数据。",
    );
    add(
      operations,
      "为高频反馈生成每周摘要",
      "示例机会：团队反复手动整理相似反馈，值得探索自动摘要。",
      "investigating",
      "opportunity",
      ["[示例证据] 3 条访谈笔记均提及每周整理反馈耗时。"],
      "验证摘要质量和可追溯性，确认团队是否愿意采用。",
    );
    for (const c of [system, operations]) {
      engine.event(
        c.id,
        "",
        "system",
        "这是明确标注的示例数据，不来自真实运行。示例频道不会执行或自动调度。",
      );
      engine.event(
        c.id,
        "",
        "assistant",
        c.id === system.id
          ? "已整理 3 个系统完善事项，分别保留调查证据、状态和下一步。"
          : "先保留机会与假设的区别，等真实数据支持后再更新结论。",
      );
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer()
    .then((service) => {
      console.log(`Morrow listening on http://127.0.0.1:${service.port}`);
      let closing = false;
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        process.on(signal, () => {
          if (closing) return;
          closing = true;
          service.close().then(() => process.exit(0));
        });
    })
    .catch((e) => {
      console.error(`Morrow: ${e instanceof Error ? e.message : "启动失败"}`);
      process.exit(1);
    });
}
