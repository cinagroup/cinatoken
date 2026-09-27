import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	confirmPostgresCompleteTextNoFetchV370,
	PostgresCompleteTextNoFetchRejectedError,
} from './postgres-complete-text-no-fetch-v372';
import {
	closePostgresCompleteTextNoFetchV388,
	PostgresCompleteTextNoFetchCloseRejectedError,
} from './postgres-complete-text-no-fetch-close-v388';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlStatement = Pick<SqlClient, 'unsafe'>;
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const LOGIN = Object.freeze({
	worker: 'cinatoken_gateway_complete_text_recovery_worker',
	observer: 'cinatoken_gateway_complete_text_recovery_observer',
	resolver: 'cinatoken_gateway_complete_text_no_fetch_resolver',
	closer: 'cinatoken_gateway_complete_text_platform_closer',
});

export type CompleteTextNoFetchRecoveryConnectionsV389 = Readonly<{
	workerConnectionString: string;
	observerConnectionString: string;
	resolverConnectionString: string;
	closerConnectionString: string;
}>;
export type NoFetchRecoveryClaimV389 = Readonly<{
	status: 'claimed'; jobId: string; requestId: string; grantId: string;
	resolutionNonce: string; decisionNonce: string; leaseToken: string;
	leaseGeneration: number; leaseUntil: string; attemptCount: number;
}>;
export type NoFetchRecoveryObservationV389 = Readonly<{
	status: 'ready_to_resolve' | 'ready_to_close' | 'confirmed' | 'possible_send' | 'conflict';
	jobId: string; requestId: string; grantId: string;
	resolutionNonce: string; decisionNonce: string;
	resolutionId: string | null; terminalId: string | null; eventId: string | null;
}>;
type LeaseLost = Readonly<{ status: 'lease_lost' }>;
type Committed<T> = Readonly<T & { commitAcknowledged: true; closeAcknowledged: true }>;
export type NoFetchRecoveryFailureV389 =
	'possible_send' | 'state_conflict' | 'resolver_rejected' | 'closer_rejected' | 'not_confirmed';

export type NoFetchRecoveryClientV389 = Readonly<{
	scan(limit: number): Promise<Committed<{ status: 'scanned'; enqueued: number }>>;
	claim(leaseSeconds: number): Promise<Committed<NoFetchRecoveryClaimV389 | { status: 'empty' }>>;
	observe(claim: NoFetchRecoveryClaimV389): Promise<Committed<NoFetchRecoveryObservationV389 | LeaseLost>>;
	finish(claim: NoFetchRecoveryClaimV389): Promise<Committed<{
		status: 'completed' | 'quarantined' | 'not_confirmed' | 'lease_lost';
		jobId: string; terminalId: string | null; eventId: string | null;
	}>>;
	fail(claim: NoFetchRecoveryClaimV389, code: NoFetchRecoveryFailureV389):
		Promise<Committed<{ status: 'retry_scheduled' | 'quarantined' | 'lease_lost' }>>;
}>;

export class PostgresNoFetchRecoveryCleanupUnconfirmedV389 extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL no-fetch recovery LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresNoFetchRecoveryCleanupUnconfirmedV389';
	}
}

