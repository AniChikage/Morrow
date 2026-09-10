import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexNativeTransport } from '../service/codex-native-transport.ts';

const binary=process.env.MORROW_TEST_CODEX_BINARY;
async function until(check:()=>boolean){for(let count=0;count<400;count++){if(check())return;await new Promise(done=>setTimeout(done,25));}assert.fail('shared runtime timed out');}

test('direct CLI creates, streams, steers and cold resumes the exact task with no App or bridge', {skip:!binary,timeout:60_000}, async()=>{
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
  const clients:CodexNativeTransport[]=[];
  const newClient=()=>{const client=new CodexNativeTransport({executable:binary!,env:{CODEX_HOME:directory},timeoutMs:12000});clients.push(client);return client;};
  try{
    const morrow=newClient();
    const created=await morrow.createThread(workspace),id=created.threadId;
    assert.equal(morrow.backgroundReady,true);assert.equal(morrow.host,null);
    const snapshots:any[]=[];
    await morrow.subscribeChanges(id,snapshot=>snapshots.push(snapshot));
    const started=await morrow.sendMessage(id,'Run directly through CLI.','cli-first');
    await until(()=>modelCalls>0);
    const steered=await morrow.sendMessage(id,'Continue the same turn.','cli-steer');
    assert.equal(steered.turnId,started.turn.id);
    await until(()=>snapshots.at(-1)?.state.turns[0]?.status==='completed');
    assert.ok(snapshots.at(-1).state.turns[0].items.some((item:any)=>item.type==='agentMessage'&&item.text.startsWith('SHARED-NATIVE-')));
    const independent=newClient();
    await assert.rejects(independent.readThread(id),/active writer/);
    const fork=await independent.forkThread(id,workspace);
    assert.notEqual(fork.threadId,id);assert.equal(fork.state.turns.length,1);
    assert.ok(fork.state.turns[0].items.some((item:any)=>item.type==='agentMessage'));
    const next=await independent.sendMessage(fork.threadId,'Continue the migrated history.','cli-handoff');
    await until(()=>independent.snapshots.get(fork.threadId)?.state.turns.some((turn:any)=>turn.turnId===next.turn.id&&turn.status==='completed'));
    assert.equal(morrow.snapshots.get(id)?.state.turns.length,1);
    independent.close();
    const owner=morrow.projectionOwner;morrow.close();
    await until(()=>morrow.socket===null||morrow.socket.readyState===3);
    const reconnected=newClient();
    const resumed=await reconnected.readThread(id);
    assert.equal(resumed.threadId,id);assert.notEqual(resumed.ownerClientId,owner);
    assert.equal(resumed.state.turns.length,1);
    const continued=await reconnected.sendMessage(id,'Continue after Morrow reconnects.','cli-next');
    await until(()=>reconnected.snapshots.get(id)?.state.turns.some((turn:any)=>turn.turnId===continued.turn.id&&turn.status==='completed'));
    assert.equal(reconnected.snapshots.get(id)?.state.turns.length,2);
    assert.equal(reconnected.host,null);
  }finally{for(const client of clients)client.close();await new Promise(done=>setTimeout(done,100));await new Promise<void>(done=>model.close(()=>done()));rmSync(directory,{recursive:true,force:true});}
});
