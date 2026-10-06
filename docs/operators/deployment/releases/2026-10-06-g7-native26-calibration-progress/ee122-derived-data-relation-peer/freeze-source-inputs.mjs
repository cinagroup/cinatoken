import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const out=process.argv[2],head='ee122dd4273e2db892daa724bc6417a9b02b280c';
const info=b=>({bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')});
const old='C:/Users/cina/AppData/Local/Temp/cinatoken-native26-ci-terminal-independent-peer-cc2708922c0e4f64a9cca948194a20d9';
const previousBytes=fs.readFileSync(old+'/FINAL-native26-ci-independent-peer.json');
assert.deepEqual(info(previousBytes),{bytes:413706,sha256:'6635f04f77f6f6325a794756883a8bf697f752af239e33deb2b8c3b226a57e66'});
const previous=JSON.parse(previousBytes),oldSourcesBytes=fs.readFileSync(previous.sourceInputs.file);
assert.deepEqual(info(oldSourcesBytes),{bytes:previous.sourceInputs.bytes,sha256:previous.sourceInputs.sha256});
const oldSources=JSON.parse(oldSourcesBytes);
assert.equal(oldSources.records.length,59);
const expected26=[60,61,66,69,71,72,73,74,75,76,77,78,80,81,82,83,84,85,86,88,95,96,97,98,99,106];
assert.deepEqual(oldSources.records.filter(x=>x.preparedTarget).map(x=>x.step),expected26);
const extras=[
'scripts/db/cutover/fixtures/historical-native/postgres-shared-key-guardrail-post-reservation-denial-v348.native.test.mjs.txt',
'scripts/db/cutover/fixtures/historical-native/postgres-replay-reservations.native.test.mjs.txt'
];
const refs=[oldSources.workflow.file,...oldSources.records.map(x=>x.fixture),...extras].map(x=>head+':'+x);
const input=Buffer.from(refs.join('\n')+'\n');
const stdinPath=path.join(out,'git-source-batch.stdin.log');fs.writeFileSync(stdinPath,input,{flag:'wx'});
const begin=new Date().toISOString();
const r=spawnSync('C:/Program Files/Git/cmd/git.exe',['cat-file','--batch'],{cwd:'C:/cinagroup/cinatoken',input,encoding:null,maxBuffer:256*1024*1024,windowsHide:true,timeout:90000});
const end=new Date().toISOString();
const stdout=r.stdout??Buffer.alloc(0),stderr=r.stderr??Buffer.alloc(0);
const raw=(name,b)=>{const file=path.join(out,name);fs.writeFileSync(file,b,{flag:'wx'});return {path:file,...info(b)};};
const receipt={schema:'independent-ee122-proxy-readonly-child-receipt-v1',name:'git-source-batch',executable:'C:/Program Files/Git/cmd/git.exe',argv:['cat-file','--batch'],cwd:'C:/cinagroup/cinatoken',startedAt:begin,closedAt:end,actualExit:r.status,signal:r.signal,spawnError:r.error?{name:r.error.name,message:r.error.message,code:r.error.code}:null,closed:r.status!==null||r.signal!==null,stdin:{path:stdinPath,...info(input)},stdout:raw('git-source-batch.stdout.log',stdout),stderr:raw('git-source-batch.stderr.log',stderr)};
fs.writeFileSync(path.join(out,'git-source-batch.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
assert.equal(r.status,0);assert.equal(r.signal,null);assert.equal(r.error,undefined);
let at=0;const extracted=[];
for(let i=0;i<refs.length;i++){
 const e=stdout.indexOf(10,at);assert(e>=0);
 const h=stdout.subarray(at,e).toString('utf8').match(/^([0-9a-f]{40}) blob ([0-9]+)$/);assert(h,refs[i]);
 const n=Number(h[2]),body=stdout.subarray(e+1,e+1+n);assert.equal(body.length,n);assert.equal(stdout[e+1+n],10);
 const gitBlob=crypto.createHash('sha1').update(Buffer.from('blob '+n+'\0')).update(body).digest('hex');assert.equal(gitBlob,h[1]);
 const snapshot=path.join(out,i===0?'source-workflow.snapshot.txt':i<60?'source-step-'+oldSources.records[i-1].step+'.snapshot.txt':'source-historical-'+(i-59)+'.snapshot.txt');
 fs.writeFileSync(snapshot,body,{flag:'wx'});
 extracted.push({ref:refs[i],gitBlob,snapshot,...info(body)});
 at=e+1+n+1;
}
assert.equal(at,stdout.length);
const workflowText=fs.readFileSync(extracted[0].snapshot,'utf8'),lines=workflowText.split('\n');
const records=oldSources.records.map((old,i)=>{
 const start=old.workflowLine-1;assert(/      - /.test(lines[start]),'workflow step line '+old.step);
 let end=start+1;while(end<lines.length&&!/^      - /.test(lines[end]))end++;
 const commands=lines.slice(start,end).filter(x=>/node .*--test /.test(x)).map(x=>x.trim());assert.equal(commands.length,1,'command count '+old.step);assert(commands[0].includes(old.fixture));
 return {step:old.step,yamlStep:old.yamlStep,workflowLine:old.workflowLine,fixture:old.fixture,preparedTarget:old.preparedTarget,originalAssertionCount:old.originalAssertionCount,workflowCommand:commands[0],source:{headSha:head,...extracted[i+1]}};
});
const report={schema:'cinatoken.ee122-native-terminal-source-inputs.v1',headSha:head,previousInventoryAuthority:{file:old+'/FINAL-native26-ci-independent-peer.json',...info(previousBytes),sourceInputs:{file:previous.sourceInputs.file,...info(oldSourcesBytes)},usage:'Only stable 59 workflow fixture selection and 26 target labels; all current source bytes come from exact ee122 Git blobs.'},workflow:{file:oldSources.workflow.file,headSha:head,...extracted[0]},records,historicalTextSnapshots:extracted.slice(60),gitBatchReceipt:{file:path.join(out,'git-source-batch.closed.json'),...receipt}};
fs.writeFileSync(path.join(out,'source-inputs-ee122.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({headSha:head,refs:refs.length,records:records.length,targets:records.filter(x=>x.preparedTarget).length,workflow:info(fs.readFileSync(extracted[0].snapshot)),historical:extracted.slice(60).map(x=>({bytes:x.bytes,sha256:x.sha256})),actualGitExit:r.status}));