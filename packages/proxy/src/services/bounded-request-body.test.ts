import assert from 'node:assert/strict';
import { it } from 'node:test';
import { boundRequestBody, RequestBodyTooLargeError } from './bounded-request-body';
import { createRequestDeadline, RequestExecutionStoppedError } from './request-deadline';

it('pulls on demand, preserves exact-limit bytes and leaves the deadline live after upload EOF', async (t) => {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
	const deadline = createRequestDeadline(100);
	t.after(() => deadline.dispose());
	let reads = 0;
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		reads++;
		c.enqueue(new Uint8Array([1, 2, 3]));
		c.close();
	} }, { highWaterMark: 0 });
	const guarded = boundRequestBody(source, deadline, 3);
	await Promise.resolve();
	assert.equal(reads, 0);
	assert.deepEqual(new Uint8Array(await new Response(guarded.body).arrayBuffer()), new Uint8Array([1, 2, 3]));
	assert.equal(source.locked, false);
	assert.equal(deadline.signal.aborted, false);
	t.mock.timers.tick(100);
	assert.equal(deadline.signal.aborted, true, 'upload EOF must not turn off the request timer');
});

it('rejects actual oversize and releases its reader without waiting for cancellation ACK', async (t) => {
	const deadline = createRequestDeadline(Date.now() + 1000);
	t.after(() => deadline.dispose());
	let cancelled = 0;
	const source = new ReadableStream<Uint8Array>({
		pull(c) { c.enqueue(new Uint8Array(4)); },
		cancel() { cancelled++; return new Promise<void>(() => {}); },
	}, { highWaterMark: 0 });
	const guarded = boundRequestBody(source, deadline, 3);
	await assert.rejects(new Response(guarded.body).text(), RequestBodyTooLargeError);
	assert.equal(cancelled, 1);
	assert.equal(source.locked, false);
	assert.equal(deadline.signal.aborted, false, 'size rejection is not a client cancellation');
});

for (const reason of ['deadline', 'client'] as const) {
	it(`interrupts a hanging upload on ${reason}, with bounded cancellation cleanup`, async (t) => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
		const parent = new AbortController();
		const deadline = createRequestDeadline(100, parent.signal);
		t.after(() => deadline.dispose());
		let cancelled = 0;
		const source = new ReadableStream<Uint8Array>({
			pull() { return new Promise<void>(() => {}); },
			cancel() { cancelled++; return new Promise<void>(() => {}); },
		}, { highWaterMark: 0 });
		const guarded = boundRequestBody(source, deadline);
		const assertion = assert.rejects(new Response(guarded.body).text(), (error: unknown) => {
			assert.ok(error instanceof RequestExecutionStoppedError);
			assert.equal(error.reason, reason === 'deadline' ? 'deadline_exceeded' : 'client_cancelled');
			return true;
		});
		await Promise.resolve();
		if (reason === 'deadline') t.mock.timers.tick(100);
		else parent.abort('private client cancellation detail');
		await assertion;
		assert.equal(cancelled, 1);
		assert.equal(source.locked, false);
	});
}

it('disposes an unread upload without pulling it or stopping the request deadline', async (t) => {
	const deadline = createRequestDeadline(Date.now() + 1000);
	t.after(() => deadline.dispose());
	let pulls = 0;
	let cancels = 0;
	const source = new ReadableStream<Uint8Array>({
		pull() { pulls++; }, cancel() { cancels++; },
	}, { highWaterMark: 0 });
	const guarded = boundRequestBody(source, deadline);
	guarded.dispose();
	guarded.dispose();
	await assert.rejects(new Response(guarded.body).text(), /no longer needed/);
	assert.equal(pulls, 0);
	assert.equal(cancels, 1);
	assert.equal(source.locked, false);
	assert.equal(deadline.signal.aborted, false);
});

it('retains the original upload failure and cleans up its reader', async (t) => {
	const deadline = createRequestDeadline(Date.now() + 1000);
	t.after(() => deadline.dispose());
	const error = new Error('synthetic upload disconnect');
	const source = new ReadableStream<Uint8Array>({ pull() { throw error; } });
	const guarded = boundRequestBody(source, deadline);
	await assert.rejects(new Response(guarded.body).text(), (received) => received === error);
	assert.equal(source.locked, false);
});
