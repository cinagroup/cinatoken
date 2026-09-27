import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as esbuild from 'esbuild';
import { buildSharedEarningScannerConfig } from './gen-shared-earning-scanner-wrangler.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const base=JSON.parse(readFileSync(resolve(root,
  'packages/proxy/wrangler.shared-earning-scanner.base.jsonc'),'utf8'));
const deliveryId='11111111-2222-4333-8444-555555555555';
const consumerId='22222222-3333-4444-8555-666666666666';
const runtimeId='33333333-4444-4555-8666-777777777777';
const environment={SHARED_EARNING_SCANNER_ENABLED:'dedicated-v1',
  EARNING_DELIVERY_HYPERDRIVE_ID:deliveryId,
  EARNING_CONSUMER_HYPERDRIVE_ID:consumerId};
const http=[{name:'cinatoken-proxy',main:'src/index.ts',
  hyperdrive:[{binding:'HYPERDRIVE',id:runtimeId}]},
{name:'cinatoken-admin',main:'app/index.ts',
  hyperdrive:[{binding:'HYPERDRIVE',id:runtimeId}]},
{name:'cinatoken-chain-worker',main:'src/index.ts',
  hyperdrive:[{binding:'HYPERDRIVE',id:runtimeId}]}];

function cliFixture(){
  const staging=resolve(root,'.wrangler/staging');
  mkdirSync(staging,{recursive:true});
  const workspace=mkdtempSync(resolve(staging,'shared-earning-scanner-cli-test-'));
  const generator='scripts/deploy/gen-shared-earning-scanner-wrangler.mjs';
  mkdirSync(resolve(workspace,'scripts/deploy'),{recursive:true});
  copyFileSync(resolve(root,generator),resolve(workspace,generator));
  for(const [index,name] of ['proxy','admin','chain-worker'].entries()){
    mkdirSync(resolve(workspace,'packages',name),{recursive:true});
    writeFileSync(resolve(workspace,'packages',name,'wrangler.jsonc'),JSON.stringify(http[index])+'\n');
  }
  copyFileSync(resolve(root,'packages/proxy/wrangler.shared-earning-scanner.base.jsonc'),
    resolve(workspace,'packages/proxy/wrangler.shared-earning-scanner.base.jsonc'));
  const output=resolve(workspace,'packages/proxy/wrangler.shared-earning-scanner.jsonc');
  writeFileSync(output,'existing fixture output\n');
  return {output,run:args=>spawnSync(process.execPath,[generator,...args],
    {cwd:workspace,encoding:'utf8',env:{...process.env,...environment,
      SHARED_EARNING_SCANNER_WORKER_NAME:base.name}})};
}

test('separate scheduled config contains only two earning authorities and no HTTP surface',()=>{
  const config=buildSharedEarningScannerConfig(environment,http,base);
  assert.equal(config.name,'cinatoken-shared-earning-scanner-review');
  assert.equal(config.main,'src/runtime/shared-earning-scanner-worker.ts');
  assert.equal(config.workers_dev,false);
  assert.deepEqual(config.triggers,{crons:['17 * * * *']});
  assert.deepEqual(config.vars,{SHARED_EARNING_SCANNER_ENABLED:'dedicated-v1'});
  assert.deepEqual(config.hyperdrive,[
    {binding:'EARNING_DELIVERY_HYPERDRIVE',id:deliveryId},
    {binding:'EARNING_CONSUMER_HYPERDRIVE',id:consumerId}]);
  for(const key of ['routes','d1_databases','services','queues','r2_buckets','secrets'])
    assert.equal(config[key],undefined,key);
  assert.equal(config.hyperdrive.some(binding=>binding.binding==='HYPERDRIVE'),false);
  assert.equal(http[0].hyperdrive.length,1);
});

test('general HTTP Worker handler has no scanner dispatch edge',()=>{
  const handler=readFileSync(resolve(root,
    'packages/proxy/src/runtime/worker-handler.ts'),'utf8');
  assert.doesNotMatch(handler,/postgres-shared-earning-scanner|runWorkerSharedEarningScanner|EARNING_(?:DELIVERY|CONSUMER)_HYPERDRIVE/u);
});

