import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,writeFile,mkdir,mkdtemp } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCancellationRecord,ownedCancellationSources,buildOwnedCancellationCandidates } from './postgres-owned-cancellation.mjs';
import { sourcePins,sha256,buildRetirementCandidates } from './postgres-transaction-retirement.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url)),exec=promisify(execFile);
const prefix='packages/core/src/storage/recovery/';

test('owned cancellation record caches frozen public state and first result independently of close',async()=>{
  const r=createCancellationRecord(),before=r.handle.snapshot();
  assert.ok(Object.isFrozen(r.handle));assert.ok(Object.isFrozen(before));
  r.complete('transport_closed');r.fail();r.complete('different');
  assert.deepEqual(await r.handle.result,{status:'transport_closed'});
  assert.deepEqual(before,{result:'pending',transportClose:'pending',transportRawClose:'pending',primaryClose:'pending',primaryRawClose:'pending'});
  assert.equal(r.handle.snapshot().transportClose,'pending');r.close();r.close('different');
  assert.deepEqual(await r.handle.transportClosed,{status:'close_observed'});
  r.observeTransportRawClose(Promise.resolve());assert.deepEqual(await r.handle.transportRawClosed,{status:'raw_closed'});
  assert.equal(r.handle.snapshot().primaryClose,'pending');r.primaryClose();
  assert.deepEqual(await r.handle.primaryCloseObserved,{status:'close_observed'});
  r.observeRawClose(Promise.resolve());assert.deepEqual(await r.handle.primaryRawClosed,{status:'raw_closed'});
  assert.deepEqual(Object.keys(r.handle).sort(),['primaryCloseObserved','primaryRawClosed','result','snapshot','transportClosed','transportRawClosed']);
});

test('owned cancellation rejection is observed, fixed-message, and never fabricates a close',async()=>{
  const r=createCancellationRecord();r.fail();await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(r.handle.result,{code:'CANCEL_TRANSPORT_FAILED',message:'Owned cancellation transport failed'});
  r.complete('transport_closed');assert.deepEqual(r.handle.snapshot(),{result:'failed',transportClose:'pending',transportRawClose:'pending',primaryClose:'pending',primaryRawClose:'pending'});
  r.close('not_started');assert.deepEqual(await r.handle.transportClosed,{status:'not_started'});
  r.observeTransportRawClose(Promise.reject(new Error('private transport raw close failure')));
  assert.deepEqual(await r.handle.transportRawClosed,{status:'raw_close_rejected'});
  r.primaryClose('not_started');assert.deepEqual(await r.handle.primaryCloseObserved,{status:'not_started'});
  r.observeRawClose(Promise.reject(new Error('private raw close failure')));
  assert.deepEqual(await r.handle.primaryRawClosed,{status:'raw_close_rejected'});
});

test('owned cancellation transformations reject drift and double application on every branch',async()=>{
  for(const [variant,pin] of Object.entries(sourcePins)){
    const original={};for(const kind of ['index','connection','query'])original[kind]=await readFile(join(root,'node_modules/postgres',dirname(pin.entry),kind+'.js'),'utf8');
    const transformed=ownedCancellationSources(original,variant);
    for(const kind of ['index','connection','query'])assert.throws(()=>ownedCancellationSources({...original,[kind]:original[kind]+'\n'},variant),/Unsupported/);
    assert.throws(()=>ownedCancellationSources(transformed,variant),/Unsupported/);
    assert.throws(()=>ownedCancellationSources(original,'other'),/Unsupported/);
  }
});

