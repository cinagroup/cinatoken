import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const out = resolve(process.argv[2]);
const repo = 'C:/cinagroup/cinatoken';
const startedAt = new Date().toISOString();
const h = bytes => createHash('sha256').update(bytes).digest('hex');
const names = [
'docs/developers/architecture/web-frontend-migration.md',
'.github/workflows/web-platform-g7.yml',
'scripts/verification/web-platform-g7/README.md',
'scripts/verification/web-platform-g7/run-owned-linux.mjs',
'scripts/verification/web-platform-g7/wire.mjs',
'scripts/verification/web-platform-g7/database.mjs',
'scripts/db/cutover/provision-postgres-roles.ts',
'docs/operators/deployment/docker.md'
];
const inputs = names.map(path => {
 const bytes = readFileSync(join(repo,path));
 return { path, bytes:bytes.length, sha256:h(bytes), text:bytes.toString('utf8') };
});
const lines = (path, start, end) => {
 const value = inputs.find(x => x.path === path);
 return value.text.split(/\r?\n/).slice(start-1,end).map((text,i) => ({line:start+i,text}));
};
const envNames = [
'DATABASE_DRIVER','DATABASE_URL','CINATOKEN_GATEWAY_MIGRATOR_PASSWORD',
'CINATOKEN_GATEWAY_RUNTIME_PASSWORD','CINATOKEN_GATEWAY_DRY_RUN',
'CINATOKEN_GATEWAY_ROTATE_PASSWORDS','SHARED_KEY_ENCRYPTION_SECRET',
'CINAAUTH_ISSUER','CINAAUTH_ACCOUNT_ORIGIN','CINATOKEN_APP_ORIGIN',
'CINATOKEN_PUBLIC_API_ORIGIN','CINATOKEN_OIDC_CLIENT_ID',
'CINATOKEN_OIDC_CLIENT_SECRET','CINATOKEN_OIDC_BRIDGE_SECRET',
'CINATOKEN_OIDC_TRANSACTION_SECRET'
];
const environmentPresence = envNames.map(name => ({
 name, processPresent:typeof process.env[name]==='string' && process.env[name].trim().length>0
}));
const configurationPathPresence = [
'docker/deploy/.env.local','docker/examples/.env.gateway','packages/admin/.env.local',
'.env','.env.gateway','docker/examples/gateway.compose.yml',
'docker/examples/web-frontend.compose.yml'
].map(path => ({ path, exists:existsSync(join(repo,path)),
 isFile:existsSync(join(repo,path)) ? statSync(join(repo,path)).isFile() : null,
 contentRead:false }));
