// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectLoop, Release } from '../../shared/types';
import { ProjectReleases, FeatureWork } from './ProjectWork';
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
describe('AI work and release review',()=>{
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
