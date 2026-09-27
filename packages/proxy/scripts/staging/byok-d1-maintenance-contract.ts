import { BYOK_CLEANUP_TABLES, type ByokCleanupBaseline } from './byok-d1-cleanup';

export const BYOK_MAINTENANCE_MAX_BYTES = 16384;
export const BYOK_MAINTENANCE_ORIGIN = 'https://cinatoken-staging-recovery-control.cinagroup.workers.dev';
export const BYOK_MAINTENANCE_PATH = '/_control/byok-d1/cleanup';
export type ByokMaintenancePermit = {
  version: 1; runId: string; tokenHash: string; issuedAt: number; expiresAt: number;
  state: 'ready' | 'pending' | 'finished';
  baseline: ByokCleanupBaseline;
  /** Trusted operator attestation, not proof that this receiver inspected Cloudflare. */
  closure: { observedAt: number; evidenceSha256: string };
  receipt: null | { removedRows: number; statementCount: number; statementBytes: number };
};
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: readonly string[]) => Object.keys(v).sort().join(',') === names.slice().sort().join(',');
const uint = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function invalid(): never { throw new Error('byok_maintenance_invalid'); }
export function parseByokMaintenancePermit(raw: string): ByokMaintenancePermit {
  if (raw.length > BYOK_MAINTENANCE_MAX_BYTES || !/^[\x20-\x7e]+$/.test(raw)) invalid();
  const p: unknown = JSON.parse(raw);
  if (!obj(p) || !keys(p, ['version','runId','tokenHash','issuedAt','expiresAt','state','baseline','closure','receipt'])
    || p.version !== 1 || typeof p.runId !== 'string' || !/^c02-byok-[a-f0-9]{12}$/.test(p.runId) || !hash(p.tokenHash)
    || !uint(p.issuedAt) || !uint(p.expiresAt) || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > 60
    || typeof p.state !== 'string' || !['ready','pending','finished'].includes(p.state)) invalid();
  const b = p.baseline, c = p.closure;
  if (!obj(b) || !keys(b, ['version','schemaSha256','counts','preservedRowSha256','fence']) || b.version !== 1 || b.fence !== 'write-fence-v1'
    || !hash(b.schemaSha256) || !obj(b.counts) || !keys(b.counts, BYOK_CLEANUP_TABLES)
    || !obj(b.preservedRowSha256) || !keys(b.preservedRowSha256, ['admin_api_keys','d1_migrations','model_endpoint_backfill_database_identity','system_config'])
    || !Object.values(b.preservedRowSha256).every(hash) || !obj(c) || !keys(c,['observedAt','evidenceSha256'])
    || !uint(c.observedAt) || c.observedAt > p.issuedAt || p.issuedAt - c.observedAt > 5 || !hash(c.evidenceSha256)) invalid();
  const counts: Record<string, number> = {};
  for (const t of BYOK_CLEANUP_TABLES) {
    const expected = t === 'system_config' ? 13 : t === 'd1_migrations' ? 68 : ['admin_api_keys','model_endpoint_backfill_database_identity'].includes(t) ? 1 : 0;
    if (b.counts[t] !== expected) invalid(); counts[t] = expected;
  }
  let receipt: ByokMaintenancePermit['receipt'] = null;
  if (p.state === 'finished') {
    const r = p.receipt;
    if (!obj(r) || !keys(r,['removedRows','statementCount','statementBytes']) || !uint(r.removedRows,1200) || r.removedRows < 1
      || !uint(r.statementCount,256) || r.statementCount < 1 || !uint(r.statementBytes,1048576) || r.statementBytes < 1) invalid();
    receipt = { removedRows:r.removedRows, statementCount:r.statementCount, statementBytes:r.statementBytes };
  } else if (p.receipt !== null) invalid();
  return { version:1,runId:p.runId,tokenHash:p.tokenHash,issuedAt:p.issuedAt,expiresAt:p.expiresAt,
    state:p.state as ByokMaintenancePermit['state'],closure:{observedAt:c.observedAt,evidenceSha256:c.evidenceSha256},receipt,
    baseline:{version:1,fence:'write-fence-v1',schemaSha256:b.schemaSha256,counts,
      preservedRowSha256:Object.fromEntries(Object.entries(b.preservedRowSha256).map(([k,v])=>{if(!hash(v))invalid();return [k,v];}))} };
}
