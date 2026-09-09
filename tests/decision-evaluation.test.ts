import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { startServer } from '../service/server.ts';
import { FakeReviewer } from './fake-reviewer.ts';
process.env.MORROW_TEST_MODE='1';
const future=()=>new Date(Date.now()+3600000).toISOString();
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'nh-evaluation-')),home=join(root,'home'),path=join(root,'project');mkdirSync(path);
  const s=await startServer({home,port:0}),token=readFileSync(join(home,'token'),'utf8');
  const request=async(method:string,route:string,input:unknown,auth=token,status=200)=>{const res=await fetch(`http://127.0.0.1:${s.port}${route}`,{method,headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:JSON.stringify(input)});const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;};
  const project=await request('POST','/api/projects',{name:'反馈核对隔离夹具',path,goal:'提高交付完成率，同时保持交付内容完整'},token,201),channel=s.store.all<any>('channels')[0];
  const run={id:randomUUID(),projectId:project.id,channelId:channel.id,runtime:'codex',status:'running',source:'morrow-schedule',executionOwner:'codex-app',startedAt:new Date().toISOString(),finishedAt:'',summary:'',sessionId:'evaluation-fixture',workDirection:channel.goal};s.store.put('runs',run);s.engine.loop.prepare(run as any);
  const grant=JSON.parse(readFileSync(join(home,'runs',run.id,'agent-context.json'),'utf8'));
  const call=(operation:string,input:unknown={},status=200,requestId=randomUUID())=>request('POST','/api/agent',{operation,input,requestId},grant.token,status);
  const context=await call('context');
  const expectation={id:'completion',kind:'outcome',claim:'交付完成率至少为 80%',scope:'隔离样本，同一交付规则',source:{kind:'file',path:'result.json'},verification:'独立运行交付样例后读取结果',disconfirm:'完成率低于 0.8',deadline:future(),rule:{pointer:'/completion',operator:'gte',expected:0.8}};
  const guardrail={...expectation,id:'integrity',kind:'guardrail',claim:'不丢失交付内容',disconfirm:'出现内容缺失',rule:{pointer:'/missing',operator:'equals',expected:0}};
  const input={objectiveVersion:context.strategy.objective.version,options:[{title:'验证交付过程',kind:'investigate',benefit:'判断是否值得扩大投入',cost:'一轮隔离验证',uncertainty:'真实用户收益未知'}],selected:0,rationale:'先核对实际效果',nextStep:'运行隔离样例',expectedOutcome:'完成率提高且保持内容完整',evaluation:'核对原始样例结果',stopWhen:'约束恶化或结果不足以判断时调整',evidenceIds:[],understandingRefs:[],watchIds:[],reviewAt:future(),maxRuns:3,expectations:[expectation,guardrail]};
  const capture=async(data:unknown,file='result.json')=>{writeFileSync(join(path,file),typeof data==='string'?data:JSON.stringify(data));return call('evidence.capture',{summary:'隔离夹具实际采集',path:file});};
  const assessment=(evidenceId?:string)=>({results:[{expectationId:'completion',verdict:'met',reason:'字段达到预先约定值',evidenceIds:evidenceId?[evidenceId]:[]},{expectationId:'integrity',verdict:'met',reason:'没有缺失',evidenceIds:evidenceId?[evidenceId]:[]}],conditions:'matched',conditionReason:'同一隔离样本、版本和统计方式',diagnosis:'expected',explanation:'仅说明本次隔离结果，真实用户效果仍未知',adjustment:'observe',understandingRefs:[]});
  const review=(d:any,a:unknown,outcome='improved',status=200,requestId=randomUUID())=>call('decision.review',{id:d.id,revision:d.revision,outcome,conclusion:'按原始条件核对',evidenceIds:[],nextDirection:'依据真实结果决定下一步',assessment:a},status,requestId);
  return {...s,root,home,path,project,channel,run,call,input,expectation,guardrail,capture,assessment,review,cleanup:async()=>{await s.close();rmSync(root,{recursive:true,force:true});}};
}

