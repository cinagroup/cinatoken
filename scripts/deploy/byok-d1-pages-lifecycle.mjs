import assert from 'node:assert/strict';

const names=new Set(['queued','initialize','clone_repo','build','deploy']);
// `skipped` is observed in provider responses even though the installed SDK
// enum omits it. Retaining that status does not itself establish runtime absence.
const statuses=new Set(['success','idle','active','failure','canceled','skipped']);
const object=v=>{assert.ok(v!==null&&typeof v==='object'&&!Array.isArray(v));return v;};
function timestamp(v){
  if(v==null)return null;
  assert.ok(typeof v==='string'&&v.length<=64&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(v)&&Number.isFinite(Date.parse(v)));
  return v;
}
function stage(v){
  if(v==null)return null;object(v);
  assert.ok(v.name===undefined||names.has(v.name));assert.ok(v.status===undefined||statuses.has(v.status));
  const result={name:v.name??null,status:v.status??null,startedOn:timestamp(v.started_on),endedOn:timestamp(v.ended_on)};
  return result;
}

/** Projects only provider lifecycle fields. Classification describes recorded
 * stages, never runtime non-existence, permission to delete or preflight success.
 * A failed deploy can have uploaded a Worker version; unknown remains unknown. */
export function projectPagesDeploymentLifecycle(value){
  object(value);assert.ok(value.uses_functions==null||typeof value.uses_functions==='boolean');
  assert.ok(value.is_skipped==null||typeof value.is_skipped==='boolean');
  const latest=stage(value.latest_stage);let stages=null;
  if(value.stages!=null){assert.ok(Array.isArray(value.stages)&&value.stages.length<=10);stages=value.stages.map(stage);assert.ok(stages.every(s=>s!==null));
    const supplied=stages.map(s=>s.name).filter(v=>v!==null);assert.equal(new Set(supplied).size,supplied.length);}
  const deploy=stages?.find(s=>s.name==='deploy')??null;
  // Provider records can contain reversed timestamps. Retain the record and
  // flag it, but never classify that inconsistent timeline as terminal proof.
  const reversed=s=>Boolean(s?.startedOn&&s.endedOn&&Date.parse(s.endedOn)<Date.parse(s.startedOn));
  const timestampAnomalies=[...(reversed(latest)?['latest-stage']:[]),...(stages??[]).flatMap(s=>reversed(s)?['stage:'+s.name]:[])];
  const latestInStages=latest?.name?stages?.find(s=>s.name===latest.name):null;
  const consistent=Boolean(latest&&latestInStages&&JSON.stringify(latest)===JSON.stringify(latestInStages));
  const classifiable=consistent&&timestampAnomalies.length===0;
  const noRecordedDeploy=Boolean(deploy&&deploy.status==='idle'&&deploy.startedOn===null&&deploy.endedOn===null);
  const noRecordedPostQueueWork=Boolean(stages&&stages.length===5&&['initialize','clone_repo','build','deploy'].every(name=>{
    const s=stages.find(s=>s.name===name);return s&&s.status==='idle'&&s.startedOn===null&&s.endedOn===null;
  }));
  let classification='INCOMPLETE_ACTIVE_OR_INCONSISTENT';
  if(timestampAnomalies.length)classification='INCONSISTENT_STAGE_TIMESTAMPS';
  else if(classifiable&&latest.name==='deploy'&&latest.status==='success'&&latest.endedOn!==null)classification='DEPLOY_SUCCESS_RECORDED';
  else if(classifiable&&latest.name==='deploy'&&latest.status==='failure'&&latest.endedOn!==null)classification='DEPLOY_FAILURE_RECORDED';
  else if(classifiable&&latest.name==='deploy'&&latest.status==='canceled'&&latest.endedOn!==null)classification='DEPLOY_CANCELED_RECORDED';
  else if(classifiable&&latest.name==='queued'&&latest.status==='skipped'&&value.is_skipped===true&&latest.endedOn!==null&&noRecordedPostQueueWork)classification='SKIPPED_NO_DEPLOY_RECORDED';
  else if(classifiable&&latest.name!=='deploy'&&['failure','canceled'].includes(latest.status)&&latest.endedOn!==null&&noRecordedDeploy){
    classification=value.is_skipped===true?'SKIPPED_NO_DEPLOY_RECORDED':'PRE_DEPLOY_TERMINAL_NO_DEPLOY_RECORDED';
  }
  return {functionsFieldState:!Object.hasOwn(value,'uses_functions')?'ABSENT':value.uses_functions===null?'NULL':value.uses_functions===undefined?'UNDEFINED':'BOOLEAN',
    latestStage:latest,stages,latestStageConsistent:consistent,timestampAnomalies,classification,runtimeAbsenceProved:false};
}
