import assert from 'node:assert/strict';
import {SSE_STAGING_SCOPE,closeSseStagingAccess} from './staging-sse-reconciliation.mjs';

// Operator-only. Fixed staging identities; no credentials, network, timers, inference, or SQL.
export const SSE_RECOVERY_ACCESS_SCOPE=Object.freeze({
  worker:'cinatoken-staging-recovery-control',
  app:'2ed1f9a7-7eb3-45ad-8cdc-392f7ae96bc0',
  policy:'90c6c0ad-3830-4e1d-baee-9884ea09a7d0',
  audience:'05cf62bcb8f57c5d9b9f93a8a3c38ed3b1e3901ca72fff8b1ea46b765bffbb7b',
  domain:'cinatoken-staging-recovery-control.cinagroup.workers.dev',
});
const scope=SSE_RECOVERY_ACCESS_SCOPE,uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const appPath='/access/apps/'+scope.app,policyPath=appPath+'/policies/'+scope.policy;
const ingressPath=s=>'/workers/scripts/'+s.worker+'/subdomain';
function validate(journal){
  assert.match(journal.runId,new RegExp(`^c02-success-${uuid}$`));
  if(journal.tokenName!==undefined)assert.match(journal.tokenName,new RegExp(`^cinatoken-sse-v[0-9]+-${uuid}$`));
  if(journal.tokenId!==undefined){assert.match(journal.tokenId,new RegExp(`^${uuid}$`));assert.ok(journal.tokenName);}
  // Request metadata is deliberately not read: a missing inference ACK must not prevent closure.
}
function checkApp(app,tokenId){
  assert.equal(app.id,scope.app);assert.equal(app.type,'self_hosted');
  assert.equal(app.domain,scope.domain);assert.equal(app.aud,scope.audience);
  assert.deepEqual(app.destinations,[{type:'public',uri:scope.domain}]);
  assert.equal(app.policies.length,1);const p=app.policies[0];
  assert.equal(p.id,scope.policy);assert.equal(p.name,'CinaToken recovery staging closed');assert.equal(p.precedence,1);
  assert.deepEqual(p.exclude??[],[]);assert.deepEqual(p.require??[],[]);
  if(p.decision==='deny')assert.deepEqual(p.include,[{everyone:{}}]);
  else {assert.equal(p.decision,'non_identity');assert.ok(tokenId);assert.deepEqual(p.include,[{service_token:{token_id:tokenId}}]);}
}
async function closeIngress(api,s){
  const path=ingressPath(s);let current=await api(path);
  if(current.enabled!==false||current.previews_enabled!==false){
    await api(path,'POST',{enabled:false,previews_enabled:false});current=await api(path);
  }
  assert.equal(current.enabled,false);assert.equal(current.previews_enabled,false);
}

/** Wrap the gateway-only closer when BOTH staging apps share one owned temporary service token.
 * The account-scoped api adapter MUST be bounded and must never auto-retry writes.
 * Explicit re-entry observes cloud state after uncertain ACKs; journal flags never skip checks.
 * Call before snapshot data reconciliation. No data is deleted by this module.
 */
export async function closeSseRecoveryAccess({api,journal,persist}){
  assert.equal(typeof api,'function');assert.equal(typeof persist,'function');validate(journal);
  // Attempt both fixed ingress closures even if one call has an uncertain result.
  // Do not proceed to token/policy writes until both are confirmed closed.
  const failures=[];
  for(const target of [scope,SSE_STAGING_SCOPE]){
    try{await closeIngress(api,target);}catch(error){failures.push(error);}
  }
  if(failures.length)throw new AggregateError(failures,'Staging ingress closure unconfirmed');
  await persist({step:'dual-ingress-closed'});
  const tokens=journal.tokenName?await api('/access/service_tokens'):[];assert.ok(Array.isArray(tokens));
  const found=tokens.filter(t=>t.name===journal.tokenName);assert.ok(found.length<=1,'Ambiguous token ownership');
  const token=found[0],tokenId=journal.tokenId??token?.id;
  if(token){assert.match(token.id,new RegExp(`^${uuid}$`));if(journal.tokenId)assert.equal(token.id,journal.tokenId);}
  if(journal.tokenId)assert.ok(tokens.every(t=>t.id!==journal.tokenId||t.name===journal.tokenName));
  let app=await api(appPath);checkApp(app,tokenId);
  if(token&&token.enabled!==false)await api('/access/service_tokens/'+token.id,'PUT',{name:journal.tokenName,enabled:false});
  await persist({step:'recovery-shared-token-disabled-or-absent',...(tokenId?{tokenId}:{})});
  if(app.service_auth_401_redirect===true){
    await api(appPath,'PUT',{...app,service_auth_401_redirect:false});app=await api(appPath);checkApp(app,tokenId);
    assert.notEqual(app.service_auth_401_redirect,true);
  }
  await persist({step:'recovery-service-auth-redirect-off'});
  if(app.policies[0].decision!=='deny')await api(policyPath,'PUT',{
    name:'CinaToken recovery staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[],
  });
  app=await api(appPath);checkApp(app,tokenId);
  assert.equal(app.policies[0].decision,'deny');assert.notEqual(app.service_auth_401_redirect,true);
  await persist({step:'recovery-deny-all-restored'});
  // Only the proven gateway closer owns deletion, after BOTH policy references have been removed.
  const gateway=await closeSseStagingAccess({api,journal,persist});
  app=await api(appPath);checkApp(app,tokenId);
  assert.equal(app.policies[0].decision,'deny');assert.notEqual(app.service_auth_401_redirect,true);
  const ingress=await api(ingressPath(scope));assert.equal(ingress.enabled,false);assert.equal(ingress.previews_enabled,false);
  await persist({step:'dual-access-cleanup-complete'});
  return {gateway,recovery:{ingressClosed:true,denyEveryone:true},sharedTokenAbsent:true};
}
