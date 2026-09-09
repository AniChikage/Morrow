#!/usr/bin/env node
// Invoked as a tool by the existing native task. The desktop credential is never
// passed to the agent; this file uses only its bounded, project-scoped run grant.
import { readFileSync } from 'node:fs';
const args=process.argv.slice(2);
const flag=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
try {
  const contextPath=flag('--context');if(!contextPath)throw new Error('缺少 --context');
  const context=JSON.parse(readFileSync(contextPath,'utf8'));
  const operation=flag('--operation')||'context';
  const inputPath=flag('--input');
  const input=inputPath?JSON.parse(readFileSync(inputPath==='-'?0:inputPath,'utf8')):{};
  const requestId=flag('--request-id');
  if(!['context','evidence.read','memory.search','memory.read','memory.recall','execution.read','verification.read'].includes(operation)&&!requestId)throw new Error('写操作需要稳定的 --request-id；重试必须沿用相同 ID 和输入');
  const response=await fetch(context.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${context.token}`},body:JSON.stringify({operation,input,...(requestId?{requestId}:{})}),signal:AbortSignal.timeout(30000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){process.stderr.write((error instanceof Error?error.message:'Morrow 工具调用失败')+'\n');process.exitCode=1;}