const report = {
 schema:'cinatoken-next-real-g2-readonly-plan-v1',
 startedAt, endedAt:new Date().toISOString(),
 sourceContext:{ requestedHead:'757490181564aa822f960f5d8704857b98b230d0',
 headAuthority:'Root supplied commit/push; no new Git/network/CI query made',
 inputAuthority:'8 current local file byte hashes at this read; no claim that whole live tree is immutable',
 originalNativeCIObservedBy:'native_next_batch; no inspection or intervention by this reader',
 manualLinuxRunObservedBy:'remaining_gate_inventory, run37429341568; no inspection or intervention by this reader',
 productionSource:'c13a64b9c3b2c90adcf736910ea408868d7854f1',
 productionAuthority:'Root and existing checklist; no fresh Cloudflare/API access',
 productionAlreadyCutover:true },
 scope:{ inputFiles:8, configContentFiles:0, businessRequests:0,
 databaseConnections:0, appRuns:0, controlTests:0, newCI:0,
 repositoryWrites:0, secretsOrCookiesOrTokenValuesOutput:0,
 sourceCheckOnly:true, executionGatePassed:false, fullG7Verified:false, fullG8Verified:false },
 inputs:inputs.map(({text,...other})=>other),
 facts:[
 {id:'existing-g7-is-stage0',source:'scripts/verification/web-platform-g7/run-owned-linux.mjs',line:948,
 finding:'Only realLinuxDockerTLSPGCatalog may pass; signedOIDC/authenticatedWrites/subjectWorkspaceIsolation/proxySSEAbortWS/retainedGrayRollback/realCinaAuthIdentity remain literal pending, restrictedRuntimeACL/nativePG18/fullG7/fullG8 literal false.'},
 {id:'stage0-db-hard-restriction',source:'scripts/verification/web-platform-g7/database.mjs',line:15,
 finding:'Both seed and observe admit only pg:5432/g7 username postgres and later require identity.role=postgres, superuser=true, PG16. Changing env alone cannot turn this runner into a restricted-role/PG18 acceptance.'},
 {id:'stage0-no-real-login',source:'scripts/verification/web-platform-g7/wire.mjs',line:245,
 finding:'Existing wire only password endpoint 410 / Origin guards, registration redirect and invalid state callback; no completed real issuer authentication/session/authorized Key write.'},
 {id:'oidc-generated-input',source:'scripts/verification/web-platform-g7/run-owned-linux.mjs',line:539,
 finding:'Hard-coded auth.test/accounts.test/client g7-controlled-local plus generated secrets; no real CinaAuth client registration supplied to this runner.'},
 {id:'smallest-real-business-gate',source:'docs/developers/architecture/web-frontend-migration.md',line:387,
 finding:'P2-12 G2: real authorized login, refresh/session restore, workspace switch, Key list/create/one-time secret handling/revoke/logout, and other user/workspace cannot read or revoke. This is the next smallest real acceptance slice; full G7 adds the same real deployment evidence on both platforms.'},
 {id:'roles-only-provisioning',source:'scripts/db/cutover/provision-postgres-roles.ts',line:113,
 finding:'Provision helper checks administrator CREATEROLE/Create, creates restricted LOGIN roles, grants CONNECT/schema USAGE and transfers schema ownership. It does not supply completed application migration/runtime table and function grants or prove an authenticated write. Dry-run rolls back and is only a prerequisite probe.'},
 {id:'linux-direct-cli-guard',source:'scripts/db/cutover/provision-postgres-roles.ts',line:175,
 finding:'Source direct-execution guard concatenates file:/// + argv[1]; for Linux absolute /path this is file:////path, whereas import.meta.url is file:///path. Static string mismatch means a direct node script invocation can skip provisionPostgresRoles entirely. No runtime experiment performed. Use explicit imported function invocation below.'}
 ],
 sourceExcerpts:{
 G2:lines(names[0],375,391),G7G8:lines(names[0],467,491),
 existingWorkflow:lines(names[1],33,54),
 stage0Stages:lines(names[3],948,969),
 stage0DBAdmission:lines(names[5],6,17),
 roleEnvAndRequirements:lines(names[6],21,49),
 roleDirectEntry:lines(names[6],175,181),
 composeCommand:lines(names[7],167,185)
 },
 environmentPresence,
 environmentPresenceMeaning:'Only current child/shell process environment. False does not mean absent Cloudflare secret, absent external secret manager, invalid deployed registration, or absent private operator environment.',
 configurationPathPresence,
 missingExecutionInputs:[
 'Authorized non-production Linux/Docker host and owned isolated PostgreSQL18 target; Docker engine and actual PG connection availability were not queried.',
 'Private reviewed env file, same-SHA frozen Web/SSR image digests, actual trusted HTTPS staging origin/CA and registered callback.',
 'Actual CinaAuth issuer/account endpoints/client registration and private OIDC client/bridge/transaction secrets; current stage0 auth.test does not provide them.',
 'At least two authorized real human subjects and two accessible workspaces with explicit expected capabilities/roles; no credentials/account identities were opened or requested here.',
 'Separate administrator/bootstrap, migrator and restricted-runtime DB connection assignment plus exact current formal schema migration and production runtime grants; do not reuse PG73 historical helper as deploy grant.',
 'Minimal G2 browser/DB observation runner for actual login and Key create/revoke/cleanup; no existing real-identity G2 runner was found in this limited 8-file scope. Existing stage0 runner cannot execute it.'
 ],
 proposedCommands:[
 {order:1,kind:'owned-DB prerequisite only, not G2 pass',run:false,platform:'reviewed isolated Linux repo root',
 command:'CINATOKEN_GATEWAY_DRY_RUN=true node --import tsx --input-type=module -e "import { provisionPostgresRoles } from \'./scripts/db/cutover/provision-postgres-roles.ts\'; await provisionPostgresRoles();"',
 privatePrerequisites:['DATABASE_URL points only to owned administrator connection','CINATOKEN_GATEWAY_MIGRATOR_PASSWORD','CINATOKEN_GATEWAY_RUNTIME_PASSWORD','existing owned role policy reviewed; no password rotation'],
 evidence:'Original stdout/stderr/actual process exit, DB role attributes and rollback observation; dry-run success alone is not effective runtime ACL or any identity/business gate.',
 authority:'Existing exported function signature and transaction rollback source; explicit Linux entry avoids line175 string mismatch.'},
 {order:2,kind:'existing same-origin Docker topology startup, only after private configuration/migrations/grants',run:false,platform:'reviewed isolated Linux repo root',
 command:'docker compose --env-file docker/deploy/.env.local -f docker/examples/gateway.compose.yml -f docker/examples/web-frontend.compose.yml up -d',
 authority:'docs/operators/deployment/docker.md:180; only operator command verified, compose contents not read in this 8-file task.',
 privatePrerequisites:['Verified Web and paired SSR images same release manifest','Current formal migrations, migrator ownership/runtime grants complete on owned PG18','Runtime service DATABASE_URL restricted; secret shared Admin/Proxy','Genuine CinaAuth registration and trusted ingress/actual app origin','Only required account/Web flags enabled and private ports isolated'],
 evidence:'Image/release source, ingress TLS/SNI/Host/Origin and live role/session/schema proof; startup success is not G2.'},
 {order:3,kind:'actual minimal G2 acceptance',run:false,
 browserEntry:'<registered HTTPS staging origin>/api/auth/cinaauth/login?intent=portal&callbackURL=%2Faccount%2Fkeys',
 actions:['Real authorized CinaAuth human completes login (no mock issuer)','Refresh restores server session; switch to known allowed workspace','List Keys, create one expendable Key, display secret once and clear it from UI; do not log secret','Revoke Key; verify restricted-role DB row/status/audit changes and reject other subject/workspace reads/revokes','Logout then verify server revocation and stale-request rejection; remove all owned QA entities'],
 authority:'Existing wire login redirect path and checklist P2-12; route uses original registration/login flow. Exact real auth registration and credentials not examined.',
 evidence:'Sanitized HTTP metadata and UI checks, original failures, DB session role/permission probes and before/after row/audit counts, owned cleanup. Do not count enrollment redirect/invalid-state control as login.',
 implementationBoundary:'Needs a small real-identity driver/readback harness on the configured staging deployment; this task does not fabricate a nonexistent ready-made G2 CLI.'}
 ],
 mapping:[
 {slice:'Role prerequisite + real Key identity/permission/write closure',ids:['G2','E02','P2-02','P2-04','P2-07','P2-09','P2-10','P2-12','P8-03','P8-04'],limit:'Does not by itself close G3/G4/G5/all role matrix/three DBs.'},
 {slice:'Same-origin real Docker auth/write slice',ids:['P7-04','P7-05','G7','E07'],limit:'Only Docker slice; Cloudflare needs corresponding actual auth/write evidence.'},
 {slice:'Real funds/chain and ledger',ids:['P8-07','E04','E05'],status:'Separate subsequent acceptance; no funds/chain action required to establish the first identity/Key slice.'},
 {slice:'Real provider SSE/abort/WS',ids:['P7-07','E07'],status:'Separate next acceptance after authenticated capability; original strict cancellation failure preserved.'},
 {slice:'retained gray switching and rollback with writes',ids:['P7-11','P7-12','G7','E07'],status:'Pending; current 100% cutover/packaging is not a rollback exercise.'},
 {slice:'retirement and full completion',ids:['P8-13','P8-14','G8','E08'],status:'Only after original G0-G7/full matrix; do not retire legacy routes now.'}
 ],
 negativeObservation:{preliminaryPowerShellReader:{reportedExitCode:1,
 reason:'ParserError: An empty pipe element is not allowed in foreach pipeline; body did not execute.',
 preservedAs:'reader-failed-tool-observation.json',nativeOrSourceFailure:false}},
 conclusion:'Next genuine acceptance is the real CinaAuth + restricted-role Key lifecycle G2 slice on actual same-origin staging topology. Existing G7 command is only stage0 and cannot satisfy it. Concrete prerequisite/function and compose commands exist, but private input/authorized subjects/ACL binding and real-identity driver are not supplied in current process/limited scope. Do not claim missing production config or current native pass.',
};
writeFileSync(join(out,'next-real-acceptance-analysis.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({ actualExit:0,inputFileCount:8,report:'next-real-acceptance-analysis.json',
 processEnvironmentPresence:environmentPresence, configurationPathPresence,
 productionRequests:0, databaseConnections:0, executionGatePassed:false,
 fullG7Verified:false, fullG8Verified:false }));

