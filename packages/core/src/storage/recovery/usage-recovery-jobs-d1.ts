import type { D1Database } from '@cloudflare/workers-types';
import { settlementId } from './usage-settlement-codec';
import { ownSettlementReference, type SettlementReference } from './usage-settlement-d1';
import { copySettlementLease, SettlementRecoveryClaimUncertainError, type SettlementLeaseProof } from './settlement-recovery-types';

/** Technical policy for the disabled prototype; these are settlement attempts, never inference attempts. */
export const MAX_RECOVERY_CLAIMS = 5;
export type RecoveryScanScope = Readonly<{ kind: 'all' } | { kind: 'tenant'; userId: string; workspaceId: string }>;
export type RecoveryCandidate = Readonly<{ ref: SettlementReference; revision: number }>;
export type RecoveryLease = RecoveryCandidate & Readonly<{ proof: SettlementLeaseProof; attempts: number; expiresAtSeconds: number }>;
export type RecoveryFailure = 'execution_error' | 'interrupted' | 'snapshot_invalid' | 'settlement_conflict';
type JobRow = {
	request_id: string; user_id: string; api_key_id: string; workspace_id: string; payload_sha256: string;
	revision: number; state: 'pending' | 'leased' | 'blocked' | 'committed'; attempts: number;
	lease_token: string | null; lease_expires_at: number | null; available_at: number | null; last_error: string | null;
};
const MATCH = 'request_id=? AND user_id=? AND api_key_id=? AND workspace_id=? AND payload_sha256=?';
function args(ref: SettlementReference) { return [ref.requestId, ref.userId, ref.apiKeyId, ref.workspaceId, ref.payloadSha256]; }
export function ownRecoveryScope(scope: RecoveryScanScope): RecoveryScanScope {
	if (scope?.kind === 'all') return Object.freeze({ kind: 'all' });
	if (scope?.kind !== 'tenant' || !settlementId(scope.userId) || !settlementId(scope.workspaceId)) throw new TypeError('Explicit recovery scan scope required');
	return Object.freeze({ kind: 'tenant', userId: scope.userId, workspaceId: scope.workspaceId });
}
function candidate(value: RecoveryCandidate): RecoveryCandidate {
	const ref = ownSettlementReference(value.ref), revision = value.revision;
	if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid recovery revision');
	return Object.freeze({ ref, revision });
}
function fromRow(row: JobRow): RecoveryCandidate {
	return candidate({ ref: { requestId: row.request_id, userId: row.user_id, apiKeyId: row.api_key_id, workspaceId: row.workspace_id, payloadSha256: row.payload_sha256 }, revision: row.revision });
}

