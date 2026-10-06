import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const repo='C:/cinagroup/cinatoken', t="C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E";
const reportPath='C:/Users/cina/AppData/Local/Temp/cinatoken-native-next-six-8d357e3fd84b4810a7210ece167eb07a/FINAL-next-five-pg73-repair.json';
const hash=b=>createHash('sha256').update(b).digest('hex');
const reportBytes=fs.readFileSync(reportPath);assert.equal(hash(reportBytes),'030316e3c0943e672eb02605f206ffadb1755f3310d014e26f19257d598a0a1f');
const report=JSON.parse(reportBytes);
const ts=createRequire(repo+'/package.json')('typescript');
const git=args=>execFileSync('C:/Program Files/Git/cmd/git.exe',args,{cwd:repo,maxBuffer:4*1024*1024});
function calls(s,name){const sf=ts.createSourceFile('fixture.mjs',s,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS), rows=[];function visit(n){if(ts.isCallExpression(n)){const e=n.expression.getText(sf);if(name==='assert' && (e==='assert'||e.startsWith('assert.'))||name==='grant'&&e==='grantPostgresRuntime')rows.push(n.getText(sf));}ts.forEachChild(n,visit);}visit(sf);return rows;}
const rows=report.files.map(item=>{const before=git(['show',report.baseCommit+':'+item.file]),after=fs.readFileSync(repo+'/'+item.file);assert.equal(before.length,item.before.bytes);assert.equal(hash(before),item.before.sha256);assert.equal(after.length,item.after.bytes);assert.equal(hash(after),item.after.sha256);const a=calls(before.toString(),'assert'),b=calls(after.toString(),'assert');assert.deepEqual(b,a);const g=calls(before.toString(),'grant');assert.deepEqual(calls(after.toString(),'grant'),g);assert.equal(a.length,item.originalAssertions);assert.equal(g.length,item.originalGrantCalls);return {file:item.file,originalAssertions:a.length,originalGrantCalls:g.length,sourceTextExact:true,workingHashExact:true};});
assert.equal(rows.reduce((n,x)=>n+x.originalAssertions,0),276);assert.equal(rows.reduce((n,x)=>n+x.originalGrantCalls,0),7);
const out={schema:'root-native-five-readonly-review-v1',at:new Date().toISOString(),closed:true,actualExit:0,baseCommit:report.baseCommit,files:rows,originalAssertions:276,originalGrantCalls:7,rawSourceTextExact:true,sourceProducerHashExact:true,realPGExecuted:false};
fs.writeFileSync(t+'/native-five-root-review.json',JSON.stringify(out,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(out));
