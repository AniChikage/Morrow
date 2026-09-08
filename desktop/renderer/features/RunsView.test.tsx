// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Run, RunDetails, RunOutputChunk, RunsPage } from '../../shared/types';
import { RunHistory, RunsView } from './RunsView';
import { featureProps, TestProviders, timestamp } from './testFixtures';

afterEach(cleanup);
function run(id:string, patch:Partial<Run>={}):Run {
 return {id,projectId:'project-atlas',channelId:'channel-system',runtime:'codex',status:'completed',startedAt:timestamp,finishedAt:'2026-09-07T02:01:00.000Z',summary:'',sessionId:'',...patch};
}
function deferred<T>() {
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(done=>{resolve=done;});
 return {promise,resolve};
}
function headings() {return screen.getAllByRole('button').filter(button=>button.classList.contains('run-heading'));}

it('labels unavailable native timestamps truthfully for completed App turns and identifies their source', async () => {
 const {props}=featureProps(), user=userEvent.setup();
 const current=run('native-without-clock',{executionOwner:'codex-app',source:'native-app',permission:'native',startedAt:'',finishedAt:'',sessionId:'native-thread'});
 props.snapshot.runs=[current];
 vi.mocked(props.api.getRuns).mockResolvedValue({runs:[current],hasMore:false});
 vi.mocked(props.api.getRun).mockResolvedValue({run:current,prompt:'App 中的原始输入',finalOutput:'原生回复'});
 render(<RunsView {...props}/>,{wrapper:TestProviders});
 await screen.findByRole('heading',{name:'原生时间未提供'});
 await user.click(headings()[0]);
 expect(await screen.findByText('Codex App 对话')).toBeTruthy();
 expect(screen.getByText('原生设置')).toBeTruthy();
 expect(screen.getByText('开始 原生时间未提供')).toBeTruthy();
 expect(screen.getByText('结束 原生时间未提供')).toBeTruthy();
 expect(screen.queryByText(/尚未结束|尚未运行/)).toBeNull();
 await user.click(screen.getByRole('tab',{name:'本轮输入'}));
 expect(await screen.findByText('原生 App 对话中记录的本轮输入。')).toBeTruthy();
 expect(screen.getByText('App 中的原始输入')).toBeTruthy();
});

it('loads durable history beyond the snapshot, merges pages in newest-first order and keeps live snapshot state', async () => {
 const {props}=featureProps(), user=userEvent.setup();
 const latest=run('latest-run',{status:'running',finishedAt:'',startedAt:'2026-09-07T05:00:00.000Z'});
 const middle=run('middle-run',{startedAt:'2026-09-06T02:00:00.000Z'});
 const oldest=run('oldest-run',{startedAt:'2026-09-05T02:00:00.000Z'});
 props.snapshot.runs=[latest];
 vi.mocked(props.api.getRuns)
  .mockResolvedValueOnce({runs:[middle,{...latest,status:'completed'}],hasMore:true,cursor:'page-one'})
  .mockResolvedValueOnce({runs:[oldest,middle],hasMore:false});
 render(<RunsView {...props}/>,{wrapper:TestProviders});
 await screen.findByRole('button',{name:'加载更早运行'});
 expect(props.api.getRuns).toHaveBeenNthCalledWith(1,{limit:80});
 expect(headings().map(button=>button.textContent?.match(/LATEST|MIDDLE|OLDEST/)?.[0])).toEqual(['LATEST','MIDDLE']);
 expect(headings()[0].textContent).toContain('运行中');
 await user.click(screen.getByRole('button',{name:'加载更早运行'}));
 await waitFor(()=>expect(headings()).toHaveLength(3));
 expect(props.api.getRuns).toHaveBeenNthCalledWith(2,{before:'page-one',limit:80});
 expect(headings().map(button=>button.textContent?.match(/LATEST|MIDDLE|OLDEST/)?.[0])).toEqual(['LATEST','MIDDLE','OLDEST']);
 expect(screen.queryByRole('button',{name:'加载更早运行'})).toBeNull();
 await user.selectOptions(screen.getByRole('combobox',{name:'按运行状态筛选'}),'completed');
 expect(headings().map(button=>button.textContent?.match(/LATEST|MIDDLE|OLDEST/)?.[0])).toEqual(['MIDDLE','OLDEST']);
 expect(props.api.getRuns).toHaveBeenCalledTimes(2);
});

