import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {peerCliMode,peerCliPlan,peerExpectedState,assertPeerCliConfig,createPeerCliJournal,runPeerWrangler,deployPeerClosed,assertPeerDeploymentReceipt,PEER_CLI_PATHS} from './staging-sse-capacity-peer-cli.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const temp=()=>mkdtempSync(join(tmpdir(),'cinatoken-peer-cli-'));

test('CLI accepts only one fixed explicit mode; no production/target/resume flags',()=>{
  for(const mode of ['--verify-local','--deploy-closed','--run'])assert.equal(peerCliMode([mode]),mode);
  for(const args of [[],['--run','--run'],['--run','--resume'],['--deploy'],['--env','production'],['--run=https://elsewhere']])assert.throws(()=>peerCliMode(args));
});
test('plan uses original clock, unique run/probes and the cumulative unreset budget',()=>{
  const clock=createSseOperatorClock(),a=peerCliPlan({version:randomUUID(),key:'local',clock}),b=peerCliPlan({version:randomUUID(),key:'local',clock});
  assert.equal(a.clock,clock);assert.notEqual(a.plan.runId,b.plan.runId);assert.equal(new Set(a.plan.plans.flatMap(p=>[p.snapshot.probeId,p.upstream.probeId])).size,4);
  assert.deepEqual(a.plan.budget,{previousPublicHttp:382,firstRoundUsdCap:2,capReset:false,maxPublicHttp:32,maxRpc:2});
  assert.throws(()=>a.assertWriteReady());assert.equal(a.requests.length,0);
});
test('historical expectation is copied and all known old token IDs are retained',()=>{
  const cloud={workersAfter:[{name:'local'}],productionAfter:[],accessAfter:[],schemaAfter:{},countsAfter:{},previousTokenIds:['a','b'],tokenId:'b'};
  const expected=peerExpectedState(cloud);assert.deepEqual(expected.previousTokenIds,['a','b']);cloud.workersAfter[0].name='changed';assert.equal(expected.workers[0].name,'local');
});
test('closed config contract passes and scope/ingress/resource/config expansion is rejected',()=>{
  const config={$schema:'local',main:'local',name:g.worker,account_id:g.account,workers_dev:false,preview_urls:false,routes:[],triggers:{crons:[]},
    limits:{cpu_ms:1000},compatibility_date:'2026-08-24',compatibility_flags:['nodejs_compat','enable_request_signal'],send_metrics:false,
    d1_databases:[{binding:'DB',database_id:g.database,database_name:'cinatoken-staging'}],services:[{binding:'IMAGE_UPSTREAM',service:'cinatoken-staging-images-upstream'}],
    vars:{DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'},ratelimits:[],observability:{},secrets:{}};
  assertPeerCliConfig(config);
  for(const mutate of [c=>c.name='cinatoken-proxy',c=>c.account_id='other',c=>c.workers_dev=true,c=>c.preview_urls=true,c=>c.routes=['example.com/*'],c=>c.triggers.crons=['* * * * *'],c=>c.d1_databases[0].database_id='production',c=>c.services[0].service='production',c=>c.queues={},c=>c.build={command:'unreviewed'},c=>c.limits.cpu_ms=300000]){
    const changed=structuredClone(config);mutate(changed);assert.throws(()=>assertPeerCliConfig(changed));
  }
});
test('journal is exclusive, append-only, fsynced and refuses result overwrite',()=>{
  const dir=join(temp(),'attempt'),journal=createPeerCliJournal(dir);
  journal.persist({step:'pending'});journal.persist({step:'ack'});journal.finish({result:'PASS'});
  assert.throws(()=>journal.finish({result:'overwritten'}));assert.throws(()=>createPeerCliJournal(dir));journal.close();journal.close();assert.throws(()=>journal.persist({step:'late'}));
  const events=readFileSync(join(dir,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(events.map(e=>e.sequence),[1,2]);assert.equal(JSON.parse(readFileSync(join(dir,'result.json'))).result,'PASS');
});
test('aborted journal operation and secret-bearing events never become durable facts',()=>{
  const dir=join(temp(),'attempt'),journal=createPeerCliJournal(dir,{secrets:['top-secret']});
  try{for(const event of [{value:'top-secret'},{client_secret:'unknown'},{Authorization:'Bearer x'},{url:'wss://private.invalid'}])assert.throws(()=>journal.persist(event));
    assert.throws(()=>journal.persist({step:'cancelled'},{signal:AbortSignal.abort()}));assert.equal(readFileSync(join(dir,'journal.jsonl'),'utf8'),'');
  }finally{journal.close();}
});

function childFactory(action){
  const calls=[];
  return {calls,spawnImpl(exe,args,options){const child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{queueMicrotask(()=>child.emit('close',null));return true;};calls.push({exe,args,options,child});queueMicrotask(()=>action(child));return child;}};
}
test('Wrangler launches fixed prebuilt entry with isolated logs, no shell or dry-run credentials',async()=>{
  const fake=childFactory(c=>{c.stdout.emit('data',Buffer.from('not logged'));c.emit('close',0);}),dir=temp();
  const result=await runPeerWrangler({root:process.cwd(),directory:dir,online:false,apiToken:'secret',spawnImpl:fake.spawnImpl});
  assert.equal(result.exitCode,0);assert.equal(result.uncertain,false);assert.equal(result.outputBytes,10);assert.ok(!JSON.stringify(result).includes('not logged'));
  const {args,options}=fake.calls[0];assert.ok(args.includes('--dry-run'));assert.ok(args.includes('--no-bundle'));assert.ok(args.includes('--autoconfig=false'));assert.ok(args.includes('--experimental-provision=false'));
  assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(options.env.WRANGLER_SEND_METRICS,'false');assert.ok(options.env.WRANGLER_LOG_PATH.startsWith(dir));assert.equal(options.shell,undefined);assert.equal(options.windowsHide,true);
});
test('one online Wrangler child uses fixed account and no dry-run flag',async()=>{
  const fake=childFactory(c=>c.emit('close',0));await runPeerWrangler({root:process.cwd(),directory:temp(),online:true,apiToken:'secret',spawnImpl:fake.spawnImpl});
  assert.equal(fake.calls.length,1);assert.equal(fake.calls[0].options.env.CLOUDFLARE_ACCOUNT_ID,g.account);assert.equal(fake.calls[0].options.env.CLOUDFLARE_API_TOKEN,'secret');assert.ok(!fake.calls[0].args.includes('--dry-run'));
});
test('Wrangler timeout terminates once and remains uncertain even with close acknowledgement',async()=>{
  const fake=childFactory(()=>{});const result=await runPeerWrangler({root:process.cwd(),directory:temp(),online:true,apiToken:'secret',spawnImpl:fake.spawnImpl,timeoutMs:5});
  assert.equal(result.uncertain,true);assert.equal(result.exitCode,null);assert.equal(fake.calls.length,1);
});
test('oversized child output stops the child and does not store plaintext',async()=>{
  const fake=childFactory(c=>c.stdout.emit('data',Buffer.alloc(262145,65)));const result=await runPeerWrangler({root:process.cwd(),directory:temp(),online:true,apiToken:'secret',spawnImpl:fake.spawnImpl});
  assert.equal(result.uncertain,true);assert.ok(JSON.stringify(result).length<300);
});
test('pre-aborted Wrangler signal prevents spawn',()=>{
  const fake=childFactory(()=>{});assert.throws(()=>runPeerWrangler({root:process.cwd(),directory:temp(),online:true,apiToken:'secret',signal:AbortSignal.abort(),spawnImpl:fake.spawnImpl}));assert.equal(fake.calls.length,0);
});

function deployment(fault){
  const clock=createSseOperatorClock(),events=[],calls=[],contexts=[],oldVersion=randomUUID(),newVersion=randomUUID();let uploads=0,checks=0;
  const settings={bindings:[],annotations:{old:true}},expected={workers:[{name:g.worker,settingsSha256:hash(settings),versions:[{version_id:oldVersion,percentage:100}]}],production:[],access:[],schema:{},counts:{}};
  const entrySha256='b'.repeat(64),oldEntrySha256='a'.repeat(64),manifestSha256='c'.repeat(64);
  const makeContext=(baseline,entry)=>{
    const index=contexts.length,session=peerCliPlan({version:baseline.workers[0].versions[0].version_id,key:'local',clock});
    const context={session,transport:{report:()=>({local:true}),beginCleanup(){events.push('containment');},async api(path,method='GET'){calls.push(path);
      if(path.endsWith('/subdomain'))return {enabled:fault==='isolation-failed',previews_enabled:false};
      if(path.startsWith('/workers/domains?'))return [];
      if(path.endsWith('/schedules'))return {schedules:[]};
      if(path.endsWith('/settings'))return uploads?(fault==='settings-drift'?{bindings:['unexpected']}: {...settings,annotations:{next:true}}):settings;
      return {deployments:[{versions:[{version_id:fault==='same-version'?oldVersion:newVersion,percentage:100}]}]};
    }},preflight:{async run(){events.push('preflight-'+index);if(fault===(index?'postflight':'preflight'))throw Error('local-secret');session.preflightComplete();return {result:'PASS',contentSha256:entry};}}};contexts.push(context);return context;
  };
  return {events,calls,contexts,expected,entrySha256,manifestSha256,get uploads(){return uploads;},async run(){return {...await deployPeerClosed({clock,expected,entrySha256,oldEntrySha256,makeContext,
    integrity(){checks++;if(fault==='integrity'||(fault==='late-integrity'&&checks===2))throw Error('changed');},
    async persist(e){events.push(e.step??e);if(fault==='pending-journal'&&e.step==='closed-deploy'&&e.result==='PENDING')throw Error('disk');},
    async cli(online){events.push(online?'upload':'dry-run');if(online)uploads++;return {exitCode:fault===(online?'upload-error':'dry-run')?1:0,uncertain:online&&fault==='upload-unknown'};}
  }),mode:'--deploy-closed',manifestSha256};}};
}
test('closed deploy binds two fresh preflights to actual new version/content before receipt',async()=>{
  const f=deployment(),report=await f.run();assert.equal(report.result,'PASS');assert.equal(f.uploads,1);assert.equal(f.contexts.length,2);
  assert.equal(f.contexts[0].session.clock,f.contexts[1].session.clock);assert.notEqual(f.contexts[0].session.plan.version,f.contexts[1].session.plan.version);
  assert.ok(f.events.indexOf('preflight-0')<f.events.indexOf('upload'));assert.ok(f.events.indexOf('upload')<f.events.indexOf('preflight-1'));
  assertPeerDeploymentReceipt(report,{manifestSha256:f.manifestSha256,entrySha256:f.entrySha256});assert.equal(report.c02GatePassed,false);
});
for(const fault of ['integrity','dry-run','preflight','late-integrity','pending-journal'])test('closed deployment refuses upload on '+fault,async()=>{
  const f=deployment(fault),report=await f.run();assert.equal(report.result,'FAIL');assert.equal(f.uploads,0);assert.equal(report.cloudMutationAttempted,false);
});
for(const fault of ['upload-error','upload-unknown','same-version','settings-drift','postflight','isolation-failed'])test('closed deployment retains uncertainty/drift without replay: '+fault,async()=>{
  const f=deployment(fault),report=await f.run();assert.equal(report.result,'ATTENTION_REQUIRED');assert.equal(f.uploads,1);assert.equal(report.cloudMutationAttempted,true);
  assert.ok(f.calls.some(p=>p.endsWith('/deployments')));assert.throws(()=>assertPeerDeploymentReceipt(report,{manifestSha256:f.manifestSha256,entrySha256:f.entrySha256}));
  assert.ok(f.events.includes('containment'));assert.ok(f.calls.some(p=>p.endsWith('/subdomain')));
});
test('receipt rejects stale package, wrong module, budget resets and changed deployment state',async()=>{
  const f=deployment(),report=await f.run(),params={manifestSha256:f.manifestSha256,entrySha256:f.entrySha256};
  for(const change of [r=>r.manifestSha256='other',r=>r.entrySha256='other',r=>r.postflight.contentSha256='other',r=>r.publicHttpCumulative=0,r=>r.publicHttpAdded=1,r=>r.capReset=true,r=>r.upload.uncertain=true,r=>r.productionWrites=1,r=>r.mode='--run']){
    const r=structuredClone(report);change(r);assert.throws(()=>assertPeerDeploymentReceipt(r,params));
  }
});
