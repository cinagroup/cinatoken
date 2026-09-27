import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestCapacityPool } from '../services/request-capacity';
import {
	drainNodeBackgroundWork,
	pendingNodeBackgroundWorkForTests,
	scheduleBackgroundWork,
} from './schedule-background-work';

test('Workers background work is registered with waitUntil', async () => {
	const registered: Promise<unknown>[] = [];
	const task = Promise.resolve('done');
	const context = {
		get: () => undefined,
		executionCtx: {
			props: {}, passThroughOnException() {},
			waitUntil(value: Promise<unknown>) {
				registered.push(value);
			},
		},
	};

	scheduleBackgroundWork(context, task);
	assert.deepEqual(registered, [task]);
	assert.equal(pendingNodeBackgroundWorkForTests(), 0);
	await task;
});

test('Node fallback retains background work until it settles and can drain it', async () => {
	let resolve!: () => void;
	const task = new Promise<void>((done) => {
		resolve = done;
	});
	const context = {
		get: () => undefined,
		get executionCtx(): never { throw new Error('No execution context'); },
	};

	scheduleBackgroundWork(context, task);
	assert.equal(pendingNodeBackgroundWorkForTests(), 1);
	resolve();
	await drainNodeBackgroundWork();
	assert.equal(pendingNodeBackgroundWorkForTests(), 0);
});

for (const runtime of ['worker', 'node', 'throwing-waitUntil'] as const) {
	for (const rejects of [false, true]) test(`${runtime} retains capacity until background ${rejects ? 'rejection' : 'completion'}`, async () => {
		const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 10 });
		const lease = pool.tryAcquire(10)!;
		let settle!: () => void;
		const task = new Promise<void>((resolve, reject) => { settle = rejects ? () => reject(new Error('synthetic')) : resolve; });
		const registered: Promise<unknown>[] = [];
		const context = {
			get: () => lease,
			get executionCtx() {
				if (runtime === 'node') throw new Error('No execution context');
				return { waitUntil(value: Promise<unknown>) {
					if (runtime === 'throwing-waitUntil') throw new Error('No waitUntil');
					registered.push(value);
				} };
			},
		};
		scheduleBackgroundWork(context, task);
		lease.release();
		assert.equal(pool.tryAcquire(1), null);
		const observed = Promise.allSettled(registered);
		settle();
		await observed;
		await drainNodeBackgroundWork();
		assert.equal(pool.snapshot().reservedBytes, 0);
		assert.equal(pool.snapshot().requests, 0);
		assert.equal(pendingNodeBackgroundWorkForTests(), 0);
	});
}
