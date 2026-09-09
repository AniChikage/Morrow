import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../service/server.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
process.env.NOHUMAN_TEST_MODE='1';
const future=()=>new Date(Date.now()+3600000).toISOString();
async function setup(){
  const root=mkdtempSync(join(tmpdir(),'nh-strategy-'));const home=join(root,'home'),path=join(root,'project');mkdirSync(path);
  const s=await startServer({home,port:0});const token=readFileSync(join(home,'token'),'utf8');
  const api=async(method:string,url:string,input?:unknown,status=200,auth=token)=>{const res=await fetch(`http://127.0.0.1:${s.port}${url}`,{method,headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});const value=await res.json();assert.equal(res.status,status,JSON.stringify(value));return value;};
  const project=await api('POST','/api/projects',{name:'目标接管验收',path,goal:'让目标用户成功完成首次使用'},201);const channel=s.store.all<any>('channels')[0];
  const run={id:randomUUID(),projectId:project.id,channelId:channel.id,runtime:'codex',status:'running',source:'nohuman-schedule',executionOwner:'codex-app',startedAt:new Date().toISOString(),finishedAt:'',summary:'',sessionId:'isolated-test',workDirection:channel.goal};
  s.store.put('runs',run);s.engine.loop.prepare(run as any);const grant=JSON.parse(readFileSync(join(home,'runs',run.id,'agent-context.json'),'utf8'));
  const call=(operation:string,input:unknown={},status=200,requestId=randomUUID())=>api('POST','/api/agent',{operation,input,requestId},status,grant.token);
  writeFileSync(join(path,'observations.json'),JSON.stringify({attempts:100,completed:20,source:'isolated fixture'}));
  const evidence=await call('evidence.capture',{summary:'初始观察',path:'observations.json'});
  const context=await call('context');
  const understandingInput={kind:'assumption',title:'用户首次操作受阻',statement:'低完成率可能与首次流程有关，也可能是需求不匹配',relevance:'决定优先调查还是直接修改',verification:'结合路径数据检验竞争解释',status:'active',evidenceIds:[evidence.id],reviewAt:future()};
  const expectations=[{id:'finding',kind:'outcome',claim:'能区分首次操作受阻的原因',scope:'隔离项目的首次使用路径数据',source:{kind:'file',path:'observations.json'},verification:'检查数据能否区分竞争解释',disconfirm:'没有路径信息，仍无法区分原因',deadline:future()}];
  const reviewInput={assessment:{results:[{expectationId:'finding',verdict:'unknown',reason:'尚无充分的新观察',evidenceIds:[]}],conditions:'unknown',conditionReason:'观察条件还未核对',diagnosis:'uncertain',explanation:'需要补充判断依据',adjustment:'observe',understandingRefs:[]}};
  const decisionInput={expectations,objectiveVersion:context.strategy.objective.version,options:[{title:'先定位用户放弃的步骤',kind:'investigate',benefit:'减少盲目改动',cost:'一次分析',uncertainty:'当前数据是否区分不同原因'},{title:'直接简化注册',kind:'act',benefit:'可能减少操作',cost:'实现与发布成本',uncertainty:'没有证据说明注册是原因'}],selected:0,rationale:'先减少影响方向选择的不确定性',nextStep:'检查现有路径反馈并寻找信息缺口',expectedOutcome:'能区分技术问题与需求问题',evaluation:'检查事件覆盖及失败路径',stopWhen:'已有证据足以区分原因，或分析不再带来新信息',understandingRefs:[],evidenceIds:[evidence.id],watchIds:[],reviewAt:future(),maxRuns:2};
  return {...s,root,home,path,project,channel,run,grant,api,call,evidence,understandingInput,decisionInput,reviewInput,cleanup:async()=>{await s.close();rmSync(root,{recursive:true,force:true});}};
}
test('a new project has one open responsibility and scoped tools preserve decisions, alternatives and revision history',async()=>{const s=await setup();try{
  assert.equal(s.store.all('channels').length,1);assert.equal(s.channel.name,'自主推进');assert.equal(s.channel.status,'paused');assert.equal(s.channel.maxRunsPerDay,32);
  const u=await s.call('understanding.upsert',s.understandingInput);const input={...s.decisionInput,understandingRefs:[{id:u.id,revision:u.revision}]};const requestId=randomUUID();
  const d=await s.call('decision.choose',input,200,requestId);assert.deepEqual(await s.call('decision.choose',input,200,requestId),d);assert.equal(d.runsUsed,1);assert.equal(d.options.length,2);
  await s.call('decision.choose',s.decisionInput,409);await s.call('decision.choose',{...input,nextStep:'different'},409,requestId);
  const review=await s.call('decision.review',{...s.reviewInput,id:d.id,revision:1,outcome:'inconclusive',conclusion:'反馈尚不能区分原因',evidenceIds:[],nextDirection:'先补充关键路径观察'});
  assert.equal(review.objective.goal,s.project.goal);assert.equal(review.status,'reviewed');assert.equal(review.expectedOutcome,d.expectedOutcome);
  const read=await s.call('memory.read',{kind:'decision',id:d.id});assert.equal(read.history.length,2);assert.equal(read.history[1].status,'active');assert.equal(read.history[0].review.conclusion,review.review.conclusion);
  assert.equal(s.store.get<any>('projects',s.project.id).goal,s.project.goal);
}finally{await s.cleanup();}});
test('new evidence can invalidate an old basis; stale plans and missing evidence cannot become current facts',async()=>{const s=await setup();try{
  await s.call('understanding.upsert',{...s.understandingInput,kind:'fact',evidenceIds:[]},400);
  const u=await s.call('understanding.upsert',s.understandingInput);const d=await s.call('decision.choose',{...s.decisionInput,understandingRefs:[{id:u.id,revision:1}]});
  const changed=await s.call('understanding.upsert',{...s.understandingInput,id:u.id,revision:1,status:'invalidated',statement:'后续观察表明原解释不成立'});assert.equal(changed.revision,2);
  await s.call('understanding.upsert',{...s.understandingInput,id:u.id,revision:1},409);
  const context=await s.call('context');assert(context.strategy.decisions[0].reviewReasons.some((v:string)=>v.includes('依据')));
  await s.call('feature.upsert',{title:'延续旧方向',summary:'旧判断已经失效',kind:'feature',status:'investigating',evidenceIds:[],nextStep:'继续'},409);
  await s.call('release.propose',{},409);
  await s.call('decision.review',{...s.reviewInput,id:d.id,revision:1,outcome:'improved',conclusion:'应该改善了',evidenceIds:[],nextDirection:'继续'},400);
  await s.call('decision.review',{...s.reviewInput,id:d.id,revision:1,outcome:'inconclusive',conclusion:'原依据失效，需要调查竞争解释',evidenceIds:[s.evidence.id],nextDirection:'修正认识'});
  await s.call('feature.upsert',{title:'重新调查',summary:'复盘后调整',kind:'feature',status:'investigating',evidenceIds:[],nextStep:'采集新依据'});
  await s.call('decision.choose',{...s.decisionInput,understandingRefs:[{id:u.id,revision:1}]},409);
  const read=await s.call('memory.read',{kind:'understanding',id:u.id});assert.equal(read.history[1].statement,s.understandingInput.statement);assert.equal(read.record.status,'invalidated');
}finally{await s.cleanup();}});
test('goal changes reject stale selections and user guidance creates durable review signals without enabling paused work',async()=>{const s=await setup();try{
  const d=await s.call('decision.choose',s.decisionInput);s.engine.acceptNativeGuidance(s.channel.id);
  assert.equal(s.engine.control(s.channel.id).enabled,false);assert.equal(s.store.get<any>('channels',s.channel.id).nextRunAt,'');
  s.store.put('channels',{...s.channel,goal:'先验证目标人群是否需要这个产品'});
  const context=await s.call('context');assert(context.strategy.decisions[0].reviewReasons.some((v:string)=>v.includes('方向')));assert(context.strategy.decisions[0].reviewReasons.some((v:string)=>v.includes('指导')));
  await s.call('decision.review',{...s.reviewInput,id:d.id,revision:1,outcome:'abandoned',conclusion:'用户改变当前重点',evidenceIds:[],nextDirection:'验证需求'});
  await s.call('decision.choose',s.decisionInput,409);
  const next=await s.call('decision.choose',{...s.decisionInput,objectiveVersion:context.strategy.objective.version});assert.notEqual(next.objective.direction,d.objective.direction);
}finally{await s.cleanup();}});
test('attempt budgets and review deadlines schedule reflection while preserving manual pause and daily limits',async()=>{const s=await setup();try{
  const d=await s.call('decision.choose',{...s.decisionInput,maxRuns:1});
  assert.equal((await s.call('context')).strategy.decisions[0].reviewReasons.length,0);
  s.engine.setControl(s.channel.id,{enabled:true});s.store.put('channels',{...s.channel,nextRunAt:future()});
  s.engine.loop.strategy.finish(s.run as any);assert(Date.parse(s.store.get<any>('channels',s.channel.id).nextRunAt)<Date.now()+31000);
  const nextRun={...s.run,id:randomUUID(),startedAt:new Date().toISOString()};s.store.put('runs',nextRun);s.engine.loop.strategy.prepare(nextRun as any);
  assert(s.engine.loop.strategy.decisionView(s.store.get<any>('strategy_decisions',d.id),nextRun.id).reviewReasons.some(v=>v.includes('预算')));
  assert.equal(s.store.get<any>('channels',s.channel.id).maxRunsPerDay,32);
  s.engine.setControl(s.channel.id,{enabled:false});s.store.put('channels',{...s.channel,status:'paused',nextRunAt:''});s.engine.loop.strategy.finish(nextRun as any);assert.equal(s.store.get<any>('channels',s.channel.id).nextRunAt,'');
}finally{await s.cleanup();}});
test('shared feature ownership prevents duplicate work and relevant feedback wakes another responsible channel',async()=>{const s=await setup();try{
  const item=await s.call('feature.upsert',{title:'完成首次操作',summary:'共享功能',kind:'feature',status:'investigating',evidenceIds:[],nextStep:'调查'});
  const other=await s.api('POST','/api/channels',{projectId:s.project.id,name:'反馈来源',goal:'提供独立观察',runtime:'codex'},201);
  const watch={id:randomUUID(),projectId:s.project.id,channelId:other.id,runId:'source-run',itemId:item.id,title:'实际体验',url:'http://127.0.0.1/isolated',pointer:'/value',condition:'changed',intervalSeconds:30,deadline:future(),status:'watching',nextPollAt:future(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};s.store.put('loop_watches',watch);
  await s.call('decision.choose',{...s.decisionInput,itemId:item.id,watchIds:[watch.id]});
  const otherRun={...s.run,id:randomUUID(),channelId:other.id};s.store.put('runs',otherRun);s.engine.loop.prepare(otherRun as any);const secret=JSON.parse(readFileSync(join(s.home,'runs',otherRun.id,'agent-context.json'),'utf8'));const scope=s.engine.loop.authenticate(`Bearer ${secret.token}`);
  const context=s.engine.loop.context(scope,{});assert.equal(context.strategy.decisions.length,1);
  await assert.rejects(s.engine.loop.call(scope,{operation:'decision.choose',input:{...s.decisionInput,objectiveVersion:context.strategy.objective.version,itemId:item.id},requestId:randomUUID()}),/另一个频道/);
  s.engine.setControl(s.channel.id,{enabled:true});s.store.put('channels',{...s.channel,nextRunAt:future()});s.engine.loop.signal(other.id,watch.id,'收到独立反馈，原判断需要复查');
  assert(Date.parse(s.store.get<any>('channels',s.channel.id).nextRunAt)<Date.now()+6000);assert((await s.call('context')).strategy.decisions[0].reviewReasons.includes('收到独立反馈，原判断需要复查'));
}finally{await s.cleanup();}});
test('observing remains quiet until evidence or the earliest basis review deadline, and large memories have explicit full reads',async()=>{const s=await setup();try{
  const reviewAt=new Date(Date.now()+120000).toISOString();const u=await s.call('understanding.upsert',{...s.understandingInput,statement:'完整项目认识'.repeat(600),reviewAt});
  await s.call('decision.choose',{...s.decisionInput,options:[{...s.decisionInput.options[0],kind:'observe'}],understandingRefs:[{id:u.id,revision:1}],maxRuns:1});
  s.engine.setControl(s.channel.id,{enabled:true});s.store.put('channels',{...s.channel,nextRunAt:future()});s.engine.loop.strategy.finish(s.run as any);
  assert.equal(s.store.get<any>('channels',s.channel.id).nextRunAt,reviewAt);
  const context=await s.call('context');assert.equal(context.strategy.understanding[0].truncated,true);assert.equal(context.strategy.understanding[0].statement.length,500);
  assert.equal((await s.call('memory.read',{kind:'understanding',id:u.id})).record.statement,u.statement);
}finally{await s.cleanup();}});
test('old lessons stay searchable beyond context limits with cross-project isolation and full reads',async()=>{const s=await setup();try{
  const old=await s.call('understanding.upsert',{...s.understandingInput,title:'过去验证的价格问题',status:'retired'});
  for(let i=0;i<100;i++)s.store.put('strategy_understanding',{...old,id:`recent-${i}`,title:`其他认识 ${i}`,status:'active',updatedAt:new Date(Date.now()+i+1).toISOString()});
  s.store.put('strategy_understanding',{...old,id:'foreign',projectId:'other-project',title:'过去验证的价格问题'});
  const context=await s.call('context');assert(!context.strategy.understanding.some((r:any)=>r.id===old.id));assert.equal(context.strategy.counts.understanding,101);
  const search=await s.call('memory.search',{query:'价格问题',limit:1});assert.equal(search.matches.length,1);assert.equal(search.matches[0].id,old.id);assert.equal(search.matches[0].status,'retired');assert.equal(search.hasMore,false);
  assert.equal((await s.call('memory.read',{kind:'understanding',id:old.id})).record.statement,old.statement);
  await s.call('memory.read',{kind:'understanding',id:'foreign'},404);await s.call('understanding.upsert',{...s.understandingInput,id:'foreign',revision:1},404);
  const first=await s.call('memory.search',{query:'其他认识',limit:30});assert.equal(first.matches.length,30);assert.equal(first.hasMore,true);assert.equal(first.nextOffset,30);
}finally{await s.cleanup();}});
test('database restart retains project understanding, decision references, original expectations and manual settings',async()=>{const s=await setup();let restarted:Awaited<ReturnType<typeof startServer>>|undefined;try{
  const u=await s.call('understanding.upsert',s.understandingInput);const d=await s.call('decision.choose',{...s.decisionInput,understandingRefs:[{id:u.id,revision:1}]});
  s.store.put('runs',{...s.run,status:'completed'});const channel=s.store.get('channels',s.channel.id);await s.close();
  restarted=await startServer({home:s.home,port:0});assert.deepEqual(restarted.store.get('channels',s.channel.id),channel);const view=restarted.engine.loop.view(s.project.id);
  assert.equal(view.strategy?.decisions[0].id,d.id);assert.equal(view.strategy?.decisions[0].runsUsed,1);assert.equal(view.strategy?.understanding[0].statement,u.statement);assert.equal(restarted.store.all('strategy_revisions').length,2);
}finally{await restarted?.close();await s.cleanup();}});

test('related memory recalls an old failed approach beyond the recent window without importing other projects or metadata',async()=>{const s=await setup();try{
  const old=await s.call('decision.choose',{...s.decisionInput,options:[{...s.decisionInput.options[0],title:'首次使用的材料核验'}]});
  const observed=await s.call('evidence.capture',{summary:'后续数据仍没有路径信息',path:'observations.json'});
  const reviewed=await s.call('decision.review',{...s.reviewInput,id:old.id,revision:1,outcome:'not_improved',assessment:{...s.reviewInput.assessment,conditions:'matched',conditionReason:'同一隔离样本与采集方式',results:[{expectationId:'finding',verdict:'not_met',reason:'记录仍没有路径字段，无法区分解释',evidenceIds:[observed.id]}]},conclusion:'材料核验未解决首次使用时缺少原始引用的问题',evidenceIds:[s.evidence.id],nextDirection:'比较证据审计与直接改写'});
  for(let i=0;i<30;i++)s.store.put('strategy_decisions',{...reviewed,id:`unrelated-${i}`,options:[{...reviewed.options[0],title:`颜色设置 ${i}`}],selected:0,rationale:'颜色配置',nextStep:'调色',expectedOutcome:'区分颜色',review:{...reviewed.review,conclusion:'颜色清晰',nextDirection:'保持配色'}});
  const invalid=await s.call('understanding.upsert',{...s.understandingInput,title:'首次使用不需要原始引用',statement:'后续材料核验反馈推翻了这个判断',status:'invalidated'});
  s.store.put('strategy_decisions',{...reviewed,id:'private-other-project',projectId:'foreign',options:[{...reviewed.options[0],title:'材料核验'}]});
  const context=await s.call('context');assert(!context.strategy.decisions.some((row:any)=>row.id===old.id));assert(context.strategy.relatedMemory.matches.some((row:any)=>row.id===old.id));
  const recall=await s.api('POST','/api/agent',{operation:'memory.recall',input:{query:'准备完善材料核验的原始引用',limit:4}},200,s.grant.token);
  assert(recall.matches.some((row:any)=>row.id===old.id&&row.outcome==='not_improved'));
  assert(recall.matches.some((row:any)=>row.id===invalid.id&&row.status==='invalidated'));
  assert(!recall.matches.some((row:any)=>row.id==='private-other-project'));assert.equal((await s.call('memory.recall',{query:'private-other-project'})).matches.length,0);
  assert((await s.call('memory.read',{kind:'decision',id:old.id})).record.review.conclusion.includes('未解决'));
  assert.equal((await s.call('memory.recall',{query:'totallyunrelatedword'})).matches.length,0);
  const cli=fileURLToPath(new URL('../service/agent-cli.ts',import.meta.url));
  const {stdout}=await promisify(execFile)(process.execPath,[cli,'--context',join(s.home,'runs',s.run.id,'agent-context.json'),'--operation','memory.recall']);
  assert(JSON.parse(stdout).matches.some((row:any)=>row.id===old.id));
}finally{await s.cleanup();}});

test('feature-linked recall is bounded, independent of wording and strictly scoped',async()=>{const s=await setup();try{
  const item=await s.call('feature.upsert',{title:'材料交付',summary:'可追溯结果',kind:'feature',status:'investigating',evidenceIds:[],nextStep:'调查'});
  const learning=await s.call('learning.upsert',{itemId:item.id,kind:'experiment',title:'Old delivery test',rationale:'Manual review',expectedResult:'Traceable source',evaluation:'Read the references',conclusion:'References missing',status:'refuted',evidenceIds:[s.evidence.id]});
  const result=await s.call('memory.recall',{itemId:item.id,query:'中文新方向',limit:1});assert.equal(result.matches[0].id,learning.id);assert(result.matches[0].reasons.includes('同一 feature 的历史记录'));
  assert((await s.call('context',{itemId:item.id})).strategy.relatedMemory.matches.some((row:any)=>row.id===learning.id));
  s.store.put('items',{...item,id:'foreign-feature',projectId:'foreign'});await s.call('memory.recall',{itemId:'foreign-feature'},404);
  await s.call('memory.recall',{limit:1000},400);
}finally{await s.cleanup();}});

test('decisions preserve the applicability rationale and reject direct reuse of failed or stale experience',async()=>{const s=await setup();try{
  const u=await s.call('understanding.upsert',{...s.understandingInput,status:'invalidated',statement:'旧方案缺少原始引用。'.repeat(100)});
  const ref={kind:'understanding',id:u.id,revision:1,use:'apply',reason:'直接使用'};
  await s.call('decision.choose',{...s.decisionInput,memoryRefs:[ref]},409);
  const input={...s.decisionInput,memoryRefs:[{...ref,use:'adapt',reason:'保留材料检查，新增原文引用，并重新验证可交付性'}]};
  const requestId=randomUUID();const d=await s.call('decision.choose',input,200,requestId);
  assert.deepEqual(await s.call('decision.choose',input,200,requestId),d);
  assert.equal(d.memoryRefs[0].snapshot.status,'invalidated');assert.equal(d.memoryRefs[0].snapshot.truncated,true);assert.equal(d.memoryRefs[0].reason,input.memoryRefs[0].reason);
  await s.call('understanding.upsert',{...s.understandingInput,id:u.id,revision:1,status:'active',statement:'补充引用后可以验证交付能力'});
  const read=await s.call('memory.read',{kind:'decision',id:d.id});assert.equal(read.record.memoryRefs[0].snapshot.status,'invalidated');assert.equal(read.history[0].memoryRefs[0].revision,1);
  await s.call('feature.upsert',{title:'继续推进',summary:'先复查经验变化',kind:'feature',status:'investigating',evidenceIds:[],nextStep:'继续'},409);
  await s.call('decision.review',{...s.reviewInput,id:d.id,revision:1,outcome:'inconclusive',conclusion:'旧经验已更新，重新评估适用条件',evidenceIds:[],nextDirection:'读取最新经验'});
  await s.call('decision.choose',input,409);
  const next=await s.call('decision.choose',{...input,memoryRefs:[{...ref,revision:2,use:'apply',reason:'新认识已针对当前范围复查，继续验证'}]});assert.equal(next.memoryRefs[0].snapshot.status,'active');
}finally{await s.cleanup();}});

test('a failed decision remains a lesson with conditions rather than a directly reusable success',async()=>{const s=await setup();try{
  const d=await s.call('decision.choose',s.decisionInput);
  const observed=await s.call('evidence.capture',{summary:'后续数据仍没有路径信息',path:'observations.json'});
  await s.call('decision.review',{...s.reviewInput,id:d.id,revision:1,outcome:'not_improved',assessment:{...s.reviewInput.assessment,conditions:'matched',conditionReason:'同一隔离样本与采集方式',results:[{expectationId:'finding',verdict:'not_met',reason:'记录仍没有路径字段，无法区分解释',evidenceIds:[observed.id]}]},conclusion:'没有得到区分原因的证据',evidenceIds:[s.evidence.id],nextDirection:'补齐观测'});
  const ref={kind:'decision',id:d.id,revision:2,use:'apply',reason:'重做一次'};
  await s.call('decision.choose',{...s.decisionInput,memoryRefs:[ref]},409);
  const next=await s.call('decision.choose',{...s.decisionInput,memoryRefs:[{...ref,use:'avoid',reason:'避免重复使用无法区分原因的数据，先补充关键观测'}]});
  assert.equal(next.memoryRefs[0].snapshot.outcome,'not_improved');assert.equal(next.memoryRefs[0].snapshot.evidenceIds[0],s.evidence.id);
  assert(s.engine.loop.view(s.project.id).evidence.some(row=>row.id===s.evidence.id));
}finally{await s.cleanup();}});

test('revised learning wakes its dependent channel, preserves full versions and does not unpause work',async()=>{const s=await setup();try{
  const input={kind:'experiment',title:'独立审计有效范围',rationale:'小样本验证',expectedResult:'证据可以独立核验',evaluation:'检查引用',conclusion:'样例可核验',status:'supported',evidenceIds:[s.evidence.id]};
  const lesson=await s.call('learning.upsert',input);
  const d=await s.call('decision.choose',{...s.decisionInput,memoryRefs:[{kind:'learning',id:lesson.id,revision:1,use:'adapt',reason:'扩大样本后重新核验，不能把小样本当作普遍有效'}]});
  await s.call('learning.upsert',{...input,id:lesson.id,revision:1,status:'refuted',conclusion:'扩大样本后发现引用丢失'});
  assert.equal(s.store.get<any>('channels',s.channel.id).nextRunAt,'');assert.equal(s.engine.control(s.channel.id).enabled,false);
  assert((await s.call('context')).strategy.decisions.find((row:any)=>row.id===d.id).reviewReasons.some((reason:string)=>reason.includes('参考经验')));
  const read=await s.call('memory.read',{kind:'learning',id:lesson.id});assert.equal(read.history.length,2);assert.equal(read.history[1].conclusion,'样例可核验');assert.equal(read.history[0].status,'refuted');
  s.engine.setControl(s.channel.id,{enabled:true});s.store.put('channels',{...s.channel,nextRunAt:future()});
  await s.call('learning.upsert',{...input,id:lesson.id,revision:2,status:'inconclusive',conclusion:'正在区分样本条件'});
  assert(Date.parse(s.store.get<any>('channels',s.channel.id).nextRunAt)<Date.now()+6000);
}finally{await s.cleanup();}});

test('memory references survive restart and legacy learning gains versions only from its available state',async()=>{const s=await setup();let restarted:Awaited<ReturnType<typeof startServer>>|undefined;try{
  const input={kind:'experiment',title:'旧版本经验',rationale:'旧实验',expectedResult:'目标效果',evaluation:'反馈',conclusion:'现存旧结论',status:'inconclusive',evidenceIds:[]};
  s.store.put('loop_learning',{...input,id:'legacy-lesson',projectId:s.project.id,channelId:s.channel.id,runId:s.run.id,revision:7,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  await s.call('learning.upsert',{...input,id:'legacy-lesson',revision:7,conclusion:'新复盘'});
  const history=await s.call('memory.read',{kind:'learning',id:'legacy-lesson'});assert.deepEqual(history.history.map((row:any)=>row.revision),[8,7]);
  const d=await s.call('decision.choose',{...s.decisionInput,memoryRefs:[{kind:'learning',id:'legacy-lesson',revision:8,use:'not_applicable',reason:'当前条件不同，保留比较记录'}]});
  await s.call('learning.upsert',{...input,id:'legacy-lesson',revision:8,conclusion:'不影响本次方向的变化'});
  assert.equal((await s.call('context')).strategy.decisions.find((row:any)=>row.id===d.id).reviewReasons.length,0);
  s.store.put('runs',{...s.run,status:'completed'});await s.close();restarted=await startServer({home:s.home,port:0});
  assert.deepEqual(restarted.store.get<any>('strategy_decisions',d.id).memoryRefs,d.memoryRefs);
  assert.equal(restarted.store.get<any>('strategy_revisions','learning:legacy-lesson:7').data.conclusion,'现存旧结论');
}finally{await restarted?.close();await s.cleanup();}});

test('memory references reject foreign and duplicate records and preserve a future review boundary',async()=>{const s=await setup();try{
  const reviewAt=new Date(Date.now()+120000).toISOString();const u=await s.call('understanding.upsert',{...s.understandingInput,reviewAt});
  s.store.put('strategy_understanding',{...u,id:'foreign-memory',projectId:'foreign'});
  const ref={kind:'understanding',id:u.id,revision:1,use:'adapt',reason:'把已有方法用于更大样本并验证'};
  await s.call('decision.choose',{...s.decisionInput,memoryRefs:[{...ref,id:'foreign-memory'}]},404);
  await s.call('decision.choose',{...s.decisionInput,memoryRefs:[ref,ref]},400);
  await s.call('decision.choose',{...s.decisionInput,memoryRefs:[{...ref,reason:''}]},400);
  const d=await s.call('decision.choose',{...s.decisionInput,options:[{...s.decisionInput.options[0],kind:'observe'}],memoryRefs:[ref]});
  s.engine.setControl(s.channel.id,{enabled:true});s.store.put('channels',{...s.channel,nextRunAt:future()});s.engine.loop.strategy.finish(s.run as any);
  assert.equal(s.store.get<any>('channels',s.channel.id).nextRunAt,reviewAt);
  const earlier=new Date(Date.now()-10000).toISOString();s.store.put('strategy_decisions',{...d,createdAt:earlier});s.store.put('strategy_understanding',{...u,reviewAt:new Date(Date.now()-1000).toISOString()});
  assert((await s.call('context')).strategy.decisions[0].reviewReasons.some((reason:string)=>reason.includes('参考经验')));
}finally{await s.cleanup();}});

test('large learning history cannot bury automatic recall and full records remain readable',async()=>{const s=await setup();try{
  const old=await s.call('learning.upsert',{kind:'experiment',title:'首次使用的原文核验',rationale:'检查证据是否匹配',expectedResult:'保留引用',evaluation:'逐条核对',conclusion:'完整结论。'.repeat(900),status:'inconclusive',evidenceIds:[]});
  for(let i=0;i<165;i++)s.store.put('loop_learning',{...old,id:`later-${i}`,title:`颜色方案 ${i}`,rationale:'主题颜色',expectedResult:'不同色彩',evaluation:'主题对比',conclusion:'配色记录。'.repeat(900)});
  const context=await s.call('context');assert.equal(context.learning.length,12);assert.deepEqual({...context.learningCoverage,readMore:undefined},{total:166,included:12,partial:true,readMore:undefined});assert.equal(context.learning[0].truncated,true);assert.equal(context.learning[0].conclusion.length,500);
  assert(context.strategy.relatedMemory.matches.some((r:any)=>r.id===old.id));assert(Object.keys(context).indexOf('strategy')<Object.keys(context).indexOf('learning'));
  assert.equal((await s.call('memory.read',{kind:'learning',id:old.id})).record.conclusion,old.conclusion);assert.equal(s.store.all('loop_learning').length,166);
}finally{await s.cleanup();}});
