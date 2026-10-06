import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {join,normalize,basename} from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const out=process.argv[2],repo='C:/cinagroup/cinatoken',root='C:/Users/cina/AppData/Local/Temp/cinatoken-g7-native53-20261006-b5c5ae279d804d44b08535e386e82504',art=join(root,'g7-artifact-current');
const source='473de5fc520fc7d64db700db88a76c7a6b45c241',base='702c4d71379acb697024ef846725871582bff94f';
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
const bytes=p=>readFileSync(normalize(p)),json=p=>JSON.parse(bytes(p).toString('utf8')),j=n=>json(join(art,n));
const write=(name,v)=>writeFileSync(join(out,name),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const check=(b,claim)=>assert.deepEqual(info(b),{bytes:claim.bytes,sha256:claim.sha256});
const validTime=t=>Number.isFinite(Date.parse(t));
const rootFiles=new Map(),rootReceipts=[];
function remember(p){const b=bytes(p);rootFiles.set(p,info(b));return b;}
function rootReceipt(prefix){
 const path=join(root,prefix+'.result.json'),r=JSON.parse(remember(path).toString('utf8'));
 assert.ok(validTime(r.at)&&validTime(r.finishedAt)&&Date.parse(r.finishedAt)>=Date.parse(r.at));assert.equal(r.actualExit,0);assert.equal(r.signal,null);assert.ok(!r.error&&!r.spawnError);
 const streamProofs={};
 for(const stream of ['stdout','stderr']){
  const d=r[stream];assert.ok(typeof d==='string'||(d&&typeof d==='object'&&typeof d.path==='string'));
  const p=normalize(typeof d==='string'?d:d.path);assert.equal(p,normalize(join(root,prefix+'.'+stream+'.log')));
  const b=remember(p);if(typeof d==='object')check(b,d);
  streamProofs[stream]={path:p,...info(b),producerByteHashDeclared:typeof d==='object',producerDeclaredByteHashVerified:typeof d==='object',peerObservedByteHashPinned:true};
 }
 rootReceipts.push({file:path,...info(bytes(path)),actualExit:r.actualExit,at:r.at,finishedAt:r.finishedAt,args:r.args,stdout:streamProofs.stdout,stderr:streamProofs.stderr});
}
for(const p of ['native-terminal-log','proxy-progress-2.raw','dispatch-terminal-failed','analyze-native-terminal','g7-progress-3.raw','g7-artifact-list','g7-artifact-download','g7-terminal-log'])rootReceipt(p);
const nativeBytes=remember(join(root,'native-terminal-log.stdout.log'));
check(nativeBytes,{bytes:327916,sha256:'4203c059c01c7097c650376d0148120244536cd2fe6931095ee0414b930f00a5'});
const g7LogBytes=remember(join(root,'g7-terminal-log.stdout.log'));
check(g7LogBytes,{bytes:221235,sha256:'0fc82f08adb4663cee12ef6cca0b7041c30b0c3849587e63290e9bc071b0ec77'});
const proxyRun=json(join(root,'proxy-progress-2.raw.stdout.log')),g7Run=json(join(root,'g7-progress-3.raw.stdout.log'));
assert.equal(proxyRun.databaseId,37409463636);assert.equal(proxyRun.headSha,source);assert.equal(proxyRun.status,'completed');assert.equal(proxyRun.conclusion,'failure');
assert.equal(g7Run.databaseId,37409541185);assert.equal(g7Run.headSha,source);assert.equal(g7Run.status,'completed');assert.equal(g7Run.conclusion,'success');
assert.equal(g7Run.jobs.length,1);assert.equal(g7Run.jobs[0].databaseId,112094637092);assert.equal(g7Run.jobs[0].conclusion,'success');
for(const n of [5,6,7,8,9,10])assert.equal(g7Run.jobs[0].steps.find(s=>s.number===n).conclusion,'success');
const nativeJob=proxyRun.jobs.find(j=>j.databaseId===112094395119),dispatchJob=proxyRun.jobs.find(j=>j.databaseId===112094395070);
assert.equal(nativeJob.conclusion,'failure');assert.equal(dispatchJob.conclusion,'failure');assert.equal(dispatchJob.steps.find(s=>s.number===27).conclusion,'failure');
const nativeCases=['postgres-complete-text-legacy-reaper-fence-v366.native.test.mjs','postgres-complete-text-all-hold-renewal-v367.native.test.mjs','postgres-complete-text-buyer-counter-cutover-v367.native.test.mjs','postgres-complete-text-legacy-buyer-held-v368.native.test.mjs','postgres-buyer-held-opt-in-gap-v370.native.test.mjs','postgres-legacy-buyer-window-accountant-v371.native.test.mjs','postgres-legacy-buyer-windowed-app-v372.native.test.mjs','postgres-legacy-buyer-windowed-app-privileges-v374.native.test.mjs'];
const nativeText=nativeBytes.toString('utf8'),nativeResults=[];
assert.match(nativeText,/postgres:18\.6-bookworm/);assert.match(nativeText,/PG_VERSION=18\.6-/);
function metrics(group){return Object.fromEntries(['tests','pass','fail','skipped','cancelled','todo'].map(name=>{const all=[...group.matchAll(new RegExp('# '+name+' ([0-9]+)','g'))];assert.equal(all.length,1,'Exactly one TAP total '+name);return [name,Number(all[0][1])];}));}
for(let i=0;i<nativeCases.length;i++){
 const file=nativeCases[i],command='node --import tsx --test scripts/db/cutover/'+file,at=nativeText.indexOf(command);
 assert.ok(at>=0);const start=nativeText.lastIndexOf('##[group]',at);let end=nativeText.indexOf('##[group]',at);if(end<0)end=nativeText.indexOf('\tPost Run actions/checkout@v4\t',at);assert.ok(start>=0&&end>at);
 const group=nativeText.slice(start,end),tap=metrics(group),step=nativeJob.steps.find(s=>s.number===53+i);
 assert.equal(tap.tests,1);assert.equal(tap.skipped,0);assert.equal(tap.cancelled,0);assert.equal(tap.todo,0);
 assert.equal(tap.pass,i<7?1:0);assert.equal(tap.fail,i<7?0:1);assert.equal(step.conclusion,i<7?'success':'failure');
 if(i===7){assert.match(group,/81 !== 73/);assert.ok(group.includes(file+':125:14'));assert.match(group,/Process completed with exit code 1\./);}
 nativeResults.push({step:53+i,file,conclusion:step.conclusion,startedAt:step.startedAt,completedAt:step.completedAt,tap,rawGroup:info(Buffer.from(group)),changedInThisBatch:i<4,observedFailure:i===7?{actual:81,expected:73,line:125,column:14,originalProcessExit:1}:null});
}
const dispatchBytes=remember(join(root,'dispatch-terminal-failed.stdout.log')),dispatchText=dispatchBytes.toString('utf8'),dispatchTap=metrics(dispatchText);
assert.deepEqual(dispatchTap,{tests:8,pass:7,fail:1,skipped:0,cancelled:0,todo:0});assert.match(dispatchText,/Process completed with exit code 1\./);
const rootAnalysisBytes=remember(join(root,'native-terminal-analysis.json')),rootAnalysis=JSON.parse(rootAnalysisBytes.toString('utf8'));
assert.equal(rootAnalysis.sourceCommit,source);assert.equal(rootAnalysis.overallCI,'failure');assert.equal(rootAnalysis.fullPipelinePassDerived,false);
for(let i=0;i<nativeResults.length;i++){const actual=nativeResults[i],r=rootAnalysis.results[i];assert.equal(r.step,actual.step);assert.equal(r.rawGroupSha256,actual.rawGroup.sha256);for(const key of ['tests','pass','fail'])assert.equal(r[key],actual.tap[key]);assert.equal(r.skip,actual.tap.skipped);}
function walk(dir,prefix=''){const rows=[];for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){const p=join(dir,entry.name),s=lstatSync(p);assert.ok(!s.isSymbolicLink(),p);const rel=prefix+entry.name;if(s.isDirectory())rows.push(...walk(p,rel+'/'));else{assert.ok(s.isFile());rows.push({file:rel,...info(bytes(p))});}}return rows;}
const artifactFiles=walk(art),top=readdirSync(art),childNames=top.filter(n=>/^(?:fallback-)?\d{3}-.+\.result\.json$/.test(n)).sort();
const runtimeNames=childNames.filter(n=>!n.startsWith('fallback-')),fallbackNames=childNames.filter(n=>n.startsWith('fallback-'));
const commands=[],allReferencedRaw=new Set();
for(const name of childNames){
 const r=j(name);assert.equal(r.schema,'web-platform-g7-child-command-closed-v1');assert.equal(r.closed,true);assert.ok(validTime(r.begin)&&validTime(r.endedAt)&&Date.parse(r.endedAt)>=Date.parse(r.begin));assert.ok(Number.isSafeInteger(r.actualExit));assert.equal(r.signal,null);assert.equal(r.errorCode,null);if('timedOut' in r)assert.equal(r.timedOut,false);
 for(const stream of ['stdout','stderr']){const d=r[stream];assert.equal(d.file,name.replace('.result.json','.'+stream+'.log'));assert.ok(!allReferencedRaw.has(d.file));allReferencedRaw.add(d.file);check(bytes(join(art,d.file)),d);}
 if(r.actualExit!==0){assert.equal(r.actualExit,2);assert.equal(r.expectedNumericReadinessNonzero,true);assert.ok(r.args.includes('pg_isready'));}
 commands.push({file:name,...r});
}
for(const [rows,prefix] of [[runtimeNames,''],[fallbackNames,'fallback-']])for(let i=0;i<rows.length;i++)assert.ok(rows[i].startsWith(prefix+String(i+1).padStart(3,'0')+'-'),'Closed command sequence contiguous');
const rawArtifactLogs=top.filter(n=>/^(?:fallback-)?\d{3}-.+\.(?:stdout|stderr)\.log$/.test(n));
assert.deepEqual(rawArtifactLogs.sort(),[...allReferencedRaw].sort());
const result=j('result.json'),ownership=j('ownership.json'),cleanup=j('cleanup.json'),fallback=j('fallback-cleanup-result.json'),wire=j('wire-result.json'),sourceInputs=j('source-inputs.json'),images=j('image-inputs.json'),seed=j('database-seed.json'),observations=j('database-runtime-observations.json'),configuration=j('runtime-configuration.json'),manifestBytes=bytes(join(art,'frozen-manifest.json')),manifest=JSON.parse(manifestBytes.toString('utf8'));
const manifestSha=info(manifestBytes).sha256;
assert.equal(bytes(join(art,'frozen-manifest.sha256')).toString().trim(),manifestSha);
for(const r of [result,fallback,wire,ownership,sourceInputs])assert.equal(r.sourceSHA,source);
for(const r of [result,wire,sourceInputs])assert.equal(r.manifestSha256,manifestSha);
assert.equal(result.schema,'web-platform-g7-owned-linux-tls-pg-closed-v1');assert.equal(result.actualExit,0);assert.ok(validTime(result.startedAt)&&validTime(result.endedAt));assert.equal(result.commandCount,runtimeNames.length);assert.equal(result.wireActualExit,0);
assert.equal(result.fullG7Verified,false);assert.equal(result.fullG8Verified,false);assert.equal(result.nativePG18Verified,false);assert.equal(result.restrictedRuntimeACLVerified,false);assert.equal(result.productionRequests,0);
assert.equal(result.stages.realLinuxDockerTLSPGCatalog,'passed');for(const [k,v] of Object.entries(result.stages))if(k!=='realLinuxDockerTLSPGCatalog')assert.equal(v,'pending');
assert.deepEqual(result.cleanup,cleanup);assert.deepEqual(result.imageIDs,images.imageIDs);assert.equal(images.references.pg,'postgres:16-alpine');
const platform=JSON.parse(images.platform);assert.equal(platform.Os,'linux');for(const role of ['admin','proxy','migrate','web','ssr'])assert.ok(images.references[role].endsWith(':'+source));
assert.equal(manifest.releaseId,source);assert.equal(manifest.schemaVersion,3);assert.equal(manifest.files.length,135);
assert.equal(wire.schema,'web-platform-g7-tls-pg-wire-v1');assert.equal(wire.actualExit,0);assert.ok(!wire.failure);assert.equal(wire.fullG7Verified,false);assert.equal(wire.productionRequests,0);for(const v of Object.values(wire.laterStages))assert.equal(v,'pending');
assert.equal(wire.expectedOriginalNineWireCases,9);
for(let i=0;i<wire.rows.length;i++)assert.equal(wire.rows[i].id,i+1);
const originalCases=[['same HTTPS Origin',410],['spoofed forwarding overwritten',410],['ambiguous forwarding overwritten',410],['missing Origin',403],['cross Origin preserved',403],['explicit cross-site',403],['unknown Host',421],['registration redirect',302],['invalid callback restores HTTPS',302]];
for(const [label,status]of originalCases){const rows=wire.rows.filter(r=>r.label===label);assert.equal(rows.length,1);assert.equal(rows[0].status,status);assert.equal(rows[0].TLSAuthorized,true);assert.equal(rows[0].setCookieCount,0);}
for(const [label,errorCode]of [['untrusted CA is rejected','UNABLE_TO_VERIFY_LEAF_SIGNATURE'],['wrong SNI fails certificate hostname validation','ERR_TLS_CERT_ALTNAME_INVALID']]){const row=wire.rows.find(r=>r.label===label);assert.equal(row.outcome,'verified TLS rejection');assert.equal(row.errorCode,errorCode);}
assert.equal(wire.rows.find(r=>r.label==='missing SNI rejected by default ingress').status,421);
const rawPortRows=wire.rows.filter(r=>r.label.startsWith('QA cannot reach '));assert.equal(rawPortRows.length,12);for(const r of rawPortRows){assert.equal(r.outcome,'raw port inaccessible');assert.ok(r.errorCode||r.blockedAtDeadline===true);}
const ssr=wire.rows.filter(r=>r.label==='real PG-backed SSR'),resources=wire.rows.filter(r=>r.label.startsWith('frozen '));
assert.equal(ssr.length,64);assert.equal(wire.completedPublicSSRRequests,ssr.length);assert.equal(resources.length,270);assert.equal(wire.completedResourceRequests,resources.length);assert.equal(wire.expectedResourceFiles,manifest.files.length);assert.equal(wire.rows.length,375);
for(const r of [...ssr,...resources]){assert.equal(r.status,200);assert.equal(r.TLSAuthorized,true);assert.equal(r.setCookieCount,0);assert.ok(['GET','HEAD'].includes(r.method));if(r.method==='HEAD')assert.equal(r.bytes,0);}
assert.equal(new Set(ssr.map(r=>r.method+' '+r.path)).size,64);
for(const file of manifest.files){for(const method of ['GET','HEAD']){const rows=resources.filter(r=>r.method===method&&r.path==='/web-assets/'+file.path);assert.equal(rows.length,1);assert.equal(rows[0].bytes,method==='GET'?file.bytes:0);}}
const ca=new X509Certificate(bytes(join(art,'tls-public/qa-root-ca.crt')));assert.equal(ca.ca,true);assert.equal(ca.fingerprint256,wire.caFingerprint);
const qa=j('qa-container-closed.json');assert.equal(qa.actualExit,0);assert.equal(qa.running,false);assert.equal(qa.OOMKilled,false);assert.ok(validTime(qa.finishedAt));
const runtimeCommands=commands.filter(c=>!c.file.startsWith('fallback-')),fallbackCommands=commands.filter(c=>c.file.startsWith('fallback-'));
const raw=r=>bytes(join(art,r.stdout.file));
function findCommand(list,predicate){const found=list.filter(predicate);assert.ok(found.length>0);return found.at(-1);}
function findWait(name){const r=findCommand(runtimeCommands,c=>c.args.includes('wait')&&c.args.at(-1)===name);assert.equal(r.actualExit,0);assert.equal(raw(r).toString().trim(),'0');return r.file;}
const migrationContainers=top.filter(n=>n.includes('-migrate-')&&n.endsWith('.container-closed.json')).sort();
assert.equal(migrationContainers.length,2);
for(const name of [...migrationContainers,...top.filter(n=>n.includes('-seed-')&&n.endsWith('.container-closed.json'))]){const r=j(name);assert.equal(r.actualExit,0);assert.equal(r.running,false);assert.equal(r.OOMKilled,false);assert.ok(!r.error);findWait(r.name);}
const seedLog=findCommand(runtimeCommands,c=>c.args.includes('logs')&&c.args.at(-1)===ownership.names.seed);assert.deepEqual(JSON.parse(raw(seedLog).toString()),seed);assert.equal(seed.mode,'--seed');assert.equal(seed.actualExit,0);
findWait(ownership.names.qa);
const qaLogs=findCommand(runtimeCommands,c=>c.args.includes('logs')&&c.args.at(-1)===ownership.names.qa);const qaSummary=JSON.parse(raw(qaLogs).toString());assert.equal(qaSummary.actualExit,0);assert.equal(qaSummary.completedRows,wire.rows.length);
for(const [role,record] of Object.entries(observations)){
 assert.ok(['proxy','admin'].includes(role));const command=findCommand(runtimeCommands,c=>c.args.includes('--observe')&&c.args.includes(ownership.names[role]));assert.equal(command.actualExit,0);assert.deepEqual(JSON.parse(raw(command).toString()),record);
 assert.equal(record.mode,'--observe');assert.equal(record.actualExit,0);assert.deepEqual(record.observation,seed.observation);assert.deepEqual(record.migrations,seed.migrations);assert.equal(record.migrationCorpusSha256,seed.migrationCorpusSha256);assert.equal(record.restrictedRuntimeACLVerified,false);assert.equal(record.nativePG18Verified,false);
}
assert.equal(seed.observation.role,'postgres');assert.equal(seed.observation.superuser,true);assert.equal(seed.observation.database,'g7');assert.equal(seed.observation.schema,'cinatoken_gateway');assert.equal(seed.observation.server_version_num,'160015');assert.equal(seed.observation.schemaColumns,795);
assert.deepEqual(seed.observation.counts,{models:1,providers:1,verified_endpoints:1,legacy_master_api_keys:1,legacy_development_keys:0,obsolete_master_config:0,admin_sessions:0,portal_sessions:0});
assert.equal(seed.fixture.legacyMasterKeyRotated,true);assert.equal(seed.fixture.storedProviderKeyEncrypted,true);assert.equal(seed.fixture.controlledCatalogEvidenceOnly,true);
assert.equal(seed.migrations.length,81);assert.equal(seed.migrationCorpusSha256,info(Buffer.from(JSON.stringify(seed.migrations))).sha256);assert.deepEqual(result.database,seed);assert.deepEqual(result.observations,observations);
const expectedResources=[...Object.values(ownership.names).map(name=>({type:'container',name})),...Object.values(ownership.networks).map(name=>({type:'network',name})),{type:'volume',name:ownership.volume}];
assert.equal(expectedResources.length,13);assert.equal(cleanup.containers.length,9);assert.equal(cleanup.networks.length,3);assert.equal(cleanup.volumes.length,1);assert.deepEqual(cleanup.errors,[]);assert.equal(cleanup.verifiedAbsent,true);
assert.equal(fallback.actualExit,0);assert.equal(fallback.verifiedAbsent,true);assert.deepEqual(fallback.errors,[]);assert.equal(fallback.runtimePassedClaim,false);assert.equal(fallback.doesNotOverrideOriginalRuntimeExit,true);
assert.deepEqual(fallback.rows.map(r=>r.type+':'+r.name).sort(),expectedResources.map(r=>r.type+':'+r.name).sort());for(const r of fallback.rows)assert.equal(r.verifiedAbsent,true);
const absenceProofs=[];
for(const list of [runtimeCommands,fallbackCommands])for(const r of expectedResources){const c=findCommand(list,c=>c.args.includes(r.type)&&c.args.includes('ls')&&(c.args.includes('name=^/'+r.name+'$')||c.args.includes('name=^'+r.name+'$')));assert.equal(c.actualExit,0);assert.equal(raw(c).length,0);absenceProofs.push({scope:list===runtimeCommands?'runtime':'fallback',type:r.type,name:r.name,command:c.file,...info(raw(c))});}
for(const list of [runtimeCommands,fallbackCommands])for(const type of ['container','network','volume']){const c=findCommand(list,c=>c.args.includes(type)&&c.args.includes('ls')&&c.args.includes('label=cinatoken.g7.owner='+ownership.owner));assert.equal(c.actualExit,0);assert.equal(raw(c).length,0);}
assert.equal(configuration.webFlagsTrue,29);assert.equal(configuration.database.sharedByAdminAndProxy,true);assert.equal(configuration.sharedEncryptionKeyMatches,true);assert.equal(configuration.oidcSecretsPresentAndMatch,true);assert.equal(configuration.secretsLogged,false);
const sourceRequests=[...sourceInputs.files.map(i=>({ref:source,path:i.path,claim:i})),...seed.migrations.map(i=>({ref:source,path:'packages/core/migrations-postgres/'+i.name,claim:i})),...nativeCases.map(path=>({ref:source,path:'scripts/db/cutover/'+path})),...nativeCases.slice(4,7).map(path=>({ref:base,path:'scripts/db/cutover/'+path})),{ref:source,path:'.github/workflows/proxy-dispatch-safety.yml'}];
const at=new Date().toISOString(),input=sourceRequests.map(r=>r.ref+':'+r.path+'\n').join(''),args=['-c','core.longpaths=true','cat-file','--batch'];
const git=spawnSync('git',args,{cwd:repo,input,encoding:null,maxBuffer:20*1024*1024,windowsHide:true});const finishedAt=new Date().toISOString();
for(const stream of ['stdout','stderr'])writeFileSync(join(out,'source-git.'+stream+'.log'),git[stream]??Buffer.alloc(0),{flag:'wx'});
const gitReceipt={schema:'cinatoken.terminal-independent-peer.command.v1',at,finishedAt,executable:'git',args,cwd:repo,actualExit:git.status,signal:git.signal??null,spawnError:git.error?String(git.error):null,stdinInfo:info(Buffer.from(input)),stdout:join(out,'source-git.stdout.log'),stderr:join(out,'source-git.stderr.log'),stdoutInfo:info(git.stdout??Buffer.alloc(0)),stderrInfo:info(git.stderr??Buffer.alloc(0))};write('source-git.closed.json',gitReceipt);
assert.equal(git.status,0);assert.equal(git.signal,null);assert.equal(git.error,undefined);
const gitSources=[],sourceMap=new Map();let position=0;
for(const request of sourceRequests){const end=git.stdout.indexOf(10,position),[blob,type,sizeText]=git.stdout.subarray(position,end).toString('utf8').split(' '),size=Number(sizeText);assert.equal(type,'blob');assert.match(blob,/^[0-9a-f]{40}$/);const b=git.stdout.subarray(end+1,end+1+size);assert.equal(b.length,size);assert.equal(git.stdout[end+1+size],10);position=end+size+2;
 assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from('blob '+size+'\0'),b])).digest('hex'),blob);if(request.claim){assert.equal(info(b).sha256,request.claim.sha256);if('bytes'in request.claim)assert.equal(b.length,request.claim.bytes);}gitSources.push({ref:request.ref,path:request.path,blob,...info(b)});sourceMap.set(request.ref+':'+request.path,b);}
