import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResourceCompletionGroup, type ResourceCompletionOutcome } from './resource-completion';
import { createRequestCapacityPool } from './request-capacity';
import { scheduleResourceCompletion, drainNodeResourceWork, pendingNodeResourceWorkForTests } from '../runtime/schedule-resource-completion';
import { scheduleBackgroundWork, drainNodeBackgroundWork } from '../runtime/schedule-background-work';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

test('resource group cannot finish before sealing or omit a pending member', async () => {
	const group = createResourceCompletionGroup();
	const first = deferred<ResourceCompletionOutcome>();
	const second = deferred<ResourceCompletionOutcome>();
	let finished = false; void group.completion.then(() => { finished = true; });
	group.track(first.promise); first.resolve('confirmed'); await flush();
	assert.equal(finished, false);
	group.track(second.promise); group.seal(); group.seal(); await flush();
	assert.equal(finished, false);
	second.resolve('confirmed'); assert.equal(await group.completion, 'confirmed');
	assert.throws(() => group.track(Promise.reject(Error('PRIVATE'))), /sealed/);
});

for (const mode of ['unconfirmed', 'reject'] as const) test(`resource group preserves ${mode} across later success`, async () => {
	const group = createResourceCompletionGroup();
	group.track(mode === 'reject' ? Promise.reject(Error('PRIVATE')) : Promise.resolve('unconfirmed'));
	group.track(Promise.resolve('confirmed')); group.seal();
	assert.equal(await group.completion, 'unconfirmed');
});

test('empty resource group confirms only its empty registered scope', async () => {
	const group = createResourceCompletionGroup(); group.seal();
	assert.equal(await group.completion, 'confirmed');
});

for (const runtime of ['worker', 'node', 'throwing-waitUntil'] as const) {
	for (const terminal of ['confirmed', 'unconfirmed', 'reject'] as const) {
		test(`resource scheduler ${runtime}/${terminal} is independent from accounting`, async t => {
			const warnings: unknown[][] = []; t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
			const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 10 });
			const lease = pool.tryAcquire(10)!; const gate = deferred<ResourceCompletionOutcome>();
			const registered: Promise<unknown>[] = [];
			const executionCtx = { waitUntil(this: unknown, task: Promise<unknown>) {
				assert.equal(this, executionCtx, 'retain native receiver');
				if (runtime === 'throwing-waitUntil') throw Error('no context'); registered.push(task);
			} };
			const context = { get: () => lease, get executionCtx() {
				if (runtime === 'node') throw Error('no context'); return executionCtx;
			} };
			scheduleResourceCompletion(context, gate.promise);
			scheduleBackgroundWork(context, Promise.resolve()); lease.release();
			await drainNodeBackgroundWork(); await flush();
			assert.equal(pool.snapshot().requests, 1, 'settled accounting cannot release pending cleanup');
			assert.equal(pool.tryAcquire(1), null);
			if (terminal === 'reject') gate.reject(Error('PRIVATE_CLEANUP_DETAIL')); else gate.resolve(terminal);
			await Promise.all(registered); await drainNodeResourceWork();
			assert.equal(pendingNodeResourceWorkForTests(), 0);
			assert.equal(pool.snapshot().requests, terminal === 'confirmed' ? 0 : 1);
			assert.equal(warnings.length, terminal === 'confirmed' ? 0 : 1);
			assert.equal(JSON.stringify(warnings).includes('PRIVATE'), false);
		});
	}
}

test('resource registration cannot resurrect an already returned capacity lease', async () => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	const lease = pool.tryAcquire(1)!; lease.release();
	assert.throws(() => scheduleResourceCompletion({ get: () => lease, executionCtx: { waitUntil() {} } }, Promise.reject(Error('PRIVATE'))), /returned/);
	await flush(); assert.equal(pool.snapshot().requests, 0);
});
