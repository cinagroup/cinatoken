import type { PostgresDatabaseClient } from '../database-client';
import type { DispatchIntentIdentity } from './dispatch-intent-d1';
import { PostgresDispatchClaimUncertainError } from './dispatch-intent-postgres';

type PgQuery = {
	unsafe<T extends unknown[] = Record<string, unknown>[]>(query: string, params?: readonly unknown[]): PromiseLike<T>;
};
type PgTransaction = PgQuery & { begin<T>(run: (tx: PgQuery) => Promise<T>): Promise<T> };

/** The digest of the whole canonical request is distinct from each route's context digest. */
export type ParentDispatchIntentIdentity = DispatchIntentIdentity & Readonly<{ requestSha256: string }>;
export type ParentDispatchAttemptBudget = 1 | 2 | 3;
export type ParentDispatchPreparation = 'newly_prepared' | 'already_prepared';

// Strict end-of-input: JavaScript's $ also accepts a trailing newline.
const END = '(?![\\s\\S])';
const ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}${END}`);
const DIGEST = new RegExp(`^[a-f0-9]{64}${END}`);
const CLAIM = new RegExp(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}${END}`);
const PREPARE = `SELECT cinatoken_gateway.prepare_request_dispatch_intent_v1(
	$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS accepted`;
const CLAIM_DISPATCH = `SELECT cinatoken_gateway.claim_request_dispatch_intent_v1(
	$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS accepted`;
const CLASSIFY = `SELECT cinatoken_gateway.classify_request_dispatch_intent_v1(
	$1,$2,$3,$4,$5,$6,$7,$8,$9) AS accepted`;

function ownIdentity(value: ParentDispatchIntentIdentity): ParentDispatchIntentIdentity {
	if (!value || typeof value !== 'object') throw new TypeError('Invalid dispatch request identity');
	// Take every scalar before any await. A runtime caller can mutate a readonly TS object.
	const ref = { requestId: value.requestId, attemptIndex: value.attemptIndex, userId: value.userId,
		apiKeyId: value.apiKeyId, workspaceId: value.workspaceId, operation: value.operation,
		requestSha256: value.requestSha256, contextSha256: value.contextSha256 };
	if (![ref.requestId, ref.userId, ref.apiKeyId, ref.workspaceId].every(id => typeof id === 'string' && ID.test(id))
		|| !Number.isSafeInteger(ref.attemptIndex) || ref.attemptIndex < 1 || ref.attemptIndex > 3
		|| (ref.operation !== 'images.generations' && ref.operation !== 'images.edits')
		|| typeof ref.requestSha256 !== 'string' || !DIGEST.test(ref.requestSha256)
		|| typeof ref.contextSha256 !== 'string' || !DIGEST.test(ref.contextSha256)) {
		throw new TypeError('Invalid dispatch request identity');
	}
	return ref;
}

function ownRevision(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
		throw new TypeError('Invalid dispatch revision');
	}
	return value;
}

function baseArgs(ref: ParentDispatchIntentIdentity): (string | number)[] {
	return [ref.requestId, ref.attemptIndex, ref.userId, ref.apiKeyId, ref.workspaceId,
		ref.operation, ref.requestSha256, ref.contextSha256];
}

function accepted(rows: Record<string, unknown>[]): boolean {
	if (rows.length !== 1 || typeof rows[0]?.accepted !== 'boolean') {
		throw new Error('Unexpected dispatch function result');
	}
	return rows[0].accepted;
}

/**
 * REVIEW ONLY. Requires the explicitly activated request-parent SQL proposal and a separately
 * reviewed EXECUTE grant. The proposal grants no runtime role; this factory is not wired into
 * production. The caller must supply a trustworthy canonical request digest and authenticated
 * identity. This repository never reads or mutates an attempt directly, retries a claim, performs
 * provider I/O, or grants sending rights from preparation. SQL owns parent-then-attempt lock order.
 */
export function createParentDispatchIntentRepositoryPostgres(
	client: Pick<PostgresDatabaseClient, 'driver' | 'raw'>,
) {
	if (client.driver !== 'postgres') throw new TypeError('PostgreSQL dispatch authority required');
	const pg = client.raw as unknown as PgTransaction;
	return {
		async prepare(ref: ParentDispatchIntentIdentity, expiresAtMs: number,
			maxAttempts: ParentDispatchAttemptBudget): Promise<ParentDispatchPreparation> {
			ref = ownIdentity(ref);
			if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 1
				|| !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3
				|| ref.attemptIndex > maxAttempts) throw new TypeError('Invalid dispatch request deadline or attempt budget');
			const parameters = [...baseArgs(ref), expiresAtMs, maxAttempts];
			// No readback is needed: a lost preparation ACK conveys no dispatch right.
			const prepared = await pg.begin(async tx => accepted(await tx.unsafe(PREPARE, parameters)));
			return prepared ? 'newly_prepared' : 'already_prepared';
		},
		async claim(ref: ParentDispatchIntentIdentity, expectedRevision: number,
			claimId: string): Promise<'granted' | 'not_granted'> {
			ref = ownIdentity(ref);
			expectedRevision = ownRevision(expectedRevision);
			if (typeof claimId !== 'string' || !CLAIM.test(claimId)) throw new TypeError('Invalid dispatch claim');
			const parameters = [...baseArgs(ref), expectedRevision, claimId];
			try {
				const granted = await pg.begin(async tx => accepted(await tx.unsafe(CLAIM_DISPATCH, parameters)));
				// A function result before COMMIT is not a grant. pg.begin must acknowledge COMMIT first.
				return granted ? 'granted' : 'not_granted';
			} catch {
				// A lost COMMIT ACK may conceal a durable claim. No readback or retry can grant it.
				throw new PostgresDispatchClaimUncertainError();
			}
		},
		async classifyOverdue(ref: ParentDispatchIntentIdentity, expectedRevision: number): Promise<boolean> {
			ref = ownIdentity(ref);
			expectedRevision = ownRevision(expectedRevision);
			const parameters = [...baseArgs(ref), expectedRevision];
			// Classification is terminal metadata, never a financial or dispatch operation.
			return pg.begin(async tx => accepted(await tx.unsafe(CLASSIFY, parameters)));
		},
	};
}
