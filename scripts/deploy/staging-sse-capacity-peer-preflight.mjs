import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const copy=value=>structuredClone(value);
const workers=[g.worker,c.worker,'cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery'];
const production=['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'];

/** Fresh, read-only preflight for an ALREADY CLOSED and byte-verified candidate
 * deployment. expected is the immutable post-deploy observation, not a proposed
 * state or user-supplied list of arbitrary targets. No deployment or setup here.
 * A failed or uncertain run is never marked write-ready or automatically retried.
 */
export function createSseCapacityPeerPreflight({transport,session,expected,entrySha256,persist}) {
  const baseline=copy(expected),{api,batch}=transport;let running;
  const report={result:'NOT_RUN',writes:0,c02GatePassed:false};
  const digest=rows=>sha(JSON.stringify(rows));
  const save=async event=>{
    let timer;const ac=new AbortController(),deadline=session.clock.after(session.clock.sample(),5000);
    try{await Promise.race([Promise.resolve().then(()=>persist(copy(event),{signal:ac.signal})),
      new Promise((_,reject)=>{timer=setTimeout(()=>{ac.abort();reject(Error('preflight_journal_timeout'));},5000);})]);
      assert.ok(session.clock.remaining(deadline)>0);
    }finally{clearTimeout(timer);ac.abort();}
  };
  async function stable() {
    for(const w of baseline.workers){
      assert.equal(digest(await api(`/workers/scripts/${w.name}/settings`)),w.settingsSha256);
      const deployed=(await api(`/workers/scripts/${w.name}/deployments`)).deployments;
      assert.ok(Array.isArray(deployed)&&deployed.length>0);assert.deepEqual(deployed[0].versions,w.versions);
    }
    for(const p of baseline.production)assert.equal(digest(await api(`/workers/scripts/${p.name}/settings`)),p.settingsSha256);
  }
  async function execute() {
    report.result='RUNNING';
    try{
      assert.deepEqual(baseline.workers.map(w=>w.name).sort(),workers.slice().sort());
      assert.deepEqual(baseline.production.map(w=>w.name).sort(),production.slice().sort());
      assert.deepEqual(baseline.access.map(a=>a.id).sort(),[g.app,c.app].sort());
      assert.deepEqual(baseline.workers.find(w=>w.name===g.worker).versions,[{version_id:session.plan.version,percentage:100}]);
      assert.match(entrySha256,/^[a-f0-9]{64}$/);assert.equal(session.plan.budget.firstRoundUsdCap,2);assert.equal(session.plan.budget.capReset,false);
      const db=await api('/d1/database/'+g.database);assert.equal(db.uuid,g.database);assert.equal(db.name,'cinatoken-staging');
      await stable();
      for(const w of workers){
        const state=await api(`/workers/scripts/${w}/subdomain`);assert.equal(state.enabled,false);assert.equal(state.previews_enabled,false);
        assert.deepEqual(await api('/workers/domains?service='+w),[]);assert.deepEqual((await api(`/workers/scripts/${w}/schedules`)).schedules,[]);
      }
      const tables=Object.keys(baseline.counts);assert.equal(tables.length,56);for(const t of tables)assert.match(t,/^[a-z][a-z0-9_]*$/);
      const rows=await batch([
        {sql:'SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513',params:[]},
        {sql:'SELECT '+tables.map(t=>`(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(','),params:[]},
        {sql:'SELECT key FROM system_config WHERE key IN (?,?) LIMIT 3',params:['c02_recovery_claim_delay_v1','c02_recovery_fencing_control_v1']},
      ]);
      assert.equal(rows[0].length,295);assert.equal(digest(rows[0]),baseline.schema.sha256);assert.deepEqual(rows[1],[baseline.counts]);assert.deepEqual(rows[2],[]);
      report.originalApps=[];
      for(const t of [g,c]){
        const app=await api('/access/apps/'+t.app);assert.equal(digest(app),baseline.access.find(a=>a.id===t.app).sha256);
        assert.equal(app.id,t.app);assert.equal(app.domain,t.domain);assert.equal(app.aud,t.audience);assert.equal(app.type,'self_hosted');
        assert.deepEqual(app.destinations,[{type:'public',uri:t.domain}]);assert.notEqual(app.service_auth_401_redirect,true);
        assert.equal(app.policies.length,1);const p=app.policies[0];assert.equal(p.id,t.policy);assert.equal(p.precedence,1);
        assert.equal(p.name,t===g?'CinaToken staging closed':'CinaToken recovery staging closed');assert.equal(p.decision,'deny');
        assert.deepEqual(p.include,[{everyone:{}}]);assert.deepEqual(p.exclude??[],[]);assert.deepEqual(p.require??[],[]);
        report.originalApps.push(app);
      }
      const tokens=await api('/access/service_tokens');assert.ok(Array.isArray(tokens));
      assert.ok(tokens.every(t=>t.name!==session.plan.tokenName&&!(baseline.previousTokenIds??[]).includes(t.id)));
      assert.deepEqual(await api(`/workers/scripts/${g.worker}/tails`),[]);
      const content=await transport.content();
      if(content.type?.startsWith('multipart/form-data')){
        const form=await new Response(content.data,{headers:{'Content-Type':content.type}}).formData();let matches=0;
        for(const part of form.values())if(typeof part!=='string'&&sha(Buffer.from(await part.arrayBuffer()))===entrySha256)matches++;
        assert.equal(matches,1,'Exactly one executable must match the closed candidate');
      }else assert.equal(sha(content.data),entrySha256);
      report.contentSha256=entrySha256;
      // Recheck versions/settings after content/schema reads. No historical hash
      // alone can mark the currently deployed candidate write-ready.
      await stable();
      const billing=await api('/billable-usage');assert.ok(Array.isArray(billing));
      const selected=billing.filter(r=>['Workers','D1'].includes(r.ServiceFamilyName));
      for(const family of ['Workers','D1'])assert.ok(selected.some(r=>r.ServiceFamilyName===family));
      assert.ok(selected.every(r=>r.BillingCurrency==='USD'&&r.ContractedCost===0),'Billing changed or unavailable');
      report.billing=selected.map(r=>Object.fromEntries(['ServiceName','ServiceFamilyName','BillingCurrency','BillingPeriodStart','ChargePeriodStart','ChargePeriodEnd','ContractedCost','CumulatedContractedCost','ConsumedQuantity','ConsumedUnit'].filter(k=>k in r).map(k=>[k,r[k]])));
      const serverNow=Date.parse(transport.report().lastCloudDate),expires=Date.parse(session.plan.expiresAt);
      assert.ok(Number.isFinite(serverNow)&&expires-serverNow>=900000&&expires-serverNow<=7200000);
      report.result='PASS';report.finished=session.clock.sample();
      await save({step:'peer-preflight',...report});session.preflightComplete();
    }catch{report.result='FAIL';try{await save({step:'peer-preflight',result:'FAIL'});}catch{};throw Error('peer_preflight_failed');}
    return copy(report);
  }
  return Object.freeze({run(){return running??=execute();},report:()=>copy(report)});
}
