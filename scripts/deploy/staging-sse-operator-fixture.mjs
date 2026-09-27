import assert from 'node:assert/strict';
import {imageSsePrompt,imageSseRow,parseImageSseProbe} from '../../packages/proxy/scripts/staging/images-sse-probe-contract.ts';
import {imageSseFixture} from './staging-image-sse-fixture.mjs';
import {snapshotSseCleanupStatements} from './staging-sse-snapshot-reconciliation.mjs';

/** The Worker reparses the prompt before creating its byte-exact CAS row.
 * Operator objects may have any property insertion order; normalize through that SAME parser.
 * No change to a deployed Worker, its existing probe, or the money/persistence contract.
 */
export function canonicalSseOperatorRow(probe){
  const canonical=parseImageSseProbe(imageSsePrompt(probe));assert.ok(canonical);
  return imageSseRow(canonical);
}
const guard=(condition,params=[])=>({sql:`SELECT CASE WHEN ${condition} THEN 1 ELSE json('failed_sse_probe_cleanup_precondition_failed') END AS cleanup_guard`,params});
const exact=(table,row)=>{const names=Object.keys(row);assert.ok(names.length>0&&names.length<=100&&names.every(n=>/^[a-z][a-z0-9_]*$/.test(n)));
  return guard(`EXISTS(SELECT 1 FROM ${table} WHERE ${names.map(n=>n+' IS ?').join(' AND ')})`,names.map(n=>row[n]));};

/** Narrow failed-experiment cleanup, NOT successful SSE acceptance or a refund.
 * Caller must close BOTH Access surfaces, revoke the exact key, wait the fixed safety window,
 * verify staging DB/schema, read owned scopes including unexpected rows, and persist all facts.
 * Only one before-fail intent + untouched armed upstream is supported; nothing is reclassified.
 */
export async function failedSseOperatorCleanupStatements({journal,observed,snapshotRows,upstreamRows,users,keys}){
  assert.equal(journal.requests.length,1);assert.equal(journal.requests[0].mode,'before-fail');
  const plan=snapshotSseCleanupStatements(journal,observed,snapshotRows);assert.equal(plan.unknown,1);assert.equal(plan.committed,0);
  assert.equal(upstreamRows.length,1);const upstream=upstreamRows[0],p=journal.probes[0];
  assert.equal(upstream.key,'c02_images_sse_probe:'+p.probeId);assert.equal(upstream.description,'c02-sse:'+journal.runId);
  assert.ok(typeof upstream.value==='string'&&Buffer.byteLength(upstream.value)<=2048);
  assert.deepEqual(JSON.parse(upstream.value),{runId:journal.runId,probeId:p.probeId,mode:'success',phase:'armed'});
  assert.equal(users.length,1);assert.equal(keys.length,1);const user=users[0],key=keys[0];
  assert.deepEqual(user,{id:journal.runId+'-user',metadata:JSON.stringify({staging_fixture:journal.runId,purpose:'private-synthetic-images'}),budget_spent_micros:0,budget_reserved_micros:100000});
  assert.deepEqual(key,{id:journal.runId+'-key',user_id:journal.runId+'-user',workspace_id:journal.runId+'-workspace',key_hash:journal.keyHash,status:'revoked'});
  const fixture=await imageSseFixture(journal.runId,journal.keyHash,journal.expiresAt);
  const statements=[exact('users',user),exact('api_keys',key),
    guard('(SELECT COUNT(*) FROM system_config WHERE key=? OR description=?)=1',[upstream.key,upstream.description]),
    exact('system_config',upstream),...plan.statements,
    {sql:'DELETE FROM system_config WHERE key=? AND description=? AND value=?',params:[upstream.key,upstream.description,upstream.value]},...fixture.cleanup];
  assert.ok(statements.length<=256&&statements.every(s=>s.params.length<=100&&Buffer.byteLength(s.sql)<=100000));
  assert.ok(Buffer.byteLength(JSON.stringify({batch:statements}))<=1048576);return statements;
}
