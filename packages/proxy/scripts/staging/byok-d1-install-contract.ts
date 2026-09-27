export const BYOK_D1_INSTALL_ACTION = 'install-fence';
export type ByokD1InstallGrant = {
  version: 1; runId: string; tokenHash: string; schemaSha256: string; fencedSchemaSha256: string;
  issuedAt: number; expiresAt: number;
};
type Counters = {
  statements: number; calls: number; active: number; peakActive: number;
  acknowledgedRowsRead: number; acknowledgedRowsWritten: number; callsWithoutRowMetadata: number; nativeRejectedCalls: number;
};
export type ByokD1InstallReceipt = {
  code: 'fence_installed'; runId: string; schemaSha256: string; fencedSchemaSha256: string;
  triggerCount: 15; installStatements: 17; closed: true; counters: Counters;
};
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === keys.sort().join(',');
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function check(v: unknown): asserts v { if (!v) throw new Error('byok_install_invalid'); }

/** Public deployment grant contains only a high-entropy credential's hash, no
 * bearer. Empty default disables installation; there is no caller-supplied SQL. */
export function parseByokD1InstallGrant(raw: string): ByokD1InstallGrant {
  check(typeof raw === 'string' && raw.length <= 1024 && /^[\x20-\x7e]+$/.test(raw));
  const v: unknown = JSON.parse(raw);
  check(object(v) && exact(v, ['version','runId','tokenHash','schemaSha256','fencedSchemaSha256','issuedAt','expiresAt'])
    && v.version === 1 && typeof v.runId === 'string' && /^c02-byok-[a-f0-9]{12}$/.test(v.runId)
    && hash(v.tokenHash) && hash(v.schemaSha256) && hash(v.fencedSchemaSha256) && v.schemaSha256 !== v.fencedSchemaSha256
    && integer(v.issuedAt) && integer(v.expiresAt) && v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 900);
  return { version:1,runId:v.runId,tokenHash:v.tokenHash,schemaSha256:v.schemaSha256,fencedSchemaSha256:v.fencedSchemaSha256,
    issuedAt:v.issuedAt,expiresAt:v.expiresAt };
}
export function parseByokD1InstallReceipt(v: unknown, grant: ByokD1InstallGrant): ByokD1InstallReceipt {
  check(object(v) && exact(v,['code','runId','schemaSha256','fencedSchemaSha256','triggerCount','installStatements','closed','counters'])
    && v.code === 'fence_installed' && v.runId === grant.runId && v.schemaSha256 === grant.schemaSha256
    && v.fencedSchemaSha256 === grant.fencedSchemaSha256 && v.triggerCount === 15 && v.installStatements === 17 && v.closed === true);
  const c = v.counters;
  check(object(c) && exact(c,['statements','calls','active','peakActive','acknowledgedRowsRead','acknowledgedRowsWritten','callsWithoutRowMetadata','nativeRejectedCalls'])
    && Object.values(c).every(integer) && c.statements === 41 && c.calls === 9 && c.active === 0 && c.peakActive === 1
    && typeof c.acknowledgedRowsRead === 'number' && c.acknowledgedRowsRead <= 100000
    && typeof c.acknowledgedRowsWritten === 'number' && c.acknowledgedRowsWritten <= 10000
    && c.callsWithoutRowMetadata === 0 && c.nativeRejectedCalls === 0);
  return {code:'fence_installed',runId:grant.runId,schemaSha256:grant.schemaSha256,fencedSchemaSha256:grant.fencedSchemaSha256,
    triggerCount:15,installStatements:17,closed:true,counters:{statements:41,calls:9,active:0,peakActive:1,
      acknowledgedRowsRead:c.acknowledgedRowsRead,acknowledgedRowsWritten:c.acknowledgedRowsWritten,callsWithoutRowMetadata:0,nativeRejectedCalls:0}};
}
