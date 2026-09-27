import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { imageSseFixture } from './staging-image-sse-fixture.mjs';
import { SSE_STAGING_SCOPE as scope, closeSseStagingAccess, assertSseDeadlineObservation,
  terminalSseReservationCleanup, terminalSseProbeCleanup, cleanupSseStagingData, sseCleanupNotBefore, SseCleanupPendingError,
  reconcileSseStagingRun,
} from './staging-sse-reconciliation.mjs';

const allModes = ['success','provider-error','partial-provider-error','invalid-json','early-eof','usage-limit','property-limit','cancel','deadline'];
const startedAt = '2026-09-08T04:00:00.000Z', expiresAt = '2026-09-08T06:00:00.000Z';
const nowMs = Date.parse('2026-09-08T05:00:00.000Z');
const isCapacity = mode => ['usage-limit','property-limit'].includes(mode);
const makeJournal = () => ({ runId:'c02-success-'+randomUUID(),keyHash:'sha256:'+randomUUID().replaceAll('-','').repeat(2),expiresAt,
  tokenId:randomUUID(),tokenName:'cinatoken-sse-v187-'+randomUUID(),
  requests:allModes.map(mode=>({id:'gen-'+randomUUID(),mode,startedAt})),
  probes:allModes.map(mode=>({probeId:randomUUID(),mode:['cancel','deadline'].includes(mode)?'hold':mode})),
});

function cloud(journal, { closed = false, failWrite = 0, failure = 'before' } = {}) {
  const tokenId=journal.tokenId;
  const policy = { id:scope.policy,name:'CinaToken staging closed',precedence:1,decision:'non_identity',
    include:[{service_token:{token_id:journal.tokenId}}],exclude:[],require:[] };
  const state = { ingress:{enabled:!closed,previews_enabled:false},app:{id:scope.app,type:'self_hosted',domain:scope.domain,
    aud:scope.audience,destinations:[{type:'public',uri:scope.domain}],policies:[policy],service_auth_401_redirect:!closed,
    session_duration:'15m',unrelated_setting:'must survive'},
    tokens:[{id:journal.tokenId,name:journal.tokenName,enabled:true,client_secret:'MUST_NOT_PERSIST'},
      {id:randomUUID(),name:'unrelated-token',enabled:true}],writes:[],calls:[] };
  if(closed){state.app.policies[0]={...policy,decision:'deny',include:[{everyone:{}}]};state.tokens.shift();}
  let count=0, failed=false;
  const api=async(path,method='GET',body)=>{
    state.calls.push({path,method});
    if(method!=='GET'){
      count++;if(!failed&&count===failWrite&&failure==='before'){failed=true;throw Error('Before write');}
      state.writes.push({path,method,body:structuredClone(body)});
    }
    let result;
    if(path===`/workers/scripts/${scope.worker}/subdomain`){
      if(method==='POST'){assert.deepEqual(body,{enabled:false,previews_enabled:false});state.ingress=structuredClone(body);}
      else assert.equal(method,'GET');result=state.ingress;
    }else if(path===`/access/apps/${scope.app}`){
      if(method==='PUT'){assert.equal(body.service_auth_401_redirect,false);state.app=structuredClone(body);}
      else assert.equal(method,'GET');result=state.app;
    }else if(path===`/access/apps/${scope.app}/policies/${scope.policy}`){
      assert.equal(method,'PUT');assert.notEqual(state.app.service_auth_401_redirect,true,'12130: wrong restoration order');
      state.app.policies=[{id:scope.policy,...body}];result=state.app.policies[0];
    }else if(path==='/access/service_tokens'){assert.equal(method,'GET');result=state.tokens;}
    else if(path===`/access/service_tokens/${tokenId}`){
      const token=state.tokens.find(t=>t.id===tokenId);assert.ok(token);
      if(method==='PUT'){assert.deepEqual(body,{name:journal.tokenName,enabled:false});token.enabled=false;result=token;}
      else {assert.equal(method,'DELETE');assert.equal(state.app.policies[0].decision,'deny','12139: still referenced');state.tokens=state.tokens.filter(t=>t.id!==token.id);result={id:token.id};}
    }else if(path===`/d1/database/${scope.database}`){assert.equal(method,'GET');result={uuid:scope.database,name:'cinatoken-staging'};}
    else assert.fail('Unexpected target: '+path);
    if(method!=='GET'&&!failed&&count===failWrite&&failure==='after'){failed=true;throw Error('Committed; acknowledgement lost');}
    return structuredClone(result);
  };
  return {state,api};
}

