import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { capacityResponseBody } from './capacity-response-body';
import { createRequestCapacityPool, retainCapacityUntilSettled } from './request-capacity';

function fixture(source: ReadableStream<Uint8Array>, controller = new AbortController()) {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 10 });
	const lease = pool.tryAcquire(10)!;
	const tasks: Promise<void>[] = [];
	const body = capacityResponseBody(source, lease, controller.signal, (task) => {
		tasks.push(retainCapacityUntilSettled(lease, task));
	});
	lease.release();
	return { pool, body, controller, tasks };
}

test('no eager pull or tee; forwards identical chunks; returns capacity only at observed EOF', async () => {
	let pulls = 0;
	const bytes = new Uint8Array([1, 2, 3]);
	const source = new ReadableStream<Uint8Array>({ pull(c) { if (++pulls === 1) c.enqueue(bytes); else c.close(); } }, { highWaterMark: 0 });
	const { pool, body, controller } = fixture(source);
	await Promise.resolve();
	assert.equal(pulls, 0);
	const reader = body.getReader();
	assert.equal((await reader.read()).value, bytes);
	assert.equal(pool.snapshot().requests, 1);
	assert.equal((await reader.read()).done, true);
	assert.equal(pool.snapshot().requests, 0);
	assert.equal(source.locked, false);
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
	reader.releaseLock();
});

test('source read error is sanitized and releases reader and reservation', async () => {
	const source = new ReadableStream<Uint8Array>({ pull() { throw new Error('synthetic-private'); } }, { highWaterMark: 0 });
	const { pool, body, controller } = fixture(source);
	await assert.rejects(body.getReader().read(), /Gateway response delivery failed/);
	assert.equal(pool.snapshot().requests, 0);
	assert.equal(source.locked, false);
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const aborted of [false, true]) {
	for (const rejects of [false, true]) test(`${aborted ? 'abort' : 'cancel'} returns promptly, retaining capacity through ${rejects ? 'rejected' : 'resolved'} cleanup`, async () => {
		let settle!: () => void;
		let cancels = 0;
		const cleanup = new Promise<void>((resolve, reject) => { settle = rejects ? () => reject(new Error('synthetic-private')) : resolve; });
		const source = new ReadableStream<Uint8Array>({ cancel(reason) {
			cancels++;
			assert.equal(reason.message, 'Gateway response delivery stopped');
			return cleanup;
		} }, { highWaterMark: 0 });
		const { pool, body, controller, tasks } = fixture(source);
		const reader = body.getReader();
		const reading = reader.read();
		if (aborted) { controller.abort(new Error('client-private')); await assert.rejects(reading, /Gateway response delivery stopped/); }
		else { await reader.cancel('client-private'); assert.equal((await reading).done, true); }
		assert.equal(pool.snapshot().requests, 1);
		assert.equal(pool.tryAcquire(1), null);
		assert.equal(cancels, 1);
		assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
		settle();
		await Promise.all(tasks);
		assert.equal(pool.snapshot().requests, 0);
		assert.equal(source.locked, false);
	});
}

test('an already-aborted request cancels an unread source without pulling', async () => {
	const controller = new AbortController();
	controller.abort();
	let pulls = 0, cancels = 0;
	const source = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel() { cancels++; } }, { highWaterMark: 0 });
	const { body, pool, tasks } = fixture(source, controller);
	await assert.rejects(body.getReader().read(), /delivery stopped/);
	await Promise.all(tasks);
	assert.equal(pulls, 0);
	assert.equal(cancels, 1);
	assert.equal(pool.snapshot().requests, 0);
});

test('locked source acquisition failure does not leak an extra owner', () => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 10 });
	const lease = pool.tryAcquire(10)!;
	const source = new ReadableStream<Uint8Array>();
	const reader = source.getReader();
	assert.throws(() => capacityResponseBody(source, lease, new AbortController().signal, () => {}), TypeError);
	lease.release(); reader.releaseLock();
	assert.equal(pool.snapshot().requests, 0);
});
