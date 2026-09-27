import type { PostgresDatabaseClient } from '../database-client';
// Type-only reuse of the existing Images identity contract; no D1 runtime dependency.
import type { DispatchIntentIdentity, DispatchIntentRow } from './dispatch-intent-d1';

type PgQuery = {
	unsafe<T extends unknown[] = Record<string, unknown>[]>(query: string, params?: readonly unknown[]): PromiseLike<T>;
};
type PgTransaction = PgQuery & { begin<T>(run: (tx: PgQuery) => Promise<T>): Promise<T> };
const TABLE = 'cinatoken_gateway.request_dispatch_intents';
const MATCH = 'request_id=$1 AND attempt_index=$2 AND user_id=$3 AND api_key_id=$4 AND workspace_id=$5 AND operation=$6 AND context_sha256=$7';
// (?![\s\S]) is strict end-of-input; JavaScript's $ also accepts a trailing newline.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?![\s\S])/;
const CLAIM = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
const COLUMNS = `request_id, attempt_index, user_id, api_key_id, workspace_id, operation, context_sha256,
	state, revision::text, dispatch_claim_id, expires_at_ms::text, created_at_ms::text, updated_at_ms::text, claimed_at_ms::text`;
type WireRow = Omit<DispatchIntentRow, 'revision' | 'expires_at_ms' | 'created_at_ms' | 'updated_at_ms' | 'claimed_at_ms'> & {
	revision: string; expires_at_ms: string; created_at_ms: string; updated_at_ms: string; claimed_at_ms: string | null;
};
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function integer(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid dispatch intent integer');
}
function scope(userId: string, workspaceId: string): void {
	if (!validId(userId) || !validId(workspaceId)) throw new TypeError('Invalid dispatch intent scope');
}
function ownIdentity(value: DispatchIntentIdentity): DispatchIntentIdentity {
	// Capture scalars before any await, including when acknowledgement reconciliation is needed.
	const ref = { requestId: value.requestId, attemptIndex: value.attemptIndex, userId: value.userId,
		apiKeyId: value.apiKeyId, workspaceId: value.workspaceId, operation: value.operation, contextSha256: value.contextSha256 };
	scope(ref.userId, ref.workspaceId);
	if (!validId(ref.requestId) || !validId(ref.apiKeyId) || !Number.isSafeInteger(ref.attemptIndex)
		|| ref.attemptIndex < 1 || ref.attemptIndex > 32 || !['images.generations', 'images.edits'].includes(ref.operation)
		|| typeof ref.contextSha256 !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(ref.contextSha256)) throw new TypeError('Invalid dispatch intent identity');
	return ref;
}
function args(ref: DispatchIntentIdentity): (string | number)[] {
	return [ref.requestId, ref.attemptIndex, ref.userId, ref.apiKeyId, ref.workspaceId, ref.operation, ref.contextSha256];
}
function decodeInteger(value: string): number {
	if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})(?![\s\S])/.test(value)) throw new Error('Invalid persisted dispatch integer');
	const result = Number(value); integer(result); return result;
}
function decode(row: WireRow): DispatchIntentRow {
	return { ...row, revision: decodeInteger(row.revision), expires_at_ms: decodeInteger(row.expires_at_ms),
		created_at_ms: decodeInteger(row.created_at_ms), updated_at_ms: decodeInteger(row.updated_at_ms),
		claimed_at_ms: row.claimed_at_ms === null ? null : decodeInteger(row.claimed_at_ms) };
}
function revision(value: number): void {
	integer(value);
	if (value === Number.MAX_SAFE_INTEGER) throw new TypeError('Dispatch intent revision exhausted');
}

export class PostgresDispatchClaimUncertainError extends Error {
	constructor() { super('Dispatch claim acknowledgement uncertain; do not send or retry inference'); this.name = 'PostgresDispatchClaimUncertainError'; }
}

/**
 * LOCAL ONLY, not registered in a production factory. Explicit PostgreSQL authority; no fallback.
 * No provider I/O, money mutation, background work or retry. This attempt-level grant is necessary
 * but NOT sufficient: current authorization, request-level unknown gate, capacity, total attempt
 * budget and deadline must be enforced by the future dispatcher, including after a delayed ACK.
 * Time is sampled by the database guard, not accepted from a caller or transaction start time.
 */
