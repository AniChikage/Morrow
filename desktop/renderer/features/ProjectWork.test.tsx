// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectLoop, Release, DecisionView } from '../../shared/types';
import { ProjectReleases, FeatureWork, ProjectThinking } from './ProjectWork';
import { ProjectView } from './ProjectView';
import { featureProps, TestProviders, timestamp } from './testFixtures';
beforeEach(()=>{localStorage.clear();HTMLElement.prototype.hasPointerCapture=()=>false;HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.releasePointerCapture=()=>{};});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function fixture(){
  const {props,api}=featureProps();
  const release:Release={id:'release-one',projectId:'project-atlas',channelId:'channel-system',runId:'run-one',itemIds:['finding-import'],title:'导入失败恢复',changes:'保持同一请求标识，避免重复写入。',rationale:'重试会造成重复记录。',expectedBenefit:'预期减少重复导入，线上收益尚待验证。',checks:[{name:'超时恢复测试',result:'passed',evidenceIds:['evidence-one']}],risks:'影响导入重试路径。',rollback:'恢复上一版本。',observationPlan:'观察重试后的重复记录率。',artifact:{name:'release.zip',sha256:'sealed-sha256',bytes:512},target:{url:'https://deploy.example.test/releases',statusUrl:'https://deploy.example.test/status',label:'测试发布环境'},reviewHash:'reviewed-content',status:'awaiting_approval',createdAt:timestamp,updatedAt:timestamp};
  const data:ProjectLoop={releases:[release],watches:[],learning:[],evidence:[{id:'evidence-one',projectId:release.projectId,channelId:release.channelId,runId:release.runId,itemId:'finding-import',summary:'测试日志',source:'/project/checks.log',observedAt:timestamp,createdAt:timestamp,origin:'file',data:'2 tests passed'}]};
  const getProjectWork=vi.fn(async()=>data),reviewRelease=vi.fn(async()=>release),reconcileRelease=vi.fn(async()=>release);
  Object.assign(api,{getProjectWork,reviewRelease,reconcileRelease});props.snapshot.releases=[release];return {props,api,release,data,getProjectWork,reviewRelease,reconcileRelease};
}
function evaluatedDecision():DecisionView {
  return {id:'evaluated',projectId:'project-atlas',channelId:'channel-system',runId:'run-one',itemId:'finding-import',objective:{goal:'提高交付成功率并保留完整内容',direction:'自主推进',version:'goal-one'},options:[{title:'验证交付效果',kind:'investigate',benefit:'减少盲目投入',cost:'一次验证',uncertainty:'真实用户效果未知'}],selected:0,rationale:'检查约束是否同时满足',nextStep:'读取交付样例',expectedOutcome:'完成率提高且没有内容缺失',evaluation:'核对实际字段',stopWhen:'约束恶化后重新判断',understandingRefs:[],evidenceIds:[],watchIds:[],reviewAt:timestamp,maxRuns:2,signalCursor:0,status:'reviewed',revision:2,createdAt:timestamp,updatedAt:timestamp,runsUsed:1,reviewReasons:[],evaluationVersion:1,
    expectations:[{id:'integrity',kind:'guardrail',claim:'不丢失交付内容',scope:'同一隔离样本和版本',source:{kind:'file',path:'/project/result.json'},verification:'逐项核对输出',disconfirm:'出现任何内容缺失',notBefore:timestamp,deadline:timestamp,rule:{pointer:'/missing',operator:'equals',expected:0}}],
    review:{outcome:'not_improved',conclusion:'完成率提高，但实际丢失两项内容',evidenceIds:['evidence-one'],nextDirection:'重新检查交付方法',runId:'run-one',channelId:'channel-system',createdAt:timestamp,assessment:{results:[{expectationId:'integrity',verdict:'not_met',reason:'实际字段为 2，与事先约定不符',evidenceIds:['evidence-one'],checkedBy:'rule',observedValue:2}],conditions:'matched',conditionReason:'仍为原样本，统计方式没有改变',diagnosis:'execution',explanation:'完成率不能替代内容完整性',adjustment:'method',understandingRefs:[]}}
  };
}
describe('AI work and release review',()=>{
  it('keeps independent findings and stale source status visible without certifying business impact',async()=>{
    const f=fixture();f.data.verifications=[{id:'verify-one',projectId:'project-atlas',channelId:'channel-system',runId:'run-one',itemId:'finding-import',evidenceIds:['evidence-one'],subjectHash:'subject',version:{digest:'frozen-source-hash',head:'commit',files:6,bytes:1000,coverage:'git-tracked-and-unignored'},status:'failed',summary:'发现真实输入格式的边界问题',findings:[{severity:'blocking',message:'169 小时的数据被错误计入 7 天'}],checks:[{expectationId:'feature',verdict:'not_met',reason:'原始时间格式的反例没有通过'}],limitations:['尚未验证业务收益'],createdAt:timestamp,finishedAt:timestamp,threadId:'independent-native-task',bytes:1200,commandCount:2,timeoutSeconds:300,current:true}];
    const view=render(<TestProviders><FeatureWork api={f.api} projectId="project-atlas" itemId="finding-import"/></TestProviders>);
    expect(await screen.findByText('复核发现问题')).not.toBeNull();expect(screen.getByText('169 小时的数据被错误计入 7 天',{exact:false})).not.toBeNull();expect(screen.queryByRole('button',{name:/确认/})).toBeNull();
    f.data.verifications[0]={...f.data.verifications[0],status:'passed',current:false};view.rerender(<TestProviders><FeatureWork api={f.api} projectId="project-atlas" itemId="other-item"/></TestProviders>);
    expect(await screen.findByText('源码或核验材料已变化，需要重新复核')).not.toBeNull();expect(screen.queryByText('独立复核通过')).toBeNull();
    await userEvent.setup().click(screen.getByText('源码或核验材料已变化，需要重新复核'));expect(screen.getByText('尚未验证业务收益')).not.toBeNull();expect(screen.getByText(/原生任务：independent-native-task/)).not.toBeNull();
  });
  it('shows the saved next direction after review and labels original native execution evidence',async()=>{
    const f=fixture(),d=evaluatedDecision();d.expectations![0].source={kind:'execution',command:'node --test'};f.data.evidence[0]={...f.data.evidence[0],origin:'execution',data:{exitCode:0,output:'1 test passed',boundVersion:true}};f.data.strategy={understanding:[],decisions:[d],counts:{understanding:0,decisions:1}};
    render(<TestProviders><ProjectThinking api={f.api} projectId="project-atlas" onNavigate={f.props.onNavigate}/></TestProviders>);
    expect(await screen.findByRole('heading',{name:'已保存的下一步'})).not.toBeNull();expect(screen.queryByText('等待形成下一步判断')).toBeNull();
    const user=userEvent.setup();await user.click(screen.getByText('此前尝试与复盘'));await user.click(screen.getByText('预期与实际'));expect(screen.getByText('约定来源：node --test')).not.toBeNull();expect(screen.getAllByText('原生执行记录').length).toBeGreaterThan(0);
  });
  it('keeps the original threshold and shows a violated guardrail with real evidence and a concrete adjustment',async()=>{
    const f=fixture(),d=evaluatedDecision();f.data.strategy={understanding:[],decisions:[d],counts:{understanding:0,decisions:1}};
    render(<TestProviders><ProjectThinking api={f.props.api} projectId="project-atlas" onNavigate={f.props.onNavigate}/></TestProviders>);const user=userEvent.setup();
    await user.click(await screen.findByText('此前尝试与复盘'));await user.click(screen.getByText('预期与实际'));
    expect(screen.getByText('不能牺牲的条件 · 不丢失交付内容')).not.toBeNull();expect(screen.getByText('与预期不符 · 规则核对')).not.toBeNull();expect(screen.getByText(/\/missing = 0 · 采集值：2/)).not.toBeNull();
    expect(screen.getByText('完成率不能替代内容完整性')).not.toBeNull();expect(screen.getByText('调整方法',{exact:false})).not.toBeNull();expect(screen.queryByText('本次预期已达成')).toBeNull();expect(screen.queryByRole('textbox')).toBeNull();expect(f.reviewRelease).not.toHaveBeenCalled();
  });
  it('shows the same evaluation on its feature and distinguishes qualitative interpretation from numeric checking',async()=>{
    const f=fixture(),d=evaluatedDecision();d.expectations![0].rule=undefined;d.review!.assessment!.results[0]={expectationId:'integrity',verdict:'unknown',reason:'样本还不足以判断',evidenceIds:['evidence-one'],checkedBy:'agent'};d.review!.outcome='inconclusive';f.data.strategy={understanding:[],decisions:[d],counts:{understanding:0,decisions:1}};
    render(<TestProviders><FeatureWork api={f.props.api} projectId="project-atlas" itemId="finding-import"/></TestProviders>);await userEvent.setup().click(await screen.findByText('预期与实际'));
    expect(screen.getByText('仍待核对 · Codex 根据证据解读')).not.toBeNull();expect(screen.queryByText(/采集值/)).toBeNull();expect(f.getProjectWork).toHaveBeenCalledWith('project-atlas','finding-import');
  });
  it('labels legacy textual conclusions without inventing an observation contract',async()=>{
    const f=fixture(),d=evaluatedDecision();delete d.evaluationVersion;delete d.expectations;delete d.review!.assessment;f.data.strategy={understanding:[],decisions:[d],counts:{understanding:0,decisions:1}};
    render(<TestProviders><ProjectThinking api={f.props.api} projectId="project-atlas" onNavigate={f.props.onNavigate}/></TestProviders>);await userEvent.setup().click(await screen.findByText('此前尝试与复盘'));
    expect(screen.getByText('历史文字复盘，未进行逐项预期核对。')).not.toBeNull();expect(screen.queryByText('预期与实际')).toBeNull();
  });
  it('shows the current decision, conflicting feedback and original expectation without requesting user planning',async()=>{
    const f=fixture();f.data.strategy={understanding:[],counts:{understanding:0,decisions:1},decisions:[{id:'choice',projectId:'project-atlas',channelId:'channel-system',runId:'run-one',objective:{goal:'改善首次使用',direction:'自主推进',version:'goal-one'},options:[{title:'先定位用户放弃的步骤',kind:'investigate',benefit:'减少盲目修改',cost:'一次调查',uncertainty:'尚缺路径数据'},{title:'直接简化注册',kind:'act',benefit:'可能减少步骤',cost:'发布成本',uncertainty:'尚未证明注册有问题'}],selected:0,rationale:'先减少关键未知',nextStep:'读取路径数据',expectedOutcome:'区分技术故障与需求不足',evaluation:'比较路径记录',stopWhen:'证据足够或不再获得新信息',understandingRefs:[],evidenceIds:['evidence-one'],watchIds:[],reviewAt:timestamp,maxRuns:2,signalCursor:0,status:'active',revision:1,createdAt:timestamp,updatedAt:timestamp,runsUsed:2,reviewReasons:['新反馈与原判断不一致']} ]};
    render(<TestProviders><ProjectView {...f.props} id="project-atlas"/></TestProviders>);const user=userEvent.setup();await user.click(screen.getByRole('tab',{name:'当前判断'}));
    expect(await screen.findByRole('heading',{name:'先定位用户放弃的步骤'})).not.toBeNull();expect(screen.getByRole('status').textContent).toContain('新反馈与原判断不一致');expect(screen.getByText('区分技术故障与需求不足',{exact:false})).not.toBeNull();
    await user.click(screen.getByText('选择依据与投入边界'));expect(screen.getByText('直接简化注册')).not.toBeNull();await user.click(screen.getByRole('button',{name:'进入对话'}));expect(f.props.onNavigate).toHaveBeenCalledWith({kind:'channel',id:'channel-system'});expect(f.reviewRelease).not.toHaveBeenCalled();
  });
  it('keeps an empty project honest and shows retrieval errors instead of made-up thinking',async()=>{
    const f=fixture();f.data.strategy={understanding:[],decisions:[],counts:{understanding:0,decisions:0}};const view=render(<TestProviders><ProjectThinking api={f.props.api} projectId="project-atlas" onNavigate={f.props.onNavigate}/></TestProviders>);expect(await screen.findByRole('heading',{name:'等待形成下一步判断'})).not.toBeNull();
    f.getProjectWork.mockRejectedValue(new Error('读取失败'));view.rerender(<TestProviders><ProjectThinking api={f.props.api} projectId="project-other" onNavigate={f.props.onNavigate}/></TestProviders>);expect((await screen.findByRole('alert')).textContent).toBe('读取失败');expect(screen.queryByRole('heading',{name:'等待形成下一步判断'})).toBeNull();
  });
  it('shows the historical lesson and why the agent adapted it without presenting a failed attempt as a success',async()=>{
    const f=fixture();f.data.strategy={understanding:[],counts:{understanding:0,decisions:1},decisions:[{id:'choice',projectId:'project-atlas',channelId:'channel-system',runId:'run-one',objective:{goal:'改善材料交付',direction:'自主推进',version:'goal-one'},options:[{title:'补上原始引用核验',kind:'build_capability',benefit:'降低核验成本',cost:'一次实现',uncertainty:'需要真实用户验证'}],selected:0,rationale:'上次只能生成文本，仍缺原始引用',nextStep:'验证每条引用',expectedOutcome:'原始材料可以逐条核验',evaluation:'检查交付文件与源材料',stopWhen:'测试不支持方向时复查',understandingRefs:[],evidenceIds:[],watchIds:[],reviewAt:timestamp,maxRuns:2,signalCursor:0,status:'active',revision:1,createdAt:timestamp,updatedAt:timestamp,runsUsed:1,reviewReasons:[],memoryRefs:[{kind:'decision',id:'old-choice',revision:2,use:'adapt',reason:'保留材料检查，新增引用核验，重新验证交付效果',snapshot:{kind:'decision',id:'old-choice',revision:2,title:'只生成材料摘要',status:'reviewed',excerpt:'未解决原始引用缺失',truncated:false,evidenceIds:['evidence-one'],updatedAt:timestamp,outcome:'not_improved',caution:'这是当时条件下的复盘，需重新判断适用性'}}]}]};
    render(<TestProviders><ProjectThinking api={f.props.api} projectId="project-atlas" onNavigate={f.props.onNavigate}/></TestProviders>);
    await userEvent.setup().click(await screen.findByText('这次参考了哪些经验'));
    expect(screen.getByText('调整后采用 · 只生成材料摘要')).not.toBeNull();expect(screen.getByText('保留材料检查，新增引用核验，重新验证交付效果')).not.toBeNull();expect(screen.getByText(/当时版本 2 · 未达到本次预期/)).not.toBeNull();expect(screen.getByText('未解决原始引用缺失')).not.toBeNull();expect(screen.getByText('测试日志',{exact:false})).not.toBeNull();
    expect(screen.queryByText('本次预期已达成')).toBeNull();expect(f.reviewRelease).not.toHaveBeenCalled();
  });
  it('identifies an older service instead of pretending that it has no project knowledge',async()=>{
    const f=fixture();render(<TestProviders><ProjectThinking api={f.props.api} projectId="project-atlas" onNavigate={f.props.onNavigate}/></TestProviders>);
    expect(await screen.findByRole('heading',{name:'当前服务尚未支持项目判断'})).not.toBeNull();expect(screen.queryByText('等待形成下一步判断')).toBeNull();
  });
  it('opens a concrete release from the shared project board and approves exactly its displayed hash',async()=>{
    const f=fixture();render(<TestProviders><ProjectView {...f.props} id="project-atlas"/></TestProviders>);const user=userEvent.setup();
    await user.click(screen.getByRole('tab',{name:/上线确认/}));await user.click(screen.getByRole('button',{name:/导入失败恢复/}));
    expect(await screen.findByText('sealed-sha256',{exact:false})).not.toBeNull();expect(screen.getByRole('heading',{name:'预期收益'})).not.toBeNull();expect(screen.getByRole('heading',{name:'上线后如何判断效果'})).not.toBeNull();expect(f.reviewRelease).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox',{name:'上线指导意见'}),'关注重复提交');await user.click(screen.getByRole('button',{name:'确认这个版本上线'}));await waitFor(()=>expect(f.reviewRelease).toHaveBeenCalledWith('release-one','reviewed-content','approve','关注重复提交'));
  });
  it('returns a concrete revision to the agent with feedback without approving it',async()=>{
    const f=fixture();render(<TestProviders><ProjectReleases {...f.props} projectId="project-atlas"/></TestProviders>);const user=userEvent.setup();await user.click(screen.getByRole('button',{name:/导入失败恢复/}));await user.type(screen.getByRole('textbox',{name:'上线指导意见'}),'还需要断网恢复验证');await user.click(screen.getByRole('button',{name:'暂不上线，继续调整'}));expect(f.reviewRelease).toHaveBeenCalledWith('release-one','reviewed-content','reject','还需要断网恢复验证');
  });
  it('keeps unknown delivery visibly unresolved and offers only receipt reconciliation',async()=>{
    const f=fixture();f.release.status='unknown';f.release.error='发布结果待核对，不会重复发送';render(<TestProviders><ProjectReleases {...f.props} projectId="project-atlas"/></TestProviders>);const user=userEvent.setup();await user.click(screen.getByRole('button',{name:/导入失败恢复/}));expect(screen.queryByRole('button',{name:'确认这个版本上线'})).toBeNull();await user.click(screen.getByRole('button',{name:'核对发布结果'}));expect(f.reconcileRelease).toHaveBeenCalledWith('release-one');expect(f.reviewRelease).not.toHaveBeenCalled();
  });
  it('shows a refuted hypothesis and the actual evidence on its feature',async()=>{
    const f=fixture();f.data.learning=[{id:'belief',projectId:f.release.projectId,channelId:f.release.channelId,runId:f.release.runId,itemId:'finding-import',kind:'hypothesis',title:'超时导致重复',rationale:'初始解释',expectedResult:'降低重复率',evaluation:'观察实际记录',conclusion:'新证据推翻了初始解释',status:'refuted',evidenceIds:['evidence-one'],revision:2,createdAt:timestamp,updatedAt:timestamp}];render(<TestProviders><FeatureWork api={f.props.api} projectId="project-atlas" itemId="finding-import"/></TestProviders>);expect(await screen.findByText('已被推翻')).not.toBeNull();expect(screen.getByText('新证据推翻了初始解释')).not.toBeNull();expect(f.getProjectWork).toHaveBeenCalledWith('project-atlas','finding-import');
  });
  it('disables approval if evidence cannot be loaded and excludes other projects',async()=>{
    const f=fixture();f.props.snapshot.releases!.push({...f.release,id:'private',projectId:'project-other',title:'其他项目发布'});f.getProjectWork.mockRejectedValue(new Error('证据服务不可用'));render(<TestProviders><ProjectReleases {...f.props} projectId="project-atlas"/></TestProviders>);const user=userEvent.setup();expect(screen.queryByText('其他项目发布')).toBeNull();await user.click(screen.getByRole('button',{name:/导入失败恢复/}));expect((await screen.findByRole('alert')).textContent).toContain('证据服务不可用');expect((screen.getByRole('button',{name:'确认这个版本上线'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('requires every cited check to remain reviewable before approval',async()=>{
    const f=fixture();f.data.evidence=[];render(<TestProviders><ProjectReleases {...f.props} projectId="project-atlas"/></TestProviders>);await userEvent.setup().click(screen.getByRole('button',{name:/导入失败恢复/}));expect((await screen.findByRole('alert')).textContent).toContain('部分验证证据尚未读取');expect((screen.getByRole('button',{name:'确认这个版本上线'}) as HTMLButtonElement).disabled).toBe(true);expect(f.reviewRelease).not.toHaveBeenCalled();
  });
});
