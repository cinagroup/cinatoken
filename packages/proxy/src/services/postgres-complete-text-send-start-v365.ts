import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;
type SqlStatement = Pick<SqlClient, 'unsafe'>;

const HOLDER_LOGIN = 'cinatoken_gateway_complete_text_send_holder';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export type CommittedCompleteTextCustodyV365 = Readonly<{
	status: 'custody_claim_recorded';
	commitAcknowledged: true;
	grantId: string;
	holderRunId: string;
	leaseEpoch: 1;
	leaseUntil: string;
}>;

export type CommittedCompleteTextSendStartV365 = Readonly<{
	status: 'start_recorded';
	commitAcknowledged: true;
	sendStartId: string;
	grantId: string;
	holderRunId: string;
	leaseEpoch: number;
	uploadSha256: string;
	expiresAt: string;
}>;

export class PostgresCompleteTextSendStartRejectedError extends Error {
	constructor(readonly status: string) {
		super(`PostgreSQL complete text send start ${status}`);
		this.name = 'PostgresCompleteTextSendStartRejectedError';
	}
}

export class PostgresCompleteTextSendStartCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL complete text holder LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresCompleteTextSendStartCleanupUnconfirmedError';
	}
}

function validConnection(value: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError('PostgreSQL complete text holder connection invalid');
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError('PostgreSQL complete text holder connection invalid'); }
	if (!['postgres:', 'postgresql:'].includes(url.protocol)
		|| !url.hostname || !url.username || !url.password
		|| !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1
		|| [...url.searchParams].some(([key, setting]) => key.toLowerCase() !== 'sslmode'
			|| !['require', 'disable'].includes(setting))) {
		throw new TypeError('PostgreSQL complete text holder connection invalid');
	}
	return value;
}

function validId(value: string, label: string): string {
	if (typeof value !== 'string' || !UUID.test(value)) {
		throw new TypeError(`PostgreSQL complete text ${label} invalid`);
	}
	return value;
}

function responseValue(rows: unknown): Record<string, unknown> {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !('value' in rows[0])
		|| !rows[0].value || typeof rows[0].value !== 'object'
		|| Array.isArray(rows[0].value)) {
		throw new TypeError('PostgreSQL complete text holder response invalid');
	}
	return rows[0].value as Record<string, unknown>;
}

function rejectStatus(row: Record<string, unknown>): never {
	if (typeof row.status === 'string' && row.status.length <= 80) {
		throw new PostgresCompleteTextSendStartRejectedError(row.status);
	}
	throw new TypeError('PostgreSQL complete text holder response invalid');
}

async function withDedicatedHolderLogin<T>(connection: string, factory: SqlFactory,
	operation: (tx: SqlStatement) => Promise<T>): Promise<T> {
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
				|| roles[0]?.current_role !== HOLDER_LOGIN
				|| roles[0]?.session_role !== HOLDER_LOGIN
				|| roles[0]?.transaction_isolation !== 'read committed') {
				throw new TypeError('PostgreSQL complete text holder direct LOGIN mismatch');
			}
			return operation(tx);
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') {
			throw new Error('PostgreSQL holder LOGIN close did not acknowledge');
		}
		await closed;
	} catch (cleanupError) {
		throw new PostgresCompleteTextSendStartCleanupUnconfirmedError(
			failure === undefined ? cleanupError
				: new AggregateError([failure, cleanupError], 'Holder operation and LOGIN close failed'),
		);
	}
	if (failure !== undefined) throw failure;
	return result as T;
}

function clockNow(clock: () => number): number {
	const now = clock();
	if (!Number.isSafeInteger(now)) throw new TypeError('PostgreSQL holder clock invalid');
	return now;
}

/** Fresh custody ACK is issued only after COMMIT and the one-shot client close. */
export async function claimPostgresCompleteTextCustodyV365(params: {
	holderConnectionString: string;
	grantId: string;
	holderRunId: string;
	nowMs?: () => number;
}, factory: SqlFactory = postgres): Promise<CommittedCompleteTextCustodyV365> {
	const connection = validConnection(params.holderConnectionString);
	const grantId = validId(params.grantId, 'grant ID');
	const holderRunId = validId(params.holderRunId, 'holder run ID');
	const clock = params.nowMs ?? Date.now;
	const row = await withDedicatedHolderLogin(connection, factory, async tx => responseValue(
		await tx.unsafe(
			'SELECT cinatoken_gateway.claim_complete_text_send_custody_v365($1::uuid,$2::uuid) AS value',
			[grantId, holderRunId],
		),
	));
	if (row.status !== 'custody_claim_recorded') rejectStatus(row);
	if (row.grantId !== grantId || row.holderRunId !== holderRunId
		|| row.leaseEpoch !== 1
		|| typeof row.leaseUntil !== 'string'
		|| !Number.isFinite(Date.parse(row.leaseUntil))
		|| Date.parse(row.leaseUntil) <= clockNow(clock)) {
		throw new TypeError('PostgreSQL complete text custody response mismatch');
	}
	return Object.freeze({ status: 'custody_claim_recorded' as const,
		commitAcknowledged: true as const, grantId, holderRunId,
		leaseEpoch: 1 as const, leaseUntil: row.leaseUntil });
}

/** Fresh start ACK is one physical send right; a duplicate status is denied. */
export async function recordPostgresCompleteTextSendStartV365(params: {
	holderConnectionString: string;
	grantId: string;
	holderRunId: string;
	expectedEpoch: number;
	uploadSha256: string;
	nowMs?: () => number;
}, factory: SqlFactory = postgres): Promise<CommittedCompleteTextSendStartV365> {
	const connection = validConnection(params.holderConnectionString);
	const grantId = validId(params.grantId, 'grant ID');
	const holderRunId = validId(params.holderRunId, 'holder run ID');
	const expectedEpoch = params.expectedEpoch;
	const uploadSha256 = params.uploadSha256;
	if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1
		|| typeof uploadSha256 !== 'string' || !SHA256.test(uploadSha256)) {
		throw new TypeError('PostgreSQL complete text send-start identity invalid');
	}
	const clock = params.nowMs ?? Date.now;
	const row = await withDedicatedHolderLogin(connection, factory, async tx => responseValue(
		await tx.unsafe(
			`SELECT cinatoken_gateway.record_complete_text_send_start_v365(
			  $1::uuid,$2::uuid,$3::bigint,$4::text) AS value`,
			[grantId, holderRunId, expectedEpoch, uploadSha256],
		),
	));
	if (row.status !== 'start_recorded') rejectStatus(row);
	if (typeof row.sendStartId !== 'string' || !UUID.test(row.sendStartId)
		|| row.grantId !== grantId || row.holderRunId !== holderRunId
		|| row.leaseEpoch !== expectedEpoch
		|| row.uploadSha256 !== uploadSha256
		|| typeof row.expiresAt !== 'string'
		|| !Number.isFinite(Date.parse(row.expiresAt))
		|| Date.parse(row.expiresAt) <= clockNow(clock)) {
		throw new TypeError('PostgreSQL complete text send-start response mismatch');
	}
	return Object.freeze({ status: 'start_recorded' as const,
		commitAcknowledged: true as const,
		sendStartId: row.sendStartId, grantId, holderRunId,
		leaseEpoch: expectedEpoch, uploadSha256,
		expiresAt: row.expiresAt });
}
