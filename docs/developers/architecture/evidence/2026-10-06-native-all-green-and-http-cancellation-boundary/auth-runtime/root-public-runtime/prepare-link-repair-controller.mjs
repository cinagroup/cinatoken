import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
let s=fs.readFileSync(path.join(root,'read-registration-via-owned-worker.mjs'),'utf8');
assert.equal(createHash('sha256').update(s).digest('hex'),'9c957baffb6f6b128a64900416359c420a7109b510b882f4628eafdae6106a43');
const replace=(a,b)=>{assert.equal(s.split(a).length,2,a);s=s.replace(a,b);};
s=s.replaceAll('cinatoken-regmeta-','cinatoken-reglink-');
replace('registration-runtime-v2/registration-metadata.bundle.mjs','registration-link-repair/registration-link-repair.bundle.mjs');
replace('a2d547c6de353ada6eb908a4068df2f597d75a7f85ca96c76d00724f008d2e67','2e8feaf50cad98f1cb775b58ec6d2e7e2b6da527f8560aca015fd7cdaa0d0474');
replace('Temporary separate gated Worker; one BEGIN READ ONLY / SET LOCAL timeouts / fixed SELECT; then DELETE and verify404','Temporary separate gated Worker; one transaction locks enabled existing fixed client/resource, INSERT only their missing association, verify before/after; then DELETE Worker and verify404');
replace('databaseDmlOrDdl:false','databaseDmlOrDdl:true,plannedDml:"Only INSERT fixed client-resource association; no client/resource updates or other client grants"');
s=s.replaceAll('metadataRequests','repairRequests').replaceAll('report.metadata','report.repair');
replace('metadata:null','repair:null');
s=s.replaceAll('registration-owned-plan.json','registration-repair-owned-plan.json').replaceAll('registration-owned-preflight.json','registration-repair-owned-preflight.json').replaceAll('registration-live-readonly.json','registration-live-link-repair.json').replaceAll("origin+'/registration-metadata'","origin+'/registration-link-repair'");
replace("{headers:{'x-registration-probe-token':gate}","{method:'POST',headers:{'x-registration-probe-token':gate}");
const begin=s.indexOf(' if(response.status===200&&Object.keys(body).length===5');
const end=s.indexOf('\n}catch(error){',begin);
assert(begin>0&&end>begin);
s=s.slice(0,begin)+` const boolShape=value=>value&&Object.keys(value).length===5&&keys.every(k=>typeof value[k]==='boolean');
 if(response.status===200&&Object.keys(body).length===3&&boolShape(body.before)&&boolShape(body.after)&&typeof body.insertedClientLink==='boolean'&&body.after.clientExists&&!body.after.clientDisabled&&body.after.resourceExists&&!body.after.resourceDisabled&&body.after.linkExists){
  report.repair={status:response.status,observedAt:new Date().toISOString(),before:body.before,after:body.after,insertedClientLink:body.insertedClientLink};
 }else{
  const allowed=['registration_policy_blocked','registration_link_not_created','relation_unavailable','read_permission_denied','query_timeout_or_canceled','database_read_failed','probe_unavailable','connection_cleanup_failed'];
  report.repair={status:response.status,classification:allowed.includes(body.classification)?body.classification:'unexpected_response',sqlstate:typeof body.sqlstate==='string'&&/^[A-Z0-9]{5}$/.test(body.sqlstate)?body.sqlstate:null};
  throw new Error('repair_failed');
 }
`+s.slice(end);
fs.writeFileSync(path.join(root,'repair-registration-via-owned-worker.mjs'),s,{flag:'wx'});
console.log(JSON.stringify({prepared:true,bytes:Buffer.byteLength(s),sha256:createHash('sha256').update(s).digest('hex'),remoteExecuted:false}));
