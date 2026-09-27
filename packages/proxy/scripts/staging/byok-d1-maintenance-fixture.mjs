import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {byokCleanupFixture} from './byok-d1-cleanup-fixture.mjs';
import {BYOK_D1_CASES} from './byok-d1-acceptance.ts';
import {captureByokD1CleanupBaseline,BYOK_D1_MAINTENANCE_KEY as KEY} from './byok-d1-cleanup.ts';
import {byokD1FenceInstallPlan,byokD1FenceTransition} from './byok-d1-write-fence.ts';
export const TOKEN='b1'.repeat(32);
export const context=()=>{const tasks=[];return {tasks,waitUntil(p){assert.equal(this.tasks,tasks);tasks.push(p);}};};
export const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
export const destructive=items=>items.some(s=>s.sql.startsWith('DELETE '));
export async function byokMaintenanceFixture(t,n=1){
  t.mock.method(globalThis,'fetch',()=>{throw Error('External network forbidden');});
  const f=byokCleanupFixture(),ctx=context();t.after(async()=>{await Promise.all(ctx.tasks);await f.close();});
  const apply=q=>f.raw.prepare(q.sql).bind(...q.params).run();
  await f.raw.batch(byokD1FenceInstallPlan(JSON.stringify(f.schema())).map(q=>f.raw.prepare(q.sql).bind(...q.params)));
  const baseline=await captureByokD1CleanupBaseline(f.raw,createHash('sha256').update(JSON.stringify(f.schema())).digest('hex'),'write-fence-v1');
  const before=f.allRows();f.arm();assert.equal((await apply(byokD1FenceTransition(f.runId,true))).meta.changes,1);
  for(const c of BYOK_D1_CASES.slice(0,n)){const r=await f.send(c);assert.equal(r.status,200,await r.text());}
  assert.equal((await f.send('stop')).status,200);assert.equal((await apply(byokD1FenceTransition(f.runId,false))).meta.changes,1);
  const now=Math.floor(Date.now()/1000),permit={version:1,runId:f.runId,tokenHash:createHash('sha256').update(TOKEN).digest('hex'),
    issuedAt:now,expiresAt:now+60,state:'ready',baseline,closure:{observedAt:now,evidenceSha256:'a'.repeat(64)},receipt:null};
  f.db.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(KEY,JSON.stringify(permit),'c02 BYOK synthetic maintenance permit');
  const getPermit=()=>JSON.parse(f.db.prepare('SELECT value FROM system_config WHERE key=?').get(KEY).value);
  const setPermit=p=>f.db.prepare('UPDATE system_config SET value=? WHERE key=?').run(typeof p==='string'?p:JSON.stringify(p),KEY);
  return Object.assign(f,{ctx,permit,before,getPermit,setPermit,restoreRows:()=>{const rows=f.allRows();rows.system_config=rows.system_config.filter(r=>r.key!==KEY);return rows;}});
}
