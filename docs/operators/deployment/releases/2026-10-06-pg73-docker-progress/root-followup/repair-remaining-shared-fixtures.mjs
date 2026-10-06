import fs from 'node:fs';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';
const temp="C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-platform-followup-20261006-lAiHQC",cwd='C:/cinagroup/cinatoken';const require=createRequire(cwd+'/package.json');const {parse}=require('@babel/parser');const hash=b=>crypto.createHash('sha256').update(b).digest('hex');const clean=x=>JSON.parse(JSON.stringify(x,(k,v)=>['start','end','loc','extra','leadingComments','trailingComments','innerComments'].includes(k)?undefined:v));
function assertions(source){const result=[];function visit(n){if(!n||typeof n!=='object')return;if(n.type==='CallExpression'&&n.callee?.type==='MemberExpression'&&n.callee.object?.name==='assert')result.push(clean(n));for(const [k,v]of Object.entries(n)){if(['loc','extra','comments','tokens'].includes(k))continue;if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);}}visit(parse(source,{sourceType:'module'}));return result;}
const specs=[
  {
    "name": "postgres-shared-key-snapshot-earning-consumer.native.test.mjs",
    "variable": "files",
    "loader": "const files=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();",
    "grants": 0
  },
  {
    "name": "postgres-shared-key-economic-delivery.native.test.mjs",
    "variable": "files",
    "loader": "const files=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();",
    "grants": 0
  },
  {
    "name": "postgres-shared-key-credited-usage-gap.native.test.mjs",
    "variable": "files",
    "loader": "const files=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();",
    "grants": 0
  },
  {
    "name": "postgres-shared-key-credited-usage-store.native.test.mjs",
    "variable": "files",
    "loader": "const files=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();",
    "grants": 0
  }
];
const records=[];for(const s of specs){const file='scripts/db/cutover/'+s.name;const before=fs.readFileSync(cwd+'/'+file);const tracked=spawnSync('C:/Program Files/Git/cmd/git.exe',['show','HEAD:'+file],{cwd,windowsHide:true,maxBuffer:2_000_000});assert.equal(tracked.status,0);assert.deepEqual(before,tracked.stdout);fs.writeFileSync(temp+'/'+s.name+'.before',before,{flag:'wx'});let source=before.toString();const beforeAssertions=assertions(source);const eol=source.includes('\r\n')?'\r\n':'\n';const edits=[];function replace(from,to,count=1){assert.equal(source.split(from).length-1,count);source=source.replaceAll(from,to);edits.push({from,to,count});}
 replace("import { readFile, readdir, writeFile } from 'node:fs/promises';","import { readFile, writeFile } from 'node:fs/promises';");
 if(s.grants){replace("import { grantPostgresRuntime } from './grant-postgres-runtime.ts';","import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';");replace('await grantPostgresRuntime({ DATABASE_URL: url });','await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: url });',2);}else{replace("import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';","import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';"+eol+"import { listPg73Migrations } from './pg73-native-fixture.mjs';");}
 replace(s.loader,'const '+s.variable+' = await listPg73Migrations();');assert.deepEqual(assertions(source),beforeAssertions);assert.ok(source.includes('assert.equal('+s.variable+'.length,'));assert.ok(!source.includes('readdir('));assert.equal((source.match(/grantPg73RuntimeFixture\(\{/g)||[]).length,s.grants);let reconstructed=source;for(const edit of [...edits].reverse())reconstructed=reconstructed.replaceAll(edit.to,edit.from);assert.equal(reconstructed,before.toString());fs.writeFileSync(cwd+'/'+file,source);const after=fs.readFileSync(cwd+'/'+file);fs.writeFileSync(temp+'/'+s.name+'.after',after,{flag:'wx'});records.push({file,before:{bytes:before.length,sha256:hash(before)},after:{bytes:after.length,sha256:hash(after)},orderedOriginalAssertionCalls:beforeAssertions.length,assertionAstExact:true,allOtherOriginalTextExact:true,edits,successfulGrantAdaptations:s.grants,grantNegativeCallsChanged:0});}
const result={at:new Date().toISOString(),actualExit:0,scope:'historical PG73 test fixtures only',nativePassClaim:false,productionChanges:false,records};fs.writeFileSync(temp+'/remaining-shared-fixture-repair.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
