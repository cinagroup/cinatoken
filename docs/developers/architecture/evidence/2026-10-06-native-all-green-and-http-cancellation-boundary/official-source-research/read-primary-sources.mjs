import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const out=path.dirname(fileURLToPath(import.meta.url));
const at=new Date().toISOString(),records=[];
const sha=b=>createHash('sha256').update(b).digest('hex');
async function get(url,label){
  const parsed=new URL(url);assert(['api.github.com','raw.githubusercontent.com'].includes(parsed.hostname));
  assert(parsed.pathname.startsWith('/repos/cloudflare/workerd/')||parsed.pathname.startsWith('/cloudflare/workerd/'));
  const startedAt=new Date().toISOString();
  try {const response=await fetch(url,{method:'GET',headers:{'User-Agent':'cinatoken-readonly-primary-source-research','Accept':parsed.hostname==='api.github.com'?'application/vnd.github+json':'text/plain'},signal:AbortSignal.timeout(15000)});const raw=Buffer.from(await response.arrayBuffer());
    const record={label,url,method:'GET',startedAt,finishedAt:new Date().toISOString(),status:response.status,contentType:response.headers.get('content-type'),bytes:raw.length,sha256:sha(raw),utf8:raw.toString('utf8')};records.push(record);assert.equal(response.status,200,label+' status');return record;
  } catch(error){records.push({label,url,method:'GET',startedAt,finishedAt:new Date().toISOString(),transportOrValidationError:error.message});throw error;}
}
let terminalError=null;
try {
  const ref=JSON.parse((await get('https://api.github.com/repos/cloudflare/workerd/git/ref/tags/v1.20260828.1','locked-tag-ref')).utf8);
  let object=ref.object;
  if(object.type==='tag')object=JSON.parse((await get(object.url,'locked-tag-peel')).utf8).object;
  assert.equal(object.type,'commit');assert(/^[0-9a-f]{40}$/.test(object.sha));
  await Promise.all([
    get('https://api.github.com/repos/cloudflare/workerd/releases/tags/v1.20260828.1','locked-release'),
    get('https://api.github.com/repos/cloudflare/workerd/issues/6832','issue-6832-current'),
    get('https://api.github.com/repos/cloudflare/workerd/pulls/6833','pr-6833-current'),
    ...['api/streams/standard.c++','api/streams/readable.c++','api/http.c++','io/worker-entrypoint.c++'].map(p=>get('https://raw.githubusercontent.com/cloudflare/workerd/'+object.sha+'/src/workerd/'+p,'locked-source-'+p))
  ]);
} catch(error){terminalError={name:error.name,message:error.message};process.exitCode=1;}
finally {const snapshot={schema:'workerd-primary-source-get-observation-v1',at,finishedAt:new Date().toISOString(),readOnly:true,repositoryWrites:0,productionRequests:0,runtimeExecuted:false,baselineRuntimeChanged:false,terminalError,records};fs.writeFileSync(path.join(out,'primary-source-records.json'),JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({readOnly:true,requests:records.length,statuses:records.map(r=>({label:r.label,status:r.status,error:r.transportOrValidationError??null})),terminalError,sourceSnapshot:'primary-source-records.json'}));}
