import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkDecision } from '../service/channel-work.ts';
const block=(value:unknown)=>'```morrow-next\n'+JSON.stringify(value)+'\n```';
test('only bounded, explicit agent decisions can schedule more work',()=>{
 const decision={state:'wait',focus:'验证',reason:'等待新证据',nextStep:'检查测试结果',waitMinutes:20};
 assert.deepEqual(parseWorkDecision(block(decision)),decision);
 for(const value of [{...decision,state:'launch'},{...decision,waitMinutes:0},{...decision,waitMinutes:100000},{...decision,waitMinutes:1.5},{...decision,nextStep:''},{...decision,reason:'x'.repeat(2001)}])assert.equal(parseWorkDecision(block(value)),null);
 assert.equal(parseWorkDecision('没有新的工作。'),null);assert.equal(parseWorkDecision('```morrow-next\n{'),null);
});
test('legacy NoHuman decision blocks remain readable after the Morrow rename',()=>{
 const decision={state:'wait',focus:'兼容迁移',reason:'等待旧版数据导入完成',nextStep:'检查导入结果',waitMinutes:60};
 assert.deepEqual(parseWorkDecision('```nohuman-next\n'+JSON.stringify(decision)+'\n```'),decision);
});