function failShape(): never { throw new TypeError('PostgreSQL no-fetch recovery response differs'); }
function exact(row: Record<string, unknown>, fields: readonly string[]): void {
	if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) failShape();
}
function isId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function integer(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function requestId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
function validConnection(value: string, login: string): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new TypeError('No-fetch recovery connection invalid'); }
	if (typeof value !== 'string' || value !== value.trim()
		|| !['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
		|| url.username !== login || !url.password || !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1 || [...url.searchParams].some(([key, val]) =>
			key.toLowerCase() !== 'sslmode' || !['disable', 'require'].includes(val))) {
		throw new TypeError('No-fetch recovery direct LOGIN connection invalid');
	}
	return value;
}
function connections(input: CompleteTextNoFetchRecoveryConnectionsV389): CompleteTextNoFetchRecoveryConnectionsV389 {
	const captured = Object.freeze({ ...input });
	for (const role of ['worker', 'observer', 'resolver', 'closer'] as const) {
		validConnection(captured[`${role}ConnectionString`], LOGIN[role]);
	}
	return captured;
}
function value(rows: unknown): Record<string, unknown> {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object'
		|| !rows[0].value || typeof rows[0].value !== 'object' || Array.isArray(rows[0].value)) failShape();
	return rows[0].value as Record<string, unknown>;
}
function claimRow(row: Record<string, unknown>): NoFetchRecoveryClaimV389 | { status: 'empty' } {
	if (row.status === 'empty') { exact(row, ['status']); return { status: 'empty' }; }
	exact(row, ['status', 'jobId', 'requestId', 'grantId', 'resolutionNonce', 'decisionNonce',
		'leaseToken', 'leaseGeneration', 'leaseUntil', 'attemptCount']);
	if (row.status !== 'claimed' || !isId(row.jobId) || !requestId(row.requestId) || !isId(row.grantId)
		|| !isId(row.resolutionNonce) || !isId(row.decisionNonce) || !isId(row.leaseToken)
		|| !integer(row.leaseGeneration, 1, Number.MAX_SAFE_INTEGER) || !integer(row.attemptCount, 1, 7)
		|| typeof row.leaseUntil !== 'string' || !Number.isFinite(Date.parse(row.leaseUntil))) failShape();
	return Object.freeze({ status: 'claimed', jobId: row.jobId, requestId: row.requestId,
		grantId: row.grantId, resolutionNonce: row.resolutionNonce, decisionNonce: row.decisionNonce,
		leaseToken: row.leaseToken, leaseGeneration: row.leaseGeneration,
		leaseUntil: row.leaseUntil, attemptCount: row.attemptCount });
}
function observationRow(row: Record<string, unknown>, claim: NoFetchRecoveryClaimV389):
	NoFetchRecoveryObservationV389 | LeaseLost {
	if (row.status === 'lease_lost') { exact(row, ['status']); return { status: 'lease_lost' }; }
	exact(row, ['status', 'jobId', 'requestId', 'grantId', 'resolutionNonce', 'decisionNonce',
		'resolutionId', 'terminalId', 'eventId']);
	if (!['ready_to_resolve', 'ready_to_close', 'confirmed', 'possible_send', 'conflict'].includes(String(row.status))
		|| row.jobId !== claim.jobId || row.requestId !== claim.requestId || row.grantId !== claim.grantId
		|| row.resolutionNonce !== claim.resolutionNonce || row.decisionNonce !== claim.decisionNonce
		|| ['resolutionId', 'terminalId', 'eventId'].some(key => row[key] !== null && !isId(row[key]))) failShape();
	if ((row.status === 'ready_to_resolve' && (row.resolutionId !== null || row.terminalId !== null || row.eventId !== null))
		|| (row.status === 'ready_to_close' && (!isId(row.resolutionId) || row.terminalId !== null || row.eventId !== null))
		|| (row.status === 'confirmed' && (!isId(row.resolutionId) || !isId(row.terminalId) || !isId(row.eventId)))) failShape();
	return Object.freeze({ ...row }) as NoFetchRecoveryObservationV389;
}
function snapshotClaim(input: NoFetchRecoveryClaimV389): NoFetchRecoveryClaimV389 {
	const checked = claimRow({ ...input, status: input.status });
	if (checked.status !== 'claimed') failShape();
	return checked;
}
function acknowledged<T extends { commitAcknowledged: true; closeAcknowledged: true }>(receipt: T): T {
	if (!receipt || receipt.commitAcknowledged !== true || receipt.closeAcknowledged !== true) {
		throw new TypeError('No-fetch recovery operation acknowledgement missing');
	}
	return receipt;
}

