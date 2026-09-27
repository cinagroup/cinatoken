import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';
import type { FinalChatQuoteSnapshot } from './chat-final-quote-input';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;
type SqlStatement = Pick<SqlClient, 'unsafe'>;
const ISSUER_LOGIN = 'cinatoken_gateway_request_capability_issuer';
const QUOTE_LOGIN = 'cinatoken_gateway_complete_text_quote_issuer';
const RUNTIME_LOGIN = 'cinatoken_gateway_runtime';
const MAX_FINAL_QUOTE_BODY_BYTES = 1_048_576;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const CAPABILITY_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export type CompleteFlatTextQuoteV360 = Readonly<{
	quoteId: string;
	requestId: string;
	finalBodySha256: string;
	modelIds: readonly string[];
	routeCount: number;
	credentialClass: 'platform';
	maxPerAttemptCeilingMicros: number;
	threeAttemptCeilingMicros: number;
	expiresAt: string;
}>;

export class PostgresCompleteChatQuoteRejectedError extends Error {
	constructor(readonly status: 'unauthorized' | 'stale' | 'unsupported' | 'conflict') {
		super(`PostgreSQL complete Chat quote ${status}`);
		this.name = 'PostgresCompleteChatQuoteRejectedError';
	}
}

export class PostgresCompleteChatQuoteCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL complete Chat quote LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresCompleteChatQuoteCleanupUnconfirmedError';
	}
}

function connectionString(value: string, label: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError(`PostgreSQL ${label} connection string invalid`);
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError(`PostgreSQL ${label} connection string invalid`); }
	if (!['postgres:', 'postgresql:'].includes(url.protocol)
		|| !url.hostname || !url.username || !url.password
		|| !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].some(([key, setting]) => key.toLowerCase() !== 'sslmode'
			|| !['require', 'disable'].includes(setting))
		|| [...url.searchParams].length > 1) {
		throw new TypeError(`PostgreSQL ${label} connection string invalid`);
	}
	return value;
}

function oneValue(rows: unknown): unknown {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !('value' in rows[0])) {
		throw new TypeError('PostgreSQL complete Chat quote response invalid');
	}
	return rows[0].value;
}

async function directLogin(tx: SqlStatement, expected: string): Promise<void> {
	const rows = await tx.unsafe('SELECT current_user AS current_role, session_user AS session_role');
	if (!Array.isArray(rows) || rows.length !== 1
		|| rows[0]?.current_role !== expected || rows[0]?.session_role !== expected) {
		throw new TypeError('PostgreSQL complete Chat quote LOGIN mismatch');
	}
}

async function withDedicatedLogin<T>(
	connection: string,
	expectedLogin: string,
	factory: SqlFactory,
	operation: (tx: SqlStatement) => Promise<T>,
): Promise<T> {
	const sql = factory(connection, { max: 1 });
	const transactional = sql as unknown as {
		begin<R>(callback: (tx: SqlStatement) => Promise<R>): Promise<R>;
	};
	let value: T | undefined;
	let failure: unknown;
	try {
		value = await transactional.begin(async tx => {
			await directLogin(tx, expectedLogin);
			return operation(tx);
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') throw new Error('LOGIN end did not acknowledge');
		await closed;
	} catch (cleanupError) {
		throw new PostgresCompleteChatQuoteCleanupUnconfirmedError(
			failure === undefined ? cleanupError
				: new AggregateError([failure, cleanupError], 'Quote operation and LOGIN cleanup failed'),
		);
	}
	if (failure !== undefined) throw failure;
	return value as T;
}

function requiredRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('PostgreSQL complete Chat quote response invalid');
	}
	return value as Record<string, unknown>;
}

function rejectStatus(value: Record<string, unknown>): never {
	if (value.status === 'unauthorized' || value.status === 'stale'
		|| value.status === 'unsupported' || value.status === 'conflict') {
		throw new PostgresCompleteChatQuoteRejectedError(value.status);
	}
	throw new TypeError('PostgreSQL complete Chat quote response invalid');
}

function issuedCapability(value: unknown, params: {
	requestId: string; apiKeyId: string; userId: string; workspaceId: string;
	budgetEpoch: number; keyLimitEpoch?: number;
}): string {
	const row = requiredRecord(value);
	if (row.status !== 'issued') rejectStatus(row);
	if (row.requestId !== params.requestId || row.apiKeyId !== params.apiKeyId
		|| row.userId !== params.userId || row.workspaceId !== params.workspaceId
		|| row.budgetEpoch !== params.budgetEpoch
		|| !Number.isSafeInteger(row.keyLimitEpoch) || (row.keyLimitEpoch as number) < 0
		|| (params.keyLimitEpoch !== undefined && row.keyLimitEpoch !== params.keyLimitEpoch)
		|| typeof row.capability !== 'string' || !CAPABILITY_RE.test(row.capability)
		|| typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))) {
		throw new TypeError('PostgreSQL Chat capability response differs from authenticated request');
	}
	return row.capability;
}

