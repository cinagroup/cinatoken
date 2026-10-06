import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const own=path.dirname(fileURLToPath(import.meta.url)),root='C:/cinagroup/cinatoken';
const raw=file=>{const b=fs.readFileSync(file);return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};};
const git=args=>execFileSync('C:/Program Files/Git/cmd/git.exe',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const target='scripts/db/cutover/postgres-shared-key-usage-repair-runtime-grant.native.test.mjs';
const before=path.join(own,'runtime-grant.before.native.test.mjs'),current=path.join(root,target);
assert.deepEqual(fs.readFileSync(before),fs.readFileSync(current));
assert.equal(git(['diff','--',target]),'');
const body=fs.readFileSync(current,'utf8'),lines=body.split(/\r?\n/);
const calls=lines.flatMap((text,index)=>/await\s+(?:assert\.rejects\()?grantPostgresRuntime\(/.test(text)?[{line:index+1,negative:text.includes('assert.rejects'),call:text.trim(),expected: text.includes('assert.rejects')?lines[index+1].trim():null}]:[]);
assert.equal(calls.length,9);assert.equal(calls.filter(item=>item.negative).length,4);
const grantFile=path.join(root,'scripts/db/cutover/grant-postgres-runtime.ts');
const helperFile=path.join(root,'scripts/db/cutover/pg73-native-fixture.mjs');
const grant=fs.readFileSync(grantFile,'utf8'),helper=fs.readFileSync(helperFile,'utf8');
const auditCheck=grant.indexOf("0074_config_change_audit.sql");
const directCheck=grant.indexOf('DO $runtime_direct_role$');
const retainedCheck=grant.indexOf("RAISE EXCEPTION 'Ordinary runtime retains shared-key usage repair privilege'");
assert.ok(auditCheck>=0&&auditCheck<directCheck&&directCheck<retainedCheck);
assert.ok(helper.indexOf('!originalRuntime.has_memberships')<helper.indexOf('await grantPostgresRuntime'));
assert.ok(body.includes('CREATE ROLE cinatoken_gateway_runtime NOLOGIN'));
assert.ok(body.includes('assert.equal(files.length, 73)'));
const inventory='C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-usage-jobs-repair-921bf93575a54e5db7b0afca01508b06/after-step17-inventory.json';
const corpusProof='C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-usage-jobs-repair-921bf93575a54e5db7b0afca01508b06/local-audit.proof.json';
const plan={
  schema:'pg73-step20-runtime-grant-readonly-adaptation-plan',at:new Date().toISOString(),localPlanSealActualExit:0,
  head:git(['rev-parse','HEAD']),target,before:raw(before),current:raw(current),
  currentGitBlob:git(['rev-parse','HEAD:'+target]),noTargetDiff:true,
  executionScope:{repositoryEdits:0,CIInvocations:0,CIPolls:0,productionRequests:0,DBConnections:0,DBWrites:0,localNativeTests:0,productionFlagsOrBindingsChanged:false},
  actualCIStatus:'The new same-head CI37390678189 is owned by Root. Step20 failure or success has not been independently queried or observed by this plan.',
  evidence:{historicalAllCurrentLoader:{line:53,expectedCountLine:54,last0073Line:55},runtimeNOLOGINLine:44,grantCalls:calls,
    permissionDenied42501Lines:[93,95],sources:[grantFile,helperFile,path.join(root,'packages/core/migrations-postgres/0074_config_change_audit.sql')].map(raw),priorFrozenCorpusProof:raw(corpusProof),broaderReadOnlyInventory:raw(inventory)},
  currentContracts:[
    'Production grant first verifies migrator current_user/schema owner, then requires0074 ledger. A raw call on the unchanged PG73 schema fails the0074 prerequisite before testing any optional repair ACL.',
    'Inside the real grant transaction, runtime directLOGIN/no-superuser/no-createdb/no-createrole/no-replication/no-bypassRLS/no-membership validation runs before broad ACL changes and the later optional repair table/definer checks.',
    'The existing PG73 bridge permits an initially restricted NOLOGIN runtime, temporarily makes it LOGIN for the real grant, then restores its original role attributes and exactPG73 ledger. It rejects an existing membership itself, before production grant executes.',
    'There are9 real grant calls:5 intended success and4 expected rejection, plus2 independent runtimeSQLSTATE42501 operations. This is not9 grant-negative cases.'
  ],
  recommendation:{status:'PLAN ONLY, no code written',
    loader:'Replace all-directory migration enumeration with listPg73Migrations; preserve assert count73 and last0073. Keep frozen corpus SHA23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc and ledger MD5ca1ea96a1b4bcd0675642f30dcf48042.',
    ordinaryCalls:{lines:[63,68,86,87,98,101,108,117],operation:'Call the existing grantPg73RuntimeFixture with this owned cluster, migrator and databaseUrl. The real unmodified production grant executes inside it. Successful setup/reruns still narrow repair ACLs; failed partial/catalog/third-party ACL grants throw their original production messages.',
      unchangedExpectedErrors:[{line:68,message:'Shared-key usage repair installation is incomplete'},{line:98,message:'Shared-key usage repair catalog differs'},{line:108,message:'Shared-key usage repair ACL differs'}],
      roleProof:'Before/after bridge calls verify runtime stays original restrictedNOLOGIN with no memberships; keep original adminSETROLE runtime permission tests and42501 assertions. No real runtime LOGIN credential is introduced.'},
    exceptionalMembershipCall:{line:112,
      originalExpected:'Ordinary runtime retains shared-key usage repair privilege',
      justifiedCurrentExpected:'Runtime must be a restricted direct LOGIN without role memberships',
      reason:'Membership is rejected by the current actual production policy before any ACL mutation. The old later repair-privilege branch is unreachable for this input. Do not broaden the expected regex or accept the bridge assertion as this case.',
      isolatedFixtureOnlyScope:[
        'Keep original GRANT shadow membership and inherited repair_table===true assertion. Snapshot existing role attributes, exact member/role IDs and membership options, plus optional job/function and ordinary users privileges.',
        'Verify owned loopback URL/migrator identity, exactPG73 ledger/corpus and0074 absent. Require only the deliberately created shadow membership and otherwise restrictedNOLOGIN attributes, so the negative setup cannot drift silently.',
        'In one migrator transaction install the unchanged0074 audit migration plus its one ledger row. Temporarily ALTER only this owned runtime role LOGIN. Do not remove or normalize the deliberate membership or ACL corruption.',
        'Invoke the actual unmodified grantPostgresRuntime directly and assert precisely the current directLOGIN/no-memberships error. Independently verify membership and business ACL snapshots remain unchanged after the failed grant; inherited repair access must still be true.',
        'In nested finally remove only the temporary0074 table+ledger and restore originalNOLOGIN attributes even after assertion failure; verify count73, exact ledgerMD5,0074 table/ledger absent, and original role/membership state. Do not use CASCADE or suppress cleanup failures.',
        'Continue the original REVOKE membership/third-party ACL cleanup, final successful bridge rerun, and owner-only repair ACL assertion.'
      ],
      noAdmissionWeakening:'This special negative scope does not relax pg73-native-fixture admission or change grant production logic. It exists only to present an intentionally invalid member role to the current real reconciler and prove rejection before mutation.'},
    invariants:['All original partial-catalog rollback, owner-only job/definer ACLs, ordinary_users_select=true, two42501 failures, catalog drift, third-party shadow ACL rejection and restore checks remain.',
      'Keep240000ms bound, nativePG18.6 owned loopback fixture and real cleanup. No73-to81 assertion update, formal/proposal SQL edit, production grant edit or deployed role/flag/binding change.',
      'Only the obsolete membership error expectation is updated, with explicit current-policy rationale and stronger no-mutation/restoration evidence. Native execution must remain the existing LinuxCI command.']},
  alternative:{name:'One temporary0074/directLOGIN envelope around all9 grants',assessment:'Technically the current production reconciler would be reached, but this duplicates the existing bridge and leaves0074/LOGIN present across historical proposal activation. Prefer the8existing-bridge calls plus one explicit negative scope to preserve the historical proposal baseline between stages.'},
  remainingUnknowns:['No native case has been run in this read-only task. Current-policy error ordering is source-proven; cleanup and ACL semantics require realLinuxPG execution.',
    'Any new helper or inline negative scope must be peer-reviewed for throw-safe restoration and exact owned-cluster boundaries before execution.'],
  intendedValidation:'gosu postgres env HOME=/var/lib/postgresql GATEWAY_NATIVE_PG_BIN=/usr/lib/postgresql/18/bin node --import tsx --test scripts/db/cutover/postgres-shared-key-usage-repair-runtime-grant.native.test.mjs'
};
const output=path.join(own,'FINAL-step20-runtime-grant-plan.json');
fs.writeFileSync(output,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({plan:raw(output),head:plan.head,target:plan.target,source:plan.current,currentGitBlob:plan.currentGitBlob,grantCalls:calls.length,negativeGrantCalls:calls.filter(item=>item.negative).length,executionScope:plan.executionScope},null,2));
