import assert from'node:assert/strict';import{createRequire}from'node:module';
import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';
import{command,file,success,out,repo,info}from'./capture.mjs';
const authority=JSON.parse(await readFile(join(out,'initial-authority.json'),'utf8'));
const tail=JSON.parse(await readFile(join(out,'tail-source-history.json'),'utf8'));
const terminal=JSON.parse(await readFile(join(out,'parent-terminal-final.stdout.log'),'utf8'));
const targets=[
 {step:94,pinCommit:'94c12c1e37e7346330486cf9a3a3246af00d95c5',target:authority.source,wrapper:authority.wrapper,
  pin:'603646803c82d3209987260ad682a34169b4e53ca7b03b672d818e3a28d7cc13',currentLabel:'base-source',oldLabel:'pin-introduction-source',variable:'names'},
 {step:109,pinCommit:'63e305a1bdf14c55fede74fb7ff9cbd9f732fc19',target:tail.pins[1].target,
  wrapper:'scripts/db/cutover/postgres-replay-reservations-backend-lifecycle-successor.native.test.mjs',
  pin:tail.pins[1].pin,currentLabel:'source-step-109',oldLabel:'pin-original-source-109',variable:'files'}
];
const jobs=[
 ['pin-original-source-109',['show',targets[1].pinCommit+':'+targets[1].target]],
 ['pin-original-wrapper-109',['show',targets[1].pinCommit+':'+targets[1].wrapper]],
 ['pre-web-source-109',['show','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b^:'+targets[1].target]],
 ['pin-current-ancestry-109',['log',authority.base,'-G',targets[1].pin,'--format=%H%x09%ai%x09%s','--',targets[1].wrapper]],
 ['pin-original-source-99',['show','f6586260e6e0274902cb7569135d3550c89fdabd:'+tail.pins[0].target]],
 ['original-lineage-blobs',['rev-parse',...targets.flatMap(t=>[t.pinCommit+':'+t.target,authority.base+':'+t.target,authority.base+':'+t.wrapper])]],
 ['protected-fixtures-status',['status','--short','--',...targets.flatMap(t=>[t.target,t.wrapper]),tail.pins[0].target]]
];
const reads=await Promise.allSettled(jobs.map(async([label,args])=>({label,bytes:success(await command(label,'git',args))})));
for(const r of reads)if(r.status==='rejected')throw r.reason;
const ts=createRequire(join(repo,'package.json'))('typescript'),proofs=[];
function selected(text,path){const ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(ast.parseDiagnostics.length,0);const r={assertions:[],templates:[],sqlAndTransactions:[],cleanup:[],conditions:[],nativeOptions:[]};
 function visit(n){if(ts.isCallExpression(n)){
  const e=n.expression.getText(ast);if(/^assert\./.test(e))r.assertions.push(n.getText(ast));
  if(/\.(unsafe|begin)$/.test(e))r.sqlAndTransactions.push(n.getText(ast));
  if(/\.(cleanup|end|stop)$/.test(e))r.cleanup.push(n.getText(ast));
  if(e==='test'&&n.arguments[1])r.nativeOptions.push(n.arguments[1].getText(ast));
 }if(ts.isTemplateExpression(n)||ts.isNoSubstitutionTemplateLiteral(n))r.templates.push(n.getText(ast));
 if(ts.isIfStatement(n))r.conditions.push(n.expression.getText(ast));ts.forEachChild(n,visit)}visit(ast);return r;
}
for(const t of targets){
 const current=await readFile(join(out,t.currentLabel+'.stdout.log')),old=await readFile(join(out,t.oldLabel+'.stdout.log'));
 assert.equal(info(old).sha256,t.pin);
 let reverse=current.toString('utf8');const ops=[
  ["import { readFile, writeFile } from 'node:fs/promises';", "import { readFile, readdir, writeFile } from 'node:fs/promises';",1],
  ["import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';", "import { grantPostgresRuntime } from './grant-postgres-runtime.ts';",1],
  [`const ${t.variable} = await listPg73Migrations();`, `const ${t.variable} = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();`,1],
  ['await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });','await grantPostgresRuntime({ DATABASE_URL: migratorUrl });',2]
 ];
 for(const [from,to,count]of ops){assert.equal(reverse.split(from).length-1,count);reverse=reverse.replaceAll(from,to)}
 assert.deepEqual(Buffer.from(reverse),old,'Whole-source historical reversal exact for '+t.step);
 const oldSelected=selected(old.toString(),t.target),currentSelected=selected(current.toString(),t.target);
 assert.deepEqual(currentSelected,oldSelected,'Original assertion/SQL/options preservation for '+t.step);
 const currentWorking=await file('working-legacy-'+t.step,join(repo,t.target));assert.equal(currentWorking.receipt.actualExit,0);assert.deepEqual(currentWorking.stdout,current);
 proofs.push({...t,old:info(old),current:info(current),reverseBytesExact:true,
  onlyChanges:ops.map(([current,original,occurrences])=>({current,original,occurrences})),
  allOriginalSelectedSourceExact:true,counts:Object.fromEntries(Object.entries(oldSelected).map(([k,v])=>[k,v.length])),
  preservedSelectedSourcesSha256:info(Buffer.from(JSON.stringify(oldSelected))).sha256});
 console.log('proof',JSON.stringify(proofs.at(-1)));
}
assert.deepEqual(await readFile(join(out,'pin-original-source-99.stdout.log')),await readFile(join(out,'source-step-99.stdout.log')));
const raw=await readFile(join(out,'actual-native-raw.stdout.log'));
assert.deepEqual(info(raw),{bytes:556674,sha256:'c78e11593edf9b694d5a490647fd37f4863aa44f22be14d367e592975dbb8d28'});
assert.equal(tail.originalReceipt.actualExit,0);assert.equal(tail.originalReceipt.signal,null);assert.equal(tail.originalReceipt.spawnError,null);
assert.deepEqual(tail.originalReceipt.stdoutInfo,info(raw));
const group=await file('actual-step94-group',terminal.verdict.nextActualNativeFailure.group.file);
assert.equal(group.receipt.actualExit,0);assert.deepEqual(info(group.stdout),{bytes:9949,sha256:'891ba26d3b0605270c2b65aa7f3d21b6b1d19728c25643f7e515ef80de3fbed1'});
assert.match(group.stdout.toString(),/187:14/);assert.ok(group.stdout.toString().includes(targets[0].pin));assert.ok(group.stdout.toString().includes(info(await readFile(join(out,'base-source.stdout.log'))).sha256));
const proof={at:new Date().toISOString(),actualExit:0,baseCommit:authority.base,sourceProofs:proofs,
  step99CurrentAndOriginalPinBytesExact:true,actualStep94:terminal.verdict.nextActualNativeFailure,
  actualStep94Group:group.receipt,actualNativeRaw:tail.actualRaw,originalNativeDownloadReceipt:tail.originalReceipt,
  originalBlobs:reads.find(r=>r.value.label==='original-lineage-blobs').value.bytes.toString().trim().split('\n'),
  currentBranch109PinHistory:reads.find(r=>r.value.label==='pin-current-ancestry-109').value.bytes.toString(),
  nativeExecuted:false,repositoryWrites:0};
await writeFile(join(out,'pin-authority-proof.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,proofs:2,current99PinExact:true,step94ActualFailure:true,step109OnlyStaticMismatch:true}));
