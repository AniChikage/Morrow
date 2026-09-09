import { randomUUID } from 'node:crypto';
import type { NativeTransport, NativeSnapshot, NativeWorkOptions } from '../service/native-conversations.ts';

/** Explicit native protocol double: no model, user repository or network is run. */
export class FakeReviewer implements NativeTransport {
  backgroundReady=true;
  snapshots=new Map<string,NativeSnapshot>();
  listeners=new Map<string,(s:NativeSnapshot)=>void>();
  sent:Array<{threadId:string;text:string;requestId:string;options?:NativeWorkOptions}>=[];
  interrupted:string[]=[];
  autoComplete=false;
  async connect(){}
  status(){return {connected:true,socketPath:'fake-reviewer',lastError:null};}
  async listThreads(){return [];}
  async createThread(cwd:string){const threadId=randomUUID(),snapshot:NativeSnapshot={threadId,ownerClientId:'fake-reviewer',revision:0,syncedAt:new Date().toISOString(),state:{cwd,model:'fake-review-model',turns:[]}};this.snapshots.set(threadId,snapshot);return snapshot;}
  async readThread(id:string){return structuredClone(this.snapshots.get(id)!);}
  async subscribe(id:string,listener:(s:NativeSnapshot)=>void){this.listeners.set(id,listener);return()=>{this.listeners.delete(id);};}
  async sendMessage(threadId:string,text:string,requestId='',_images?:Array<{path:string}>,options?:NativeWorkOptions){
    this.sent.push({threadId,text,requestId,options});const turnId=randomUUID(),snapshot=this.snapshots.get(threadId)!;
    snapshot.state.turns=[{turnId,status:'inProgress',params:{clientUserMessageId:requestId},items:[]}];
    this.emit(threadId);if(this.autoComplete)this.complete(threadId);
    return {turn:{id:turnId}};
  }
  emit(id:string){const s=this.snapshots.get(id)!;s.revision++;s.syncedAt=new Date().toISOString();this.listeners.get(id)?.(structuredClone(s));}
  report(id:string){const sent=this.sent.find(s=>s.threadId===id)!,subject=JSON.parse(sent.text.split('原始核验对象：')[1].split('\n')[0]);const ids=subject.decision?.expectations?.length?subject.decision.expectations.map((e:any)=>e.id):['feature'];return {verdict:'pass',summary:'隔离原生协议夹具完成只读核验',checks:ids.map((expectationId:string)=>({expectationId,verdict:'met',reason:'仅为协议夹具的检查结果'})),findings:[],limitations:['此记录为 fake native transport，不代表模型效果验收']};}
  complete(id=this.sent.at(-1)!.threadId,options:{report?:unknown;command?:boolean;status?:string;items?:any[]}={}){
    const snapshot=this.snapshots.get(id)!,turn=snapshot.state.turns[0];
    turn.status=options.status||'completed';turn.items=options.items||[...(options.command===false?[]:[{id:'check',type:'commandExecution',command:'read-only fixture check',cwd:snapshot.state.cwd,status:'completed',exitCode:0,aggregatedOutput:'fixture inspected'}]),{id:'final',type:'agentMessage',phase:'final_answer',text:'```morrow-verification\n'+JSON.stringify(options.report||this.report(id))+'\n```'}];this.emit(id);
  }
  async interrupt(threadId:string,turnId:string){this.interrupted.push(`${threadId}:${turnId}`);const s=this.snapshots.get(threadId);if(s)s.state.turns[0].status='interrupted';return {};}
  async respond(){throw new Error('reviewer must not approve requests');}
  close(){}
}