/** Every operation gets an independent direct LOGIN and validates within its transaction. */
export function createPostgresCompleteTextNoFetchRecoveryV389(
	input: CompleteTextNoFetchRecoveryConnectionsV389, factory: SqlFactory = postgres,
): NoFetchRecoveryClientV389 {
	const urls = connections(input);
	async function call<T>(role: 'worker' | 'observer', statement: string, args: readonly (string | number)[],
		check: (row: Record<string, unknown>) => T): Promise<Committed<T>> {
		const sql = factory(urls[`${role}ConnectionString`], { max: 1 });
		const transactional = sql as unknown as { begin<R>(run: (tx: SqlStatement) => Promise<R>): Promise<R> };
		let answer: T | undefined;
		let failure: unknown;
		try {
			answer = await transactional.begin(async tx => {
				const roles = await tx.unsafe('SELECT current_user AS current_role, session_user AS session_role,'
					+ " pg_catalog.current_setting('transaction_isolation') AS transaction_isolation");
				if (!Array.isArray(roles) || roles.length !== 1 || roles[0]?.current_role !== LOGIN[role]
					|| roles[0]?.session_role !== LOGIN[role] || roles[0]?.transaction_isolation !== 'read committed') {
					throw new TypeError('No-fetch recovery direct LOGIN mismatch');
				}
				// Set before the function statement so waits and scans have a real
				// PostgreSQL command timeout, including request-lock contention.
				await tx.unsafe("SET LOCAL lock_timeout='2s'");
				await tx.unsafe("SET LOCAL statement_timeout='15s'");
				return check(value(await tx.unsafe(statement, [...args])));
			});
		} catch (error) { failure = error; }
		try {
			const closed = sql.end({ timeout: 1 });
			if (!closed || typeof closed.then !== 'function') throw new Error('No-fetch recovery close did not acknowledge');
			await closed;
		} catch (error) {
			throw new PostgresNoFetchRecoveryCleanupUnconfirmedV389(failure === undefined ? error
				: new AggregateError([failure, error], 'No-fetch recovery operation and close failed'));
		}
		if (failure !== undefined) throw failure;
		if (answer === undefined) failShape();
		return Object.freeze({ ...answer, commitAcknowledged: true as const, closeAcknowledged: true as const });
	}
	return Object.freeze({
		scan(limit) {
			if (!integer(limit, 1, 50)) throw new TypeError('No-fetch scan limit invalid');
			return call('worker', 'SELECT cinatoken_gateway.scan_complete_text_no_fetch_recovery_v389($1::integer) AS value', [limit], row => {
				exact(row, ['status', 'enqueued']);
				if (row.status !== 'scanned' || !integer(row.enqueued, 0, limit)) failShape();
				return { status: 'scanned' as const, enqueued: row.enqueued };
			});
		},
		claim(leaseSeconds) {
			if (!integer(leaseSeconds, 5, 300)) throw new TypeError('No-fetch lease duration invalid');
			return call('worker', 'SELECT cinatoken_gateway.claim_complete_text_no_fetch_recovery_v389($1::integer) AS value', [leaseSeconds], claimRow);
		},
		observe(inputClaim) {
			const claim = snapshotClaim(inputClaim);
			return call('observer', 'SELECT cinatoken_gateway.observe_complete_text_no_fetch_recovery_v389($1::uuid,$2::uuid) AS value',
				[claim.jobId, claim.leaseToken], row => observationRow(row, claim));
		},
		finish(inputClaim) {
			const claim = snapshotClaim(inputClaim);
			return call('observer', 'SELECT cinatoken_gateway.finish_complete_text_no_fetch_recovery_v389($1::uuid,$2::uuid) AS value',
				[claim.jobId, claim.leaseToken], row => {
					exact(row, ['status', 'jobId', 'terminalId', 'eventId']);
					if (!['completed', 'quarantined', 'not_confirmed', 'lease_lost'].includes(String(row.status))
						|| row.jobId !== claim.jobId || (row.terminalId !== null && !isId(row.terminalId))
						|| (row.eventId !== null && !isId(row.eventId))
						|| (row.status === 'completed' && (!isId(row.terminalId) || !isId(row.eventId)))) failShape();
					return { status: row.status, jobId: claim.jobId, terminalId: row.terminalId, eventId: row.eventId } as
						{ status: 'completed' | 'quarantined' | 'not_confirmed' | 'lease_lost'; jobId: string; terminalId: string | null; eventId: string | null };
				});
		},
		fail(inputClaim, code) {
			const claim = snapshotClaim(inputClaim);
			if (!['possible_send', 'state_conflict', 'resolver_rejected', 'closer_rejected', 'not_confirmed'].includes(code)) {
				throw new TypeError('No-fetch recovery failure code invalid');
			}
			return call('worker', 'SELECT cinatoken_gateway.fail_complete_text_no_fetch_recovery_v389($1::uuid,$2::uuid,$3::text) AS value',
				[claim.jobId, claim.leaseToken, code], row => {
					exact(row, ['status']);
					if (row.status !== 'retry_scheduled' && row.status !== 'quarantined' && row.status !== 'lease_lost') failShape();
					return { status: row.status };
				});
		},
	});
}

export type NoFetchRecoveryLimitsV389 = Readonly<{
	scanLimit: number; maxItems: number; admissionBudgetMs: number; leaseSeconds: number;
}>;
const DEFAULT_LIMITS: NoFetchRecoveryLimitsV389 = Object.freeze({
	scanLimit: 50, maxItems: 20, admissionBudgetMs: 25_000, leaseSeconds: 300,
});
export type NoFetchRecoveryRunResultV389 = Readonly<{
	enqueued: number; claimed: number; completed: number; retryScheduled: number; quarantined: number;
	stopReason: 'empty' | 'item_limit' | 'admission_budget' | 'lease_lost';
}>;
export type NoFetchRecoveryPortsV389 = Readonly<{
	/** Local verification seams; deployed composition uses the direct clients. */
	client?: NoFetchRecoveryClientV389;
	/** Trusted binding transport; clients still verify the actual origin LOGIN. */
	sqlFactory?: SqlFactory;
	resolve?: typeof confirmPostgresCompleteTextNoFetchV370;
	close?: typeof closePostgresCompleteTextNoFetchV388;
	monotonicMs?: () => number;
}>;

