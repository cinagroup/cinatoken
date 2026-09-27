import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'hono';
import type { StorageContext } from '@octafuse/core';
import type { PostgresDatabaseClient } from '../../../core/src/storage/database-client';
import type { Env, GatewayBindings } from '../app';
import {
	openWorkerPostgresImageRecoveryOwner,
	PostgresImageProducerCleanupUnconfirmedError,
} from './worker-postgres-image-producer-owner';

const runtime = 'postgres://cinatoken_gateway_runtime:runtime-secret@db.example/gateway';
const dispatch = 'postgres://cinatoken_gateway_dispatch_producer:dispatch-secret@db.example/gateway';
const fact = 'postgres://cinatoken_gateway_fact_producer:fact-secret@db.example/gateway';

function input(overrides: Partial<GatewayBindings> = {}, driver: 'postgres' | 'd1' = 'postgres', runtimeRole = 'cinatoken_gateway_runtime') {
	const bindings: GatewayBindings = {
		DATABASE_DRIVER: 'postgres',
		HYPERDRIVE: { connectionString: runtime },
		DISPATCH_HYPERDRIVE: { connectionString: dispatch },
		FACT_HYPERDRIVE: { connectionString: fact },
		...overrides,
	};
	return {
		context: { env: bindings } as Context<Env>,
		storage: { client: { driver, raw: { unsafe: async () => [
			{ current_role: runtimeRole, session_role: runtimeRole },
		] } } } as StorageContext,
	};
}

function roleForUrl(url: string): string {
	return url === dispatch ? 'cinatoken_gateway_dispatch_producer' : 'cinatoken_gateway_fact_producer';
}

