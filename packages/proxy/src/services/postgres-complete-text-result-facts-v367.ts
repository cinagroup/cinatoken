import { createHash } from 'node:crypto';
import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;
type SqlStatement = Pick<SqlClient, 'unsafe'>;

const HOLDER_LOGIN = 'cinatoken_gateway_complete_text_send_holder';
const BILL_LOGIN = 'cinatoken_gateway_complete_text_provider_bill';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROVIDER_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const BILL_AMOUNT = /^(0|[1-9][0-9]{0,17})$/u;

export type CompleteTextHolderEvidenceV367 =
	| Readonly<{ kind: 'no_fetch_attestation'; observation: 'fetch_not_called' }>
	| Readonly<{ kind: 'fetch_invoked'; observation: 'fetch_invoked'; uploadSha256: string }>
	| Readonly<{ kind: 'transport_unknown'; observation: 'transport_unknown';
		phase: 'connect' | 'headers' | 'body' | 'cancel' }>
	| Readonly<{ kind: 'provider_zero_charge_observation'; providerRequestRef: string;
		reportedChargeMicros: 0; signalSha256: string }>
	| Readonly<{ kind: 'provider_usage'; providerRequestRef: string;
		inputTokens: number; outputTokens: number }>;

/** amountMicros is decimal text so every SQL-accepted 18-digit amount stays exact. */
export type CompleteTextProviderBillEvidenceV367 = Readonly<{
	providerRequestRef: string;
	providerEventId: string;
	currency: 'USD';
	amountMicros: string;
	billDocumentSha256: string;
}>;

export type CommittedCompleteTextResultFactV367 = Readonly<{
	status: 'fact_recorded' | 'already_recorded';
	commitAcknowledged: true;
	sourceKind: 'holder' | 'provider_bill';
	kind: CompleteTextHolderEvidenceV367['kind'] | 'provider_bill';
	grantId: string;
	evidenceNonce: string;
	factId: string;
	evidenceSha256: string;
}>;

export class PostgresCompleteTextResultFactRejectedError extends Error {
	constructor(readonly status: string) {
		super(`PostgreSQL complete text result fact ${status}`);
		this.name = 'PostgresCompleteTextResultFactRejectedError';
	}
}

/** A failed close leaves the write outcome unknown even if COMMIT returned. */
export class PostgresCompleteTextResultFactCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL complete text result fact LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresCompleteTextResultFactCleanupUnconfirmedError';
	}
}

function validConnection(value: string, role: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError('PostgreSQL complete text result fact connection invalid');
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError('PostgreSQL complete text result fact connection invalid'); }
	if (!['postgres:', 'postgresql:'].includes(url.protocol)
		|| !url.hostname || !url.password || url.username !== role
		|| !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1
		|| [...url.searchParams].some(([key, setting]) =>
			key.toLowerCase() !== 'sslmode' || !['require', 'disable'].includes(setting))) {
		throw new TypeError('PostgreSQL complete text result fact direct LOGIN connection invalid');
	}
	return value;
}

function validId(value: string, name: string): string {
	if (typeof value !== 'string' || !UUID.test(value)) {
		throw new TypeError(`PostgreSQL complete text ${name} invalid`);
	}
	return value;
}

function exactFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)
		|| (Object.getPrototypeOf(value) !== Object.prototype
			&& Object.getPrototypeOf(value) !== null)
		|| Object.keys(value).sort().join(',') !== [...fields].sort().join(',')
		|| fields.some(field => !Object.hasOwn(
			Object.getOwnPropertyDescriptor(value, field) ?? {}, 'value'))) {
		throw new TypeError('PostgreSQL complete text result evidence fields invalid');
	}
	return value as Record<string, unknown>;
}

function checkedRef(value: unknown): string {
	if (typeof value !== 'string' || !PROVIDER_REF.test(value)) {
		throw new TypeError('PostgreSQL complete text provider reference invalid');
	}
	return value;
}

function checkedSha(value: unknown, name: string): string {
	if (typeof value !== 'string' || !SHA256.test(value)) {
		throw new TypeError(`PostgreSQL complete text ${name} invalid`);
	}
	return value;
}

function checkedCount(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0
		|| (value as number) > 999_999_999) {
		throw new TypeError('PostgreSQL complete text token count invalid');
	}
	return value as number;
}

/**
 * The v366 schema permits only flat ASCII strings and nonnegative integers.
 * PostgreSQL jsonb orders object keys by UTF-8 length and then byte order,
 * and prints a space after each comma and colon. Build that exact text here
 * so the client digest is independent of the database writer's digest check.
 */