/** Internal service repository. 'all' requires a trusted platform recovery caller, not a tenant HTTP request. */
export function createUsageRecoveryJobsD1(db: D1Database) {
	return {
		async scanDue(input: RecoveryScanScope, limit: number): Promise<RecoveryCandidate[]> {
			const scope = ownRecoveryScope(input);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Recovery scan limit must be 1..50');
			const clause = scope.kind === 'tenant' ? 'user_id=? AND workspace_id=? AND ' : '';
			// Only bounded scalar references, never load 50 full payloads into a batch.
			const rows = (await db.prepare(`SELECT request_id,user_id,api_key_id,workspace_id,payload_sha256,revision
				FROM request_usage_recovery_jobs WHERE ${clause}state IN ('pending','leased') AND available_at<=unixepoch('now')
				ORDER BY available_at,request_id LIMIT ?`).bind(...(scope.kind === 'tenant' ? [scope.userId, scope.workspaceId] : []), limit).all<JobRow>()).results;
			return rows.map(fromRow);
		},
		async inspect(reference: SettlementReference): Promise<JobRow | null> {
			const ref = ownSettlementReference(reference);
			return db.prepare(`SELECT * FROM request_usage_recovery_jobs WHERE ${MATCH}`).bind(...args(ref)).first<JobRow>();
		},
		async claim(input: RecoveryCandidate, leaseSeconds: number): Promise<{ status: 'claimed'; lease: RecoveryLease } | { status: 'not_claimed' } | { status: 'exhausted' }> {
			const value = candidate(input), token = crypto.randomUUID();
			if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new TypeError('Recovery lease must be 1..300 seconds');
			try {
				const result = await db.prepare(`UPDATE request_usage_recovery_jobs SET
					state=CASE WHEN attempts<5 THEN 'leased' ELSE 'blocked' END,revision=revision+1,
					lease_token=CASE WHEN attempts<5 THEN ? ELSE NULL END,
					lease_expires_at=CASE WHEN attempts<5 THEN unixepoch('now')+? ELSE NULL END,
					available_at=CASE WHEN attempts<5 THEN unixepoch('now')+? ELSE NULL END,
					last_error=CASE WHEN attempts<5 THEN NULL ELSE 'retry_exhausted' END,
					attempts=MIN(attempts+1,5),updated_at=unixepoch('now')
					WHERE ${MATCH} AND revision=? AND state IN ('pending','leased') AND available_at<=unixepoch('now')
					RETURNING *`).bind(token, leaseSeconds, leaseSeconds, ...args(value.ref), value.revision).all<JobRow>();
				if (result.meta.changes === 0) return { status: 'not_claimed' };
				const row = result.results[0];
				if (result.meta.changes !== 1 || result.results.length !== 1 || row.revision !== value.revision + 1) throw new Error('Invalid claim result');
				if (row.state === 'blocked' && row.attempts === MAX_RECOVERY_CLAIMS) return { status: 'exhausted' };
				if (row.state !== 'leased' || row.lease_token !== token || !Number.isSafeInteger(row.lease_expires_at)
					|| row.lease_expires_at === null || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.attempts > MAX_RECOVERY_CLAIMS) throw new Error('Invalid claimed lease');
				return { status: 'claimed', lease: Object.freeze({ ...value, revision: row.revision,
					proof: copySettlementLease({ token, revision: row.revision }), attempts: row.attempts, expiresAtSeconds: row.lease_expires_at }) };
			} catch {
				// Even a committed claim ACK loss confers no ownership. A later, newly fenced lease may recover.
				throw new SettlementRecoveryClaimUncertainError();
			}
		},
		async fail(input: RecoveryLease, reason: RecoveryFailure): Promise<'deferred' | 'blocked' | 'not_owned'> {
			const value = candidate(input), proof = copySettlementLease(input.proof);
			if (value.revision !== proof.revision || !['execution_error','interrupted','snapshot_invalid','settlement_conflict'].includes(reason)) throw new TypeError('Invalid recovery failure');
			const permanent = reason === 'snapshot_invalid' || reason === 'settlement_conflict';
			const result = await db.prepare(`UPDATE request_usage_recovery_jobs SET
				state=CASE WHEN ?=1 OR attempts>=5 THEN 'blocked' ELSE 'pending' END,
				available_at=CASE WHEN ?=1 OR attempts>=5 THEN NULL ELSE unixepoch('now')+5*(1<<(attempts-1)) END,
				last_error=CASE WHEN ?=0 AND attempts>=5 THEN 'retry_exhausted' ELSE ? END,
				lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=unixepoch('now')
				WHERE ${MATCH} AND state='leased' AND revision=? AND lease_token=? AND lease_expires_at>unixepoch('now')
				RETURNING state`).bind(Number(permanent),Number(permanent),Number(permanent),reason,...args(value.ref),proof.revision,proof.token).all<{ state: string }>();
			if (result.meta.changes === 0) return 'not_owned';
			if (result.meta.changes !== 1) throw new Error('Recovery failure persistence uncertain');
			if (result.results[0]?.state === 'blocked') return 'blocked';
			if (result.results[0]?.state === 'pending') return 'deferred';
			throw new Error('Recovery failure persistence uncertain');
		},
	};
}
