import { BYOK_D1_CASES } from './byok-d1-acceptance';
import { BYOK_D1_CONTROL_KEY } from './byok-d1-one-shot';

/** Staging-only persistent safety schema. Pure statement builders; no automatic
 * install, migration, HTTP endpoint or I/O. Install only after the operator's
 * full closed/empty/schema/identity/budget preflight, in ONE native D1 batch.
 * The fence remains installed and closed after cleanup; dropping it would let
 * delayed statements execute again. It is not protection against a privileged
 * actor that can edit system_config or drop triggers.
 */
export const BYOK_D1_FENCE_KEY = 'c02_byok_d1_write_fence_v1';
export const BYOK_D1_FENCE_CLOSED = '{"version":1,"state":"closed","runId":null}';
export const BYOK_D1_FENCE_DESCRIPTION = 'c02 BYOK staging write fence v1';
const tables = ['users', 'workspaces', 'management_api_keys', 'byok_keys', 'user_audit_logs'] as const;
type Table = typeof tables[number];
type Query = { sql: string; params: (string | number | null)[] };
const check = (value: unknown) => { if (!value) throw new Error('byok_fence_invalid'); };
const safeJson = (alias: string, max: number) => `CASE WHEN length(CAST(${alias}.value AS BLOB)) <= ${max} AND json_valid(${alias}.value) THEN ${alias}.value ELSE '{}' END`;
const f = (field: string) => `json_extract(${safeJson('f', 128)},'$.${field}')`;
const c = (field: string) => `json_extract(${safeJson('c', 32768)},'$.${field}')`;
const validRun = (value: string) => `(length(${value}) = 21 AND substr(${value},1,9) = 'c02-byok-' AND substr(${value},10) NOT GLOB '*[^0-9a-f]*')`;
function scope(table: Table, row: 'NEW' | 'OLD', prefix: string, auditFault = false): string {
  const id = (suffix: string) => `(${prefix} || '-${suffix}')`;
  if (table === 'users') return `${row}.id IS ${id('u')}`;
  if (table === 'workspaces') return `${row}.id IS ${id('w')} AND ${row}.personal_owner_user_id IS ${id('u')}`;
  if (table === 'management_api_keys') return `${row}.id IS ${id('m')} AND ${row}.personal_owner_user_id IS ${id('u')}`;
  if (table === 'byok_keys') return `${row}.workspace_id IS ${id('w')}`;
  // The existing audit-rollback case intentionally references a missing user.
  // Let its original FK constraint reject it; the fence must not mask that test.
  return `(${row}.user_id IS ${id('u')}${auditFault ? ` OR (${c('pendingCase')} = 'audit-rollback' AND ${row}.user_id IS ${id('absent')})` : ''})`;
}
function trigger(table: Table, operation: 'INSERT' | 'UPDATE' | 'DELETE') {
  const name = `c02_byok_fence_v1_${table}_${operation.toLowerCase()}`;
  const prefix = `(${c('runId')} || '-' || ${c('cursor')})`;
  const admission = `SELECT 1 FROM system_config f JOIN system_config c ON c.key = '${BYOK_D1_CONTROL_KEY}'
    WHERE f.key = '${BYOK_D1_FENCE_KEY}' AND ${f('version')} = 1 AND ${f('state')} = 'open'
    AND ${validRun(f('runId'))} AND ${f('runId')} IS ${c('runId')} AND ${c('version')} = 1 AND ${c('state')} = 'pending'
    AND typeof(${c('cursor')}) = 'integer' AND ${c('cursor')} BETWEEN 0 AND 9
    AND ${c('pendingCase')} IS json_extract('${JSON.stringify(BYOK_D1_CASES)}','$[' || ${c('cursor')} || ']')
    AND unixepoch('now') >= ${c('issuedAt')} AND unixepoch('now') < ${c('expiresAt')}
    AND ${scope(table, 'NEW', prefix, true)}${operation === 'UPDATE' ? ` AND ${scope(table, 'OLD', prefix, true)}` : ''}`;
  const deletion = `SELECT 1 FROM system_config f, json_each('[0,1,2,3,4,5,6,7,8,9]') i
    WHERE f.key = '${BYOK_D1_FENCE_KEY}' AND ${f('version')} = 1 AND ${f('state')} = 'cleaning'
    AND ${validRun(f('runId'))} AND ${scope(table, 'OLD', `(${f('runId')} || '-' || i.value)`)}`;
  return Object.freeze({ name, table, sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
    BEGIN SELECT CASE WHEN EXISTS(${operation === 'DELETE' ? deletion : admission}) THEN 1 ELSE RAISE(ABORT,'c02_byok_write_fenced') END; END` });
}
export const BYOK_D1_FENCE_TRIGGERS = Object.freeze(tables.flatMap(table =>
  (['INSERT', 'UPDATE', 'DELETE'] as const).map(operation => trigger(table, operation))));

export function assertByokD1FenceInstalled(schema: unknown, configRows: { key?: unknown; value?: unknown; description?: unknown }[]) {
  check(Array.isArray(schema)); if (!Array.isArray(schema)) return;
  const objects = schema.filter(r => typeof r === 'object' && r !== null && typeof r.name === 'string' && r.name.startsWith('c02_byok_fence_v1_'));
  check(objects.length === 15);
  for (const expected of BYOK_D1_FENCE_TRIGGERS) {
    const rows = objects.filter(r => r.name === expected.name);
    check(rows.length === 1 && rows[0].type === 'trigger' && rows[0].tbl_name === expected.table && rows[0].sql === expected.sql);
  }
  const rows = configRows.filter(r => r.key === BYOK_D1_FENCE_KEY);
  check(rows.length === 1 && rows[0]?.value === BYOK_D1_FENCE_CLOSED && rows[0].description === BYOK_D1_FENCE_DESCRIPTION);
}

export function byokD1FenceValue(state: 'open' | 'cleaning', runId: string) {
  check((state === 'open' || state === 'cleaning') && /^c02-byok-[a-f0-9]{12}$/.test(runId));
  return JSON.stringify({ version: 1, state, runId });
}
export function byokD1FenceInstallPlan(expectedSchema: string): Query[] {
  check(new TextEncoder().encode(expectedSchema).length <= 262144 && Array.isArray(JSON.parse(expectedSchema)));
  const schema = `SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM
    (SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513)`;
  return [
    { sql: `SELECT CASE WHEN (${schema}) IS ? AND ${tables.map(t => `(SELECT COUNT(*) FROM ${t}) = 0`).join(' AND ')}
      AND NOT EXISTS(SELECT 1 FROM system_config WHERE key IN (?,?)) THEN 1 ELSE json('byok_fence_install_changed') END AS fence_guard`,
      params: [expectedSchema, BYOK_D1_CONTROL_KEY, BYOK_D1_FENCE_KEY] },
    ...BYOK_D1_FENCE_TRIGGERS.map(t => ({ sql: t.sql, params: [] })),
    { sql: 'INSERT INTO system_config(key,value,description) VALUES(?,?,?)', params: [BYOK_D1_FENCE_KEY, BYOK_D1_FENCE_CLOSED, BYOK_D1_FENCE_DESCRIPTION] },
  ];
}
/** Only the external trusted operator may use these control writes. The case
 * runner cannot reset/reopen a fence and its product SQL remains unchanged. */
export function byokD1FenceTransition(runId: string, open: boolean): Query {
  const openValue = byokD1FenceValue('open', runId);
  return { sql: `UPDATE system_config SET value = ? WHERE key = ? AND value = ? AND EXISTS(
    SELECT 1 FROM system_config c WHERE c.key = ? AND ${c('runId')} IS ? AND ${c('state')} = ?
    ${open ? `AND unixepoch('now') >= ${c('issuedAt')} AND unixepoch('now') < ${c('expiresAt')}` : ''})`,
    params: [open ? openValue : BYOK_D1_FENCE_CLOSED, BYOK_D1_FENCE_KEY, open ? BYOK_D1_FENCE_CLOSED : openValue,
      BYOK_D1_CONTROL_KEY, runId, open ? 'ready' : 'stopped'] };
}
