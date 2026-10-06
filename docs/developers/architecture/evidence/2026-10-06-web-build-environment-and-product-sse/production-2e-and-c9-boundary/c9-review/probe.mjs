import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire,builtinModules} from 'node:module';
const repo='C:/cinagroup/cinatoken';
const artifact='C:/Users/cina/AppData/Local/Temp/cinatoken-web-foundation-5b11fb36c4074c9da1317f28ef4c7111/product-c9-artifact/product-sse-cancel-37452189276-1/product-sse-cancel-37452189276-1/fixture';
const out=process.argv[2];
const require=createRequire(repo+'/package.json');
const sha=b=>createHash('sha256').update(b).digest('hex');
const source=readFileSync(join(artifact,'worker-source.mjs'),'utf8');
const bundle=readFileSync(join(artifact,'worker-bundle.mjs'),'utf8');
assert.equal(sha(bundle),'4af70bbec058fa852e68c30299b1798ffd56af46195abef22f5a935045942198');
const originalFetch=globalThis.fetch;
async function probe(file,label){
 const calls=[];
 globalThis.fetch=async(input,init)=>{const url=String(input);calls.push({url,method:init?.method});if(url==='http://127.0.0.1:1/observe')return new Response(null,{status:204});throw Error('SYNTHETIC_UPSTREAM_REACHED_NO_NETWORK');};
 try {const worker=(await import(pathToFileURL(file).href)).default;await worker.fetch(new Request('http://127.0.0.1:1/fixture/product-sse',{method:'POST'}),{OBSERVATION_URL:'http://127.0.0.1:1/observe',UPSTREAM_BASE:'http://127.0.0.1:1/v1'},{waitUntil(){throw Error('unexpected waitUntil before dispatch');}});return {label,calls,error:null};}
 catch(e){return {label,calls,error:{name:e.name,message:e.message,stack:e.stack}};}
 finally{globalThis.fetch=originalFetch;}
}
const results=[await probe(join(artifact,'worker-bundle.mjs'),'exact-artifact-synthetic-Node')];
const injected=join(out,'initializer-only-diagnostic.mjs');
writeFileSync(injected,bundle+'\ninit_provider_endpoints();\n',{flag:'wx'});
results.push(await probe(injected,'same-artifact-one-init-call-diagnostic'));
for(const [label,extra] of [['ignoreAnnotations',{ignoreAnnotations:true}],['treeShakingFalse',{treeShaking:false}]]){
 const built=await require('esbuild').build({stdin:{contents:source,resolveDir:repo,sourcefile:'product-sse-cancel-worker.mjs',loader:'js'},bundle:true,format:'esm',platform:'browser',target:'es2022',conditions:['workerd','worker','browser'],external:[...builtinModules,...builtinModules.map(x=>'node:'+x)],metafile:true,write:false,...extra});
 const bytes=built.outputFiles[0].contents;const file=join(out,label+'.mjs');writeFileSync(file,bytes,{flag:'wx'});
 const text=Buffer.from(bytes).toString('utf8');
 results.push({...await probe(file,label),bundleBytes:bytes.length,bundleSha:sha(bytes),providerInitOccurrences:(text.match(/init_provider_endpoints\(\)/g)||[]).length,coreSourceSelected:Object.hasOwn(built.metafile.inputs,'packages/core/src/index.ts'),coreDistSelected:Object.keys(built.metafile.inputs).some(x=>x.startsWith('packages/core/dist/'))});
}
const report={schema:'product-c9-readonly-bundle-initialization-probe-v1',at:new Date().toISOString(),mode:'Node with synthetic fetch stub only; no Workerd/native acceptance/production/database/network',sourceSha:'c9fc6e7b7f8ceffc60a6068f4cb105e4ac5f633b',artifactBundleSha:sha(bundle),results};
writeFileSync(join(out,'bundle-initialization-probe.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
