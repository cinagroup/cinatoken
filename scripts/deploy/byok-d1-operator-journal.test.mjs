import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createByokD1OperatorJournal,inspectByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
const meta=()=>({runId:'c02-byok-a1b2c3d4e5f6',candidateSha256:'a'.repeat(64),priorManifestSha256:'b'.repeat(64)});
const base=resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging');
const root=()=>fs.mkdtempSync(resolve(base,'byok-journal-test-'));
const path=j=>resolve(j.directory,'journal.jsonl');
const childFile=fileURLToPath(new URL('./byok-d1-operator-journal-child.mjs',import.meta.url));
function child(workspace,mode) {
  // Do not inherit API tokens, connection strings or unrelated application env.
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['SYSTEMROOT','WINDIR','TEMP','TMP'].includes(k.toUpperCase())));
  const p=spawn(process.execPath,[childFile,workspace,mode],{windowsHide:true,env,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
  const done=new Promise((res,rej)=>{p.on('error',rej);p.on('close',(code,signal)=>res({code,signal,stdout,stderr}));});
  return {p,done};
}
test('exclusive reservation survives close and changing run ID; no alternate attempt',async()=>{
  const workspace=root(),j=createByokD1OperatorJournal(workspace,meta());
  await j.attempt('arm',async()=>7,()=>({rowsWritten:1}));j.close();
  assert.throws(()=>createByokD1OperatorJournal(workspace,meta()));
  assert.throws(()=>createByokD1OperatorJournal(workspace,{...meta(),runId:'c02-byok-000000000001'}));
  const r=inspectByokD1OperatorJournal(path(j));assert.deepEqual(r.attempts,{arm:'ACK'});assert.equal(r.mayReplay,false);
});
test('six actual processes contend for one fixed workspace reservation',async()=>{
  const workspace=root(),children=Array.from({length:6},()=>child(workspace,'race'));const results=await Promise.all(children.map(c=>c.done));
  assert.equal(results.filter(r=>r.stdout==='WON'&&r.code===0).length,1,JSON.stringify(results));
  assert.equal(results.filter(r=>r.stdout==='REFUSED'&&r.code===2).length,5);
});
for(const mode of ['crash-before','crash-after'])test('hard-killed process leaves durable PENDING / '+mode,async t=>{
  const workspace=root(),c=child(workspace,mode);t.after(()=>{if(c.p.exitCode===null&&c.p.signalCode===null)c.p.kill();});
  await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error('child did not enter live work')),15000);
    c.p.once('message',m=>{clearTimeout(timer);assert.equal(m.state,'live-pending');res();});c.p.once('error',e=>{clearTimeout(timer);rej(e);});});
  assert.equal(c.p.exitCode,null);assert.equal(c.p.signalCode,null);assert.equal(c.p.kill('SIGKILL'),true);await c.done;
  assert.throws(()=>createByokD1OperatorJournal(workspace,meta()));
  const r=inspectByokD1OperatorJournal(resolve(workspace,'.wrangler/staging/byok-d1-execution-reservation/journal.jsonl'));
  assert.equal(r.attempts.arm,'PENDING');assert.equal(r.mayReplay,false);
  assert.equal(fs.existsSync(resolve(workspace,'synthetic-side-effect')),mode==='crash-after');
});
test('PENDING is fsynced and inspectable before callback; ACK follows it',async()=>{
  const j=createByokD1OperatorJournal(root(),meta());
  const value=await j.attempt('arm',async()=>{assert.equal(inspectByokD1OperatorJournal(path(j)).attempts.arm,'PENDING');return 'private-result';});
  assert.equal(value,'private-result');assert.ok(!fs.readFileSync(path(j),'utf8').includes(value));assert.equal(j.snapshot().attempts.arm,'ACK');j.close();
});
test('duplicate simultaneous calls invoke at most once and live work cannot be closed',async()=>{
  const j=createByokD1OperatorJournal(root(),meta());let release,calls=0;const first=j.attempt('arm',()=>{calls++;return new Promise(r=>release=r);});
  await assert.rejects(j.attempt('arm',()=>{calls++;}));assert.throws(()=>j.close());release();await first;assert.equal(calls,1);j.close();
});
test('unknown work poisons ordinary flow but distinct containment remains possible',async()=>{
  const j=createByokD1OperatorJournal(root(),meta());const secret='do-not-log-provider-secret';
  await assert.rejects(j.attempt('arm',()=>{throw Error(secret);}),/byok_operator_attempt_failed/);
  await assert.rejects(j.attempt('case-0',()=>assert.fail('must not invoke')));
  let closed=0;await j.attempt('close-gateway',()=>{closed++;});assert.equal(closed,1);
  await assert.rejects(j.attempt('close-gateway',()=>{closed++;}));assert.equal(closed,1);
  assert.ok(!fs.readFileSync(path(j),'utf8').includes(secret));assert.equal(inspectByokD1OperatorJournal(path(j)).attempts.arm,'FAILED_OR_UNCERTAIN');j.close();
});
test('invalid summary cannot leak credentials or turn the attempt into success',async()=>{
  const j=createByokD1OperatorJournal(root(),meta());
  await assert.rejects(j.attempt('arm',async()=>({Authorization:'secret'}),v=>v));
  assert.ok(!fs.readFileSync(path(j),'utf8').includes('Authorization'));assert.equal(j.snapshot().poisoned,true);j.close();
});
for(const fault of ['write','zero-write','fsync'])test('failed PENDING forbids new work / '+fault,async()=>{
  let armed=false;const io={...fs,writeSync(...args){if(armed&&fault==='write')throw Error('disk');if(armed&&fault==='zero-write')return 0;return fs.writeSync(...args);},
    fsyncSync(fd){if(armed&&fault==='fsync')throw Error('disk');return fs.fsyncSync(fd);}};
  const j=createByokD1OperatorJournal(root(),meta(),{io});armed=true;let calls=0;
  await assert.rejects(j.attempt('arm',()=>{calls++;}));assert.equal(calls,0);assert.equal(j.snapshot().attempts.arm,'NOT_INVOKED');
  await assert.rejects(j.attempt('close-gateway',()=>{calls++;}));assert.equal(calls,1);assert.equal(j.snapshot().poisoned,true);j.close();
});
test('short filesystem writes are fully handled',async()=>{
  const io={...fs,writeSync(fd,data,offset,length){return fs.writeSync(fd,data,offset,Math.min(length,7));}};
  const j=createByokD1OperatorJournal(root(),meta(),{io});await j.attempt('arm',async()=>{});j.close();assert.equal(inspectByokD1OperatorJournal(path(j)).records,3);
});
test('ACK fsync failure after effect is uncertain, not replayed',async()=>{
  let syncs=0,calls=0;const io={...fs,fsyncSync(fd){if(++syncs===3)throw Error('lost ACK flush');return fs.fsyncSync(fd);}};
  const j=createByokD1OperatorJournal(root(),meta(),{io});await assert.rejects(j.attempt('arm',()=>{calls++;}));
  await assert.rejects(j.attempt('arm',()=>{calls++;}));assert.equal(calls,1);assert.equal(j.snapshot().attempts.arm,'FAILED_OR_UNCERTAIN');j.close();
  assert.throws(()=>inspectByokD1OperatorJournal(path(j))); // Ambiguous tail never repaired silently.
});
test('recovery inspector rejects changed, truncated and reordered history',async()=>{
  const workspace=root(),j=createByokD1OperatorJournal(workspace,meta());await j.attempt('arm',async()=>{});j.close();
  const original=fs.readFileSync(path(j),'utf8'),rows=original.trimEnd().split('\n');
  for(const [name,body] of [['changed',original.replace('ACK','FAK')],['truncated',original.slice(0,-1)],['reordered',[rows[0],rows[2],rows[1]].join('\n')+'\n']]){
    const file=resolve(workspace,name+'.jsonl');fs.writeFileSync(file,body,{flag:'wx'});assert.throws(()=>inspectByokD1OperatorJournal(file));
  }
});
test('existing linked staging directory is not followed',()=>{
  const workspace=root(),elsewhere=root();fs.mkdirSync(resolve(workspace,'.wrangler'));
  fs.symlinkSync(elsewhere,resolve(workspace,'.wrangler/staging'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>createByokD1OperatorJournal(workspace,meta()));assert.deepEqual(fs.readdirSync(elsewhere),[]);
});
for(const m of [{...meta(),runId:'../../outside'},{...meta(),candidateSha256:'bad'},{...meta(),secret:'must-not-be-accepted'}])test('metadata rejected before reserving a directory / '+Object.keys(m).join(','),()=>{
  const workspace=root();assert.throws(()=>createByokD1OperatorJournal(workspace,m));assert.deepEqual(fs.readdirSync(workspace),[]);
});
