import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {out,info} from './capture.mjs';
const prior='C:/Users/cina/AppData/Local/Temp/cinatoken-6e2-ci-terminal-observer-dbbc0b1231e543eb99e18eb9bbe45370';
const oldSha='6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa',sha='757490181564aa822f960f5d8704857b98b230d0';
const names=['observe-initial.mjs','watch-proxy.mjs','prepare-map.mjs','collect-terminal.mjs','analyze-terminal.mjs','close-audit.mjs','seal-terminal.mjs'];
const pins=[];
for(const name of names){
 const raw=await readFile(join(prior,name));let code=raw.toString('utf8').replaceAll(oldSha,sha).replaceAll('cinatoken-6e2-','cinatoken-757-');
 if(name==='observe-initial.mjs')code=code.replace('for(const r of runs)assert.equal(r.headSha,sha);',"for(const r of runs){assert.equal(r.headSha,sha);assert.equal(r.event,'push');}");
 if(name==='watch-proxy.mjs')code=code.replaceAll('37424911830','37429192670');
 if(name==='collect-terminal.mjs')code=code.replace("watch=await load('proxy-watch-2.closed.json'),watchHistory=[await load('proxy-watch-1.closed.json'),watch]","watch=await load('proxy-watch-1.closed.json'),watchHistory=[watch]");
 if(name==='analyze-terminal.mjs'){
  code=code.replace('bootstrap7:entries.find(e=>e.step===7),quote24:entries.find(e=>e.step===24),', 'bootstrap7:entries.find(e=>e.step===7),quote24:entries.find(e=>e.step===24),retention90:entries.find(e=>e.step===90),');
  code=code.replace('frozen94:report.native.frozen94.actual.conclusion,', 'retention90:{status:report.native.retention90.actual.conclusion,tap:simpleTap(report.native.retention90)},frozen94:report.native.frozen94.actual.conclusion,');
 }
 if(name==='close-audit.mjs')code=code.replace('final.native.bootstrap7,final.native.quote24,final.native.frozen94,','final.native.bootstrap7,final.native.quote24,final.native.retention90,final.native.frozen94,');
 assert.ok(!code.includes(oldSha));assert.ok(!code.includes('37424911830'));
 const bytes=Buffer.from(code);await writeFile(join(out,name),bytes,{flag:'wx'});pins.push({name,reusedToolSourceOnly:{path:join(prior,name),...info(raw)},newTool:info(bytes)});
}
await writeFile(join(out,'TOOL-source-provenance.json'),JSON.stringify({sourceSha:sha,toolFiles:7,oldReportsOrMetadataCopied:0,pins},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceSha:sha,toolFiles:7,originalRun:37429192670,oldReportsOrMetadataCopied:0,watchIntervalSeconds:45,completeLogOrder:['native','dispatch']}));
