import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { APIError, keys, string } from './protocol.ts';
import type { NativeItem } from './protocol.ts';
import type { ProjectWorkLoop, Scope } from './project-loop.ts';
import type { Evidence } from './autonomy-types.ts';
import type { ExecutionCapture } from './verification-types.ts';
import { sourceVersion } from './source-version.ts';
import { now } from './store.ts';

/** Decode only a native shell's three literal argv words. Never evaluate shell text. */
export function executionCommand(raw:Record<string,any>):string {
  const command=typeof raw.command==='string'?raw.command:'';
  // An automatically reviewed native command starts as `agent` and completes
  // as `unifiedExecStartup`, with the same literal shell argv representation.
  if(!['agent','unifiedExecStartup'].includes(raw.source))return command;
  const words:string[]=[];let word='',quote='',started=false;
  for(let i=0;i<command.length;i++){
    const c=command[i];
    if(quote==="'"){if(c==="'")quote='';else word+=c;continue;}
    if(c==='\\'&&quote!=="'"){
      const next=command[++i];if(next===undefined)return command;
      word+=quote==='"'&&!['$','`','"','\\','\n'].includes(next)?'\\'+next:next==='\n'?'':next;started=true;continue;
    }
    if(quote==='"'){if(c==='"')quote='';else word+=c;continue;}
    if(c==="'"||c==='"'){quote=c;started=true;continue;}
    if(/\s/.test(c)){if(started){words.push(word);word='';started=false;}continue;}
    if(/[;|&()<>`$]/.test(c))return command;
    word+=c;started=true;
  }
  if(quote)return command;if(started)words.push(word);
  return words.length===3&&/^(?:\/bin\/)?(?:bash|zsh|sh)$/.test(words[0])&&['-c','-lc'].includes(words[1])?words[2]:command;
}

export class ExecutionEvidence {
  readonly loop:ProjectWorkLoop;
  constructor(loop:ProjectWorkLoop){this.loop=loop;}
  prepare(scope:Scope,input:Record<string,unknown>) {
    keys(input,['command']);const {project,run}=this.loop.scope(scope);
    if(!run.sessionId||!run.nativeTurnId)throw new APIError(409,'执行证据需要当前原生任务与轮次');
    const command=string(input.command,'command',20000);
    const previous=this.loop.rows<ExecutionCapture>('loop_executions',scope.projectId).find(row=>row.runId===scope.runId&&row.command===command&&['prepared','running'].includes(row.status));
    if(previous)return previous;
    const row:ExecutionCapture={id:randomUUID(),projectId:scope.projectId,channelId:scope.channelId,runId:scope.runId,threadId:run.sessionId,turnId:run.nativeTurnId,command,cwd:realpathSync(project.path),version:sourceVersion(project.path),status:'prepared',createdAt:now(),nativeCursor:Number((this.loop.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM native_items').get() as any).n)};
    this.loop.store.put('loop_executions',row);return row;
  }
  observing(threadId:string){return this.loop.store.all<ExecutionCapture>('loop_executions').some(row=>row.threadId===threadId&&['prepared','running'].includes(row.status));}
  observe(threadId:string,items:NativeItem[]) {
    const pending=this.loop.store.all<ExecutionCapture>('loop_executions').filter(row=>row.threadId===threadId&&['prepared','running'].includes(row.status));
    for(const record of pending)for(const item of items){
      const row=this.loop.store.get<ExecutionCapture>('loop_executions',record.id)!;
      if(!['prepared','running'].includes(row.status)||item.type!=='commandExecution'||item.turnId!==row.turnId||(item.raw.command!==row.command&&executionCommand(item.raw)!==row.command))continue;
      if(row.nativeItemId&&row.nativeItemId!==item.id)continue;
      const position=this.loop.store.db.prepare('SELECT rowid AS n FROM native_items WHERE id=?').get(item.id) as {n:number}|undefined;
      if(!position||position.n<=row.nativeCursor)continue;
      const raw=item.raw;const ended=['completed','failed','declined','interrupted'].includes(raw.status);
      let error=row.error;
      try{if(realpathSync(raw.cwd)!==row.cwd)error='原生命令目录与项目不同';if((row.status==='prepared'||ended)&&sourceVersion(row.cwd).digest!==row.version.digest)error='准备后或执行期间源文件发生变化';}
      catch{error='无法核对命令目录或源版本';}
      if(!ended){if(row.status==='prepared')this.loop.store.put('loop_executions',{...row,status:'running',nativeItemId:item.id,startedAt:now(),...(error?{error}:{})});continue;}
      const output=typeof raw.aggregatedOutput==='string'?raw.aggregatedOutput:'';
      const outputComplete=typeof raw.aggregatedOutput==='string'&&!raw.outputTruncated&&!raw.truncated&&!/output (?:was )?truncated|tokens truncated/i.test(output)&&Buffer.byteLength(output)<=4*1024*1024;
      if(!row.startedAt)error='未观察到原生命令开始，不能事后补写执行版本';
      const exitCode=Number.isInteger(raw.exitCode)?raw.exitCode:null;
      const data={command:row.command,nativeCommand:raw.command,cwd:row.cwd,exitCode,status:raw.status,output:Buffer.from(output).subarray(0,4*1024*1024).toString('utf8'),outputComplete,sourceVersion:row.version,boundVersion:!error,threadId,turnId:row.turnId,nativeItemId:item.id,...(error?{error}:{})};
      const time=now();const evidence:Evidence={id:randomUUID(),projectId:row.projectId,channelId:row.channelId,runId:row.runId,summary:`原生命令 · ${exitCode===null?'退出结果未知':`退出码 ${exitCode}`} · ${row.command.slice(0,160)}`,source:row.command,origin:'execution',observedAt:time,createdAt:time,data,digest:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
      this.loop.store.put('loop_evidence',evidence);this.loop.store.put('loop_executions',{...row,status:'captured',nativeItemId:item.id,evidenceId:evidence.id,...(error?{error}:{})});
      this.loop.strategy.evidenceObserved(evidence);this.loop.audit(row,'execution.captured',evidence.summary,undefined,{evidenceId:evidence.id,boundVersion:!error},'system');
    }
  }
  read(scope:Scope,input:Record<string,unknown>){keys(input,['id']);this.loop.scope(scope);const row=this.loop.store.get<ExecutionCapture>('loop_executions',string(input.id,'id',200));if(row?.projectId!==scope.projectId)throw new APIError(404,'执行记录不属于当前项目');return {...row,evidence:row.evidenceId?this.loop.store.get('loop_evidence',row.evidenceId):undefined};}
  recover(){for(const row of this.loop.store.all<ExecutionCapture>('loop_executions'))if(['prepared','running'].includes(row.status))this.loop.store.put('loop_executions',{...row,status:'unknown',error:'服务重启，执行期间源版本无法完整核验；请重新准备并执行'});}
}
