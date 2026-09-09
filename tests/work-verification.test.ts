import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../service/server.ts';
import { sourceVersion } from '../service/source-version.ts';
import { executionCommand } from '../service/execution-evidence.ts';
import { FakeReviewer } from './fake-reviewer.ts';
process.env.NOHUMAN_TEST_MODE='1';
const future=()=>new Date(Date.now()+3600000).toISOString();
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'nh-v09-')),path=join(root,'project'),home=join(root,'home');mkdirSync(path);writeFileSync(join(path,'source.js'),'export const value=1;\n');
  const native=new FakeReviewer(),s=await startServer({home,port:0,nativeTransport:native}),token=readFileSync(join(home,'token'),'utf8');
  const request=async(route:string,input:unknown,auth=token,status=200)=>{const r=await fetch(`http://127.0.0.1:${s.port}${route}`,{method:'POST',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:JSON.stringify(input)});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;};
  const project=await request('/api/projects',{name:'独立复核夹具',path,goal:'保留完整结果且可复现'},token,201),channel=s.store.all<any>('channels')[0];
  const run={id:randomUUID(),projectId:project.id,channelId:channel.id,runtime:'codex',status:'running',source:'nohuman-schedule',executionOwner:'codex-app',startedAt:new Date().toISOString(),finishedAt:'',summary:'',sessionId:'implementer-thread',nativeTurnId:'implementer-turn'};s.store.put('runs',run);s.engine.loop.prepare(run as any);
  const grant=JSON.parse(readFileSync(join(home,'runs',run.id,'agent-context.json'),'utf8'));
  const call=(operation:string,input:unknown={},status=200,requestId=randomUUID())=>request('/api/agent',{operation,input,requestId},grant.token,status);
  const itemInput={title:'完整结果',summary:'修复并追踪返回值',kind:'feature',status:'investigating',evidenceIds:[],nextStep:'验证反例'};
  const item=await call('feature.upsert',itemInput);
  writeFileSync(join(path,'result.json'),JSON.stringify({value:1}));const evidence=await call('evidence.capture',{summary:'实际文件内容，执行真实性尚未证明',path:'result.json'});
  const command='node --test source.js';
  const emitCommand=(id:string,status:string,patch:Record<string,unknown>={})=>{const raw={id,type:'commandExecution',command,cwd:path,status,aggregatedOutput:status==='inProgress'?'':'1 test passed',...(status==='inProgress'?{}:{exitCode:0}),...patch};const row={id,threadId:run.sessionId,turnId:run.nativeTurnId,type:'commandExecution',role:'tool',text:raw.aggregatedOutput,status,raw,present:true,ordinal:0};s.store.put('native_items',row);s.engine.loop.executions.observe(run.sessionId,[row] as any);};
  const choose=async(execution=false)=>{const context=await call('context');return call('decision.choose',{objectiveVersion:context.strategy.objective.version,options:[{title:'核验完整结果',kind:'build_capability',benefit:'确保结果完整',cost:'一次检查',uncertainty:'业务影响未知'}],selected:0,rationale:'先核验',nextStep:'检查边界',expectedOutcome:'实际检查通过',evaluation:'比对原始输入输出',stopWhen:'反例存在时调整',understandingRefs:[],evidenceIds:[],watchIds:[],reviewAt:future(),maxRuns:3,itemId:item.id,expectations:[{id:'value',kind:'outcome',claim:execution?'命令确实运行通过':'结果值为 1',scope:'当前版本隔离检查',source:execution?{kind:'execution',command}:{kind:'file',path:'result.json'},verification:'核验原始结果',disconfirm:'出现反例',deadline:future(),rule:{pointer:execution?'/exitCode':'/value',operator:'equals',expected:execution?0:1}}]});};
  const review=(d:any,id:string,status=200,verdict='met')=>call('decision.review',{id:d.id,revision:d.revision,outcome:verdict==='met'?'improved':'inconclusive',conclusion:'仅核验本次能力',evidenceIds:[],nextDirection:'继续观察实际效果',assessment:{results:[{expectationId:'value',verdict,reason:'按原始记录核对',evidenceIds:[id]}],conditions:'matched',conditionReason:'同一数据口径',diagnosis:'expected',explanation:'不是业务收益证明',adjustment:'observe',understandingRefs:[]}},status);
  return {...s,native,root,path,home,project,channel,run,item,itemInput,evidence,call,choose,review,command,emitCommand,cleanup:async()=>{await s.close();rmSync(root,{recursive:true,force:true});}};
}

