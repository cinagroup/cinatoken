import fs from 'node:fs';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
const t="C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E",root='C:/cinagroup/cinatoken',git='C:/Program Files/Git/cmd/git.exe',base='6658ec978009afa5fe3f4beccf6bde358590b663';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(fs.readFileSync(p));
const beforePlan=json(t+'/changeset-plan-before.json'),afterPlan=json(t+'/changeset-plan-after.json');
const names=['cinatoken','@octafuse/core','@octafuse/tool-engines','@octafuse/proxy','@octafuse/admin','@cinatoken/web'];
assert.deepEqual(beforePlan.releases.map(r=>r.name),names.slice(0,5));assert.deepEqual(afterPlan.releases.map(r=>r.name),names);
assert.deepEqual(afterPlan.changesets,beforePlan.changesets);assert.deepEqual(afterPlan.releases.slice(0,5),beforePlan.releases);
assert.ok(afterPlan.releases.every(r=>r.oldVersion==='2.8.0'&&r.newVersion==='2.9.0'));
const oldConfig=spawnSync(git,['show',base+':.changeset/config.json'],{cwd:root,windowsHide:true});assert.equal(oldConfig.status,0);
fs.writeFileSync(t+'/changeset-config-before.json',oldConfig.stdout,{flag:'wx'});
const old=json(t+'/changeset-config-before.json'),current=json(root+'/.changeset/config.json');assert.deepEqual(current,{...old,fixed:[[...old.fixed[0],'@cinatoken/web']]});
const manifests=['package.json',...['core','tool-engines','proxy','admin','web'].map(p=>'packages/'+p+'/package.json')];
const manifestProof=[];
for(const p of manifests){const gitResult=spawnSync(git,['show',base+':'+p],{cwd:root,windowsHide:true});assert.equal(gitResult.status,0);const b=fs.readFileSync(root+'/'+p);assert.deepEqual(b,gitResult.stdout);assert.equal(JSON.parse(b).version,'2.8.0');manifestProof.push({file:p,bytes:b.length,sha256:hash(b),version:'2.8.0'});}
const edits=[
 ['.changeset/README.md','根包 `cinatoken` 与 `@octafuse/core` / `@octafuse/proxy` / `@octafuse/admin`','根包 `cinatoken` 与 `@octafuse/core` / `@octafuse/tool-engines` / `@octafuse/proxy` / `@octafuse/admin` / `@cinatoken/web`'],
 ['docs/maintainers/release-versioning.md','`cinatoken` + `@octafuse/core` / `@octafuse/proxy` / `@octafuse/admin`','`cinatoken` + `@octafuse/core` / `@octafuse/tool-engines` / `@octafuse/proxy` / `@octafuse/admin` / `@cinatoken/web`'],
 ['docs/maintainers/release-versioning.md','根包与三个 workspace','根包与五个 workspace（Core、Tool Engines、Proxy、Admin、Web）'],
 ['docs/maintainers/release-versioning.md','（与 `@octafuse/*` 同版本）','（与 `@octafuse/*`、`@cinatoken/web` 同版本）']
];
const documents=new Map();
for(const [p,a,b]of edits){if(!documents.has(p)){const before=fs.readFileSync(root+'/'+p);fs.writeFileSync(t+'/'+p.replaceAll('/','__')+'.before',before,{flag:'wx'});documents.set(p,{before,text:before.toString()});}const d=documents.get(p);assert.equal(d.text.split(a).length,2,p+' anchor');d.text=d.text.replace(a,b);}
for(const [p,d]of documents){fs.writeFileSync(root+'/'+p,d.text);d.after=fs.readFileSync(root+'/'+p);}
const proof={at:new Date().toISOString(),closed:true,actualExitCode:0,baseCommit:base,actualChangesetsCliPlanBefore:{releases:5,webIncluded:false},actualChangesetsCliPlanAfter:{releases:6,webIncluded:true,newVersion:'2.9.0'},existingFiveReleaseEntriesExact:true,allCurrentManifestBytesExact:true,currentVersionUnchanged:'2.8.0',productionMutation:false,repositoryPermissionMutation:false,draftVersionCandidateNotMerged:true,manifestProof,config:{before:{bytes:oldConfig.stdout.length,sha256:hash(oldConfig.stdout)},after:{bytes:fs.statSync(root+'/.changeset/config.json').size,sha256:hash(fs.readFileSync(root+'/.changeset/config.json'))}},documents:[...documents].map(([p,d])=>({file:p,before:{bytes:d.before.length,sha256:hash(d.before)},after:{bytes:d.after.length,sha256:hash(d.after)}}))};
fs.writeFileSync(t+'/release-fixed-group-repair.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({actualExitCode:0,beforeReleaseCount:5,afterReleaseCount:6,allCurrentVersions:'2.8.0',productionMutation:false}));
