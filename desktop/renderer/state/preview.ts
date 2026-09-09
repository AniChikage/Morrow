import type { DesktopAPI, Snapshot, Channel, ConnectionInfo, WorkspaceEvent, RunOutputChunk } from '../../shared/types';
const createdAt = '2026-09-06T14:47:00.000Z';
const channels: Channel[] = [{id:'demo-system',projectId:'demo-atlas',name:'系统完善',goal:'持续提升 Atlas 的可靠性与产品体验。',runtime:'codex',model:'',status:'paused',intervalMinutes:60,maxRunsPerDay:8,permission:'read-only',nextRunAt:'',lastRunAt:'',sessionId:''},{id:'demo-growth',projectId:'demo-atlas',name:'运营洞察',goal:'发现有证据支持的用户体验与增长机会，区分假设和事实。',runtime:'claude',model:'',status:'paused',intervalMinutes:90,maxRunsPerDay:6,permission:'read-only',nextRunAt:'',lastRunAt:'',sessionId:''}];
const snapshot:Snapshot = {projects:[{id:'demo-atlas',name:'Atlas 示例项目',path:'',goal:'让每个产品团队都能把客户反馈转化为清晰、可验证的产品改进。',createdAt,isDemo:true}],channels,items:[
 {id:'demo-001',channelId:'demo-system',title:'空状态缺少下一步指引',summary:'首次进入反馈看板时，没有数据的团队难以找到导入入口。\n\n### 观察\n\n当前空状态只有“暂无反馈”，缺少可以直接完成的下一步。\n\n- 在空状态提供「导入反馈」入口\n- 保留使用示例数据探索的选项\n- 导入完成后自动返回看板',status:'verified',kind:'issue',evidence:['[示例证据] onboarding/review.md：5 位试用者中 3 位未找到导入入口。','[示例证据] 截图核对：空状态仅显示“暂无反馈”。'],nextStep:'设计带导入入口的空状态，并进行一次可用性验证。',createdAt,updatedAt:createdAt},
 {id:'demo-002',channelId:'demo-system',title:'导入失败需要可恢复的错误提示',summary:'[示例分析] 网络错误后缺少重试入口，用户无法确定反馈是否已经保存。',status:'investigating',kind:'issue',evidence:['[示例证据] 错误分支只显示通用提示，没有重试或保留输入。'],nextStep:'验证重试路径和数据去重，记录可复现步骤。',createdAt,updatedAt:createdAt},
 {id:'demo-003',channelId:'demo-growth',title:'把首条反馈变成激活时刻',summary:'[示例假设] 首次导入后提供清晰引导，可能帮助团队更早感受到整理反馈的价值。',status:'open',kind:'hypothesis',evidence:['[示例证据] 试用反馈提到“不知道接下来该做什么”。'],nextStep:'先验证用户行为，确认是否存在激活瓶颈。',createdAt,updatedAt:createdAt},
 {id:'demo-004',channelId:'demo-growth',title:'为高频反馈生成每周摘要',summary:'[示例机会] 将重复出现的反馈归纳为主题，帮助团队讨论下一步优先级。',status:'investigating',kind:'opportunity',evidence:['[示例证据] 产品会议每周手工整理重复反馈。'],nextStep:'调查摘要的实际使用场景，形成小范围试验。',createdAt,updatedAt:createdAt},
 {id:'demo-005',channelId:'demo-system',title:'反馈列表加载状态已统一',summary:'[示例结果] 加载、空状态和错误状态已分开处理。',status:'resolved',kind:'issue',evidence:['[示例证据] 已核对三种展示状态和键盘操作。'],nextStep:'持续观察后续使用反馈。',createdAt,updatedAt:createdAt}
],runs:[],events:[{id:'demo-event-1',channelId:'demo-system',runId:'',kind:'system',text:'这是明确标注的示例数据，不来自真实运行。示例频道不会执行或自动调度。',createdAt},{id:'demo-event-2',channelId:'demo-system',runId:'',kind:'assistant',text:'已整理 **3 个系统完善事项**，分别保留调查证据、状态和下一步。\n\n优先关注首次使用体验，以及导入失败后的恢复路径。',createdAt}],runtimes:[{id:'codex',name:'Codex',available:false,path:'',version:'',detail:'界面预览；请在桌面应用中检测本机 CLI。',canWrite:false},{id:'claude',name:'Claude Code',available:false,path:'',version:'',detail:'界面预览；请在桌面应用中检测本机 CLI。',canWrite:false},{id:'trae',name:'Trae CLI',available:false,path:'',version:'',detail:'界面预览；请在桌面应用中检测本机 CLI。',canWrite:false}]};
// This browser-only store is explicitly labelled as preview data. Desktop uses SQLite.
snapshot.items.forEach((item,index)=>Object.assign(item,{projectId:'demo-atlas',number:index+1,sourceChannelIds:[item.channelId],revision:1}));
snapshot.projects[0].runtime='codex';
snapshot.events.forEach(event=>event.projectId='demo-atlas');
const demoRun={id:'demo-run-001',projectId:'demo-atlas',channelId:'demo-system',runtime:'codex',status:'completed',startedAt:createdAt,finishedAt:'2026-09-06T14:49:00.000Z',summary:'[示例运行] 已检查空状态的改进方案。',sessionId:'demo-native-session',model:'',permission:'read-only' as const,trigger:'manual' as const,reportStatus:'missing' as const,reportError:'CLI 已完成；本轮没有看板报告。',exitCode:0};
snapshot.runs.push(demoRun);
const demoPrompt='[示例输入] 检查反馈看板的空状态，并记录可验证的改进建议。';
const demoReply='[示例输出] 已完成检查。空状态需要明确的导入入口和可恢复的失败提示。';
const demoChunks:RunOutputChunk[]=[{id:'demo-chunk-1',runId:demoRun.id,stream:'prompt',text:demoPrompt,createdAt,sequence:1},{id:'demo-chunk-2',runId:demoRun.id,stream:'stdout',text:'[示例原始输出] 正在检查反馈看板…\n',createdAt,sequence:2},{id:'demo-chunk-3',runId:demoRun.id,stream:'final',text:demoReply,createdAt,sequence:3}];
const connection: ConnectionInfo = {config:{mode:'local',host:'',port:43821,directory:''},connected:true,name:'界面预览 · 示例'};
const clone=()=>structuredClone(snapshot);
const unavailable=async():Promise<never>=>{throw new Error('请在 Morrow 桌面应用中执行此操作。');};
function audit(projectId:string,channelId:string,itemId:string,text:string,action:string,changes?:WorkspaceEvent['changes']){
 const event:WorkspaceEvent={id:crypto.randomUUID(),projectId,channelId,itemId,runId:'',kind:'system',actor:'human',action,text,createdAt:new Date().toISOString(),...(changes?{changes}:{})};snapshot.events.push(event);return structuredClone(event);
}
export function previewAPI():DesktopAPI {const api:DesktopAPI={
 getState:async()=>clone(),getConnection:async()=>connection,connect:unavailable,createProject:unavailable,createChannel:unavailable,
 updateChannel:async(id,data)=>{const channel=snapshot.channels.find(value=>value.id===id);if(!channel)throw new Error('频道不存在');const before=structuredClone(channel);Object.assign(channel,data);audit(channel.projectId,id,'','[预览] 更新了频道设置','channel.updated',{before,after:channel});return structuredClone(channel);},
 channelAction:unavailable,
 getNativeStatus:async()=>({available:false,connected:false,detail:'界面预览；原生对话需要在 Morrow 桌面应用中连接。',capabilities:{list:false,read:false,send:false,create:false,interrupt:false,respond:false}}),
 listNativeThreads:async()=>({status:await api.getNativeStatus(),threads:[]}),
 getNativeConversation:async channelId=>({channelId,status:await api.getNativeStatus(),items:[],requests:[],hasMore:false}),
 bindNativeThread:unavailable,createNativeThread:unavailable,sendNativeMessage:unavailable,interruptNativeTurn:unavailable,respondNativeRequest:unavailable,openNativeApp:unavailable,
 chooseNativeImages:unavailable,getNativeImage:unavailable,
 sendMessage:async(id,text)=>{const channel=snapshot.channels.find(value=>value.id===id);if(!channel)throw new Error('频道不存在');const event:WorkspaceEvent={id:crypto.randomUUID(),projectId:channel.projectId,channelId:id,runId:'',kind:'message',actor:'human',text,createdAt:new Date().toISOString()};snapshot.events.push(event);return structuredClone(event);},
 updateItem:async(id,status)=>api.patchItem(id,{status}),
 createItem:async({projectId,...data})=>{const now=new Date().toISOString();const item={id:crypto.randomUUID(),projectId,number:Math.max(0,...snapshot.items.filter(value=>value.projectId===projectId).map(value=>value.number||0))+1,sourceChannelIds:data.channelId?[data.channelId]:[],revision:1,channelId:data.channelId||'',title:data.title,summary:data.summary||'',status:data.status||'open',kind:data.kind||'feature',evidence:data.evidence||[],nextStep:data.nextStep||'',createdAt:now,updatedAt:now};snapshot.items.push(item);audit(projectId,item.channelId,item.id,'[预览] 新建了功能','item.created',{after:item});return structuredClone(item);},
 patchItem:async(id,data)=>{const item=snapshot.items.find(value=>value.id===id);if(!item)throw new Error('功能不存在');if(data.revision!==undefined&&data.revision!==item.revision)throw new Error('功能已被更新，请重新加载。');const before=structuredClone(item),revision=(item.revision||1)+1;Object.assign(item,data,{revision,updatedAt:new Date().toISOString()});audit(item.projectId||'',item.channelId,id,'[预览] 更新了功能','item.updated',{before,after:item});return structuredClone(item);},
 getRuns:async query=>({runs:structuredClone(snapshot.runs.filter(run=>(!query.projectId||run.projectId===query.projectId)&&(!query.channelId||run.channelId===query.channelId))),hasMore:false}),
 getRun:async id=>{const run=snapshot.runs.find(value=>value.id===id);if(!run)throw new Error('运行不存在');return {run:structuredClone(run),prompt:demoPrompt,finalOutput:demoReply};},
 getRunOutput:async(id,query)=>{const start=query.after?demoChunks.findIndex(chunk=>chunk.id===query.after)+1:0;const chunks=demoChunks.filter(chunk=>chunk.runId===id).slice(start,start+(query.limit||60));return {chunks:structuredClone(chunks),hasMore:start+chunks.length<demoChunks.length,cursor:chunks.at(-1)?.id};},
 openNativeSession:unavailable,
 loadDemo:async()=>({ok:true}),refreshRuntimes:async()=>structuredClone(snapshot.runtimes),
 getEvents:async query=>{let events=snapshot.events.filter(event=>(!query.projectId||event.projectId===query.projectId)&&(!query.channelId||event.channelId===query.channelId)&&(!query.itemId||event.itemId===query.itemId)&&(!query.runId||event.runId===query.runId));if(query.before){const index=events.findIndex(event=>event.id===query.before);events=index<0?[]:events.slice(0,index);}if(query.after){const index=events.findIndex(event=>event.id===query.after);events=index<0?[]:events.slice(index+1);}const limit=query.limit||80,page=events.slice(-limit);return {events:structuredClone(page),hasMore:events.length>limit,cursor:page[0]?.id};},
 chooseFolder:unavailable,openProjectFolder:unavailable,openDataFolder:unavailable,openExternal:async url=>{if(/^https?:\/\//.test(url))window.open(url,'_blank','noopener,noreferrer');},onCommand:()=>()=>{}
};return api;}
