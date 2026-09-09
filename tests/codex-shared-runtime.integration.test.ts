import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexSharedTransport, findSharedHost } from '../service/codex-shared-transport.ts';

const binary=process.env.MORROW_TEST_CODEX_BINARY;
async function until(check:()=>boolean){for(let count=0;count<400;count++){if(check())return;await new Promise(done=>setTimeout(done,25));}assert.fail('shared runtime timed out');}

test('App launch bridge and Morrow share cold tasks, active steering, external replies and runtime recovery', {skip:!binary,timeout:60_000}, async()=>{
  const directory=mkdtempSync('/tmp/morrow-native-'),workspace=join(directory,'project');mkdirSync(workspace);
  let modelCalls=0;
  const model=createServer(async(request,response)=>{
    for await(const chunk of request){}
    const call=++modelCalls,id=`response-${call}`,text=`SHARED-NATIVE-${call}`;
    await new Promise(done=>setTimeout(done,150));
    const item={id:`message-${call}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
    response.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(done=>model.listen(0,'127.0.0.1',done));
  const port=(model.address() as any).port;
  writeFileSync(join(directory,'config.toml'),`model="fixture-model"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="read-only"\n[model_providers.fixture]\nname="Isolated fixture"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const bridgeDirectory=join(directory,'bridge');let requestId=0;const hosts:any[]=[];const clients:CodexSharedTransport[]=[];
  async function appClient(){
    const child=spawn(process.execPath,[resolve('service/codex-app-host-bridge.ts'),'-c','features.code_mode_host=true','app-server','--listen','stdio://','-c','model="fixture-model"'],{env:{...process.env,CODEX_HOME:directory,MORROW_CODEX_BINARY:binary!,MORROW_CODEX_BRIDGE_HOME:bridgeDirectory,MORROW_CODEX_SOCKET_DIRECTORY:join(directory,'sockets')},stdio:['pipe','pipe','pipe']});hosts.push(child);
    let errors='';child.stderr.on('data',data=>errors+=data.toString());
    const pending=new Map<number,any>(),events:any[]=[];
    createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);const entry=pending.get(message.id);if(entry){clearTimeout(entry.timer);pending.delete(message.id);message.error?entry.reject(Error(JSON.stringify(message.error))):entry.resolve(message.result);}else events.push(message);});
    const request=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++requestId;const timer=setTimeout(()=>reject(Error(`${method} timed out: ${errors.slice(-1000)}`)),12000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
    await request('initialize',{clientInfo:{name:'codex_app_fixture',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');
    await until(()=>!!findSharedHost(bridgeDirectory,directory));
    return {child,request,events,stop:async()=>{child.stdin.end();await new Promise(done=>child.once('exit',done));await until(()=>!findSharedHost(bridgeDirectory,directory));}};
  }
  const newClient=()=>{const client=new CodexSharedTransport({directory:bridgeDirectory,codexHome:directory});clients.push(client);return client;};
  try{
    const app=await appClient(),morrow=newClient();
    const created=await morrow.createThread(workspace);const id=created.threadId;const snapshots:any[]=[];
    await morrow.subscribeChanges(id,snapshot=>snapshots.push(snapshot));
    const started=await morrow.sendMessage(id,'Create from Morrow, no App task opened.','native-first');
    await until(()=>modelCalls>0);
    const appResume=await app.request('thread/resume',{threadId:id,excludeTurns:true});assert.equal(appResume.thread.id,id);assert.equal(appResume.thread.status.type,'active');
    const steered=await app.request('turn/steer',{threadId:id,expectedTurnId:started.turn.id,clientUserMessageId:'app-steer',input:[{type:'text',text:'Continue the same native turn.',text_elements:[]}]});assert.equal(steered.turnId,started.turn.id);
    await until(()=>snapshots.at(-1)?.state.threadRuntimeStatus.type==='idle'&&snapshots.at(-1)?.state.turns.length>0);
    assert.equal(snapshots.at(-1).state.turns[0].turnId,started.turn.id);
    assert.ok(snapshots.at(-1).state.turns[0].items.some((item:any)=>item.type==='agentMessage'&&item.text.startsWith('SHARED-NATIVE-')));
    const outside=await app.request('turn/start',{threadId:id,clientUserMessageId:'app-message',input:[{type:'text',text:'App-originated input',text_elements:[]}]});
    await until(()=>snapshots.at(-1)?.state.turns.some((turn:any)=>turn.turnId===outside.turn.id&&turn.status==='completed'));
    const beforeRestartId=morrow.host!.launchId;morrow.close();await app.stop();
    const restartedApp=await appClient(),reconnected=newClient();
    // The new App client has only initialized; it has never opened/resumed this task.
    const resumed=await reconnected.readThread(id);assert.equal(resumed.threadId,id);assert.notEqual(reconnected.host!.launchId,beforeRestartId);assert.equal(resumed.state.turns.length,2);
    const replies=resumed.state.turns.flatMap((turn:any)=>turn.items).filter((item:any)=>item.type==='agentMessage');assert.equal(new Set(replies.map((item:any)=>item.id)).size,replies.length);
    const afterRestart=await reconnected.sendMessage(id,'Resume without opening the App task.','native-after-restart');
    await until(()=>reconnected.snapshots.get(id)?.state.turns.some((turn:any)=>turn.turnId===afterRestart.turn.id&&turn.status==='completed'));
    const appRead=await restartedApp.request('thread/read',{threadId:id,includeTurns:false});assert.equal(appRead.thread.id,id);assert.equal(appRead.thread.status.type,'idle');
  }finally{for(const client of clients)client.close();for(const child of hosts)if(child.exitCode==null)child.kill('SIGTERM');await new Promise(done=>setTimeout(done,100));await new Promise<void>(done=>model.close(()=>done()));rmSync(directory,{recursive:true,force:true});}
});
