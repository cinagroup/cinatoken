import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import worker, { createCompleteTextHolderWorkerV390 } from './complete-text-holder-worker-v390.ts';

const url='https://holder.service.invalid/complete-text-attempt';
const envelope={requestId:'owned-v390',quoteId:'11111111-1111-4111-8111-111111111111',
  attemptNonce:'22222222-2222-4222-8222-222222222222',candidateIndex:0,
  routeTargetId:'route-v390',finalBodyUtf8:'{"model":"test","models":["test"],"messages":[]}'};
function context(){const tasks=[];return {tasks,waitUntil(task){tasks.push(task);}};}
function request(body=JSON.stringify(envelope),headers={}){
  return new Request(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
}

test('v390 config is disabled and private with only four named Hyperdrives and one required KEK',async()=>{
  const config=JSON.parse(await readFile(new URL('../../wrangler.complete-text-holder-v390.jsonc',import.meta.url),'utf8'));
  assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
  assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers,{crons:[]});
  assert.equal(config.vars.COMPLETE_TEXT_HOLDER_ENABLED,'disabled');
  assert.deepEqual(config.secrets,{required:['PROVIDER_KEY_ENCRYPTION_SECRET']});
  assert.deepEqual(config.hyperdrive.map(item=>item.binding),[
    'COMPLETE_TEXT_READER','COMPLETE_TEXT_GRANTER','COMPLETE_TEXT_HOLDER','COMPLETE_TEXT_RENEWER']);
  assert.equal(new Set(config.hyperdrive.map(item=>item.id)).size,4);
  for(const binding of ['services','d1_databases','kv_namespaces','r2_buckets','queues','assets'])
    assert.equal(config[binding],undefined);
  const bundled=await build({entryPoints:[fileURLToPath(new URL('./complete-text-holder-worker-v390.ts',import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true,
    conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*',...builtinModules]});
  assert.equal(bundled.outputFiles.length,1);
  assert.ok(!Object.keys(bundled.metafile.inputs).some(path=>/proxy\/src\/(app\.ts|runtime\/workers\.ts|routes\/)/u.test(path)));
  assert.match(bundled.outputFiles[0].text,/createObservedPrivateCompleteTextHolderV384/u);
});

test('default-off request cancels unused upload and never reads role or KEK bindings',async()=>{
  let cancelled=0;
  const body=new ReadableStream({cancel(){cancelled++;}});
  const ctx=context();
  const env={COMPLETE_TEXT_HOLDER_ENABLED:'disabled',
    get COMPLETE_TEXT_READER(){throw new Error('role must not be read');},
    get PROVIDER_KEY_ENCRYPTION_SECRET(){throw new Error('KEK must not be read');}};
  const response=await worker.fetch(new Request(url,{method:'POST',body,duplex:'half'}),env,ctx);
  assert.equal(response.status,503);await Promise.all(ctx.tasks);
  assert.equal(cancelled,1);
  assert.deepEqual(await response.json(),{error:'holder_request_unavailable'});
});

test('fixed route/content type/UTF8/six-field validation rejects before any private DB binding access',async()=>{
  const env={COMPLETE_TEXT_HOLDER_ENABLED:'reviewed-v1',get COMPLETE_TEXT_READER(){throw new Error('unexpected DB access');}};
  const cases=[
    [new Request('https://foreign.invalid/complete-text-attempt',{method:'POST',body:'{}'}),404],
    [new Request(url+'?providerUrl=https://foreign.invalid',{method:'POST',body:'{}'}),404],
    [new Request(url),404],
    [request('{}',{'Content-Type':'text/plain'}),415],
    [request(JSON.stringify({...envelope,providerUrl:'https://foreign.invalid'})),400],
    [request(JSON.stringify({...envelope,providerSecret:'caller-selected-secret'})),400],
    [request(JSON.stringify({...envelope,role:'cinatoken_gateway_migrator'})),400],
    [request(JSON.stringify({...envelope,candidateIndex:8})),400],
    [request(new Uint8Array([0xff,0xfe])),400],
    [request('{}',{'Content-Length':String(6*1_048_576+8_193)}),413],
    [request('{'),400],
  ];
  for(const [input,status]of cases){
    const ctx=context();const response=await worker.fetch(input,env,ctx);
    assert.equal(response.status,status);await Promise.all(ctx.tasks);
    assert.deepEqual(await response.json(),{error:'holder_request_unavailable'});
  }
});

test('actual oversized streamed envelope is cancelled at the bounded reader',async()=>{
  let cancelled=0;
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1_048_576));},cancel(){cancelled++;}});
  const ctx=context();
  const response=await worker.fetch(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'}),
    {COMPLETE_TEXT_HOLDER_ENABLED:'reviewed-v1'},ctx);
  assert.equal(response.status,413);await Promise.all(ctx.tasks);assert.equal(cancelled,1);
});

test('caller cancellation while upload stalls cancels body and drains its actual completion',async()=>{
  let cancelled=0;const abort=new AbortController();const ctx=context();
  const body=new ReadableStream({cancel(){cancelled++;}});
  const result=worker.fetch(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},
    body,duplex:'half',signal:abort.signal}),{COMPLETE_TEXT_HOLDER_ENABLED:'reviewed-v1'},ctx);
  abort.abort();const response=await result;
  assert.equal(response.status,499);await Promise.all(ctx.tasks);assert.equal(cancelled,1);
});

test('private entry deadline stops a stalled upload without starting the DB chain',async()=>{
  let cancelled=0;const ctx=context();
  const body=new ReadableStream({cancel(){cancelled++;}});
  const local=createCompleteTextHolderWorkerV390({maxRequestMs:25});
  const response=await local.fetch(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'}),
    {COMPLETE_TEXT_HOLDER_ENABLED:'reviewed-v1'},ctx);
  assert.equal(response.status,504);await Promise.all(ctx.tasks);assert.equal(cancelled,1);
});

test('incomplete private binding set rejects before opening any database connection',async()=>{
  const ctx=context();
  const response=await worker.fetch(request(),{COMPLETE_TEXT_HOLDER_ENABLED:'reviewed-v1',
    COMPLETE_TEXT_READER:{connectionString:'postgres://cinatoken_gateway_migrator:fake@127.0.0.1:9/postgres?sslmode=disable'},
  },ctx);
  assert.equal(response.status,502);await Promise.all(ctx.tasks);
  assert.deepEqual(await response.json(),{error:'holder_request_unavailable'});
});

test('local options can shorten but cannot extend execution or renewal bounds',()=>{
  assert.throws(()=>createCompleteTextHolderWorkerV390({maxRequestMs:300_001}));
  assert.throws(()=>createCompleteTextHolderWorkerV390({maxUnrenewedStreamMs:14*60_000+1}));
});
