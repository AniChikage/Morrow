import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceVersion } from '../service/source-version.ts';

test('asset-rich projects hash complete large files with bounded buffers and detect tail changes',()=>{
  const root=mkdtempSync(join(tmpdir(),'nh-source-assets-'));
  try {
    const path=join(root,'video.mp4'),fd=openSync(path,'w');ftruncateSync(fd,65*1024*1024);closeSync(fd);
    const before=sourceVersion(root);assert.equal(before.bytes,65*1024*1024);assert.equal(before.scheme,'source-v2');
    const changed=openSync(path,'r+');writeSync(changed,Buffer.from('changed tail'),0,12,65*1024*1024-12);closeSync(changed);
    assert.notEqual(sourceVersion(root).digest,before.digest);
    const oversized=openSync(path,'r+');ftruncateSync(oversized,1024*1024*1024+1);closeSync(oversized);
    assert.throws(()=>sourceVersion(root),/1 GiB/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('nested dependency links and package caches stay outside Git source seals while application links still fail',()=>{
  const root=mkdtempSync(join(tmpdir(),'nh-source-deps-'));
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',root,...args],{stdio:'ignore'});
  try {
    git('init');git('config','user.email','acceptance@localhost');git('config','user.name','Morrow test');
    writeFileSync(join(root,'app.js'),'original');mkdirSync(join(root,'packages/cli/node_modules'),{recursive:true});mkdirSync(join(root,'.pnpm-store'));
    symlinkSync('/outside-dependency',join(root,'packages/cli/node_modules/dependency'));writeFileSync(join(root,'.pnpm-store/index.db'),'cache');
    git('add','.');git('commit','-m','fixture');
    const before=sourceVersion(root);assert.equal(before.coverage,'git-tracked-and-unignored');assert.equal(before.files,1);
    writeFileSync(join(root,'.pnpm-store/index.db'),'updated cache');assert.equal(sourceVersion(root).digest,before.digest);
    writeFileSync(join(root,'app.js'),'changed');assert.notEqual(sourceVersion(root).digest,before.digest);
    symlinkSync('/etc/hosts',join(root,'application-link'));assert.throws(()=>sourceVersion(root),/链接/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
