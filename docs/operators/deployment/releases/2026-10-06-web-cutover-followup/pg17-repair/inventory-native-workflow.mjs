import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const own = path.dirname(fileURLToPath(import.meta.url));
const root='C:/cinagroup/cinatoken';
const raw=file=>{const b=fs.readFileSync(file);return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};};
const workflow=path.join(root,'.github/workflows/proxy-dispatch-safety.yml');
const lines=fs.readFileSync(workflow,'utf8').split(/\r?\n/);
const begin=lines.findIndex(line=>line==='  native-financial-consumer:');
assert.ok(begin>=0);
let declaredStep=0;
const entries=[];
for(let i=begin+1;i<lines.length;i++){
  if(/^  [a-z][a-z0-9-]*:/.test(lines[i]))break;
  if(/^      - [a-zA-Z][a-zA-Z0-9_-]*:/.test(lines[i]))declaredStep++;
  const names=lines[i].match(/(?:scripts|packages)\/[A-Za-z0-9_./-]+\.native\.test\.mjs/g)??[];
  for(const name of names){
    const file=path.join(root,name),body=fs.readFileSync(file,'utf8'),sourceLines=body.split(/\r?\n/);
    const matching=expression=>sourceLines.flatMap((text,index)=>expression.test(text)?[{line:index+1,text:text.trim()}]:[]);
    const allDirectoryLoader=matching(/await\s+readdir\(migrations(?:Url)?\)/);
    const historicalCountAssertions=matching(/assert\.equal\([^\n]*,\s*73\)/);
    const historicalLastAssertion=matching(/assert\.equal\([^\n]*0073_recovery_api_key_workspace_lock/);
    const directGrantCalls=matching(/await\s+(?:assert\.rejects\()?grantPostgresRuntime\(/);
    const bridgeCalls=matching(/await\s+grantPg73RuntimeFixture\(/);
    const pinCalls=matching(/await\s+listPg73Migrations\(/);
    entries.push({file:name,workflowLine:i+1,declaredWorkflowStep:declaredStep,
      expectedActionsStepIncludingSetup:declaredStep+2,
      allDirectoryLoader,historicalCountAssertions,historicalLastAssertion,directGrantCalls,bridgeCalls,pinCalls,
      runtimeRoleDeclarations:matching(/CREATE ROLE cinatoken_gateway_runtime\s+(?:NOLOGIN|LOGIN)/),
      status:allDirectoryLoader.length&&historicalCountAssertions.length?'STATIC_PG73_ALL_CURRENT_MISMATCH_CANDIDATE':pinCalls.length?'ALREADY_PINNED_PG73':'REVIEW_OTHER_SETUP',
      runtimeExecutedByInventory:false,source:raw(file)});
  }
}
const target='scripts/db/cutover/postgres-shared-key-usage-repair-jobs.native.test.mjs';
const targetEntry=entries.find(entry=>entry.file===target);
assert.equal(targetEntry.expectedActionsStepIncludingSetup,17);
const afterTarget=entries.filter(entry=>entry.declaredWorkflowStep>targetEntry.declaredWorkflowStep);
const candidates=afterTarget.filter(entry=>entry.status==='STATIC_PG73_ALL_CURRENT_MISMATCH_CANDIDATE');
const alreadyPinned=afterTarget.filter(entry=>entry.status==='ALREADY_PINNED_PG73');
const others=afterTarget.filter(entry=>entry.status==='REVIEW_OTHER_SETUP');
const laterDirectGrant=afterTarget.filter(entry=>entry.directGrantCalls.length);
const report={schema:'native-workflow-after-step17-readonly-plan',at:new Date().toISOString(),workflow:raw(workflow),changedFiles:[],
  notes:['Only step17 was observed failing in the latest closed CI log. Later candidates are static findings; no later native failure or pass is claimed.',
    'The expected Actions step numbers add the automatic Set up job and Initialize containers steps to declared YAML steps; both automatic steps and target17 were cross-checked against the closed Root job state.',
    'The frozen PG73 corpus/count must remain73. No blanket73-to81 edits or formal/proposal SQL changes.',
    'Direct grant calls include rejection tests. Do not replace every direct call with the bridge: membership/catalog drift tests can depend on production preflight order and expected errors. Review each fixture separately.'],
  totals:{nativeFiles:entries.length,afterTarget:afterTarget.length,staticAllCurrentWith73:candidates.length,alreadyPinnedPG73:alreadyPinned.length,otherSetup:others.length,laterDirectGrantFixtures:laterDirectGrant.length},
  proposedBatches:[
    {name:'next-shared-usage-runtime-grant',files:candidates.filter(entry=>entry.file.includes('usage-repair-runtime-grant')).map(entry=>entry.file),
      review:'Pin initial PG73 corpus, but separately review NOLOGIN and production grant0074/directLOGIN requirements, expected partial catalog/ACL failure messages, and membership-negative cases. Existing bridge rejects memberships before calling the production reconciler; a blanket bridge replacement can change the tested error. No edit authorized here.'},
    {name:'remaining-shared-key-historical-fixtures',files:candidates.filter(entry=>!entry.file.includes('usage-repair-runtime-grant')&&/shared-key|shared-earning/.test(entry.file)).map(entry=>entry.file),
      review:'Review each proposal historical trigger/ledger contract and successful grant setup. Use existing frozen-list/bridge only where correct; preserve retry, ownership, ACL and role drift assertions.'},
    {name:'remaining-admission-and-buyer-historical-fixtures',files:candidates.filter(entry=>!entry.file.includes('usage-repair-runtime-grant')&&!/shared-key|shared-earning/.test(entry.file)).map(entry=>entry.file),
      review:'Review formal corpus, proposal compatibility and direct grant preflight ordering per fixture. Do not apply a bulk assertion update.'},
    {name:'already-pinned-direct-grant-review',files:laterDirectGrant.filter(entry=>entry.pinCalls.length&&!entry.allDirectoryLoader.length).map(entry=>entry.file),
      review:'A loader fix alone is unnecessary here, but successful direct grants on PG73 may encounter required0074 and/or LOGIN checks. Preserve deliberate production rejection tests; runtime evidence is pending.'}
  ],candidates,alreadyPinnedSummary:alreadyPinned.map(entry=>({file:entry.file,step:entry.expectedActionsStepIncludingSetup,successfulOrRejectedDirectGrantCallLines:entry.directGrantCalls.map(item=>item.line),bridgeCallLines:entry.bridgeCalls.map(item=>item.line)})),
  otherSetup:others,allNativeEntries:entries};
const output=path.join(own,'after-step17-inventory.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({report:raw(output),totals:report.totals,candidates:candidates.map(entry=>({file:entry.file,step:entry.expectedActionsStepIncludingSetup,loader:entry.allDirectoryLoader.map(item=>item.line),count:entry.historicalCountAssertions.map(item=>item.line),directGrantCalls:entry.directGrantCalls.map(item=>item.line)})),nextTen:afterTarget.slice(0,10).map(entry=>({file:entry.file,step:entry.expectedActionsStepIncludingSetup,status:entry.status}))},null,2));
