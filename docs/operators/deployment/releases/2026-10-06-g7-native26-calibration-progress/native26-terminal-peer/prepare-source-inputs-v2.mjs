import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const out=process.argv[2],head='dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc';
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
const inventoryFile='C:/Users/cina/AppData/Local/Temp/cinatoken-native59-full-inventory-10b2722ab06d4cf6b6305e24571b4a8d/FINAL-native59-full-readonly-inventory.json';
const preparationFile='C:/Users/cina/AppData/Local/Temp/cinatoken-native26-pg73-repair-908e0528cf5e44508d04e761c4540713/FINAL-native26-pg73-preparation.json';
const inventoryBytes=readFileSync(inventoryFile),preparationBytes=readFileSync(preparationFile);
assert.equal(info(inventoryBytes).sha256,'67bf17ba71aa1b9a1b3eba948cc0f2a7e221e80a9e8a1ed3ee33eef8e5ceb6cb');
assert.equal(info(preparationBytes).sha256,'48f61432f183455a1c1557cda0ee8063d9f5419358933ed035504cd85913efda');
const inventory=JSON.parse(inventoryBytes),preparation=JSON.parse(preparationBytes),commands=[];
function git(name,args){ name="v2-"+name;
 const at=new Date().toISOString(),r=spawnSync('git',args,{cwd:'C:/cinagroup/cinatoken',encoding:null,maxBuffer:16*1024*1024,windowsHide:true}),finishedAt=new Date().toISOString();
 const stdout=r.stdout??Buffer.alloc(0),stderr=r.stderr??Buffer.alloc(0);
 const receipt={at,finishedAt,executable:'git',args,cwd:'C:/cinagroup/cinatoken',actualExit:r.status,signal:r.signal??null,spawnError:r.error?String(r.error):null,stdout:join(out,name+'.stdout.log'),stderr:join(out,name+'.stderr.log'),stdoutInfo:info(stdout),stderrInfo:info(stderr)};
 writeFileSync(receipt.stdout,stdout,{flag:'wx'});writeFileSync(receipt.stderr,stderr,{flag:'wx'});writeFileSync(join(out,name+'.closed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});commands.push(receipt);assert.equal(r.status,0,JSON.stringify(receipt));return stdout;
}
const workflow=git('source-workflow',['cat-file','blob',head+':.github/workflows/proxy-dispatch-safety.yml']);
const lines=workflow.toString('utf8').split('\n');
const jobAt=lines.findIndex(l=>l==='  native-financial-consumer:');assert(jobAt>=0);
let jobEnd=jobAt+1;while(jobEnd<lines.length && !/^  [^ ].*:$/.test(lines[jobEnd]))jobEnd++;
const starts=[];for(let i=jobAt;i<jobEnd;i++)if(/^      - /.test(lines[i]))starts.push(i);
const records=[];
for(let step=55;step<=113;step++){
 const yaml=step-2,start=starts[yaml-1],end=starts[yaml]??jobEnd;assert(Number.isInteger(start));
 const block=lines.slice(start,end).join('\n');const matches=[...block.matchAll(/node (?:--import tsx )?--test ([^\s]+\.native\.test\.mjs)/g)];assert.equal(matches.length,1,'step '+step);
 const fixture=matches[0][1];assert(block.includes('GATEWAY_NATIVE_PG_BIN=/usr/lib/postgresql/18/bin'));const prior=inventory.records.find(r=>r.step===step);if(prior)assert.equal(fixture,prior.fixture);
 const bytes=git('source-step-'+step,['cat-file','blob',head+':'+fixture]),source=info(bytes),prepared=preparation.finalFiles.find(r=>r.step===step);
 if(prepared){assert.equal(fixture,prepared.file);assert.deepEqual(source,prepared.after);}else if(prior){assert.equal(source.sha256,prior.sha256);assert.equal(source.bytes,prior.bytes);}
 records.push({step,yamlStep:yaml,workflowLine:start+1,fixture,source:{headSha:head,...source,snapshot:join(out,'v2-source-step-'+step+'.stdout.log')},preparedTarget:!!prepared,originalAssertionCount:prepared?.originalAssertions??prior?.originalAssertionCount??null});
}
assert.equal(records.length,59);assert.equal(records.filter(r=>r.preparedTarget).length,26);
const report={schema:'cinatoken.native26-ci-independent-peer.source-inputs.v1',at:new Date().toISOString(),headSha:head,workflow:{file:'.github/workflows/proxy-dispatch-safety.yml',...info(workflow),snapshot:join(out,'v2-source-workflow.stdout.log')},inventory:{file:inventoryFile,...info(inventoryBytes)},preparation:{file:preparationFile,...info(preparationBytes)},records,commands,sourceReadOnly:true};
writeFileSync(join(out,'source-inputs-v2.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({headSha:head,records:records.length,preparedTargets:records.filter(r=>r.preparedTarget).length,actualClosedGitReads:commands.length,gitAllActualZero:commands.every(r=>r.actualExit===0),report:join(out,'source-inputs-v2.json')}));