function fakeSql(end: () => unknown = async () => {}, role = 'cinatoken_gateway_dispatch_producer'): PostgresDatabaseClient['raw'] {
	return {
		unsafe: async (query: string) => {
			assert.equal(query, 'SELECT current_user AS current_role, session_user AS session_role');
			return [{ current_role: role, session_role: role }];
		},
		end,
	} as unknown as PostgresDatabaseClient['raw'];
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

test('explicit Worker owner creates raw, single-connection producer clients only', async () => {
	const created: Array<{ url: string; max: number }> = [];
	const closed: string[] = [];
	const { context, storage } = input();
	const owner = await openWorkerPostgresImageRecoveryOwner(
		context, storage,
		(url, options) => {
			created.push({ url, max: options.max });
			return fakeSql(async () => { closed.push(url); }, roleForUrl(url));
		},
	);
	assert.deepEqual(created, [{ url: dispatch, max: 1 }, { url: fact, max: 1 }]);
	assert.equal(owner.authorities.claimProducer.driver, 'postgres');
	assert.equal(owner.authorities.factProducer.driver, 'postgres');
	assert.notEqual(owner.authorities.claimProducer.raw, owner.authorities.factProducer.raw);
	await Promise.all([owner.close(), owner.close()]);
	assert.deepEqual(closed, [dispatch, fact]);
});

test('missing, shared, and malformed bindings fail before a client is created', async () => {
	const invalid: Array<[string, Partial<GatewayBindings>, RegExp]> = [
		['missing runtime', { HYPERDRIVE: undefined }, /HYPERDRIVE connection string required/],
		['missing dispatch', { DISPATCH_HYPERDRIVE: undefined }, /DISPATCH_HYPERDRIVE connection string required/],
		['missing fact', { FACT_HYPERDRIVE: undefined }, /FACT_HYPERDRIVE connection string required/],
		['shared runtime and dispatch', { DISPATCH_HYPERDRIVE: { connectionString: runtime } }, /must be distinct/],
		['shared producer origin', { FACT_HYPERDRIVE: { connectionString: dispatch } }, /must be distinct/],
		['wrong scheme', { FACT_HYPERDRIVE: { connectionString: fact.replace('postgres:', 'mysql:') } }, /Invalid.*FACT_HYPERDRIVE/],
		['missing password', { DISPATCH_HYPERDRIVE: { connectionString: dispatch.replace(':dispatch-secret@', '@') } }, /Invalid.*DISPATCH_HYPERDRIVE/],
		['missing database', { HYPERDRIVE: { connectionString: runtime.replace('/gateway', '/') } }, /Invalid.*HYPERDRIVE/],
		['query override', { FACT_HYPERDRIVE: { connectionString: `${fact}?user=cinatoken_gateway_runtime` } }, /Invalid.*FACT_HYPERDRIVE/],
		['duplicate sslmode', { FACT_HYPERDRIVE: { connectionString: `${fact}?sslmode=disable&sslmode=require` } }, /Invalid.*FACT_HYPERDRIVE/],
		['fragment', { FACT_HYPERDRIVE: { connectionString: `${fact}#role=runtime` } }, /Invalid.*FACT_HYPERDRIVE/],
	];
	for (const [name, overrides, error] of invalid) {
		let creations = 0;
		const { context, storage } = input(overrides);
		await assert.rejects(
			openWorkerPostgresImageRecoveryOwner(context, storage, () => {
				creations += 1;
				return fakeSql();
			}),
			error,
			name,
		);
		assert.equal(creations, 0, name);
	}
	for (const { context, storage } of [
		input({ DATABASE_DRIVER: 'd1' }),
		input({}, 'd1'),
	]) {
		let creations = 0;
		await assert.rejects(openWorkerPostgresImageRecoveryOwner(context, storage, () => {
			creations += 1;
			return fakeSql();
		}), /requires PostgreSQL Worker storage/);
		assert.equal(creations, 0);
	}
	let creations = 0;
	const wrongRuntime = input({}, 'postgres', 'cinatoken_gateway_fact_producer');
	await assert.rejects(openWorkerPostgresImageRecoveryOwner(
		wrongRuntime.context, wrongRuntime.storage, () => {
			creations += 1;
			return fakeSql();
		},
	), /runtime LOGIN role mismatch/);
	assert.equal(creations, 0);
});

test('synthetic Hyperdrive proxy credentials and sslmode are accepted only after SQL role proof', async () => {
	const synthetic = input({
		HYPERDRIVE: { connectionString: 'postgresql://proxy-runtime:opaque@a.hyperdrive.local/config-a?sslmode=disable' },
		DISPATCH_HYPERDRIVE: { connectionString: 'postgresql://proxy-dispatch:opaque@b.hyperdrive.local/config-b?sslmode=disable' },
		FACT_HYPERDRIVE: { connectionString: 'postgresql://proxy-fact:opaque@c.hyperdrive.local/config-c?sslmode=require' },
	});
	const created: string[] = [];
	const owner = await openWorkerPostgresImageRecoveryOwner(synthetic.context, synthetic.storage, url => {
		created.push(url);
		return fakeSql(undefined, created.length === 1
			? 'cinatoken_gateway_dispatch_producer' : 'cinatoken_gateway_fact_producer');
	});
	assert.equal(created.length, 2);
	await owner.close();
});

test('crossed producer origins fail SQL role preflight and close both clients', async () => {
	const { context, storage } = input({
		DISPATCH_HYPERDRIVE: { connectionString: fact },
		FACT_HYPERDRIVE: { connectionString: dispatch },
	});
	const created: string[] = [];
	const closed: string[] = [];
	await assert.rejects(openWorkerPostgresImageRecoveryOwner(context, storage, url => {
		created.push(url);
		return fakeSql(async () => { closed.push(url); }, roleForUrl(url));
	}), /dispatch_producer LOGIN role mismatch/);
	assert.deepEqual(created, [fact, dispatch]);
	assert.deepEqual(closed, [fact, dispatch]);

	await assert.rejects(openWorkerPostgresImageRecoveryOwner(context, storage, url => {
		return fakeSql(() => url === fact
			? Promise.reject(new Error('hidden cleanup failure')) : Promise.resolve(), roleForUrl(url));
	}), PostgresImageProducerCleanupUnconfirmedError);
});

test('close waits for both origin confirmations and remains idempotent', async () => {
	const dispatchClose = deferred();
	const factClose = deferred();
	const calls: string[] = [];
	const { context, storage } = input();
	const owner = await openWorkerPostgresImageRecoveryOwner(context, storage, (url, options) => {
		assert.equal(options.max, 1);
		return fakeSql(() => {
			calls.push(url);
			return url === dispatch ? dispatchClose.promise : factClose.promise;
		}, roleForUrl(url));
	});
	let finished = false;
	const pending = owner.close().then(() => { finished = true; });
	assert.deepEqual(calls, [dispatch, fact]);
	dispatchClose.resolve();
	await Promise.resolve();
	assert.equal(finished, false);
	factClose.resolve();
	await pending;
	assert.equal(finished, true);
	await owner.close();
	assert.deepEqual(calls, [dispatch, fact]);
});

test('one unconfirmed close rejects after attempting both origins', async () => {
	const factClose = deferred();
	const calls: string[] = [];
	const { context, storage } = input();
	const owner = await openWorkerPostgresImageRecoveryOwner(context, storage, (url) => fakeSql(() => {
		calls.push(url);
		if (url === dispatch) return Promise.reject(new Error('hidden dispatch failure'));
		return factClose.promise;
	}, roleForUrl(url)));
	const pending = owner.close();
	assert.deepEqual(calls, [dispatch, fact]);
	factClose.resolve();
	await assert.rejects(pending, PostgresImageProducerCleanupUnconfirmedError);
	await assert.rejects(owner.close(), PostgresImageProducerCleanupUnconfirmedError);
	assert.deepEqual(calls, [dispatch, fact]);
});

test('a non-promise close result is unconfirmed even when the other origin closes', async () => {
	const calls: string[] = [];
	const { context, storage } = input();
	const owner = await openWorkerPostgresImageRecoveryOwner(context, storage, url => fakeSql(() => {
		calls.push(url);
		return url === dispatch ? undefined : Promise.resolve();
	}, roleForUrl(url)));
	await assert.rejects(owner.close(), PostgresImageProducerCleanupUnconfirmedError);
	assert.deepEqual(calls, [dispatch, fact]);
});

test('fact client creation failure confirms dispatch cleanup before failing', async () => {
	const dispatchClose = deferred();
	const closeStarted = deferred();
	const calls: string[] = [];
	const { context, storage } = input();
	let settled = false;
	const opening = openWorkerPostgresImageRecoveryOwner(context, storage, (url) => {
		if (url === fact) throw new Error('hidden fact failure');
		return fakeSql(() => {
			calls.push('dispatch close');
			closeStarted.resolve();
			return dispatchClose.promise;
		}, roleForUrl(url));
	}).finally(() => { settled = true; });
	await closeStarted.promise;
	assert.deepEqual(calls, ['dispatch close']);
	await Promise.resolve();
	assert.equal(settled, false);
	dispatchClose.resolve();
	await assert.rejects(opening, /fact producer open failed/);
	assert.equal(settled, true);

	await assert.rejects(openWorkerPostgresImageRecoveryOwner(context, storage, (url) => {
		if (url === fact) throw new Error('hidden fact failure');
		return fakeSql(() => Promise.reject(new Error('hidden cleanup failure')), roleForUrl(url));
	}), PostgresImageProducerCleanupUnconfirmedError);
});
