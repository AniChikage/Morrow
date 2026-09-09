import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Store } from '../service/store.ts';
import { NativeConversations } from '../service/native-conversations.ts';
import type { Engine } from '../service/engine.ts';
import { WebSocketServer } from 'ws';
import { CodexSharedTransport } from '../service/codex-shared-transport.ts';
import { sharedRuntimeArgs } from '../service/codex-app-host-bridge.ts';

const id='shared-thread-fixture',turnId='shared-turn-fixture';
const until=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(done=>setTimeout(done,10));}assert.fail('native update timed out');};
async function fixture(options:{loseSend?:boolean; rejectSend?:boolean; bufferedDelta?:boolean; codexHome?:string; loadedThreads?:string[]}={}){
  const dir=mkdtempSync('/tmp/morrow-shared-');chmodSync(dir,0o700);const path=join(dir,'host.sock');
  const codexHome=options.codexHome||dir;
  const server=createServer();const wss=new WebSocketServer({server});let peer:any;const messages:any[]=[];
  const oldTurn={id:turnId,status:'completed',itemsView:'full',items:[{id:'old-reply',type:'agentMessage',text:'original'}]};
  wss.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
    const message=JSON.parse(raw.toString());messages.push(message);if(message.id==null)return;
    const respond=(result:any)=>socket.send(JSON.stringify({id:message.id,result}));
    const event=(method:string,params:any)=>socket.send(JSON.stringify({method,params}));
    switch(message.method){
      case 'initialize':return respond({codexHome,userAgent:'fixture/1'});
      case 'thread/loaded/list':return respond({data:options.loadedThreads||[id],nextCursor:null});
      case 'thread/start':return respond({thread:{id,status:{type:'idle'}},cwd:dir,model:'native-fixture',approvalPolicy:'never',sandbox:{type:'readOnly'}});
      case 'thread/resume':return respond({thread:{id,name:'Native task',status:{type:'idle'}},cwd:dir,model:'native-fixture',approvalPolicy:'never',sandbox:{type:'readOnly'}});
      case 'thread/turns/list':
        if(options.bufferedDelta)event('item/agentMessage/delta',{threadId:id,turnId,itemId:'old-reply',delta:' before'});
        respond({data:[{...oldTurn,items:[{...oldTurn.items[0],text:options.bufferedDelta?'original before':'original'}]}],nextCursor:null});
        if(options.bufferedDelta)event('item/agentMessage/delta',{threadId:id,turnId,itemId:'old-reply',delta:' after'});return;
      case 'turn/start':
        if(options.loseSend){socket.terminate();return;}
        if(options.rejectSend){socket.send(JSON.stringify({id:message.id,error:{code:-32602,message:'rejected'}}));return;}
        event('turn/started',{threadId:id,turn:{id:'new-turn',status:'inProgress',items:[]}});return respond({turn:{id:'new-turn',status:'inProgress'}});
      case 'turn/steer':return respond({turnId:'new-turn'});
      case 'turn/interrupt':return respond({});
    }
  });});await new Promise<void>(done=>server.listen(path,done));chmodSync(path,0o600);
  const client=new CodexSharedTransport({host:{version:1,launchId:'fixture-launch',bridgePid:process.pid,appPid:process.pid,runtimePid:process.pid,codexHome,executable:'/fixture/codex',socketPath:path,startedAt:new Date().toISOString()},timeoutMs:1000});
  return {dir,client,messages,event:(method:string,params:any,requestId?:number)=>peer.send(JSON.stringify({method,params,...(requestId?{id:requestId}:{})})),close:async()=>{client.close();for(const socket of wss.clients)socket.terminate();await new Promise<void>(done=>wss.close(()=>done()));await new Promise<void>(done=>server.close(()=>done()));rmSync(dir,{recursive:true,force:true});}};
}

