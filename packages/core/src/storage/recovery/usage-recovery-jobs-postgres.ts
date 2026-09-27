import type { PostgresDatabaseClient } from '../database-client';
import { ownPostgresSettlementReference, type PostgresSettlementReference } from './usage-settlement-facts-postgres';
import { SettlementConflictError, SettlementRecoveryClaimUncertainError, type SettlementLeaseProof } from './settlement-recovery-types';

/** Disabled prototype policy only; counts settlement recovery, NEVER inference dispatch. */
export const MAX_POSTGRES_RECOVERY_CLAIMS = 5;
export type PostgresRecoveryScope = Readonly<{ kind: 'all' } | { kind: 'tenant'; userId: string; workspaceId: string }>;
export type PostgresRecoveryScanKind = 'unregistered' | 'due';
export type PostgresRecoveryCandidate = Readonly<{ ref: PostgresSettlementReference; revision: number }>;
export type PostgresRecoveryLease = PostgresRecoveryCandidate & Readonly<{ proof: SettlementLeaseProof; attempts: number; expiresAtMs: number }>;
export type PostgresRecoveryFailure = 'execution_error' | 'interrupted' | 'snapshot_invalid' | 'settlement_conflict';
type State = 'pending' | 'leased' | 'blocked' | 'committed';
type Transition = 'enqueued' | 'claimed' | 'failed' | 'exhausted' | 'committed';
export type PostgresRecoveryJob = PostgresRecoveryCandidate & Readonly<{ state: State; attempts: number; lastTransition: Transition;
  leaseSeconds: number | null; expiresAtMs: number | null; availableAtMs: number | null; lastError: PostgresRecoveryFailure | 'retry_exhausted' | null;
  createdAtMs: number; updatedAtMs: number }>;
type PgQuery = { unsafe<T extends unknown[] = Record<string, unknown>[]>(query: string, params?: readonly unknown[]): PromiseLike<T> };
type PgTransaction = PgQuery & { begin<T>(run: (tx: PgQuery) => Promise<T>): Promise<T> };
const JOB = 'cinatoken_gateway.request_usage_recovery_jobs', FACT = 'cinatoken_gateway.request_usage_settlements', OUTBOX = 'cinatoken_gateway.request_usage_settlement_outbox';
const JOIN = `FROM ${JOB} j JOIN ${FACT} s ON s.request_id=j.request_id AND s.payload_sha256=j.payload_sha256
  AND s.created_at_ms=j.fact_created_at_ms AND s.user_id=j.user_id AND s.workspace_id=j.workspace_id`;
const MATCH = 's.request_id=$1 AND s.attempt_index=$2 AND s.user_id=$3 AND s.api_key_id=$4 AND s.workspace_id=$5 AND s.operation=$6 AND s.context_sha256=$7 AND s.dispatch_claim_id=$8 AND s.payload_sha256=$9';
const REF = 's.request_id,s.attempt_index,s.user_id,s.api_key_id,s.workspace_id,s.operation,s.context_sha256,s.dispatch_claim_id,s.payload_sha256';
const STATUS = `j.state,j.revision::text,j.attempts,j.last_transition,j.lease_seconds,j.lease_expires_at_ms::text,
  j.available_at_ms::text,j.last_error,j.created_at_ms::text,j.updated_at_ms::text`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
type Wire = { request_id: string; attempt_index: number; user_id: string; api_key_id: string; workspace_id: string;
  operation: PostgresSettlementReference['operation']; context_sha256: string; dispatch_claim_id: string; payload_sha256: string;
  state: State; revision: string; attempts: number; last_transition: Transition; lease_seconds: number | null;
  lease_expires_at_ms: string | null; available_at_ms: string | null; last_error: PostgresRecoveryJob['lastError'];
  created_at_ms: string; updated_at_ms: string; lease_token?: string | null };
