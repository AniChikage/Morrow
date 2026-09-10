import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexNativeTransport } from '../service/codex-native-transport.ts';

async function fixture(mode: string, work: (client: CodexNativeTransport) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-cli-'));
  const executable = join(dir, 'codex');
  writeFileSync(executable, `#!${process.execPath}
import readline from 'node:readline';
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['app-server','--listen','stdio://']) || process.env.CODEX_CLI_PATH) process.exit(2);
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line); if(!m.id)return;
  if(process.env.FIXTURE_MODE==='exit')process.exit(0);
  if(process.env.FIXTURE_MODE==='hang')return;
  if(m.method==='initialize'){process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');return;}
  if(m.method==='thread/start'){
    const reply=Buffer.from(JSON.stringify({id:m.id,result:{thread:{id:'thread-1',status:{type:'idle'}},cwd:'/tmp',model:'测试',approvalPolicy:'on-request',sandbox:{type:'readOnly'}}})+'\\n');
    const at=reply.indexOf(Buffer.from('测试'))+1;process.stdout.write(reply.subarray(0,at));setTimeout(()=>process.stdout.write(reply.subarray(at)),10);return;
  }
  if(m.method==='turn/start'){
    if(process.env.FIXTURE_MODE==='crash-send')process.exit(0);
    process.stdout.write(JSON.stringify({id:m.id,error:{code:400,message:'rejected'}})+'\\n');
  }
});
`, { mode: 0o700 });
  const client = new CodexNativeTransport({ executable, env: { FIXTURE_MODE: mode, CODEX_CLI_PATH: '/retired/app/bridge' }, timeoutMs: mode === 'hang' ? 500 : 3000 });
  try { await work(client); } finally { client.close(); await new Promise(done => setTimeout(done, 30)); rmSync(dir, { recursive: true, force: true }); }
}

test('direct CLI decodes split Unicode and closes only its owned connection', async () => fixture('normal', async client => {
  const thread = await client.createThread('/tmp');
  assert.equal(thread.state.model, '测试'); assert.equal(client.host, null);
  assert.equal(client.backgroundReady, true); assert.match(client.threadStatus(thread.threadId).detail, /CLI/);
  const socket = client.socket; client.close();
  await new Promise(done => setTimeout(done, 30)); assert.equal(socket?.readyState, 3);
}));
test('CLI startup failure and initialization timeout fail promptly', async () => {
  await fixture('exit', async client => { await assert.rejects(client.connect(), /断开|退出/); });
  await fixture('hang', async client => { await assert.rejects(client.connect(), /超时/); });
  const client = new CodexNativeTransport({ executable: '/missing/morrow-codex' });
  try { await assert.rejects(client.connect(), /ENOENT/); } finally { client.close(); }
});
test('CLI exit during a mutation preserves delivery uncertainty', async () => fixture('crash-send', async client => {
  await client.createThread('/tmp');
  await assert.rejects(client.sendMessage('thread-1', 'one message', 'request-1'), (error: any) => error.outcomeUnknown === true);
}));
test('explicit CLI rejection remains definitive', async () => fixture('normal', async client => {
  await client.createThread('/tmp');
  await assert.rejects(client.sendMessage('thread-1', 'one message', 'request-1'), (error: any) => error.outcomeUnknown === false && error.message === 'rejected');
}));
