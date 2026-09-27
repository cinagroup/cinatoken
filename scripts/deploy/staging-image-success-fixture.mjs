// Synthetic-only D1 records for the private Images service; never real credentials or tariffs.
import assert from 'node:assert/strict';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '@octafuse/core';

export async function imageSuccessFixture(runId, keyHash, expiresAt, { includeLimitEdits = false } = {}) {
  assert.equal(typeof includeLimitEdits,'boolean');
  assert.match(runId, /^c02-success-[a-f0-9-]{36}$/);
  assert.match(keyHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(new Date(expiresAt).toISOString(), expiresAt);
  const user=runId+'-user',workspace=runId+'-workspace',key=runId+'-key';
  const marker=JSON.stringify({staging_fixture:runId,purpose:'private-synthetic-images'});
  const seed=[],models=[],providers=[],routes=[],endpoints=[],cases={};
  const insert=(table,row)=>{const names=Object.keys(row);seed.push({sql:`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`,params:Object.values(row)});};
  insert('users',{id:user,email:runId+'@example.invalid',budget_max:0,metadata:marker});
  insert('workspaces',{id:workspace,scope_type:'personal',personal_owner_user_id:user,name:'C02 private synthetic',slug:'c02-success',settings_json:marker});
  insert('api_keys',{id:key,key:'hashref:'+keyHash,key_hash:keyHash,key_preview:'sk-…',user_id:user,workspace_id:workspace,name:'C02 private synthetic',metadata:marker,expires_at:expiresAt,limit_micros:0});
  const now=new Date().toISOString();
  for(const mode of ['small','limit','over','replacement']) {
    const provider={id:runId+'-p-'+mode,api_key:'c02-staging-synthetic-provider',endpoints:JSON.stringify({openai:{base:`https://c02-images-upstream.invalid/cases/${mode}/v1`}}),shared_channel_type:null};
    providers.push(provider.id);insert('providers',{...provider,name:provider.id,status:'active',description:marker});
    for(const operation of mode==='small'||(includeLimitEdits&&mode==='limit')?['generations','edits']:['generations']) {
      const model=runId+'-'+mode+'-'+operation,route= model+'-r',endpoint=model+'-e';
      models.push(model);routes.push(route);endpoints.push(endpoint);cases[mode+'-'+operation]={model,route,endpoint,provider:provider.id};
      insert('models',{id:model,display_name:'Synthetic '+mode,vendor:'test',context_window:8192,max_tokens:1024,route_policy:'{"strategy":"weight_priority"}',input_modalities:'["text","image"]',output_modalities:'["image"]',metadata:marker});
      const routeRow={id:route,model_id:model,provider_id:provider.id,provider_model_name:'private-model',upstream_protocol:'openai',upstream_operation:'images.'+operation,adapter:'passthrough',custom_params:null};
      insert('model_routes',{...routeRow,route_group:'default',priority:0,status:'active',weight:1});
      insert('model_endpoints',{id:endpoint,model_id:model,provider_id:provider.id,provider_slug:'test',tag:'synthetic',endpoint_class:'standard',context_length:8192,max_completion_tokens:1024,supported_parameters:'[]',pricing:'{"currency":"USD","prompt":"0","completion":"0"}',
        image_capabilities:JSON.stringify({provider_slug:'test',provider_tag:null,supports_streaming:false,supported_parameters:{n:{type:'range',min:1,max:10}},allowed_passthrough_parameters:[],pricing:[{billable:'output_image',unit:'image',cost_usd:'0'}]}),
        evidence_url:'https://example.invalid/c02-private-synthetic-only',verified_by:runId,verified_at:now,expires_at:expiresAt,status:'verified'});
      insert('model_endpoint_routes',{endpoint_id:endpoint,route_target_id:route,subject_fingerprint:await computeRouteDataPolicySubjectFingerprintFromRows(routeRow,provider)});
    }
  }
  const cleanup=[
    {sql:'DELETE FROM api_key_request_logs WHERE user_id=? AND api_key_id=? AND workspace_id=?',params:[user,key,workspace]},
    {sql:'DELETE FROM user_audit_logs WHERE user_id=?',params:[user]},
    ...models.map(id=>({sql:'DELETE FROM public_model_daily_stats WHERE model_id=?',params:[id]})),
    ...endpoints.map(id=>({sql:'DELETE FROM model_endpoints WHERE id=? AND verified_by=?',params:[id,runId]})),
    ...routes.map((id,i)=>({sql:'DELETE FROM model_routes WHERE id=? AND model_id=?',params:[id,models[i]]})),
    ...models.map(id=>({sql:'DELETE FROM models WHERE id=? AND metadata=?',params:[id,marker]})),
    ...providers.map(id=>({sql:'DELETE FROM providers WHERE id=? AND description=?',params:[id,marker]})),
    {sql:'DELETE FROM api_keys WHERE id=? AND user_id=? AND workspace_id=? AND key_hash=?',params:[key,user,workspace,keyHash]},
    {sql:'DELETE FROM workspaces WHERE id=? AND personal_owner_user_id=? AND settings_json=?',params:[workspace,user,marker]},
    {sql:'DELETE FROM users WHERE id=? AND metadata=?',params:[user,marker]},
  ];
  return {ids:{runId,user,workspace,key,models,providers,routes,endpoints},cases,seed,cleanup,
    revoke:{sql:"UPDATE api_keys SET status='revoked' WHERE id=? AND user_id=? AND workspace_id=? AND key_hash=?",params:[key,user,workspace,keyHash]}};
}

export function successJsonWire(model, bytes) {
  const prefix=Buffer.from(JSON.stringify({model,prompt:'synthetic boundary'}).slice(0,-1)+',"padding":"'),suffix=Buffer.from('"}');
  bytes??=prefix.length+suffix.length;assert.ok(Number.isSafeInteger(bytes)&&bytes>=prefix.length+suffix.length);
  return {bytes,type:'application/json',*chunks(){yield prefix;let n=bytes-prefix.length-suffix.length;const page=Buffer.alloc(65536,65);while(n){const k=Math.min(n,page.length);yield page.subarray(0,k);n-=k;}yield suffix;}};
}
export function successMultipartWire(model, fileBytes=16) {
  assert.ok(Number.isSafeInteger(fileBytes)&&fileBytes>=0&&fileBytes<=20*1024**2);
  const boundary='cinatoken-c02-success',prefix=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nsynthetic boundary\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`),suffix=Buffer.from(`\r\n--${boundary}--\r\n`);
  return {bytes:prefix.length+fileBytes+suffix.length,type:`multipart/form-data; boundary=${boundary}`,*chunks(){yield prefix;let n=fileBytes;const page=Buffer.alloc(65536,65);while(n){const k=Math.min(n,page.length);yield page.subarray(0,k);n-=k;}yield suffix;}};
}