test('numeric expectations cannot report success over a violated guardrail, and review remains immutable across restart',async()=>{
  const s=await fixture();let reopened:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
    const d=await s.call('decision.choose',s.input);const e=await s.capture({completion:0.95,missing:2});
    await s.review(d,s.assessment(e.id),'improved',400);
    const a={...s.assessment(e.id),diagnosis:'execution',adjustment:'method',results:s.assessment(e.id).results.map(r=>r.expectationId==='integrity'?{...r,verdict:'not_met',reason:'实际缺失两项内容'}:r)};
    await s.review(d,a,'improved',400);
    const requestId=randomUUID(),reviewed=await s.review(d,a,'not_improved',200,requestId);
    assert.deepEqual(await s.review(d,a,'not_improved',200,requestId),reviewed);
    assert.equal(reviewed.review.assessment.results[1].observedValue,2);assert.equal(reviewed.review.assessment.results[1].checkedBy,'rule');
    assert.deepEqual(reviewed.expectations,d.expectations);assert.deepEqual(reviewed.review.evidenceIds,[e.id]);
    await s.call('decision.review',{id:d.id,revision:2,outcome:'improved',expectations:[]},400);
    const history=await s.call('memory.read',{kind:'decision',id:d.id});assert.equal(history.history[1].review,undefined);
    s.store.put('runs',{...s.run,status:'completed'});await s.close();reopened=await startServer({home:s.home,port:0});
    assert.deepEqual(reopened.store.get<any>('strategy_decisions',d.id).review.assessment,reviewed.review.assessment);
    assert.equal(reopened.engine.control(s.channel.id).enabled,false);
  }finally{await reopened?.close();await s.cleanup();}
});
test('strict rule values, missing data and observation maturity cannot be replaced by optimistic prose',async()=>{
  const s=await fixture();try{
    const d=await s.call('decision.choose',s.input),e=await s.capture({completion:'0.95',missing:0});
    await s.review(d,s.assessment(e.id),'improved',400);
    const a={...s.assessment(e.id),diagnosis:'measurement',adjustment:'measurement',results:s.assessment(e.id).results.map(r=>r.expectationId==='completion'?{...r,verdict:'unknown',reason:'采集字段类型不符合约定'}:r)};
    await s.review(d,a,'not_improved',400);const result=await s.review(d,a,'inconclusive');assert.equal(result.review.assessment.results[0].observedValue,'0.95');
    const next=await s.call('decision.choose',{...s.input,expectations:s.input.expectations.map(e=>({...e,notBefore:new Date(Date.now()+60000).toISOString()}))});
    const early=await s.capture({completion:0.99,missing:0});await s.review(next,s.assessment(early.id),'improved',400);
    await s.review(next,{...s.assessment(early.id),diagnosis:'pending',results:s.assessment(early.id).results.map(r=>({...r,verdict:'unknown'}))},'inconclusive');
  }finally{await s.cleanup();}
});
test('old baseline, wrong source, agent assertions and omitted newer evidence cannot establish improvement',async()=>{
  const s=await fixture();try{
    const baseline=await s.capture({completion:1,missing:0}),d=await s.call('decision.choose',s.input);
    // Identical timestamps still cannot turn a pre-decision row into new evidence.
    s.store.put('loop_evidence',{...baseline,createdAt:d.createdAt,observedAt:d.createdAt});
    await s.review(d,s.assessment(baseline.id),'improved',400);
    const wrong=await s.capture({completion:1,missing:0},'other.json');await s.review(d,s.assessment(wrong.id),'improved',400);
    const agent=await s.call('evidence.record',{summary:'声称成功',source:join(s.path,'result.json'),observedAt:new Date().toISOString(),data:{completion:1,missing:0}});await s.review(d,s.assessment(agent.id),'improved',400);
    const good=await s.capture({completion:1,missing:0}),bad=await s.capture({completion:0.5,missing:0});
    await s.review(d,s.assessment(good.id),'improved',409);
    const a={...s.assessment(bad.id),diagnosis:'uncertain',results:s.assessment(bad.id).results.map(r=>r.expectationId==='completion'?{...r,verdict:'not_met'}:r)};
    const result=await s.review(d,a,'not_improved');assert.equal(result.review.assessment.diagnosis,'uncertain');
  }finally{await s.cleanup();}
});
test('changed conditions retain the measured values without calling them a comparable improvement',async()=>{
  const s=await fixture();try{
    const d=await s.call('decision.choose',s.input),e=await s.capture({completion:1,missing:0});
    const a={...s.assessment(e.id),conditions:'changed',conditionReason:'后续样本排除了困难交付',diagnosis:'environment',adjustment:'measurement'};
    await s.review(d,a,'improved',400);const result=await s.review(d,a,'inconclusive');
    assert.equal(result.review.assessment.results[0].observedValue,1);assert.equal(result.review.assessment.conditions,'changed');
  }finally{await s.cleanup();}
});
test('assumption reconsideration must persist a changed understanding and preserves the referenced version',async()=>{
  const s=await fixture();try{
    const uInput={kind:'assumption',title:'流程步骤是主要阻碍',statement:'当前怀疑步骤太多',relevance:'决定是否简化步骤',verification:'观察具体放弃原因',status:'active',evidenceIds:[],reviewAt:future()};
    const u=await s.call('understanding.upsert',uInput),d=await s.call('decision.choose',{...s.input,understandingRefs:[{id:u.id,revision:1}]}),e=await s.capture({completion:0.4,missing:0});
    const a={...s.assessment(e.id),diagnosis:'assumption',adjustment:'assumption',explanation:'现有结果不支持继续按原解释投入，需检验竞争解释',results:s.assessment(e.id).results.map(r=>r.expectationId==='completion'?{...r,verdict:'not_met'}:r),understandingRefs:[] as any[]};
    await s.review(d,a,'not_improved',400);await s.review(d,{...a,understandingRefs:[{id:u.id,revision:1}]},'not_improved',400);
    const changed=await s.call('understanding.upsert',{...uInput,id:u.id,revision:1,statement:'仍无法证明步骤是原因，下一步检验内容是否满足需求',evidenceIds:[e.id]});
    const result=await s.review(d,{...a,understandingRefs:[{id:u.id,revision:changed.revision}]},'not_improved');
    assert.deepEqual(result.review.assessment.understandingRefs,[{id:u.id,revision:2}]);
    const recall=await s.call('memory.recall',{query:'竞争解释'});assert(recall.matches.some((r:any)=>r.id===d.id));
    const history=await s.call('memory.read',{kind:'understanding',id:u.id});assert.equal(history.history[1].statement,uInput.statement);
  }finally{await s.cleanup();}
});
test('qualitative checks are explicitly agent interpretations; missing or duplicate checks fail closed',async()=>{
  const s=await fixture();try{
    const d=await s.call('decision.choose',{...s.input,expectations:[{...s.expectation,rule:undefined}]}),e=await s.capture('隔离交付样例：每项结果都有可查来源。');
    const a={...s.assessment(e.id),results:[{expectationId:'completion',verdict:'met',reason:'逐项检查后能够核对来源，限于此次样例',evidenceIds:[e.id]}]};
    await s.review(d,{...a,results:[]},'improved',400);
    const pending=await s.review(d,a);assert.equal(pending.pendingVerification,true);
    const reviewer=new FakeReviewer();reviewer.autoComplete=true;s.engine.loop.verification.connect(reviewer,v=>v);await s.engine.loop.verification.start(pending.verificationId);
    const result=s.store.get<any>('strategy_decisions',d.id);assert.equal(result.review.assessment.results[0].checkedBy,'agent');assert.equal(result.review.assessment.results[0].observedValue,undefined);
    const next=await s.call('decision.choose',s.input);await s.review(next,{...s.assessment(),results:[a.results[0],a.results[0]]},'inconclusive',400);
  }finally{await s.cleanup();}
});
test('new choices require an observation contract, reject foreign sources, and legacy reviews remain readable',async()=>{
  const s=await fixture();try{
    await s.call('decision.choose',{...s.input,expectations:undefined},400);
    await s.call('decision.choose',{...s.input,expectations:[{...s.expectation,source:{kind:'file',path:'../outside.json'}}]},403);
    symlinkSync(s.root,join(s.path,'outside-link'));await s.call('decision.choose',{...s.input,expectations:[{...s.expectation,source:{kind:'file',path:'outside-link/not-created.json'}}]},403);
    await s.call('decision.choose',{...s.input,expectations:[{...s.expectation,source:{kind:'watch',watchId:'foreign'}}]},404);
    await s.call('decision.choose',{...s.input,expectations:[s.expectation,s.expectation]},400);
    const d=await s.call('decision.choose',s.input);const {evaluationVersion,expectations,evidenceCursor,...legacy}=d;s.store.put('strategy_decisions',legacy);
    const result=await s.call('decision.review',{id:d.id,revision:1,outcome:'inconclusive',conclusion:'旧版尚未保存逐项预期',evidenceIds:[],nextDirection:'下一次使用新的核对方式'});
    assert.equal(result.evaluationVersion,undefined);assert.equal(result.review.assessment,undefined);
  }finally{await s.cleanup();}
});
test('unchanged HTTP data is freshly sampled for a new contract and changes to another expected field also wake dependent work',async()=>{
  const s=await fixture();let data={completion:0.9,missing:0};const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    const url=`http://127.0.0.1:${(server.address() as any).port}/metrics`;
    const watch=await s.call('watch.create',{title:'隔离交付观察',url,pointer:'/completion',condition:'changed',intervalSeconds:30,deadline:future()});
    await s.engine.loop.poll(watch.id);const initial=s.store.get<any>('loop_watches',watch.id).lastEvidenceId;
    const d=await s.call('decision.choose',{...s.input,expectations:s.input.expectations.map(e=>({...e,source:{kind:'watch',watchId:watch.id}}))});
    await s.engine.loop.poll(watch.id);const fresh=s.store.get<any>('loop_watches',watch.id).lastEvidenceId;assert.notEqual(fresh,initial);
    assert.equal(s.store.get<any>('loop_evidence',fresh).watchId,watch.id);assert.equal(s.engine.control(s.channel.id).enabled,false);
    const count=s.store.all('loop_evidence').length;await s.engine.loop.poll(watch.id);assert.equal(s.store.all('loop_evidence').length,count);
    data={completion:0.9,missing:3};await s.engine.loop.poll(watch.id);const latest=s.store.get<any>('loop_watches',watch.id).lastEvidenceId;assert.notEqual(latest,fresh);
    await s.review(d,s.assessment(fresh),'improved',409);const a={...s.assessment(latest),diagnosis:'execution',adjustment:'method',results:s.assessment(latest).results.map(r=>r.expectationId==='integrity'?{...r,verdict:'not_met'}:r)};
    await s.review(d,a,'not_improved');assert.equal(s.store.get<any>('channels',s.channel.id).nextRunAt,'');
  }finally{await new Promise<void>(r=>server.close(()=>r()));await s.cleanup();}
});
test('an invalid object field remains unknown without continuously creating identical HTTP evidence',async()=>{
  const s=await fixture();const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({completion:{invalid:true},missing:0}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));try{
    const watch=await s.call('watch.create',{title:'错误类型夹具',url:`http://127.0.0.1:${(server.address() as any).port}/metrics`,pointer:'/missing',condition:'changed',intervalSeconds:30,deadline:future()});
    const d=await s.call('decision.choose',{...s.input,expectations:s.input.expectations.map(e=>({...e,source:{kind:'watch',watchId:watch.id}}))});
    await s.engine.loop.poll(watch.id);const count=s.store.all('loop_evidence').length;await s.engine.loop.poll(watch.id);assert.equal(s.store.all('loop_evidence').length,count);
    const id=s.store.get<any>('loop_watches',watch.id).lastEvidenceId;
    const a={...s.assessment(id),diagnosis:'measurement',adjustment:'measurement',results:s.assessment(id).results.map(r=>r.expectationId==='completion'?{...r,verdict:'unknown'}:r)};
    const result=await s.review(d,a,'inconclusive');assert.equal(result.review.assessment.results[0].observedValue,null);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await s.cleanup();}
});
test('the same misleading success claim passes the legacy evidence-presence gate but is rejected with the observation contract',async()=>{
  const s=await fixture();try{
    const d=await s.call('decision.choose',s.input),e=await s.capture({completion:0.95,missing:2});
    await s.review(d,s.assessment(e.id),'improved',400);
    const {evaluationVersion,expectations,evidenceCursor,...legacy}=d;s.store.put('strategy_decisions',legacy);
    const old=await s.call('decision.review',{id:d.id,revision:1,outcome:'improved',conclusion:'完成率达到目标，所以成功',evidenceIds:[e.id],nextDirection:'扩大投入'});
    assert.equal(old.review.outcome,'improved');assert.equal(old.review.assessment,undefined);
  }finally{await s.cleanup();}
});

