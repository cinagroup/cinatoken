import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'file:///C:/cinagroup/cinatoken/node_modules/acorn/dist/acorn.mjs';
const own=path.dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken';
const info=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
const workflow=fs.readFileSync(path.join(repo,'.github/workflows/proxy-dispatch-safety.yml'));
const block=workflow.toString().split('  native-financial-consumer:')[1].split(/^  [a-z][a-z0-9-]*:/m)[0];
const steps=block.split(/^      - /m).slice(1).map((body,index)=>({sourceStep:index+1,ciStep:index+3,body,file:body.match(/node .*?--test (\S+)/)?.[1]}));
const index=steps.findIndex(step=>step.file==='scripts/db/cutover/postgres-budget-admission-login-v350.native.test.mjs');
assert.ok(index>=0);assert.equal(steps[index].ciStep,36);
function walk(node,visitor,ancestors=[]){if(!node||typeof node!=='object')return;if(node.type)visitor(node,ancestors);for(const value of Object.values(node)){if(Array.isArray(value))for(const item of value)walk(item,visitor,[...ancestors,node]);else if(value&&typeof value==='object')walk(value,visitor,[...ancestors,node]);}}
const reviewed=[],candidates=[];
for(const step of steps.slice(index+1)){
  if(!step.file||!step.file.startsWith('scripts/db/cutover/'))continue;
  const bytes=fs.readFileSync(path.join(repo,step.file)),body=bytes.toString();
  const grants=[],counts=[],loaders=[];
  walk(parse(body,{ecmaVersion:'latest',sourceType:'module'}),(node,ancestors)=>{
    if(node.type!=='CallExpression')return;
    const source=body.slice(node.start,node.end),line=body.slice(0,node.start).split('\n').length;
    if(node.callee?.type==='Identifier'&&['readdir','listPg73Migrations','grantPostgresRuntime','grantPg73RuntimeFixture'].includes(node.callee.name)){
      if(['readdir','listPg73Migrations'].includes(node.callee.name))loaders.push({line,source,callee:node.callee.name});
      else {const enclosing=[...ancestors].reverse().find(parent=>parent.type==='CallExpression'&&parent.callee?.object?.name==='assert'&&parent.callee?.property?.name==='rejects');grants.push({line,source,callee:node.callee.name,assertRejectsEnclosing:enclosing?body.slice(enclosing.start,enclosing.end):null});}
    }
    if(node.callee?.object?.name==='assert'&&['equal','strictEqual'].includes(node.callee?.property?.name)&&node.arguments?.some(argument=>argument.type==='Literal'&&argument.value===73))counts.push({line,source});
  });
  const pinned=loaders.some(item=>item.callee==='listPg73Migrations');
  const record={file:step.file,sourceStep:step.sourceStep,ciStep:step.ciStep,...info(bytes),pinnedPg73:pinned,historical73Assertions:counts,loaders,grants,actualLinuxFailureKnown:false};
  reviewed.push(record);
  if(!pinned&&counts.length&&loaders.some(item=>item.callee==='readdir'))candidates.push({...record,body,bytesBuffer:bytes});
  if(candidates.length===8)break;
}
assert.equal(candidates.length,8);
assert.deepEqual(candidates.map(item=>item.ciStep),[37,38,41,42,43,44,45,46]);
const detailed=candidates.map(({body,bytesBuffer,...item})=>{
  const name=path.basename(item.file),original=spawnSync('C:/Program Files/Git/cmd/git.exe',['show',`b1ec8f33cf24edc07e8855c059c1498730a43113:${item.file}`],{cwd:repo,encoding:null,windowsHide:true});
  assert.equal(original.status,0);assert.ok(bytesBuffer.equals(original.stdout));
  const snapshot=path.join(own,'downstream-'+name+'.before');fs.writeFileSync(snapshot,bytesBuffer,{flag:'wx'});
  const lines=body.split('\n');
  const roleEvidence=lines.map((text,index)=>({line:index+1,text})).filter(item=>/CREATE ROLE|const roles=|const roles =|runtime:|GRANT .* TO cinatoken_gateway_runtime|REVOKE .*FROM cinatoken_gateway_runtime/.test(item.text));
  const concurrency=item.ciStep===41;
  const hasSequentialNegatives=item.grants.some(call=>call.assertRejectsEnclosing);
  let plan;
  if(concurrency)plan={existingBridge:'Allowed for sequential initial and final grants; concurrent grant requires an independent owned migrator client.',sharedMigratorBridgeSafe:false,why:'Original concurrentGrant is launched inside migrator.begin; connection max1 is occupied by that transaction. The existing bridge starts with pg73State(migrator), so using the same client queues its first query until commit while the fixture waits for the production grant advisory lock. This cannot establish the original lock wait.',minimalFixtureOnlyAdaptation:'Create a separate client authenticated directly as the same owned migrator LOGIN, max1, loopback cluster.port. Add it to clients for existing finally cleanup; use this peer for the bridge around the concurrent production grant. Preserve original blocked=true polling60×25ms, Request capability v356 exact rejection, original assertions, and rollback/ACL checks. Do not alter helper or production locking. Validate temporary0074 install/drop does not interfere with proposal transaction or ledger assertions in actual Linux.',productionNegative:'Unchanged production preflight0074, then request-capability marker guard before broad grants.',nativeConcurrencyValidationRequired:true};
  else plan={existingBridge:'Compatible with restricted owned LOGIN and no memberships at the original sequential grant points.',sharedMigratorBridgeSafe:true,minimalFixtureOnlyAdaptation:hasSequentialNegatives?'Pin listPg73Migrations and use fixture-local closure forwarding the original explicit DATABASE_URL to existing bridge, retaining every original grant call and exact assert AST/source.':'Pin listPg73Migrations and adapt the sole original successful grant to existing owned bridge, preserving original73/corpus and role/ACL/rollback assertions.',productionNegative:hasSequentialNegatives?'Unchanged production0074 preflight is satisfied only temporarily; original exact Request capability v356 installed guard still must reject before ACL mutation.':'No direct grant-negative case in this fixture; proposal default-off/contamination/42501 cases must remain byte-exact.',nativeConcurrencyValidationRequired:false};
  const concurrencyEvidence=concurrency?body.slice(body.indexOf('      let concurrentGrant;'),body.indexOf("      stage('default-off-contaminated-role-rejection-and-concurrent-grant-interlock');")+"      stage('default-off-contaminated-role-rejection-and-concurrent-grant-interlock');".length):null;
  return {...item,sourceExactFixedBase:true,snapshot:{path:snapshot,...info(bytesBuffer)},runtimeRole:{login:true,password:'randomBytes(24) hex in owned fixture only',memberships:'No membership at initial grant; v359 tests runtime membership contamination later and revokes in finally before final negative grant.',evidence:roleEvidence},grantNegativeCount:item.grants.filter(call=>call.assertRejectsEnclosing).length,grantSuccessOrConcurrentCount:item.grants.filter(call=>!call.assertRejectsEnclosing).length,plan,concurrencyEvidence};
});
const report={schema:'cinatoken.pg73.downstream.readonly-plan.v1',at:new Date().toISOString(),actualExit:0,baseCommit:'b1ec8f33cf24edc07e8855c059c1498730a43113',actualFailureScope:'Only step36 v350 failure is established by sealed Linux log. Steps37+ are not executed due to fail-fast and are static candidates, never reported failed or passed.',stepMapping:'Workflow source step34 corresponds to actual CI step36 from parent verified run/job; +2 represents Set up job and Initialize containers. The first8 same-mechanism candidates are ordered by workflow.',workflow:info(workflow),nextEight:detailed,interveningPinnedFixtures:reviewed.filter(item=>item.pinnedPg73),scope:{sourceWrites:0,databaseConnections:0,productionRequests:0,ciPolling:false,onlyTempEvidenceWrites:true},recommendation:'Batch only the seven simple sequential fixtures after exact source/role/negative review; isolate v356 concurrency adaptation for real lock validation rather than blindly wrapping the active migrator transaction.'};
const target=path.join(own,'FINAL-next-eight-pg73-plan.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});const bytes=fs.readFileSync(target);
console.log(JSON.stringify({actualExit:0,path:target,...info(bytes),candidates:detailed.map(item=>({ciStep:item.ciStep,file:item.file,grantNegativeCount:item.grantNegativeCount,sharedMigratorBridgeSafe:item.plan.sharedMigratorBridgeSafe})),sourceWrites:0}));