assert.equal(position,git.stdout.length);
for(const path of nativeCases.slice(4,7)){const file='scripts/db/cutover/'+path;assert.ok(sourceMap.get(source+':'+file).equals(sourceMap.get(base+':'+file)));}
const nativeProducer=json('C:/Users/cina/AppData/Local/Temp/cinatoken-native-four-repair-38a94fb93d9842929dc7ae9cf6b378da/FINAL-native-four-pg73-preparation.json');
for(const claim of nativeProducer.files)check(sourceMap.get(source+':'+claim.file),claim.after);
const wireSource=sourceMap.get(source+':scripts/verification/web-platform-g7/wire.mjs').toString('utf8');
assert.ok(wireSource.includes('assert.equal(sha256(response.body), file.sha256)'));assert.ok(wireSource.includes('rejectUnauthorized: true'));assert.ok(wireSource.includes('assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined)'));assert.ok(wireSource.includes('bootstrap.records.length'));
const databaseSource=sourceMap.get(source+':scripts/verification/web-platform-g7/database.mjs').toString('utf8');assert.ok(databaseSource.includes('Full actual migration corpus must be applied'));assert.ok(databaseSource.includes('sha256(JSON.stringify({ columns, constraints }))'));
const artifacts=json(join(root,'g7-artifact-list.stdout.log'));assert.equal(artifacts.total_count,1);const remote=artifacts.artifacts[0];assert.equal(remote.id,11387954568);assert.equal(remote.workflow_run.id,g7Run.databaseId);assert.equal(remote.workflow_run.head_sha,source);assert.equal(remote.expired,false);assert.equal(remote.digest,'sha256:8b300225ecfb4cf4a98b120e8e4f3c9f27b827689f5b6d0bf702af1cea520b0c');
assert.match(g7LogBytes.toString(),/Web platform G7|Execute real isolated TLS/);
assert.deepEqual(walk(art),artifactFiles);for(const [p,i]of rootFiles)check(bytes(p),i);
const report={schema:'cinatoken.native-g7-terminal-independent-peer.final.v1',at:new Date().toISOString(),actualExit:0,reviewOnly:true,findings:[],sourceCommit:source,currentWorkingTreeNotUsedAsSource:true,native:{runId:proxyRun.databaseId,overallConclusion:'failure',jobId:nativeJob.databaseId,jobConclusion:'failure',postgresImage:'postgres:18.6-bookworm',newFourResults:nativeResults.slice(0,4),unchanged57To59Results:nativeResults.slice(4,7),nextFailure:nativeResults[7],dispatch:{jobId:dispatchJob.databaseId,strictStep:27,conclusion:'failure',tap:dispatchTap,originalProcessExit:1,raw:info(dispatchBytes)},rootAnalysisIndependentlyMatched:true,fullPipelinePassDerived:false},g7:{runId:g7Run.databaseId,jobId:g7Run.jobs[0].databaseId,overallConclusion:'success',actualRuntimeExit:result.actualExit,runtimeInterval:{startedAt:result.startedAt,endedAt:result.endedAt},artifact:{directory:art,topEntryCount:top.length,topRegularFileCount:top.filter(n=>lstatSync(join(art,n)).isFile()).length,recursiveRegularFileCount:artifactFiles.length,fileSetStableBeforeAfter:true,allFiles:artifactFiles,remoteId:remote.id,remoteSize:remote.size_in_bytes,remoteReportedDigest:remote.digest,remoteZipDigestLocallyVerified:false},runtimeCommandCount:runtimeNames.length,fallbackCommandCount:fallbackNames.length,totalChildCommandCount:commands.length,totalRawChildLogs:allReferencedRaw.size,childReceipts:commands,allChildBytesShaAndTerminalReceiptsVerified:true,nonzeroReadinessReceipts:commands.filter(c=>c.actualExit!==0),manifest:{sha256:manifestSha,releaseId:manifest.releaseId,currentResourceFiles:manifest.files.length,serverFileCount:manifest.serverFiles.length,sourceArchiveDigestReportedOnly:true},database:{seedActualExit:0,proxyObservationActualExit:0,adminObservationActualExit:0,observationsEqual:true,observation:seed.observation,migrations:seed.migrations,migrationCorpusSha256:seed.migrationCorpusSha256,GitMigrationBytesMatched:true,migrationsTwiceClosedZero:true,fixture:seed.fixture,restrictedRuntimeACLVerified:false,nativePG18Verified:false},wire:{actualExit:0,rowCount:wire.rows.length,originalNineCases:originalCases,publicSSRRequests:ssr.length,resourceRequests:resources.length,uniqueResourceFiles:manifest.files.length,TLSNegativeCasesVerified:true,rawPortNegativeCases:rawPortRows.length,caFingerprint:ca.fingerprint256,rows:wire.rows,originalWireSourceAssertionsMatchedGit:true,wireSummaryChildClosureMatched:true},cleanup:{runtime:cleanup,fallback,absenceProofs,resourceCount:expectedResources.length,bothOwnerLabelScansAbsent:true},stage0Passed:true,fullG7Verified:false,fullG8Verified:false,productionRequests:0,laterStages:result.stages},gitSourceProofs:gitSources,gitReadReceipt:gitReceipt,rootClosedReceiptProofs:rootReceipts,rootInputHashes:[...rootFiles].map(([path,i])=>({path,...i})),scope:{repositoryWrites:0,gitMutations:0,testExecutions:0,CLIOrAPINetworkRequests:0,ciTriggers:0,databaseExecutions:0,productionRequests:0},limitations:['This read-only audit verifies frozen terminal receipts and exact source Git blobs at 473de5fc520fc7d64db700db88a76c7a6b45c241; concurrent working tree edits are intentionally excluded.','G7 stage 0 passed on PostgreSQL 16.15 using postgres superuser. It does not prove PostgreSQL 18 restricted runtime ACL behavior or full G7/G8.','Signed OIDC, authenticated writes, subject/workspace isolation, proxy SSE abort/WS, retained gray rollback and real CinaAuth identity remain pending.','The GitHub artifact ZIP SHA256 is remote-reported. This review verifies every extracted recursive file and child raw byte/hash, not a locally downloaded ZIP archive digest.','Source archive and schema catalog digests are recorded projections. Source migration bytes and cross-runtime projected schema/count equality are verified; no full source archive or raw catalog column/constraint dump is present in this terminal artifact.']};
write('FINAL-native-g7-terminal-independent-peer.json',report);
const reportBytes=bytes(join(out,'FINAL-native-g7-terminal-independent-peer.json'));
console.log(JSON.stringify({actualExit:0,path:join(out,'FINAL-native-g7-terminal-independent-peer.json'),...info(reportBytes),sourceCommit:source,nativePassSteps:7,nativeNextFailure:60,ProxyOverall:'failure',strict:dispatchTap,G7Run:g7Run.databaseId,G7Stage0:'passed',artifactRecursiveFiles:artifactFiles.length,runtimeCommands:runtimeNames.length,fallbackCommands:fallbackNames.length,childRawLogs:allReferencedRaw.size,fullG7Verified:false,fullG8Verified:false}));
