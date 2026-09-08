// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialogs } from './Dialogs';
import { featureProps, item, TestProviders, timestamp } from '../features/testFixtures';
import type { ConnectionInfo } from '../../shared/types';
const context = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../state/workspace', () => ({ useWorkspace: () => context.current }));
const local: ConnectionInfo = { config: { mode:'local', host:'', port:43821, directory:'/Users/test/Library/Application Support/NoHuman' }, connected:true, name:'本机 Mac' };
beforeEach(() => {
 const { props, api } = featureProps();
 props.snapshot.projects[1].path='/Users/test/projects/Other';
 context.current = { ...props, connection:local, error:'', reset:vi.fn(), setConnectionInfo:vi.fn(), clearError:vi.fn(), mutate:vi.fn(async(action:()=>Promise<unknown>) => {try{await action();return true;}catch{return false;}}), api };
 if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView=()=>{};
});
afterEach(cleanup);
it('uses a remote directory when switching from Mac and remembers edited SSH settings across mode changes', async()=>{
 const user=userEvent.setup();
 render(<Dialogs modal={{kind:'settings'}} onClose={()=>{}} onNavigate={()=>{}}/>,{wrapper:TestProviders});
 await user.click(screen.getByRole('button',{name:'远程 SSH'}));
 expect((screen.getByRole('textbox',{name:'远程数据目录'}) as HTMLInputElement).value).toBe('~/.local/share/nohuman');
 await user.type(screen.getByRole('textbox',{name:/SSH 主机/}),'build-box');
 await user.clear(screen.getByRole('textbox',{name:'远程数据目录'}));
 await user.type(screen.getByRole('textbox',{name:'远程数据目录'}),'/srv/nohuman');
 await user.click(screen.getByRole('button',{name:'本机 Mac'}));
 await user.click(screen.getByRole('button',{name:'远程 SSH'}));
 expect((screen.getByRole('textbox',{name:/SSH 主机/}) as HTMLInputElement).value).toBe('build-box');
 expect((screen.getByRole('textbox',{name:'远程数据目录'}) as HTMLInputElement).value).toBe('/srv/nohuman');
});
it('clears the old workspace before connecting and does not announce a failed resolved connection as successful',async()=>{
 const failure={...local,connected:false,error:'执行服务拒绝连接'};
 context.current.api.connect.mockImplementation(async()=>{
  expect(context.current.reset).toHaveBeenCalledOnce();
  return failure;
 });
 render(<Dialogs modal={{kind:'settings'}} onClose={()=>{}} onNavigate={()=>{}}/>,{wrapper:TestProviders});
 await userEvent.setup().click(screen.getByRole('button',{name:'连接'}));
 await waitFor(()=>expect(context.current.setConnectionInfo).toHaveBeenCalledWith(failure));
 await waitFor(()=>expect(context.current.mutate).toHaveResolvedWith(false));
 expect(screen.queryByRole('status')).toBeNull();
});
it('only announces success after the actual connection succeeds',async()=>{
 context.current.api.connect.mockResolvedValue(local);
 render(<Dialogs modal={{kind:'settings'}} onClose={()=>{}} onNavigate={()=>{}}/>,{wrapper:TestProviders});
 await userEvent.setup().click(screen.getByRole('button',{name:'连接'}));
 expect((await screen.findByRole('status')).textContent).toBe('已连接到本机 Mac');
 expect(context.current.setConnectionInfo).toHaveBeenCalledWith(local);
});

it('opens a native folder, derives the project name and saves the chosen default runtime before navigating', async () => {
 const user=userEvent.setup(), onClose=vi.fn(), onNavigate=vi.fn();
 context.current.api.chooseFolder.mockResolvedValue('/Users/test/projects/Atlas');
 context.current.api.createProject.mockResolvedValue({id:'project-new',name:'Atlas',path:'/Users/test/projects/Atlas',runtime:'claude',goal:'',createdAt:timestamp,isDemo:false});
 render(<Dialogs modal={{kind:'project'}} onClose={onClose} onNavigate={onNavigate}/>,{wrapper:TestProviders});
 expect((screen.getByRole('button',{name:'打开项目'}) as HTMLButtonElement).disabled).toBe(true);
 await user.click(screen.getByRole('button',{name:'选择文件夹'}));
 expect(context.current.api.chooseFolder).toHaveBeenCalledOnce();
 expect((screen.getByPlaceholderText('选择本机项目文件夹') as HTMLInputElement).value).toBe('/Users/test/projects/Atlas');
 expect((screen.getByRole('textbox',{name:'项目名称'}) as HTMLInputElement).value).toBe('Atlas');
 expect((screen.getByRole('combobox',{name:/默认运行时/}) as HTMLSelectElement).value).toBe('codex');
 await user.selectOptions(screen.getByRole('combobox',{name:/默认运行时/}),'claude');
 await user.click(screen.getByRole('button',{name:'打开项目'}));
 await waitFor(()=>expect(context.current.api.createProject).toHaveBeenCalledWith({name:'Atlas',path:'/Users/test/projects/Atlas',runtime:'claude',goal:'持续跟踪项目进展，识别有证据支持的问题，在授权范围内推进修复并验证结果。'}));
 expect(onNavigate).toHaveBeenCalledWith({kind:'project',id:'project-new'},true);
 expect(onClose).toHaveBeenCalledOnce();
 expect(context.current.api.channelAction).not.toHaveBeenCalled();
});