test('v302 owned cancellation: bounded dual-branch protocol evidence and unchanged production inputs',{timeout:120000},async t=>{
  const historical=JSON.parse(await readFile(join(root,'docs/developers/architecture/implementation-evidence/C03-postgres-owned-cancellation-v302-results.json'),'utf8'));
  const changed=[];
  for(const [name,hash] of Object.entries(historical.sourceSha256))
    if(sha256(await readFile(join(root,name)))!==hash)changed.push(name);
  if(changed.length){
    t.diagnostic('Historical v302 evidence remains immutable; current source drift: '+changed.join(', '));
    t.skip('Superseded by the v303 owned-cancellation owner harness after intentional source changes');
    return;
  }
  await mkdir(join(root,'.wrangler/staging'),{recursive:true});
  const directory=await mkdtemp(join(root,'.wrangler/staging/postgres-owned-cancel-v302-run-'));
  const before={},report={directory,tests:{},before,boundaries:{workersRuntime:false,nativePostgres:false,deployed:false,adoptionChanged:false}};
  const protectedPaths=['package-lock.json','pnpm-lock.yaml','node_modules/postgres/package.json','packages/core/package.json','packages/core/dist/index.js','packages/proxy/package.json','packages/proxy/wrangler.jsonc',
    ...Object.values(sourcePins).flatMap(pin=>['index','connection','query'].map(kind=>'node_modules/postgres/'+pin.entry.replace('index.js',kind+'.js')))];
  for(const name of protectedPaths)before[name]=sha256(await readFile(join(root,name)));
  const previous=JSON.parse(await readFile(join(root,'docs/developers/architecture/implementation-evidence/C03-postgres-recovery-observation-v301-results.json'),'utf8'));
  for(const [name,hash] of Object.entries(previous.sourceSha256))assert.equal(sha256(await readFile(join(root,name))),hash);
  report.v301SourcesUnchanged=Object.keys(previous.sourceSha256).length;
  const prior=JSON.parse(await readFile(join(root,'docs/developers/architecture/implementation-evidence/C03-postgres-transaction-lifecycle-v300-results.json'),'utf8'));
  report.v300SourcesUnchanged=[];
  for(const [name,hash] of Object.entries(prior.sourceSha256)){
    if(name===prefix+'postgres-recovery-operation-owner.wire.test.mjs')continue;
    assert.equal(sha256(await readFile(join(root,name))),hash);report.v300SourcesUnchanged.push(name);
  }
  t.after(async()=>{
    report.sourceSha256={};
    for(const name of ['scripts/db/diag/postgres-owned-cancellation.mjs','scripts/db/diag/postgres-owned-cancellation.test.mjs',prefix+'postgres-owned-cancellation.wire.test.mjs',prefix+'postgres-recovery-operation-owner.wire.test.mjs'])
      report.sourceSha256[name]=sha256(await readFile(join(root,name)));
    await writeFile(join(directory,'results.json'),JSON.stringify(report,null,2));
    for(const [name,hash] of Object.entries(before))assert.equal(sha256(await readFile(join(root,name))),hash,name+' untouched');
    t.diagnostic('owned cancellation report: '+directory);
  });
  const candidate=await buildOwnedCancellationCandidates(),repeat=await buildOwnedCancellationCandidates();report.candidate=candidate;report.repeatedDirectory=repeat.directory;
  for(const variant of ['esm','cjs','cf']){
    assert.equal(candidate.artifacts[variant].sha256,repeat.artifacts[variant].sha256);
    assert.deepEqual(candidate.artifacts[variant].inputs,repeat.artifacts[variant].inputs);
  }
  const old=await buildRetirementCandidates({lifecycle:'completed',writeFailure:'retire'});report.oldCandidate=old.directory;
  async function suite(name,paths,pass,fail=0,extra={},pattern){
    const env={...process.env,GATEWAY_POSTGRES_RECOVERY_DRIVER:'',GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION:'',GATEWAY_POSTGRES_SUPERVISION_MODULE:'',...extra};delete env.NODE_TEST_CONTEXT;
    const result=await exec(process.execPath,['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',...(pattern?['--test-name-pattern='+pattern]:[]),...paths],
      {cwd:root,env,timeout:45000,maxBuffer:512*1024,windowsHide:true}).then(value=>({...value,code:0}),error=>error);
    const output=(result.stdout??'')+(result.stderr??'');await writeFile(join(directory,name+'.tap'),output);
    assert.equal(result.code,fail?1:0,output);assert.match(output,new RegExp('# tests '+(pass+fail)+'\\b'));
    assert.match(output,new RegExp('# pass '+pass+'\\b'));assert.match(output,new RegExp('# fail '+fail+'\\b'));assert.match(output,/# cancelled 0\b/);
    report.tests[name]={pass,fail,expectedFailure:fail>0,durationMs:Number(output.match(/# duration_ms ([\d.]+)/)[1])};return output;
  }
  const regressions=['postgres-transaction-retirement','postgres-transaction-reservation','postgres-transaction-completion','postgres-write-failure'].map(name=>prefix+name+'.wire.test.mjs');
  for(const variant of ['esm','cjs']){
    const env={GATEWAY_POSTGRES_RECOVERY_DRIVER:candidate.artifacts[variant].path};
    await t.test(variant+' owned cancellation',()=>suite(variant+'-owned',[prefix+'postgres-owned-cancellation.wire.test.mjs'],28,0,env));
    await t.test(variant+' original lifecycle regression',()=>suite(variant+'-lifecycle',regressions,60,0,env));
    await t.test(variant+' ordinary cancel remains legacy',()=>suite(variant+'-legacy-cancel',[prefix+'postgres-cancel-observation.wire.test.mjs'],2,0,env));
    await t.test(variant+' old candidate actually pipelines the successor',async()=>{
      const output=await suite(variant+'-negative',[prefix+'postgres-owned-cancellation.wire.test.mjs'],0,1,{GATEWAY_POSTGRES_RECOVERY_DRIVER:old.artifacts[variant].path},'owned query is exclusive BEFORE');
      assert.match(output,/cancellable query must not pipeline its successor/);
    });
  }
  await t.test('installed cancellation baseline',()=>suite('installed-cancel',[prefix+'postgres-cancel-observation.wire.test.mjs'],2));
  await t.test('installed onclose negative remains',async()=>{
    const output=await suite('installed-onclose',[prefix+'postgres-recovery-operation-owner.wire.test.mjs'],2,1);
    assert.match(output,/Cannot read properties of null/);
  });
  await t.test('source owner, finite observation and unchanged financial SQL',()=>suite('source-sql',[
    prefix+'postgres-recovery-operation-owner.test.mjs',prefix+'supervise-usage-recovery-postgres.test.mjs',prefix+'usage-recovery.postgres.test.mjs'],62,0,
    {GATEWAY_PGLITE_MODULE:process.env.GATEWAY_PGLITE_MODULE||join(root,'.wrangler/staging/pg-schema-v250/package/dist/index.js'),GATEWAY_PG_FINANCIAL_BASELINE:''}));
  await t.test('recovery typecheck',async()=>{
    await exec(process.execPath,['node_modules/typescript/bin/tsc','--project','packages/core/tsconfig.recovery-runner-postgres.json','--noEmit'],{cwd:root,timeout:20000,maxBuffer:256*1024,windowsHide:true});
    report.typecheckExitCode=0;
  });
});
