import postgres from 'postgres';
import type { Context } from 'hono';
import type { StorageContext } from '@octafuse/core';
import type { PostgresDatabaseClient } from '../../../core/src/storage/database-client';
import type { Env, PostgresImageRecoveryAppOptions } from '../app';

type ProducerSql = PostgresDatabaseClient['raw'];
type ProducerFactory = (connectionString: string, options: { max: 1 }) => ProducerSql;
type ProducerOwner = Awaited<ReturnType<PostgresImageRecoveryAppOptions['open']>>;

const EXPECTED_USERS = {
	HYPERDRIVE: 'cinatoken_gateway_runtime',
	DISPATCH_HYPERDRIVE: 'cinatoken_gateway_dispatch_producer',
	FACT_HYPERDRIVE: 'cinatoken_gateway_fact_producer',
} as const;

export class PostgresImageProducerCleanupUnconfirmedError extends Error {
	constructor() {
		super('PostgreSQL Images producer cleanup was not confirmed');
		this.name = 'PostgresImageProducerCleanupUnconfirmedError';
	}
}

function connectionString(binding: unknown, name: keyof typeof EXPECTED_USERS): string {
	const value = binding && typeof binding === 'object'
		? (binding as { connectionString?: unknown }).connectionString : undefined;
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
		throw new TypeError(`PostgreSQL Images ${name} connection string required`);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError(`Invalid PostgreSQL Images ${name} connection string`);
	}
	const query = [...url.searchParams];
	const validSslMode = query.length === 0 || (query.length === 1
		&& query[0][0].toLowerCase() === 'sslmode'
		&& (query[0][1] === 'disable' || query[0][1] === 'require'));
	if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
		|| !url.hostname || !url.username || !url.password
		|| !url.pathname || url.pathname === '/' || !validSslMode || url.hash) {
		throw new TypeError(`Invalid PostgreSQL Images ${name} connection string`);
	}
	return value;
}

async function requireLogin(sql: Pick<ProducerSql, 'unsafe'>, expected: string): Promise<void> {
	let rows: unknown;
	try {
		rows = await sql.unsafe('SELECT current_user AS current_role, session_user AS session_role');
	} catch {
		throw new Error(`PostgreSQL Images ${expected} LOGIN preflight failed`);
	}
	if (!Array.isArray(rows) || rows.length !== 1
		|| rows[0]?.current_role !== expected || rows[0]?.session_role !== expected) {
		throw new Error(`PostgreSQL Images ${expected} LOGIN role mismatch`);
	}
}

async function confirmedClose(sql: ProducerSql): Promise<void> {
	const completion = sql.end({ timeout: 1 });
	if (!completion || typeof completion.then !== 'function') {
		throw new PostgresImageProducerCleanupUnconfirmedError();
	}
	await completion;
}

async function closeBoth(dispatch: ProducerSql, fact: ProducerSql): Promise<void> {
	const outcomes = await Promise.allSettled([confirmedClose(dispatch), confirmedClose(fact)]);
	if (outcomes.some(outcome => outcome.status === 'rejected')) {
		throw new PostgresImageProducerCleanupUnconfirmedError();
	}
}

/**
 * Explicit review-only Worker owner opener. No default runtime path calls this.
 * Hyperdrive URL credentials may authenticate only to its proxy; actual
 * session_user/current_user checks occur on all three PostgreSQL sessions.
 * The factory repeats producer checks within every statement transaction.
 */
export async function openWorkerPostgresImageRecoveryOwner(
	context: Context<Env>, storage: StorageContext,
	createSql: ProducerFactory = postgres,
): Promise<ProducerOwner> {
	const bindings = context.env;
	if (bindings.DATABASE_DRIVER !== 'postgres' || storage.client.driver !== 'postgres') {
		throw new TypeError('PostgreSQL Images producer owner requires PostgreSQL Worker storage');
	}
	const runtime = connectionString(bindings.HYPERDRIVE, 'HYPERDRIVE');
	const dispatch = connectionString(bindings.DISPATCH_HYPERDRIVE, 'DISPATCH_HYPERDRIVE');
	const fact = connectionString(bindings.FACT_HYPERDRIVE, 'FACT_HYPERDRIVE');
	if (new Set([runtime, dispatch, fact]).size !== 3
		|| new Set([bindings.HYPERDRIVE, bindings.DISPATCH_HYPERDRIVE, bindings.FACT_HYPERDRIVE]).size !== 3) {
		throw new TypeError('PostgreSQL Images Hyperdrive bindings must be distinct');
	}
	await requireLogin(storage.client.raw, EXPECTED_USERS.HYPERDRIVE);

	let claimSql: ProducerSql;
	try {
		claimSql = createSql(dispatch, { max: 1 });
	} catch {
		throw new Error('PostgreSQL Images dispatch producer open failed');
	}
	let factSql: ProducerSql;
	try {
		factSql = createSql(fact, { max: 1 });
	} catch {
		try {
			await confirmedClose(claimSql);
		} catch {
			throw new PostgresImageProducerCleanupUnconfirmedError();
		}
		throw new Error('PostgreSQL Images fact producer open failed');
	}
	try {
		await requireLogin(claimSql, EXPECTED_USERS.DISPATCH_HYPERDRIVE);
		await requireLogin(factSql, EXPECTED_USERS.FACT_HYPERDRIVE);
	} catch (error) {
		await closeBoth(claimSql, factSql);
		throw error;
	}
	let closing: Promise<void> | undefined;
	return {
		authorities: {
			claimProducer: { driver: 'postgres', raw: claimSql },
			factProducer: { driver: 'postgres', raw: factSql },
		},
		close() {
			closing ??= closeBoth(claimSql, factSql);
			return closing;
		},
	};
}
