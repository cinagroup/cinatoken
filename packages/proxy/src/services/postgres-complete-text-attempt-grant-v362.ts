import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';
import type {
	CommittedTextGrantReceiptV361,
	TextGrantClaimRequestV361,
} from './chat-text-grant-egress-contract-v361';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlStatement = Pick<SqlClient, 'unsafe' | 'json'>;
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;

const GRANTER_LOGIN = 'cinatoken_gateway_complete_text_attempt_granter';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CLAIM_KEYS = Object.freeze([
	'requestId', 'quoteId', 'finalBodySha256', 'candidateIndex', 'modelId',
	'routeTargetId', 'providerId', 'endpointId', 'credentialClass',
	'credentialId', 'providerCiphertextSha256', 'preparedRouteSourceSha256',
	'method', 'upstreamUrlSha256', 'outboundBodySha256',
	'outboundBodyCanonicalSha256', 'outboundBodyBytes',
	'credentialFingerprintSha256',
] as const);
const DIGEST_KEYS = Object.freeze([
	'finalBodySha256', 'providerCiphertextSha256',
	'preparedRouteSourceSha256', 'upstreamUrlSha256', 'outboundBodySha256',
	'outboundBodyCanonicalSha256', 'credentialFingerprintSha256',
] as const);
const ID_KEYS = Object.freeze([
	'modelId', 'routeTargetId', 'providerId', 'endpointId', 'credentialId',
] as const);

export type CommittedCompleteTextAttemptGrantV362 = CommittedTextGrantReceiptV361 &
	Readonly<{ holdRecoveryExpiresAt: string }>;

export class PostgresCompleteTextAttemptGrantRejectedError extends Error {
	constructor(readonly status: string) {
		super(`PostgreSQL complete text attempt grant ${status}`);
		this.name = 'PostgresCompleteTextAttemptGrantRejectedError';
	}
}

export class PostgresCompleteTextAttemptGrantCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL complete text attempt grant LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresCompleteTextAttemptGrantCleanupUnconfirmedError';
	}
}

function validConnection(value: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError('PostgreSQL complete text granter connection invalid');
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError('PostgreSQL complete text granter connection invalid'); }
	if (!['postgres:', 'postgresql:'].includes(url.protocol)
		|| !url.hostname || !url.username || !url.password
		|| !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].some(([key, setting]) => key.toLowerCase() !== 'sslmode'
			|| !['require', 'disable'].includes(setting))
		|| [...url.searchParams].length > 1) {
		throw new TypeError('PostgreSQL complete text granter connection invalid');
	}
	return value;
}

function snapshotClaim(value: TextGrantClaimRequestV361): TextGrantClaimRequestV361 {
	const original = value as unknown as Record<string, unknown>;
	if (!original || typeof original !== 'object' || Array.isArray(original)
		|| Object.keys(original).length !== CLAIM_KEYS.length
		|| CLAIM_KEYS.some(key => !Object.hasOwn(original, key))) {
		throw new TypeError('PostgreSQL complete text attempt claim invalid');
	}
	// Copy primitive fields once. A mutable caller or inherited toJSON cannot
	// change what is sent to PostgreSQL after local validation.
	const claim = Object.fromEntries(CLAIM_KEYS.map(key => [key, original[key]]));
	if (Object.keys(claim).length !== CLAIM_KEYS.length
		|| typeof claim.requestId !== 'string' || claim.requestId.length < 1
		|| claim.requestId.length > 128
		|| typeof claim.quoteId !== 'string' || !UUID.test(claim.quoteId)
		|| !Number.isSafeInteger(claim.candidateIndex)
		|| (claim.candidateIndex as number) < 0 || (claim.candidateIndex as number) > 7
		|| claim.credentialClass !== 'platform' || claim.method !== 'POST'
		|| !Number.isSafeInteger(claim.outboundBodyBytes)
		|| (claim.outboundBodyBytes as number) < 2
		|| (claim.outboundBodyBytes as number) > 2_097_152
		|| DIGEST_KEYS.some(key => typeof claim[key] !== 'string'
			|| !SHA256.test(claim[key] as string))
		|| ID_KEYS.some(key => typeof claim[key] !== 'string'
			|| (claim[key] as string).length < 1 || (claim[key] as string).length > 512)) {
		throw new TypeError('PostgreSQL complete text attempt claim invalid');
	}
	return Object.freeze(claim) as TextGrantClaimRequestV361;
}

