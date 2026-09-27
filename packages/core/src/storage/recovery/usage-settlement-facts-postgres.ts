import type { PostgresDatabaseClient } from '../database-client';
import type { DispatchIntentIdentity } from './dispatch-intent-d1';
import { decodeUsageSettlement, encodeUsageSettlement, type UsageSettlement } from './usage-settlement-codec';
import { SettlementConflictError, SettlementSnapshotInvalidError } from './settlement-recovery-types';

/** Existing v1 Images final-request settlement input only; not a quote or a charge authorization. */
export type PostgresSettlementReference = Readonly<DispatchIntentIdentity & { dispatchClaimId: string; payloadSha256: string }>;
export type SettlementDiscoveryCursor = Readonly<{ createdAtMs: number; requestId: string }>;
export type SettlementDiscoveryEntry = Readonly<{ reference: PostgresSettlementReference; cursor: SettlementDiscoveryCursor }>;
type PgQuery = { unsafe<T extends unknown[] = Record<string, unknown>[]>(query: string, params?: readonly unknown[]): PromiseLike<T> };
const FACT = 'cinatoken_gateway.request_usage_settlements';
const OUTBOX = 'cinatoken_gateway.request_usage_settlement_outbox';
const JOIN = `FROM ${FACT} s JOIN ${OUTBOX} o ON o.request_id=s.request_id
	AND o.payload_sha256=s.payload_sha256 AND o.created_at_ms=s.created_at_ms`;
const REF_COLUMNS = `s.request_id, s.attempt_index, s.user_id, s.api_key_id, s.workspace_id,
	s.operation, s.context_sha256, s.dispatch_claim_id, s.payload_sha256`;
const MATCH = `s.request_id=$1 AND s.attempt_index=$2 AND s.user_id=$3 AND s.api_key_id=$4 AND s.workspace_id=$5
	AND s.operation=$6 AND s.context_sha256=$7 AND s.dispatch_claim_id=$8 AND s.payload_sha256=$9`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?![\s\S])/;
const HASH = /^[0-9a-f]{64}(?![\s\S])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
type RefRow = { request_id: string; attempt_index: number; user_id: string; api_key_id: string; workspace_id: string;
	operation: DispatchIntentIdentity['operation']; context_sha256: string; dispatch_claim_id: string; payload_sha256: string };
const valid = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);
function scope(userId: string, workspaceId: string): void {
	if (!valid(ID, userId) || !valid(ID, workspaceId)) throw new TypeError('Invalid settlement scope');
}
export function ownPostgresSettlementReference(value: PostgresSettlementReference): PostgresSettlementReference {
	const ref = { requestId: value.requestId, attemptIndex: value.attemptIndex, userId: value.userId, apiKeyId: value.apiKeyId,
		workspaceId: value.workspaceId, operation: value.operation, contextSha256: value.contextSha256,
		dispatchClaimId: value.dispatchClaimId, payloadSha256: value.payloadSha256 };
	scope(ref.userId, ref.workspaceId);
	if (!valid(ID, ref.requestId) || !valid(ID, ref.apiKeyId) || !Number.isSafeInteger(ref.attemptIndex)
		|| ref.attemptIndex < 1 || ref.attemptIndex > 32 || !['images.generations', 'images.edits'].includes(ref.operation)
		|| !valid(HASH, ref.contextSha256) || !valid(HASH, ref.payloadSha256) || !valid(UUID, ref.dispatchClaimId)) throw new TypeError('Invalid settlement reference');
	return Object.freeze(ref);
}
function args(ref: PostgresSettlementReference): (string | number)[] {
	return [ref.requestId, ref.attemptIndex, ref.userId, ref.apiKeyId, ref.workspaceId, ref.operation,
		ref.contextSha256, ref.dispatchClaimId, ref.payloadSha256];
}
function fromRow(row: RefRow): PostgresSettlementReference {
	return ownPostgresSettlementReference({ requestId: row.request_id, attemptIndex: row.attempt_index,
		userId: row.user_id, apiKeyId: row.api_key_id, workspaceId: row.workspace_id, operation: row.operation,
		contextSha256: row.context_sha256, dispatchClaimId: row.dispatch_claim_id, payloadSha256: row.payload_sha256 });
}
function cursor(value: SettlementDiscoveryCursor): SettlementDiscoveryCursor {
	const copy = { createdAtMs: value.createdAtMs, requestId: value.requestId };
	if (!Number.isSafeInteger(copy.createdAtMs) || copy.createdAtMs < 0 || !valid(ID, copy.requestId)) throw new TypeError('Invalid settlement discovery cursor');
	return Object.freeze(copy);
}
function storedTime(value: string): number {
	if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})(?![\s\S])/.test(value)) throw new SettlementSnapshotInvalidError();
	const result = Number(value);
	if (!Number.isSafeInteger(result)) throw new SettlementSnapshotInvalidError();
	return result;
}

