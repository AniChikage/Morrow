import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../service/server.ts';
import { ProjectWorkLoop } from '../service/project-loop.ts';
import { FakeReviewer } from './fake-reviewer.ts';
process.env.MORROW_TEST_MODE='1';
async function setup(){
  const root=mkdtempSync(join(tmpdir(),'morrow-loop-'));const home=join(root,'home'),path=join(root,'project');mkdirSync(path);
  let feedback={activation:0.2};let receipt:any={};let posts=0;let responseMode='normal';let uploaded='';
  const remote=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method==='POST'){posts++;let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);uploaded=Buffer.from(data.artifact.base64,'base64').toString('utf8');assert.equal(createHash('sha256').update(uploaded).digest('hex'),data.artifact.sha256);receipt={releaseId:data.releaseId,artifactSha256:data.artifact.sha256,status:'published'};if(responseMode==='disconnect'){req.socket.destroy();return;}res.end(JSON.stringify(responseMode==='wrong'?{...receipt,artifactSha256:'wrong'}:receipt));return;}res.end(JSON.stringify(req.url==='/feedback'?feedback:receipt));});
  await new Promise<void>(r=>remote.listen(0,'127.0.0.1',r));const remoteURL=`http://127.0.0.1:${(remote.address() as any).port}`;
  const s=await startServer({home,port:0});const token=readFileSync(join(home,'token'),'utf8');const api=async(method:string,url:string,data?:unknown,expected=200,bearer=token)=>{const response=await fetch(`http://127.0.0.1:${s.port}${url}`,{method,headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;};
  const project=await api('POST','/api/projects',{name:'闭环验收',path,goal:'持续改善首次使用体验'},201);const channel=s.store.all<any>('channels')[0];
  await api('POST','/api/channels',{projectId:project.id,name:'共享观察验收',goal:'独立验证跨频道反馈',runtime:'codex'},201);
  const run={id:randomUUID(),projectId:project.id,channelId:channel.id,runtime:'codex',status:'running',source:'morrow-schedule',executionOwner:'codex-app',startedAt:new Date().toISOString(),finishedAt:'',summary:'',sessionId:'isolated-native'};s.store.put('runs',run);s.engine.loop.prepare(run as any);const context=JSON.parse(readFileSync(join(home,'runs',run.id,'agent-context.json'),'utf8'));
  const call=(operation:string,input:unknown,requestId=randomUUID(),expected=200)=>api('POST','/api/agent',{operation,input,requestId},expected,context.token);
  const feature=await call('feature.upsert',{title:'改善首次使用',summary:'追踪实际体验',kind:'feature',status:'investigating',evidenceIds:[],nextStep:'建立反馈'});
  writeFileSync(join(path,'checks.log'),'2 tests passed\n');const evidence=await call('evidence.capture',{itemId:feature.id,summary:'隔离测试日志',path:'checks.log'});
  writeFileSync(join(path,'release.txt'),'immutable build one');
  // Release transport tests now cross the independent native gate with an explicit
  // protocol double; they do not claim that a real model verified this fixture.
  const reviewer=new FakeReviewer();reviewer.autoComplete=true;s.engine.loop.verification.connect(reviewer,v=>v);
  const completion=await call('feature.upsert',{id:feature.id,revision:s.store.get<any>('items',feature.id).revision,title:feature.title,summary:feature.summary,kind:feature.kind,status:'verified',evidenceIds:[evidence.id],nextStep:'准备本地发布'});
  assert.equal(completion.pendingVerification,true);await s.engine.loop.verification.start(completion.verificationId);
  assert.equal(s.store.get<any>('loop_verifications',completion.verificationId).status,'passed');
  assert.equal(s.store.get<any>('items',feature.id).status,'verified');
  assert.equal(s.store.get<any>('loop_finalizations',completion.finalizationId).status,'applied');
  const releaseInput={itemIds:[feature.id],title:'首次体验改进',changes:'修正失败提示并补充关键流程反馈',rationale:'测试发现失败状态无法恢复',expectedBenefit:'预期减少首次操作失败；线上收益尚待验证',checks:[{name:'恢复流程测试',result:'passed',evidenceIds:[evidence.id]}],risks:'影响首次使用路径',rollback:'恢复上一个产物',observationPlan:'观察关键操作完成率，再决定是否继续',artifactPath:'release.txt',target:{url:remoteURL+'/deploy',statusUrl:remoteURL+'/status',label:'隔离测试发布端'}};
  return {...s,root,home,path,api,call,context,project,channel,run,feature,evidence,releaseInput,remoteURL,get posts(){return posts;},get uploaded(){return uploaded;},setFeedback:(value:any)=>feedback=value,setMode:(value:string)=>responseMode=value,cleanup:async()=>{await s.close();await new Promise<void>(r=>remote.close(()=>r()));rmSync(root,{recursive:true,force:true});}};
}
const future=()=>new Date(Date.now()+3600000).toISOString();
test('review retains old referenced evidence and native context offers scoped full reads without replaying large logs',async()=>{const s=await setup();try{
  const release=await s.call('release.propose',s.releaseInput);
  for(let i=0;i<110;i++)s.store.put('loop_evidence',{...s.evidence,id:`later-${i}`,itemId:undefined});
  const view=await s.api('GET',`/api/projects/${s.project.id}/work`);assert(view.evidence.some((row:any)=>row.id===s.evidence.id));assert(view.releases.some((row:any)=>row.id===release.id));
  const original='full evidence\n'.repeat(300);writeFileSync(join(s.path,'long.log'),original);const long=await s.call('evidence.capture',{itemId:s.feature.id,summary:'完整证据',path:'long.log'});
  const context=await s.call('context',{});const preview=context.evidence.find((row:any)=>row.id===long.id);assert.equal(preview.truncated,true);assert.equal(preview.data.length,2000);assert.equal((await s.call('evidence.read',{id:long.id})).data,original);
  s.store.put('loop_evidence',{...long,id:'foreign-evidence',projectId:'another'});await s.call('evidence.read',{id:'foreign-evidence'},randomUUID(),404);
}finally{await s.cleanup();}});
test('native tools maintain one project feature, evidence and revised conclusions with scoped idempotent writes',async()=>{const s=await setup();try{
  const context=await s.call('context',{});assert.equal(context.features[0].id,s.feature.id);assert.equal(context.evidence[0].origin,'file');assert.equal(context.features[0].evidence.length,1);
  const id=randomUUID();const input={itemId:s.feature.id,kind:'hypothesis',title:'失败提示导致放弃',rationale:'需要区分技术故障与需求不足',expectedResult:'恢复后完成率增加',evaluation:'比较观测到的完成率',conclusion:'',status:'active',evidenceIds:[]};const first=await s.call('learning.upsert',input,id);assert.deepEqual(await s.call('learning.upsert',input,id),first);await s.call('learning.upsert',{...input,title:'不同内容'},id,409);
  const revised=await s.call('learning.upsert',{...input,id:first.id,revision:1,status:'refuted',conclusion:'新证据不支持原判断',evidenceIds:[s.evidence.id]});assert.equal(revised.revision,2);await s.call('learning.upsert',{...input,id:first.id,revision:1},randomUUID(),409);
  await s.call('feature.upsert',{id:s.feature.id,revision:s.store.get<any>('items',s.feature.id).revision,title:s.feature.title,summary:'继续追踪',kind:'feature',status:'verified',evidenceIds:[s.evidence.id],nextStep:'准备上线'});assert.equal(s.store.all('items').length,1);
  await s.call('release.approve',{},randomUUID(),400);await s.api('POST','/api/releases/unknown/review',{},401,s.context.token);
  s.store.put('items',{...s.feature,id:'foreign',projectId:'other'});await s.call('evidence.record',{itemId:'foreign',summary:'wrong',source:'fake',observedAt:new Date().toISOString()},randomUUID(),404);
  s.store.put('runs',{...s.run,status:'completed'});await s.call('evidence.record',{summary:'late',source:'fake',observedAt:new Date().toISOString()},randomUUID(),409);
}finally{await s.cleanup();}});
test('release requires human approval, publishes exactly the sealed artifact once, then real HTTP feedback resumes work',async()=>{const s=await setup();try{
  const release=await s.call('release.propose',s.releaseInput);assert.equal(release.status,'awaiting_approval');s.engine.loop.tick();await Promise.allSettled([...s.engine.loop.pending]);assert.equal(s.posts,0);
  const watch=await s.call('watch.create',{itemId:s.feature.id,title:'首次完成率',url:s.remoteURL+'/feedback',pointer:'/activation',condition:'gte',expected:0.6,deadline:future(),intervalSeconds:30,releaseId:release.id});
  await s.call('wait',{watchIds:[watch.id],releaseIds:[],deadline:future(),reason:'等待上线后的真实反馈'});s.engine.setControl(s.channel.id,{enabled:true});s.engine.completeAutonomousWork(s.run as any,'',true);assert(Date.parse(s.store.get<any>('channels',s.channel.id).nextRunAt)>Date.now()+100000);
  await s.engine.loop.poll(watch.id);assert.equal(s.store.get<any>('loop_watches',watch.id).lastDigest,undefined);
  await s.api('POST',`/api/releases/${release.id}/review`,{reviewHash:'stale',decision:'approve'},409);assert.equal(s.posts,0);
  writeFileSync(join(s.path,'release.txt'),'unreviewed later changes');
  await s.api('POST',`/api/releases/${release.id}/review`,{reviewHash:release.reviewHash,decision:'approve'});await Promise.allSettled([...s.engine.loop.pending]);assert.equal(s.posts,1);assert.equal(s.uploaded,'immutable build one');assert.equal(s.engine.loop.release(release.id).status,'published');
  await s.api('POST',`/api/releases/${release.id}/review`,{reviewHash:release.reviewHash,decision:'approve'});assert.equal(s.posts,1);
  await s.engine.loop.poll(watch.id);assert.equal(s.store.get<any>('loop_watches',watch.id).status,'watching');s.setFeedback({activation:0.7});await s.engine.loop.poll(watch.id);assert.equal(s.store.get<any>('loop_watches',watch.id).status,'triggered');assert.equal(s.store.get<any>('loop_waits',s.channel.id).status,'ready');assert(Date.parse(s.store.get<any>('channels',s.channel.id).nextRunAt)<Date.now()+10000);
  const view=await s.api('GET',`/api/projects/${s.project.id}/work?itemId=${s.feature.id}`);assert.equal(view.evidence.filter((v:any)=>v.origin==='http').length,2);assert.equal(view.releases[0].id,release.id);assert(s.store.all<any>('events').some(e=>e.action==='release.approved'&&e.actor==='human'));
}finally{await s.cleanup();}});
test('uncertain deployment is reconciled read-only after restart without a duplicate publication',async()=>{const s=await setup();try{
  const release=await s.call('release.propose',s.releaseInput);s.setMode('disconnect');await s.api('POST',`/api/releases/${release.id}/review`,{reviewHash:release.reviewHash,decision:'approve'});await Promise.allSettled([...s.engine.loop.pending]);assert.equal(s.engine.loop.release(release.id).status,'unknown');assert.equal(s.posts,1);
  const recovered=new ProjectWorkLoop(s.store,s.home);recovered.recover();await recovered.reconcile(release.id);assert.equal(recovered.release(release.id).status,'published');recovered.tick();await recovered.close();assert.equal(s.posts,1);
}finally{await s.cleanup();}});
test('invalid receipts and modified sealed files never masquerade as a successful approved release',async()=>{const s=await setup();try{
  const release=await s.call('release.propose',s.releaseInput);s.setMode('wrong');await s.api('POST',`/api/releases/${release.id}/review`,{reviewHash:release.reviewHash,decision:'approve'});await Promise.allSettled([...s.engine.loop.pending]);assert.equal(s.engine.loop.release(release.id).status,'unknown');
  const another=await s.call('release.propose',{...s.releaseInput,title:'另一版本'});writeFileSync(s.engine.loop.artifactPath(another.id),'tampered');await s.api('POST',`/api/releases/${another.id}/review`,{reviewHash:another.reviewHash,decision:'approve'},409);assert.equal(s.posts,1);
}finally{await s.cleanup();}});
test('changed feedback needs a baseline, cross-channel waits wake correctly, and manual pause remains authoritative',async()=>{const s=await setup();try{
  const watch=await s.call('watch.create',{itemId:s.feature.id,title:'观察变化',url:s.remoteURL+'/feedback',pointer:'/activation',condition:'changed',deadline:future(),intervalSeconds:30});
  await s.engine.loop.poll(watch.id);assert.equal(s.store.get<any>('loop_watches',watch.id).status,'watching');const count=s.store.all('loop_evidence').length;await s.engine.loop.poll(watch.id);assert.equal(s.store.all('loop_evidence').length,count);
  const other=s.store.all<any>('channels')[1];s.engine.setControl(other.id,{enabled:true});s.store.put('loop_waits',{id:other.id,projectId:s.project.id,runId:'other-run',watchIds:[watch.id],releaseIds:[],deadline:future(),status:'waiting',reason:'共享观察'});
  s.engine.setControl(s.channel.id,{enabled:false});s.store.put('channels',{...s.channel,status:'paused',nextRunAt:''});s.setFeedback({activation:0.3});await s.engine.loop.poll(watch.id);assert.equal(s.store.get<any>('channels',s.channel.id).nextRunAt,'');assert.equal(s.store.get<any>('loop_waits',other.id).status,'ready');assert(s.store.get<any>('channels',other.id).nextRunAt);
}finally{await s.cleanup();}});
test('a rejected release persists feedback and leaves independent work enabled',async()=>{const s=await setup();try{
  const release=await s.call('release.propose',s.releaseInput);await s.call('wait',{watchIds:[],releaseIds:[release.id],deadline:future(),reason:'等待上线确认'});s.engine.setControl(s.channel.id,{enabled:true});s.engine.completeAutonomousWork(s.run as any,'',true);
  await s.api('POST',`/api/releases/${release.id}/review`,{reviewHash:release.reviewHash,decision:'reject',feedback:'补充失败恢复验证'});assert.equal(s.engine.loop.release(release.id).feedback,'补充失败恢复验证');assert.equal(s.engine.control(s.channel.id).enabled,true);assert.equal(s.posts,0);assert.equal(s.store.get<any>('loop_waits',s.channel.id).status,'ready');
}finally{await s.cleanup();}});
test('feedback failures wake investigation once and expired observations never invent a successful result',async()=>{const s=await setup();try{
  const watch=await s.call('watch.create',{itemId:s.feature.id,title:'检查数据缺口',url:s.remoteURL+'/feedback',pointer:'/missing',condition:'changed',deadline:future(),intervalSeconds:30});await s.call('wait',{watchIds:[watch.id],releaseIds:[],deadline:future(),reason:'等待数据'});s.engine.setControl(s.channel.id,{enabled:true});s.engine.completeAutonomousWork(s.run as any,'',true);
  await s.engine.loop.poll(watch.id);await s.engine.loop.poll(watch.id);assert.equal(s.store.all<any>('events').filter(e=>e.action==='feedback.unavailable').length,1);assert.equal(s.store.get<any>('loop_waits',s.channel.id).status,'ready');assert.equal(s.store.get<any>('loop_watches',watch.id).status,'watching');
  s.store.put('loop_watches',{...s.store.get<any>('loop_watches',watch.id),deadline:new Date(0).toISOString()});await s.engine.loop.poll(watch.id);assert.equal(s.store.get<any>('loop_watches',watch.id).status,'expired');assert.equal(s.store.all<any>('loop_evidence').filter(e=>e.origin==='http').length,0);
}finally{await s.cleanup();}});
test('SQLite restart retains sealed releases, observations, waits and existing channel preferences',async()=>{const s=await setup();let restarted:Awaited<ReturnType<typeof startServer>>|undefined;try{
  const release=await s.call('release.propose',s.releaseInput);await s.call('wait',{watchIds:[],releaseIds:[release.id],deadline:future(),reason:'等待已准备版本的确认'});s.store.put('runs',{...s.run,status:'completed'});const before=s.store.get<any>('channels',s.channel.id);await s.close();restarted=await startServer({home:s.home,port:0});assert.deepEqual(restarted.store.get('channels',s.channel.id),before);assert.equal(restarted.engine.loop.release(release.id).reviewHash,release.reviewHash);assert.equal(restarted.store.get<any>('loop_waits',s.channel.id).status,'waiting');assert.equal(restarted.store.get<any>('items',s.feature.id).evidence.length,1);assert.equal(readFileSync(restarted.engine.loop.artifactPath(release.id),'utf8'),'immutable build one');assert.equal(s.posts,0);
}finally{await restarted?.close();await s.cleanup();}});
test('long-term feedback continues after its review deadline, wakes on new evidence, stays quiet when unchanged and stops on cancellation',async()=>{const s=await setup();try{
  const watch=await s.call('watch.create',{itemId:s.feature.id,title:'持续监测体验',url:s.remoteURL+'/feedback',pointer:'/activation',condition:'changed',deadline:future(),intervalSeconds:30});assert.equal(watch.continuous,true);
  await s.engine.loop.poll(watch.id);s.store.put('loop_watches',{...s.store.get<any>('loop_watches',watch.id),deadline:new Date(0).toISOString()});await s.engine.loop.poll(watch.id);assert.equal(s.store.get<any>('loop_watches',watch.id).status,'expired');
  await s.call('wait',{watchIds:[],releaseIds:[],deadline:future(),reason:'稳定时降低复查频率'});s.engine.setControl(s.channel.id,{enabled:true});s.engine.completeAutonomousWork(s.run as any,'',true);const sleeping=s.store.get<any>('channels',s.channel.id).nextRunAt;
  await s.engine.loop.poll(watch.id);assert.equal(s.store.get<any>('channels',s.channel.id).nextRunAt,sleeping);
  s.setFeedback({activation:0.1});await s.engine.loop.poll(watch.id);const awake=s.store.get<any>('channels',s.channel.id).nextRunAt;assert(Date.parse(awake)<Date.now()+6000);const observed=s.store.all<any>('loop_evidence').length;await s.engine.loop.poll(watch.id);assert.equal(s.store.get<any>('channels',s.channel.id).nextRunAt,awake);assert.equal(s.store.all<any>('loop_evidence').length,observed);
  await s.call('watch.cancel',{id:watch.id});s.setFeedback({activation:0});await s.engine.loop.poll(watch.id);assert.equal(s.store.all<any>('loop_evidence').length,observed);
  const once=await s.call('watch.create',{title:'一次性实验',url:s.remoteURL+'/feedback',pointer:'/activation',condition:'changed',deadline:future(),continuous:false});s.store.put('loop_watches',{...once,deadline:new Date(0).toISOString()});await s.engine.loop.poll(once.id);await s.engine.loop.poll(once.id);assert.equal(s.store.get<any>('loop_watches',once.id).lastDigest,undefined);
}finally{await s.cleanup();}});
test('the native command-line tool reads its scoped context and accepts JSON over stdin',async()=>{const s=await setup();try{
  const contextPath=join(s.home,'runs',s.run.id,'agent-context.json');const output=await new Promise<string>((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../service/agent-cli.ts',import.meta.url)),'--context',contextPath,'--operation','evidence.record','--input','-','--request-id','cli-input-check']);let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.once('error',reject);child.once('close',code=>code===0?resolve(stdout):reject(new Error(stderr)));child.stdin.end(JSON.stringify({itemId:s.feature.id,summary:'原生工具输入验收',source:'isolated-native-tool',observedAt:new Date().toISOString(),data:{observed:true}}));});const evidence=JSON.parse(output);assert.equal(evidence.origin,'agent');assert.equal(evidence.projectId,s.project.id);assert.equal(output.includes(s.context.token),false);assert.equal(s.store.get<any>('items',s.feature.id).evidence.length,2);
}finally{await s.cleanup();}});