function parseRecordedGrant(value: unknown, claim: TextGrantClaimRequestV361,
	requestTimeMs: number): CommittedCompleteTextAttemptGrantV362 {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('PostgreSQL complete text attempt grant response invalid');
	}
	const row = value as Record<string, unknown>;
	if (row.status !== 'grant_recorded') {
		if (typeof row.status === 'string' && row.status.length <= 80) {
			throw new PostgresCompleteTextAttemptGrantRejectedError(row.status);
		}
		throw new TypeError('PostgreSQL complete text attempt grant response invalid');
	}
	if (CLAIM_KEYS.some(key => row[key] !== claim[key])
		|| typeof row.grantId !== 'string' || !UUID.test(row.grantId)
		|| !Number.isSafeInteger(row.attemptNumber)
		|| (row.attemptNumber as number) < 1 || (row.attemptNumber as number) > 3
		|| !Number.isSafeInteger(row.manifestSourceGeneration)
		|| (row.manifestSourceGeneration as number) < 1
		|| row.currentSourceGeneration !== row.manifestSourceGeneration
		|| typeof row.manifestAttestedSourceSha256 !== 'string'
		|| !SHA256.test(row.manifestAttestedSourceSha256)
		|| row.currentAttestedSourceSha256 !== row.manifestAttestedSourceSha256
		|| typeof row.manifestSourceSha256 !== 'string'
		|| !SHA256.test(row.manifestSourceSha256)
		|| typeof row.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(row.expiresAt))
		|| Date.parse(row.expiresAt) <= requestTimeMs
		|| typeof row.holdRecoveryExpiresAt !== 'string'
		|| !Number.isFinite(Date.parse(row.holdRecoveryExpiresAt))
		|| Date.parse(row.holdRecoveryExpiresAt) < Date.parse(row.expiresAt)) {
		throw new TypeError('PostgreSQL complete text attempt grant differs from prepared wire');
	}
	return Object.freeze({ ...claim,
		status: 'committed' as const,
		commitAcknowledged: true as const,
		grantId: row.grantId,
		attemptNumber: row.attemptNumber as number,
		manifestSourceGeneration: row.manifestSourceGeneration as number,
		currentSourceGeneration: row.currentSourceGeneration as number,
		manifestAttestedSourceSha256: row.manifestAttestedSourceSha256,
		currentAttestedSourceSha256: row.currentAttestedSourceSha256 as string,
		manifestSourceSha256: row.manifestSourceSha256,
		expiresAt: row.expiresAt,
		holdRecoveryExpiresAt: row.holdRecoveryExpiresAt,
	});
}

/**
 * Review-only holder-side client. A v362 function result alone does not permit
 * fetch: the transaction and one-shot client shutdown must both acknowledge.
 * Any uncertain acknowledgement leaves the nonce spent or unknown; callers
 * must not replay it as another physical send.
 */
export async function grantPostgresCompleteTextAttemptV362(params: {
	granterConnectionString: string;
	attemptNonce: string;
	claim: TextGrantClaimRequestV361;
	nowMs?: () => number;
}, factory: SqlFactory = postgres): Promise<CommittedCompleteTextAttemptGrantV362> {
	const connection = validConnection(params.granterConnectionString);
	const attemptNonce = params.attemptNonce;
	if (typeof attemptNonce !== 'string' || !UUID.test(attemptNonce)) {
		throw new TypeError('PostgreSQL complete text attempt nonce invalid');
	}
	const claim = snapshotClaim(params.claim);
	const clock = params.nowMs ?? Date.now;
	const sql = factory(connection, { max: 1 });
	const transactional = sql as unknown as {
		begin<T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T>;
	};
	let result: CommittedCompleteTextAttemptGrantV362 | undefined;
	let failure: unknown;
	try {
		result = await transactional.begin(async tx => {
			const roles = await tx.unsafe(
				`SELECT current_user AS current_role, session_user AS session_role,
				  pg_catalog.current_setting('transaction_isolation') AS transaction_isolation,
				  pg_catalog.jsonb_typeof($1::jsonb) AS claim_type,
				  ($2::uuid IS NOT NULL) AS nonce_present`,
				[tx.json(claim), attemptNonce],
			);
			if (!Array.isArray(roles) || roles.length !== 1
				|| roles[0]?.current_role !== GRANTER_LOGIN
				|| roles[0]?.session_role !== GRANTER_LOGIN
				|| roles[0]?.transaction_isolation !== 'read committed'
				|| roles[0]?.claim_type !== 'object'
				|| roles[0]?.nonce_present !== true) {
				throw new TypeError(`PostgreSQL complete text attempt granter call preflight mismatch: ${JSON.stringify({
					currentRoleMatches: roles[0]?.current_role === GRANTER_LOGIN,
					sessionRoleMatches: roles[0]?.session_role === GRANTER_LOGIN,
					isolation: roles[0]?.transaction_isolation,
					claimType: roles[0]?.claim_type,
					noncePresent: roles[0]?.nonce_present,
				})}`);
			}
			const rows = await tx.unsafe(
				'SELECT cinatoken_gateway.grant_complete_flat_text_attempt_v362($1::uuid,$2::jsonb) AS value',
				[attemptNonce, tx.json(claim)],
			);
			if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
				|| typeof rows[0] !== 'object' || !('value' in rows[0])) {
				throw new TypeError('PostgreSQL complete text attempt grant response invalid');
			}
			return parseRecordedGrant(rows[0].value, claim, clock());
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') {
			throw new Error('LOGIN end did not acknowledge');
		}
		await closed;
	} catch (cleanupError) {
		throw new PostgresCompleteTextAttemptGrantCleanupUnconfirmedError(
			failure === undefined ? cleanupError
				: new AggregateError([failure, cleanupError], 'Grant and LOGIN cleanup failed'),
		);
	}
	if (failure !== undefined) throw failure;
	if (!result || Date.parse(result.expiresAt) <= clock()) {
		throw new PostgresCompleteTextAttemptGrantRejectedError('expired_after_ack');
	}
	return result;
}
