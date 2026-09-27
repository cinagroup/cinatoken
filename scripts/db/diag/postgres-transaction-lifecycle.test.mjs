import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildRetirementCandidates, retireCompletedScopes, retireWriteFailures, sourcePins, sha256 } from './postgres-transaction-retirement.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url)),run=promisify(execFile);
const paths=['postgres-transaction-retirement','postgres-transaction-reservation','postgres-transaction-completion','postgres-write-failure']
  .map(name=>'packages/core/src/storage/recovery/'+name+'.wire.test.mjs');
const buildOptions={lifecycle:'completed',writeFailure:'retire'};

test('lifecycle transformations require original pinned sources and compatible options',async()=>{
  for(const [variant,pin] of Object.entries(sourcePins)){
    const index=await readFile(join(root,'node_modules/postgres',pin.entry),'utf8');
    const connection=await readFile(join(root,'node_modules/postgres',pin.entry.replace('index.js','connection.js')),'utf8');
    for(const [fn,value] of [[retireCompletedScopes,index],[retireWriteFailures,connection]]){
      assert.throws(()=>fn(value+'\n',variant),/Unsupported/);
      assert.throws(()=>fn(value,'unknown'),/Unsupported/);
      assert.throws(()=>fn(fn(value,variant),variant),/Unsupported/);
    }
  }
  await assert.rejects(buildRetirementCandidates({lifecycle:'unknown'}),/Unsupported/);
  await assert.rejects(buildRetirementCandidates({...buildOptions,reservation:'hook-only'}),/requires complete/);
});

test('pinned v300 candidate: dual branch lifecycle wire, reproducibility and old negatives',{timeout:45000},async t=>{
  const before={};
  const names=['package-lock.json','pnpm-lock.yaml','node_modules/postgres/package.json',
    ...Object.values(sourcePins).flatMap(pin=>['node_modules/postgres/'+pin.entry,'node_modules/postgres/'+pin.entry.replace('index.js','connection.js')])];
  for(const name of names)before[name]=sha256(await readFile(join(root,name)));
  t.after(async()=>{for(const name of names)assert.equal(sha256(await readFile(join(root,name))),before[name],name+' untouched');});
  const parent=join(root,'.wrangler/staging');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'postgres-lifecycle-v300-run-'));
  const report={directory,tests:{},before};
  t.after(async()=>{await writeFile(join(directory,'results.json'),JSON.stringify(report,null,2));t.diagnostic('lifecycle report: '+directory);});
  const built=await buildRetirementCandidates(buildOptions),repeated=await buildRetirementCandidates(buildOptions);
  report.candidate=built;report.repeatedDirectory=repeated.directory;
  for(const variant of ['esm','cjs','cf']){
    assert.equal(built.artifacts[variant].sha256,repeated.artifacts[variant].sha256);
    assert.deepEqual(built.artifacts[variant].inputs,repeated.artifacts[variant].inputs);
  }
  const legacy=await buildRetirementCandidates();report.legacyDirectory=legacy.directory;
  assert.equal(legacy.artifacts.esm.sha256,'9bdf3525f9697a1fd3f4f4af7727f66b3b70cd0a3b0c6ba100ea41afac2a0c2b');
  for(const variant of ['esm','cjs']){
    await t.test(variant+' complete 60-case wire suite',async()=>{
      const env={...process.env,GATEWAY_POSTGRES_RECOVERY_DRIVER:built.artifacts[variant].path,GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION:''};
      delete env.NODE_TEST_CONTEXT;
      try{
        const value=await run(process.execPath,['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',...paths],
          {cwd:root,env,timeout:18000,maxBuffer:512*1024,windowsHide:true});
        await writeFile(join(directory,variant+'.tap'),value.stdout+value.stderr);
        assert.match(value.stdout,/# tests 60\b/);assert.match(value.stdout,/# fail 0\b/);
        report.tests[variant]={pass:60,fail:0,durationMs:Number(value.stdout.match(/# duration_ms ([\d.]+)/)[1])};
      }catch(error){await writeFile(join(directory,variant+'.tap'),(error.stdout??'')+(error.stderr??''));t.diagnostic(error.stdout??'');throw error;}
    });
    await t.test(variant+' old candidate fails both actual lifecycle counterexamples',async()=>{
      const env={...process.env,GATEWAY_POSTGRES_RECOVERY_DRIVER:legacy.artifacts[variant].path,GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION:''};
      delete env.NODE_TEST_CONTEXT;
      const failure=await run(process.execPath,['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',
        '--test-name-pattern=completed commit rejects escaped unsafe|socket write fault accepted=true immediate=true',...paths.slice(2)],
        {cwd:root,env,timeout:10000,maxBuffer:256*1024,windowsHide:true}).then(()=>null,error=>error);
      assert.ok(failure,'legacy candidate must fail real counterexamples');
      await writeFile(join(directory,variant+'-negative.tap'),failure.stdout+failure.stderr);
      assert.equal(failure.code,1);assert.match(failure.stdout,/# tests 2\b/);assert.match(failure.stdout,/# fail 2\b/);
      assert.match(failure.stdout,/ended scope must not perform unsafe/);assert.match(failure.stdout,/failed bytes are not resent/);
      report.tests[variant+'-negative']={pass:0,fail:2,expected:true,durationMs:Number(failure.stdout.match(/# duration_ms ([\d.]+)/)[1])};
    });
  }
});