test('Access closes ingress, disables identity, restores redirect before deny, then deletes token; repeat is read-only',async()=>{
  const journal=makeJournal(),f=cloud(journal),saved=[],other=structuredClone(f.state.tokens[1]);
  await closeSseStagingAccess({api:f.api,journal,persist:async s=>saved.push(s)});
  assert.deepEqual(f.state.writes.map(w=>w.method),['POST','PUT','PUT','PUT','DELETE']);
  assert.equal(f.state.app.unrelated_setting,'must survive');assert.deepEqual(f.state.tokens,[other]);
  assert.doesNotMatch(JSON.stringify(saved),/MUST_NOT_PERSIST|client_secret/);
  const n=f.state.writes.length;await closeSseStagingAccess({api:f.api,journal});assert.equal(f.state.writes.length,n);
});
for(const failure of ['before','after'])for(let failWrite=1;failWrite<=5;failWrite++)test(`Access resumes ${failure} write ${failWrite}, including lost acknowledgement`,async()=>{
  const journal=makeJournal(),f=cloud(journal,{failWrite,failure});
  await assert.rejects(closeSseStagingAccess({api:f.api,journal}));
  await closeSseStagingAccess({api:f.api,journal});
  assert.equal(f.state.ingress.enabled,false);assert.equal(f.state.app.policies[0].decision,'deny');
  assert.ok(f.state.tokens.every(t=>t.id!==journal.tokenId));
});
for(let index=1;index<=5;index++)test(`Access resumes after durable checkpoint ${index} fails`,async()=>{
  const journal=makeJournal(),f=cloud(journal);let seen=0;
  await assert.rejects(closeSseStagingAccess({api:f.api,journal,persist:async()=>{if(++seen===index)throw Error('journal unavailable');}}));
  await closeSseStagingAccess({api:f.api,journal});assert.equal(f.state.app.policies[0].decision,'deny');
});
for(const [name,change] of [
  ['domain',f=>f.state.app.domain='production.example.com'],['audience',f=>f.state.app.aud='other'],
  ['policy',f=>f.state.app.policies[0].id=randomUUID()],['foreign service identity',f=>f.state.app.policies[0].include=[{service_token:{token_id:randomUUID()}}]],
  ['extra policy',f=>f.state.app.policies.push({...f.state.app.policies[0],id:randomUUID()})],
  ['duplicate token names',f=>f.state.tokens.push({...f.state.tokens[0],id:randomUUID()})],
  ['renamed token',f=>f.state.tokens[0].name='other-owner'],
])test('Access refuses '+name+' drift after closing ingress',async()=>{
  const journal=makeJournal(),f=cloud(journal);change(f);await assert.rejects(closeSseStagingAccess({api:f.api,journal}));
  assert.equal(f.state.ingress.enabled,false);assert.equal(f.state.writes.length,1);
});
test('Lost token-create acknowledgement reconciles exact name; incomplete inference metadata cannot prevent Access closure',async()=>{
  const journal=makeJournal(),f=cloud(journal);delete journal.tokenId;journal.requests=[{id:null,mode:'deadline'}];
  await closeSseStagingAccess({api:f.api,journal});assert.equal(f.state.tokens.length,1);
});
test('No token was created and Access is already deny-all: no writes',async()=>{
  const journal=makeJournal(),f=cloud(journal,{closed:true});delete journal.tokenId;delete journal.tokenName;
  await closeSseStagingAccess({api:f.api,journal});assert.equal(f.state.writes.length,0);
});