function args(ref: PostgresSettlementReference): (string | number)[] {
  return [ref.requestId,ref.attemptIndex,ref.userId,ref.apiKeyId,ref.workspaceId,ref.operation,ref.contextSha256,ref.dispatchClaimId,ref.payloadSha256];
}
function number(value: number, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid recovery integer');
}
function integer(value: string): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})(?![\s\S])/.test(value)) throw new Error('Invalid persisted recovery integer');
  const result = Number(value); number(result); return result;
}
export function ownPostgresRecoveryScope(input: PostgresRecoveryScope): PostgresRecoveryScope {
  if (input?.kind === 'all') return Object.freeze({ kind: 'all' });
  if (input?.kind !== 'tenant') throw new TypeError('Explicit recovery scope required');
  const owned = { kind: 'tenant' as const, userId: input.userId, workspaceId: input.workspaceId };
  const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?![\s\S])/;
  if (typeof owned.userId !== 'string' || !id.test(owned.userId) || typeof owned.workspaceId !== 'string' || !id.test(owned.workspaceId)) throw new TypeError('Invalid recovery scope');
  return Object.freeze(owned);
}
/** Closed catalogue for the two non-locking recovery scans; writes are never scan operations. */
export function postgresRecoveryScan(kind: PostgresRecoveryScanKind, input: PostgresRecoveryScope, limit: number):
  Readonly<{ query: string; params: readonly (string | number)[] }> {
  if (kind !== 'unregistered' && kind !== 'due') throw new TypeError('Invalid recovery scan kind');
  const value = ownPostgresRecoveryScope(input); number(limit,1,50);
  const tenant = value.kind === 'tenant';
  const params = Object.freeze(tenant ? [value.userId,value.workspaceId,limit] : [limit]);
  const query = kind === 'unregistered'
    ? `SELECT ${REF} FROM ${FACT} s JOIN ${OUTBOX} o
        ON o.request_id=s.request_id AND o.payload_sha256=s.payload_sha256 AND o.created_at_ms=s.created_at_ms
        WHERE ${tenant ? 's.user_id=$1 AND s.workspace_id=$2 AND ' : ''}NOT EXISTS (SELECT 1 FROM ${JOB} j WHERE j.request_id=s.request_id)
        ORDER BY s.created_at_ms,s.request_id LIMIT $${tenant ? 3 : 1}`
    : `SELECT ${REF},j.revision::text ${JOIN}
        WHERE ${tenant ? 'j.user_id=$1 AND j.workspace_id=$2 AND ' : ''}j.state IN ('pending','leased')
        AND j.available_at_ms <= (SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint)
        ORDER BY j.available_at_ms,j.request_id LIMIT $${tenant ? 3 : 1}`;
  return Object.freeze({ query, params });
}
function candidate(input: PostgresRecoveryCandidate): PostgresRecoveryCandidate {
  const ref = ownPostgresSettlementReference(input.ref), revision = input.revision;
  number(revision, 0, Number.MAX_SAFE_INTEGER - 1); return Object.freeze({ ref, revision });
}
function ownProof(input: PostgresRecoveryLease): PostgresRecoveryCandidate & { proof: SettlementLeaseProof } {
  const value = candidate(input), token = input.proof.token, revision = input.proof.revision;
  number(revision, 1, Number.MAX_SAFE_INTEGER - 1);
  if (typeof token !== 'string' || !UUID.test(token) || revision !== value.revision) throw new TypeError('Invalid recovery proof');
  return Object.freeze({ ...value, proof: Object.freeze({ token, revision }) });
}
function refFromRow(row: Wire): PostgresSettlementReference {
  return ownPostgresSettlementReference({ requestId:row.request_id,attemptIndex:row.attempt_index,userId:row.user_id,apiKeyId:row.api_key_id,
    workspaceId:row.workspace_id,operation:row.operation,contextSha256:row.context_sha256,dispatchClaimId:row.dispatch_claim_id,payloadSha256:row.payload_sha256 });
}
function decode(row: Wire): PostgresRecoveryJob {
  const result = { ref:refFromRow(row),revision:integer(row.revision),state:row.state,attempts:row.attempts,lastTransition:row.last_transition,
    leaseSeconds:row.lease_seconds,expiresAtMs:row.lease_expires_at_ms === null ? null : integer(row.lease_expires_at_ms),
    availableAtMs:row.available_at_ms === null ? null : integer(row.available_at_ms),lastError:row.last_error,
    createdAtMs:integer(row.created_at_ms),updatedAtMs:integer(row.updated_at_ms) };
  number(result.attempts,0,MAX_POSTGRES_RECOVERY_CLAIMS);
  if (!['pending','leased','blocked','committed'].includes(result.state) || !['enqueued','claimed','failed','exhausted','committed'].includes(result.lastTransition)
    || (result.lastError !== null && !['execution_error','interrupted','snapshot_invalid','settlement_conflict','retry_exhausted'].includes(result.lastError))
    || result.updatedAtMs < result.createdAtMs) throw new Error('Invalid persisted recovery state');
  if (result.state === 'leased') {
    number(result.leaseSeconds!,1,300);
    if (result.attempts < 1 || result.revision < 1 || result.lastTransition !== 'claimed' || result.lastError !== null
      || result.expiresAtMs !== result.updatedAtMs + result.leaseSeconds!*1000 || result.availableAtMs !== result.expiresAtMs) throw new Error('Invalid persisted lease');
  } else {
    if (result.leaseSeconds !== null || result.expiresAtMs !== null) throw new Error('Invalid cleared recovery lease');
    if (result.state === 'pending' && (result.attempts >= 5 || result.availableAtMs === null || result.availableAtMs < result.updatedAtMs
      || (result.attempts === 0 ? result.revision !== 0 || result.lastTransition !== 'enqueued' || result.lastError !== null
        : result.lastTransition !== 'failed' || !['execution_error','interrupted'].includes(result.lastError ?? '')))) throw new Error('Invalid pending recovery');
    if (result.state === 'blocked' && (result.attempts < 1 || result.revision < 1 || result.availableAtMs !== null || result.lastError === null
      || !['failed','exhausted'].includes(result.lastTransition))) throw new Error('Invalid blocked recovery');
    if (result.state === 'committed' && (result.attempts < 1 || result.revision < 1 || result.availableAtMs !== null
      || result.lastError !== null || result.lastTransition !== 'committed')) throw new Error('Invalid committed recovery');
  }
  return Object.freeze(result); // No token in any inspect/ensure/discovery result.
}

