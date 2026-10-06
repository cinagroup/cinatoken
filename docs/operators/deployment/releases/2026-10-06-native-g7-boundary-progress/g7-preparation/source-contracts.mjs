import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root='C:/cinagroup/cinatoken';
const out='C:/Users/cina/AppData/Local/Temp/cinatoken-g7-tls-pg-package-20261006-552eab3dd02f4b15a01d765d9a2aab8f';
const require=createRequire(`${root}/package.json`);
const acorn=require('acorn');const YAML=require('yaml');
const hash=b=>createHash('sha256').update(b).digest('hex');
const parse=b=>acorn.parse(b,{sourceType:'module',ecmaVersion:'latest'});
const normalize=v=>{if(Array.isArray(v))return v.map(normalize);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!['start','end','loc','raw'].includes(k)).map(([k,x])=>[k,normalize(x)]));return v};
function walk(value,visit){if(!value||typeof value!=='object')return;visit(value);for(const item of Object.values(value))if(Array.isArray(item))item.forEach(v=>walk(v,visit));else if(item&&typeof item==='object')walk(item,visit)}
const astChecks=[];
for(const name of ['admission.mjs','admission.test.mjs','database.mjs','wire.mjs']){
const p=`scripts/verification/web-platform-g7/${name}`;
const before=parse(readFileSync(`${out}/before-format/${p}`,'utf8'));
const after=parse(readFileSync(`${root}/${p}`,'utf8'));
assert.deepEqual(normalize(after),normalize(before),name);
astChecks.push({name,formatOnlyASTExact:true});}
// The runner gained two nonempty decimal/0..255 Docker-wait admissions after formatting.
const runner='scripts/verification/web-platform-g7/run-owned-linux.mjs';
const original=parse(readFileSync(`${out}/before-format/${runner}`,'utf8'));
const amended=parse(readFileSync(`${root}/${runner}`,'utf8'));
let removed=0,integerRestored=0;
walk(amended,node=>{if(Array.isArray(node.body))node.body=node.body.filter(s=>{const c=s.type==='ExpressionStatement'&&s.expression;if(c?.type==='CallExpression'&&c.callee?.object?.name==='assert'&&c.callee?.property?.name==='match'&&['result','wait'].includes(c.arguments[0]?.callee?.object?.object?.name)&&c.arguments[0]?.callee?.object?.property?.name==='stdout'){removed++;return false}return true});if(node.type==='CallExpression'&&node.callee?.object?.name==='assert'&&node.callee?.property?.name==='ok'&&node.arguments[0]?.type==='LogicalExpression'&&['actualExit','qaExit'].includes(node.arguments[0]?.left?.arguments?.[0]?.name)){assert.equal(node.arguments[0].right.operator,'<=');assert.equal(node.arguments[0].right.right.value,255);node.arguments[0]=node.arguments[0].left;integerRestored++;}});
assert.equal(removed,2);assert.equal(integerRestored,2);assert.deepEqual(normalize(amended),normalize(original));
astChecks.push({name:'run-owned-linux.mjs',formatASTExactApartFromTwoStrictWaitAdmissions:true});
const source=readFileSync(`${root}/scripts/verification/web-platform-g7/database.mjs`,'utf8');
let literals=[];walk(parse(source),node=>{if(node.type==='TemplateLiteral'&&node.expressions.length===0&&node.quasis[0].value.cooked?.includes('INSERT INTO cinatoken_gateway.providers'))literals.push(node.quasis[0].value.cooked)});assert.equal(literals.length,1);
const csv=s=>{const items=[];let begin=0,quote=false,depth=0;for(let i=0;i<s.length;i++){const c=s[i];if(c==="'"){if(quote&&s[i+1]==="'"){i++;continue}quote=!quote}else if(!quote){if(c==='(')depth++;if(c===')')depth--;if(c===','&&depth===0){items.push(s.slice(begin,i).trim());begin=i+1}}}assert.equal(quote,false);assert.equal(depth,0);items.push(s.slice(begin).trim());return items};
const now=new Date();
const value=s=>s.startsWith("'")&&s.endsWith("'")?s.slice(1,-1).replaceAll("''","'"):s==='false'?false:s==='true'?true:s==='null'?null:/^\d+$/.test(s)?Number(s):s==='now()'?now.toISOString():s==="now()+interval '1 day'"?new Date(now.getTime()+86400000).toISOString():s;
const rows={};for(const match of literals[0].matchAll(/INSERT INTO cinatoken_gateway\.([a-z_]+)\(([^)]+)\)\s+VALUES\s*\(([\s\S]*?)\);/g)){const cols=csv(match[2]),vals=csv(match[3]);assert.equal(cols.length,vals.length,match[1]);rows[match[1]]=Object.fromEntries(cols.map((c,i)=>[c,value(vals[i])]))}
assert.equal(Object.keys(rows).length,6);
const {parseVerifiedModelEndpointSnapshot,modelEndpointSupportsOperation}=await import(pathToFileURL(`${root}/packages/core/src/model-endpoint-runtime.ts`));
const {computeRouteDataPolicySubjectFingerprintFromRows}=await import(pathToFileURL(`${root}/packages/core/src/route-data-policy.ts`));
const {parseProviderEndpoints}=await import(pathToFileURL(`${root}/packages/core/src/provider-endpoints.ts`));
const endpoint={endpoint_class:null,region:null,quantization:null,image_capabilities:'{}',audio_capabilities:'{}',created_at:now.toISOString(),updated_at:now.toISOString(),...rows.model_endpoints};
const snapshot=parseVerifiedModelEndpointSnapshot(endpoint,now);assert.ok(snapshot);assert.equal(modelEndpointSupportsOperation(snapshot,'chat.completions'),true);assert.equal(modelEndpointSupportsOperation(snapshot,'images.generations'),false);assert.equal(modelEndpointSupportsOperation(snapshot,'audio.speech'),false);
assert.equal(parseVerifiedModelEndpointSnapshot({...endpoint,expires_at:new Date(now.getTime()-1).toISOString()},now),null);
assert.equal(parseVerifiedModelEndpointSnapshot({...endpoint,supports_voice_cloning:null},now),null);
const provider={...rows.providers,api_key:'local-nonsecret-producer-contract-only'};const route=rows.model_routes;
assert.equal(parseProviderEndpoints(provider).openai.base,'https://provider.test/v1');
const fingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(route,provider);assert.match(fingerprint,/^[a-f0-9]{64}$/);assert.notEqual(await computeRouteDataPolicySubjectFingerprintFromRows(route,{...provider,api_key:'different-local-nonsecret'}),fingerprint);assert.notEqual(await computeRouteDataPolicySubjectFingerprintFromRows({...route,provider_model_name:'different-local-model'},provider),fingerprint);
const doc=YAML.parse(readFileSync(`${root}/.github/workflows/web-platform-g7.yml`,'utf8'));assert.deepEqual(Object.keys(doc.on),['workflow_dispatch']);assert.deepEqual(doc.permissions,{contents:'read'});assert.equal(doc.jobs['owned-linux']['timeout-minutes'],60);
assert.equal(existsSync(`${out}/never-created-runtime`),false);
const result={schema:'web-platform-g7-local-source-contracts-v1',actualExit:0,astChecks,sqlLiteralTables:Object.keys(rows),actualCoreParserAcceptedTextFixture:true,wrongOperationExpiredUnknownCapabilityRejected:true,actualCoreCredentialAndRouteFingerprintNegatives:true,workflowManualOnly:true,windowsRuntimeAdmissionRejectedBeforeOutputCreation:true,source:{databaseSha256:hash(Buffer.from(source))},nativePG:false,actualDocker:false,actualTLS:false,productionRequests:0};
writeFileSync(`${out}/source-contracts-report.json`,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
