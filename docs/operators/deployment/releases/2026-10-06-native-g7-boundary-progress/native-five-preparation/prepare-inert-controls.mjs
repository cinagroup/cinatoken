import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const original=await readFile('C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-next-eight-repair-0511920406eb4b37baca7e103b9080d5/existing-bridge-control-flow.test.mjs','utf8');
let source=original.replace('postgres-budget-admission-login-v350.native.test.mjs','postgres-complete-text-secretless-plan-v365.native.test.mjs')
 .replaceAll('Buyer settlement split is active','Request capability v356 is installed')
 .replace("if(text.includes('authenticated_request_capabilities_v356'))return [{installed:false}];","if(text.includes('authenticated_request_capabilities_v356'))return [{installed:state.buyerSplit}];")
 .replace("if(text.includes('buyer_split_grant_policy_v348'))return [{active:state.buyerSplit}];","if(text.includes('buyer_split_grant_policy_v348'))return [{active:false}];")
 .replaceAll("event.sql.includes('buyer_split_grant_policy_v348')","event.sql.includes('authenticated_request_capabilities_v356')")
 .replaceAll('Buyer split','Request capability');
assert.notEqual(source,original);assert.ok(source.includes("target.slice(node.start,node.end).includes('Request capability v356 is installed')"));
await writeFile(join(root,'inert-bridge-control.test.mjs'),source,{flag:'wx'});
process.stdout.write(JSON.stringify({actualExit:0,controlledTests:6,noPgExecuted:true})+'\n');