/**
 * Disabled internal repository. Explicit all-scope scans require a trusted platform service.
 * No caller authorization, provider dispatch, financial commit/receipt or lease renewal here.
 * A returned lease may expire during ACK delivery; future authoritative writes MUST fence again
 * in their own transaction. Task failure fencing alone does not prove final money-write fencing.
 */
export function createUsageRecoveryJobsPostgres(client: Pick<PostgresDatabaseClient, 'driver' | 'raw'>, control: Readonly<{
  scan?: (kind: PostgresRecoveryScanKind, scope: PostgresRecoveryScope, limit: number) => PromiseLike<unknown[]>;
}> = {}) {
  if (client.driver !== 'postgres') throw new TypeError('PostgreSQL recovery authority required');
  const pg = client.raw as unknown as PgTransaction;
  const scan = control.scan;
  if (scan !== undefined && typeof scan !== 'function') throw new TypeError('Invalid recovery scan control');
  async function read(ref: PostgresSettlementReference): Promise<PostgresRecoveryJob | null> {
    const rows = await pg.unsafe<Wire[]>(`SELECT ${REF},${STATUS} ${JOIN} WHERE ${MATCH}`, args(ref));
    if (rows.length > 1) throw new Error('Unexpected recovery cardinality');
    if (!rows[0]) return null;
    const result = decode(rows[0]), expected = args(ref);
    if (args(result.ref).some((v,i) => v !== expected[i])) throw new SettlementConflictError('Stored recovery identity conflict');
    return result;
  }
  async function lock(tx: PgQuery, ref: PostgresSettlementReference): Promise<boolean> {
    // Complete identity, one job row lock, then a separate UPDATE samples the live DB clock.
    const rows = await tx.unsafe(`SELECT j.request_id ${JOIN} WHERE ${MATCH} FOR UPDATE OF j`, args(ref));
    if (rows.length > 1) throw new Error('Unexpected recovery lock cardinality');
    return rows.length === 1;
  }
  return {
    async inspect(ref: PostgresSettlementReference) { return read(ownPostgresSettlementReference(ref)); },
    async ensure(reference: PostgresSettlementReference): Promise<PostgresRecoveryJob> {
      const ref = ownPostgresSettlementReference(reference);
      try {
        await pg.unsafe(`INSERT INTO ${JOB}(request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id)
          SELECT s.request_id,s.payload_sha256,s.created_at_ms,s.user_id,s.workspace_id FROM ${FACT} s
          JOIN ${OUTBOX} o ON o.request_id=s.request_id AND o.payload_sha256=s.payload_sha256 AND o.created_at_ms=s.created_at_ms
          WHERE ${MATCH} ON CONFLICT(request_id) DO NOTHING`, args(ref));
      } catch { /* Safe to reconcile registration, never ownership. No retry. */ }
      const row = await read(ref);
      if (!row) throw new SettlementConflictError('Recovery registration unconfirmed or conflicting');
      return row;
    },
    async scanUnregistered(input: PostgresRecoveryScope, limit: number): Promise<PostgresSettlementReference[]> {
      const value = ownPostgresRecoveryScope(input), statement = postgresRecoveryScan('unregistered',value,limit);
      // Repeated bounded anti-join, no high-water cursor: late commits and backdated creation
      // remain discoverable. Registered blocked rows cannot be silently re-enqueued.
      const rows = await (scan ? scan('unregistered',value,limit) : pg.unsafe<Wire[]>(statement.query,statement.params)) as Wire[];
      return rows.map(refFromRow);
    },
    async scanDue(input: PostgresRecoveryScope, limit: number): Promise<PostgresRecoveryCandidate[]> {
      const value = ownPostgresRecoveryScope(input), statement = postgresRecoveryScan('due',value,limit);
      const rows = await (scan ? scan('due',value,limit) : pg.unsafe<Wire[]>(statement.query,statement.params)) as Wire[];
      return rows.map(row => candidate({ ref:refFromRow(row),revision:integer(row.revision) }));
    },
    async claim(input: PostgresRecoveryCandidate, leaseSeconds: number): Promise<{ status: 'claimed'; lease: PostgresRecoveryLease } | { status: 'not_claimed' } | { status: 'exhausted' }> {
      const value = candidate(input); number(leaseSeconds,1,300); const token = crypto.randomUUID();
      try {
        return await pg.begin(async tx => {
          if (!await lock(tx,value.ref)) return { status:'not_claimed' as const };
          const rows = await tx.unsafe<Wire[]>(`UPDATE ${JOB} j SET state=CASE WHEN j.attempts<5 THEN 'leased' ELSE 'blocked' END,
            revision=j.revision+1,attempts=LEAST(j.attempts+1,5),last_transition=CASE WHEN j.attempts<5 THEN 'claimed' ELSE 'exhausted' END,
            lease_token=CASE WHEN j.attempts<5 THEN $11 ELSE NULL END,lease_seconds=CASE WHEN j.attempts<5 THEN $12::integer ELSE NULL END,
            last_error=CASE WHEN j.attempts<5 THEN NULL ELSE 'retry_exhausted' END
            FROM ${FACT} s WHERE j.request_id=s.request_id AND j.payload_sha256=s.payload_sha256 AND ${MATCH}
            AND j.revision=$10 AND j.state IN ('pending','leased') RETURNING ${REF},${STATUS},j.lease_token`, [...args(value.ref),value.revision,token,leaseSeconds]);
          if (!rows.length) return { status:'not_claimed' as const };
          if (rows.length !== 1) throw new Error('Unexpected recovery claim cardinality');
          const row = decode(rows[0]);
          if (row.revision !== value.revision+1 || args(row.ref).some((v,i) => v !== args(value.ref)[i])) throw new Error('Unexpected recovery claim identity');
          if (row.state === 'blocked' && row.attempts === 5 && row.lastTransition === 'exhausted' && row.lastError === 'retry_exhausted') return { status:'exhausted' as const };
          if (row.state !== 'leased' || rows[0].lease_token !== token || row.expiresAtMs === null || row.leaseSeconds !== leaseSeconds) throw new Error('Unexpected recovery lease');
          return { status:'claimed' as const, lease:Object.freeze({ ...value,revision:row.revision,attempts:row.attempts,
            expiresAtMs:row.expiresAtMs,proof:Object.freeze({ token,revision:row.revision }) }) };
        }); // Await COMMIT acknowledgement before handing out the proof.
      } catch { throw new SettlementRecoveryClaimUncertainError(); } // No readback grant or inline retry.
    },
    async fail(input: PostgresRecoveryLease, reason: PostgresRecoveryFailure): Promise<'deferred' | 'blocked' | 'not_owned'> {
      const value = ownProof(input);
      if (!['execution_error','interrupted','snapshot_invalid','settlement_conflict'].includes(reason)) throw new TypeError('Invalid recovery failure');
      const permanent = reason === 'snapshot_invalid' || reason === 'settlement_conflict';
      return pg.begin(async tx => {
        if (!await lock(tx,value.ref)) return 'not_owned';
        const rows = await tx.unsafe<{ state: State }[]>(`UPDATE ${JOB} j SET
          state=CASE WHEN $12::boolean OR j.attempts>=5 THEN 'blocked' ELSE 'pending' END,
          last_transition='failed',revision=j.revision+1,lease_token=NULL,lease_seconds=NULL,
          last_error=CASE WHEN NOT $12::boolean AND j.attempts>=5 THEN 'retry_exhausted' ELSE $13 END
          FROM ${FACT} s WHERE j.request_id=s.request_id AND j.payload_sha256=s.payload_sha256 AND ${MATCH}
          AND j.state='leased' AND j.revision=$10 AND j.lease_token=$11 RETURNING j.state`,
          [...args(value.ref),value.proof.revision,value.proof.token,permanent,reason]);
        if (!rows.length) return 'not_owned';
        if (rows.length !== 1 || !['pending','blocked'].includes(rows[0].state)) throw new Error('Recovery failure persistence uncertain');
        return rows[0].state === 'blocked' ? 'blocked' : 'deferred';
      });
    },
  };
}
