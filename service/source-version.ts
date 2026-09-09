import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { APIError } from './protocol.ts';
import type { SourceVersion } from './verification-types.ts';

/** No project commands/hooks are run. Ignored dependencies/build products are outside this source seal. */
export function sourceVersion(directory:string):SourceVersion {
  const root=realpathSync(directory), maxBytes=1024*1024*1024, started=performance.now();
  // Dependencies are outside this source-only seal even when accidentally tracked
  // by Git. Keep assets and tracked build inputs; never silently sample large files.
  const dependencies=new Set(['node_modules','.pnpm-store']);
  const git=(args:string[])=>execFileSync('git',['-c','core.fsmonitor=false','-C',root,...args],{encoding:'utf8',timeout:3000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','ignore'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  let paths:string[]=[],head='',coverage:SourceVersion['coverage']='folder';
  try {
    const top=realpathSync(git(['rev-parse','--show-toplevel']).trim());
    if(top===root){paths=git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean);head=git(['rev-parse','--verify','HEAD']).trim();coverage='git-tracked-and-unignored';}
  } catch { /* Unborn repositories and plain local folders use the bounded traversal. */ }
  if(coverage==='folder'){
    const excluded=new Set(['.git',...dependencies,'.build','dist','build','.next','.cache','.DS_Store']);
    const visit=(dir:string)=>{for(const row of readdirSync(dir,{withFileTypes:true})){
      if(excluded.has(row.name))continue;
      const path=join(dir,row.name);
      if(row.isDirectory())visit(path);else paths.push(relative(root,path));
      if(paths.length>5000)throw new APIError(409,'源版本超过 5000 个文件，无法完整封存，不能报告验证通过');
    }};visit(root);
  }
  paths=[...new Set(paths)].filter(path=>!path.split('/').some(part=>dependencies.has(part))).sort();if(paths.length>5000)throw new APIError(409,'源版本超过 5000 个文件，无法完整封存');
  const hash=createHash('sha256').update('nohuman-source-v2\0'),buffer=Buffer.allocUnsafe(512*1024);let bytes=0;
  for(const path of paths){
    if(performance.now()-started>5000)throw new APIError(409,'源版本读取超过 5 秒，无法完整核验，请检查本地磁盘或项目规模');
    const full=join(root,path);let stat;try{stat=lstatSync(full);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){hash.update(JSON.stringify([path,'deleted']));continue;}throw error;}
    if(stat.isDirectory())throw new APIError(409,'源版本包含子模块目录，尚不能完整核验');
    if(!stat.isFile())throw new APIError(409,'源版本包含链接或特殊文件，尚不能完整核验目标内容');
    if(realpathSync(full)!==full)throw new APIError(409,'源文件父目录包含链接，不能核验项目外内容');
    bytes+=stat.size;if(bytes>maxBytes)throw new APIError(409,'源版本超过 1 GiB，无法完整封存');
    const fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW),content=createHash('sha256');
    try {
      const before=fstatSync(fd);
      if(!before.isFile()||before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size)throw new APIError(409,'读取期间源文件发生变化，请重新核验');
      let read=0,length;
      while((length=readSync(fd,buffer,0,buffer.length,null))>0){
        read+=length;if(read>stat.size||performance.now()-started>5000)throw new APIError(409,'源文件变化或读取超时，无法完整核验');
        content.update(buffer.subarray(0,length));
      }
      const after=fstatSync(fd);
      if(read!==stat.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new APIError(409,'读取期间源文件发生变化，请重新核验');
      hash.update(JSON.stringify([path,stat.mode&0o777,content.digest('hex')]));
    } finally {closeSync(fd);}
  }
  return {digest:hash.digest('hex'),head,files:paths.length,bytes,coverage,scheme:'source-v2'};
}
