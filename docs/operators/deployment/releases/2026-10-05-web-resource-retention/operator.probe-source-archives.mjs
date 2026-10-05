import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyRelease} from 'file:///C:/cinagroup/cinatoken/packages/web/scripts/package-release.mjs';
const [label, releaseID] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label??'')) throw new Error('Invalid label');
const temp = path.dirname(fileURLToPath(import.meta.url));
const release = verifyRelease('C:/cinagroup/cinatoken', releaseID);
const record = {at:new Date().toISOString(),releaseId:releaseID,manifestSha256:release.manifestSha256,previousReleaseId:release.manifest.previousReleaseId,currentReleaseId:release.manifest.currentReleaseId,archives:[],actualExit:0};
for (const descriptor of release.manifest.sourceDelivery.archives) {
 const result = {path:descriptor.path,expectedBytes:descriptor.bytes,expectedSha256:descriptor.sha256,requests:[]};
 const url='https://cinatoken.com/web-assets/'+descriptor.path;
 for (const method of ['HEAD','GET']) {
  const item={method,url};
  try {
   const response=await fetch(url,{method,redirect:'manual',signal:AbortSignal.timeout(45000)});
   const body=Buffer.from(await response.arrayBuffer());
   Object.assign(item,{status:response.status,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex'),headers:Object.fromEntries(['cache-control','content-type','content-length','etag'].map(k=>[k,response.headers.get(k)]))});
   item.pass=response.status===200 && (method==='HEAD'?body.length===0:body.length===descriptor.bytes && item.sha256===descriptor.sha256);
  } catch(e) {item.pass=false;item.error=e.name+': '+e.message;}
  if(!item.pass)record.actualExit=1;
  result.requests.push(item);
 }
 record.archives.push(result);
}
record.finishedAt=new Date().toISOString();
fs.writeFileSync(path.join(temp,label+'.proof.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(record));process.exitCode=record.actualExit;
