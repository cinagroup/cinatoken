/** V2 staging-only, request-owned D1 boundary probe. No production import or arbitrary SQL/timing input. */
export const SSE_SNAPSHOT_FAULT_MODES = ['before-fail', 'after-ack-loss', 'snapshot-read-fail', 'job-read-fail', 'before-hold', 'after-hold'] as const;
export type SseSnapshotFaultMode = typeof SSE_SNAPSHOT_FAULT_MODES[number];
export type SseSnapshotFault = Readonly<{ runId: string; probeId: string; mode: SseSnapshotFaultMode }>;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const pattern = new RegExp(`^c02-snapshot:(c02-success-${uuid}):(${uuid}):(${SSE_SNAPSHOT_FAULT_MODES.join('|')})$`);
export function parseSseSnapshotFault(value: unknown): SseSnapshotFault | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const match = pattern.exec(value);
  const mode = SSE_SNAPSHOT_FAULT_MODES.find(mode => mode === match?.[3]);
  return match && mode ? { runId: match[1], probeId: match[2], mode } : null;
}
export function sseSnapshotFaultRow(input: SseSnapshotFault) {
  const probe = parseSseSnapshotFault(`c02-snapshot:${input.runId}:${input.probeId}:${input.mode}`);
  if (!probe) throw new TypeError('Invalid bounded SSE snapshot fault');
  return { key: 'c02_sse_snapshot:' + probe.probeId, description: 'c02-snapshot:' + probe.runId,
    value: JSON.stringify({ ...probe, phase: 'armed' }) };
}

// Match the complete current repository shapes. SQL drift is a failed/missed experiment, not a broad matcher.
const insertSql = 'INSERT INTO request_usage_settlements (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,dispatch_claim_id,payload_version,payload_json,payload_sha256,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING';
const snapshotRead = 'SELECT * FROM request_usage_settlements WHERE request_id=? AND user_id=? AND api_key_id=? AND workspace_id=? AND payload_sha256=?';
const jobRead = 'SELECT * FROM request_usage_recovery_jobs WHERE request_id=? AND user_id=? AND api_key_id=? AND workspace_id=? AND payload_sha256=?';
const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const generation = new RegExp(`^gen-${uuid}$`);
const claim = new RegExp(`^${uuid}$`);
export const SSE_SNAPSHOT_HOLD_MS = 20_000;
const pollMs = 250, polls = SSE_SNAPSHOT_HOLD_MS / pollMs;

