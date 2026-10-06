import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url)),target=path.join(root,'registration-link-repair');
const hash=b=>createHash('sha256').update(b).digest('hex');
let source=fs.readFileSync(path.join(root,'registration-runtime-v2/registration-metadata.worker.mjs'),'utf8');
assert.equal(hash(Buffer.from(source)),'44d83eefffd275c0b4122294e8cc57af6590df2078c7f9f79a5cd1a8460e5885');
const replace=(a,b)=>{assert.equal(source.split(a).length,2,a);source=source.replace(a,b);};
replace("pathname !== '/registration-metadata'","pathname !== '/registration-link-repair'");
replace("request.method !== 'GET'","request.method !== 'POST'");
replace("const classification = code === '42P01'", "const classification = error?.message === 'registration_policy_blocked' ? 'registration_policy_blocked'\n    : error?.message === 'registration_link_not_created' ? 'registration_link_not_created'\n    : code === '42P01'");
const start=source.indexOf('      // postgres 3.4.9 emits BEGIN READ ONLY');
const end=source.indexOf('    } catch (error) {',start);
assert(start>0&&end>start);
source=source.slice(0,start)+`      // Lock the already-existing fixed client/resource and preserve both policies.
      // This transaction may INSERT only their missing exact association.
      result = await sql.begin(async transaction => {
        await transaction.unsafe('SET LOCAL statement_timeout = 5000');
        await transaction.unsafe('SET LOCAL lock_timeout = 2000');
        await transaction.unsafe('SET LOCAL idle_in_transaction_session_timeout = 7000');
        const client = await transaction.unsafe('SELECT COALESCE("disabled", FALSE) AS "disabled" FROM "oauthClient" WHERE "clientId" = $1 FOR UPDATE', [CLIENT_ID]);
        const resource = await transaction.unsafe('SELECT COALESCE("disabled", FALSE) AS "disabled" FROM "oauthResource" WHERE "identifier" = $1 FOR UPDATE', [RESOURCE_ID]);
        const readMetadata = async () => {
          const rows = await transaction.unsafe(SELECT_METADATA, [CLIENT_ID, RESOURCE_ID]);
          if (rows.length !== 1 || Object.keys(rows[0]).length !== OUTPUT_KEYS.length || OUTPUT_KEYS.some(key => typeof rows[0][key] !== 'boolean')) throw new Error('Unexpected result shape');
          return Object.fromEntries(OUTPUT_KEYS.map(key => [key, rows[0][key]]));
        };
        const before = await readMetadata();
        if (client.length !== 1 || resource.length !== 1 || client[0].disabled !== false || resource[0].disabled !== false || !before.clientExists || before.clientDisabled || !before.resourceExists || before.resourceDisabled) throw new Error('registration_policy_blocked');
        const inserted = await transaction.unsafe('INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING RETURNING TRUE AS "inserted"', [CLIENT_ID + ':' + RESOURCE_ID, CLIENT_ID, RESOURCE_ID]);
        const after = await readMetadata();
        if (!after.linkExists || after.clientDisabled || after.resourceDisabled) throw new Error('registration_link_not_created');
        return { before, after, insertedClientLink: inserted.length === 1 };
      });
`+source.slice(end);
assert.equal((source.match(/INSERT INTO/g)||[]).length,1);
assert.doesNotMatch(source,/\b(?:DELETE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)\b/);
assert.doesNotMatch(source,/UPDATE\s+"/);
assert.equal((source.match(/FOR UPDATE/g)||[]).length,2);
fs.mkdirSync(target);fs.writeFileSync(path.join(target,'registration-link-repair.worker.mjs'),source,{flag:'wx'});
const require=createRequire('C:/cinagroup/cinatoken/package.json'),esbuild=require('esbuild');
await esbuild.build({stdin:{contents:source,sourcefile:'registration-link-repair.worker.mjs',resolveDir:'C:/cinagroup/cinatoken',loader:'js'},absWorkingDir:'C:/cinagroup/cinatoken',tsconfigRaw:{compilerOptions:{}},outfile:path.join(target,'registration-link-repair.bundle.mjs'),bundle:true,format:'esm',platform:'neutral',conditions:['workerd'],external:['node:*','cloudflare:sockets'],alias:{postgres:'C:/cinagroup/cinatoken/node_modules/postgres/cf/src/index.js'},nodePaths:['C:/cinagroup/cinatoken/node_modules'],target:'es2022',logLevel:'silent',legalComments:'none'});
const syntax=[];
for(const name of ['registration-link-repair.worker.mjs','registration-link-repair.bundle.mjs']){
 const child=spawnSync(process.execPath,['--check',path.join(target,name)],{windowsHide:true,timeout:10000,encoding:'utf8'});
 syntax.push({name,actualExit:child.status,signal:child.signal,spawnError:child.error?.code??null,stdoutBytes:Buffer.byteLength(child.stdout??''),stderrBytes:Buffer.byteLength(child.stderr??'')});
 assert.equal(child.status,0);assert.equal(child.signal,null);assert.equal(child.error,undefined);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
}
const bundle=fs.readFileSync(path.join(target,'registration-link-repair.bundle.mjs'));
const report={at:new Date().toISOString(),sourceBytes:Buffer.byteLength(source),sourceSha256:hash(Buffer.from(source)),bundleBytes:bundle.length,bundleSha256:hash(bundle),syntax,runtimeExecuted:false,plannedWrites:'Only INSERT exact cinatoken-admin / https://cinatoken.com association after locked enabled-existing client/resource checks; conflict DO NOTHING and after.linkExists required; any failure rolls back',resourceOrClientUpdates:false,otherClientsLinked:false,rootLiveReadReference:'registration-live-readonly.json: 200 true/false/true/false/false; owned read Worker deleted and verified404'};
fs.writeFileSync(path.join(target,'prepared.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
