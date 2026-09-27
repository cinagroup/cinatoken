import type { D1Database } from '@cloudflare/workers-types';

/** Local-only foundation. No production factory/route exports or enables this repository yet. */
export type DispatchIntentIdentity = Readonly<{
	requestId: string;
	attemptIndex: number;
	userId: string;
	apiKeyId: string;
	workspaceId: string;
	operation: 'images.generations' | 'images.edits';
	/** Digest of the caller's frozen dispatch context, NOT a credential or authorization token. */
	contextSha256: string;
}>;
export type DispatchIntentState = 'prepared' | 'dispatch_claimed' | 'expired_before_dispatch' | 'outcome_unknown';
export type DispatchIntentRow = {
	request_id: string; attempt_index: number; user_id: string; api_key_id: string; workspace_id: string;
	operation: DispatchIntentIdentity['operation']; context_sha256: string; state: DispatchIntentState;
	revision: number; dispatch_claim_id: string | null; expires_at_ms: number;
	created_at_ms: number; updated_at_ms: number; claimed_at_ms: number | null;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CLAIM = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function time(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid dispatch intent time');
}
function scope(userId: string, workspaceId: string): void {
	if (!validId(userId) || !validId(workspaceId)) throw new TypeError('Invalid dispatch intent scope');
}
function identity(value: DispatchIntentIdentity): void {
	scope(value.userId, value.workspaceId);
	if (!validId(value.requestId) || !validId(value.apiKeyId)
		|| !Number.isSafeInteger(value.attemptIndex) || value.attemptIndex < 1 || value.attemptIndex > 32
		|| !['images.generations', 'images.edits'].includes(value.operation)
		|| typeof value.contextSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.contextSha256)) throw new TypeError('Invalid dispatch intent identity');
}
function args(value: DispatchIntentIdentity): (string | number)[] {
	return [value.requestId, value.attemptIndex, value.userId, value.apiKeyId,
		value.workspaceId, value.operation, value.contextSha256];
}
const MATCH = 'request_id=? AND attempt_index=? AND user_id=? AND api_key_id=? AND workspace_id=? AND operation=? AND context_sha256=?';

/** Ambiguous acknowledgement never confers permission to send, including to the same caller. */
export class DispatchClaimUncertainError extends Error {
	constructor() { super('Dispatch claim acknowledgement uncertain; do not send or retry inference'); this.name = 'DispatchClaimUncertainError'; }
}

/**
 * Uses the D1 primary path, not a session/replica. No timers, background work, secret logging,
 * monetary mutation or provider I/O. All caller-supplied times must come from the trusted host.
 * A granted claim is necessary but NOT sufficient: current auth/policy/budget/attempt admission
 * must still be enforced by the dispatcher. A marker proves possible dispatch, never acceptance.
 */
export function createDispatchIntentRepositoryD1(db: D1Database) {
	async function inspect(ref: DispatchIntentIdentity): Promise<DispatchIntentRow | null> {
		identity(ref);
		return db.prepare(`SELECT * FROM request_dispatch_intents WHERE ${MATCH}`).bind(...args(ref)).first<DispatchIntentRow>();
	}
	return {
		inspect,
		async prepare(ref: DispatchIntentIdentity, nowMs: number, expiresAtMs: number): Promise<DispatchIntentRow> {
			// Own the scalar identity before yielding: the caller can still mutate a readonly TS value at runtime.
			ref = { requestId: ref.requestId, attemptIndex: ref.attemptIndex, userId: ref.userId,
				apiKeyId: ref.apiKeyId, workspaceId: ref.workspaceId, operation: ref.operation, contextSha256: ref.contextSha256 };
			identity(ref); time(nowMs); time(expiresAtMs);
			if (expiresAtMs <= nowMs) throw new TypeError('Dispatch intent deadline must be in the future');
			let failed = false;
			try {
				await db.prepare(`INSERT INTO request_dispatch_intents (
					request_id, attempt_index, user_id, api_key_id, workspace_id, operation, context_sha256,
					state, revision, expires_at_ms, created_at_ms, updated_at_ms
				) SELECT ?,?,?,?,?,?,?,'prepared',0,?,?,? FROM api_keys
				WHERE id=? AND user_id=? AND workspace_id=?
				ON CONFLICT(request_id, attempt_index) DO NOTHING`)
					.bind(...args(ref), expiresAtMs, nowMs, nowMs, ref.apiKeyId, ref.userId, ref.workspaceId).run();
			} catch { failed = true; }
			// Creation can be reconciled: an existing intent alone never grants sending rights.
			const row = await inspect(ref);
			if (!row || row.expires_at_ms !== expiresAtMs) {
				throw new Error(failed ? 'Dispatch intent persistence unconfirmed' : 'Dispatch intent identity or deadline conflict');
			}
			return row;
		},
		async claim(ref: DispatchIntentIdentity, expectedRevision: number, claimId: string, nowMs: number): Promise<'granted' | 'not_granted'> {
			identity(ref); time(nowMs); time(expectedRevision);
			if (typeof claimId !== 'string' || !CLAIM.test(claimId) || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid dispatch claim');
			try {
				const result = await db.prepare(`UPDATE request_dispatch_intents
					SET state='dispatch_claimed', revision=revision+1, dispatch_claim_id=?, claimed_at_ms=?, updated_at_ms=?
					WHERE ${MATCH} AND state='prepared' AND revision=? AND created_at_ms<=? AND expires_at_ms>?`)
					.bind(claimId, nowMs, nowMs, ...args(ref), expectedRevision, nowMs, nowMs).run();
				if (result.meta.changes === 1) return 'granted';
				if (result.meta.changes === 0) return 'not_granted';
				throw new Error('Unexpected dispatch mutation count');
			} catch {
				// Do NOT read back and re-grant. The original caller may have sent already.
				throw new DispatchClaimUncertainError();
			}
		},
		async listOverdue(userId: string, workspaceId: string, nowMs: number, limit: number): Promise<DispatchIntentRow[]> {
			scope(userId, workspaceId); time(nowMs);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Invalid bounded recovery batch');
			return (await db.prepare(`SELECT * FROM request_dispatch_intents
				WHERE user_id=? AND workspace_id=? AND state IN ('prepared','dispatch_claimed') AND expires_at_ms<=?
				ORDER BY expires_at_ms, request_id, attempt_index LIMIT ?`)
				.bind(userId, workspaceId, nowMs, limit).all<DispatchIntentRow>()).results;
		},
		async classifyOverdue(ref: DispatchIntentIdentity, expectedRevision: number, nowMs: number): Promise<boolean> {
			identity(ref); time(expectedRevision); time(nowMs);
			if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new TypeError('Dispatch intent revision exhausted');
			const result = await db.prepare(`UPDATE request_dispatch_intents
				SET state=CASE state WHEN 'prepared' THEN 'expired_before_dispatch' ELSE 'outcome_unknown' END,
					revision=revision+1, updated_at_ms=?
				WHERE ${MATCH} AND revision=? AND state IN ('prepared','dispatch_claimed') AND expires_at_ms<=?`)
				.bind(nowMs, ...args(ref), expectedRevision, nowMs).run();
			return result.meta.changes === 1;
		},
	};
}