const historical=JSON.parse(readFileSync(new URL('../../docs/developers/architecture/implementation-evidence/C02-images-sse-staging-runtime-results.json',import.meta.url),'utf8'));
function deadlineObservation(){
  const d=historical.deadlineIndependentObservation;
  return {journal:{runId:d.runId,requests:historical.run.cases.map(c=>({id:c.id,mode:c.mode,probeId:c.probeId}))},id:d.requestId,wire:d.wire,elapsedMs:d.elapsedMs,probe:JSON.parse(d.observed[0][0].value),logs:d.observed[1],account:d.observed[2][0],recoveryCounts:d.observed.slice(3).map(r=>r[0].n)};
}
test('Frozen real 301099 ms deadline evidence matches server_error, not an invented timeout code',()=>assertSseDeadlineObservation(deadlineObservation()));
for(const [name,change] of [
  ['wrong code',v=>v.wire=v.wire.replace('server_error','gateway_timeout')],
  ['early timer',v=>v.elapsedMs=1000],['fallback expiry',v=>v.probe.events.at(-1).reason='expired'],
  ['duplicate DONE',v=>v.wire+='data: [DONE]\n\n'],['untrusted ID',v=>v.id='gen-'+randomUUID()],
  ['duplicate log',v=>v.logs.push({...v.logs.find(l=>l.id===v.id)})],['budget held',v=>v.account.budget_reserved_micros=1],
  ['foreign probe',v=>v.probe.runId='c02-success-'+randomUUID()],['wrong probe ID',v=>v.probe.probeId=randomUUID()],
  ['wrong cumulative spend',v=>v.account.budget_spent_micros++],['hidden malformed frame',v=>v.wire='malformed\n\n'+v.wire],
])test('Deadline oracle rejects '+name,()=>{const v=deadlineObservation();change(v);assert.throws(()=>assertSseDeadlineObservation(v));});