function completeQuote(value: unknown, input: FinalChatQuoteSnapshot): CompleteFlatTextQuoteV360 {
	const row = requiredRecord(value);
	if (row.status !== 'quoted_complete_subset') rejectStatus(row);
	const max = row.maxPerAttemptCeilingMicros;
	const total = row.threeAttemptCeilingMicros;
	if (typeof row.quoteId !== 'string' || !UUID_RE.test(row.quoteId)
		|| row.requestId !== input.requestId
		|| row.finalBodySha256 !== input.finalBodySha256
		|| !Array.isArray(row.modelIds)
		|| row.modelIds.length !== input.modelIds.length
		|| row.modelIds.some((id, index) => id !== input.modelIds[index])
		|| !Number.isSafeInteger(row.routeCount) || (row.routeCount as number) < input.modelIds.length
		|| (row.routeCount as number) > 100
		|| row.credentialClass !== 'platform'
		|| !Number.isSafeInteger(max) || (max as number) < 0
		|| !Number.isSafeInteger(total) || (total as number) !== (max as number) * 3
		|| typeof row.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(row.expiresAt))
		|| Date.parse(row.expiresAt) <= Date.now()) {
		throw new TypeError('PostgreSQL complete Chat quote response differs from final request');
	}
	return Object.freeze({
		quoteId: row.quoteId,
		requestId: input.requestId,
		finalBodySha256: input.finalBodySha256,
		modelIds: Object.freeze([...input.modelIds]),
		routeCount: row.routeCount as number,
		credentialClass: 'platform' as const,
		maxPerAttemptCeilingMicros: max as number,
		threeAttemptCeilingMicros: total as number,
		expiresAt: row.expiresAt,
	});
}

/**
 * Review-only, one-shot v356 -> v360 bridge. Each SECURITY DEFINER call uses
 * its own direct LOGIN and waits for COMMIT and client close ACK. No attempt is
 * dispatched from this return value; a separate manifest-backed budget hold
 * and committed physical egress grant are still required.
 */
export async function issuePostgresCompleteChatQuoteV360(params: {
	runtimeClient: PostgresDatabaseClient;
	runtimeConnectionString: string;
	capabilityConnectionString: string;
	quoteConnectionString: string;
	bearer: string;
	identity: Readonly<{
		apiKeyId: string; userId: string; workspaceId: string;
		budgetEpoch: number; keyLimitEpoch?: number;
	}>;
	finalQuoteInput: FinalChatQuoteSnapshot;
}, factories: { capability?: SqlFactory; quote?: SqlFactory } = {}): Promise<CompleteFlatTextQuoteV360> {
	const input = params.finalQuoteInput;
	const identity = Object.freeze({ ...params.identity, requestId: input.requestId });
	const bearer = params.bearer;
	if (params.runtimeClient.driver !== 'postgres'
		|| !Object.isFrozen(input) || !Object.isFrozen(input.modelIds)
		|| typeof identity.requestId !== 'string' || identity.requestId.length < 1
		|| identity.requestId.length > 128
		|| typeof identity.apiKeyId !== 'string' || !identity.apiKeyId
		|| typeof identity.userId !== 'string' || !identity.userId
		|| typeof identity.workspaceId !== 'string' || !identity.workspaceId
		|| typeof bearer !== 'string' || bearer.length < 16 || bearer.length > 512
		|| !SHA256_RE.test(input.originalBodySha256)
		|| !SHA256_RE.test(input.finalBodySha256)
		|| typeof input.finalBodyUtf8 !== 'string'
		|| !Number.isSafeInteger(identity.budgetEpoch) || identity.budgetEpoch < 0
		|| (identity.keyLimitEpoch !== undefined &&
			(!Number.isSafeInteger(identity.keyLimitEpoch) || identity.keyLimitEpoch < 0))) {
		throw new TypeError('PostgreSQL complete Chat quote input invalid');
	}
	const runtimeConnection = connectionString(params.runtimeConnectionString, 'runtime');
	const capabilityConnection = connectionString(params.capabilityConnectionString, 'capability');
	const quoteConnection = connectionString(params.quoteConnectionString, 'quote');
	if (new Set([runtimeConnection, capabilityConnection, quoteConnection]).size !== 3) {
		throw new TypeError('PostgreSQL complete Chat quote LOGIN connections must be distinct');
	}
	const finalBytes = new TextEncoder().encode(input.finalBodyUtf8);
	if (finalBytes.byteLength < 2 || finalBytes.byteLength > MAX_FINAL_QUOTE_BODY_BYTES) {
		throw new TypeError('PostgreSQL complete Chat final body outside supported subset');
	}
	await directLogin(params.runtimeClient.raw, RUNTIME_LOGIN);
	const actualFinalSha = await crypto.subtle.digest('SHA-256', finalBytes);
	if ([...new Uint8Array(actualFinalSha)].map(byte => byte.toString(16).padStart(2, '0')).join('')
		!== input.finalBodySha256) {
		throw new TypeError('PostgreSQL complete Chat final body digest invalid');
	}
	const capability = await withDedicatedLogin(capabilityConnection, ISSUER_LOGIN,
		factories.capability ?? postgres,
		async tx => issuedCapability(oneValue(await tx.unsafe(
			'SELECT cinatoken_gateway.issue_request_capability_v356($1,$2,$3) AS value',
			[input.requestId, bearer, input.originalBodySha256],
		)), identity));
	return withDedicatedLogin(quoteConnection, QUOTE_LOGIN,
		factories.quote ?? postgres,
		async tx => completeQuote(oneValue(await tx.unsafe(
			'SELECT cinatoken_gateway.issue_complete_flat_text_quote_v360($1,$2,$3,$4) AS value',
			[input.requestId, capability, input.originalBodySha256, input.finalBodyUtf8],
		)), input));
}
