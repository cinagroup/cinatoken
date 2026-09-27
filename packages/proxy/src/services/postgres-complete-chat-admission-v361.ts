import postgres from 'postgres';
import type { GuardrailBudgetIntent, PostgresDatabaseClient } from '@octafuse/core';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;
type SqlStatement = Pick<SqlClient, 'unsafe' | 'json'>;
const ADMISSION_LOGIN = 'cinatoken_gateway_budget_admission';
const RUNTIME_LOGIN = 'cinatoken_gateway_runtime';
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;

export type CompleteChatAdmissionV361 = Readonly<{
	status: 'admitted' | 'idempotent';
	quoteId: string;
	requestId: string;
	finalBodySha256: string;
	reservedMicros: number;
	ordinary: 'reserved' | 'unlimited';
	guardrailCount: number;
	expiresAt: string;
}>;

export class PostgresCompleteChatAdmissionRejectedError extends Error {
	constructor(readonly status: string) {
		super(`PostgreSQL complete Chat admission ${status}`);
		this.name = 'PostgresCompleteChatAdmissionRejectedError';
	}
}

export class PostgresCompleteChatAdmissionCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL complete Chat admission LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresCompleteChatAdmissionCleanupUnconfirmedError';
	}
}

function validConnection(value: string, label: string): string {
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

async function assertDirectLogin(sql: SqlStatement, role: string): Promise<void> {
	const rows = await sql.unsafe('SELECT current_user AS current_role, session_user AS session_role');
	if (!Array.isArray(rows) || rows.length !== 1
		|| rows[0]?.current_role !== role || rows[0]?.session_role !== role) {
		throw new TypeError('PostgreSQL complete Chat admission LOGIN mismatch');
	}
}

function parseAdmission(value: unknown, quote: CompleteFlatTextQuoteV360,
	intentCount: number): CompleteChatAdmissionV361 {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('PostgreSQL complete Chat admission response invalid');
	}
	const row = value as Record<string, unknown>;
	if (row.status !== 'admitted' && row.status !== 'idempotent') {
		if (typeof row.status === 'string' && row.status.length <= 80) {
			throw new PostgresCompleteChatAdmissionRejectedError(row.status);
		}
		throw new TypeError('PostgreSQL complete Chat admission response invalid');
	}
	if (row.quoteId !== quote.quoteId || row.finalBodySha256 !== quote.finalBodySha256
		|| row.reservedMicros !== quote.threeAttemptCeilingMicros
		|| !Number.isSafeInteger(row.guardrailCount) || row.guardrailCount !== intentCount
		|| typeof row.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(row.expiresAt))
		|| Date.parse(row.expiresAt) <= Date.now()
		|| Date.parse(row.expiresAt) > Date.parse(quote.expiresAt)
		|| (row.ordinary !== 'reserved' && row.ordinary !== 'unlimited')) {
		throw new TypeError('PostgreSQL complete Chat admission differs from quoted request');
	}
	return Object.freeze({
		status: row.status,
		quoteId: quote.quoteId,
		requestId: quote.requestId,
		finalBodySha256: quote.finalBodySha256,
		reservedMicros: quote.threeAttemptCeilingMicros,
		ordinary: row.ordinary,
		guardrailCount: intentCount,
		expiresAt: row.expiresAt,
	});
}

/**
 * Review-only no-amount bridge to v361. The database reads the committed v360
 * quote and reserves its full three-attempt ceiling. A committed admission is
 * not a physical dispatch grant; the caller must still fail closed before fetch.
 */
export async function admitPostgresCompleteChatQuoteV361(params: {
	runtimeClient: PostgresDatabaseClient;
	runtimeConnectionString: string;
	admissionConnectionString: string;
	quote: CompleteFlatTextQuoteV360;
	guardrailIntents: readonly GuardrailBudgetIntent[];
}, factory: SqlFactory = postgres): Promise<CompleteChatAdmissionV361> {
	const { quote } = params;
	if (params.runtimeClient.driver !== 'postgres'
		|| !quote || !Object.isFrozen(quote)
		|| typeof quote.requestId !== 'string' || quote.requestId.length < 1
		|| quote.requestId.length > 128
		|| typeof quote.quoteId !== 'string' || !UUID_RE.test(quote.quoteId)
		|| typeof quote.finalBodySha256 !== 'string'
		|| !SHA256_RE.test(quote.finalBodySha256)
		|| !Number.isSafeInteger(quote.threeAttemptCeilingMicros)
		|| quote.threeAttemptCeilingMicros < 1
		|| !Number.isSafeInteger(quote.maxPerAttemptCeilingMicros)
		|| quote.threeAttemptCeilingMicros !== quote.maxPerAttemptCeilingMicros * 3
		|| typeof quote.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(quote.expiresAt))
		|| Date.parse(quote.expiresAt) <= Date.now()
		|| !Array.isArray(params.guardrailIntents)
		|| params.guardrailIntents.length > 7) {
		throw new TypeError('PostgreSQL complete Chat admission input invalid');
	}
	const runtimeConnection = validConnection(params.runtimeConnectionString, 'runtime');
	const admissionConnection = validConnection(params.admissionConnectionString, 'admission');
	if (runtimeConnection === admissionConnection) {
		throw new TypeError('PostgreSQL complete Chat admission LOGIN connections must be distinct');
	}
	const intentsJson = JSON.stringify(params.guardrailIntents);
	if (typeof intentsJson !== 'string' || intentsJson.length > 32_768) {
		throw new TypeError('PostgreSQL complete Chat admission intents invalid');
	}
	const intentsSnapshot = JSON.parse(intentsJson) as GuardrailBudgetIntent[];
	if (!Array.isArray(intentsSnapshot)
		|| intentsSnapshot.length !== params.guardrailIntents.length) {
		throw new TypeError('PostgreSQL complete Chat admission intents invalid');
	}
	await assertDirectLogin(params.runtimeClient.raw, RUNTIME_LOGIN);
	const sql = factory(admissionConnection, { max: 1 });
	const transactional = sql as unknown as {
		begin<T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T>;
	};
	let result: CompleteChatAdmissionV361 | undefined;
	let failure: unknown;
	try {
		result = await transactional.begin(async tx => {
			await assertDirectLogin(tx, ADMISSION_LOGIN);
			const rows = await tx.unsafe(
				'SELECT cinatoken_gateway.admit_complete_flat_text_quote_v361($1,$2::uuid,$3::jsonb) AS value',
				[quote.requestId, quote.quoteId, tx.json(intentsSnapshot)],
			);
			if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
				|| typeof rows[0] !== 'object' || !('value' in rows[0])) {
				throw new TypeError('PostgreSQL complete Chat admission response invalid');
			}
			return parseAdmission(rows[0].value, quote, params.guardrailIntents.length);
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') {
			throw new Error('LOGIN end did not acknowledge');
		}
		await closed;
	} catch (cleanupError) {
		throw new PostgresCompleteChatAdmissionCleanupUnconfirmedError(
			failure === undefined ? cleanupError
				: new AggregateError([failure, cleanupError], 'Admission and LOGIN cleanup failed'),
		);
	}
	if (failure !== undefined) throw failure;
	return result as CompleteChatAdmissionV361;
}
