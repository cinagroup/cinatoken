import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
const repo='C:/cinagroup/cinatoken';
const require=createRequire(path.join(repo,'package.json'));
const acorn=require('acorn'), yaml=require('yaml');
const {convertV4MiniflareOptions,Log,LogLevel}=require('miniflare');
const dir=path.join(repo,'scripts/diagnostics/v364-direct-socket');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=fs.readFileSync(path.join(dir,'run-direct-socket.mjs'),'utf8');
const old=fs.readFileSync(path.join(repo,'scripts/diagnostics/v364-owned-linux-boundary/run-boundary.mjs'),'utf8');
const parsed=acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'});
const oldParsed=acorn.parse(old,{ecmaVersion:'latest',sourceType:'module'});
const checks=[]; const check=(name,run)=>{run();checks.push({name,actualOutcome:0});};
const fn=(tree,name)=>tree.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);
const canonical=value=>JSON.parse(JSON.stringify(value,(key,item)=>['start','end','loc','raw'].includes(key)?undefined:item));
for(const name of ['httpClient','observedGet','disposeFixture','bounded']) check('original-'+name+'-AST-preserved',()=>assert.deepEqual(canonical(fn(parsed,name)),canonical(fn(oldParsed,name))));
check('original-cancellation-assertions-and-window-AST-preserved',()=>{
 const now=canonical(fn(parsed,'cancellationCase')),before=canonical(fn(oldParsed,'cancellationCase'));
 const result=now.body.body.find(n=>n.type==='VariableDeclaration'&&n.declarations[0].id.name==='result').declarations[0].init;
 assert.deepEqual(result.properties.filter(p=>['directSocket','coreEntryBypassed'].includes(p.key.name)).map(p=>[p.key.name,p.value.value]),[['directSocket',true],['coreEntryBypassed',true]]);
 result.properties=result.properties.filter(p=>!['directSocket','coreEntryBypassed'].includes(p.key.name));
 assert.deepEqual(now,before);
});
const input=JSON.parse(fs.readFileSync(path.join(dir,'source-inputs.json'),'utf8'));
check('protected-source-Git-bytes-exact',()=>{
 for(const row of input.files){const current=fs.readFileSync(path.join(repo,row.path)),blob=execFileSync('git',['show','HEAD:'+row.path],{cwd:repo,maxBuffer:8*1024*1024});
  assert.equal(current.length,row.bytes);assert.equal(sha(current),row.sha256);assert.deepEqual(current,blob);}
});
check('installed-direct-socket-source-exact',()=>{for(const row of input.installedFiles){const b=fs.readFileSync(path.join(repo,row.path));assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);}});
check('only-original-runtime-flags',()=>{assert.equal(source.includes('request_signal_passthrough'),false);assert.equal(source.includes('compatibilityFlags: holderConfig.compatibility_flags'),true);});
check('actual-V4-option-schema-direct-socket-bare-and-binding',()=>{
 for(const kind of ['bare','binding','native-reader']){
  let captured;
  const context={phase:()=>{},holderConfig:{kv_namespaces:[{id:'qa-observations'}],name:'qa-holder',compatibility_flags:['nodejs_compat','enable_request_signal']},gatewayConfig:{name:'qa-gateway'},bundles:{bare:'bare',nativeReader:'native',observedGateway:'gateway',observedHolder:'holder'},CaptureLog:class extends Log { constructor(){super(LogLevel.DEBUG);} },convertV4MiniflareOptions,
   Miniflare:class{constructor(value){captured=value;}},active:new Map(),event:()=>{}};
  vm.createContext(context);const create=fn(parsed,'createFixture');vm.runInContext(source.slice(create.start,create.end),context);vm.runInContext('createFixture("inert-schema",'+JSON.stringify(kind)+')',context);
  assert.ok(captured.workers.length=== (kind==='binding'?2:1));
  assert.deepEqual(JSON.parse(JSON.stringify(captured.workers[0].dev.unsafeDirectSockets)),[{host:'127.0.0.1',port:0}]);
  for(const worker of captured.workers) assert.deepEqual(JSON.parse(JSON.stringify(worker.config.compatibilityFlags)),['nodejs_compat','enable_request_signal']);
  if(kind==='binding') assert.equal(captured.workers[1].dev.unsafeDirectSockets,undefined);
 }
});
check('native-calibration-adds-no-lifetime-task',()=>{
 const text=fs.readFileSync(path.join(dir,'native-reader-calibration.mjs'),'utf8');const ast=acorn.parse(text,{ecmaVersion:'latest',sourceType:'module'});let wait=0,cancel=0;
 const visit=n=>{if(!n||typeof n!=='object')return;if(n.type==='CallExpression'&&n.callee?.type==='MemberExpression'){if(n.callee.property.name==='waitUntil')wait++;if(n.callee.object.name==='reader'&&n.callee.property.name==='cancel')cancel++;}for(const value of Object.values(n))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);};visit(ast);assert.equal(wait,0);assert.equal(cancel,1);assert.equal(text.includes("import holder from"),true);
});
check('workflow-is-manual-bounded-readonly-and-retains-failures',()=>{
 const value=yaml.parse(fs.readFileSync(path.join(repo,'.github/workflows/v364-direct-socket.yml'),'utf8'));
 assert.deepEqual(value.on,{workflow_dispatch:null});assert.deepEqual(value.permissions,{contents:'read'});assert.equal(value.concurrency['cancel-in-progress'],false);
 const job=value.jobs['direct-socket-cancellation'];assert.equal(job['timeout-minutes'],10);assert.equal(job.steps[0].with['persist-credentials'],false);
 const run=job.steps.find(s=>s.run?.includes('execute-owned-linux.py'));assert.equal(run['timeout-minutes'],7);assert.equal(run['continue-on-error'],undefined);
 const upload=job.steps.find(s=>s.uses==='actions/upload-artifact@v4');assert.equal(upload.if,'${{ always() }}');assert.equal(upload.with['include-hidden-files'],true);assert.equal(upload.with['if-no-files-found'],'error');
});
check('original-baseline-zero-required-for-aggregate-zero',()=>assert.match(source,/baseline\?\.code === 0/u));
check('preparation-executed-no-runtime',()=>{const report=JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')),'prepared-only/prepare-only.json'),'utf8'));assert.equal(report.actualExit,0);assert.equal(report.runtimeExecuted,false);assert.equal(report.sourceUnchanged,true);assert.equal(report.bundleHashes.length,6);});
console.log(JSON.stringify({schema:'v364-direct-local-contract-audit-v1',closed:true,actualOutcome:0,checks,realRuntimeExecuted:false,fixtureRuntimeTestsExecuted:false,productionRequests:0},null,2));