it('keeps CLI completion separate from report validation and displays exact input and paginated original output', async () => {
 const {props}=featureProps(), user=userEvent.setup();
 const current=run('detail-run',{trigger:'manual',permission:'workspace-write',reportStatus:'invalid',reportError:'报告缺少必要字段',exitCode:0,sessionId:'native-session-123'});
 props.snapshot.runs=[current];
 vi.mocked(props.api.getRuns).mockResolvedValue({runs:[current],hasMore:false});
 vi.mocked(props.api.getRun).mockResolvedValue({run:current,prompt:'实际发送的输入\n保留完整上下文与空行\n\n检查路径 /tmp/project',finalOutput:'已完成 **本地验证**。',report:{invalidField:'缺少 summary'}});
 const chunk=(id:string,stream:RunOutputChunk['stream'],sequence:number,text:string):RunOutputChunk=>({id,runId:current.id,stream,sequence,text,createdAt:timestamp});
 const first=chunk('first','stderr',1,'第一次 stderr 原始字节');
 const second=chunk('second','stdout',2,'第二次 stdout 原始字节');
 const final=chunk('last','final',3,'最终原始回复字节');
 vi.mocked(props.api.getRunOutput)
  .mockResolvedValueOnce({chunks:[second,chunk('prompt','prompt',0,'输入不会冒充输出'),first,chunk('report','report',4,'报告不会冒充输出')],hasMore:true,cursor:'output-two'})
  .mockResolvedValueOnce({chunks:[second,final],hasMore:false,cursor:'output-final'});
 render(<RunsView {...props}/>,{wrapper:TestProviders});
 await user.click(headings()[0]);
 await waitFor(()=>expect(props.api.getRun).toHaveBeenCalledWith(current.id));
 expect(headings()[0].textContent).toContain('已完成');
 expect(headings()[0].textContent).not.toContain('运行失败');
 expect(screen.getByText('报告未同步')).toBeTruthy();
 expect(screen.getByText('报告缺少必要字段')).toBeTruthy();
 expect(screen.getByText('退出码 0')).toBeTruthy();
 await user.click(screen.getByRole('tab',{name:'本轮输入'}));
 const input=await screen.findByText(/实际发送的输入/);
 expect(input.textContent).toBe('实际发送的输入\n保留完整上下文与空行\n\n检查路径 /tmp/project');
 expect(props.api.getRunOutput).not.toHaveBeenCalled();
 await user.click(screen.getByRole('tab',{name:'原始输出'}));
 await screen.findByText(first.text);
 expect(props.api.getRunOutput).toHaveBeenNthCalledWith(1,current.id,{limit:60});
 expect(screen.queryByText('输入不会冒充输出')).toBeNull();
 expect(screen.queryByText('报告不会冒充输出')).toBeNull();
 await user.click(screen.getByRole('button',{name:'加载后续输出'}));
 await screen.findByText(final.text);
 expect(props.api.getRunOutput).toHaveBeenNthCalledWith(2,current.id,{after:'output-two',limit:60});
 expect([...document.querySelectorAll('.run-output-chunk code')].map(node=>node.textContent)).toEqual([first.text,second.text,final.text]);
 expect(screen.queryByText(/实际发送的输入/)).toBeNull();
 await user.click(screen.getByRole('tab',{name:'看板报告'}));
 expect(screen.getByText(/"invalidField": "缺少 summary"/)).toBeTruthy();
 expect(screen.getByRole('heading',{name:'原生最终回复'})).toBeTruthy();
 expect(screen.getByText('本地验证')).toBeTruthy();
 expect(screen.queryByText(first.text)).toBeNull();
 await user.click(screen.getByRole('button',{name:'打开频道'}));
 expect(props.onNavigate).toHaveBeenCalledWith({kind:'channel',id:current.channelId});
});

it('ignores a delayed previous project page and keeps the new scope cursor when loading more history', async () => {
 const {props}=featureProps(), user=userEvent.setup(), previous=deferred<RunsPage>();
 const oldRun=run('oldscp-run'), newRun=run('newscp-run',{projectId:'project-other',channelId:'channel-other'});
 const olderNewRun=run('newold-run',{projectId:'project-other',channelId:'channel-other',startedAt:'2026-09-05T01:00:00.000Z'});
 vi.mocked(props.api.getRuns).mockImplementation(query=>{
  if(query.projectId==='project-atlas')return previous.promise;
  return Promise.resolve(query.before?{runs:[olderNewRun],hasMore:false}:{runs:[newRun],hasMore:true,cursor:'new-project-cursor'});
 });
 const view=render(<RunHistory {...props} runs={[]} query={{projectId:'project-atlas'}}/>,{wrapper:TestProviders});
 await waitFor(()=>expect(props.api.getRuns).toHaveBeenCalledWith({projectId:'project-atlas',limit:80}));
 view.rerender(<RunHistory {...props} runs={[]} query={{projectId:'project-other'}}/>);
 await screen.findByRole('button',{name:/NEW SCP|NEWSCP/});
 await act(async()=>{previous.resolve({runs:[oldRun],hasMore:true,cursor:'old-project-cursor'});await previous.promise;});
 expect(headings()).toHaveLength(1);
 expect(headings()[0].textContent).toContain('NEWSCP');
 expect(screen.queryByRole('button',{name:/OLDSCP/})).toBeNull();
 await user.click(screen.getByRole('button',{name:'加载更早运行'}));
 await waitFor(()=>expect(headings()).toHaveLength(2));
 expect(props.api.getRuns).toHaveBeenLastCalledWith({projectId:'project-other',before:'new-project-cursor',limit:80});
});

