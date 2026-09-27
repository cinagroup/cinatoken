import assert from 'node:assert/strict';
import test from 'node:test';
import { wireFixture, assertNoDispatch, assertWireSettled } from './images-wire-boundary-fixture.mjs';
import { IMAGE_CONTROL_MAX_CHARS } from '../../src/services/image-control-limits.ts';
import { parseImageUsageFromAnyShape, ImageUsageLimitError } from '../../src/services/egress/image-response-usage.ts';
import { normalizeOpenRouterImageResponse } from '../../src/services/egress/openai-images-driver.ts';

for(const [field,limit] of Object.entries(IMAGE_CONTROL_MAX_CHARS))test(`JSON ${field}: decoded limit before trim, then semantic validation`,async t=>{
  for(const extra of [0,1]){
    const f=await wireFixture(t);
    const value=(field==='model'?f.fixture.cases['small-generations'].model:field==='n'?'1':field==='size'?'1024x1024':field==='service_tier'?'default':'auto').padEnd(limit+extra,' ');
    assert.equal(value.length,limit+extra);
    const response=await f.json({[field]:value});
    if(extra)await assertNoDispatch(f,response,400,new RegExp(field+' must be at most '+limit+' characters'));
    else if(field==='service_tier')await assertNoDispatch(f,response,400,/service_tier must be one of/);
    else await assertWireSettled(f,response);
  }
});

for(const [profile,unit] of Object.entries({unicode:'💡',escaped:'"\\'}))test(`JSON quality ${profile}: UTF-16 rather than UTF-8 or wire escaping`,async t=>{
  for(const extra of [0,1]){
    const f=await wireFixture(t),value=unit.repeat(32)+'a'.repeat(extra);assert.equal(value.length,64+extra);
    if(extra)await assertNoDispatch(f,await f.json({quality:value}),400,/quality must be at most 64 characters/);
    else await assertWireSettled(f,await f.json({quality:value}));
  }
});

for(const [profile,unit] of Object.entries({ascii:'a',unicode:'💡',escaped:'"\\'}))test(`JSON property ${profile}: 256 decoded units accepted, 257 rejected`,async t=>{
  for(const extra of [0,1]){
    const f=await wireFixture(t),name=unit.repeat(256/unit.length)+'a'.repeat(extra);assert.equal(name.length,256+extra);
    if(extra)await assertNoDispatch(f,await f.json({[name]:0}),413,/property name characters/);
    else await assertWireSettled(f,await f.json({[name]:0}));
  }
});

test('JSON duplicate control last value wins, including escaped key spelling',async t=>{
  const accepted=await wireFixture(t);
  await assertWireSettled(accepted,await accepted.json(body=>JSON.stringify(body).slice(0,-1)+',"quality":"'+ 'a'.repeat(65)+'","qual\\u0069ty":"auto"}'));
  const rejected=await wireFixture(t);
  await assertNoDispatch(rejected,await rejected.json(body=>JSON.stringify(body).slice(0,-1)+',"quality":"auto","qual\\u0069ty":"'+ 'a'.repeat(65)+'"}'),400,/quality must be at most 64 characters/);
});
test('JSON overwritten oversized property names still consume lexical admission',async t=>{
  const f=await wireFixture(t);
  await assertNoDispatch(f,await f.json(body=>JSON.stringify(body).slice(0,-1)+',"discard":{"'+ 'a'.repeat(257)+'":0},"discard":0}'),413,/property name characters/);
});

for(const [profile,unit] of Object.entries({ascii:' ',unicode:'\u2000',escaped:'\n'}))test(`JSON provider ${profile}: compact UTF-8 16384 accepted, 16385 rejected`,async t=>{
  const stem='unused-provider',overhead=Buffer.byteLength(JSON.stringify({ignore:[stem]})),cost=Buffer.byteLength(JSON.stringify(unit))-2;
  const remaining=16384-overhead,value=stem+unit.repeat(Math.floor(remaining/cost))+' '.repeat(remaining%cost);
  for(const extra of [0,1]){
    const f=await wireFixture(t),provider={ignore:[value+' '.repeat(extra)]};assert.equal(Buffer.byteLength(JSON.stringify(provider)),16384+extra);
    if(extra)await assertNoDispatch(f,await f.json({provider}),400,/provider must be at most 16384 JSON bytes/);
    else await assertWireSettled(f,await f.json({provider}));
  }
});

