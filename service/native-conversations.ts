import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { APIError } from './protocol.ts';
import type { Channel, Project, Run, NativeConversation, NativeConnectionStatus, NativeItem, NativeRequest, NativeMessageReceipt, NativeThreadSummary } from './protocol.ts';
import { Store, now } from './store.ts';
import type { Engine } from './engine.ts';
import { extractReport } from './reports.ts';
import { applyDesktopPatches } from './codex-desktop-transport.ts';
import { CodexNativeTransport } from './codex-native-transport.ts';
import { CodexSharedTransport } from './codex-shared-transport.ts';
import { configureCodexBridge, restoreCodexBridge } from './codex-bridge-setup.ts';
import { resolveNativeAttachments } from './native-media.ts';

export type NativeSnapshot = {threadId:string;ownerClientId:string;revision:number;syncedAt:string;state:Record<string,any>};
export type NativeWorkOptions = {
  approvalPolicy: 'on-request';
  approvalsReviewer: 'auto_review';
  sandboxPolicy?: {type:'readOnly';networkAccess:false} | {type:'workspaceWrite';writableRoots:string[];networkAccess:false;excludeTmpdirEnvVar:true;excludeSlashTmp:true};
};
type NativeChange = {type:'patches';baseRevision:number;revision:number;patches:unknown[]} | {type:'snapshot';revision:number;conversationState:Record<string,any>};
export interface NativeTransport {
  readonly backgroundReady?: boolean;
  createThread?(cwd:string):Promise<NativeSnapshot>;
  connect():Promise<void>;
  status():{connected:boolean;socketPath:string;lastError:string|null};
  threadStatus?(threadId:string):{ready:boolean;detail:string;lastSyncedAt?:string};
  listThreads(cwd:string):Promise<Array<{id:string;title:string;cwd:string;updatedAt?:string|number;model?:string|null}>>;
  readThread(threadId:string):Promise<NativeSnapshot>;
  loadCompleteHistory?(threadId:string):Promise<NativeSnapshot>;
  subscribe(threadId:string,listener:(snapshot:NativeSnapshot)=>void):Promise<()=>void>;
  subscribeChanges?(threadId:string,listener:(snapshot:NativeSnapshot,change:NativeChange)=>void):Promise<()=>void>;
  sendMessage(threadId:string,text:string,clientMessageId?:string,images?:Array<{path:string}>,workOptions?:NativeWorkOptions):Promise<unknown>;
  interrupt(threadId:string,expectedTurnId:string):Promise<unknown>;
  respond(threadId:string,requestId:string|number,kind:'command'|'file'|'permissions'|'userInput'|'mcp',response:unknown):Promise<unknown>;
  close():void;
}
type Binding = {id:string;projectId:string;threadId:string;cwd:string;createdAt:string;lastSyncedAt?:string;syncError?:string;createdByNoHuman?:boolean};
type StoredThread = NativeSnapshot & {id:string;summary:NativeThreadSummary;hash:string;projectionVersion?:number};
type StoredItem = NativeItem & {threadId:string;ordinal:number;present:boolean};
type Outbox = NativeMessageReceipt & {id:string;channelId:string;projectId:string;threadId:string;text:string;textHash?:string;attachmentIds?:string[];createdAt:string;source:'chat'|'schedule';runId?:string};
const stable = (threadId:string,key:string) => createHash('sha256').update(`${threadId}\0${key}`).digest('hex');
const PROJECTION_VERSION=2;
const isUserItem=(item:any)=>item?.type==='userMessage'||item?.type==='steeringUserMessage';
const inputParts=(item:any):any[]=>Array.isArray(item?.content)?item.content:Array.isArray(item?.input)?item.input:[];
const userText=(item:any)=>{const parts=inputParts(item);return parts.length?parts.filter((part:any)=>part?.type==='text'&&typeof part.text==='string').map((part:any)=>part.text).join(''):typeof item?.restoreMessage?.text==='string'?item.restoreMessage.text:'';};
const itemMatchesRequest=(item:any,requestId:string)=>item?.clientId===requestId||item?.clientUserMessageId===requestId||item?.restoreMessage?.id===requestId;
const isCanonicalSteer=(steering:any,canonical:any)=>canonical?.type==='userMessage'&&((steering.serverUserMessageId&&canonical.id===steering.serverUserMessageId)||([steering.clientUserMessageId,steering.restoreMessage?.id].some(id=>typeof id==='string'&&itemMatchesRequest(canonical,id))));
const errorText = (error:unknown) => error instanceof Error ? error.message : '原生会话同步失败';
const sameFolder=(left:string,right:string)=>{try{return realpathSync(left)===realpathSync(right);}catch{return left===right;}};
function finalText(turn:any):string {const messages=(turn.items||[]).filter((item:any)=>item.type==='agentMessage');const final=messages.filter((item:any)=>item.phase==='final_answer');return (final.length?final:messages.filter((item:any)=>!item.phase).slice(-1)).map((item:any)=>item.text||'').join('\n\n');}
const requestKind = (method:string):NativeRequest['type'] => method.includes('commandExecution') ? 'command' : method.includes('fileChange') ? 'file' : method.includes('permissions') ? 'permissions' : method.includes('requestUserInput') ? 'userInput' : method.includes('elicitation') ? 'mcp' : 'unsupported';
export function nativeTurns(state:Record<string,any>):any[] {
  const history = state.turnHistory?.history;
  const entities = state.turnHistory?.entitiesByKey || history?.entitiesByKey;
  if (Array.isArray(history?.islands) && entities) return history.islands.flatMap((island:any) => (island.entries || []).map((entry:any) => entities[entry.value]).filter(Boolean));
  return Array.isArray(state.turns) ? state.turns : [];
}
function activeTurn(state:Record<string,any>):any | undefined { if(state.threadRuntimeStatus?.type==='idle')return undefined;const turn=nativeTurns(state).at(-1);return turn&&['inProgress','running'].includes(turn.status)?turn:undefined; }
function summary(snapshot:NativeSnapshot):NativeThreadSummary {
  const state=snapshot.state; const active=activeTurn(state);
  return {id:snapshot.threadId,title:state.generatedTitle || state.name || state.title || state.thread?.name || 'Codex 原生任务',cwd:state.cwd || state.latestThreadSettings?.cwd || state.thread?.cwd || '',status:active || state.threadRuntimeStatus?.type === 'active' ? 'running' : 'idle',...(active?.turnId ? {activeTurnId:active.turnId} : {}),...(state.model || state.latestThreadSettings?.model || state.latestModel ? {model:state.model || state.latestThreadSettings?.model || state.latestModel} : {}),updatedAt:snapshot.syncedAt};
}
function nativeItems(snapshot:NativeSnapshot,cache?:WeakMap<object,StoredItem>):StoredItem[] {
  const rows:StoredItem[]=[];
  const canonicalUsers=nativeTurns(snapshot.state).flatMap(turn=>turn.items||[]).filter(item=>item?.type==='userMessage');
  for (const [turnIndex,turn] of nativeTurns(snapshot.state).entries()) {
    const turnId=String(turn.turnId || turn.id || `pending-${turn.params?.clientUserMessageId || turnIndex}`);
    for (const [itemIndex,raw] of (Array.isArray(turn.items) ? turn.items : []).entries()) {
      if (!raw || typeof raw !== 'object') continue;
      const type=String(raw.type || 'unknown');
      if(type==='steered'||(type==='steeringUserMessage'&&canonicalUsers.some(item=>isCanonicalSteer(raw,item))))continue;
      const cached=cache?.get(raw);if(cached&&cached.turnId===turnId&&cached.ordinal===rows.length&&cached.status===(raw.status||turn.status)){rows.push(cached);continue;}
      const role=isUserItem(raw) ? 'user' : type==='agentMessage' ? 'assistant' : type==='systemMessage' ? 'system' : 'tool';
      const text=isUserItem(raw)?userText(raw):typeof raw.text==='string' ? raw.text : Array.isArray(raw.content) ? raw.content.filter((part:any)=>part?.type==='text' && typeof part.text==='string').map((part:any)=>part.text).join('') : typeof raw.aggregatedOutput==='string' ? raw.aggregatedOutput : '';
      const identity=type==='steeringUserMessage'?(raw.serverUserMessageId||raw.id||raw.clientUserMessageId||itemIndex):(raw.id||raw.clientId||itemIndex);
      const created=raw.restoreMessage?.createdAt;const createdAt=(typeof created==='string'||typeof created==='number')&&Number.isFinite(new Date(created).getTime())?new Date(created).toISOString():undefined;
      const row:StoredItem={id:stable(snapshot.threadId,`${turnId}:${identity}`),threadId:snapshot.threadId,turnId,type,role,text,status:raw.status || turn.status,raw,ordinal:rows.length,present:true,...(createdAt?{createdAt}:{}),...(raw.command!==undefined || raw.arguments!==undefined ? {input:raw.command ?? raw.arguments} : {}),...(raw.result!==undefined || raw.aggregatedOutput!==undefined || raw.changes!==undefined ? {output:raw.result ?? raw.aggregatedOutput ?? raw.changes} : {})};cache?.set(raw,row);rows.push(row);
    }
  }
  return rows;
}
export class NativeConversations {
  transport:NativeTransport;
  subscriptions=new Map<string,()=>void>();
  attaching=new Map<string,Promise<void>>();
  sending=new Map<string,Promise<NativeMessageReceipt>>();
  scheduled=new Map<string,{run:Run;revisions:Map<string,number>;runDir:string}>();
  starting=new Set<string>();
  creating=new Map<string,Promise<NativeConversation>>();
  observed=new Map<string,{owner:string;revision:number;syncedAt:string}>();
  threadCache=new Map<string,StoredThread>();
  itemCache=new Map<string,Map<string,StoredItem>>();
  turnCache=new Map<string,{raw:unknown;row:any}>();
  projectedItems=new WeakMap<object,StoredItem>();
  safeValues=new WeakMap<object,any>();
  pendingSnapshots=new Map<string,NativeSnapshot>();
  pendingTimers=new Map<string,ReturnType<typeof setTimeout>>();
  journaled=new Map<string,{owner:string;revision:number}>();
  checkpointAt=new Map<string,number>();
  dirtyThreads=new Set<string>();
  dirtyTurns=new Set<string>();
  closed=false;
  store:Store;
  engine:Engine;
  constructor(store:Store,engine:Engine,transport?:NativeTransport) { this.store=store;this.engine=engine;this.transport=transport || new CodexNativeTransport(undefined,new CodexSharedTransport({preferredLaunchId:()=>store.get<any>('migrations','native-host-affinity')?.launchId,preferredThreadIds:()=>store.all<Binding>('native_bindings').map(row=>row.threadId),onConnected:host=>store.put('migrations',{id:'native-host-affinity',launchId:host.launchId,connectedAt:now()})})); }
  safe<T>(value:T):T {
    if(typeof value==='string')return this.engine.redact(value) as T;
    if(!value||typeof value!=='object')return value;
    const found=this.safeValues.get(value as object);if(found)return found;
    let changed=false;const result:any=Array.isArray(value)?[]:{};
    for(const [key,child] of Object.entries(value)){const next=this.safe(child);Object.defineProperty(result,key,{value:next,writable:true,enumerable:true,configurable:true});if(next!==child)changed=true;}
    const safe=changed?result:value;this.safeValues.set(value as object,safe);return safe as T;
  }
  cachedThread(threadId:string) {let thread=this.threadCache.get(threadId);if(!thread){thread=this.store.get<StoredThread>('native_threads',threadId);if(thread)this.threadCache.set(threadId,thread);}return thread;}
  queueSnapshot(snapshot:NativeSnapshot,change:NativeChange) {
    if(this.closed)return;
    if(change.type==='snapshot'){this.flushPending(snapshot.threadId);this.ingest(snapshot,true);return;}
    const previous=this.journaled.get(snapshot.threadId);if(previous?.owner===snapshot.ownerClientId&&previous.revision>=snapshot.revision)return;
    // Persist every original IPC delta before coalescing its display projection.
    // This small journal can recover a checkpoint after an unclean shutdown.
    this.store.put('native_events',{id:stable(snapshot.threadId,`ipc:${snapshot.ownerClientId}:${snapshot.revision}`),kind:'native.patch',threadId:snapshot.threadId,ownerClientId:snapshot.ownerClientId,revision:snapshot.revision,createdAt:snapshot.syncedAt,change:this.safe(change)});
    this.journaled.set(snapshot.threadId,{owner:snapshot.ownerClientId,revision:snapshot.revision});this.pendingSnapshots.set(snapshot.threadId,snapshot);
    if(!this.pendingTimers.has(snapshot.threadId)){const timer=setTimeout(()=>{this.pendingTimers.delete(snapshot.threadId);try{this.flushPending(snapshot.threadId);}catch(error){this.recordError(snapshot.threadId,error);}},250);timer.unref();this.pendingTimers.set(snapshot.threadId,timer);}
  }
  flushPending(threadId?:string) {for(const id of threadId?[threadId]:[...this.pendingSnapshots.keys()]){const timer=this.pendingTimers.get(id);if(timer)clearTimeout(timer);this.pendingTimers.delete(id);const snapshot=this.pendingSnapshots.get(id);this.pendingSnapshots.delete(id);if(snapshot)this.ingest(snapshot);}}
  checkpoint(threadId:string) {
    const thread=this.threadCache.get(threadId);if(thread&&this.dirtyThreads.has(threadId)){this.store.put('native_threads',thread);this.dirtyThreads.delete(threadId);}
    for(const key of this.dirtyTurns){const cached=this.turnCache.get(key);if(cached?.row.threadId===threadId){this.store.put('native_turns',cached.row);this.dirtyTurns.delete(key);}}
    this.checkpointAt.set(threadId,Date.now());
  }
  recoverCheckpoint(threadId:string) {
    const initial=this.cachedThread(threadId);if(!initial)return;
    const rows=this.store.db.prepare("SELECT data FROM native_events WHERE json_extract(data,'$.kind')='native.patch' AND json_extract(data,'$.threadId')=? AND json_extract(data,'$.ownerClientId')=? AND json_extract(data,'$.revision')>? ORDER BY CAST(json_extract(data,'$.revision') AS INTEGER)").all(threadId,initial.ownerClientId,initial.revision) as Array<{data:string}>;
    let snapshot:NativeSnapshot=initial;
    for(const row of rows){const event=JSON.parse(row.data);if(event.change?.baseRevision!==snapshot.revision)break;snapshot={threadId,ownerClientId:initial.ownerClientId,revision:event.revision,syncedAt:event.createdAt,state:applyDesktopPatches(snapshot.state,event.change.patches)};}
    if(snapshot.revision!==initial.revision)this.ingest(snapshot,true);
  }
  channel(id:string) { const channel=this.store.get<Channel>('channels',id);if(!channel)throw new APIError(404,'频道不存在');if(channel.runtime!=='codex')throw new APIError(409,'此频道不使用 Codex');const project=this.store.get<Project>('projects',channel.projectId)!;if(project.isDemo)throw new APIError(409,'示例项目没有原生会话');return {channel,project}; }
  get backgroundReady(){return !!this.transport.backgroundReady;}
  binding(id:string) { return this.store.get<Binding>('native_bindings',id); }
  bound(id:string) { const binding=this.binding(id);if(!binding)throw new APIError(409,'请先绑定 Codex App 中同一项目的任务');return binding; }
  async status():Promise<NativeConnectionStatus> {
    let connectionError='';try{await this.transport.connect();}catch(error){connectionError=errorText(error);}
    const value=this.transport.status(),connected=value.connected&&!connectionError;
    const backgroundReady=connected&&!!this.transport.backgroundReady;
    const backgroundConfigured=this.store.get<any>('migrations','codex-background-bridge')?.enabled===true;
    const detail=connectionError||(!connected?value.lastError||'请启动 Codex App 后重新连接。':backgroundReady?'已连接 Codex App 的同一原生后台，可直接新建和恢复对话。':backgroundConfigured?'后台桥接已配置，等待 Codex App 重新打开一次。':'已连接 Codex App 已加载的任务；后台连接尚未设置。');
    return {available:connected,connected,backgroundReady,backgroundConfigured,detail,capabilities:{list:connected,read:connected,send:connected,create:backgroundReady&&!!this.transport.createThread,interrupt:connected,respond:connected}};
  }
  configureBackground() { const result=configureCodexBridge(this.engine.home);this.store.transaction(()=>{this.store.put('migrations',{id:'codex-background-bridge',enabled:true,configuredAt:now(),launcher:result.launcher});this.engine.audit({projectId:'',actor:'human',action:'native.background-configured',text:'已配置 Codex App 原生后台桥接，等待 App 下次启动生效。',after:{launcher:result.launcher}});});return result; }
  restoreBackground() { const result=restoreCodexBridge(this.engine.home);this.store.transaction(()=>{this.store.put('migrations',{id:'codex-background-bridge',enabled:false,restoredAt:now()});this.engine.audit({projectId:'',actor:'human',action:'native.background-restored',text:'已恢复 Codex App 原始启动设置，当前会话未中断。'});});return result; }
  async start() {
    for(const entry of this.store.all<Outbox>('native_outbox').filter(entry=>entry.state==='pending'))this.store.put('native_outbox',{...entry,state:'unknown',error:'服务重新连接，正在核对原生任务；不会自动重发。'});
    for(const run of this.store.all<Run>('runs').filter(run=>run.status==='running'&&run.executionOwner==='codex-app'&&run.source==='nohuman-schedule'))this.scheduled.set(run.channelId,{run,revisions:new Map(Object.entries(run.nativeItemRevisions || {})),runDir:join(this.engine.home,'runs',run.id)});
    for(const binding of this.store.all<Binding>('native_bindings')) {try{this.recoverCheckpoint(binding.threadId);}catch(error){this.recordError(binding.threadId,error);}void this.attach(binding.threadId).catch(error=>this.recordError(binding.threadId,error));}
  }
  recordError(threadId:string,error:unknown) { if(this.closed)return;for(const binding of this.store.all<Binding>('native_bindings').filter(row=>row.threadId===threadId))this.store.put('native_bindings',{...binding,syncError:errorText(error)}); }
  async attach(threadId:string) {
    if(this.subscriptions.has(threadId))return;
    if(this.attaching.has(threadId))return this.attaching.get(threadId)!;
    const pending=(async()=>{await this.transport.connect();const stop=this.transport.subscribeChanges?await this.transport.subscribeChanges(threadId,(snapshot,change)=>{if(!this.closed)try{this.queueSnapshot(snapshot,change);}catch(error){this.recordError(threadId,error);}}):await this.transport.subscribe(threadId,snapshot=>{if(!this.closed)try{this.ingest(snapshot);}catch(error){this.recordError(threadId,error);}});if(this.closed)stop();else this.subscriptions.set(threadId,stop);this.ingest(this.transport.loadCompleteHistory ? await this.transport.loadCompleteHistory(threadId) : await this.transport.readThread(threadId));})();
    this.attaching.set(threadId,pending);try{await pending;}finally{this.attaching.delete(threadId);}
  }
  async sync(threadId:string) { await this.attach(threadId);this.flushPending(threadId);const cached=this.threadCache.get(threadId);if(cached&&this.transport.threadStatus?.(threadId).ready)return cached;const snapshot=await this.transport.readThread(threadId);this.ingest(snapshot);return snapshot; }
  ingest(snapshot:NativeSnapshot,forceCheckpoint=false) {
    if(this.closed || !this.store.all<Binding>('native_bindings').some(binding=>binding.threadId===snapshot.threadId))return;
    const observed=this.observed.get(snapshot.threadId);
    if(observed?.owner===snapshot.ownerClientId&&observed.revision===snapshot.revision&&observed.syncedAt===snapshot.syncedAt){for(const binding of this.store.all<Binding>('native_bindings').filter(row=>row.threadId===snapshot.threadId&&(row.syncError||!row.lastSyncedAt)))this.store.put('native_bindings',{...binding,syncError:'',lastSyncedAt:snapshot.syncedAt});return;}
    const safe=this.safe(snapshot);
    const old=this.cachedThread(safe.threadId);
    if(old && old.ownerClientId===safe.ownerClientId && old.revision>safe.revision)return;
    const hash=stable(safe.threadId,`${safe.ownerClientId}:${safe.revision}`);
    let items=nativeItems(safe,this.projectedItems);const requests=Array.isArray(safe.state.requests) ? safe.state.requests : [];
    const warmItems=this.itemCache.get(safe.threadId);const previousItems=warmItems||new Map(this.store.nativeRows<StoredItem>('native_items',safe.threadId).map(item=>[item.id,item]));
    const complete=safe.state.turnHistory?.history?.isComplete===true || safe.state.turnsPagination?.hasLoadedOldest===true || (!safe.state.turnHistory&&Array.isArray(safe.state.turns));
    if(!complete){const seen=new Set(items.map(item=>item.id));const rawKeys=new Set(nativeTurns(safe.state).flatMap(turn=>(turn.items||[]).map((item:any)=>`${turn.turnId||turn.id}:${item.id}`)));const canonical=nativeTurns(safe.state).flatMap(turn=>turn.items||[]).filter(item=>item?.type==='userMessage');items=[...[...previousItems.values()].filter(item=>item.present&&!seen.has(item.id)&&!rawKeys.has(`${item.turnId}:${item.raw.id}`)&&!(item.type==='steeringUserMessage'&&canonical.some(raw=>isCanonicalSteer(item.raw,raw)))).sort((a,b)=>a.ordinal-b.ordinal),...items].map((item,ordinal)=>item.ordinal===ordinal?item:{...item,ordinal});}
    const changedItems=items.filter(item=>previousItems.get(item.id)!==item&&(warmItems||JSON.stringify(previousItems.get(item.id))!==JSON.stringify(item)));
    const itemIds=new Set(items.map(item=>item.id));const removedItemIds=[...previousItems.values()].filter(item=>item.present&&!itemIds.has(item.id)).map(item=>item.id);
    const metadata:Record<string,unknown>={};for(const [key,value] of Object.entries(safe.state))if(!['turns','turnHistory'].includes(key)&&old?.state[key]!==value)metadata[key]=value;
    const priorTurns=new Map(nativeTurns(old?.state||{}).map(turn=>[String(turn.turnId||turn.id),turn]));
    const turns=nativeTurns(safe.state).filter(turn=>priorTurns.get(String(turn.turnId||turn.id))!==turn).map(({items,...turn}:any)=>turn);
    const journaled=this.journaled.get(safe.threadId);const hasRawJournal=journaled?.owner===safe.ownerClientId&&journaled.revision>=safe.revision;
    const checkpoint=forceCheckpoint||!old||old.ownerClientId!==safe.ownerClientId||Date.now()-(this.checkpointAt.get(safe.threadId)||0)>=5000||(!activeTurn(safe.state)&&!!activeTurn(old.state));
    const nextThread={...safe,id:safe.threadId,summary:summary(safe),hash,projectionVersion:PROJECTION_VERSION};
    this.store.transaction(()=>{
      if(checkpoint)this.store.put('native_threads',nextThread);
      if(old?.hash!==hash || old?.projectionVersion!==PROJECTION_VERSION) {
        if(!hasRawJournal)this.store.put('native_events',{id:randomUUID(),threadId:safe.threadId,revision:safe.revision,ownerClientId:safe.ownerClientId,createdAt:now(),changedItems,removedItemIds,turns,metadata});
        for(const id of removedItemIds)this.store.put('native_items',{...previousItems.get(id)!,present:false});
        for(const item of changedItems)this.store.put('native_items',item);
        this.store.db.prepare("UPDATE native_requests SET data=json_set(data,'$.status','resolved') WHERE json_extract(data,'$.threadId')=?").run(safe.threadId);
        for(const raw of requests)if(raw?.id!==undefined && typeof raw.method==='string')this.store.put('native_requests',{id:stable(safe.threadId,`request:${raw.id}`),nativeId:String(raw.id),threadId:safe.threadId,type:requestKind(raw.method),turnId:raw.params?.turnId,status:'pending',title:raw.method,raw});
      }
      for(const binding of this.store.all<Binding>('native_bindings').filter(row=>row.threadId===safe.threadId))this.store.put('native_bindings',{...binding,lastSyncedAt:safe.syncedAt,syncError:''});
      for(const entry of this.store.nativeRows<Outbox>('native_outbox',safe.threadId).filter(row=>['pending','unknown'].includes(row.state))) {
        const turn=nativeTurns(safe.state).find(turn=>turn.params?.clientUserMessageId===entry.requestId || turn.items?.some((item:any)=>itemMatchesRequest(item,entry.requestId)&&(item.type!=='steeringUserMessage'||item.status==='accepted'||item.serverUserMessageId)));
        if(turn)this.store.put('native_outbox',{...entry,state:'accepted',...(turn.turnId ? {turnId:turn.turnId} : {}),error:''});
      }
    });
    this.threadCache.set(safe.threadId,nextThread);this.itemCache.set(safe.threadId,new Map([...previousItems.values()].map(item=>[item.id,item])));const cachedItems=this.itemCache.get(safe.threadId)!;for(const id of removedItemIds)cachedItems.set(id,{...previousItems.get(id)!,present:false});for(const item of items)cachedItems.set(item.id,item);
    if(checkpoint){this.dirtyThreads.delete(safe.threadId);this.checkpointAt.set(safe.threadId,Date.now());}else this.dirtyThreads.add(safe.threadId);
    this.observed.set(snapshot.threadId,{owner:snapshot.ownerClientId,revision:snapshot.revision,syncedAt:snapshot.syncedAt});
    this.recordNativeRuns(safe,checkpoint);
    for(const entry of this.store.nativeRows<Outbox>('native_outbox',safe.threadId))if(entry.state==='accepted'&&entry.source==='chat'&&!(entry as any).guidanceHandled)this.receipt(entry);
    const channelBinding=this.store.all<Binding>('native_bindings').find(binding=>binding.threadId===safe.threadId);
    if(channelBinding){
      const work=this.store.get<Channel>('channels',channelBinding.id)?.work;
      if(work?.awaitingReply){const ask=this.store.get<Run>('runs',work.runId),turns=nativeTurns(safe.state),index=turns.findIndex(turn=>turn.turnId===ask?.nativeTurnId);if(index>=0&&turns.slice(index+1).some(turn=>turn.items?.some(isUserItem)))this.engine.acceptNativeGuidance(channelBinding.id);}
    }
    this.finishScheduled(safe);
  }
  async list(id:string) { const {project}=this.channel(id);const status=await this.status();if(!status.connected)return {status,threads:[]};const threads=(await this.transport.listThreads(project.path)).filter(thread=>sameFolder(thread.cwd,project.path)).map(thread=>({id:thread.id,title:thread.title,cwd:thread.cwd,status:'idle',...(thread.model?{model:thread.model}:{}),...(thread.updatedAt?{updatedAt:typeof thread.updatedAt==='number'?new Date(thread.updatedAt<1e12?thread.updatedAt*1000:thread.updatedAt).toISOString():thread.updatedAt}:{})}));return {status,threads}; }
  canRecreateEmpty(binding:Binding):boolean {
    if(!binding.createdByNoHuman||!this.transport.backgroundReady||!/no rollout found|missing source rollout/i.test(binding.syncError||''))return false;
    this.flushPending(binding.threadId);
    const stored=this.cachedThread(binding.threadId);
    return !!stored&&!nativeTurns(stored.state).length&&!stored.state.requests?.length&&
      !this.store.nativeRows('native_outbox',binding.threadId).length&&!this.store.nativeRows('native_items',binding.threadId).length&&!this.store.nativeRows('native_turns',binding.threadId).length;
  }
  async create(id:string):Promise<NativeConversation> {
    if(this.creating.has(id))return this.creating.get(id)!;
    const operation=(async()=>{
      const {channel,project}=this.channel(id);
      const previous=this.binding(id);
      if(previous){await this.conversation(id,{});if(!this.canRecreateEmpty(this.bound(id)))return this.conversation(id,{});}
      if(this.engine.active.has(id)||this.starting.has(id)||this.engine.control(id).enabled)throw new APIError(409,'请先暂停频道并等待本轮完成');
      const status=await this.status();if(!status.capabilities.create||!this.transport.createThread)throw new APIError(409,'完成一次 Codex 后台连接设置后，即可在 NoHuman 新建对话。');
      this.engine.audit({projectId:project.id,channelId:id,actor:'human',action:'native.creation-requested',text:'请求 Codex App 后台创建原生任务。'});
      let snapshot:NativeSnapshot;
      try{snapshot=await this.transport.createThread(project.path);}catch(error){this.engine.audit({projectId:project.id,channelId:id,actor:'system',action:'native.creation-failed',text:this.engine.redact(errorText(error))});throw error;}
      if(!sameFolder(summary(snapshot).cwd,project.path))throw new APIError(409,'原生任务目录与项目不一致');
      const binding={id,projectId:project.id,threadId:snapshot.threadId,cwd:project.path,createdAt:now(),createdByNoHuman:true};
      this.store.transaction(()=>{this.store.put('native_bindings',binding);this.store.put('channels',{...channel,sessionId:snapshot.threadId});this.engine.audit({projectId:project.id,channelId:id,actor:'human',action:previous?'native.empty-recreated':'native.created',text:previous?'原生后台未保留尚未发送消息的空白任务，已按用户请求重新创建。':'已在 Codex App 共享后台创建原生任务。',...(previous?{before:previous}:{}),after:binding});});
      if(previous){this.subscriptions.get(previous.threadId)?.();this.subscriptions.delete(previous.threadId);}
      this.ingest(snapshot);await this.attach(snapshot.threadId);return this.conversation(id,{});
    })();this.creating.set(id,operation);try{return await operation;}finally{this.creating.delete(id);}
  }
  async bind(id:string,threadId:string) {
    const {channel,project}=this.channel(id);
    if(this.engine.active.has(id)||this.starting.has(id)||this.scheduled.has(id)||this.engine.control(id).enabled)throw new APIError(409,'请先暂停频道并等待本轮完成，再绑定原生任务');
    if(this.store.all<Binding>('native_bindings').some(row=>row.threadId===threadId&&row.id!==id))throw new APIError(409,'该原生任务已经绑定到另一个频道');
    const listed=await this.transport.listThreads(project.path);const thread=listed.find(row=>row.id===threadId && sameFolder(row.cwd,project.path));if(!thread)throw new APIError(404,'原生任务不属于此项目目录或不存在');
    let snapshot:NativeSnapshot|undefined;let syncError='';try{snapshot=await this.transport.readThread(threadId);}catch(error){syncError=errorText(error);}const cwd=snapshot?summary(snapshot).cwd:'';if(cwd && realpathSync(cwd)!==realpathSync(project.path))throw new APIError(409,'原生任务目录与项目不一致');
    const before=this.binding(id);const binding={id,projectId:project.id,threadId,cwd:project.path,createdAt:now()};
    if(before?.threadId!==threadId && before && this.store.get<StoredThread>('native_threads',before.threadId)?.summary.status==='running')throw new APIError(409,'原生任务仍在执行，请等待它完成后再切换绑定');
    this.store.transaction(()=>{this.store.put('native_bindings',binding);this.store.put('channels',{...channel,sessionId:threadId});this.engine.audit({projectId:project.id,channelId:id,actor:'human',action:'native.bound',text:'已绑定 Codex App 原生任务。',before,after:binding});});
    if(before&&before.threadId!==threadId&&!this.store.all<Binding>('native_bindings').some(row=>row.threadId===before.threadId)){this.subscriptions.get(before.threadId)?.();this.subscriptions.delete(before.threadId);}
    if(snapshot)this.ingest(snapshot);if(syncError)this.recordError(threadId,syncError);else try{await this.attach(threadId);}catch(error){this.recordError(threadId,error);}return this.conversation(id,{});
  }
  async conversation(id:string,query:{before?:string;limit?:number}):Promise<NativeConversation> {
    this.channel(id);const status=await this.status();const binding=this.binding(id);
    if(!binding)return {channelId:id,status,items:[],requests:[],hasMore:false};
    if(status.connected)try{await this.sync(binding.threadId);}catch(error){this.recordError(binding.threadId,error);}
    const latest=this.bound(id);const stored=this.cachedThread(binding.threadId);
    let cachedItems=this.itemCache.get(binding.threadId);if(!cachedItems){cachedItems=new Map(this.store.nativeRows<StoredItem>('native_items',binding.threadId).map(item=>[item.id,item]));this.itemCache.set(binding.threadId,cachedItems);}
    const all=[...cachedItems.values()].filter(item=>item.present).sort((a,b)=>a.ordinal-b.ordinal);
    const index=query.before ? all.findIndex(item=>item.id===query.before) : all.length;
    if(index<0)throw new APIError(404,'消息游标不属于此原生任务');
    const scheduledTurns=new Set(this.store.nativeRows<Outbox>('native_outbox',binding.threadId).filter(entry=>entry.source==='schedule').map(entry=>entry.turnId));
    const limit=query.limit||80;const page=all.slice(Math.max(0,index-limit),index).map(({threadId,ordinal,present,...item})=>({...item,...(item.role==='user'&&scheduledTurns.has(item.turnId)&&this.store.nativeRows<Outbox>('native_outbox',binding.threadId).some(entry=>entry.source==='schedule'&&entry.turnId===item.turnId&&(itemMatchesRequest(item.raw,entry.requestId)||item.text===entry.text))?{autonomousContext:true}:{})}));
    const requests=this.store.all<any>('native_requests').filter(row=>row.threadId===binding.threadId&&row.status==='pending').map(({nativeId,threadId,...row})=>({...row,id:nativeId}));
    const readiness=this.transport.threadStatus?.(binding.threadId);const syncError=latest.syncError || (readiness&&!readiness.ready?readiness.detail:!stored?'尚未取得原生任务快照':'');
    const threadStatus=syncError?{...status,connected:false,detail:syncError,capabilities:{...status.capabilities,read:false,send:false,interrupt:false,respond:false}}:status;
    return {channelId:id,threadId:binding.threadId,status:threadStatus,canRecreateEmpty:this.canRecreateEmpty(latest),...(stored ? {thread:{...stored.summary,cwd:stored.summary.cwd||binding.cwd}} : {}),items:page,requests,hasMore:index>limit,...(page[0]?{cursor:page[0].id}:{}),lastSyncedAt:latest.lastSyncedAt,...(syncError?{syncError}:{})};
  }
  async send(id:string,text:string,requestId:string,source:'chat'|'schedule'='chat',runId?:string,attachments:Array<{id:string}>=[]):Promise<NativeMessageReceipt> {
    const {project,channel}=this.channel(id);if(!this.binding(id))await this.create(id);const binding=this.bound(id);const key=`${id}:${requestId}`;
    const workOptions:NativeWorkOptions|undefined=source==='schedule'?{approvalPolicy:'on-request',approvalsReviewer:'auto_review',...(channel.permission==='native'?{}:{sandboxPolicy:channel.permission==='read-only'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:[project.path],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}})}:undefined;
    const images=resolveNativeAttachments(this.store,id,attachments);const attachmentIds=attachments.map(item=>item.id);const textHash=createHash('sha256').update(text).digest('hex');
    const old=this.store.get<Outbox>('native_outbox',key);if(old){if((old.textHash?old.textHash!==textHash:old.text!==text)||old.threadId!==binding.threadId||JSON.stringify(old.attachmentIds||[])!==JSON.stringify(attachmentIds))throw new APIError(409,'同一请求 ID 已用于其他消息');return this.receipt(old);}
    if(this.sending.has(key))return this.sending.get(key)!;
    const operation=(async()=>{
      await this.sync(binding.threadId);
      const entry:Outbox={id:key,requestId,channelId:id,projectId:project.id,threadId:binding.threadId,text:this.engine.redact(text),textHash,attachmentIds,state:'pending',source,createdAt:now(),...(runId?{runId}:{})};
      this.store.transaction(()=>{this.store.put('native_outbox',entry);this.engine.audit({projectId:project.id,channelId:id,runId,actor:source==='chat'?'human':'system',action:'native.message-submitted',text:source==='chat'?'向 Codex App 原生任务发送消息。':'向 Codex App 原生任务提交持续职责轮次。',after:{requestId,threadId:binding.threadId}});});
      try {const response=await this.transport.sendMessage(binding.threadId,text,requestId,images,workOptions) as any;const turnId=response?.turn?.id || response?.turnId;const result={...entry,...this.store.get<Outbox>('native_outbox',key),state:'accepted' as const,...(typeof turnId==='string'?{turnId}:{}),response:JSON.parse(this.engine.redact(JSON.stringify(response??null)))};this.store.put('native_outbox',result);try{await this.sync(binding.threadId);}catch(error){this.recordError(binding.threadId,error);}return this.receipt(this.store.get<Outbox>('native_outbox',key)!);}
      catch(error){const current=this.store.get<Outbox>('native_outbox',key)!;if(current.state==='accepted')return this.receipt(current);const definitive=(error as any)?.outcomeUnknown===false;const result={...entry,state:definitive?'failed' as const:'unknown' as const,error:definitive?errorText(error):`发送结果尚未确认：${errorText(error)}。不会自动重发，请核对原生任务。`};this.store.put('native_outbox',result);return this.receipt(result);}
    })();this.sending.set(key,operation);try{return await operation;}finally{this.sending.delete(key);}
  }
  receipt(entry:Outbox):NativeMessageReceipt { if(entry.state==='accepted'&&entry.source==='chat'&&!(entry as any).guidanceHandled){this.engine.acceptNativeGuidance(entry.channelId);this.store.put('native_outbox',{...entry,guidanceHandled:true});}return {requestId:entry.requestId,state:entry.state,...(entry.turnId?{turnId:entry.turnId}:{}),...(entry.error?{error:entry.error}:{})}; }
  recordNativeRuns(snapshot:NativeSnapshot,checkpoint=false) {
    const binding=this.store.all<Binding>('native_bindings').find(row=>row.threadId===snapshot.threadId);if(!binding)return;
    const outbox=this.store.nativeRows<Outbox>('native_outbox',snapshot.threadId);
    for(const turn of nativeTurns(snapshot.state)) {
      const turnId=turn.turnId || turn.id;if(typeof turnId!=='string'||!turnId)continue;
      const key=stable(snapshot.threadId,`turn:${turnId}`);const cached=this.turnCache.get(key);if(cached&&cached.raw===turn){if(checkpoint&&this.dirtyTurns.has(key)){this.store.put('native_turns',cached.row);this.dirtyTurns.delete(key);}continue;}
      const previous=cached?.row||this.store.get<any>('native_turns',key);const ended=!['inProgress','running'].includes(turn.status);
      const rawHash=ended?createHash('sha256').update(JSON.stringify(turn)).digest('hex'):stable(key,`${snapshot.ownerClientId}:${snapshot.revision}`);
      if(previous?.hash===rawHash&&previous.projectionVersion===PROJECTION_VERSION){this.turnCache.set(key,{raw:turn,row:previous});continue;}
      const request=outbox.find(row=>row.turnId===turnId || turn.params?.clientUserMessageId===row.requestId || turn.items?.some((item:any)=>itemMatchesRequest(item,row.requestId)));
      const runId=request?.runId || previous?.runId || `${key.slice(0,8)}-${key.slice(8,12)}-${key.slice(12,16)}-${key.slice(16,20)}-${key.slice(20,32)}`;
      const existing=this.store.get<Run>('runs',runId);
      const ownerScheduled=existing?.source==='nohuman-schedule';
      const startedAt=typeof turn.turnStartedAtMs==='number'&&Number.isFinite(turn.turnStartedAtMs)?new Date(turn.turnStartedAtMs).toISOString():existing?.startedAt||'';
      const finishedAt=ended&&typeof turn.turnStartedAtMs==='number'&&typeof turn.durationMs==='number'?new Date(turn.turnStartedAtMs+turn.durationMs).toISOString():existing?.finishedAt||'';
      const final=finalText(turn);const promptItemIds:string[]=[...(previous?.promptItemIds || [])];
      const row={id:key,threadId:snapshot.threadId,nativeTurnId:turnId,channelId:binding.id,projectId:binding.projectId,runId,hash:rawHash,projectionVersion:PROJECTION_VERSION,raw:turn,promptItemIds,firstObservedAt:previous?.firstObservedAt||now(),updatedAt:now(),...(ended?{finalHash:rawHash}:{})};
      this.store.transaction(()=>{
        if(!ownerScheduled) {
          const run:Run={id:runId,projectId:binding.projectId,channelId:binding.id,runtime:'codex',model:snapshot.state.latestThreadSettings?.model||snapshot.state.latestModel||'',permission:'native',executionOwner:'codex-app',source:request?'nohuman-chat':'native-app',trigger:'manual',resumedFromSessionId:snapshot.threadId,nativeTurnId:turnId,reportStatus:'missing',reportError:'此轮是原生对话，未作为持续职责报告自动更新看板。',status:ended?(turn.status==='completed'?'completed':turn.status==='interrupted'?'interrupted':'failed'):'running',startedAt,finishedAt,summary:(final || (ended?turn.error?.message || '原生轮次已结束':'原生任务正在执行。')).slice(0,20000),sessionId:snapshot.threadId};
          this.store.put('runs',run);
          for(const [index,item] of (turn.items||[]).entries())if(isUserItem(item)) {const aliases=[item.serverUserMessageId,item.id,item.clientId,item.clientUserMessageId,item.restoreMessage?.id].filter(value=>typeof value==='string');if(!aliases.length)aliases.push(String(index));if(aliases.some(value=>promptItemIds.includes(value))){for(const alias of aliases)if(!promptItemIds.includes(alias))promptItemIds.push(alias);continue;}const text=userText(item);if(text)this.store.io(runId,'prompt',this.engine.redact(text));promptItemIds.push(...aliases);}
          if(ended&&previous?.finalHash!==rawHash){this.store.io(runId,'stdout',JSON.stringify(turn));if(final)this.store.io(runId,'final',final);}
        }
        if(checkpoint||ended||!previous)this.store.put('native_turns',row);
      });
      this.turnCache.set(key,{raw:turn,row});if(checkpoint||ended||!previous)this.dirtyTurns.delete(key);else this.dirtyTurns.add(key);
    }
  }
  async interrupt(id:string,turnId:string) { this.channel(id);const binding=this.bound(id);const snapshot=await this.sync(binding.threadId);if(activeTurn(snapshot.state)?.turnId!==turnId)throw new APIError(409,'该原生轮次已结束或不是当前轮次');const result=await this.transport.interrupt(binding.threadId,turnId);this.engine.audit({projectId:binding.projectId,channelId:id,actor:'human',action:'native.interrupt',text:'已向原生任务请求停止当前轮次。',after:{threadId:binding.threadId,turnId}});return result; }
  async respond(id:string,requestId:string,response:unknown) { this.channel(id);const binding=this.bound(id);await this.sync(binding.threadId);const request=this.store.get<any>('native_requests',stable(binding.threadId,`request:${requestId}`));if(!request || request.status!=='pending')throw new APIError(409,'原生请求已经处理或已失效');if(request.type==='unsupported')throw new APIError(409,'请在 Codex App 中处理此类原生请求');const result=await this.transport.respond(binding.threadId,request.raw.id,request.type,response);this.store.put('native_requests',{...request,status:'responded',response});this.engine.audit({projectId:binding.projectId,channelId:id,actor:'human',action:'native.responded',text:'已向原生任务提交审批或问题答复。',after:{requestId,type:request.type,response}});return result; }
  async startScheduled(id:string,scheduled:boolean) {
    const {channel,project}=this.channel(id);const binding=this.bound(id);if(this.starting.has(id)||this.scheduled.has(id))throw new APIError(409,'该频道正在执行原生轮次');this.starting.add(id);
    try {
      const snapshot=await this.sync(binding.threadId);
      if(activeTurn(snapshot.state)||snapshot.state.threadRuntimeStatus?.type==='active') {if(scheduled){this.store.put('channels',{...channel,status:'waiting',nextRunAt:new Date(Date.now()+5000).toISOString()});return;}throw new APIError(409,'Codex App 正在执行此任务，请等待当前轮次完成');}
      // Native interactive settings remain authoritative. A scheduler may only
      // inherit settings whose sandbox we can verify against its saved scope.
      const sandbox=snapshot.state.currentPermissions?.sandboxPolicy?.type || snapshot.state.latestThreadSettings?.sandboxPolicy?.type || snapshot.state.sandboxPolicy?.type;
      const allowed=channel.permission==='native'?['readOnly','read-only','workspaceWrite','workspace-write','dangerFullAccess','danger-full-access','externalSandbox','external-sandbox']:channel.permission==='read-only' ? ['readOnly','read-only'] : ['readOnly','read-only','workspaceWrite','workspace-write'];
      if(!allowed.includes(sandbox))throw new APIError(409,'原生任务权限尚无法确认符合频道的自动执行范围；请在 Codex App 中设置只读或工作区权限后重试。普通对话可直接继续。');
      const run:Run={id:randomUUID(),projectId:project.id,channelId:id,runtime:'codex',model:snapshot.state.model || snapshot.state.latestThreadSettings?.model || '',permission:'native',executionOwner:'codex-app',source:'nohuman-schedule',trigger:scheduled?'schedule':'manual',resumedFromSessionId:binding.threadId,workDirection:channel.goal,reportStatus:'pending',reportError:'',status:'running',startedAt:now(),finishedAt:'',summary:'',sessionId:binding.threadId,nativeItemRevisions:Object.fromEntries(this.store.projectItems(project.id).map(item=>[item.id,item.revision]))};
      const runDir=join(this.engine.home,'runs',run.id);mkdirSync(runDir,{recursive:true,mode:0o700});const prompt=this.engine.prompt(project,channel,run);this.store.put('runs',run);this.engine.persistIO(run.id,'prompt',prompt);this.scheduled.set(id,{run,revisions:new Map(this.store.projectItems(project.id).map(item=>[item.id,item.revision])),runDir});this.store.put('channels',{...channel,status:'running',lastRunAt:run.startedAt,nextRunAt:''});
      const receipt=await this.send(id,prompt,randomUUID(),'schedule',run.id);const active=this.scheduled.get(id);if(active){active.run.nativeTurnId=receipt.turnId;this.store.put('runs',active.run);if(receipt.state==='failed'){this.engine.finishFailure(active.run,'failed',receipt.error||'原生 App 拒绝了本轮请求');this.scheduled.delete(id);}else if(receipt.state!=='accepted'){this.engine.setControl(id,{enabled:false});this.store.put('channels',{...this.store.get<Channel>('channels',id)!,status:'blocked',nextRunAt:''});this.engine.event(id,run.id,'system',receipt.error||'原生发送结果待确认；已停止自动调度，避免重复执行。');}}
      const stored=this.cachedThread(binding.threadId);if(stored)this.finishScheduled(stored);
    }finally{this.starting.delete(id);}
  }
  finishScheduled(snapshot:NativeSnapshot) {
    for(const [id,active] of this.scheduled) {
      if(active.run.sessionId!==snapshot.threadId)continue;
      const receipt=this.store.all<Outbox>('native_outbox').find(row=>row.runId===active.run.id);
      const turn=nativeTurns(snapshot.state).find(turn=>(active.run.nativeTurnId && turn.turnId===active.run.nativeTurnId)||(receipt && turn.params?.clientUserMessageId===receipt.requestId));
      if(!turn)continue;active.run.nativeTurnId=turn.turnId;this.store.put('runs',active.run);if(['inProgress','running'].includes(turn.status))continue;
      const final=finalText(turn);
      this.engine.persistIO(active.run.id,'stdout',JSON.stringify(turn));this.engine.persistIO(active.run.id,'final',final);
      const wasEnabled=this.engine.control(id).enabled;
      if(turn.status==='completed') {const report=extractReport(undefined,final);active.run.reportStatus=report.status;active.run.reportError=report.error;try{if(report.result)this.engine.finishSuccess(active.run,this.store.get<Channel>('channels',id)!,report.result,active.runDir,active.revisions);else this.engine.finishWithoutReport(active.run,final);}catch(error){active.run.reportStatus='invalid';active.run.reportError=errorText(error);this.engine.finishWithoutReport(active.run,final);}}
      else this.engine.finishFailure(active.run,turn.status==='interrupted'?'interrupted':'failed',turn.error?.message||`原生轮次结束：${turn.status}`);
      if(turn.status==='completed')this.engine.completeAutonomousWork(active.run,final,wasEnabled);
      this.scheduled.delete(id);
    }
  }
  isBusy(id:string) { return this.starting.has(id)||this.scheduled.has(id); }
  isProjectBusy(projectId:string,exceptId?:string) { return this.store.all<Binding>('native_bindings').filter(binding=>binding.projectId===projectId&&binding.id!==exceptId).some(binding=>this.isBusy(binding.id)||this.cachedThread(binding.threadId)?.summary.status==='running'); }
  async pause(id:string) { const active=this.scheduled.get(id);if(active?.run.nativeTurnId)await this.interrupt(id,active.run.nativeTurnId); }
  close() {this.flushPending();for(const threadId of this.threadCache.keys())this.checkpoint(threadId);this.closed=true;for(const stop of this.subscriptions.values())stop();this.subscriptions.clear();this.transport.close(); }
}
