import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash,randomBytes} from 'node:crypto';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),prepared='C:/Users/cina/AppData/Local/Temp/cinatoken-registration-preview-readonly-prepared-mqVPEM',runtime=path.join(here,'registration-runtime');
const sha=b=>createHash('sha256').update(b).digest('hex');fs.mkdirSync(runtime);
const original=fs.readFileSync(path.join(prepared,'registration-metadata.worker.mjs'),'utf8');assert.equal(sha(Buffer.from(original)),'38880c12a7c7107fc7906358f48d546294aa7fa21b939197810582ffc72b6b6b');
const block=`onnotice: () => {},
        connection: {
          application_name: 'cinatoken_registration_metadata_readonly',
          default_transaction_read_only: true,
          statement_timeout: 5000,
          lock_timeout: 2000,
          idle_in_transaction_session_timeout: 7000
        }`;assert.equal(original.split(block).length,2);
let source=original.replace(block,"onnotice: () => {}");
const before="const rows = await sql.begin('read only', transaction => transaction.unsafe(SELECT_METADATA, [CLIENT_ID, RESOURCE_ID]));";
assert.equal(source.split(before).length,2);source=source.replace(before,`const rows = await sql.begin('read only', async transaction => {
        await transaction.unsafe('SET LOCAL statement_timeout = 5000');
        await transaction.unsafe('SET LOCAL lock_timeout = 2000');
        await transaction.unsafe('SET LOCAL idle_in_transaction_session_timeout = 7000');
        return transaction.unsafe(SELECT_METADATA, [CLIENT_ID, RESOURCE_ID]);
      });`);
fs.writeFileSync(path.join(runtime,'registration-metadata.worker.mjs'),source,{flag:'wx'});
const require=createRequire('C:/cinagroup/cinatoken/package.json'),esbuild=require('esbuild'),postgresRoot=path.dirname(require.resolve('postgres/package.json'));
await esbuild.build({stdin:{contents:source,sourcefile:'registration-metadata.worker.mjs',resolveDir:'C:/cinagroup/cinatoken'},outfile:path.join(runtime,'registration-metadata.bundle.mjs'),bundle:true,format:'esm',platform:'neutral',conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],alias:{postgres:path.join(postgresRoot,'cf/src/index.js')},target:'es2022',logLevel:'silent'});
const bundle=fs.readFileSync(path.join(runtime,'registration-metadata.bundle.mjs'));fs.writeFileSync(path.join(runtime,'prepared.json'),JSON.stringify({sourceBytes:Buffer.byteLength(source),sourceSha256:sha(Buffer.from(source)),bundleBytes:bundle.length,bundleSha256:sha(bundle),runtimeExecuted:false,rowOrSchemaWrites:false,rootDelta:'Only replace session startup GUCs by transaction-local timeouts; BEGIN READ ONLY and fixed one SELECT remain',originalSourceSha256:sha(Buffer.from(original))},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({prepared:true,sourceSha256:sha(Buffer.from(source)),bundleSha256:sha(bundle),runtimeExecuted:false}));