it('opens an already connected folder without creating another project', async () => {
 const user=userEvent.setup(), onClose=vi.fn(), onNavigate=vi.fn();
 context.current.snapshot.projects[1].path='/Users/test/projects/existing';
 context.current.api.chooseFolder.mockResolvedValue('/Users/test/projects/existing');
 render(<Dialogs modal={{kind:'project'}} onClose={onClose} onNavigate={onNavigate}/>,{wrapper:TestProviders});
 await user.click(screen.getByRole('button',{name:'选择文件夹'}));
 await user.click(screen.getByRole('button',{name:'打开已有项目'}));
 expect(context.current.api.createProject).not.toHaveBeenCalled();
 expect(onNavigate).toHaveBeenCalledWith({kind:'project',id:'project-other'},true);
 expect(onClose).toHaveBeenCalledOnce();
});

it('keeps a failed native folder selection recoverable and never submits an empty path', async () => {
 context.current.api.chooseFolder.mockRejectedValueOnce(new Error('文件夹选择器暂不可用')).mockResolvedValueOnce(null);
 render(<Dialogs modal={{kind:'project'}} onClose={()=>{}} onNavigate={()=>{}}/>,{wrapper:TestProviders});
 const user=userEvent.setup();
 await user.click(screen.getByRole('button',{name:'选择文件夹'}));
 expect((await screen.findByRole('alert')).textContent).toContain('文件夹选择器暂不可用');
 await user.click(screen.getByRole('button',{name:'选择文件夹'}));
 expect((screen.getByRole('button',{name:'打开项目'}) as HTMLButtonElement).disabled).toBe(true);
 expect(context.current.api.createProject).not.toHaveBeenCalled();
});

it('accepts a remote project directory without invoking the local folder picker', async () => {
 const user=userEvent.setup(), onNavigate=vi.fn();
 context.current.connection={...local,config:{mode:'ssh',host:'build-box',port:43821,directory:'/srv/nohuman'}};
 context.current.api.createProject.mockResolvedValue({id:'remote-project'});
 render(<Dialogs modal={{kind:'project'}} onClose={()=>{}} onNavigate={onNavigate}/>,{wrapper:TestProviders});
 expect(screen.queryByRole('button',{name:'选择文件夹'})).toBeNull();
 await user.type(screen.getByRole('textbox',{name:'远程项目目录'}),'/srv/projects/remote-app');
 await user.type(screen.getByRole('textbox',{name:/持续目标/}),'验证远程构建结果');
 await user.selectOptions(screen.getByRole('combobox',{name:/默认运行时/}),'trae');
 await user.click(screen.getByRole('button',{name:'打开项目'}));
 await waitFor(()=>expect(context.current.api.createProject).toHaveBeenCalledWith({name:'remote-app',path:'/srv/projects/remote-app',goal:'验证远程构建结果',runtime:'trae'}));
 expect(context.current.api.chooseFolder).not.toHaveBeenCalled();
 expect(onNavigate).toHaveBeenCalledWith({kind:'project',id:'remote-project'},true);
});

it('creates a project-owned feature with evidence and no invented source channel', async () => {
 const user=userEvent.setup(), onClose=vi.fn(), onNavigate=vi.fn();
 render(<Dialogs modal={{kind:'feature',projectId:'project-atlas'}} onClose={onClose} onNavigate={onNavigate}/>,{wrapper:TestProviders});
 await user.type(screen.getByRole('textbox',{name:'标题'}),'  恢复导入进度  ');
 await user.type(screen.getByRole('textbox',{name:'描述'}),'  支持 **断点恢复**。  ');
 expect((screen.getByRole('combobox',{name:'关联频道'}) as HTMLSelectElement).value).toBe('');
 expect(screen.getAllByRole('option').some(option=>option.getAttribute('value')==='channel-other')).toBe(false);
 await user.click(screen.getByText('证据与下一步'));
 await user.click(screen.getByRole('button',{name:'添加证据'}));
 await user.type(screen.getByRole('textbox',{name:'证据 1'}),'  test/import.test.ts 验证通过  ');
 await user.click(screen.getByRole('button',{name:'添加证据'}));
 await user.type(screen.getByRole('textbox',{name:'下一步'}),'  验证第二次导入  ');
 await user.click(screen.getByRole('button',{name:'创建功能'}));
 await waitFor(()=>expect(context.current.api.createItem).toHaveBeenCalledWith({projectId:'project-atlas',channelId:'',title:'恢复导入进度',summary:'支持 **断点恢复**。',kind:'feature',status:'open',evidence:['test/import.test.ts 验证通过'],nextStep:'验证第二次导入'}));
 expect(context.current.api.patchItem).not.toHaveBeenCalled();
 expect(onNavigate).toHaveBeenCalledWith({kind:'finding',id:'finding-import'});
 expect(onClose).toHaveBeenCalledOnce();
});

