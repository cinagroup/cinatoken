import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {createSseHostExpirySession} from '../../../../scripts/deploy/staging-sse-host-expiry-session.mjs';
import {createSseCapacityPeerRunWithRejection as createSseCapacityPeerRun} from '../../../../scripts/deploy/staging-sse-capacity-peer-run-with-rejection.mjs';
import {SSE_STAGING_SCOPE as g} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from '../../../../scripts/deploy/staging-sse-recovery-access-v2.mjs';
import {PEER_WATCH_URL,PEER_PROFILE} from '../../../../scripts/deploy/staging-sse-capacity-peer-protocol.mjs';

// Real resource orchestrator/window/core/finalizer and SQLite transactions.
// Preflight, management API, tail socket and public HTTP are LOCAL MODELS.
export function rejectionRunFixture(t,fault){
  t.mock.method(globalThis,'fetch',()=>{throw Error('External network forbidden');});
  const db=createSqliteD1();t.after(()=>db.sqlite.close());
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const counts=()=>Object.fromEntries(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name})=>[name,db.sqlite.prepare('SELECT COUNT(*) n FROM '+name).get().n]));
  const baseline=counts(),key='synthetic-'+randomUUID(),runId='c02-success-'+randomUUID();let ms=0,mutated=false,cleaning=false,creation=false,ownTail,tokenId,seedBatches=0,deleteBatches=0,logFailed=false;
  const waits=[],calls=[],http=[],events=[],tails=[],tokens=[];
  const clock=createSseOperatorClock({readNs:()=>BigInt(ms)*1000000n,wallNow:()=>new Date().toISOString(),sleep:async n=>{waits.push(n);ms+=n;}});
  const budget={previousPublicHttp:382,firstRoundUsdCap:2};
  const session=createSseHostExpirySession({clock,baseline:budget,input:{scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},
    version:randomUUID(),runId,keyHash:'sha256:'+createHash('sha256').update(key).digest('hex'),expiresAt:new Date(Date.now()+3600000).toISOString(),tokenName:'cinatoken-sse-v217-'+randomUUID(),
    plans:['before-hold','after-hold'].map(mode=>({mode,snapshot:{runId,mode,probeId:randomUUID()},upstream:{runId,mode:'success',probeId:randomUUID()}})),
    budget:{...budget,capReset:false,maxPublicHttp:32,maxRpc:2}}});
  const state=new Map([g,c].map(t=>[t.worker,{enabled:false,previews_enabled:false}]));
  const settings={local:'settings'},settingsSha256=createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  const expected={workers:[g.worker,c.worker,'cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery'].map(name=>({name,settingsSha256,versions:[{version_id:session.plan.version,percentage:100}]})),
    production:['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'].map(name=>({name,settingsSha256}))};
  const apps=[g,c].map(t=>({id:t.app,domain:t.domain,aud:t.audience,type:'self_hosted',destinations:[{type:'public',uri:t.domain}],service_auth_401_redirect:false,
    policies:[{id:t.policy,name:t===g?'CinaToken staging closed':'CinaToken recovery staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]}));
  const preflight={async run(){if(fault==='preflight')throw Error('local-secret');session.preflightComplete();return {result:'PASS',originalApps:structuredClone(apps)};}};
  const api=async(path,method='GET',body)=>{
    calls.push({path,method});if(method!=='GET'){if(!cleaning)session.assertWriteReady();mutated=true;}
    if(path.endsWith('/settings'))return fault==='final-isolation'?{changed:true}:settings;
    if(path.endsWith('/deployments'))return {deployments:[{versions:[{version_id:session.plan.version,percentage:100}]}]};
    if(path.startsWith('/workers/domains?'))return [];
    if(path.endsWith('/schedules'))return {schedules:[]};
    if(path.endsWith('/subdomain')&&['cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery'].some(w=>path.includes(w)))return {enabled:false,previews_enabled:false};
    if(path==='/d1/database/'+g.database)return {uuid:g.database,name:'cinatoken-staging'};
    if(path===`/workers/scripts/${g.worker}/tails`){
      if(method==='POST'){creation=true;const id=randomUUID().replaceAll('-','');tails.push({id});
        if(fault==='tail-ack-lost')throw Error('local-secret');ownTail=id;return {id,url:'wss://local.invalid/local-secret'};}
      return structuredClone(tails);
    }
    if(ownTail&&path===`/workers/scripts/${g.worker}/tails/${ownTail}`){assert.equal(method,'DELETE');tails.length=0;return {};}
    if(path==='/access/service_tokens'){
      if(method==='POST'){tokenId=randomUUID();const token={id:tokenId,name:session.plan.tokenName,enabled:true,client_id:'local',client_secret:'local-secret'};tokens.push(token);
        if(fault==='token-ack-lost')throw Error('local-secret');return token;}
      return structuredClone(tokens);
    }
    if(path==='/access/service_tokens/'+tokenId){if(method==='PUT')tokens[0].enabled=false;if(method==='DELETE')tokens.length=0;return {};}
    for(const target of [g,c]){
      if(path===`/workers/scripts/${target.worker}/subdomain`){if(method==='POST')state.set(target.worker,structuredClone(body));return {...state.get(target.worker)};}
      const i=apps.findIndex(a=>a.id===target.app);
      if(path==='/access/apps/'+target.app){if(method==='PUT')apps[i]=structuredClone(body);return structuredClone(apps[i]);}
      if(path===`/access/apps/${target.app}/policies/${target.policy}`){apps[i].policies=[{id:target.policy,...body}];
        if(!cleaning&&fault==='policy-ack-lost')throw Error('local-secret');return {};}
    }
    assert.fail('Unknown local API '+path);
  };
  const batch=async(statements,{write=false}={})=>{
    if(write){mutated=true;if(!cleaning)session.assertWriteReady();}
    assert.equal(write,!statements.every(s=>s.sql.startsWith('SELECT ')));
    const isSeed=statements.some(s=>s.sql.startsWith('INSERT INTO users'));
    const isDelete=statements.some(s=>s.sql.startsWith('DELETE'));
    if(isSeed)seedBatches++;
    if(isDelete){deleteBatches++;assert.equal(cleaning,true);assert.ok(ms>=350001);assert.ok([...state.values()].every(s=>!s.enabled));assert.equal(tokens.length+tails.length,0);
      if(fault==='race-after-guard-read')db.sqlite.prepare('UPDATE users SET budget_spent_micros=1 WHERE id=?').run(runId+'-user');}
    const values=await db.binding.batch(statements.map(s=>db.binding.prepare(s.sql).bind(...s.params)));
    if(isSeed&&fault==='seed-ack-lost')throw Error('local-secret');return values.map(v=>v.results);
  };
  const transport={api,batch,beginCleanup(){cleaning=true;},report:()=>({cloudMutationAttempted:mutated}),
    ownership:()=>({runId,tokenName:session.plan.tokenName,...(tokenId?{tokenId}:{}),tail:{creation:creation?'attempted':'not-attempted',...(ownTail?{id:ownTail}:{})}})};
  class Socket extends EventEmitter{
    constructor(url,protocol,options){super();assert.equal(protocol,'trace-v1');assert.equal(options.maxPayload,131072);queueMicrotask(()=>{if(fault==='tail-handshake')this.emit('error',Error('local-secret'));else this.emit('open');});}
    send(value){assert.deepEqual(JSON.parse(value),{debug:false});if(fault==='tail-send')throw Error('local-secret');}
    terminate(){this.emit('close');}
  }
  const pool=randomUUID(),fetchImpl=async(url,init)=>{
    http.push({url,method:init.method});
    if(url===PEER_WATCH_URL){
      if(!['inference-ack-lost','reject','reject-secret','reject-journal'].includes(fault))return new Response(null,{status:403});
      const frame={profile:PEER_PROFILE,kind:'sample',instanceId:pool,watchEpoch:1,barrier:0,sequence:1,maxRequests:1,maxReservedBytes:1024,requests:0,reservedBytes:0};
      return new Response(new ReadableStream({start(c){c.enqueue(Buffer.from(JSON.stringify(frame)+'\n'));}}),{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store','x-c02-capacity-instance':pool,'x-c02-capacity-peer':pool+':1'}});
    }
    if(url.endsWith('/v1/images/generations')){
      if(fault==='inference-ack-lost')throw Error('local-secret');
      return Response.json({status:'rejected',reason:fault==='reject-secret'?'local-secret':'peer_not_active_here',dispatch_started:false},{status:409});
    }
    const headers=new Headers(init.headers),valid=headers.get('CF-Access-Client-Secret')==='local-secret';
    if(!valid)return new Response(null,{status:403,headers:{'Content-Type':'text/html'}});
    if(fault==='auth')return new Response(null,{status:500});
    if(url.endsWith('/__staging/sse-capacity'))return Response.json({profile:'c02-sse-ownership-v1',instanceId:pool,maxRequests:1,maxReservedBytes:1024,requests:0,reservedBytes:0},
      {headers:{'Cache-Control':'no-store','x-c02-capacity-instance':pool}});
    assert.equal(headers.has('X-CinaToken-Recovery-Command'),false,'Auth probe must never run a recovery command');
    return Response.json({status:'invalid_command',reason:'command_header'},{status:400,headers:{'Cache-Control':'no-store'}});
  };
  const persist=async e=>{
    if(fault==='reject-journal'&&e.step==='peer-rejection')throw Error('local-secret');
    if(fault==='seed-journal'&&e.step==='peer-seed'&&e.result==='ACK'&&!logFailed){logFailed=true;throw Error('local-secret');}
    if(fault==='facts-journal'&&e.step==='peer-unused-fixture-facts')throw Error('local-secret');
    if(fault==='tampered-armed'&&e.step==='peer-unused-fixture-wait')db.sqlite.prepare("UPDATE system_config SET value='{}' WHERE description=?").run('c02-cancel:'+runId);
    events.push(structuredClone(e));
  };
  const run=createSseCapacityPeerRun({session,transport,preflight,expected,baselineCounts:baseline,key,persist,fetchImpl,Socket});
  return {run,session,db,counts,baseline,calls,http,events,state,tokens,tails,waits,get seedBatches(){return seedBatches;},get deleteBatches(){return deleteBatches;}};
}
