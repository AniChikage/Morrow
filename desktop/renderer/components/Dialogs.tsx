import { useEffect, useId, useRef, useState, type ReactNode, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, FolderOpen, Plus, Search, Hash, Folder, FileText, Laptop, Server, ArrowUpRight, Check } from 'lucide-react';
import { Button, IconButton, StatusIcon } from './ui';
import { runtimeLabel, kindLabel } from './format';
import { useWorkspace } from '../state/workspace';
import type { Channel, ChannelPatch, ConnectionConfig, Route, RuntimeID, WorkItem, ItemPatch } from '../../shared/types';

export type ModalState = {kind:'project'} | {kind:'channel';projectId:string;channel?:Channel} | {kind:'feature';projectId:string;item?:WorkItem} | {kind:'search'} | {kind:'settings'} | null;
export function Dialogs({modal,onClose,onNavigate}:{modal:ModalState;onClose:()=>void;onNavigate:(route:Route,newTab?:boolean)=>void}) {
 if(!modal)return null;
 if(modal.kind==='project')return <ProjectDialog onClose={onClose} onNavigate={onNavigate}/>;
 if(modal.kind==='channel')return <ChannelDialog key={modal.channel?.id||modal.projectId} {...modal} onClose={onClose} onNavigate={onNavigate}/>;
 if(modal.kind==='feature')return <FeatureDialog key={modal.item?.id||modal.projectId} {...modal} onClose={onClose} onNavigate={onNavigate}/>;
 if(modal.kind==='search')return <SearchDialog onClose={onClose} onNavigate={onNavigate}/>;
 return <SettingsDialog onClose={onClose}/>;
}
function Modal({title,description,children,onClose,className=''}:{title:string;description:string;children:ReactNode;onClose:()=>void;className?:string}) {
 const ref=useRef<HTMLDivElement>(null);
 return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content ref={ref} className={`dialog-content ${className}`} onOpenAutoFocus={event=>{const el=ref.current?.querySelector<HTMLElement>('[data-autofocus]');if(el){event.preventDefault();el.focus();}}}><div className="dialog-heading"><div><Dialog.Title className="dialog-title">{title}</Dialog.Title><Dialog.Description className="dialog-description">{description}</Dialog.Description></div><Dialog.Close asChild><IconButton label="关闭" className="dialog-close"><X/></IconButton></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
function Field({title,hint,children}:{title:string;hint?:string;children:ReactNode}) { return <label className="form-field"><span className="field-label">{title}</span>{children}{hint&&<small>{hint}</small>}</label>; }
function ProjectDialog({onClose,onNavigate}:{onClose:()=>void;onNavigate:(route:Route,newTab?:boolean)=>void}) {
 const {api,connection,mutate,busy,error,clearError,snapshot}=useWorkspace();
 const [name,setName]=useState(''),[path,setPath]=useState(''),[goal,setGoal]=useState(''),[runtime,setRuntime]=useState<RuntimeID>('codex'),[localError,setLocalError]=useState('');
 const remote=connection?.config.mode==='ssh';
 const existing=path.trim()?snapshot.projects.find(project=>!project.isDemo&&project.path===path.trim()):undefined;
 useEffect(()=>clearError(),[]);
 async function choose(){try{const folder=await api.chooseFolder();if(folder){setPath(folder);if(!name)setName(folder.split('/').filter(Boolean).pop()||'');setLocalError('');}}catch(e){setLocalError(e instanceof Error?e.message:String(e));}}
 async function submit(e:FormEvent){
  e.preventDefault();
  if(existing){onNavigate({kind:'project',id:existing.id},true);onClose();return;}
  let projectId='';
  const ok=await mutate(async()=>{const project=await api.createProject({name:name.trim()||path.split('/').filter(Boolean).pop()||'项目',path:path.trim(),goal:goal.trim()||'持续跟踪项目进展，识别有证据支持的问题，在授权范围内推进修复并验证结果。',runtime});projectId=project.id;});
  if(ok){onNavigate({kind:'project',id:projectId},true);onClose();}
 }
 return <Modal title="打开项目文件夹" description="把已有项目接入 Morrow，统一跟踪功能与持续改进。" onClose={onClose}>
  <form onSubmit={submit}>
   <Field title={remote?'远程项目目录':'项目文件夹'}><span className="input-action"><input data-autofocus value={path} onChange={e=>setPath(e.target.value)} placeholder={remote?'/home/user/projects/atlas':'选择本机项目文件夹'} required/>{!remote&&<Button onClick={()=>void choose()}><FolderOpen/>选择文件夹</Button>}</span></Field>
   <Field title="项目名称"><input value={name} onChange={e=>setName(e.target.value)} placeholder="默认使用文件夹名称" maxLength={100}/></Field>
   <Field title="默认运行时" hint="使用 CLI 已有登录；原生会话继续由 CLI 管理。"><select value={runtime} onChange={e=>setRuntime(e.target.value as RuntimeID)}>{(['codex','claude','trae'] as const).map(id=><option key={id} value={id}>{runtimeLabel(id)}</option>)}</select></Field>
   <Field title="持续目标" hint="可以留空，稍后在频道中细化长期职责。"><textarea value={goal} onChange={e=>setGoal(e.target.value)} placeholder="例如：持续检查关键流程，发现问题、修复并验证。" maxLength={10000}/></Field>
   <p className="form-note">所有频道共用这个项目的功能看板。接入后可打开原生 CLI，也可开启持续跟踪；频道初始保持暂停。</p>
   {existing&&<p className="form-note">这个文件夹已接入，将打开已有项目。</p>}
   {(error||localError)&&<p role="alert" className="form-error">{localError||error}</p>}
   <div className="form-actions"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy||!path.trim()}>{busy?'正在接入…':existing?'打开已有项目':'打开项目'}</Button></div>
  </form>
 </Modal>;
}
function FeatureDialog({projectId,item,onClose,onNavigate}:{projectId:string;item?:WorkItem;onClose:()=>void;onNavigate:(route:Route,newTab?:boolean)=>void}) {
 const {api,snapshot,mutate,busy,error,clearError}=useWorkspace();
 const [title,setTitle]=useState(item?.title||''),[summary,setSummary]=useState(item?.summary||''),[kind,setKind]=useState(item?.kind||'feature'),[status,setStatus]=useState(item?.status||'open'),[channelId,setChannelId]=useState(item?.channelId||'');
 const [evidence,setEvidence]=useState<string[]>(item?.evidence||[]),[nextStep,setNextStep]=useState(item?.nextStep||''),[revision,setRevision]=useState(item?.revision);
 const latest=item?snapshot.items.find(value=>value.id===item.id):undefined;
 const stale=!!item&&latest?.revision!==undefined&&revision!==latest.revision;
 const channels=snapshot.channels.filter(channel=>channel.projectId===projectId);
 useEffect(()=>clearError(),[]);
 function reload(){if(!latest)return;setTitle(latest.title);setSummary(latest.summary);setKind(latest.kind);setStatus(latest.status);setEvidence(latest.evidence);setNextStep(latest.nextStep);setRevision(latest.revision);clearError();}
 async function submit(e:FormEvent){e.preventDefault();let itemId=item?.id||'';const fields:ItemPatch={title:title.trim(),summary:summary.trim(),kind,status,evidence:evidence.map(value=>value.trim()).filter(Boolean),nextStep:nextStep.trim()};
  const ok=await mutate(async()=>{if(item)await api.patchItem(item.id,{...fields,...(revision!==undefined?{revision}:{})});else{const value=await api.createItem({projectId,...fields,title:fields.title!,channelId});itemId=value.id;}});
  if(ok){onNavigate({kind:'finding',id:itemId});onClose();}
 }
 return <Modal title={item?'编辑功能':'新建功能'} description="功能保存在项目统一看板，所有频道共享进展与证据。" onClose={onClose}>
  <form onSubmit={submit}>
   <Field title="标题"><input data-autofocus value={title} onChange={e=>setTitle(e.target.value)} maxLength={300} placeholder="描述一个需要推进的功能或问题" required/></Field>
   <Field title="描述"><textarea className="feature-description-input" value={summary} onChange={e=>setSummary(e.target.value)} maxLength={10000} placeholder="目标、背景与验收标准，支持 Markdown。"/></Field>
   <div className="form-row"><Field title="类型"><select value={kind} onChange={e=>setKind(e.target.value)}><option value="feature">功能</option><option value="issue">问题</option><option value="opportunity">机会</option><option value="hypothesis">假设</option></select></Field><Field title="状态"><select value={status} onChange={e=>setStatus(e.target.value)}><option value="open">待处理</option><option value="investigating">进行中</option><option value="verified">已验证</option><option value="resolved">已解决</option><option value="blocked">受阻</option></select></Field></div>
   {!item&&<Field title="关联频道"><select value={channelId} onChange={e=>setChannelId(e.target.value)}><option value="">人工创建 · 暂不关联</option>{channels.map(channel=><option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></Field>}
   <details className="feature-form-details" open={!!item}><summary>证据与下一步</summary><div className="feature-evidence-fields">{evidence.map((value,index)=><div className="feature-evidence-field" key={index}><Field title={`证据 ${index+1}`}><textarea value={value} onChange={e=>setEvidence(previous=>previous.map((entry,i)=>i===index?e.target.value:entry))} maxLength={5000} placeholder="可复查的路径、日志或验证结果"/></Field><IconButton label={`移除证据 ${index+1}`} onClick={()=>setEvidence(previous=>previous.filter((_,i)=>i!==index))}><X size={14}/></IconButton></div>)}<Button variant="ghost" onClick={()=>setEvidence(previous=>[...previous,''])} disabled={evidence.length>=50}><Plus size={14}/>添加证据</Button></div><Field title="下一步"><textarea value={nextStep} onChange={e=>setNextStep(e.target.value)} maxLength={5000} placeholder="明确下一次要推进的工作。"/></Field></details>
   {stale&&<p className="form-error">此功能已有新的修改。<button type="button" onClick={reload}>重新载入最新内容</button></p>}
   {error&&<p role="alert" className="form-error">{error}</p>}
   <div className="form-actions"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy||stale||!title.trim()}>{busy?'正在保存…':item?'保存修改':'创建功能'}</Button></div>
  </form>
 </Modal>;
}
function ChannelDialog({projectId,channel,onClose,onNavigate}:{projectId:string;channel?:Channel;onClose:()=>void;onNavigate:(route:Route)=>void}) {
 const {api,mutate,busy,error,clearError,snapshot}=useWorkspace();const [name,setName]=useState(channel?.name||'');const [goal,setGoal]=useState(channel?.goal||'');const [runtime,setRuntime]=useState<RuntimeID>(channel?.runtime||'codex');const [model,setModel]=useState(channel?.model||'');const [permission,setPermission]=useState<Channel['permission']>(channel?.permission||'workspace-write');const [interval,setInterval]=useState(channel?.intervalMinutes||60);const [budget,setBudget]=useState(channel?.maxRunsPerDay||32);const running=channel&&snapshot.channels.find(c=>c.id===channel.id)?.status==='running';
 useEffect(()=>clearError(),[]);
 async function submit(e:FormEvent){e.preventDefault();const ok=await mutate(async()=>{if(channel){const data:ChannelPatch={name:name.trim(),goal:goal.trim(),intervalMinutes:interval,maxRunsPerDay:budget};if(!running){if(runtime!==channel.runtime)data.runtime=runtime;if(model!==channel.model)data.model=model.trim();if(permission!==channel.permission)data.permission=permission;}await api.updateChannel(channel.id,data);}else{const c=await api.createChannel({projectId,name:name.trim(),goal:goal.trim(),runtime,model:model.trim(),permission,intervalMinutes:interval,maxRunsPerDay:budget});onNavigate({kind:'channel',id:c.id});}});if(ok)onClose();}
 return <Modal title={channel?'调整工作方向':'新建频道'} description="告诉 Codex 长期关注什么，它会自主选择下一步，你可以随时通过对话指导。" onClose={onClose}><form onSubmit={submit}><Field title="频道名称"><input data-autofocus value={name} onChange={e=>setName(e.target.value)} placeholder="例如：性能与稳定性" maxLength={100} required/></Field><Field title="工作方向"><textarea value={goal} onChange={e=>setGoal(e.target.value)} placeholder="例如：持续改善用户体验，主动发现值得做的改进，完成后验证效果。" maxLength={10000} required/></Field><details className="feature-form-details"><summary>工作设置</summary><div className="form-row"><Field title="运行引擎"><select value={runtime} onChange={e=>{setRuntime(e.target.value as RuntimeID);setModel('');if(e.target.value!=='codex'&&permission==='native')setPermission('workspace-write');}} disabled={running}>{(['codex','claude','trae'] as const).map(id=><option key={id} value={id}>{runtimeLabel(id)}</option>)}</select></Field><Field title="模型"><input value={model} onChange={e=>setModel(e.target.value)} placeholder="CLI 默认模型" disabled={running}/></Field></div><Field title="执行权限"><select value={permission} onChange={e=>setPermission(e.target.value as Channel['permission'])} disabled={running}><option value="read-only">只读工作空间</option><option value="workspace-write">允许工作区写入</option>{runtime==='codex'&&<option value="native">沿用 Codex App 原生权限</option>}</select></Field><div className="form-row"><Field title="复查间隔（分钟）"><input type="number" value={interval} onChange={e=>setInterval(Number(e.target.value))} min={1} max={1440} required/></Field><Field title="每日运行上限"><input type="number" value={budget} onChange={e=>setBudget(Number(e.target.value))} min={1} max={100} required/></Field></div></details><p className="form-note">{running?'暂停频道后可以更换引擎、模型或执行权限。':'保存后可在频道开始工作。已有对话和进展会保留。'}</p>{error&&<p className="form-error" role="alert">{error}</p>}<div className="form-actions"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy||!name.trim()||!goal.trim()||interval<1||interval>1440||budget<1||budget>100}>{busy?'正在保存…':channel?'保存方向':'创建频道'}</Button></div></form></Modal>;
}
function SearchDialog({onClose,onNavigate}:{onClose:()=>void;onNavigate:(route:Route,newTab?:boolean)=>void}) {
 const {snapshot}=useWorkspace();const [query,setQuery]=useState('');const [selected,setSelected]=useState(0);const listId=useId();
 const matches=(v:string)=>v.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
 const results=[...snapshot.projects.filter(p=>matches(p.name+' '+p.goal)).map(p=>({route:{kind:'project' as const,id:p.id},title:p.name,detail:'项目',icon:<Folder size={16}/>})),...snapshot.channels.filter(c=>matches(c.name+' '+c.goal)).map(c=>({route:{kind:'channel' as const,id:c.id},title:c.name,detail:snapshot.projects.find(p=>p.id===c.projectId)?.name||'频道',icon:<Hash size={16}/>})),...snapshot.items.filter(i=>matches(i.title+' '+i.summary+' '+i.evidence.join(' '))).map(i=>({route:{kind:'finding' as const,id:i.id},title:i.title,detail:kindLabel(i.kind),icon:<StatusIcon status={i.status}/>}))].slice(0,40);
 function choose(index:number){if(results[index]){onNavigate(results[index].route,true);onClose();}}
 return <Modal title="搜索工作空间" description="搜索项目、频道、发现与证据。" onClose={onClose} className="search-dialog"><div className="global-search-input"><Search size={18}/><input data-autofocus role="combobox" aria-label="搜索工作空间" aria-autocomplete="list" aria-controls={listId} aria-expanded="true" aria-activedescendant={results[selected]?`${listId}-${selected}`:undefined} placeholder="搜索项目、发现或关键词…" value={query} onChange={e=>{setQuery(e.target.value);setSelected(0);}} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setSelected(v=>Math.min(results.length-1,v+1));}else if(e.key==='ArrowUp'){e.preventDefault();setSelected(v=>Math.max(0,v-1));}else if(e.key==='Enter'){e.preventDefault();choose(selected);}}}/></div><div id={listId} className="search-results" role="listbox" aria-label="搜索结果">{results.map((r,i)=><button id={`${listId}-${i}`} role="option" aria-selected={i===selected} className="search-result" key={r.route.kind+r.route.id} onMouseEnter={()=>setSelected(i)} onClick={()=>choose(i)}>{r.icon}<span>{r.title}<small>{r.detail}</small></span>{i===selected&&<span className="search-enter">↵</span>}</button>)}{!results.length&&<p className="search-empty">没有找到相关内容</p>}</div><div className="search-footer"><span>{results.length} 个结果</span><span>↑ ↓ 选择　↵ 打开　Esc 关闭</span></div></Modal>;
}
function SettingsDialog({onClose}:{onClose:()=>void}) {
 const {api,connection,busy,mutate,error,reset,setConnectionInfo,clearError}=useWorkspace();const [config,setConfig]=useState<ConnectionConfig>(connection?.config||{mode:'local',host:'',port:43821,directory:'~/.local/share/morrow'});const [saved,setSaved]=useState(false);const remoteConfig=useRef<ConnectionConfig>(connection?.config.mode==='ssh'?connection.config:{mode:'ssh',host:'',port:43821,directory:'~/.local/share/morrow'});
 function changeMode(mode:ConnectionConfig['mode']){setSaved(false);setConfig(current=>{if(current.mode===mode)return current;if(current.mode==='ssh')remoteConfig.current=current;return mode==='ssh'?remoteConfig.current:{mode:'local',host:'',port:43821,directory:''};});}
 useEffect(()=>clearError(),[]);
 async function submit(e:FormEvent){e.preventDefault();setSaved(false);reset();const ok=await mutate(async()=>{const info=await api.connect(config);setConnectionInfo(info);if(!info.connected)throw new Error(info.error||'连接失败，请检查执行位置。');});if(ok)setSaved(true);}
 return <Modal title="设置" description="管理桌面应用连接的执行位置。" onClose={onClose}><form onSubmit={submit}><fieldset className="settings-fields" disabled={busy}><div className="settings-section-title">执行位置</div><div className="segmented settings-mode"><button type="button" aria-pressed={config.mode==='local'} onClick={()=>changeMode('local')}><Laptop size={14}/>本机 Mac</button><button type="button" aria-pressed={config.mode==='ssh'} onClick={()=>changeMode('ssh')}><Server size={14}/>远程 SSH</button></div>{config.mode==='ssh'?<><Field title="SSH 主机" hint="使用已有 SSH 配置中的主机别名或 user@host。"><input value={config.host} onChange={e=>{setSaved(false);setConfig(c=>({...c,host:e.target.value}));}} placeholder="dev-box" required/></Field><div className="form-row"><Field title="服务端口"><input type="number" min={1} max={65535} value={config.port} onChange={e=>{setSaved(false);setConfig(c=>({...c,port:Number(e.target.value)}));}} required/></Field><Field title="远程数据目录"><input value={config.directory} onChange={e=>{setSaved(false);setConfig(c=>({...c,directory:e.target.value}));}} placeholder="~/.local/share/morrow" required/></Field></div><p className="form-note">远端需要先启动 Morrow 执行服务。通过已有 SSH 登录连接，执行和数据保留在远端。</p></>:<p className="form-note">项目和执行记录保存在这台 Mac。关闭界面后，独立执行服务继续运行。</p>}</fieldset>{error&&<p role="alert" className="form-error">{error}</p>}{saved&&<p role="status" className="settings-saved"><Check size={14}/>已连接到{config.mode==='local'?'本机 Mac':config.host}</p>}<div className="form-actions"><Button variant="ghost" onClick={()=>void mutate(()=>api.openDataFolder())}><FolderOpen/>数据目录</Button><span className="spacer"/><Button onClick={onClose}>完成</Button><Button variant="primary" type="submit" disabled={busy||config.mode==='ssh'&&!config.host.trim()}>{busy?'正在连接…':'连接'}</Button></div></form><div className="settings-about"><span>Morrow</span><span>0.3.0 · Electron / React</span></div></Modal>;
}