it('blocks a stale feature draft until the latest revision is explicitly reloaded, then patches that revision', async () => {
 const user=userEvent.setup(), onClose=vi.fn(), onNavigate=vi.fn();
 const original=item({revision:3});
 context.current.snapshot.items=[original];
 const modal={kind:'feature' as const,projectId:'project-atlas',item:original};
 const view=render(<Dialogs modal={modal} onClose={onClose} onNavigate={onNavigate}/>,{wrapper:TestProviders});
 await user.clear(screen.getByRole('textbox',{name:'标题'}));
 await user.type(screen.getByRole('textbox',{name:'标题'}),'尚未保存的本地修改');
 const latest=item({revision:4,title:'代理已补充恢复方案',summary:'最新的验收范围',status:'investigating',evidence:['新的复现日志'],nextStep:'验证恢复方案'});
 context.current={...context.current,snapshot:{...context.current.snapshot,items:[latest]}};
 view.rerender(<Dialogs modal={modal} onClose={onClose} onNavigate={onNavigate}/>);
 const save=screen.getByRole('button',{name:'保存修改'}) as HTMLButtonElement;
 expect(save.disabled).toBe(true);
 expect((screen.getByRole('textbox',{name:'标题'}) as HTMLInputElement).value).toBe('尚未保存的本地修改');
 await user.click(save);
 expect(context.current.api.patchItem).not.toHaveBeenCalled();
 await user.click(screen.getByRole('button',{name:'重新载入最新内容'}));
 expect((screen.getByRole('textbox',{name:'标题'}) as HTMLInputElement).value).toBe(latest.title);
 expect((screen.getByRole('textbox',{name:'证据 1'}) as HTMLTextAreaElement).value).toBe('新的复现日志');
 expect(screen.queryByRole('combobox',{name:'关联频道'})).toBeNull();
 await user.click(screen.getByRole('button',{name:'保存修改'}));
 await waitFor(()=>expect(context.current.api.patchItem).toHaveBeenCalledWith(original.id,{title:latest.title,summary:latest.summary,kind:latest.kind,status:latest.status,evidence:latest.evidence,nextStep:latest.nextStep,revision:4}));
 expect(onClose).toHaveBeenCalledOnce();
});

it('retains an edited feature after a rejected save and does not navigate away', async () => {
 const user=userEvent.setup(), onClose=vi.fn(), onNavigate=vi.fn(), original=item({revision:3});
 context.current.snapshot.items=[original];
 context.current.api.patchItem.mockRejectedValue(new Error('Revision conflict'));
 render(<Dialogs modal={{kind:'feature',projectId:'project-atlas',item:original}} onClose={onClose} onNavigate={onNavigate}/>,{wrapper:TestProviders});
 await user.type(screen.getByRole('textbox',{name:'标题'}),' 待保存');
 await user.click(screen.getByRole('button',{name:'保存修改'}));
 await waitFor(()=>expect(context.current.mutate).toHaveResolvedWith(false));
 expect((screen.getByRole('textbox',{name:'标题'}) as HTMLInputElement).value).toBe(`${original.title} 待保存`);
 expect(onClose).not.toHaveBeenCalled();
 expect(onNavigate).not.toHaveBeenCalled();
});
it('edits a channel direction without making scheduling fields the primary form or starting work',async()=>{
 const user=userEvent.setup(),channel=context.current.snapshot.channels[0];
 render(<Dialogs modal={{kind:'channel',projectId:channel.projectId,channel}} onClose={()=>{}} onNavigate={()=>{}}/>,{wrapper:TestProviders});
 expect(screen.getByRole('textbox',{name:'工作方向'})).toBeTruthy();
 expect(screen.getByRole('spinbutton',{name:'每日运行上限'}).closest('details')?.open).toBe(false);
 await user.clear(screen.getByRole('textbox',{name:'工作方向'}));await user.type(screen.getByRole('textbox',{name:'工作方向'}),'持续改善登录体验，优先复现用户遇到的问题');
 await user.click(screen.getByRole('button',{name:'保存方向'}));
 expect(context.current.api.updateChannel).toHaveBeenCalledWith(channel.id,expect.objectContaining({goal:'持续改善登录体验，优先复现用户遇到的问题'}));
 expect(context.current.api.channelAction).not.toHaveBeenCalled();
});
