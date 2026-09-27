import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {createSseHostExpirySession} from './staging-sse-host-expiry-session.mjs';
import {createSseCapacityPeerTransport} from './staging-sse-capacity-peer-transport.mjs';
import {createSseCapacityPeerPreflight} from './staging-sse-capacity-peer-preflight.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),digest=v=>sha(JSON.stringify(v));
const dbPath='/d1/database/'+g.database,tailPath='/workers/scripts/'+g.worker+'/tails';

// Fixed API responses are synthetic contracts, not cloud revalidation.
function setup(t,{fault}={}) {
  t.mock.method(globalThis,'fetch',()=>{throw Error('External network forbidden');});
  let ms=0,override,logFault=false;
  const clock=createSseOperatorClock({readNs:()=>BigInt(ms)*1000000n,wallNow:()=>new Date('2026-09-09T01:00:00Z').toISOString()});
  const runId='c02-success-'+randomUUID(),version=randomUUID(),baseline={previousPublicHttp:382,firstRoundUsdCap:2};
  const session=createSseHostExpirySession({clock,baseline,input:{scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},
    version,runId,keyHash:'sha256:'+'a'.repeat(64),expiresAt:'2026-09-09T02:00:00.000Z',tokenName:'cinatoken-sse-v215-'+randomUUID(),
    plans:['before-hold','after-hold'].map(mode=>({mode,snapshot:{runId,mode,probeId:randomUUID()},upstream:{runId,mode:'success',probeId:randomUUID()}})),
    budget:{...baseline,capReset:false,maxPublicHttp:32,maxRpc:2}}});
  const calls=[],logs=[],token={id:randomUUID(),name:session.plan.tokenName,client_id:'local-id',client_secret:'local-secret'},tail={id:randomUUID().replaceAll('-',''),url:'wss://local.invalid/private-secret',expires_at:'2026-09-09T02:00:00Z'};
  const settings={local:'synthetic'},schema=Array.from({length:295},(_,i)=>({type:'table',name:'local_'+i,tbl_name:'local_'+i,sql:'local schema'}));
  const counts=Object.fromEntries(Array.from({length:56},(_,i)=>['t_'+i,0]));
  const apps=[g,c].map(t=>({id:t.app,domain:t.domain,aud:t.audience,type:'self_hosted',destinations:[{type:'public',uri:t.domain}],service_auth_401_redirect:false,
    policies:[{id:t.policy,name:t===g?'CinaToken staging closed':'CinaToken recovery staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]}));
  const expected={workers:[g.worker,c.worker,'cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery'].map(name=>({name,settingsSha256:digest(settings),versions:[{version_id:version,percentage:100}]})),
    production:['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'].map(name=>({name,settingsSha256:digest(settings)})),
    access:apps.map(a=>({id:a.id,sha256:digest(a)})),schema:{sha256:digest(schema)},counts,previousTokenIds:[]};
  const entry=Buffer.from('synthetic-closed-candidate'),entrySha256=sha(entry);
  let tokenPage;
  const json=(result,info)=>Response.json({success:true,result,...(tokenPage?{result_info:info??{count:result.length,page:tokenPage,per_page:1000,total_count:result.length,total_pages:1}}:{})},{headers:{Date:'Wed, 09 Sep 2026 01:00:00 GMT'}});
  const fetchImpl=async(url,init)=>{
    assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/'+g.account+'/'));assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,'Bearer local-api-token');if(!logFault)assert.equal(logs.at(-1).result,'PENDING');
    const rawPath=url.split(g.account)[1],path=rawPath.split('?')[0],body=init.body?JSON.parse(init.body):undefined;calls.push({path:rawPath,method:init.method,body,signal:init.signal});
    tokenPage=path==='/access/service_tokens'&&init.method==='GET'?Number(new URL(url).searchParams.get('page')):undefined;
    if(override){const result=await override({path,rawPath,init,body,json});if(result)return result;}
    if(path===dbPath)return json({uuid:fault==='database'?randomUUID():g.database,name:'cinatoken-staging'});
    if(path===dbPath+'/query')return json(body.batch.map(q=>({success:true,results:q.sql.includes('main.sqlite_master')?schema:q.sql.includes('COUNT(*)')?[counts]:fault==='controls'?[{key:'c02_recovery_claim_delay_v1'}]:[],meta:{rows_read:1,rows_written:q.sql.startsWith('SELECT ')?0:1}})));
    if(path.endsWith('/settings'))return json(settings);
    if(path.endsWith('/deployments'))return json({deployments:[{versions:[{version_id:fault==='version'?randomUUID():version,percentage:100}]}]});
    if(path.endsWith('/subdomain'))return json({enabled:fault==='open-ingress',previews_enabled:false});
    if(path.startsWith('/workers/domains'))return json([]);
    if(path.endsWith('/schedules'))return json({schedules:[]});
    if(path.startsWith('/access/apps/'))return json(apps.find(a=>path==='/access/apps/'+a.id));
    if(path==='/access/service_tokens')return json(init.method==='POST'?token:[]);
    if(path===tailPath)return json(init.method==='POST'?tail:fault==='old-tail'?[tail]:[]);
    if(path===tailPath+'/'+tail.id||path==='/access/service_tokens/'+token.id)return json({});
    if(path.endsWith('/content/v2'))return new Response(fault==='content'?'wrong':entry,{headers:{'Content-Type':'application/javascript'}});
    if(path==='/billable-usage')return json((fault==='missing-billing'?['Workers']:['Workers','D1']).map(ServiceFamilyName=>({ServiceFamilyName,BillingCurrency:'USD',ContractedCost:fault==='cost'?0.1:0})));
    assert.fail('Unknown local target '+path);
  };
  const persist=async e=>{if(logFault)throw Error('local-secret');logs.push(structuredClone(e));};
  const transport=createSseCapacityPeerTransport({session,apiToken:'local-api-token',fetchImpl,persist});
  const preflight=createSseCapacityPeerPreflight({transport,session,expected,entrySha256,persist});
  return {session,transport,preflight,expected,calls,logs,token,tail,entrySha256,entry,persist,json,
    override(fn){override=fn;},logFault(){logFault=true;},at(n){ms=n;}};
}

test('fixed real transport and fresh preflight compose without writes; one original run promise',async t=>{
  const x=setup(t),first=x.preflight.run();assert.equal(x.preflight.run(),first);const result=await first;
  assert.equal(result.result,'PASS');x.session.assertWriteReady();assert.equal(result.contentSha256,x.entrySha256);
  assert.equal(x.transport.report().cloudMutationAttempted,false);assert.equal(x.transport.report().rowsWritten,0);
  assert.ok(x.calls.every(c=>c.method==='GET'||c.path===dbPath+'/query'));assert.equal(x.calls.filter(c=>c.path.endsWith('/deployments')).length,8);
  assert.doesNotMatch(JSON.stringify({result,logs:x.logs,report:x.transport.report()}),/local-secret|local-api-token|private-secret/);
});

for(const fault of ['database','version','open-ingress','controls','old-tail','content','missing-billing','cost'])test('failed fresh preflight never grants write authority: '+fault,async t=>{
  const x=setup(t,{fault});await assert.rejects(x.preflight.run(),/peer_preflight_failed/);assert.throws(()=>x.session.assertWriteReady());
  assert.equal(x.transport.report().cloudMutationAttempted,false);assert.equal(x.preflight.report().result,'FAIL');
  const count=x.calls.length;await assert.rejects(x.preflight.run());assert.equal(x.calls.length,count);
});

test('all foreign/normalized production mutations and raw SQL API bypasses are refused before fetch',async t=>{
  const x=setup(t);x.session.preflightComplete();
  for(const [path,method,body] of [
    ['/workers/scripts/cinatoken-proxy/subdomain','POST',{enabled:false,previews_enabled:false}],
    ['/workers/scripts/'+g.worker+'/../cinatoken-proxy/settings','GET'],
    ['/d1/database/'+randomUUID()+'/query','POST',{batch:[]}],
    [dbPath+'/query','POST',{batch:[{sql:'DELETE FROM users',params:[]}]}],
    ['/access/service_tokens/'+randomUUID(),'DELETE'],[tailPath+'/'+randomUUID(),'DELETE'],
    ['https://foreign.invalid/','GET'],['//foreign.invalid/','GET'],
  ])await assert.rejects(x.transport.api(path,method,body));
  assert.equal(x.calls.length,0);
});

test('D1 identity, one-statement reads, row metrics and body size fail closed',async t=>{
  const x=setup(t);await assert.rejects(x.transport.batch([{sql:'SELECT 1',params:[]} ]));await x.transport.api(dbPath);
  const before=x.calls.length;
  for(const sql of ['SELECT 1;DELETE FROM users','SELECT 1 -- hidden','SELECT 1 /* hidden */','DELETE FROM users'])await assert.rejects(x.transport.batch([{sql,params:[]} ]));
  await assert.rejects(x.transport.batch([{sql:'SELECT ?',params:['x'.repeat(1048576)]}]));assert.equal(x.calls.length,before);
  await x.transport.batch([{sql:'SELECT 1',params:[]}]);assert.equal(x.transport.report().rowsRead,1);assert.equal(x.transport.report().rowsWritten,0);
});

test('confirmed token/tail ownership is retained before a failing ACK journal, with no secret log',async t=>{
  const x=setup(t);x.session.preflightComplete();
  x.override(({path})=>{if(path==='/access/service_tokens')x.logFault();});
  await assert.rejects(x.transport.api('/access/service_tokens','POST',{name:x.session.plan.tokenName,duration:'1h'}));
  assert.equal(x.transport.ownership().tokenId,x.token.id);x.transport.beginCleanup();
  await x.transport.api('/access/service_tokens/'+x.token.id,'PUT',{name:x.session.plan.tokenName,enabled:false});
  await x.transport.api('/access/service_tokens/'+x.token.id,'DELETE');
  assert.doesNotMatch(JSON.stringify(x.transport.report()),/local-secret/);
});

test('lost creation ACK consumes write; exact unique name read can recover token ownership, never tail guess',async t=>{
  const x=setup(t);x.session.preflightComplete();
  x.override(({path,init,json})=>{
    if(init.method==='POST'&&(path===tailPath||path==='/access/service_tokens'))throw Error('local-secret');
    if(init.method==='GET'&&path==='/access/service_tokens')return json([x.token]);
  });
  for(const [path,body] of [[tailPath,{filters:[{header:{key:'x-c02-sse-host-expiry'}}]}],['/access/service_tokens',{name:x.session.plan.tokenName,duration:'1h'}]]){
    await assert.rejects(x.transport.api(path,'POST',body));await assert.rejects(x.transport.api(path,'POST',body));
  }
  assert.equal(x.calls.length,2);await x.transport.api('/access/service_tokens');assert.equal(x.transport.ownership().tokenId,x.token.id);
  assert.deepEqual(x.transport.ownership().tail,{creation:'attempted'});x.transport.beginCleanup();await assert.rejects(x.transport.api(tailPath+'/'+x.tail.id,'DELETE'));
});

test('request snapshot survives pending journal mutation and hidden options cannot bypass preflight',async t=>{
  const x=setup(t),body={name:x.session.plan.tokenName,duration:'1h'};
  await assert.rejects(x.transport.api('/access/service_tokens','POST',body,{sql:true}));assert.equal(x.calls.length,0);
  x.session.preflightComplete();const work=x.transport.api('/access/service_tokens','POST',body);body.name='foreign';await work;
  assert.equal(x.calls[0].body.name,x.session.plan.tokenName);
});

test('non-cooperative headers timeout rejects once and cancels late response body',async t=>{
  const x=setup(t);t.mock.timers.enable({apis:['setTimeout']});let resolve,cancelled=0;
  x.override(()=>new Promise(r=>resolve=r));const work=x.transport.api(dbPath);await tick();
  t.mock.timers.tick(20001);await assert.rejects(work,/peer_management_failed/);
  resolve(new Response(new ReadableStream({cancel(){cancelled++;}})));await tick();assert.equal(cancelled,1);assert.equal(x.calls.length,1);
});

test('non-cooperative body is cancelled at original deadline, without hanging cleanup',async t=>{
  const x=setup(t);t.mock.timers.enable({apis:['setTimeout']});let cancelled=0;
  x.override(()=>new Response(new ReadableStream({cancel(){cancelled++;}})));
  const work=x.transport.api(dbPath);await tick();t.mock.timers.tick(20001);await assert.rejects(work);assert.equal(cancelled,1);
});

test('cleanup retains its reserved management capacity and cannot reopen ingress',async t=>{
  const x=setup(t);for(let i=0;i<240;i++)await x.transport.api(dbPath);await assert.rejects(x.transport.api(dbPath));
  x.transport.beginCleanup();await x.transport.api(`/workers/scripts/${g.worker}/subdomain`,'POST',{enabled:false,previews_enabled:false});
  await assert.rejects(x.transport.api(`/workers/scripts/${g.worker}/subdomain`,'POST',{enabled:true,previews_enabled:false}));
  for(let i=241;i<360;i++)await x.transport.api(dbPath);await assert.rejects(x.transport.api(dbPath));assert.equal(x.calls.length,360);
});

test('canonical key revoke may repeat only after known ACK; failed journals forbid other SQL writes',async t=>{
  const x=setup(t);await x.transport.api(dbPath);x.transport.beginCleanup();
  const revoke={sql:"UPDATE api_keys SET status='revoked' WHERE id=? AND user_id=? AND workspace_id=? AND key_hash=?",
    params:[x.session.plan.runId+'-key',x.session.plan.runId+'-user',x.session.plan.runId+'-workspace',x.session.plan.keyHash]};
  await x.transport.batch([revoke],{write:true});await x.transport.batch([revoke],{write:true});
  x.logFault();await x.transport.api(dbPath);await x.transport.batch([revoke],{write:true});
  await assert.rejects(x.transport.batch([{sql:'DELETE FROM users',params:[]}],{write:true}));
  x.override(({path})=>{if(path===dbPath+'/query')throw Error('lost revoke ACK');});
  await assert.rejects(x.transport.batch([revoke],{write:true}));const before=x.calls.length;
  await assert.rejects(x.transport.batch([revoke],{write:true}));assert.equal(x.calls.length,before);
});

test('multipart executable content must contain exactly one matching candidate',async t=>{
  const x=setup(t);const form=new FormData();form.append('main.js',new Blob([x.entry]),'main.js');
  x.override(({path})=>path.endsWith('/content/v2')?new Response(form):undefined);
  assert.equal((await x.preflight.run()).result,'PASS');
});

test('duplicate matching executable parts fail preflight without granting write readiness',async t=>{
  const x=setup(t),form=new FormData();for(const name of ['main.js','other.js'])form.append(name,new Blob([x.entry]),name);
  x.override(({path})=>path.endsWith('/content/v2')?new Response(form):undefined);
  await assert.rejects(x.preflight.run());assert.throws(()=>x.session.assertWriteReady());
});

test('missing D1 billing metrics are uncertain and do not authorize a repeat write',async t=>{
  const x=setup(t);await x.transport.api(dbPath);x.session.preflightComplete();
  x.override(({path,json})=>path===dbPath+'/query'?json([{success:true,results:[],meta:{}}]):undefined);
  const rows=[{sql:'INSERT INTO local_test(value) VALUES (?)',params:[1]}];
  await assert.rejects(x.transport.batch(rows,{write:true}));const before=x.calls.length;
  await assert.rejects(x.transport.batch(rows,{write:true}));assert.equal(x.calls.length,before);
});

test('oversized management ACK cannot be replayed and never exposes response body',async t=>{
  const x=setup(t);x.session.preflightComplete();x.override(()=>new Response('secret-'+ 'x'.repeat(2097152)));
  const body={name:x.session.plan.tokenName,duration:'1h'};
  await assert.rejects(x.transport.api('/access/service_tokens','POST',body));await assert.rejects(x.transport.api('/access/service_tokens','POST',body));
  assert.equal(x.calls.length,1);assert.equal(x.transport.ownership().tokenId,undefined);assert.doesNotMatch(JSON.stringify(x.transport.report()),/secret-/);
});

test('failed preflight journal never makes a session write-ready',async t=>{
  const x=setup(t);x.override(({path})=>{if(path==='/billable-usage')x.logFault();});
  await assert.rejects(x.preflight.run());assert.throws(()=>x.session.assertWriteReady());assert.equal(x.transport.report().cloudMutationAttempted,false);
});

test('explicit abort bounds a pending management read and records its original attempt',async t=>{
  const x=setup(t),ac=new AbortController();let entered;const ready=new Promise(r=>entered=r);
  x.override(()=>{entered();return new Promise(()=>{});});const work=x.transport.api(dbPath,'GET',undefined,{signal:ac.signal});
  await ready;ac.abort();await assert.rejects(work);assert.equal(x.calls.length,1);assert.equal(x.calls[0].signal.aborted,true);
  assert.equal(x.transport.report().operations[0].result,'FAILED_OR_UNCERTAIN');
});

test('complete token pagination finds an owned token beyond the first thousand',async t=>{
  const x=setup(t);x.session.preflightComplete();
  await x.transport.api('/access/service_tokens','POST',{name:x.session.plan.tokenName,duration:'1h'});
  const first=Array.from({length:1000},()=>({id:randomUUID(),name:'foreign'}));
  x.override(({path,rawPath,json})=>{if(path!=='/access/service_tokens')return;
    const page=Number(new URL('https://local.invalid'+rawPath).searchParams.get('page')),values=page===1?first:[x.token];
    return json(values,{count:values.length,page,per_page:1000,total_count:1001,total_pages:2});});
  const result=await x.transport.api('/access/service_tokens');assert.equal(result.length,1001);assert.equal(x.transport.ownership().tokenId,x.token.id);
  assert.equal(x.calls.filter(c=>c.path.includes('per_page=1000')).length,2);
});

for(const fault of ['missing-page-metadata','changing-count','duplicate-id'])test('incomplete/inconsistent token list never proves absence: '+fault,async t=>{
  const x=setup(t),first=Array.from({length:1000},()=>({id:randomUUID(),name:'foreign'}));
  x.override(({path,rawPath,json})=>{if(path!=='/access/service_tokens')return;
    const page=Number(new URL('https://local.invalid'+rawPath).searchParams.get('page'));
    if(fault==='missing-page-metadata')return Response.json({success:true,result:[]});
    const values=page===1?first:[fault==='duplicate-id'?first[0]:x.token];
    return json(values,{count:values.length,page,per_page:1000,total_count:page===2&&fault==='changing-count'?1002:1001,total_pages:2});});
  await assert.rejects(x.transport.api('/access/service_tokens'));assert.equal(x.transport.ownership().tokenId,undefined);
});