async function database(t){
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec('PRAGMA foreign_keys=ON');
  const directory=new URL('../../packages/core/migrations-d1/',import.meta.url);
  for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,directory),'utf8'));
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])sqlite.exec(readFileSync(new URL(`../../packages/core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const journal=makeJournal(),otherJournal=makeJournal(),f=cloud(journal,{closed:true}),events=[];
  const fixture=await imageSseFixture(journal.runId,journal.keyHash,journal.expiresAt),other=await imageSseFixture(otherJournal.runId,otherJournal.keyHash,otherJournal.expiresAt);
  for(const fix of [fixture,other])for(const s of fix.seed)sqlite.prepare(s.sql).run(...s.params);
  for(const j of [journal,otherJournal]){
    for(const r of j.requests){
      sqlite.prepare('INSERT INTO user_budget_reservations(request_id,user_id,api_key_id,budget_epoch,limit_micros,reserved_micros,expires_at,created_at,updated_at) VALUES(?,?,?,0,1000000,100000,?,?,?)').run(r.id,j.runId+'-user',j.runId+'-key',expiresAt,startedAt,startedAt);
      sqlite.prepare('UPDATE user_budget_reservations SET state=?,settled_micros=?,terminal_at=?,terminal_reason=? WHERE request_id=?').run(isCapacity(r.mode)?'expired':'settled',r.mode==='success'||isCapacity(r.mode)?100000:0,startedAt,isCapacity(r.mode)?'usage_unavailable_after_dispatch':'request_usage_settled',r.id);
    }
    for(const p of j.probes)sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run('c02_images_sse_probe:'+p.probeId,JSON.stringify({runId:j.runId,...p,phase:'terminal'}),'c02-sse:'+j.runId);
  }
  let before=()=>{},after=()=>{};
  const batch=async statements=>{
    assert.ok(statements.length<=64);before(statements);sqlite.exec('BEGIN');let result;
    try{result=statements.map(s=>sqlite.prepare(s.sql).all(...s.params).map(r=>({...r})));sqlite.exec('COMMIT');}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
    after(statements);return result;
  };
  const rows=()=>sqlite.prepare('SELECT * FROM user_budget_reservations WHERE user_id=? ORDER BY request_id').all(fixture.ids.user).map(r=>({...r}));
  const run=(overrides={})=>cleanupSseStagingData({api:f.api,batch,journal,nowMs,persist:async e=>events.push(e),...overrides});
  return {sqlite,journal,otherJournal,fixture,other,cloud:f,events,batch,rows,run,setBefore:fn=>before=fn,setAfter:fn=>after=fn};
}

test('Real migrated SQLite: nine terminal rows, probes and fixture removed; repeat preserves unrelated fixture byte-for-byte',async t=>{
  const f=await database(t);const other=f.sqlite.prepare('SELECT * FROM user_budget_reservations WHERE user_id=?').all(f.other.ids.user);
  assert.equal(f.rows().filter(r=>r.state==='expired').length,2);
  assert.deepEqual(await f.run(),{removedReservations:9,fixtureRemoved:true});
  assert.deepEqual(await f.run(),{removedReservations:0,fixtureRemoved:true});
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM user_budget_reservations WHERE user_id=?').all(f.other.ids.user),other);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM providers').get().n,5);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM models').get().n,5);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM system_config WHERE description LIKE 'c02-sse:%'").get().n,9);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});
for(const phase of ['reservation','fixture'])test(`SQL ${phase} commit / lost ACK resumes without replay or broad deletion`,async t=>{
  const f=await database(t);let failed=false;
  f.setAfter(statements=>{if(!failed&&statements.some(s=>s.sql.startsWith(phase==='reservation'?'DELETE FROM user_budget_reservations':'DELETE FROM users'))){failed=true;throw Error('committed; ACK lost');}});
  await assert.rejects(f.run());await f.run();assert.equal(f.rows().length,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,1);
});
test('Persisting observation fails: no reservations, probes or owners removed',async t=>{
  const f=await database(t);await assert.rejects(f.run({persist:async()=>{throw Error('disk full');}}));
  assert.equal(f.rows().length,9);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,2);
});
test('Post-observation CAS race aborts whole reservation batch and retains every row',async t=>{
  const f=await database(t),id=f.rows().at(-1).request_id;
  await assert.rejects(f.run({persist:async()=>f.sqlite.prepare('UPDATE user_budget_reservations SET updated_at=? WHERE request_id=?').run('2026-09-08T04:00:01.000Z',id)}));
  assert.equal(f.rows().length,9);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,2);
});
test('Quiescence gate uses latest headers; revokes key but leaves all data, without sleeping',async t=>{
  const f=await database(t);f.journal.requests.at(-1).headersAt='2026-09-08T04:04:00.000Z';
  const deadline=sseCleanupNotBefore(f.journal);assert.equal(deadline,Date.parse('2026-09-08T04:09:50.000Z'));
  await assert.rejects(f.run({nowMs:deadline-1}),e=>e instanceof SseCleanupPendingError&&e.resumeAtMs===deadline);
  assert.equal(f.rows().length,9);assert.equal(f.sqlite.prepare('SELECT status FROM api_keys WHERE id=?').get(f.fixture.ids.key).status,'revoked');
});
test('Unknown request identity blocks data cleanup but still revokes the exact fixture key',async t=>{
  const f=await database(t);f.journal.requests.at(-1).id=null;await assert.rejects(f.run());
  assert.equal(f.rows().length,9);assert.equal(f.sqlite.prepare('SELECT status FROM api_keys WHERE id=?').get(f.fixture.ids.key).status,'revoked');
});
for(const [name,change] of [
  ['active state',r=>r.state='dispatched'],['wrong amount',r=>r.settled_micros++],['foreign owner',r=>r.user_id='other'],
  ['foreign key',r=>r.api_key_id='other'],['TTL guess',r=>{r.state='expired';r.terminal_reason='ttl_expired';}],
  ['unlisted request',r=>r.request_id='gen-'+randomUUID()],['missing terminal time',r=>r.terminal_at=null],
])test('Reservation planner refuses '+name,async t=>{
  const f=await database(t),rows=f.rows();change(rows[0]);assert.throws(()=>terminalSseReservationCleanup(f.journal,rows));
  assert.equal(f.rows().length,9);
});
for(const [name,mutate] of [
  ['nonterminal',v=>v.phase='started'],['foreign owner',v=>v.runId='other'],['wrong mode',v=>v.mode='other'],
])test('Probe cleanup refuses '+name,async t=>{
  const f=await database(t),p=f.journal.probes[0],key='c02_images_sse_probe:'+p.probeId;
  const row=f.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').get(key),value=JSON.parse(row.value);mutate(value);row.value=JSON.stringify(value);
  assert.throws(()=>terminalSseProbeCleanup(f.journal,[row]));
});
test('Probe changed after observation: fixture transaction rolls back and retains owners/probes',async t=>{
  const f=await database(t);f.setBefore(statements=>{if(statements.some(s=>s.sql.startsWith('DELETE FROM users')))
    f.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}','c02_images_sse_probe:'+f.journal.probes.at(-1).probeId);});
  await assert.rejects(f.run());assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM system_config WHERE description=?').get('c02-sse:'+f.journal.runId).n,9);
});
test('Durable dispatch intent prevents fixture deletion, never removed by the SSE legacy cleanup',async t=>{
  const f=await database(t),stamp=Date.parse(startedAt);
  f.sqlite.prepare("INSERT INTO request_dispatch_intents(request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,state,revision,expires_at_ms,created_at_ms,updated_at_ms) VALUES(?,1,?,?,?,'images.generations',?,'prepared',0,?,?,?)")
    .run('gen-'+randomUUID(),f.fixture.ids.user,f.fixture.ids.key,f.fixture.ids.workspace,'a'.repeat(64),stamp+10000,stamp,stamp);
  await assert.rejects(f.run());assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM request_dispatch_intents').get().n,1);
});
test('A late reservation inserted between phases blocks destructive owner cleanup',async t=>{
  const f=await database(t);f.setBefore(statements=>{if(statements.some(s=>s.sql.startsWith('DELETE FROM users'))){
    f.sqlite.prepare("UPDATE api_keys SET status='active' WHERE id=?").run(f.fixture.ids.key);
    f.sqlite.prepare('INSERT INTO user_budget_reservations(request_id,user_id,api_key_id,budget_epoch,limit_micros,reserved_micros,expires_at,created_at,updated_at) VALUES(?,?,?,0,1000000,100000,?,?,?)')
      .run('gen-'+randomUUID(),f.fixture.ids.user,f.fixture.ids.key,expiresAt,startedAt,startedAt);
  }});
  await assert.rejects(f.run());assert.equal(f.rows().length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,2);
});
test('Reconciliation code contains no fetch or timer and never replays inference',()=>{
  const source=readFileSync(new URL('./staging-sse-reconciliation.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\bfetch\(|\bsetTimeout\(|\/v1\/images\/generations/);
});

test('Shared operator entry reconciles Access and real SQL together; repeat performs no external management writes',async t=>{
  const f=await database(t),c=cloud(f.journal),saved=[];
  const options={api:c.api,batch:f.batch,journal:f.journal,nowMs,persist:async e=>saved.push(e)};
  const result=await reconcileSseStagingRun(options);
  assert.equal(result.access.tokenAbsent,true);assert.equal(result.data.removedReservations,9);
  const writes=c.state.writes.length;await reconcileSseStagingRun(options);assert.equal(c.state.writes.length,writes);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,1);
  assert.ok(saved.some(e=>e.step==='terminal-reservations-observed'&&e.rows.length===9));
});
test('Shared entry pending quiescence leaves Access closed, token deleted, key revoked, and data recoverable',async t=>{
  const f=await database(t),c=cloud(f.journal);
  await assert.rejects(reconcileSseStagingRun({api:c.api,batch:f.batch,journal:f.journal,nowMs:Date.parse(startedAt),persist:async()=>{}}),SseCleanupPendingError);
  assert.equal(c.state.ingress.enabled,false);assert.equal(c.state.tokens.length,1);assert.equal(f.rows().length,9);
  assert.equal(f.sqlite.prepare('SELECT status FROM api_keys WHERE id=?').get(f.fixture.ids.key).status,'revoked');
});
test('Wrong database identity stops before any SQL operation',async t=>{
  const f=await database(t);let calls=0;
  await assert.rejects(f.run({api:async path=>path.startsWith('/d1/')?{uuid:'production',name:'cinatoken'}:f.cloud.api(path),batch:async()=>{calls++;return [];}}));
  assert.equal(calls,0);
});
test('Changed owner marker prevents destructive fixture batch',async t=>{
  const f=await database(t);f.sqlite.prepare('UPDATE users SET metadata=? WHERE id=?').run('different-owner',f.fixture.ids.user);
  await assert.rejects(f.run());assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,2);
});