test('App host bridge preserves native model, plugin, and permission overrides',()=>{
  const args=['app-server','--listen','stdio://','-c','mcp_servers.codex_app={enabled=true}','-c','model="native-model"','--analytics-default-enabled'];
  assert.deepEqual(sharedRuntimeArgs(args,'/private/socket'),['app-server','-c','mcp_servers.codex_app={enabled=true}','-c','model="native-model"','--analytics-default-enabled','--listen','unix:///private/socket']);
  assert.equal(sharedRuntimeArgs(['exec','user prompt'],'/socket'),null);
  assert.equal(sharedRuntimeArgs(['app-server','proxy'],'/socket'),null);
  assert.equal(sharedRuntimeArgs(['app-server','--listen','ws://other'],'/socket'),null);
  const global=['-c','features.code_mode_host=true','--config','model="native-model"'];
  assert.deepEqual(sharedRuntimeArgs([...global,...args],'/socket'),[...global,'app-server','-c','mcp_servers.codex_app={enabled=true}','-c','model="native-model"','--analytics-default-enabled','--listen','unix:///socket']);
  assert.deepEqual(sharedRuntimeArgs(['--config=model="native-model"','app-server','--listen=stdio://'],'/socket'),['--config=model="native-model"','app-server','--listen','unix:///socket']);
  for(const invalid of [['-c','app-server'],['-c','name=app-server','exec','hello'],['--unknown','app-server'],[...global,'app-server','proxy'],[...global,'app-server','--listen','ws://other']])assert.equal(sharedRuntimeArgs(invalid,'/socket'),null);
});
test('multiple backends are resolved by loaded bound tasks and a persisted native launch, without resuming candidates',async()=>{
  const directory=mkdtempSync('/tmp/morrow-hosts-');chmodSync(directory,0o700);
  const owner=await fixture({codexHome:directory}),other=await fixture({codexHome:directory,loadedThreads:[]});
  let pin:string|undefined;let client:CodexSharedTransport|undefined;
  try{
    const hosts=[{...owner.client.options.host!,launchId:'original'},{...other.client.options.host!,launchId:'tool-runtime'}];
    hosts.forEach((host,index)=>writeFileSync(join(directory,`host-${index+1}.json`),JSON.stringify(host),{mode:0o600}));
    client=new CodexSharedTransport({directory,codexHome:directory,preferredThreadIds:()=>[id],onConnected:host=>pin=host.launchId});await client.connect();assert.equal(client.host?.launchId,'original');assert.equal(pin,'original');assert.equal([...owner.messages,...other.messages].some(message=>message.method==='thread/resume'),false);client.close();
    client=new CodexSharedTransport({directory,codexHome:directory,preferredLaunchId:()=>pin});await client.connect();assert.equal(client.host?.launchId,'original');client.close();
    client=new CodexSharedTransport({directory,codexHome:directory,preferredThreadIds:()=>['unloaded']});await assert.rejects(()=>client!.connect(),(error:any)=>error.code==='ambiguous_host');assert.equal([...owner.messages,...other.messages].some(message=>message.method==='thread/resume'),false);
  }finally{client?.close();await owner.close();await other.close();rmSync(directory,{recursive:true,force:true});}
});
test('cold task resumes without a desktop owner and retains native turn ids and streamed output',async()=>{
  const f=await fixture();try{
    const snapshots:any[]=[];await f.client.subscribeChanges(id,snapshot=>snapshots.push(snapshot));assert.equal(f.client.threadStatus(id).ready,true);
    const raw='  hello\n native  ';await f.client.sendMessage(id,raw,'stable-input');
    const sent=f.messages.find(message=>message.method==='turn/start');assert.deepEqual(sent.params,{threadId:id,input:[{type:'text',text:raw,text_elements:[]}],clientUserMessageId:'stable-input'});
    await f.client.sendMessage(id,'follow up','stable-steer');assert.equal(f.messages.find(message=>message.method==='turn/steer').params.expectedTurnId,'new-turn');
    f.event('item/started',{threadId:id,turnId:'new-turn',item:{id:'command',type:'commandExecution',status:'inProgress',aggregatedOutput:''}});
    f.event('item/commandExecution/outputDelta',{threadId:id,turnId:'new-turn',itemId:'command',delta:'streamed output'});
    await until(()=>snapshots.at(-1).state.turns.at(-1).items[0]?.aggregatedOutput==='streamed output');
    assert.equal(f.messages.some(message=>message.method==='thread-owner-discovery'),false);
  }finally{await f.close();}
});
test('hydration applies only deltas newer than the fetched history',async()=>{
  const f=await fixture({bufferedDelta:true});try{const snapshot=await f.client.readThread(id);await until(()=>f.client.snapshots.get(id)?.state.turns[0].items[0].text==='original before after');assert.equal(f.client.snapshots.get(id)!.state.turns[0].items[0].text,'original before after');}finally{await f.close();}
});
test('reconnecting to the same host gives reset projection revisions a new epoch while retaining native ids',async()=>{
  const f=await fixture();const reconnect=new CodexSharedTransport(f.client.options);try{
    const first=await f.client.readThread(id);f.client.close();const second=await reconnect.readThread(id);
    assert.notEqual(first.ownerClientId,second.ownerClientId);assert.equal(second.revision,0);assert.equal(first.threadId,second.threadId);assert.equal(first.state.turns[0].turnId,second.state.turns[0].turnId);
  }finally{reconnect.close();await f.close();}
});
test('autonomous turns use native automatic review within their saved workspace and never steer a raced interactive turn',async()=>{
  const f=await fixture();try{
    const options={approvalPolicy:'on-request' as const,approvalsReviewer:'auto_review' as const,sandboxPolicy:{type:'workspaceWrite' as const,writableRoots:[f.dir],networkAccess:false as const,excludeTmpdirEnvVar:true as const,excludeSlashTmp:true as const}};
    await f.client.sendMessage(id,'bounded work','scheduled',[],options);
    assert.deepEqual(f.messages.find(message=>message.method==='turn/start').params,{threadId:id,input:[{type:'text',text:'bounded work',text_elements:[]}],clientUserMessageId:'scheduled',...options});
    assert.deepEqual((await f.client.readThread(id)).state.currentPermissions.sandboxPolicy,options.sandboxPolicy);
    await assert.rejects(()=>f.client.sendMessage(id,'raced work','scheduled-next',[],options),(error:any)=>error.code==='thread_busy'&&error.outcomeUnknown===false);
    assert.equal(f.messages.some(message=>message.method==='turn/steer'),false);
    await f.client.sendMessage(id,'human guidance','chat');assert.equal(f.messages.find(message=>message.method==='turn/steer').params.approvalsReviewer,undefined);
  }finally{await f.close();}
});
test('shared native approvals retain request ids and cannot approve a different request type',async()=>{
  const f=await fixture();try{await f.client.readThread(id);f.event('item/commandExecution/requestApproval',{threadId:id,turnId},42);await until(()=>f.client.snapshots.get(id)?.state.requests.length===1);await assert.rejects(()=>f.client.respond(id,42,'file','accept'),/类型不匹配/);await f.client.respond(id,42,'command','decline');await until(()=>f.messages.some(message=>message.id===42));assert.deepEqual(f.messages.find(message=>message.id===42).result,{decision:'decline'});}finally{await f.close();}
});
test('a lost native send reply remains unknown and is never resent',async()=>{
  const f=await fixture({loseSend:true});try{await assert.rejects(()=>f.client.sendMessage(id,'once','stable'),(error:any)=>error.outcomeUnknown===true);assert.equal(f.messages.filter(message=>message.method==='turn/start').length,1);}finally{await f.close();}
});
test('native rejections remain definitive and creating a task does not start a turn',async()=>{
  const f=await fixture({rejectSend:true});try{const snapshot=await f.client.createThread(f.dir);assert.equal(snapshot.threadId,id);assert.equal(f.messages.some(message=>message.method==='turn/start'),false);await assert.rejects(()=>f.client.sendMessage(id,'once','stable'),(error:any)=>error.outcomeUnknown===false);}finally{await f.close();}
});

