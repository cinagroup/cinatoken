import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,openSync,writeSync,fsyncSync,closeSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {PEER_DIAGNOSTIC_ENTRY_SHA256,PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE} from './staging-sse-peer-diagnostic-candidate.mjs';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {createSseHostExpirySession} from './staging-sse-host-expiry-session.mjs';
import {createSseCapacityPeerTransport} from './staging-sse-capacity-peer-transport.mjs';
import {createSseCapacityPeerPreflight} from './staging-sse-capacity-peer-preflight.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex'),digest=v=>sha(JSON.stringify(v));
const copy=v=>structuredClone(v),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const PEER_CLI_DIAGNOSTIC_PATHS=Object.freeze({
  manifest:'docs/developers/architecture/implementation-evidence/C02-images-sse-peer-diagnostic-operator-v231-results.json',
  prepared:'.wrangler/staging/sse-peer-diagnostic-v230-prepare-result.json',
  config:'.wrangler/staging/sse-peer-diagnostic-v230/wrangler.jsonc',
  entry:'.wrangler/staging/sse-peer-diagnostic-v230/bundle/images-sse-capacity-peer-diagnostic-gateway.js',
  deploy:'.wrangler/staging/sse-peer-diagnostic-v231-deploy',
  run:'.wrangler/staging/sse-peer-diagnostic-v231-run',
});

