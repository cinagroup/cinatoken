import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,writeFile,mkdir,mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { postgresCandidateAdoption } from './postgres-candidate-adoption.mjs';
import { sha256,sourcePins } from './postgres-transaction-retirement.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url)),exec=promisify(execFile);
test('v301 finite observation evidence: source/SQL, compiled Node, cancel wire, Workers compile, protected inputs',{timeout:60000},async t=>{
  await mkdir(join(root,'.wrangler/staging'),{recursive:true});
  const directory=await mkdtemp(join(root,'.wrangler/staging/postgres-observation-v301-'));
  const before={};
  const protectedPaths=['package-lock.json','pnpm-lock.yaml','node_modules/postgres/package.json','packages/core/package.json','packages/core/dist/index.js','packages/proxy/package.json','packages/proxy/wrangler.jsonc',
    ...Object.values(sourcePins).flatMap(pin=>['node_modules/postgres/'+pin.entry,'node_modules/postgres/'+pin.entry.replace('index.js','connection.js')])];
  for(const path of protectedPaths)before[path]=sha256(await readFile(join(root,path)));
  const report={directory,tests:{},artifacts:{},before,boundaries:{workersRuntime:false,nativePostgres:false,deployed:false}};
  const verify=async()=>{for(const [path,hash] of Object.entries(report.before))assert.equal(sha256(await readFile(join(root,path))),hash,path+' untouched');};
  await verify();t.after(async()=>{await writeFile(join(directory,'results.json'),JSON.stringify(report,null,2));await verify();t.diagnostic('observation report: '+directory);});
  async function suite(name,paths,expected,extra={}){
    const env={...process.env,GATEWAY_POSTGRES_RECOVERY_DRIVER:'',GATEWAY_POSTGRES_FACTORY_INITIALIZES_SESSION:'',GATEWAY_POSTGRES_SUPERVISION_MODULE:'',...extra};
    delete env.NODE_TEST_CONTEXT;
    const outcome=await exec(process.execPath,['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',...paths],{cwd:root,env,timeout:25000,maxBuffer:512*1024,windowsHide:true})
      .then(value=>({...value,code:0}),error=>error);
    await writeFile(join(directory,name+'.tap'),(outcome.stdout??'')+(outcome.stderr??''));
    assert.equal(outcome.code,0,outcome.stdout);assert.match(outcome.stdout,new RegExp('# tests '+expected+'\\b'));assert.match(outcome.stdout,/# fail 0\b/);
    report.tests[name]={pass:expected,fail:0,durationMs:Number(outcome.stdout.match(/# duration_ms ([\d.]+)/)[1])};
  }
  const prefix='packages/core/src/storage/recovery/';
  await t.test('source owner/supervisor and original financial SQL',()=>suite('source-sql',[
    prefix+'postgres-recovery-operation-owner.test.mjs',prefix+'supervise-usage-recovery-postgres.test.mjs',prefix+'usage-recovery.postgres.test.mjs'],62,
    {GATEWAY_PGLITE_MODULE:process.env.GATEWAY_PGLITE_MODULE||join(root,'.wrangler/staging/pg-schema-v250/package/dist/index.js'),GATEWAY_PG_FINANCIAL_BASELINE:''}));
  await t.test('unmodified driver cancellation evidence',()=>suite('installed-cancel',[prefix+'postgres-cancel-observation.wire.test.mjs'],2));
  for(const target of ['node','workers'])await t.test(target+' isolated entry and branch audit',async()=>{
    const adoption=await postgresCandidateAdoption({enabled:true,target});report.candidate??=adoption.candidate;
    const outfile=join(directory,target+'.mjs');
    const result=await build({stdin:{contents:"export { createPostgresRecoveryRun } from './packages/core/src/storage/recovery/run-usage-recovery-postgres.ts';\nexport { supervisePostgresRecoveryRun } from './packages/core/src/storage/recovery/supervise-usage-recovery-postgres.ts';",resolveDir:root,sourcefile:'observation-entry-v301.mjs'},
      bundle:true,write:true,metafile:true,format:'esm',platform:target==='node'?'node':'neutral',packages:'external',external:['node:*','cloudflare:*'],
      conditions:target==='workers'?['workerd','worker','browser']:['node'],outfile,plugins:adoption.plugins,logLevel:'silent'});
    await writeFile(join(directory,target+'-meta.json'),JSON.stringify(result.metafile,null,2));
    report.artifacts[target]={path:outfile,sha256:sha256(await readFile(outfile)),variants:Object.keys(result.metafile.inputs).filter(x=>x.startsWith('postgres-evaluation:'))};
    assert.deepEqual(report.artifacts[target].variants,['postgres-evaluation:'+(target==='node'?'esm':'cf')]);
    if(target==='node')await suite('compiled-supervisor',[prefix+'supervise-usage-recovery-postgres.test.mjs'],21,{GATEWAY_POSTGRES_SUPERVISION_MODULE:outfile});
  });
  for(const variant of ['esm','cjs'])await t.test(variant+' candidate cancellation proof',()=>suite(variant+'-cancel',[prefix+'postgres-cancel-observation.wire.test.mjs'],2,
    {GATEWAY_POSTGRES_RECOVERY_DRIVER:report.candidate.artifacts[variant].path}));
});
