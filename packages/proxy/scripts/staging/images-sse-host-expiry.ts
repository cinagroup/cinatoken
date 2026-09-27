import {sseSnapshotFaultRow, withSseSnapshotFault, type SseSnapshotFault} from './images-sse-snapshot-fault-v2';

export const SSE_HOST_EXPIRY_MS = 45_000;
const update = 'UPDATE system_config SET value=?,updated_at=? WHERE key=? AND description=? AND value=?';

/** Staging-only fixed host-expiry profile layered under the frozen V2 native INSERT oracle.
 * Pause AFTER the native held-marker CAS, BEFORE its acknowledgement reaches V2. Its ordinary
 * release polling is consequently never entered. No abort(), configurable timer or retry.
 * A surviving timer is a failed experiment, never evidence of platform cancellation.
 */
export function withSseSnapshotHostExpiry(db: D1Database, input: SseSnapshotFault): D1Database {
  const probe = Object.freeze({runId: input.runId, probeId: input.probeId, mode: input.mode});
  const row = sseSnapshotFaultRow(probe);
  if (!['before-hold', 'after-hold'].includes(probe.mode)) throw new TypeError('Invalid SSE host expiry profile');
  const phase = probe.mode === 'before-hold' ? 'held-before-insert' : 'held-after-insert';
  const owned = new WeakMap<D1PreparedStatement, {native: D1PreparedStatement; target: boolean}>();
  let used = false;
  function heldValue(sql: string, values: readonly unknown[]): string | null {
    if (sql.trim().replace(/\s+/g, ' ') !== update || values.length !== 5
      || values[2] !== row.key || values[3] !== row.description
      || typeof values[0] !== 'string' || values[0].length > 2048) return null;
    let value: unknown;
    try {value = JSON.parse(values[0]);} catch {return null;}
    if (!value || typeof value !== 'object' || !('phase' in value) || value.phase !== phase
      || !('runId' in value) || value.runId !== probe.runId
      || !('probeId' in value) || value.probeId !== probe.probeId
      || !('mode' in value) || value.mode !== probe.mode) return null;
    return values[0];
  }
  function wrap(native: D1PreparedStatement, sql: string, values: readonly unknown[] = []): D1PreparedStatement {
    const held = heldValue(sql, values);
    async function run<T>(): Promise<D1Result<T>> {
      if (held === null) return native.run<T>();
      if (used) throw new Error('C02_SSE_HOST_EXPIRY_ALREADY_USED');
      used = true;
      const result = await native.run<T>();
      // The original V2 transition handles failed ownership, without entering any timer.
      if (!result.success || result.meta.changes !== 1) return result;
      await new Promise<void>(resolve => setTimeout(resolve, SSE_HOST_EXPIRY_MS));
      const failed = JSON.stringify({...JSON.parse(held), phase: 'host-expiry-not-observed'});
      const marked = await db.prepare(update).bind(failed, new Date().toISOString(), row.key, row.description, held).run();
      if (!marked.success || marked.meta.changes !== 1) throw new Error('C02_SSE_HOST_EXPIRY_OWNERSHIP_CHANGED');
      throw new Error('C02_SSE_HOST_EXPIRY_NOT_OBSERVED');
    }
    const unsupported = async (): Promise<never> => {throw new Error('C02_SSE_HOST_EXPIRY_NON_RUN_MARKER');};
    const statement: D1PreparedStatement = {
      bind: (...bound) => wrap(native.bind(...bound), sql, [...bound]), run,
      first: held === null ? native.first.bind(native) : unsupported,
      all: held === null ? native.all.bind(native) : unsupported,
      raw: held === null ? native.raw.bind(native) : unsupported,
    };
    owned.set(statement, {native, target: held !== null});
    return statement;
  }
  const boundary: D1Database = {
    prepare: sql => wrap(db.prepare(sql), sql),
    batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      return db.batch<T>(statements.map(statement => {
        const entry = owned.get(statement);
        if (!entry || entry.target) throw new Error('C02_SSE_HOST_EXPIRY_UNSUPPORTED_BATCH');
        return entry.native;
      }));
    },
    exec: db.exec.bind(db), dump: db.dump.bind(db),
    withSession() {throw new Error('C02_SSE_HOST_EXPIRY_SESSION_UNSUPPORTED');},
  };
  return withSseSnapshotFault(boundary, probe);
}
