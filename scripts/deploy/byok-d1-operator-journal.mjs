import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const hex=/^[a-f0-9]{64}$/,run=/^c02-byok-[a-f0-9]{12}$/;
const steps=new Set(['preflight','baseline','arm','open-access','open-gateway','stop','seal-fence','cleanup','final-verify',
  'create-token','open-controller-access','open-controller',
  'deploy-receiver','deploy-controller','deploy-gateway',
  'install-fence','open-fence','arm-maintenance',...Array.from({length:10},(_,i)=>'verify-case-'+i),
  'closure-before','closure-fresh','closure-after',...Array.from({length:10},(_,i)=>'case-'+i),
  'close-gateway','close-controller','close-access','close-controller-access','revoke-token']);
// Stopping admissions and sealing an installed fence remain available after
// unknown case outcomes. Neither step may reopen a fence, reset a permit or
// authorize cleanup. Each is still consumed once, even after journal I/O fails.
const containment=new Set(['stop','seal-fence','close-gateway','close-controller','close-access','close-controller-access','revoke-token']);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function facts(value) {
  assert.ok(value&&Object.getPrototypeOf(value)===Object.prototype);
  for(const [key,v] of Object.entries(value)) {
    if(key==='evidenceSha256')assert.match(v,hex);
    else {assert.ok(['logicalApiReads','rowsRead','rowsWritten','publicHttp','completedCases'].includes(key));assert.ok(integer(v)&&v<=10000000);}
  }
  return {...value};
}
function input(value) {
  assert.deepEqual(Object.keys(value).sort(),['candidateSha256','priorManifestSha256','runId']);
  assert.match(value.runId,run);assert.match(value.candidateSha256,hex);assert.match(value.priorManifestSha256,hex);
  return {...value};
}

/** Host-only journal. The fixed reservation blocks ALL later runs in this
 * workspace, even with a different run ID, after a crash or after close().
 * No resume/release/delete API. Local filesystem exclusivity is not a distributed
 * lock, a cloud CAS, an OS power-loss guarantee, or proof that a PID is alive.
 * io overrides are for filesystem fault tests; production uses node:fs.
 */
export function createByokD1OperatorJournal(workspace,metadata,{io=fs}={}) {
  const meta=input(structuredClone(metadata)),root=fs.realpathSync(workspace);
  assert.ok(!root.startsWith('\\\\'),'Network shares are not supported');
  const inside=path=>{const rel=relative(root,path);assert.ok(rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../'));};
  let parent=root;
  for(const part of ['.wrangler','staging']) {
    parent=resolve(parent,part);inside(parent);
    try{fs.mkdirSync(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    assert.ok(fs.lstatSync(parent).isDirectory()&&!fs.lstatSync(parent).isSymbolicLink());
    assert.equal(fs.realpathSync(parent),parent);
  }
  const directory=resolve(parent,'byok-d1-execution-reservation');inside(directory);
  fs.mkdirSync(directory); // Deliberately no EEXIST recovery and no alternate suffix.
  let fd,sequence=0,previous='0'.repeat(64),written=0,closed=false,poisoned=false,active=0;
  const attempted=new Set(),states=new Map(),epoch=randomUUID();
  function append(step,outcome,detail={}) {
    assert.ok(!closed&&fd!==undefined);
    const event={sequence:sequence+1,epoch,previous,step,outcome,facts:detail};
    const body=JSON.stringify(event),row={...event,sha256:hash(body)},data=Buffer.from(JSON.stringify(row)+'\n');
    assert.ok(data.length<=4096&&written+data.length<=262144&&sequence<128);
    for(let offset=0;offset<data.length;) {
      const n=io.writeSync(fd,data,offset,data.length-offset);assert.ok(Number.isInteger(n)&&n>0&&n<=data.length-offset);offset+=n;
    }
    io.fsyncSync(fd);written+=data.length;sequence++;previous=row.sha256;
  }
  try {
    fd=io.openSync(resolve(directory,'journal.jsonl'),'wx',0o600);
    append('reservation','RESERVED',{...meta,firstRoundUsdCap:2,capReset:false});
  }catch {if(fd!==undefined)try{io.closeSync(fd);}catch{};throw Error('byok_journal_reservation_failed');}
  async function attempt(step,work,summarize=()=>({})) {
    assert.ok(steps.has(step)&&typeof work==='function'&&typeof summarize==='function');
    assert.ok(!closed&&!attempted.has(step),'Attempt cannot be replayed');
    const closing=containment.has(step);assert.ok(closing||!poisoned,'Journal is stopped');
    assert.ok(sequence<(closing?126:96),'Journal capacity reserved for containment');
    attempted.add(step);states.set(step,'RESERVED');active++;
    try {
      try {append(step,'PENDING');}catch {poisoned=true;if(!closing)throw Error('pending_not_durable');}
      states.set(step,'INVOKED');
      const value=await work();
      const detail=facts(summarize(value));append(step,'ACK',detail);states.set(step,'ACK');return value;
    }catch {
      poisoned=true;
      const invoked=states.get(step)==='INVOKED';states.set(step,invoked?'FAILED_OR_UNCERTAIN':'NOT_INVOKED');
      try{append(step,states.get(step));}catch{}
      throw Error('byok_operator_attempt_failed');
    }finally{active--;}
  }
  return Object.freeze({directory,attempt,identity:Object.freeze({...meta}),
    snapshot:()=>({epoch,sequence,bytes:written,poisoned,closed,active,attempts:Object.fromEntries(states)}),
    close(){assert.equal(active,0,'Cannot close a journal with live work');if(!closed){closed=true;io.closeSync(fd);}},
  });
}

/** Read-only integrity inspection. It NEVER authorizes retry or removes the
 * reservation. A partial/truncated tail is evidence of an interrupted write. */
export function inspectByokD1OperatorJournal(path) {
  const stat=fs.statSync(path);assert.ok(stat.isFile()&&stat.size>0&&stat.size<=262144);
  const text=fs.readFileSync(path,'utf8');assert.ok(text.endsWith('\n'),'Incomplete journal tail');
  const rows=text.slice(0,-1).split('\n').map(line=>JSON.parse(line));assert.ok(rows.length<=128);
  let previous='0'.repeat(64),epoch;const states={};
  for(const [i,row] of rows.entries()) {
    assert.deepEqual(Object.keys(row).sort(),['epoch','facts','outcome','previous','sequence','sha256','step']);
    const {sha256,...body}=row;assert.equal(sha256,hash(JSON.stringify(body)));assert.equal(row.previous,previous);assert.equal(row.sequence,i+1);
    assert.match(row.epoch,/^[a-f0-9-]{36}$/);epoch??=row.epoch;assert.equal(row.epoch,epoch);
    if(i===0){assert.equal(row.step,'reservation');assert.equal(row.outcome,'RESERVED');
      const {firstRoundUsdCap,capReset,...meta}=row.facts;assert.equal(firstRoundUsdCap,2);assert.equal(capReset,false);input(meta);
    }else {
      assert.ok(steps.has(row.step));facts(row.facts);
      assert.ok(['PENDING','ACK','FAILED_OR_UNCERTAIN','NOT_INVOKED'].includes(row.outcome));
      if(row.outcome==='PENDING')assert.equal(states[row.step],undefined);
      else assert.equal(states[row.step],'PENDING');
      states[row.step]=row.outcome;
    }
    previous=sha256;
  }
  return {records:rows.length,epoch,sha256:previous,attempts:states,mayReplay:false};
}