function measured(s:Awaited<ReturnType<typeof fixture>>,baseline:{evidenceId:string}|{unavailable:string}){
  return {...s.expectation,rule:{pointer:'/completion',operator:'gte',expected:0.25},measurement:{metric:'完成交付的用户数 / 全部开始交付的用户数；比例 0..1',goalRelation:'观察真实交付成功是否提高',limitation:'隔离采集样本；未证明真实用户收益或因果关系',comparison:'delta',baseline,freshness:{pointer:'/generatedAt',maxAgeSeconds:300},checks:[{label:'足够样本',pointer:'/sampleSize',operator:'gte',expected:100},{label:'采集完整',pointer:'/complete',operator:'equals',expected:true},{label:'相同人群与口径',pointer:'/population',operator:'equals',expected:'all-started-v1'}]}};
}
const sample=(extra:Record<string,unknown>={})=>({completion:0.5,sampleSize:100,complete:true,population:'all-started-v1',generatedAt:new Date().toISOString(),...extra});
function measuredAssessment(s:Awaited<ReturnType<typeof fixture>>,evidenceId:string,verdict='met'){
  return {...s.assessment(evidenceId),results:[{expectationId:'completion',verdict,reason:'仅按原始观测条件核对',evidenceIds:[evidenceId]}]};
}
test('measurement loop rejects attractive numbers with insufficient samples, then applies an independently reviewed baseline comparison and preserves it on restart',async()=>{
  const s=await fixture();let reopened:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
    const baseline=await s.capture(sample()),expectation=measured(s,{evidenceId:baseline.id});
    const d=await s.call('decision.choose',{...s.input,expectations:[expectation]});
    assert.equal(d.observations[0].baselineValue,0.5);assert.equal(d.observations[0].status,'waiting');
    const bad=await s.capture(sample({completion:1,sampleSize:2}));
    const gaps=await s.call('observation.read',{decisionId:d.id});assert.equal(gaps.observations[0].verdict,'unknown');assert.match(gaps.observations[0].issues.join(' '),/足够样本/);
    await s.review(d,measuredAssessment(s,bad.id),'improved',400);
    await s.call('verification.request',{decisionId:d.id,evidenceIds:[bad.id]},409);assert.equal(s.store.all('loop_verifications').length,0);
    const good=await s.capture(sample({completion:0.875}));
    const ready=(await s.call('context')).strategy.decisions.find((r:any)=>r.id===d.id).observations[0];
    assert.equal(ready.status,'ready');assert.equal(ready.baselineValue,0.5);assert.equal(ready.observedValue,0.875);assert.equal(ready.comparedValue,0.375);assert.equal(ready.verdict,'met');
    const pending=await s.review(d,measuredAssessment(s,good.id));assert.equal(pending.pendingVerification,true);
    const verification=s.store.get<any>('loop_verifications',pending.verificationId);assert(verification.evidenceIds.includes(baseline.id));assert(verification.prompt.includes('all-started-v1'));
    const reviewer=new FakeReviewer();reviewer.autoComplete=true;s.engine.loop.verification.connect(reviewer,v=>v);await s.engine.loop.verification.start(pending.verificationId);
    const final=s.store.get<any>('strategy_decisions',d.id);assert.equal(final.status,'reviewed');assert.equal(final.review.outcome,'improved');assert.deepEqual(final.expectations,d.expectations);assert.equal(final.review.assessment.results[0].observation.comparedValue,0.375);
    assert.equal(s.store.all<any>('loop_finalizations').find(r=>r.targetId===d.id).status,'applied');
    const read=await s.call('observation.read',{decisionId:d.id});assert.equal(read.checkedAt,final.review.createdAt);assert.equal(read.observations[0].verdict,'met');
    s.store.put('runs',{...s.run,status:'completed'});await s.close();reopened=await startServer({home:s.home,port:0});
    assert.deepEqual(reopened.store.get<any>('strategy_decisions',d.id),final);assert.equal(reopened.store.get<any>('loop_evidence',baseline.id).data,baseline.data);assert.equal(reopened.engine.control(s.channel.id).enabled,false);
  }finally{await reopened?.close();await s.cleanup();}
});
test('cached, future-dated, incomplete, shifted-population and mistyped data stay unknown even when the headline value passes',async()=>{
  const s=await fixture();try{
    const baseline=await s.capture(sample()),d=await s.call('decision.choose',{...s.input,expectations:[measured(s,{evidenceId:baseline.id})]});
    const failures=[{generatedAt:new Date(Date.now()-3600000).toISOString()},{generatedAt:new Date(Date.now()+3600000).toISOString()},{generatedAt:undefined},{complete:false},{population:'successful-users-only'},{sampleSize:'1000'},{completion:'0.99'}];
    for(const values of failures){
      const e=await s.capture(sample({completion:0.99,...values}));
      const observed=(await s.call('observation.read',{decisionId:d.id})).observations[0];assert.equal(observed.status,'needs_repair',JSON.stringify(values));assert.equal(observed.verdict,'unknown');
      await s.review(d,measuredAssessment(s,e.id),'improved',400);await s.call('verification.request',{decisionId:d.id,evidenceIds:[e.id]},409);
    }
    const healthyButNoEffect=await s.capture(sample({completion:0.625})),obs=(await s.call('observation.read',{decisionId:d.id})).observations[0];
    assert.equal(obs.status,'ready');assert.equal(obs.verdict,'not_met');assert.equal(obs.comparedValue,0.125);
    const final=await s.review(d,{...measuredAssessment(s,healthyButNoEffect.id,'not_met'),diagnosis:'uncertain',adjustment:'method'},'not_improved');assert.equal(final.review.assessment.results[0].observation.comparedValue,0.125);assert.equal(s.store.all('loop_verifications').length,0);
  }finally{await s.cleanup();}
});
test('missing baseline remains an actionable capability gap, cannot be backfilled into an old choice, and a new choice can use the collected baseline',async()=>{
  const s=await fixture();try{
    const expectation=measured(s,{unavailable:'尚未建立完整的交付采集链路'});
    const d=await s.call('decision.choose',{...s.input,options:[{...s.input.options[0],kind:'build_capability'}],expectations:[expectation]});
    assert.match(d.observations[0].issues.join(' '),/采集链路/);
    const baseline=await s.capture(sample());await s.review(d,measuredAssessment(s,baseline.id),'improved',400);
    const unknown=await s.review(d,{...measuredAssessment(s,baseline.id,'unknown'),diagnosis:'measurement',adjustment:'measurement'},'inconclusive');
    assert.deepEqual(unknown.expectations[0].measurement.baseline,expectation.measurement.baseline);
    const next=await s.call('decision.choose',{...s.input,expectations:[measured(s,{evidenceId:baseline.id})]});
    const after=await s.capture(sample({completion:0.75}));const observed=(await s.call('observation.read',{decisionId:next.id})).observations[0];assert.equal(observed.verdict,'met');assert.equal(observed.baselineEvidenceId,baseline.id);assert.equal(observed.evidenceId,after.id);
    await s.call('observation.read',{decisionId:'another-project-decision'},404);
  }finally{await s.cleanup();}
});
test('baseline and quality contracts reject substituted sources, selective history and invalid configuration',async()=>{
  const s=await fixture();try{
    const choose=(expectation:any,status:number)=>s.call('decision.choose',{...s.input,expectations:[expectation]},status);
    const older=await s.capture(sample()),latest=await s.capture(sample({completion:0.8}));
    await choose(measured(s,{evidenceId:older.id}),409);
    const wrong=await s.capture(sample(),'other.json');await choose(measured(s,{evidenceId:wrong.id}),400);
    const agent=await s.call('evidence.record',{summary:'自写基线',source:join(s.path,'result.json'),observedAt:new Date().toISOString(),data:sample()});await choose(measured(s,{evidenceId:agent.id}),400);
    await choose(measured(s,{evidenceId:'foreign'}),404);
    const e=measured(s,{evidenceId:latest.id});
    await choose({...e,measurement:{...e.measurement,checks:[]}},400);
    await choose({...e,measurement:{...e.measurement,checks:[{label:'非法路径',pointer:'/bad~2',operator:'equals',expected:true}]}},400);
    await choose({...e,measurement:{...e.measurement,freshness:{pointer:'/generatedAt',maxAgeSeconds:0}}},400);
    await choose({...e,rule:{pointer:'/completion',operator:'equals',expected:'ok'}},400);
    const invalid=await s.capture(sample({sampleSize:2}));const d=await choose(measured(s,{evidenceId:invalid.id}),200);await s.capture(sample({completion:1}));
    const gaps=(await s.call('observation.read',{decisionId:d.id})).observations[0];assert.equal(gaps.verdict,'unknown');assert.match(gaps.issues.join(' '),/原基线/);
  }finally{await s.cleanup();}
});
test('HTTP quality changes wake linked work, identical bad samples stay quiet, and a recovered source replaces cached success',async()=>{
  const s=await fixture();let data=sample(),failure=false;const server=createServer((_req,res)=>{res.statusCode=failure?503:200;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));try{
    const watch=await s.call('watch.create',{title:'观测质量验收',url:`http://127.0.0.1:${(server.address() as any).port}/metrics`,pointer:'/completion',condition:'changed',intervalSeconds:30,deadline:future()});
    await s.engine.loop.poll(watch.id);const baseline=s.store.get<any>('loop_watches',watch.id).lastEvidenceId;
    const d=await s.call('decision.choose',{...s.input,expectations:[{...measured(s,{evidenceId:baseline}),source:{kind:'watch',watchId:watch.id}}]});
    data=sample({completion:0.875,sampleSize:2});await s.engine.loop.poll(watch.id);
    const bad=s.store.get<any>('loop_watches',watch.id).lastEvidenceId,count=s.store.all('loop_evidence').length,signals=s.store.all('strategy_signals').length;
    data={...data,generatedAt:new Date().toISOString()};await s.engine.loop.poll(watch.id);assert.equal(s.store.all('loop_evidence').length,count);assert.equal(s.store.all('strategy_signals').length,signals);
    data=sample({completion:0.875});await s.engine.loop.poll(watch.id);const good=s.store.get<any>('loop_watches',watch.id).lastEvidenceId;assert.notEqual(bad,good);
    assert.equal((await s.call('observation.read',{decisionId:d.id})).observations[0].verdict,'met');
    failure=true;await s.engine.loop.poll(watch.id);assert.match((await s.call('observation.read',{decisionId:d.id})).observations[0].issues.join(' '),/来源不可用/);
    await s.review(d,measuredAssessment(s,good),'improved',400);await s.call('verification.request',{decisionId:d.id,evidenceIds:[good]},409);
    const faultSignals=s.store.all('strategy_signals').length;await s.engine.loop.poll(watch.id);assert.equal(s.store.all('strategy_signals').length,faultSignals);
    failure=false;await s.engine.loop.poll(watch.id);const recovered=s.store.get<any>('loop_watches',watch.id);assert.equal(recovered.error,undefined);assert.notEqual(recovered.lastEvidenceId,good);
    assert.equal((await s.call('observation.read',{decisionId:d.id})).observations[0].verdict,'met');assert(s.store.all('strategy_signals').length>faultSignals);assert.equal(s.engine.control(s.channel.id).enabled,false);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await s.cleanup();}
});
test('HTTP metrics that stop updating become unknown once, and a fresh sample restores readiness without a polling storm',async t=>{
  const s=await fixture();t.mock.timers.enable({apis:['Date'],now:Date.now()});let data=sample();
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    const watch=await s.call('watch.create',{title:'采集停滞验收',url:`http://127.0.0.1:${(server.address() as any).port}/metrics`,pointer:'/completion',condition:'changed',intervalSeconds:30,deadline:future()});
    await s.engine.loop.poll(watch.id);const baseline=s.store.get<any>('loop_watches',watch.id).lastEvidenceId;
    const d=await s.call('decision.choose',{...s.input,expectations:[{...measured(s,{evidenceId:baseline}),source:{kind:'watch',watchId:watch.id}}]});
    data=sample({completion:0.875});await s.engine.loop.poll(watch.id);assert.equal((await s.call('observation.read',{decisionId:d.id})).observations[0].verdict,'met');
    t.mock.timers.tick(301000);const count=s.store.all('loop_evidence').length;await s.engine.loop.poll(watch.id);assert.equal(s.store.all('loop_evidence').length,count+1);
    assert.equal((await s.call('observation.read',{decisionId:d.id})).observations[0].verdict,'unknown');
    await s.engine.loop.poll(watch.id);assert.equal(s.store.all('loop_evidence').length,count+1);
    data=sample({completion:0.875});await s.engine.loop.poll(watch.id);assert.equal(s.store.all('loop_evidence').length,count+2);assert.equal((await s.call('observation.read',{decisionId:d.id})).observations[0].verdict,'met');
    await s.engine.loop.poll(watch.id);assert.equal(s.store.all('loop_evidence').length,count+2);
  }finally{t.mock.timers.reset();await new Promise<void>(r=>server.close(()=>r()));await s.cleanup();}
});