function canonicalJsonbEvidence(entries: readonly (readonly [string, string | number])[]): {
	text: string; digest: string;
} {
	const sorted = [...entries].sort(([left], [right]) =>
		Buffer.byteLength(left) - Buffer.byteLength(right) || Buffer.compare(
			Buffer.from(left), Buffer.from(right)));
	const text = `{${sorted.map(([key, value]) =>
		`${JSON.stringify(key)}: ${typeof value === 'number' ? String(value) :
			key === 'amountMicros' ? value : JSON.stringify(value)}`).join(', ')}}`;
	if (Buffer.byteLength(text, 'utf8') > 1024) {
		throw new TypeError('PostgreSQL complete text result evidence too large');
	}
	return { text, digest: createHash('sha256').update(text).digest('hex') };
}

function holderEvidence(value: CompleteTextHolderEvidenceV367) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('PostgreSQL complete text holder evidence invalid');
	}
	const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
	const kind = kindDescriptor && 'value' in kindDescriptor
		? kindDescriptor.value as unknown : undefined;
	switch (kind) {
		case 'no_fetch_attestation': {
			const row = exactFields(value, ['kind', 'observation']);
			if (row.observation !== 'fetch_not_called') break;
			return { kind, ...canonicalJsonbEvidence([
				['observation', 'fetch_not_called'],
			]) };
		}
		case 'fetch_invoked': {
			const row = exactFields(value, ['kind', 'observation', 'uploadSha256']);
			if (row.observation !== 'fetch_invoked') break;
			return { kind, ...canonicalJsonbEvidence([
				['observation', 'fetch_invoked'],
				['uploadSha256', checkedSha(row.uploadSha256, 'upload digest')],
			]) };
		}
		case 'transport_unknown': {
			const row = exactFields(value, ['kind', 'observation', 'phase']);
			if (row.observation !== 'transport_unknown'
				|| !['connect', 'headers', 'body', 'cancel'].includes(row.phase as string)) break;
			return { kind, ...canonicalJsonbEvidence([
				['observation', 'transport_unknown'],
				['phase', row.phase as string],
			]) };
		}
		case 'provider_zero_charge_observation': {
			const row = exactFields(value, ['kind', 'providerRequestRef',
				'reportedChargeMicros', 'signalSha256']);
			if (row.reportedChargeMicros !== 0) break;
			return { kind, ...canonicalJsonbEvidence([
				['providerRequestRef', checkedRef(row.providerRequestRef)],
				['reportedChargeMicros', 0],
				['signalSha256', checkedSha(row.signalSha256, 'signal digest')],
			]) };
		}
		case 'provider_usage': {
			const row = exactFields(value, ['kind', 'providerRequestRef',
				'inputTokens', 'outputTokens']);
			return { kind, ...canonicalJsonbEvidence([
				['providerRequestRef', checkedRef(row.providerRequestRef)],
				['inputTokens', checkedCount(row.inputTokens)],
				['outputTokens', checkedCount(row.outputTokens)],
			]) };
		}
	}
	throw new TypeError('PostgreSQL complete text holder evidence invalid');
}

function billEvidence(value: CompleteTextProviderBillEvidenceV367) {
	const row = exactFields(value, ['providerRequestRef', 'providerEventId',
		'currency', 'amountMicros', 'billDocumentSha256']);
	if (row.currency !== 'USD' || typeof row.amountMicros !== 'string'
		|| !BILL_AMOUNT.test(row.amountMicros)) {
		throw new TypeError('PostgreSQL complete text provider bill amount invalid');
	}
	return { kind: 'provider_bill' as const, ...canonicalJsonbEvidence([
		['providerRequestRef', checkedRef(row.providerRequestRef)],
		['providerEventId', checkedRef(row.providerEventId)],
		['currency', 'USD'],
		['amountMicros', row.amountMicros],
		['billDocumentSha256', checkedSha(row.billDocumentSha256,
			'bill document digest')],
	]) };
}

function responseValue(rows: unknown): Record<string, unknown> {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !('value' in rows[0])
		|| !rows[0].value || typeof rows[0].value !== 'object'
		|| Array.isArray(rows[0].value)) {
		throw new TypeError('PostgreSQL complete text result fact response invalid');
	}
	return rows[0].value as Record<string, unknown>;
}

