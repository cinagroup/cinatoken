import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';
import { timingSafeEqual } from 'node:crypto';
import { BYOK_D1_MAINTENANCE_KEY, createByokD1Cleanup } from './byok-d1-cleanup';
import { BYOK_D1_FENCE_KEY, BYOK_D1_FENCE_CLOSED } from './byok-d1-write-fence';
import { BYOK_MAINTENANCE_MAX_BYTES, parseByokMaintenancePermit } from './byok-d1-maintenance-contract';

export type ByokMaintenanceResult = { status: 'cleaned'; runId: string; removedRows: number; statementCount: number }
  | { status: 'disabled' | 'invalid_arguments' | 'host_rejected' | 'not_authorized' | 'not_admissible' | 'outcome_unknown' };

/** Only the staging receiver supplies the bound DB and enable flag. A caller
 * supplies an opaque credential, never SQL, scope, baseline or a binding. The
 * privileged operator INSERTs the fixed permit once after fresh closure; this
 * module has no provisioning/reset or resume operation. */
export function runByokD1Maintenance(db: D1Database, enabled: boolean, token: unknown,
  ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<ByokMaintenanceResult> {
  if (!enabled) return Promise.resolve({status:'disabled'});
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return Promise.resolve({status:'invalid_arguments'});
  let registered = false;
  const task = Promise.resolve().then(async (): Promise<ByokMaintenanceResult> => {
    if (!registered) return {status:'host_rejected'};
    try {
      const row = await db.prepare('SELECT value FROM system_config WHERE key = ? AND length(CAST(value AS BLOB)) <= ?')
        .bind(BYOK_D1_MAINTENANCE_KEY,BYOK_MAINTENANCE_MAX_BYTES).first<{value:string}>();
      if (!row || typeof row.value !== 'string') return {status:'not_authorized'};
      const permit = parseByokMaintenancePermit(row.value);
      const actual = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));
      const expected = Uint8Array.from(permit.tokenHash.match(/../g)!, h=>Number.parseInt(h,16));
      if (!timingSafeEqual(expected,actual)) return {status:'not_authorized'};
      if (permit.state !== 'ready') return {status:'not_admissible'};
      const pending = JSON.stringify({...permit,state:'pending'});
      const claimed = await db.prepare(`UPDATE system_config SET value = ? WHERE key = ? AND value = ?
        AND unixepoch('now') >= ? AND unixepoch('now') < ? AND unixepoch('now') - ? BETWEEN 0 AND 15`)
        .bind(pending,BYOK_D1_MAINTENANCE_KEY,row.value,permit.issuedAt,permit.expiresAt,permit.closure.observedAt).run();
      if (!claimed.success || !Number.isSafeInteger(claimed.meta.changes) || claimed.meta.changes < 0 || claimed.meta.changes > 1) throw new Error('claim_unknown');
      if (claimed.meta.changes === 0) return {status:'not_admissible'};
      // No transition back to ready, including validation failures or lost ACKs.
      const containment = async () => {
        const proof = await db.prepare(`SELECT f.value AS fence, p.value AS permit FROM system_config f
          JOIN system_config p ON p.key = ? WHERE f.key = ? AND p.value = ? AND f.value = ?
          AND unixepoch('now') - ? BETWEEN 0 AND 15`)
          .bind(BYOK_D1_MAINTENANCE_KEY,BYOK_D1_FENCE_KEY,pending,BYOK_D1_FENCE_CLOSED,permit.closure.observedAt)
          .first<{fence:string;permit:string}>();
        if (!proof || proof.fence !== BYOK_D1_FENCE_CLOSED || proof.permit !== pending) throw new Error('containment_unconfirmed');
        // The cleanup module separately pins all trigger definitions and row sets.
        // This validates a trusted closure attestation + DB fence, not cloud I/O.
      };
      const task = createByokD1Cleanup({db,baseline:permit.baseline,runId:permit.runId,maintenanceValue:pending,
        assertProducerClosed:containment,persist:async event=>{
          if (event.result === 'PENDING') { await containment(); return; } // claim is already durable before all cleanup work
          if (event.result !== 'ACK' || typeof event.report !== 'object' || event.report === null) throw new Error('receipt_invalid');
          const report = event.report as Record<string,unknown>;
          const receipt = {removedRows:report.removedRows,statementCount:report.statementCount,statementBytes:report.statementBytes};
          const finished = JSON.stringify({...permit,state:'finished',receipt});parseByokMaintenancePermit(finished);
          const ack = await db.prepare('UPDATE system_config SET value = ? WHERE key = ? AND value = ?')
            .bind(finished,BYOK_D1_MAINTENANCE_KEY,pending).run();
          if (!ack.success || ack.meta.changes !== 1) throw new Error('receipt_unknown');
        }});
      const report = await task.run();
      return report.result === 'CLEANED' ? {status:'cleaned',runId:permit.runId,removedRows:report.removedRows,statementCount:report.statementCount}
        : {status:'outcome_unknown'};
    } catch { return {status:'outcome_unknown'}; }
  });
  // Register before even the authorization read. Client/RPC disconnect is not
  // proof that a database call stopped; a surviving PENDING is never retried.
  try { ctx.waitUntil(task.then(()=>{})); registered = true; } catch { /* no I/O */ }
  return task;
}