export function peerCliModeDiagnostic(args){
  assert.ok(Array.isArray(args)&&args.length===1&&['--verify-local','--deploy-closed','--run'].includes(args[0]),'One explicit fixed mode required');
  return args[0];
}
export function assertPeerDiagnosticBudget(cloud){
  assert.equal(cloud.firstRoundUsdCap,2);assert.equal(cloud.capReset,false);
  assert.equal(cloud.publicHttpCumulative,PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE);
  const budget=cloud.budget,values=[budget.priorAndDelayedUsageReservationUsd,budget.nextSyntheticTestReservationUsd,budget.unallocatedReserveUsd];
  assert.ok(values.every(v=>Number.isFinite(v)&&v>=0));
  assert.ok(values.reduce((sum,v)=>sum+v,0)<=2+Number.EPSILON);
  assert.ok(budget.nextSyntheticTestReservationUsd>=0.05,'Synthetic trial reserve required within original cap');
}
export function peerExpectedStateDiagnostic(cloud){
  return copy({workers:cloud.workersAfter,production:cloud.productionAfter,access:cloud.accessAfter,
    schema:cloud.schemaAfter,counts:cloud.countsAfter,previousTokenIds:[...new Set([...(cloud.previousTokenIds??[]),cloud.tokenId].filter(Boolean))]});
}
export function peerCliPlanDiagnostic({version,key,serverNow=Date.now(),clock=createSseOperatorClock()}){
  const runId='c02-success-'+randomUUID(),baseline={previousPublicHttp:PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE,firstRoundUsdCap:2};
  const input={scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},version,runId,
    keyHash:'sha256:'+sha(key),expiresAt:new Date(serverNow+3600000).toISOString(),tokenName:'cinatoken-sse-v231-'+randomUUID(),
    plans:['before-hold','after-hold'].map(mode=>({mode,snapshot:{runId,mode,probeId:randomUUID()},upstream:{runId,mode:'success',probeId:randomUUID()}})),
    budget:{...baseline,capReset:false,maxPublicHttp:32,maxRpc:2}};
  return createSseHostExpirySession({input,baseline,clock});
}
export function assertPeerCliConfigDiagnostic(config){
  assert.deepEqual(Object.keys(config).sort(),['$schema','name','main','compatibility_date','compatibility_flags','send_metrics','workers_dev','preview_urls','routes','triggers','vars','d1_databases','ratelimits','observability','secrets','services','account_id','limits'].sort());
  assert.equal(config.name,g.worker);assert.equal(config.account_id,g.account);assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
  assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers,{crons:[]});assert.deepEqual(config.limits,{cpu_ms:1000});
  assert.equal(config.compatibility_date,'2026-08-24');assert.deepEqual(config.compatibility_flags,['nodejs_compat','enable_request_signal']);
  assert.equal(config.send_metrics,false);assert.equal(config.d1_databases.length,1);
  assert.equal(config.d1_databases[0].binding,'DB');assert.equal(config.d1_databases[0].database_id,g.database);assert.equal(config.d1_databases[0].database_name,'cinatoken-staging');
  assert.deepEqual(config.services,[{binding:'IMAGE_UPSTREAM',service:'cinatoken-staging-images-upstream'}]);
  assert.deepEqual(config.vars,{DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'});
  assert.deepEqual(config.observability,{enabled:true,head_sampling_rate:1});
  assert.deepEqual(config.secrets,{required:['SHARED_KEY_ENCRYPTION_SECRET']});
  assert.deepEqual(config.ratelimits,[
    {name:'AUTH_RATE_LIMITER',namespace_id:'60002001',simple:{limit:30,period:60}},
    {name:'PUBLIC_STATS_RATE_LIMITER',namespace_id:'60002002',simple:{limit:12,period:60}},
    {name:'ANALYTICS_RATE_LIMITER',namespace_id:'60002003',simple:{limit:64,period:60}},
  ]);
}

/** Append-only, exclusive attempt reservation. A crash leaves the directory and
 * durable PENDING records; no resume, truncation, or automatic new attempt. */
export function createPeerCliJournalDiagnostic(directory,{secrets=[]}={}){
  mkdirSync(directory);let fd;
  try{fd=openSync(resolve(directory,'journal.jsonl'),'wx',0o600);}catch(error){throw error;}
  let sequence=0,closed=false;
  const encode=value=>{
    const text=JSON.stringify(value);assert.ok(Buffer.byteLength(text)<=8388608);
    for(const secret of secrets)if(secret)assert.ok(!text.includes(secret),'Secret in journal');
    assert.ok(!/"(?:client_secret|client_id|Authorization)"\s*:|wss:\/\//i.test(text),'Sensitive resource in journal');
    return Buffer.from(text+'\n');
  };
  const write=(handle,bytes)=>{let n=0;while(n<bytes.length){const wrote=writeSync(handle,bytes,n,bytes.length-n);assert.ok(wrote>0);n+=wrote;}fsyncSync(handle);};
  return Object.freeze({
    persist(event,{signal}={}){assert.equal(closed,false);signal?.throwIfAborted();write(fd,encode({sequence:++sequence,event}));signal?.throwIfAborted();},
    finish(report){assert.equal(closed,false);const bytes=encode(report),out=openSync(resolve(directory,'result.json'),'wx',0o600);try{write(out,bytes);}finally{closeSync(out);}},
    close(){if(!closed){closed=true;closeSync(fd);}},
  });
}

/** Executable-bound, no-shell child. No caller flags, env file or target override.
 * A timeout is uncertain, even if the CLI later finishes uploading. */
export function runPeerWranglerDiagnostic({root,directory,online,apiToken,signal,spawnImpl=spawn,timeoutMs=180000}){
  assert.equal(typeof online,'boolean');assert.ok(timeoutMs>0&&timeoutMs<=180000);
  const args=['node_modules/wrangler/bin/wrangler.js','deploy',PEER_CLI_DIAGNOSTIC_PATHS.entry,'--no-bundle','--experimental-provision=false','--autoconfig=false','--config',PEER_CLI_DIAGNOSTIC_PATHS.config];
  if(!online)args.push('--dry-run','--outdir',resolve(directory,'dry-run'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>! /^(?:CF_|CLOUDFLARE_|WRANGLER_|NODE_OPTIONS$)/i.test(k)));
  Object.assign(env,{CLOUDFLARE_ACCOUNT_ID:g.account,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(directory,online?'deploy.log':'dry-run.log')});
  if(online){assert.ok(apiToken);env.CLOUDFLARE_API_TOKEN=apiToken;}
  signal?.throwIfAborted();
  return new Promise(resolveResult=>{
    let child,timer,killTimer,finished=false,uncertain=false,size=0;const hash=createHash('sha256');
    const complete=(exitCode,reason)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',stop);
      resolveResult({exitCode,reason,uncertain,outputBytes:size,outputSha256:hash.digest('hex'),...(child?.pid?{pid:child.pid}:{})});};
    const stop=()=>{if(finished)return;uncertain=true;try{child?.kill();}catch{};killTimer??=setTimeout(()=>complete(null,'termination-unconfirmed'),5000);};
    try{child=spawnImpl(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const data=b=>{if(finished)return;size+=b.length;hash.update(b);if(size>262144)stop();};
      child.stdout.on('data',data);child.stderr.on('data',data);child.once('error',()=>complete(null,'spawn-error'));
      child.once('close',code=>complete(code,uncertain?'interrupted':'closed'));
      signal?.addEventListener('abort',stop,{once:true});timer=setTimeout(stop,timeoutMs);if(signal?.aborted)stop();
    }catch{complete(null,'spawn-error');}
  });
}

/** Deployment has no inference session to replay. Its two read-only preflights
 * share one clock; the later inference starts its own ORIGINAL session once. */
export async function deployPeerClosedDiagnostic({expected,oldEntrySha256,entrySha256,makeContext,cli,integrity,persist,clock}){
  const before=copy(expected),report={result:'RUNNING',cloudMutationAttempted:false,publicHttpAdded:0,publicHttpCumulative:PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE,
    firstRoundUsdCap:2,capReset:false,modelCalls:0,kmsCalls:0,productionWrites:0,c02GatePassed:false,management:[]};
  let context,containmentTransport;
  try{
    integrity();const dry=await cli(false);await persist({step:'closed-dry-run',...dry});assert.equal(dry.exitCode,0);assert.equal(dry.uncertain,false);
    context=makeContext(before,oldEntrySha256);containmentTransport=context.transport;await context.preflight.run();
    const settings=await context.transport.api(`/workers/scripts/${g.worker}/settings`);
    assert.equal(digest(settings),before.workers.find(w=>w.name===g.worker).settingsSha256);
    integrity();context.session.assertWriteReady();
    await persist({step:'closed-deploy',result:'PENDING',started:clock.sample()});
    report.cloudMutationAttempted=true;const upload=await cli(true);report.upload=upload;
    await persist({step:'closed-deploy',...upload});
    // Read back even a nonzero/uncertain CLI result. Never upload twice.
    const current=await context.transport.api(`/workers/scripts/${g.worker}/settings`);
    const versions=(await context.transport.api(`/workers/scripts/${g.worker}/deployments`)).deployments[0].versions;
    report.gatewayObserved={name:g.worker,settingsSha256:digest(current),versions};
    assert.equal(versions.length,1);assert.equal(versions[0].percentage,100);assert.match(versions[0].version_id,uuid);
    assert.notDeepEqual(versions,before.workers.find(w=>w.name===g.worker).versions);
    const {annotations:oldAnnotations,...oldSettings}=settings,{annotations:newAnnotations,...newSettings}=current;
    assert.deepEqual(newSettings,oldSettings,'Only executable and annotations may change');
    const after=copy(before);after.workers[after.workers.findIndex(w=>w.name===g.worker)]=report.gatewayObserved;
    report.management.push(context.transport.report());context=makeContext(after,entrySha256);
    report.postflight=await context.preflight.run();
    assert.equal(upload.exitCode,0);assert.equal(upload.uncertain,false);integrity();
    report.expected=after;report.entrySha256=entrySha256;report.result='PASS';
  }catch{report.result=report.cloudMutationAttempted?'ATTENTION_REQUIRED':'FAIL';}
  finally{
    if(report.cloudMutationAttempted){
      // Independent of upload ACK, content/settings comparisons and journal ACK.
      // Only the two already-authorized staging ingresses can be closed here.
      try{
        const transport=containmentTransport;transport.beginCleanup();
        for(const name of [g.worker,c.worker,'cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery']){
          let state=await transport.api(`/workers/scripts/${name}/subdomain`);
          if((state.enabled!==false||state.previews_enabled!==false)&&[g.worker,c.worker].includes(name)){
            await transport.api(`/workers/scripts/${name}/subdomain`,'POST',{enabled:false,previews_enabled:false});
            state=await transport.api(`/workers/scripts/${name}/subdomain`);
          }
          assert.equal(state.enabled,false);assert.equal(state.previews_enabled,false);
          assert.deepEqual(await transport.api('/workers/domains?service='+name),[]);
          assert.deepEqual((await transport.api(`/workers/scripts/${name}/schedules`)).schedules,[]);
        }
        for(const p of before.production)assert.equal(digest(await transport.api(`/workers/scripts/${p.name}/settings`)),p.settingsSha256);
        for(const a of before.access)assert.equal(digest(await transport.api('/access/apps/'+a.id)),a.sha256);
        report.finalIsolationVerified=true;
      }catch{report.finalIsolationVerified=false;report.result='ATTENTION_REQUIRED';}
    }
    // Re-snapshot the first transport after independent containment reads.
    report.management=[];if(containmentTransport)report.management.push(containmentTransport.report());
    if(context&&context.transport!==containmentTransport)report.management.push(context.transport.report());
    report.finished=clock.sample();await persist({step:'closed-deploy-complete',...report});
  }
  return report;
}

export function assertPeerDeploymentReceiptDiagnostic(receipt,{manifestSha256,entrySha256}){
  assert.equal(receipt.result,'PASS');assert.equal(receipt.mode,'--deploy-closed');assert.equal(receipt.manifestSha256,manifestSha256);
  assert.equal(receipt.entrySha256,entrySha256);assert.equal(receipt.postflight.result,'PASS');assert.equal(receipt.postflight.contentSha256,entrySha256);
  assert.equal(receipt.cloudMutationAttempted,true);assert.equal(receipt.upload.exitCode,0);assert.equal(receipt.upload.uncertain,false);
  assert.equal(receipt.finalIsolationVerified,true);
  assert.equal(receipt.publicHttpAdded,0);assert.equal(receipt.publicHttpCumulative,PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE);assert.equal(receipt.firstRoundUsdCap,2);assert.equal(receipt.capReset,false);
  assert.equal(receipt.modelCalls+receipt.kmsCalls+receipt.productionWrites,0);
}

// Fixed local evidence only. Arbitrary file arguments and resume flags are not supported.
export async function peerCliMainDiagnostic(args){
  const mode=peerCliModeDiagnostic(args),root=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
  assert.equal(realpathSync(process.cwd()),root,'Run from the project root');
  const inside=p=>{const path=realpathSync(resolve(root,p)),rel=relative(root,path);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));return path;};
  const read=p=>JSON.parse(readFileSync(inside(p))),manifest=read(PEER_CLI_DIAGNOSTIC_PATHS.manifest),prepared=read(PEER_CLI_DIAGNOSTIC_PATHS.prepared);
  const manifestSha256=sha(readFileSync(inside(PEER_CLI_DIAGNOSTIC_PATHS.manifest)));
  assert.equal(manifest.version,'1.130');assert.equal(manifest.diagnostic.resourceOperatorIntegrated,true);assert.equal(manifest.diagnostic.oneShotCliIntegrated,true);assert.equal(prepared.result,'PASS');
  assert.equal(manifest.cloud.publicHttpCumulative,PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE);assert.equal(manifest.cloud.firstRoundUsdCap,2);assert.equal(manifest.cloud.capReset,false);
  assert.equal(manifest.cloud.modelCallsCumulative+manifest.cloud.kmsCallsCumulative,0);
  assertPeerDiagnosticBudget(manifest.cloud);
  assert.equal(prepared.entry.path,PEER_CLI_DIAGNOSTIC_PATHS.entry);assert.deepEqual(prepared.entry,manifest.candidateBuild.entry);assert.equal(prepared.generatedBindingsMatch,true);assert.equal(prepared.entry.sha256,PEER_DIAGNOSTIC_ENTRY_SHA256);
  const records=[...manifest.files,...manifest.operationalArtifacts,...manifest.evidenceDependencies,...manifest.bundleInputs,...prepared.inputs,...prepared.artifacts];
  assert.ok(records.some(r=>r.path==='scripts/deploy/staging-sse-peer-diagnostic-cli.mjs'));
  const integrity=()=>{assert.equal(sha(readFileSync(inside(PEER_CLI_DIAGNOSTIC_PATHS.manifest))),manifestSha256);for(const r of records)assert.equal(sha(readFileSync(inside(r.path))),r.sha256,r.path);};
  integrity();assertPeerCliConfigDiagnostic(read(PEER_CLI_DIAGNOSTIC_PATHS.config));assert.equal(read('node_modules/wrangler/package.json').version,'4.127.1');
  if(mode==='--verify-local')return {result:'PASS',mode,hashRecords:records.length,cloudCalls:0};
  const apiToken=process.env.CLOUDFLARE_API_TOKEN;assert.ok(apiToken&&apiToken.length<=4096,'Cloudflare token unavailable');
  const clock=createSseOperatorClock(),key='sk-c02-'+randomBytes(32).toString('hex');
  const directory=resolve(root,mode==='--deploy-closed'?PEER_CLI_DIAGNOSTIC_PATHS.deploy:PEER_CLI_DIAGNOSTIC_PATHS.run);
  assert.equal(realpathSync(resolve(directory,'..')),inside('.wrangler/staging'));
  // Exclusive directory BEFORE any cloud effect. Never remove it to retry.
  const journal=createPeerCliJournalDiagnostic(directory,{secrets:[apiToken,key]}),persist=journal.persist;
  const ac=new AbortController(),interrupt=()=>ac.abort();process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  const network=(url,options)=>{ac.signal.throwIfAborted();return fetch(url,{...options,signal:AbortSignal.any([ac.signal,options.signal].filter(Boolean))});};
  let report={result:'FAIL',mode,manifestSha256,publicHttpAdded:0,publicHttpCumulative:PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE,firstRoundUsdCap:2,capReset:false},run;
  const makeContext=(expected,entrySha256)=>{
    const version=expected.workers.find(w=>w.name===g.worker).versions[0].version_id;
    const session=peerCliPlanDiagnostic({version,key,clock});
    const transport=createSseCapacityPeerTransport({session,apiToken,persist});
    const preflight=createSseCapacityPeerPreflight({session,transport,expected,entrySha256,persist});
    return {session,transport,preflight};
  };
  try{
    persist({step:'cli-reserved',mode,manifestSha256,budget:report,started:clock.sample()});
    if(mode==='--deploy-closed'){
      const observed=read(manifest.cloud.lastObservationManifest).cloud;
      report={...report,...await deployPeerClosedDiagnostic({expected:peerExpectedStateDiagnostic(observed),oldEntrySha256:observed.gatewayContentSha256,entrySha256:prepared.entry.sha256,
        makeContext,cli:online=>runPeerWranglerDiagnostic({root,directory,online,apiToken,signal:ac.signal}),integrity,persist,clock})};
    }else{
      const receipt=read(PEER_CLI_DIAGNOSTIC_PATHS.deploy+'/result.json');assertPeerDeploymentReceiptDiagnostic(receipt,{manifestSha256,entrySha256:prepared.entry.sha256});
      const {createSsePeerDiagnosticRunWithRejection}=await import('./staging-sse-peer-diagnostic-run-with-rejection.mjs');
      const context=makeContext(receipt.expected,prepared.entry.sha256);ac.signal.throwIfAborted();integrity();
      persist({step:'cli-plan',plan:context.session.plan,receiptSha256:sha(readFileSync(inside(PEER_CLI_DIAGNOSTIC_PATHS.deploy+'/result.json')))});
      run=createSsePeerDiagnosticRunWithRejection({...context,expected:receipt.expected,baselineCounts:receipt.expected.counts,key,persist,fetchImpl:network,
        onWait:left=>console.log(JSON.stringify({step:'safety-wait',remainingSeconds:Math.ceil(left/1000)}))});
      const result=await run.run();report={...report,result:result.result,run:result,publicHttpAdded:result.publicHttp,publicHttpCumulative:result.cumulativePublicHttp};
    }
    integrity();
  }catch{report.result='ATTENTION_REQUIRED';if(run){report.run=run.report();report.publicHttpAdded=report.run.publicHttp;report.publicHttpCumulative=PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE+report.publicHttpAdded;}}
  finally{
    try{journal.finish({...report,finished:clock.sample(),finalIncrementalBillVerified:false,c02GatePassed:false});}
    finally{journal.close();process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
  }
  return {result:report.result,mode,output:relative(root,resolve(directory,'result.json')),publicHttpAdded:report.publicHttpAdded,publicHttpCumulative:report.publicHttpCumulative};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await peerCliMainDiagnostic(process.argv.slice(2));console.log(JSON.stringify(result));if(!['PASS','OBSERVED'].includes(result.result))process.exitCode=1;}
  catch{console.error(JSON.stringify({result:'FAIL',error:'peer_cli_stopped; inspect the reserved journal, do not replay'}));process.exitCode=1;}
}