async function withDedicatedLogin<T>(connection: string, role: string,
	factory: SqlFactory, operation: (tx: SqlStatement) => Promise<T>): Promise<T> {
	const sql = factory(connection, { max: 1 });
	const transactional = sql as unknown as {
		begin<R>(callback: (tx: SqlStatement) => Promise<R>): Promise<R>;
	};
	let result: T | undefined;
	let failure: unknown;
	try {
		result = await transactional.begin(async tx => {
			const roles = await tx.unsafe(`SELECT current_user AS current_role,
			  session_user AS session_role,
			  pg_catalog.current_setting('transaction_isolation') AS transaction_isolation`);
			if (!Array.isArray(roles) || roles.length !== 1
				|| roles[0]?.current_role !== role || roles[0]?.session_role !== role
				|| roles[0]?.transaction_isolation !== 'read committed') {
				throw new TypeError('PostgreSQL complete text result fact direct LOGIN mismatch');
			}
			return operation(tx);
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') {
			throw new Error('PostgreSQL result fact LOGIN close did not acknowledge');
		}
		await closed;
	} catch (cleanupError) {
		throw new PostgresCompleteTextResultFactCleanupUnconfirmedError(
			failure === undefined ? cleanupError
				: new AggregateError([failure, cleanupError],
					'Result fact operation and LOGIN close failed'),
		);
	}
	if (failure !== undefined) throw failure;
	return result as T;
}

function receipt(row: Record<string, unknown>, identity: {
	grantId: string; evidenceNonce: string; sourceKind: 'holder' | 'provider_bill';
	kind: CommittedCompleteTextResultFactV367['kind']; digest: string;
}): CommittedCompleteTextResultFactV367 {
	if (row.status !== 'fact_recorded' && row.status !== 'already_recorded') {
		if (typeof row.status === 'string' && row.status.length <= 80) {
			throw new PostgresCompleteTextResultFactRejectedError(row.status);
		}
		throw new TypeError('PostgreSQL complete text result fact response invalid');
	}
	if (Object.keys(row).sort().join(',') !== 'evidenceSha256,factId,status'
		|| typeof row.factId !== 'string' || !UUID.test(row.factId)
		|| row.evidenceSha256 !== identity.digest) {
		throw new TypeError('PostgreSQL complete text result fact receipt mismatch');
	}
	return Object.freeze({ status: row.status, commitAcknowledged: true as const,
		sourceKind: identity.sourceKind, kind: identity.kind,
		grantId: identity.grantId, evidenceNonce: identity.evidenceNonce,
		factId: row.factId, evidenceSha256: identity.digest });
}

/**
 * Appends one holder observation. A nonce must be supplied by the caller and
 * retained across any explicit retry; this client never invents another one.
 */
export async function appendPostgresCompleteTextHolderFactV367(params: {
	holderConnectionString: string;
	grantId: string;
	holderRunId: string;
	expectedEpoch: number;
	evidenceNonce: string;
	evidence: CompleteTextHolderEvidenceV367;
}, factory: SqlFactory = postgres): Promise<CommittedCompleteTextResultFactV367> {
	const connection = validConnection(params.holderConnectionString, HOLDER_LOGIN);
	const grantId = validId(params.grantId, 'grant ID');
	const holderRunId = validId(params.holderRunId, 'holder run ID');
	const evidenceNonce = validId(params.evidenceNonce, 'evidence nonce');
	const expectedEpoch = params.expectedEpoch;
	if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) {
		throw new TypeError('PostgreSQL complete text holder epoch invalid');
	}
	const evidence = holderEvidence(params.evidence);
	const row = await withDedicatedLogin(connection, HOLDER_LOGIN, factory,
		async tx => responseValue(await tx.unsafe(
			`SELECT cinatoken_gateway.append_complete_text_holder_fact_v366(
			  $1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::text,$6::text::jsonb,$7::text) AS value`,
			[grantId, holderRunId, expectedEpoch, evidenceNonce, evidence.kind,
				evidence.text, evidence.digest],
		)));
	return receipt(row, { grantId, evidenceNonce, sourceKind: 'holder',
		kind: evidence.kind, digest: evidence.digest });
}

/**
 * Database writer only. The caller must independently authenticate the bill
 * document and correlate its provider event before calling this function.
 */
export async function appendPostgresCompleteTextProviderBillFactV367(params: {
	billConnectionString: string;
	grantId: string;
	evidenceNonce: string;
	evidence: CompleteTextProviderBillEvidenceV367;
}, factory: SqlFactory = postgres): Promise<CommittedCompleteTextResultFactV367> {
	const connection = validConnection(params.billConnectionString, BILL_LOGIN);
	const grantId = validId(params.grantId, 'grant ID');
	const evidenceNonce = validId(params.evidenceNonce, 'evidence nonce');
	const evidence = billEvidence(params.evidence);
	const row = await withDedicatedLogin(connection, BILL_LOGIN, factory,
		async tx => responseValue(await tx.unsafe(
			`SELECT cinatoken_gateway.append_complete_text_provider_bill_v366(
			  $1::uuid,$2::uuid,$3::text::jsonb,$4::text) AS value`,
			[grantId, evidenceNonce, evidence.text, evidence.digest],
		)));
	return receipt(row, { grantId, evidenceNonce, sourceKind: 'provider_bill',
		kind: 'provider_bill', digest: evidence.digest });
}