// A renamed installation may retain its old state directory or use MORROW_HOME.
// Discover through the production constructor, then recover an actual task from
// the isolated socket; selecting a default directory would miss this receipt.
test('native task discovery follows the service home after a rename',async()=>{
  const f=await fixture({codexHome:process.env.CODEX_HOME||join(homedir(),'.codex')});
  const home=join(f.dir,'NoHuman'),directory=join(home,'codex-bridge');mkdirSync(directory,{recursive:true,mode:0o700});
  writeFileSync(join(directory,`host-${process.pid}.json`),JSON.stringify(f.client.options.host),{mode:0o600});
  const store=new Store(join(home,'workspace.sqlite'));
  const native=new NativeConversations(store,{home} as Engine);
  try{
    const snapshot=await native.transport.readThread(id);
    assert.equal(native.transport.backgroundReady,true);
    assert.equal(snapshot.threadId,id);
    assert.equal(snapshot.state.turns[0].items[0].text,'original');
    assert.equal(store.get<any>('migrations','native-host-affinity')?.launchId,'fixture-launch');
    assert.equal(f.messages.filter(message=>message.method==='thread/resume').length,1);
    assert.equal(f.messages.some(message=>message.method==='thread/start'||message.method==='turn/start'),false);
  }finally{native.close();store.close();await f.close();}
});
