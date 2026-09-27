import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {projectPagesDeploymentLifecycle:project}=await import(process.env.BYOK_PAGES_LIFECYCLE_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_PAGES_LIFECYCLE_MODULE)).href:'./byok-d1-pages-lifecycle.mjs');
const first='2026-06-13T12:07:52.643799Z',last='2026-06-13T12:10:28.592992Z';
function row({name='build',status='failure',skipped=false,functions=null}={}){
  const latest={name,status,started_on:first,ended_on:last};
  return {uses_functions:functions,is_skipped:skipped,latest_stage:latest,stages:[
    {name:'queued',status:'success',started_on:first,ended_on:first},
    ...['initialize','clone_repo','build'].map(key=>key===name?{...latest}:{name:key,status:'success',started_on:first,ended_on:first}),
    name==='deploy'?{...latest}:{name:'deploy',status:'idle',started_on:null,ended_on:null}
  ]};
}
for(const name of ['initialize','clone_repo','build'])for(const status of ['failure','canceled']){
  test(name+' '+status+' records pre-deploy terminal state but never proves runtime absence',()=>{
    const r=project(row({name,status}));assert.equal(r.classification,'PRE_DEPLOY_TERMINAL_NO_DEPLOY_RECORDED');
    assert.equal(r.latestStageConsistent,true);assert.equal(r.runtimeAbsenceProved,false);assert.equal(r.functionsFieldState,'NULL');
  });
}
for(const status of ['success','failure','canceled'])test('deploy '+status+' remains a distinct recorded outcome',()=>{
  const r=project(row({name:'deploy',status,functions:true}));assert.equal(r.classification,'DEPLOY_'+status.toUpperCase()+'_RECORDED');assert.equal(r.runtimeAbsenceProved,false);
});
test('skipped flag is only descriptive and requires matching terminal/no-deploy metadata',()=>{
  assert.equal(project(row({skipped:true})).classification,'SKIPPED_NO_DEPLOY_RECORDED');
  const r=row({skipped:true});r.stages.at(-1).status='active';assert.equal(project(r).classification,'INCOMPLETE_ACTIVE_OR_INCONSISTENT');
});
test('a successful direct upload may retain idle or active earlier stages',()=>{
  const r=row({name:'deploy',status:'success',functions:true});r.stages[0].status='active';r.stages[0].ended_on=null;
  for(const s of r.stages.slice(1,-1)){s.status='idle';s.started_on=null;s.ended_on=null;}
  assert.equal(project(r).classification,'DEPLOY_SUCCESS_RECORDED');
});
function skippedRow(){
  const latest={name:'queued',status:'skipped',started_on:first,ended_on:last};
  return {uses_functions:null,is_skipped:true,latest_stage:latest,stages:[{...latest},
    ...['initialize','clone_repo','build','deploy'].map(name=>({name,status:'idle',started_on:null,ended_on:null}))]};
}
test('provider queued skipped status remains descriptive evidence',()=>{
  const out=project(skippedRow());assert.equal(out.classification,'SKIPPED_NO_DEPLOY_RECORDED');
  assert.equal(out.latestStage.status,'skipped');assert.equal(out.runtimeAbsenceProved,false);
});
for(const kind of ['flag-false','flag-missing','missing-end','missing-stage','downstream-started','downstream-active','latest-mismatch']){
  test('queued skipped requires coherent complete no-work metadata: '+kind,()=>{
    const r=skippedRow();
    if(kind==='flag-false')r.is_skipped=false;if(kind==='flag-missing')delete r.is_skipped;
    if(kind==='missing-end'){r.latest_stage.ended_on=null;r.stages[0].ended_on=null;}
    if(kind==='missing-stage')r.stages.splice(1,1);
    if(kind==='downstream-started')r.stages[1].started_on=first;
    if(kind==='downstream-active')r.stages[2].status='active';
    if(kind==='latest-mismatch')r.stages[0].status='canceled';
    const out=project(r);assert.equal(out.classification,'INCOMPLETE_ACTIVE_OR_INCONSISTENT');assert.equal(out.runtimeAbsenceProved,false);
  });
}
test('source presence distinguishes absent, null and boolean Functions values',()=>{
  for(const [value,state] of [[false,'BOOLEAN'],[true,'BOOLEAN'],[null,'NULL'],[undefined,'UNDEFINED']])assert.equal(project({uses_functions:value}).functionsFieldState,state);
  assert.equal(project({}).functionsFieldState,'ABSENT');
});
for(const kind of ['missing-latest','missing-stages','missing-deploy','status-mismatch','timestamp-mismatch','active-deploy','started-idle-deploy','missing-end']){
  test('incomplete or inconsistent lifecycle remains unresolved: '+kind,()=>{
    const r=row();
    if(kind==='missing-latest')delete r.latest_stage;
    if(kind==='missing-stages')delete r.stages;
    if(kind==='missing-deploy')r.stages.pop();
    if(kind==='status-mismatch')r.stages.find(s=>s.name==='build').status='success';
    if(kind==='timestamp-mismatch')r.stages.find(s=>s.name==='build').ended_on=first;
    if(kind==='active-deploy')r.stages.at(-1).status='active';
    if(kind==='started-idle-deploy')r.stages.at(-1).started_on=first;
    if(kind==='missing-end'){r.latest_stage.ended_on=null;r.stages.find(s=>s.name==='build').ended_on=null;}
    const out=project(r);assert.equal(out.classification,'INCOMPLETE_ACTIVE_OR_INCONSISTENT');assert.equal(out.runtimeAbsenceProved,false);
  });
}
for(const kind of ['bad-functions','bad-skipped','stage-array','bad-name','bad-status','invalid-time','too-many-stages','duplicate-stage','null-stage']){
  test('malformed lifecycle rejected: '+kind,()=>{
    const r=row();if(kind==='bad-functions')r.uses_functions='false';if(kind==='bad-skipped')r.is_skipped='false';
    if(kind==='stage-array')r.latest_stage=[];if(kind==='bad-name')r.latest_stage.name='secret';if(kind==='bad-status')r.latest_stage.status='unknown';
    if(kind==='invalid-time')r.latest_stage.ended_on='2026-99-99T00:00:00Z';
    if(kind==='too-many-stages')r.stages=Array(11).fill(r.latest_stage);if(kind==='duplicate-stage')r.stages.push(r.stages[0]);if(kind==='null-stage')r.stages.push(null);
    assert.throws(()=>project(r));
  });
}
test('reversed provider timestamps remain evidence, never terminal qualification',()=>{
  const r=row({name:'deploy',status:'success'});r.latest_stage.started_on=last;r.latest_stage.ended_on=first;r.stages[r.stages.length-1]={...r.latest_stage};
  const out=project(r);assert.equal(out.classification,'INCONSISTENT_STAGE_TIMESTAMPS');assert.equal(out.latestStage.startedOn,last);assert.equal(out.latestStage.endedOn,first);
  assert.deepEqual(out.timestampAnomalies,['latest-stage','stage:deploy']);assert.equal(out.runtimeAbsenceProved,false);
});
test('reversal in an earlier stage prevents terminal classification too',()=>{
  const r=row();r.stages[0].started_on=last;r.stages[0].ended_on=first;
  const out=project(r);assert.equal(out.classification,'INCONSISTENT_STAGE_TIMESTAMPS');assert.deepEqual(out.timestampAnomalies,['stage:queued']);
});
test('projection excludes configuration, logs, error messages and arbitrary additional fields',()=>{
  const secret='PRIVATE-DO-NOT-PERSIST',r=row();r.env_vars={KEY:secret};r.logs=secret;r.latest_stage.error=secret;r.stages[0].message=secret;
  const before=JSON.stringify(r),out=project(r);assert.ok(!JSON.stringify(out).includes(secret));assert.equal(JSON.stringify(r),before);
});