test('native execution seals real command fields and rejects stale or forged evidence',async()=>{
  const f=await fixture();try{
    const d=await f.choose(true),requestId=randomUUID();
    const prepared=await f.call('execution.prepare',{command:f.command},200,requestId);assert.deepEqual(await f.call('execution.prepare',{command:f.command},200,requestId),prepared);
    f.emitCommand('tool-one','inProgress');f.emitCommand('tool-one','completed');
    const captured=await f.call('execution.read',{id:prepared.id});assert.equal(captured.evidence.origin,'execution');assert.equal(captured.evidence.data.boundVersion,true);assert.equal(captured.evidence.data.exitCode,0);assert.equal(captured.evidence.data.threadId,f.run.sessionId);
    f.emitCommand('tool-one','completed',{exitCode:1});assert.deepEqual((await f.call('execution.read',{id:prepared.id})).evidence,captured.evidence);
    await f.call('evidence.record',{origin:'execution',summary:'forged',source:f.command,observedAt:new Date().toISOString()},400);
    const pending=await f.review(d,captured.evidence.id);assert.equal(pending.pendingVerification,true);assert.equal(pending.status,'active');
    await f.engine.loop.verification.start(pending.verificationId);assert.equal(f.native.sent.length,1);assert.notEqual(f.native.sent[0].threadId,f.run.sessionId);assert.deepEqual(f.native.sent[0].options,{approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}});assert(!f.native.sent[0].text.includes('agent-context.json'));assert.equal(f.engine.budgetCount(f.channel.id),2);
    f.native.complete();const done=f.store.get<any>('strategy_decisions',d.id);assert.equal(done.status,'reviewed');assert.equal(done.review.outcome,'improved');
    writeFileSync(join(f.path,'source.js'),'export const value=2;');assert.equal(f.engine.loop.verification.view(f.project.id)[0].current,false);
    assert.throws(()=>f.engine.loop.verification.requirePassed({projectId:f.project.id} as any,f.item.id),/独立复核/);
    const next=await f.choose(true);const old=f.store.get<any>('loop_evidence',captured.evidence.id);f.store.put('loop_evidence',{...old,id:'stale-source',createdAt:next.createdAt,observedAt:next.createdAt});
    await f.review(next,'stale-source',400);const unknown=await f.review(next,'stale-source',200,'unknown');assert.equal(unknown.review.assessment.results[0].verdict,'unknown');
  }finally{await f.cleanup();}
});
test('missing start, changed source, wrong directory, failed command and truncated output stay inspectable without false success',async()=>{
  const f=await fixture();try{
    for(const [kind,change] of [['no-start',{}],['nonzero',{exitCode:9}],['truncated',{outputTruncated:true}],['wrong-cwd',{cwd:f.root}],['changed',{}]] as const){
      const p=await f.call('execution.prepare',{command:f.command});if(kind!=='no-start')f.emitCommand(kind,'inProgress');if(kind==='changed')writeFileSync(join(f.path,'source.js'),'changed');f.emitCommand(kind,'completed',change);
      const e=(await f.call('execution.read',{id:p.id})).evidence;assert.equal(e.origin,'execution');if(kind==='nonzero')assert.equal(e.data.exitCode,9);else if(kind==='truncated')assert.equal(e.data.outputComplete,false);else assert.equal(e.data.boundVersion,false);
    }
    const p=await f.call('execution.prepare',{command:f.command});f.engine.loop.executions.recover();assert.equal((await f.call('execution.read',{id:p.id})).status,'unknown');
    f.emitCommand('after-restart','completed');assert.equal((await f.call('execution.read',{id:p.id})).evidence,undefined);
  }finally{await f.cleanup();}
});
test('automatic feature gate retains failures, deduplicates requests and requires corrected current source',async()=>{
  const f=await fixture();try{
    const input={...f.itemInput,id:f.item.id,revision:f.item.revision,status:'verified',evidenceIds:[f.evidence.id]};
    const pending=await f.call('feature.upsert',input);assert.equal(pending.status,'investigating');assert.equal(pending.pendingVerification,true);
    const job=f.store.get<any>('loop_verifications',pending.verificationId);assert.equal((await f.call('verification.request',{itemId:f.item.id,evidenceIds:[f.evidence.id]})).id,job.id);
    await f.engine.loop.verification.start(job.id);const bad={...f.native.report(f.native.sent[0].threadId),verdict:'fail',checks:[{expectationId:'feature',verdict:'not_met',reason:'真实 ISO 时间格式存在边界反例'}],findings:[{severity:'blocking',message:'169 小时的数据错误计入 7 天'}]};f.native.complete(undefined,{report:bad});
    assert.equal(f.store.get<any>('loop_verifications',job.id).status,'failed');
    const again=await f.call('feature.upsert',{...input,revision:pending.revision});assert.equal(again.status,'investigating');assert.equal(again.verificationId,job.id);assert.equal(f.native.sent.length,1);
    writeFileSync(join(f.path,'source.js'),'export const value=1; // fixed boundary\n');
    const fixed=await f.call('feature.upsert',{...input,revision:again.revision});assert.notEqual(fixed.verificationId,job.id);await f.engine.loop.verification.start(fixed.verificationId);f.native.complete();
    const verified=f.store.get<any>('items',f.item.id);assert.equal(verified.status,'verified');assert.equal(f.store.all('items').length,1);assert.equal(f.store.all('loop_verifications').length,2);assert.equal(f.store.get<any>('loop_verifications',job.id).findings[0].message,bad.findings[0].message);
    assert(f.store.all('loop_verification_events').length>0);assert.equal(f.store.get<any>('channels',f.channel.id).sessionId,'');assert.equal(f.store.all('native_bindings').length,0);
  }finally{await f.cleanup();}
});
test('no-tool pass, skipped expectations and changes during review cannot certify success',async()=>{
  for(const scenario of ['no-tool','missing-check','changed','file-change']){
    const f=await fixture();try{
      const job=await f.call('verification.request',{itemId:f.item.id,evidenceIds:[f.evidence.id]});await f.engine.loop.verification.start(job.id);
      const report=f.native.report(f.native.sent[0].threadId);if(scenario==='missing-check')report.checks=[];if(scenario==='changed')writeFileSync(join(f.path,'source.js'),'changed during review');
      f.native.complete(undefined,{report,command:scenario!=='no-tool',...(scenario==='file-change'?{items:[{id:'write',type:'fileChange',status:'completed'}]}:{})});
      assert.equal(f.store.get<any>('loop_verifications',job.id).status,'unknown',scenario);
    }finally{await f.cleanup();}
  }
});
test('pause and restart preserve unknown outcomes, stop exact reviewer turns, and never resend',async()=>{
  const f=await fixture();try{
    const job=await f.call('verification.request',{itemId:f.item.id,evidenceIds:[f.evidence.id]});await f.engine.loop.verification.start(job.id);
    await f.engine.action(f.channel.id,'pause');await Promise.allSettled([...f.engine.loop.pending]);assert.equal(f.store.get<any>('loop_verifications',job.id).status,'unknown');assert.equal(f.native.interrupted.length,1);assert.equal(f.engine.control(f.channel.id).enabled,false);assert.equal(f.store.get<any>('channels',f.channel.id).nextRunAt,'');
    const stored=f.store.get<any>('loop_verifications',job.id);f.store.put('loop_verifications',{...stored,id:'interrupted-by-restart',status:'running'});f.engine.loop.verification.recover();assert.equal(f.store.get<any>('loop_verifications','interrupted-by-restart').status,'unknown');
    f.engine.loop.verification.tick();await Promise.allSettled([...f.engine.loop.pending]);assert.equal(f.native.sent.length,1);
  }finally{await f.cleanup();}
});
test('daily budget and project scope apply to reviewer jobs and execution reads',async()=>{
  const f=await fixture();try{
    f.store.put('channels',{...f.channel,maxRunsPerDay:1});const job=await f.call('verification.request',{itemId:f.item.id,evidenceIds:[f.evidence.id]});f.engine.loop.verification.tick();assert.equal(f.store.get<any>('loop_verifications',job.id).status,'queued');assert.equal(f.native.sent.length,0);
    f.store.put('loop_verifications',{...job,id:'foreign',projectId:'another'});await f.call('verification.read',{id:'foreign'},404);
    f.store.put('loop_executions',{id:'foreign-execution',projectId:'another'});await f.call('execution.read',{id:'foreign-execution'},404);
    await f.call('verification.request',{itemId:f.item.id,evidenceIds:[f.evidence.id],verdict:'pass'},400);
    f.store.put('channels',{...f.channel,maxRunsPerDay:3});f.engine.loop.verification.tick();await Promise.allSettled([...f.engine.loop.pending]);assert.equal(f.native.sent.length,1);
  }finally{await f.cleanup();}
});
test('source seals cover untracked edits, preserve unchanged content and reject symlink targets',async()=>{
  const root=mkdtempSync(join(tmpdir(),'nh-source-'));try{
    writeFileSync(join(root,'source.js'),'one');const a=sourceVersion(root);assert.equal(sourceVersion(root).digest,a.digest);writeFileSync(join(root,'other.js'),'two');assert.notEqual(sourceVersion(root).digest,a.digest);symlinkSync('/etc/hosts',join(root,'linked'));assert.throws(()=>sourceVersion(root),/链接/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('unknown reviews can be retried once with preserved history, while streaming I/O stays complete and bounded',async()=>{
  const f=await fixture();try{
    const job=await f.call('verification.request',{itemId:f.item.id,evidenceIds:[f.evidence.id]});await f.engine.loop.verification.start(job.id);f.native.complete(undefined,{command:false});assert.equal(f.store.get<any>('loop_verifications',job.id).status,'unknown');
    const retry=await f.call('verification.retry',{id:job.id});assert.notEqual(retry.id,job.id);await f.engine.loop.verification.start(retry.id);
    const threadId=f.native.sent.at(-1)!.threadId,snapshot=f.native.snapshots.get(threadId)!,turn=snapshot.state.turns[0];
    turn.items=[{id:'stream',type:'commandExecution',command:'read-only stream',cwd:f.path,status:'inProgress',aggregatedOutput:''}];
    for(let i=1;i<=90;i++){turn.items[0].aggregatedOutput='a'.repeat(i*1000);f.native.emit(threadId);}
    const events=f.store.all<any>('loop_verification_events').filter(e=>e.verificationId===retry.id),first=events.find(e=>e.raw?.id==='stream').raw;
    const rebuilt={...first};for(const event of events)if(event.patches)for(const patch of event.patches){if(patch.removed)delete rebuilt[patch.field];else if('append' in patch)rebuilt[patch.field]+=patch.append;else rebuilt[patch.field]=patch.value;}
    assert.equal(rebuilt.aggregatedOutput,'a'.repeat(90000));assert(f.store.get<any>('loop_verifications',retry.id).bytes<110000);
    f.native.complete(undefined,{command:false});await f.call('verification.retry',{id:retry.id},429);assert.equal(f.store.get<any>('loop_verifications',job.id).status,'unknown');
  }finally{await f.cleanup();}
});
test('SQLite restart retains execution seals, failure history and reviewer interruption intent without replay',async()=>{
  const f=await fixture();let reopened:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
    const p=await f.call('execution.prepare',{command:f.command});f.emitCommand('persisted-command','inProgress');f.emitCommand('persisted-command','completed');const evidence=(await f.call('execution.read',{id:p.id})).evidence;
    const job=await f.call('verification.request',{itemId:f.item.id,evidenceIds:[evidence.id]});await f.engine.loop.verification.start(job.id);
    await f.close();reopened=await startServer({home:f.home,port:0,nativeTransport:f.native});
    assert.deepEqual(reopened.store.get<any>('loop_evidence',evidence.id),evidence);assert.equal(reopened.store.get<any>('loop_verifications',job.id).status,'unknown');assert.equal(reopened.store.get<any>('loop_executions',p.id).status,'captured');assert.equal(reopened.store.get<any>('projects',f.project.id).path,f.project.path);assert.equal(f.native.sent.length,1);assert.equal(reopened.store.db.prepare('PRAGMA quick_check').get()?.quick_check,'ok');
  }finally{await reopened?.close();await f.cleanup();}
});
test('timeout and output overflow interrupt only the reviewer and do not accept its later pass',async()=>{
  for(const scenario of ['timeout','overflow']){
    const f=await fixture();try{
      const job=await f.call('verification.request',{itemId:f.item.id,evidenceIds:[f.evidence.id]});if(scenario==='timeout')f.store.put('loop_verifications',{...job,timeoutSeconds:0.02});
      await f.engine.loop.verification.start(job.id);
      if(scenario==='overflow')f.native.complete(undefined,{items:[{id:'huge',type:'agentMessage',text:'x'.repeat(4*1024*1024+1)}]});else await new Promise(r=>setTimeout(r,50));
      await Promise.allSettled([...f.engine.loop.pending]);assert.equal(f.store.get<any>('loop_verifications',job.id).status,'unknown');f.native.complete();assert.equal(f.store.get<any>('loop_verifications',job.id).status,'unknown');assert.equal(f.store.get<any>('runs',f.run.id).status,'running');
    }finally{await f.cleanup();}
  }
});
test('native literal shell wrappers preserve exact command identity without accepting extra shell operations',async()=>{
  for(const command of ['node --test source.js',"node -e 'console.log(\"ok\")'",'echo "$VALUE"; printf "%s" "$(literal)"',"printf '%s' 'quoted text'",'node --test\n# comment']){
    const wrapped="/bin/bash -lc '"+command.replaceAll("'","'\\''")+"'";
    assert.equal(executionCommand({source:'unifiedExecStartup',command:wrapped}),command);
    assert.notEqual(executionCommand({source:'unifiedExecStartup',command:wrapped+'; false'}),command);
  }
  assert.equal(executionCommand({source:'unifiedExecStartup',command:'/bin/bash -lc "node --test source.js"'}),'node --test source.js');
  const f=await fixture();try{
    const p=await f.call('execution.prepare',{command:f.command});const raw={source:'unifiedExecStartup',command:`/bin/bash -lc "${f.command}"`};f.emitCommand('wrapped','inProgress',raw);f.emitCommand('wrapped','completed',raw);const captured=await f.call('execution.read',{id:p.id});assert.equal(captured.evidence.data.boundVersion,true);assert.equal(captured.evidence.data.nativeCommand,raw.command);
  }finally{await f.cleanup();}
});

test('native automatic approval start and completion bind one exact execution despite changing source tags',async()=>{
  const f=await fixture();try {
    const p=await f.call('execution.prepare',{command:f.command});
    const wrapped=`/bin/bash -lc '${f.command}'`;
    f.emitCommand('approved-command','inProgress',{source:'agent',command:wrapped,aggregatedOutput:null,exitCode:null});
    assert.equal((await f.call('execution.read',{id:p.id})).status,'running');
    f.emitCommand('approved-command','completed',{source:'unifiedExecStartup',command:wrapped});
    const capture=await f.call('execution.read',{id:p.id});assert.equal(capture.evidence.data.boundVersion,true);assert.equal(capture.evidence.data.exitCode,0);
    assert.notEqual(executionCommand({source:'agent',command:wrapped+'; false'}),f.command);
    assert.notEqual(executionCommand({source:'other',command:wrapped}),f.command);
  } finally {await f.cleanup();}
});

test('pending project verification delays autonomous turns without spending runs and releases them after completion',async()=>{
  const f=await fixture(),native=f.engine.native!,original=native.startScheduled;let starts=0;
  native.startScheduled=(async()=>{starts++;}) as typeof original;
  try {
    f.store.put('native_bindings',{id:f.channel.id,projectId:f.project.id,threadId:f.run.sessionId,cwd:f.path,createdAt:new Date().toISOString()});
    const job=await f.call('verification.request',{itemId:f.item.id,evidenceIds:[f.evidence.id]}),budget=f.engine.budgetCount(f.channel.id);
    f.engine.start(f.channel.id,true);assert.equal(starts,0);assert.equal(f.engine.budgetCount(f.channel.id),budget);assert.equal(f.store.get<any>('channels',f.channel.id).status,'waiting');
    assert.throws(()=>f.engine.start(f.channel.id,false),/独立复核尚未完成/);
    f.store.put('projects',{...f.project,id:'other-project',path:f.root});f.store.put('channels',{...f.channel,id:'other-channel',projectId:'other-project'});
    f.store.put('native_bindings',{id:'other-channel',projectId:'other-project',threadId:'other-thread',cwd:f.root,createdAt:new Date().toISOString()});
    await f.engine.start('other-channel',true);assert.equal(starts,1);
    await f.engine.loop.verification.start(job.id);f.engine.start(f.channel.id,true);assert.equal(starts,1);
    f.native.complete();await f.engine.start(f.channel.id,true);assert.equal(starts,2);
  } finally {native.startScheduled=original;await f.cleanup();}
});
test('a compact final snapshot cannot erase the successful tools already observed by the reviewer',async()=>{
  const f=await fixture();try{
    const job=await f.call('verification.request',{itemId:f.item.id,evidenceIds:[f.evidence.id]});await f.engine.loop.verification.start(job.id);
    const threadId=f.native.sent[0].threadId,turn=f.native.snapshots.get(threadId)!.state.turns[0];turn.items=[{id:'check',type:'commandExecution',status:'completed',exitCode:0,aggregatedOutput:'independent check'}];f.native.emit(threadId);f.native.complete(threadId,{command:false});assert.equal(f.store.get<any>('loop_verifications',job.id).status,'passed');assert.equal(f.store.get<any>('loop_verifications',job.id).commandCount,1);
  }finally{await f.cleanup();}
});


test('frozen expectations survive progress edits and covered evidence subsets; completion needs no extra native turn',async()=>{
  const f=await fixture();try{
    const d=await f.choose(true),p=await f.call('execution.prepare',{command:f.command});
    f.emitCommand('proof','inProgress');f.emitCommand('proof','completed');
    const evidence=(await f.call('execution.read',{id:p.id})).evidence;
    const job=await f.call('verification.request',{decisionId:d.id,evidenceIds:[evidence.id,f.evidence.id]});
    const pending=await f.review(d,evidence.id);assert.equal(pending.verificationId,job.id);
    const item=f.store.get<any>('items',f.item.id);f.store.put('items',{...item,title:'补充了结果说明',summary:'本地通过；业务收益仍未知',revision:item.revision+1});
    assert.equal(f.engine.loop.verification.current(job),true);
    await f.engine.loop.verification.start(job.id);
    f.store.put('runs',{...f.run,status:'completed'});const budget=f.engine.budgetCount(f.channel.id);
    f.native.complete();assert.equal(f.store.get<any>('strategy_decisions',d.id).status,'reviewed');
    assert.equal(f.store.get<any>('loop_finalizations',pending.finalizationId).status,'applied');
    f.engine.loop.verification.settle(job.id);assert.equal(f.store.get<any>('strategy_decisions',d.id).revision,2);assert.equal(f.engine.budgetCount(f.channel.id),budget);
    assert.equal(f.store.all<any>('events').filter(e=>e.action==='decision.reviewed').length,1);
    // A fresh native turn consumes the same valid proof to finish the feature.
    f.store.put('runs',f.run);
    const latest=f.store.get<any>('items',f.item.id);
    const finished=await f.call('feature.upsert',{...f.itemInput,id:latest.id,revision:latest.revision,title:latest.title,summary:'补充上线风险与回退说明',status:'verified',evidenceIds:[evidence.id]});
    assert.equal(finished.status,'verified');assert.equal(finished.verificationId,job.id);assert.equal(f.native.sent.length,1);
  }finally{await f.cleanup();}
});

test('new contradictory execution invalidates a passing review and cannot be dropped to reuse old success',async()=>{
  const f=await fixture();try{
    const d=await f.choose(true),p=await f.call('execution.prepare',{command:f.command});
    f.emitCommand('old-proof','inProgress');f.emitCommand('old-proof','completed');const evidence=(await f.call('execution.read',{id:p.id})).evidence;
    const pending=await f.review(d,evidence.id);await f.engine.loop.verification.start(pending.verificationId);
    const newer=await f.call('execution.prepare',{command:f.command});f.emitCommand('counterexample','inProgress');f.emitCommand('counterexample','completed',{exitCode:1});
    const counterexample=(await f.call('execution.read',{id:newer.id})).evidence;f.native.complete();
    assert.equal(f.store.get<any>('strategy_decisions',d.id).status,'active');assert.equal(f.store.get<any>('loop_finalizations',pending.finalizationId).status,'rejected');
    await f.call('verification.request',{decisionId:d.id,evidenceIds:[evidence.id]},409);assert.equal(f.store.all('loop_verifications').length,1);assert.equal(f.engine.loop.verification.current(f.store.get<any>('loop_verifications',pending.verificationId)),false);
    await f.review(d,evidence.id,409);
  }finally{await f.cleanup();}
});

test('automatic feature completion preserves concurrent human changes and never revives a stale request',async()=>{
  const f=await fixture();try{
    const pending=await f.call('feature.upsert',{...f.itemInput,id:f.item.id,revision:f.item.revision,status:'verified',evidenceIds:[f.evidence.id]});
    await f.engine.loop.verification.start(pending.verificationId);
    const item=f.store.get<any>('items',f.item.id);f.store.put('items',{...item,status:'blocked',nextStep:'等待用户新的方向',revision:item.revision+1});
    f.native.complete();assert.equal(f.store.get<any>('items',f.item.id).status,'blocked');assert.equal(f.store.get<any>('loop_finalizations',pending.finalizationId).status,'stale');
    f.engine.loop.verification.settle(pending.verificationId);assert.equal(f.store.get<any>('items',f.item.id).revision,item.revision+1);
  }finally{await f.cleanup();}
});

test('persisted successful completion intent recovers once after restart even though the originating turn ended',async()=>{
  const f=await fixture();let reopened:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
    const pending=await f.call('feature.upsert',{...f.itemInput,id:f.item.id,revision:f.item.revision,status:'verified',evidenceIds:[f.evidence.id]});
    // Recovery fixture: a durable terminal receipt with its local transition not yet drained.
    const job=f.store.get<any>('loop_verifications',pending.verificationId);f.store.put('loop_verifications',{...job,status:'passed',finishedAt:new Date().toISOString()});
    f.store.put('runs',{...f.run,status:'completed'});await f.close();
    reopened=await startServer({home:f.home,port:0,nativeTransport:new FakeReviewer()});reopened.engine.loop.verification.tick();
    assert.equal(reopened.store.get<any>('items',f.item.id).status,'verified');assert.equal(reopened.store.get<any>('loop_finalizations',pending.finalizationId).status,'applied');
    const revision=reopened.store.get<any>('items',f.item.id).revision;reopened.engine.loop.verification.tick();assert.equal(reopened.store.get<any>('items',f.item.id).revision,revision);
    assert.equal(reopened.store.get<any>('runs',f.run.id).status,'completed');assert.equal(f.native.sent.length,0);
  }finally{await reopened?.close();await f.cleanup();}
});

test('retry carries the latest valid completion request and bounded tool observations without inheriting a verdict',async()=>{
  for(const changed of [false,true]){
    const f=await fixture();try{
      const pending=await f.call('feature.upsert',{...f.itemInput,id:f.item.id,revision:f.item.revision,status:'resolved',evidenceIds:[f.evidence.id]});
      await f.engine.loop.verification.start(pending.verificationId);
      const thread=f.native.sent.at(-1)!.threadId,turn=f.native.snapshots.get(thread)!.state.turns[0];
      turn.items=[{id:'partial-check',type:'commandExecution',command:'read-only counterexample',status:'completed',exitCode:0,aggregatedOutput:'recorded counterexample observation'}];f.native.emit(thread);
      f.engine.loop.verification.stop(pending.verificationId,'fixture timeout after a recorded tool');await Promise.allSettled([...f.engine.loop.pending]);
      if(changed){const item=f.store.get<any>('items',f.item.id);f.store.put('items',{...item,status:'blocked',revision:item.revision+1});}
      const retry=await f.call('verification.retry',{id:pending.verificationId});
      assert.match(retry.prompt,/recorded counterexample observation/);assert.equal(retry.commandCount,0);assert.equal(retry.status,'queued');
      const carried=f.store.all<any>('loop_finalizations').filter(i=>i.verificationId===retry.id);assert.equal(carried.length,changed?0:1);
      await f.engine.loop.verification.start(retry.id);f.store.put('runs',{...f.run,status:'completed'});f.native.complete();
      assert.equal(f.store.get<any>('items',f.item.id).status,changed?'blocked':'resolved');
      assert.equal(f.store.get<any>('loop_finalizations',pending.finalizationId).status,'rejected');
      if(!changed){assert.equal(f.store.get<any>('loop_finalizations',carried[0].id).status,'applied');assert.equal(carried[0].runId,f.run.id);}
      assert.equal(f.native.sent.length,2);assert.equal(f.store.get<any>('loop_verifications',pending.verificationId).status,'unknown');
    }finally{await f.cleanup();}
  }
});


test('expired-window and stale-source execution cannot queue a reviewer even when a previous decision was reviewed',async()=>{
  const f=await fixture();try{
    const d=await f.choose(true),p=await f.call('execution.prepare',{command:f.command});
    f.emitCommand('proof-window','inProgress');f.emitCommand('proof-window','completed');
    const evidence=(await f.call('execution.read',{id:p.id})).evidence;
    // An archived contract ended before this new capture: the historical deadline is not extended.
    const archived={...d,status:'reviewed',expectations:d.expectations.map((e:any)=>({...e,deadline:new Date(Date.parse(evidence.observedAt)-1).toISOString()}))};f.store.put('strategy_decisions',archived);
    await f.call('verification.request',{decisionId:d.id,evidenceIds:[evidence.id]},409);
    assert.equal(f.native.sent.length,0);assert.equal(f.store.all('loop_verifications').length,0);
    assert.deepEqual(f.store.get<any>('strategy_decisions',d.id).expectations,archived.expectations);
    f.store.put('strategy_decisions',d);writeFileSync(join(f.path,'source.js'),'export const value=2;');
    await f.call('verification.request',{decisionId:d.id,evidenceIds:[evidence.id]},409);assert.equal(f.store.all('loop_verifications').length,0);
  }finally{await f.cleanup();}
});
