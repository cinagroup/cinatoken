import assert from 'node:assert/strict';
import {exactStagingRowGuard} from './staging-sql-row-guard.mjs';

const financial=['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations'];
const guard=(condition,params)=>({sql:`SELECT CASE WHEN ${condition} THEN 1 ELSE json('unused_fixture_changed') END AS cleanup_guard`,params});

/** ONLY an acknowledged canonical seed with no inference/RPC send is eligible.
 * Caller owns the original counters and must close access/tail and revoke key.
 * Uncertain inference and uncertain seed are deliberately excluded. Never call
 * this as an alternative to native/financial reconciliation after a send.
 */
export async function removeUnusedSsePeerFixture({session,fixture,seed,seedAcknowledged,seedFinished,primarySends,finalization,
  baselineCounts,batch,persist,onWait}) {
  assert.equal(seedAcknowledged,true);assert.equal(primarySends,0);assert.equal(session.lastRpcFinished,undefined);
  assert.ok(session.requests.every(r=>!r.timing.headers&&!r.id));
  assert.equal(finalization.accessClosed,true);assert.equal(finalization.tailAbsent,true);assert.equal(finalization.keyRevoked,true);
  assert.ok(!finalization.errors.includes('journal'));assert.equal(fixture.ids.runId,session.plan.runId);
  for(const t of financial)assert.equal(baselineCounts[t],0);
  const tables=Object.keys(baselineCounts);for(const t of tables)assert.match(t,/^[a-z][a-z0-9_]*$/);
  const countsQuery={sql:'SELECT '+tables.map(t=>`(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(','),params:[]};
  const expected={...baselineCounts},selected=seed.map(s=>{
    const m=/^INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES \([?,]+\)$/.exec(s.sql);assert.ok(m);
    const table=m[1],names=m[2].split(',');assert.ok(table in expected);expected[table]++;
    assert.equal(names.length,s.params.length);assert.ok(names.every(n=>/^[a-z][a-z0-9_]*$/.test(n)));
    return {table,query:{sql:`SELECT * FROM ${table} WHERE ${names.map(n=>n+' IS ?').join(' AND ')} LIMIT 2`,params:s.params}};
  });
  const deadline=session.clock.after(seedFinished,350000);
  await persist({step:'peer-unused-fixture-wait',deadline});await session.clock.waitUntil(deadline,{onWait});
  const rows=await batch([countsQuery,...selected.map(s=>s.query)]);
  assert.equal(rows.length,selected.length+1);assert.deepEqual(rows[0].map(r=>({...r})),[expected]);
  const statements=tables.map(t=>guard(`(SELECT COUNT(*) FROM ${t})=?`,[expected[t]]));
  for(let i=0;i<selected.length;i++){
    assert.equal(rows[i+1].length,1);const row={...rows[i+1][0]},table=selected[i].table;
    if(table==='users'){assert.equal(row.id,fixture.ids.user);assert.equal(row.budget_spent_micros,0);assert.equal(row.budget_reserved_micros,0);}
    if(table==='api_keys'){assert.equal(row.id,fixture.ids.key);assert.equal(row.status,'revoked');assert.equal(row.key_hash,session.plan.keyHash);}
    statements.push(exactStagingRowGuard(table,row));
  }
  for(const s of selected.filter(s=>s.table==='system_config'))statements.push({sql:'DELETE FROM system_config WHERE key=? AND value=? AND description=?',params:s.query.params});
  statements.push(...fixture.cleanup);
  assert.ok(statements.length<=256&&Buffer.byteLength(JSON.stringify(statements))<=1048576);
  await persist({step:'peer-unused-fixture-facts',runId:session.plan.runId,observed:rows,primarySends:0,seedAcknowledged:true});
  await batch(statements); // One atomic transaction, never split or replay.
  const after=await batch([countsQuery]);assert.deepEqual(after[0].map(r=>({...r})),[baselineCounts]);
  await persist({step:'peer-unused-fixture-removed',runId:session.plan.runId});
  return {fixtureRemoved:true,unusedFixture:true,experimentPassed:false};
}
