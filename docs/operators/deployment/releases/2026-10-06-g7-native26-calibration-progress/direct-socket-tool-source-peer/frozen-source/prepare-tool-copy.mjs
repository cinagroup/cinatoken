import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1'));
const original='C:/Users/cina/AppData/Local/Temp/cinatoken-g7-native-four-archive-prep-45cfb0f397164d5a8451d8d3c3a5b5fd/enhanced-tools';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),pins=[];
for(const name of fs.readdirSync(original).sort()){const b=fs.readFileSync(path.join(original,name));pins.push({source:path.join(original,name),file:name,bytes:b.length,sha256:sha(b)});if(name!=='evidence-lib.mjs')fs.writeFileSync(path.join(root,name),b,{flag:'wx'});}
let code=fs.readFileSync(path.join(original,'evidence-lib.mjs'),'utf8');
assert.equal(sha(Buffer.from(code)),'1a94e0682a2f9782a0bcc28c4736ff49c0bf4db0b9e0cfe0f34ecb6918b22cb7');
const replace=(before,after)=>{assert.equal(code.split(before).length,2,'Exact one source anchor');code=code.replace(before,after)};
replace("export const sha256 =", "import { directSocketClosure, directSocketAggregate, validateDirectSocketFiles } from './direct-socket-dialect.mjs';\n\nexport const sha256 =");
replace("  if (aggregateSchemas.has(value.schema)) return null;", "  if (aggregateSchemas.has(value.schema)) return null;\n  if (value.schema === 'v364-direct-socket-executor-closed-v1') return directSocketClosure(value);");
replace("const aggregateSchemas = new Set([", "const aggregateSchemas = new Set(['v364-direct-socket-closed-v1', ");
replace("function aggregateOf(value) {", "function aggregateOf(value) {\n  if (value.schema === 'v364-direct-socket-closed-v1') return directSocketAggregate(value);");
replace("['v364-owned-linux-executor-closed-v1', 'v364-owned-linux-boundary-executor-closed-v1', 'web-platform-g7-child-command-closed-v1'].includes(value?.schema)", "['v364-direct-socket-executor-closed-v1', 'v364-owned-linux-executor-closed-v1', 'v364-owned-linux-boundary-executor-closed-v1', 'web-platform-g7-child-command-closed-v1'].includes(value?.schema)");
replace("    if (receipt.dialect === 'exact-terminal-spawnSync-status') {", "    if (['v364-direct-socket-executor-closed-v1', 'v364-direct-socket-no-child-preflight-rejection-v1'].includes(receipt.dialect)) {\n      try { for (const rel of validateDirectSocketFiles({ receiptName: name, value, data: context.data, json: context.json, receiptMtime: item.mtimeMs })) associate(context, rel, receipt); }\n      catch (error) { problem(context, name, `Direct-socket executor binding rejected: ${error.message}`); }\n      continue;\n    }\n    if (receipt.dialect === 'exact-terminal-spawnSync-status') {");
fs.writeFileSync(path.join(root,'evidence-lib.mjs'),code,{flag:'wx'});
fs.writeFileSync(path.join(root,'original-enhanced-tools-pins.json'),JSON.stringify({originalDirectory:original,pins,scope:'Original frozen package unmodified; only new copy evidence-lib adds exact direct-socket module calls, all old suites byte exact'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({toolCopyPrepared:true,pins:pins.length,originalModified:false,newLibrarySha256:sha(Buffer.from(code))}));