export function withSseSnapshotFault(db: D1Database, input: SseSnapshotFault): D1Database {
  // Own the scalars before any await; callers cannot change the selected mode or tenant later.
  const probe = Object.freeze({ runId: input.runId, probeId: input.probeId, mode: input.mode });
  const row = sseSnapshotFaultRow(probe);
  const nativeStatements = new WeakMap<D1PreparedStatement, { native: D1PreparedStatement; target: boolean }>();
  let used = false, inserted = false, readFaultUsed = false, current = row.value;
  let requestId: string | undefined, payloadSha256: string | undefined;
  let nativeResult: { success: boolean | null; changes: number | null; rowsWritten: number | null; identityVerified: boolean } | undefined;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const state = (phase: string) => JSON.stringify({ ...probe, requestId, payloadSha256, phase, nativeResult });
  async function transition(phase: string) {
    const next = state(phase);
    const result = await db.prepare('UPDATE system_config SET value=?,updated_at=? WHERE key=? AND description=? AND value=?')
      .bind(next, new Date().toISOString(), row.key, row.description, current).run();
    if (!result.success || result.meta.changes !== 1) throw new Error('C02_SNAPSHOT_OWNERSHIP_UNCONFIRMED');
    current = next;
  }
  async function hold() {
    const release = state('release-requested');
    for (let i = 0; i < polls; i++) {
      const value = await db.prepare('SELECT value FROM system_config WHERE key=? AND description=?')
        .bind(row.key, row.description).first<string>('value');
      if (value === release) { current = release; return; }
      if (value !== current) throw new Error('C02_SNAPSHOT_OWNERSHIP_CHANGED');
      await new Promise<void>(resolve => setTimeout(resolve, pollMs));
    }
    await transition('release-timeout');
    throw new Error('C02_SNAPSHOT_RELEASE_TIMEOUT');
  }
  function matchesInsert(values: readonly unknown[]) {
    return values.length === 12 && typeof values[0] === 'string' && generation.test(values[0])
      && Number.isSafeInteger(values[1]) && Number(values[1]) >= 1 && Number(values[1]) <= 32
      && values[2] === probe.runId + '-user' && values[3] === probe.runId + '-key' && values[4] === probe.runId + '-workspace'
      && values[5] === 'images.generations' && hash(values[6]) && typeof values[7] === 'string' && claim.test(values[7])
      && values[8] === 1 && typeof values[9] === 'string' && values[9].length <= 262144 && hash(values[10])
      && typeof values[11] === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(values[11]);
  }
  function matchesRead(values: readonly unknown[]) {
    return values.length === 5 && values[0] === requestId && values[1] === probe.runId + '-user'
      && values[2] === probe.runId + '-key' && values[3] === probe.runId + '-workspace' && values[4] === payloadSha256;
  }
  function wrap(native: D1PreparedStatement, sql: string, values: readonly unknown[] = []): D1PreparedStatement {
    const shape = normalize(sql), target = shape === insertSql && matchesInsert(values);
    async function run<T>(): Promise<D1Result<T>> {
      if (!target) return native.run<T>();
      if (used) throw new Error('C02_SNAPSHOT_ALREADY_USED');
      used = true; requestId = String(values[0]); payloadSha256 = String(values[10]);
      await transition('claimed');
      if (probe.mode === 'before-fail') {
        await transition('failed-before-insert'); throw new Error('C02_SNAPSHOT_BEFORE_INSERT');
      }
      if (probe.mode === 'before-hold') { await transition('held-before-insert'); await hold(); }
      // Real standalone INSERT: the existing trigger enqueues the job in this same native transaction.
      const result = await native.run<T>();
      // D1 changes can include trigger writes. Preserve the returned object unchanged;
      // a positive count is necessary for this one-shot experiment, not proof of a charge.
      nativeResult = {
        success: typeof result.success === 'boolean' ? result.success : null,
        changes: count(result.meta?.changes), rowsWritten: count(result.meta?.rows_written),
        identityVerified: false,
      };
      if (nativeResult.success !== true || nativeResult.changes === null || nativeResult.changes < 1) {
        await transition('insert-not-applied'); throw new Error('C02_SNAPSHOT_INSERT_NOT_APPLIED');
      }
      await transition('insert-result-observed');
      // Diagnostic read on the native binding: do not consume either repository read fault.
      // Compare every INSERT field in SQL without loading the potentially large payload again.
      // Job state may advance concurrently; its immutable identity must still match the snapshot.
      const verified = await db.prepare(`SELECT EXISTS(
        SELECT 1 FROM request_usage_settlements s JOIN request_usage_recovery_jobs j
          ON j.request_id=s.request_id AND j.user_id=s.user_id AND j.api_key_id=s.api_key_id
          AND j.workspace_id=s.workspace_id AND j.payload_sha256=s.payload_sha256
        WHERE s.request_id=? AND s.attempt_index=? AND s.user_id=? AND s.api_key_id=?
          AND s.workspace_id=? AND s.operation=? AND s.context_sha256=? AND s.dispatch_claim_id=?
          AND s.payload_version=? AND s.payload_json=? AND s.payload_sha256=? AND s.recorded_at=?
      ) AS identity_verified`).bind(...values).first<number>('identity_verified');
      if (verified !== 1) {
        await transition('insert-identity-unconfirmed'); throw new Error('C02_SNAPSHOT_IDENTITY_UNCONFIRMED');
      }
      nativeResult.identityVerified = true;
      inserted = true;
      await transition('insert-committed');
      if (probe.mode === 'after-ack-loss') {
        await transition('insert-ack-lost'); throw new Error('C02_SNAPSHOT_ACK_LOST');
      }
      if (probe.mode === 'after-hold') { await transition('held-after-insert'); await hold(); }
      await transition('insert-ack-returned');
      return result;
    }
    async function first<T>(column?: string): Promise<T | null> {
      if (target) throw new Error('C02_SNAPSHOT_NON_RUN_INSERT');
      const readTarget = probe.mode === 'snapshot-read-fail' ? snapshotRead : probe.mode === 'job-read-fail' ? jobRead : null;
      if (inserted && !readFaultUsed && shape === readTarget && matchesRead(values)) {
        readFaultUsed = true;
        await transition(probe.mode === 'snapshot-read-fail' ? 'snapshot-read-failed' : 'job-read-failed');
        throw new Error('C02_SNAPSHOT_READ_UNAVAILABLE');
      }
      return column === undefined ? native.first<T>() : native.first<T>(column);
    }
    const statement: D1PreparedStatement = {
      bind: (...bound) => wrap(native.bind(...bound), sql, [...bound]), run, first,
      all: target ? async () => { throw new Error('C02_SNAPSHOT_NON_RUN_INSERT'); } : native.all.bind(native),
      raw: target ? async () => { throw new Error('C02_SNAPSHOT_NON_RUN_INSERT'); } : native.raw.bind(native),
    };
    nativeStatements.set(statement, { native, target });
    return statement;
  }
  return {
    prepare: sql => wrap(db.prepare(sql), sql),
    batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const native = statements.map(statement => {
        const entry = nativeStatements.get(statement);
        if (!entry) throw new Error('C02_SNAPSHOT_FOREIGN_STATEMENT');
        if (entry.target) throw new Error('C02_SNAPSHOT_BATCH_INSERT_UNSUPPORTED');
        return entry.native;
      });
      return db.batch<T>(native); // Never split, repeat or emulate the accounting transaction.
    },
    exec: db.exec.bind(db), dump: db.dump.bind(db),
    withSession() { throw new Error('C02_SNAPSHOT_SESSION_UNSUPPORTED'); },
  };
}