test('multipart single field: 65536 UTF-8 bytes accepted, 65537 rejected',async t=>{
  for(const extra of [0,1]){
    const f=await wireFixture(t),response=await f.multipart([['unused','a'.repeat(65536+extra)]]);
    if(extra)await assertNoDispatch(f,response,413,/Multipart field exceeds/);else await assertWireSettled(f,response);
  }
});
test('multipart cumulative fields include model and prompt: 131072 bytes accepted, +1 rejected',async t=>{
  for(const extra of [0,1]){
    const f=await wireFixture(t),response=await f.multipart(fields=>{
      const fixed=Object.values(fields).reduce((n,v)=>n+Buffer.byteLength(v),0),second=131072-fixed-65536+extra;
      assert.ok(second<=65536);return[['unusedA','a'.repeat(65536)],['unusedB','b'.repeat(second)]];
    });
    if(extra)await assertNoDispatch(f,response,413,/Multipart fields exceed/);else await assertWireSettled(f,response);
  }
});
test('multipart part count includes model, prompt and image: 64 accepted, 65 rejected',async t=>{
  for(const extra of [0,1]){
    const f=await wireFixture(t),response=await f.multipart(Array.from({length:61+extra},(_,i)=>['unused'+i,'a']));
    if(extra)await assertNoDispatch(f,response,413,/Too many multipart parts/);else await assertWireSettled(f,response);
  }
});
test('multipart 257-character property is governed by envelope, not JSON key limit',async t=>{
  const f=await wireFixture(t);await assertWireSettled(f,await f.multipart([['a'.repeat(257),'x']]));
});
for(const [profile,unit] of Object.entries({ascii:' ',unicode:'\u2000'}))test(`multipart provider ${profile}: 16384 decoded characters and separate field-byte limit`,async t=>{
  const head='{"ignore":["unused-provider',tail='"]}',value=head+unit.repeat(16384-head.length-tail.length)+tail;
  assert.equal(value.length,16384);assert.ok(Buffer.byteLength(value)<65536);
  for(const extra of [0,1]){
    const f=await wireFixture(t),response=await f.multipart([['provider',value+' '.repeat(extra)]]);
    if(extra)await assertNoDispatch(f,response,400,/provider must be at most 16384 characters/);else await assertWireSettled(f,response);
  }
});

function usageAt(bytes,profile){
  const aliases=profile==='aliases',unit=profile==='unicode'?'圖💡':profile==='escaped'?'"\\':'a';
  const usage={...(aliases?{prompt_tokens:3,completion_tokens:7}:{input_tokens:3,output_tokens:7}),total_tokens:10,opaque:'private-wire-usage'};
  const normalized=u=>({...u,input_tokens:3,output_tokens:7,prompt_tokens:3,completion_tokens:7});
  const remaining=bytes-Buffer.byteLength(JSON.stringify(normalized(usage))),cost=Buffer.byteLength(JSON.stringify(unit))-2;
  usage.opaque+=unit.repeat(Math.floor(remaining/cost))+'a'.repeat(remaining%cost);
  assert.equal(Buffer.byteLength(JSON.stringify(normalized(usage))),bytes);
  return usage;
}
for(const operation of ['generations','edits'])for(const profile of ['ascii','unicode','escaped','aliases'])test(`${operation} usage ${profile}: 65536 normalized bytes accepted, +1 settles unknown without replay`,async t=>{
  for(const extra of [0,1]){
    const body={data:[{b64_json:'AQID'}],usage:usageAt(65536+extra,profile)};
    const normalized=normalizeOpenRouterImageResponse(body);
    if(extra)assert.throws(()=>parseImageUsageFromAnyShape(normalized),ImageUsageLimitError);
    else assert.equal(Buffer.byteLength(parseImageUsageFromAnyShape(normalized).raw_usage),65536);
    const f=await wireFixture(t,{upstreamBody:body});
    const observed=await assertWireSettled(f,await(operation==='edits'?f.multipart():f.json()),extra?502:200);
    if(extra){assert.equal(observed.body.error.message,'Upstream provider is unavailable');assert.equal(observed.snapshot.value.params.requestLog.rawUsage,null);assert.equal(JSON.stringify(observed.body).includes('private-wire-'),false);}
    else {const usage=JSON.parse(observed.snapshot.value.params.requestLog.rawUsage);assert.equal(usage.total_tokens,10);assert.equal(Object.keys(usage).length,6);}
    t.diagnostic(JSON.stringify({operation,profile,kind:'usage',bytes:65536+extra,status:observed.status,account:f.account(),sends:f.sends}));
  }
});
for(const operation of ['generations','edits'])for(const [profile,unit] of Object.entries({ascii:'a',unicode:'💡',escaped:'"\\'}))test(`${operation} upstream property ${profile}: decoded 256/+1 and durable unknown outcome`,async t=>{
  for(const extra of [0,1]){
    const name=unit.repeat(256/unit.length)+'a'.repeat(extra),body={data:[{b64_json:'AQID'}],usage:{input_tokens:3,output_tokens:7,total_tokens:10},[name]:0};
    const f=await wireFixture(t,{upstreamBody:body});
    const observed=await assertWireSettled(f,await(operation==='edits'?f.multipart():f.json()),extra?502:200);
    if(extra){assert.equal(observed.body.error.message,'Upstream provider is unavailable');assert.equal(observed.snapshot.value.params.requestLog.rawUsage,null);}
    t.diagnostic(JSON.stringify({operation,profile,kind:'upstream-property',units:256+extra,status:observed.status,account:f.account(),sends:f.sends}));
  }
});