test('bundle graph isolates scanner code from general HTTP entry',async()=>{
  const result=await esbuild.build({
    entryPoints:[resolve(root,'packages/proxy/src/index.ts'),
      resolve(root,'packages/proxy/src/runtime/shared-earning-scanner-worker.ts')],
    bundle:true,platform:'browser',format:'esm',packages:'external',
    write:false,metafile:true,outdir:resolve(root,'packages/proxy/.scanner-build-check'),
  });
  const outputs=Object.values(result.metafile.outputs).filter(output=>output.entryPoint);
  const httpBundle=outputs.find(output=>output.entryPoint.endsWith('/src/index.ts'));
  const scannerBundle=outputs.find(output=>output.entryPoint.endsWith(
    '/src/runtime/shared-earning-scanner-worker.ts'));
  assert.ok(httpBundle);
  assert.ok(scannerBundle);
  assert.equal(Object.keys(httpBundle.inputs).some(path=>path.endsWith(
    '/postgres-shared-earning-scanner.ts')),false);
  assert.equal(Object.keys(scannerBundle.inputs).some(path=>path.endsWith(
    '/postgres-shared-earning-scanner.ts')),true);
  assert.equal(Object.keys(scannerBundle.inputs).some(path=>path.endsWith(
    '/worker-handler.ts')),false);
});

test('generator rejects credential alias, HTTP exposure and hostile base config',()=>{
  for(const [label,env,configs,template,expected] of [
    ['disabled',{},http,base,/activation/],
    ['old activation',{...environment,SHARED_EARNING_SCANNER_ENABLED:'reviewed-v1'},http,base,/activation/],
    ['missing delivery',{...environment,EARNING_DELIVERY_HYPERDRIVE_ID:''},http,base,/canonical/],
    ['duplicate financial ID',{...environment,EARNING_CONSUMER_HYPERDRIVE_ID:deliveryId},http,base,/must differ/],
    ['reused HTTP origin',{...environment,EARNING_DELIVERY_HYPERDRIVE_ID:runtimeId},http,base,/already bound/],
    ['existing proxy financial binding',environment,
      [{...http[0],hyperdrive:[...http[0].hyperdrive,
        {binding:'EARNING_CONSUMER_HYPERDRIVE',id:consumerId}]},http[1],http[2]],base,
      /already has earning scanner authority/],
    ['existing proxy activation',environment,
      [{...http[0],vars:{SHARED_EARNING_SCANNER_ENABLED:'reviewed-v1'}},http[1],http[2]],base,
      /already has earning scanner authority/],
    ['route in base',environment,http,{...base,routes:[{pattern:'api.example/*'}]},/base configuration differs/],
    ['Queue in base',environment,http,{...base,queues:{}},/base configuration differs/],
    ['unknown authority in base',environment,http,{...base,unsafe:{binding:'SECRET'}},
      /base configuration differs/],
    ['existing chain financial binding',environment,
      [http[0],http[1],{...http[2],hyperdrive:[...http[2].hyperdrive,
        {binding:'EARNING_DELIVERY_HYPERDRIVE',id:deliveryId}]}],base,
      /already has earning scanner authority/],
    ['same worker name',{...environment,SHARED_EARNING_SCANNER_WORKER_NAME:'cinatoken-proxy'},http,base,
      /name is invalid or reused/],
  ]){
    assert.throws(()=>buildSharedEarningScannerConfig(env,configs,template),expected,label);
  }
});

test('print mode validates isolated generated HTTP configs without writing',()=>{
  const fixture=cliFixture(),before=statSync(fixture.output).mtimeMs;
  const bytes=readFileSync(fixture.output);
  const result=fixture.run(['--print']);
  assert.equal(result.status,0,result.stderr);
  const config=JSON.parse(result.stdout);
  assert.deepEqual(config.hyperdrive,[
    {binding:'EARNING_DELIVERY_HYPERDRIVE',id:deliveryId},
    {binding:'EARNING_CONSUMER_HYPERDRIVE',id:consumerId}]);
  assert.equal(statSync(fixture.output).mtimeMs,before);
  assert.deepEqual(readFileSync(fixture.output),bytes);
});

test('default CLI invocation writes no activated scanner config',()=>{
  const fixture=cliFixture(),before=statSync(fixture.output).mtimeMs;
  const bytes=readFileSync(fixture.output);
  const result=fixture.run([]);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Use --print or --write/);
  assert.equal(statSync(fixture.output).mtimeMs,before);
  assert.deepEqual(readFileSync(fixture.output),bytes);
});