/**
 * Durable no-fetch recovery, not platform event delivery. The database owns
 * nonces, lease fencing, retry limits and terminal verification. An uncertain
 * COMMIT or LOGIN close stops the run without a second operation or fail ACK.
 * A later invocation resumes from the same durable job. The admission budget
 * stops new claims; it never races an in-flight financial transaction.
 */
export async function runPostgresCompleteTextNoFetchRecoveryV389(
	input: CompleteTextNoFetchRecoveryConnectionsV389,
	options: NoFetchRecoveryLimitsV389 = DEFAULT_LIMITS,
	ports: NoFetchRecoveryPortsV389 = {},
): Promise<NoFetchRecoveryRunResultV389> {
	const urls = connections(input);
	const limits = Object.freeze({ ...options });
	if (!integer(limits.scanLimit, 1, 50) || !integer(limits.maxItems, 1, 50)
		|| !integer(limits.admissionBudgetMs, 1, 60_000) || !integer(limits.leaseSeconds, 5, 300)) {
		throw new TypeError('No-fetch recovery bounds invalid');
	}
	const client = ports.client ?? createPostgresCompleteTextNoFetchRecoveryV389(urls, ports.sqlFactory);
	const resolve = ports.resolve ?? (params => confirmPostgresCompleteTextNoFetchV370(params, ports.sqlFactory));
	const close = ports.close ?? (params => closePostgresCompleteTextNoFetchV388(params, ports.sqlFactory));
	const now = ports.monotonicMs ?? (() => performance.now());
	const began = now();
	if (!Number.isFinite(began)) throw new TypeError('No-fetch recovery clock invalid');
	const scanned = acknowledged(await client.scan(limits.scanLimit));
	let claimed = 0, completed = 0, retryScheduled = 0, quarantined = 0;
	const result = (stopReason: NoFetchRecoveryRunResultV389['stopReason']) => Object.freeze({
		enqueued: scanned.enqueued, claimed, completed, retryScheduled, quarantined, stopReason,
	});
	while (claimed < limits.maxItems) {
		const elapsed = now() - began;
		if (!Number.isFinite(elapsed) || elapsed < 0) throw new TypeError('No-fetch recovery clock invalid');
		if (elapsed >= limits.admissionBudgetMs) return result('admission_budget');
		const next = acknowledged(await client.claim(limits.leaseSeconds));
		if (next.status === 'empty') return result('empty');
		// Strip client acknowledgement fields from the immutable database identity.
		const claim = claimRow(Object.fromEntries(Object.entries(next).filter(([key]) =>
			key !== 'commitAcknowledged' && key !== 'closeAcknowledged')));
		if (claim.status !== 'claimed') failShape();
		claimed++;
		let observed = acknowledged(await client.observe(claim));
		let refusal: NoFetchRecoveryFailureV389 = 'not_confirmed';
		if (observed.status === 'ready_to_resolve') {
			try {
				acknowledged(await resolve({ resolverConnectionString: urls.resolverConnectionString,
					grantId: claim.grantId, resolutionNonce: claim.resolutionNonce }));
			} catch (error) {
				if (!(error instanceof PostgresCompleteTextNoFetchRejectedError)) throw error;
				refusal = 'resolver_rejected';
			}
			// Adopt an already committed legal resolution, including a different
			// nonce from a pre-existing operator, only through the fresh observer.
			observed = acknowledged(await client.observe(claim));
		}
		if (observed.status === 'ready_to_close') {
			try {
				acknowledged(await close({ closerConnectionString: urls.closerConnectionString,
					requestId: claim.requestId, grantId: claim.grantId,
					resolutionId: observed.resolutionId!, decisionNonce: claim.decisionNonce }));
			} catch (error) {
				if (!(error instanceof PostgresCompleteTextNoFetchCloseRejectedError)) throw error;
				refusal = 'closer_rejected';
			}
			observed = acknowledged(await client.observe(claim));
		}
		if (observed.status === 'lease_lost') return result('lease_lost');
		if (observed.status === 'confirmed') {
			const finished = acknowledged(await client.finish(claim));
			if (finished.status === 'lease_lost') return result('lease_lost');
			if (finished.status === 'completed') {
				if (finished.terminalId !== observed.terminalId || finished.eventId !== observed.eventId) failShape();
				completed++; continue;
			}
			if (finished.status === 'quarantined') { quarantined++; continue; }
		}
		const failed = acknowledged(await client.fail(claim, observed.status === 'possible_send' ? 'possible_send'
			: observed.status === 'conflict' ? 'state_conflict' : refusal));
		if (failed.status === 'lease_lost') return result('lease_lost');
		if (failed.status === 'quarantined') quarantined++; else retryScheduled++;
	}
	return result('item_limit');
}