export function createDispatchIntentRepositoryPostgres(client: PostgresDatabaseClient) {
	if (client.driver !== 'postgres') throw new TypeError('PostgreSQL dispatch authority required');
	const pg = client.raw as unknown as PgTransaction;
	async function read(ref: DispatchIntentIdentity): Promise<DispatchIntentRow | null> {
		const rows = await pg.unsafe<WireRow[]>(`SELECT ${COLUMNS} FROM ${TABLE} WHERE ${MATCH}`, args(ref));
		if (rows.length > 1) throw new Error('Unexpected dispatch intent cardinality');
		return rows[0] ? decode(rows[0]) : null;
	}
	return {
		async inspect(ref: DispatchIntentIdentity): Promise<DispatchIntentRow | null> { return read(ownIdentity(ref)); },
		async prepare(ref: DispatchIntentIdentity, expiresAtMs: number): Promise<DispatchIntentRow> {
			ref = ownIdentity(ref); integer(expiresAtMs);
			let failed = false;
			try {
				await pg.unsafe(`INSERT INTO ${TABLE}
					(request_id, attempt_index, user_id, api_key_id, workspace_id, operation, context_sha256, expires_at_ms)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(request_id, attempt_index) DO NOTHING`, [...args(ref), expiresAtMs]);
			} catch { failed = true; }
			// Safe to reconcile creation: even an existing claimed intent conveys NO sending rights.
			const row = await read(ref);
			if (!row || row.expires_at_ms !== expiresAtMs) throw new Error(failed
				? 'Dispatch intent persistence unconfirmed' : 'Dispatch intent identity or deadline conflict');
			return row;
		},
		async claim(ref: DispatchIntentIdentity, expectedRevision: number, claimId: string): Promise<'granted' | 'not_granted'> {
			ref = ownIdentity(ref); revision(expectedRevision);
			if (typeof claimId !== 'string' || !CLAIM.test(claimId)) throw new TypeError('Invalid dispatch claim');
			const parameters = [...args(ref), expectedRevision, claimId];
			try {
				const granted = await pg.begin(async tx => {
					// A separate statement obtains the lock BEFORE the update/guard samples clock_timestamp.
					// Never capture a timestamp in a CTE evaluated before this potentially blocking lock.
					const locked = await tx.unsafe(`SELECT request_id FROM ${TABLE} WHERE ${MATCH} FOR UPDATE`, parameters.slice(0, 7));
					if (locked.length === 0) return false;
					if (locked.length !== 1) throw new Error('Unexpected dispatch lock cardinality');
					const rows = await tx.unsafe(`UPDATE ${TABLE} SET state='dispatch_claimed', revision=revision+1, dispatch_claim_id=$9
						WHERE ${MATCH} AND revision=$8 AND state='prepared' RETURNING request_id`, parameters);
					if (rows.length > 1) throw new Error('Unexpected dispatch mutation cardinality');
					return rows.length === 1;
				});
				// A row returned BEFORE COMMIT is not a grant. Wait for the transaction acknowledgement.
				return granted ? 'granted' : 'not_granted';
			} catch {
				// No readback/retry, even for our own claimId. A lost COMMIT acknowledgement is ambiguous.
				throw new PostgresDispatchClaimUncertainError();
			}
		},
		async listOverdue(userId: string, workspaceId: string, limit: number): Promise<DispatchIntentRow[]> {
			scope(userId, workspaceId);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Invalid bounded recovery batch');
			const rows = await pg.unsafe<WireRow[]>(`SELECT ${COLUMNS} FROM ${TABLE}
				WHERE user_id=$1 AND workspace_id=$2 AND state IN ('prepared','dispatch_claimed')
				AND expires_at_ms <= (SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint)
				ORDER BY expires_at_ms, request_id, attempt_index LIMIT $3`, [userId, workspaceId, limit]);
			return rows.map(decode);
		},
		async classifyOverdue(ref: DispatchIntentIdentity, expectedRevision: number): Promise<boolean> {
			ref = ownIdentity(ref); revision(expectedRevision); const parameters = [...args(ref), expectedRevision];
			// Classification only, not a charge/refund, replay decision or resource release.
			return pg.begin(async tx => {
				const locked = await tx.unsafe(`SELECT request_id FROM ${TABLE} WHERE ${MATCH} FOR UPDATE`, parameters.slice(0, 7));
				if (locked.length === 0) return false;
				if (locked.length !== 1) throw new Error('Unexpected dispatch lock cardinality');
				const rows = await tx.unsafe(`UPDATE ${TABLE}
					SET state=CASE state WHEN 'prepared' THEN 'expired_before_dispatch' ELSE 'outcome_unknown' END, revision=revision+1
					WHERE ${MATCH} AND revision=$8 AND state IN ('prepared','dispatch_claimed') RETURNING request_id`, parameters);
				if (rows.length > 1) throw new Error('Unexpected dispatch mutation cardinality');
				return rows.length === 1;
			});
		},
	};
}