/**
 * Disabled PostgreSQL-only foundation: immutable facts + atomic discovery, NO financial commit,
 * lease, completion mark, provider I/O, retry, route or production factory. Callers must authorize
 * tenant access. A content digest or outbox entry is not dispatch/financial authority.
 */
export function createUsageSettlementFactsRepositoryPostgres(
	client: Pick<PostgresDatabaseClient, 'driver' | 'raw'>,
) {
	if (client.driver !== 'postgres') throw new TypeError('PostgreSQL settlement authority required');
	const pg = client.raw as unknown as PgQuery;
	async function loadOwned(ref: PostgresSettlementReference): Promise<UsageSettlement> {
		const rows = await pg.unsafe<(RefRow & { payload_version: number; payload_json: string; recorded_at: string })[]>(
			`SELECT ${REF_COLUMNS}, s.payload_version, s.payload_json, s.recorded_at ${JOIN} WHERE ${MATCH}`, args(ref));
		if (rows.length !== 1) throw new SettlementConflictError('Settlement fact or atomic discovery entry missing or conflicting');
		const row = rows[0];
		let value: UsageSettlement;
		try { value = await decodeUsageSettlement(row.payload_json, ref.payloadSha256); }
		catch { throw new SettlementSnapshotInvalidError(); }
		const actual = ownPostgresSettlementReference({ ...value.intent, dispatchClaimId: value.dispatchClaimId, payloadSha256: ref.payloadSha256 });
		const expected = args(ref);
		if (args(fromRow(row)).some((value, index) => value !== expected[index])
			|| args(actual).some((value, index) => value !== expected[index])
			|| row.payload_version !== value.version || row.recorded_at !== value.recordedAtIso) throw new SettlementConflictError('Stored settlement identity conflict');
		return value;
	}
	return {
		async load(reference: PostgresSettlementReference): Promise<UsageSettlement> {
			return loadOwned(ownPostgresSettlementReference(reference));
		},
		async persist(input: UsageSettlement): Promise<PostgresSettlementReference> {
			// The shared codec owns the complete plain-JSON input synchronously before asynchronous hashing.
			const encoded = await encodeUsageSettlement(input);
			const value = await decodeUsageSettlement(encoded.json, encoded.sha256);
			const ref = ownPostgresSettlementReference({ ...value.intent, dispatchClaimId: value.dispatchClaimId, payloadSha256: encoded.sha256 });
			try {
				// One autocommit statement: trigger enqueue + reciprocal deferred FK commit together.
				await pg.unsafe(`INSERT INTO ${FACT}
					(request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,dispatch_claim_id,payload_sha256,payload_version,payload_json,recorded_at)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(request_id) DO NOTHING`,
					[...args(ref), value.version, encoded.json, value.recordedAtIso]);
			} catch {
				// A lost acknowledgement may be reconciled by exact readback; never resubmit this write here.
			}
			await loadOwned(ref); // Requires BOTH durable rows and validates the same immutable content.
			return ref;
		},
		// Pagination within a full sweep only, NEVER a durable processed watermark: creation
		// timestamps do not order transaction visibility (or clock rollback). Consumers must
		// restart sweeps and deduplicate; independent durable jobs/leases are not implemented here.
		async listForRecovery(userId: string, workspaceId: string, limit: number, after?: SettlementDiscoveryCursor): Promise<SettlementDiscoveryEntry[]> {
			scope(userId, workspaceId);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Invalid bounded settlement discovery batch');
			const next = after === undefined ? undefined : cursor(after);
			const rows = await pg.unsafe<(RefRow & { created_at_ms: string })[]>(`SELECT ${REF_COLUMNS}, s.created_at_ms::text ${JOIN}
				WHERE s.user_id=$1 AND s.workspace_id=$2 ${next ? 'AND (s.created_at_ms,s.request_id)>($4,$5)' : ''}
				ORDER BY s.created_at_ms,s.request_id LIMIT $3`, next
				? [userId, workspaceId, limit, next.createdAtMs, next.requestId] : [userId, workspaceId, limit]);
			return rows.map(row => Object.freeze({ reference: fromRow(row), cursor: cursor({ createdAtMs: storedTime(row.created_at_ms), requestId: row.request_id }) }));
		},
	};
}
