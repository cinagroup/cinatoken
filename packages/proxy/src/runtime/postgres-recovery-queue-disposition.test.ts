import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import type { PostgresRecoveryRunResult } from '../../../core/src/storage/recovery/run-usage-recovery-postgres';
import {
	createPostgresRecoveryQueueOwner,
	POSTGRES_RECOVERY_STAGING_QUEUE,
	POSTGRES_RECOVERY_WAKE_V1,
	type PostgresRecoveryQueueOutcome,
} from './postgres-recovery-queue-owner';
import {
	createPostgresRecoveryQueueDisposition,
	type DeclaredRecoveryQueueConsumer,
} from './postgres-recovery-queue-disposition';

const declaredConsumer: DeclaredRecoveryQueueConsumer = Object.freeze({
	queue: POSTGRES_RECOVERY_STAGING_QUEUE,
	deadLetterQueue: 'cinatoken-staging-postgres-recovery-dlq',
	maxBatchSize: 1,
	maxRetries: 3,
	baseRetryDelaySeconds: 10,
	maxRetryDelaySeconds: 60,
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

function batch(options: { attempts?: number; count?: number; queue?: string; body?: unknown; retryThrows?: boolean } = {}) {
	const calls = { ack: 0, ackAll: 0, retry: 0, retryAll: [] as (number | null)[] };
	const messages = Array.from({ length: options.count ?? 1 }, (_, index) => ({
		id: `wake-${index}`, timestamp: new Date(0), attempts: options.attempts ?? 1,
		body: options.body ?? POSTGRES_RECOVERY_WAKE_V1,
		ack() { calls.ack++; }, retry() { calls.retry++; },
	}));
	const value = {
		queue: options.queue ?? POSTGRES_RECOVERY_STAGING_QUEUE,
		messages,
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		ackAll() { calls.ackAll++; },
		retryAll(input?: { delaySeconds?: number }) {
			if (options.retryThrows) throw new Error('retry marker failed');
			calls.retryAll.push(input?.delaySeconds ?? null);
		},
	} as MessageBatch<unknown>;
	return { value, calls };
}

function context(): Pick<ExecutionContext, 'waitUntil'> {
	return { waitUntil(promise) { void promise; } };
}

function owner(status: PostgresRecoveryQueueOutcome['status'] = 'run_drained') {
	let calls = 0;
	return {
		get calls() { return calls; },
		async queue(): Promise<PostgresRecoveryQueueOutcome> {
			calls++;
			if (status === 'run_drained' || status === 'bounded_incomplete') return {
				status, result: { scanned: 0, claimed: 0, committed: 0 }, physicalClose: 'not_observed',
			};
			if (status === 'outcome_unknown' || status === 'deadline_expired' || status === 'clock_invalid')
				return { status, physicalClose: 'not_observed' };
			return { status } as PostgresRecoveryQueueOutcome;
		},
	};
}

function assertNoAck(calls: ReturnType<typeof batch>['calls']) {
	assert.equal(calls.ack, 0);
	assert.equal(calls.ackAll, 0);
	assert.equal(calls.retry, 0);
}

test('default-disabled candidate still explicitly retries before a normal return and starts no owner work', async () => {
	const run = owner();
	const delivery = batch();
	const disposition = createPostgresRecoveryQueueDisposition({ owner: run });
	assert.deepEqual(await disposition.queue(delivery.value, {}, context()), {
		ownerStatus: 'disabled', disposition: 'retry_requested', atDeclaredRetryLimit: false,
	});
	assert.equal(run.calls, 0);
	assert.deepEqual(delivery.calls.retryAll, [null]);
	assertNoAck(delivery.calls);
});

test('enabled candidate requires a bounded declaration including a distinct DLQ; declaration is not a host proof', () => {
	const run = owner();
	assert.throws(() => createPostgresRecoveryQueueDisposition({ enabled: true, owner: run }));
	for (const override of [
		{ deadLetterQueue: POSTGRES_RECOVERY_STAGING_QUEUE },
		{ maxBatchSize: 10 },
		{ maxRetries: 0 },
		{ maxRetryDelaySeconds: 0 },
	]) assert.throws(() => createPostgresRecoveryQueueDisposition({
		enabled: true, owner: run, declaredConsumer: { ...declaredConsumer, ...override } as DeclaredRecoveryQueueConsumer,
	}));
});

test('every owner diagnostic, including run_drained, requests retry and never ACKs', async () => {
	const statuses: PostgresRecoveryQueueOutcome['status'][] = [
		'disabled', 'invalid_wake', 'busy', 'capacity_quarantined', 'host_rejected',
		'deadline_expired', 'clock_invalid', 'run_drained', 'bounded_incomplete', 'outcome_unknown',
	];
	for (const status of statuses) {
		const run = owner(status);
		const delivery = batch({ attempts: 2 });
		const disposition = createPostgresRecoveryQueueDisposition({ enabled: true, owner: run, declaredConsumer });
		const result = await disposition.queue(delivery.value, {}, context());
		assert.equal(result.ownerStatus, status);
		assert.equal(result.disposition, 'retry_requested');
		assert.equal(run.calls, 1);
		assert.deepEqual(delivery.calls.retryAll, [20]);
		assertNoAck(delivery.calls);
	}
});

test('main Queue Promise waits for the original owner completion before retrying', async () => {
	const completion = deferred<PostgresRecoveryQueueOutcome>();
	let started = false;
	const delivery = batch();
	const disposition = createPostgresRecoveryQueueDisposition({
		enabled: true, declaredConsumer,
		owner: { queue() { started = true; return completion.promise; } },
	});
	let settled = false;
	const task = disposition.queue(delivery.value, {}, context()).then(result => { settled = true; return result; });
	await Promise.resolve();
	assert.equal(started, true);
	assert.equal(settled, false);
	assert.deepEqual(delivery.calls.retryAll, []);
	completion.resolve({ status: 'run_drained', result: { scanned: 1, claimed: 1, committed: 1 }, physicalClose: 'not_observed' });
	assert.equal((await task).ownerStatus, 'run_drained');
	assert.deepEqual(delivery.calls.retryAll, [10]);
	assertNoAck(delivery.calls);
});

test('owner rejection and invalid/multi-message batches retry without implicit ACK or unsafe work', async () => {
	let calls = 0;
	const disposition = createPostgresRecoveryQueueDisposition({
		enabled: true, declaredConsumer,
		owner: { async queue() { calls++; throw new Error('confidential database error'); } },
	});
	for (const options of [{}, { count: 2 }, { queue: 'other-queue' }, { attempts: 9 }]) {
		const delivery = batch(options);
		const result = await disposition.queue(delivery.value, {}, context());
		assert.equal(result.ownerStatus, Object.keys(options).length === 0 ? 'owner_threw' : 'invalid_batch');
		assert.equal(result.disposition, 'retry_requested');
		assert.equal(delivery.calls.retryAll.length, 1);
		assertNoAck(delivery.calls);
	}
	assert.equal(calls, 1);
});

test('owner cannot mark the real message or batch ACK before the outer retry request', async () => {
	const delivery = batch();
	const disposition = createPostgresRecoveryQueueDisposition({
		enabled: true, declaredConsumer,
		owner: {
			async queue(observedBatch) {
				assert.notEqual(observedBatch, delivery.value);
				assert.throws(() => observedBatch.messages[0].ack(), /disposition is owned/);
				assert.throws(() => observedBatch.ackAll(), /disposition is owned/);
				assert.throws(() => observedBatch.retryAll(), /disposition is owned/);
				return { status: 'run_drained', result: { scanned: 0, claimed: 0, committed: 0 },
					physicalClose: 'not_observed' };
			},
		},
	});
	assert.equal((await disposition.queue(delivery.value, {}, context())).ownerStatus, 'run_drained');
	assert.deepEqual(delivery.calls.retryAll, [10]);
	assertNoAck(delivery.calls);
});

test('declared retry limit is diagnostic: final retry still relies on actual host DLQ configuration', async () => {
	const run = owner('busy');
	const delivery = batch({ attempts: declaredConsumer.maxRetries + 1 });
	const disposition = createPostgresRecoveryQueueDisposition({ enabled: true, owner: run, declaredConsumer });
	assert.deepEqual(await disposition.queue(delivery.value, {}, context()), {
		ownerStatus: 'busy', disposition: 'retry_requested', atDeclaredRetryLimit: true,
	});
	assert.deepEqual(delivery.calls.retryAll, [60]);
	assertNoAck(delivery.calls);
});

test('retry marker failure rejects the main Queue Promise instead of returning implicit ACK', async () => {
	const delivery = batch({ retryThrows: true });
	const disposition = createPostgresRecoveryQueueDisposition({ enabled: true, owner: owner(), declaredConsumer });
	await assert.rejects(disposition.queue(delivery.value, {}, context()),
		/PostgreSQL recovery Queue retry disposition failed/);
	assertNoAck(delivery.calls);
});

function drainedRun(): PostgresRecoveryRunResult {
	return {
		discovered: 0, registered: 0, scanned: 0, claimed: 0, committed: 0,
		blocked: 0, deferred: 0, lostOwnership: 0, uncertain: 0, skipped: 0,
		leasesLeftForExpiry: 0, retainedHolds: 0,
		capacityLimited: false, admissionStopped: false, stopReason: null, resources: 'confirmed',
	};
}

test('redelivered V1 wake can start another run: run_drained is not a durable per-wake receipt', async () => {
	let starts = 0;
	const run = createPostgresRecoveryQueueOwner({
		enabled: true, invocationBudgetMs: 60_000,
		openClient() { return {}; },
		startRun() { starts++; return { completion: Promise.resolve(drainedRun()) }; },
		retireClient() {},
	});
	const disposition = createPostgresRecoveryQueueDisposition({ enabled: true, owner: run, declaredConsumer });
	const first = batch();
	const second = batch({ attempts: 2 });
	assert.equal((await disposition.queue(first.value, {}, context())).ownerStatus, 'run_drained');
	assert.equal((await disposition.queue(second.value, {}, context())).ownerStatus, 'run_drained');
	assert.equal(starts, 2);
	assert.deepEqual(first.calls.retryAll, [10]);
	assert.deepEqual(second.calls.retryAll, [20]);
	assertNoAck(first.calls);
	assertNoAck(second.calls);
});

test('unknown real owner result preserves its local quarantine across a retry', async () => {
	let starts = 0;
	const run = createPostgresRecoveryQueueOwner({
		enabled: true, invocationBudgetMs: 60_000,
		openClient() { return {}; },
		startRun() { starts++; return { completion: Promise.resolve({ ...drainedRun(), resources: 'unconfirmed' as const }) }; },
		retireClient() {},
	});
	const disposition = createPostgresRecoveryQueueDisposition({ enabled: true, owner: run, declaredConsumer });
	const first = batch();
	const second = batch({ attempts: 2 });
	assert.equal((await disposition.queue(first.value, {}, context())).ownerStatus, 'outcome_unknown');
	assert.equal((await disposition.queue(second.value, {}, context())).ownerStatus, 'capacity_quarantined');
	assert.equal(starts, 1);
	assertNoAck(first.calls);
	assertNoAck(second.calls);
});
