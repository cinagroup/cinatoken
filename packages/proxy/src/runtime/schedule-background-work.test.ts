import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from 'hono';
import {
	drainNodeBackgroundWork,
	pendingNodeBackgroundWorkForTests,
	scheduleBackgroundWork,
} from './schedule-background-work';

test('Workers background work is registered with waitUntil', async () => {
	const registered: Promise<unknown>[] = [];
	const task = Promise.resolve('done');
	const context = {
		executionCtx: {
			waitUntil(value: Promise<unknown>) {
				registered.push(value);
			},
		},
	} as unknown as Context;

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
		get executionCtx(): never {
			throw new Error('No execution context');
		},
	} as unknown as Context;

	scheduleBackgroundWork(context, task);
	assert.equal(pendingNodeBackgroundWorkForTests(), 1);
	resolve();
	await drainNodeBackgroundWork();
	assert.equal(pendingNodeBackgroundWorkForTests(), 0);
});
