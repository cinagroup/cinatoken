// Node diagnostic, never a Workers physical-memory acceptance result. Real SQLite and host/repository path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup,sample,prepare } from '../../../core/src/storage/recovery/usage-settlement-test-support.mjs';
import { encodeUsageSettlement,MAX_SETTLEMENT_BYTES } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';
import { RECOVERY_EXPERIMENT_PROFILE as profile } from '../../../../scripts/deploy/prepare-staging-recovery-experiment.mjs';
function auditJson(maxBytes,kind){
  if(kind==='dense')return '['+Array(Math.max(0,Math.floor((maxBytes-1)/3))).fill('{}').join(',')+']';
  const character=kind==='unicode'?'漢':'x';
  return JSON.stringify(character.repeat(Math.max(0,Math.floor((maxBytes-2)/Buffer.byteLength(character)))));
}
async function nearLimit(kind,cost){
  const value=sample(cost),log=value.params.requestLog,audit=value.params.audit;
  for(const [object,key,limit]of [[log,'rawUsage',65536],[log,'pricingAudit',65536],[log,'routeTrace',32768],[log,'timingMetadata',32768],[audit,'beforeUserSnapshot',32768]])
    object[key]=auditJson(limit,kind);
  let low=2,high=32768,best;
  while(low<=high){
    const middle=Math.floor((low+high)/2);audit.afterUserSnapshot=auditJson(middle,kind);
    try{best=await encodeUsageSettlement(value);low=middle+1;}
    catch{high=middle-1;}
  }
  audit.afterUserSnapshot=auditJson(high,kind);
  const encoded=await encodeUsageSettlement(value);
  assert.ok(best&&Buffer.byteLength(encoded.json)>=MAX_SETTLEMENT_BYTES-4);
  return value;
}
async function one(kind,cost){
  assert.ok(global.gc,'Use --expose-gc');assert.ok(['ascii','unicode','dense'].includes(kind));
  assert.ok(cost===0||cost===0.1);
  const db=setup();db.sqlite.exec(readFileSync(new URL('../../../core/migrations-proposals/d1/request-usage-recovery-jobs.sql',import.meta.url),'utf8'));
  const sizes=[];
  async function seed(){
    for(let i=0;i<profile.maxItems;i++){
      const value=await nearLimit(kind,cost);await prepare(db,value);await db.repo.persist(value);
      sizes.push(Buffer.byteLength((await encodeUsageSettlement(value)).json));
    }
  }
  const originalLog=console.log;
  try{
    await seed();global.gc();global.gc();
    const baseline=process.memoryUsage(),peak={...baseline},points=[];
    const observe=label=>{
      const usage=process.memoryUsage();for(const key of Object.keys(peak))peak[key]=Math.max(peak[key],usage[key]);
      points.push({label,heapUsed:usage.heapUsed,external:usage.external,arrayBuffers:usage.arrayBuffers,rss:usage.rss});
    };
    db.hooks.beforeStatement=sql=>observe(/main\.sqlite_master/.test(sql)?'schema-query':sql.trim().split(/\s+/)[0]);
    db.hooks.afterStatement=()=>observe('statement-result');
    db.hooks.afterBatch=()=>observe('batch-result');
    const host=createUsageRecoveryHost(),held=[];
    console.log=()=>{};
    const started=performance.now();
    const result=await host.run(db.binding,{
      RECOVERY_ENVIRONMENT:'staging',RECOVERY_ENABLED:'true',RECOVERY_MAX_ITEMS:String(profile.maxItems),
      RECOVERY_CONCURRENCY:String(profile.concurrency),RECOVERY_LEASE_SECONDS:String(profile.leaseSeconds),
      RECOVERY_RUN_BUDGET_MS:String(profile.runBudgetMs),RECOVERY_RESERVED_BYTES:String(profile.reservedBytesPerConsumer),
      RECOVERY_INSTANCE_BYTES:String(profile.instancePoolBytes),
    },{waitUntil:promise=>held.push(promise)});
    await Promise.all(held);observe('run-settled');
    assert.equal(result.status,'finished');assert.equal(result.result.committed,profile.maxItems);
    assert.equal(result.result.uncertain,0);assert.equal(result.result.blocked,0);assert.equal(result.result.deferred,0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n,profile.maxItems);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM request_usage_recovery_jobs WHERE state='committed'").get().n,profile.maxItems);
    const snapshot=host.snapshot();assert.equal(snapshot.active,false);
    assert.equal(snapshot.capacity.requests,0);assert.equal(snapshot.capacity.reservedBytes,0);
    const spent=db.sqlite.prepare("SELECT budget_spent_micros AS n FROM users WHERE id='recovery-user'").get().n;
    assert.equal(spent,Math.round(profile.maxItems*cost*1000000));
    return {kind,cost,syntheticBudgetSpentMicros:spent,realPaidCalls:0,payloadBytes:sizes,result:result.result,elapsedMs:performance.now()-started,baseline,peak,
      delta:Object.fromEntries(Object.keys(peak).map(key=>[key,peak[key]-baseline[key]])),samplePoints:points.length,
      schemaObserved:points.some(point=>point.label==='schema-query'),snapshot,
      runtime:process.version,nodePlatform:process.platform,sqliteVersion:db.sqlite.prepare('SELECT sqlite_version() AS v').get().v,
      nodeOnly:true,synchronousPeaksMayBeMissed:true,workerMemoryMeasured:false};
  }finally{console.log=originalLog;db.sqlite.close();}
}
if(process.argv[2]==='--sample'){
  assert.equal(process.argv.length,5);console.log(JSON.stringify(await one(process.argv[3],Number(process.argv[4]))));
}else{
  const cost=process.argv[2]==='--charged'?0.1:0;
  assert.deepEqual(process.argv.slice(2),cost>0?['--charged']:[]);
  const file='.wrangler/staging/recovery-workset-'+profile.id+'-'+(cost>0?'charged':'zero')+'-results.json';assert.equal(existsSync(file),false);
  const report={startedAt:new Date().toISOString(),profile,cost,syntheticFundsOnly:true,samples:[],failures:[],workerMemoryMeasured:false,cloudCalls:0};
  for(const kind of ['ascii','unicode','dense']){
    for(let repeat=1;repeat<=3;repeat++){
      const child=spawnSync(process.execPath,['--expose-gc','--import','tsx',fileURLToPath(import.meta.url),'--sample',kind,String(cost)],
        {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1048576});
      if(child.status!==0){
        report.failures.push({kind,repeat,status:child.status,error:child.error?.message,stderr:child.stderr?.slice(-2000)});
        writeFileSync(file,JSON.stringify(report,null,2));process.exitCode=1;console.log(JSON.stringify(report));process.exit(1);
      }
      const result={repeat,...JSON.parse(child.stdout)};report.samples.push(result);
      console.log(JSON.stringify({kind,repeat,payloadBytes:result.payloadBytes[0],committed:result.result.committed,delta:result.delta}));
      writeFileSync(file,JSON.stringify(report,null,2));
    }
  }
  report.finishedAt=new Date().toISOString();report.status='NODE_DIAGNOSTIC_PASS';
  writeFileSync(file,JSON.stringify(report,null,2));
}