it('does not leak delayed input details after opening a different run', async () => {
 const {props}=featureProps(), user=userEvent.setup(), firstDetails=deferred<RunDetails>();
 const first=run('firsta-run'), second=run('second-run',{startedAt:'2026-09-06T02:00:00.000Z'});
 props.snapshot.runs=[first,second];
 vi.mocked(props.api.getRuns).mockResolvedValue({runs:[first,second],hasMore:false});
 vi.mocked(props.api.getRun).mockImplementation(id=>id===first.id?firstDetails.promise:Promise.resolve({run:second,prompt:'第二次运行独立输入',finalOutput:''}));
 render(<RunsView {...props}/>,{wrapper:TestProviders});
 await user.click(headings()[0]);
 await user.click(screen.getByRole('tab',{name:'本轮输入'}));
 expect(screen.getByText('正在读取输入…')).toBeTruthy();
 await user.click(headings()[1]);
 await user.click(screen.getByRole('tab',{name:'本轮输入'}));
 expect(await screen.findByText('第二次运行独立输入')).toBeTruthy();
 await act(async()=>{firstDetails.resolve({run:first,prompt:'旧运行不应泄漏的输入',finalOutput:''});await firstDetails.promise;});
 expect(screen.queryByText('旧运行不应泄漏的输入')).toBeNull();
 expect(screen.getByText('第二次运行独立输入')).toBeTruthy();
 expect(within(headings()[1]).getByText('SECOND')).toBeTruthy();
});

it('retains visible live runs when durable history fails and retries the same channel scope', async () => {
 const {props}=featureProps(), user=userEvent.setup(), latest=run('active-run',{status:'running'});
 vi.mocked(props.api.getRuns).mockRejectedValueOnce(new Error('历史数据库暂不可用')).mockResolvedValueOnce({runs:[latest],hasMore:false});
 render(<RunHistory {...props} runs={[latest]} query={{channelId:latest.channelId}}/>,{wrapper:TestProviders});
 expect((await screen.findByRole('alert')).textContent).toContain('历史数据库暂不可用');
 expect(headings()[0].textContent).toContain('运行中');
 await user.click(screen.getByRole('button',{name:'重试'}));
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
 expect(props.api.getRuns).toHaveBeenLastCalledWith({channelId:latest.channelId,limit:80});
 expect(headings()).toHaveLength(1);
});

it('keeps the durable page range authoritative when a large snapshot includes unloaded runs with identical timestamps', async () => {
 const {props}=featureProps(),user=userEvent.setup();
 const snapshot=Array.from({length:180},(_,index)=>run(`${String(index).padStart(6,'0')}-run`));
 vi.mocked(props.api.getRuns)
  .mockResolvedValueOnce({runs:snapshot.slice(100),hasMore:true,cursor:'older-100'})
  .mockResolvedValueOnce({runs:snapshot.slice(20,100),hasMore:true,cursor:'older-20'})
  .mockResolvedValueOnce({runs:snapshot.slice(0,20),hasMore:false});
 const view=render(<RunHistory {...props} runs={snapshot}/>,{wrapper:TestProviders});
 await screen.findByRole('button',{name:'加载更早运行'});
 expect(headings()).toHaveLength(80);
 expect(screen.queryByText('000099')).toBeNull();
 const fresh=run('fresh-run',{status:'running',finishedAt:''});
 const live=snapshot.map(value=>value.id===snapshot[179].id?{...value,status:'running' as const,finishedAt:''}:value);
 view.rerender(<RunHistory {...props} runs={[...live,fresh]}/>);
 expect(headings()).toHaveLength(81);
 expect(screen.getByRole('button',{name:/000179/}).textContent).toContain('运行中');
 expect(screen.getByRole('button',{name:/FRESH-/}).textContent).toContain('运行中');
 expect(screen.queryByText('000099')).toBeNull();
 await user.click(screen.getByRole('button',{name:'加载更早运行'}));
 await waitFor(()=>expect(headings()).toHaveLength(161));
 expect(props.api.getRuns).toHaveBeenNthCalledWith(2,{before:'older-100',limit:80});
 expect(screen.getByText('000099')).toBeTruthy();
 expect(screen.queryByText('000019')).toBeNull();
 await user.click(screen.getByRole('button',{name:'加载更早运行'}));
 await waitFor(()=>expect(headings()).toHaveLength(181));
 expect(props.api.getRuns).toHaveBeenNthCalledWith(3,{before:'older-20',limit:80});
 expect(screen.getByText('000019')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'加载更早运行'})).toBeNull();
});
