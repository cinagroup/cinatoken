import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';
import{out,repo,info}from'./capture.mjs';
const input=JSON.parse(await readFile(join(out,'inputs.json'),'utf8'));
const installed=JSON.parse(await readFile(join(repo,'node_modules/postgres/package.json'),'utf8'));assert.equal(installed.version,'3.4.9');assert.equal(input.driver.lockVersion,'3.4.9');
for(const p of input.protection.filter(p=>/^node_modules\/postgres\//.test(p.path)))assert.deepEqual(info(await readFile(join(repo,p.path))),{bytes:p.bytes,sha256:p.sha256});
// Load only the installed driver's type serializers; no postgres client/connection is constructed.
const{serializers}=await import(pathToFileURL(join(repo,'node_modules/postgres/src/types.js')).href);
assert.equal(typeof serializers[1184],'function');assert.equal(typeof serializers[25],'function');
const microseconds='2026-10-06 05:45:00.123456+00',milliseconds='2026-10-06 05:45:00.123+00';
const cases=[['microsecond-text',microseconds],['millisecond-control',milliseconds]].map(([label,value])=>({label,input:value,
 timestampSerialize1184:serializers[1184](value),textSerialize25:serializers[25](value)}));
for(const c of cases){assert.equal(c.timestampSerialize1184,'2026-10-06T05:45:00.123Z');assert.equal(c.textSerialize25,c.input)}
const report={at:new Date().toISOString(),actualExit:0,driverVersion:'3.4.9',lock:input.driver,
 installedTypeSource:input.protection.find(p=>p.path==='node_modules/postgres/src/types.js'),
 realFunctionSources:{timestamp1184:serializers[1184].toString(),text25:serializers[25].toString()},cases,
 observedMechanism:'The actual installed3.4.9 timestamp serializer normalizes both inputs through JavaScript Date to millisecond ISO text; its text serializer preserves the controlled original input strings.',
 boundary:'This directly exercises real driver serializer functions offline. It does not establish the server-inferred parameter OID, actual PG timing/root cause, or native fixture pass.',
 databaseExecuted:false,postgresClientCreated:false,nativeExecuted:false,rootCauseConfirmed:false};
await writeFile(join(out,'offline-serialize-proof.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
