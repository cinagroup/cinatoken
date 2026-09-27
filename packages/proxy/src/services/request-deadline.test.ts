import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRequestDeadline, RequestExecutionStoppedError, type DeadlineClock } from './request-deadline';

function clockFixture() {
	let now = 100;
	let next = 0;
	const jobs = new Map<number, { at: number; run(): void }>();
	const clock: DeadlineClock = {
		now: () => now,
		set(run, delay) { const id = ++next; jobs.set(id, { at: now + delay, run }); return id; },
		clear(handle) { assert.equal(typeof handle, 'number'); jobs.delete(handle as number); },
	};
	return {
		clock, jobs,
		advance(to: number) {
			now = to;
			for (const [id, job] of [...jobs]) if (job.at <= now) { jobs.delete(id); job.run(); }
		},
	};
}

it('uses one absolute deadline and never starts work after it expires', async () => {
	const { clock, advance, jobs } = clockFixture();
	const deadline = createRequestDeadline(130, undefined, clock);
	assert.equal(await deadline.wait(async () => 1), 1);
	advance(129);
	assert.equal(await deadline.wait(async () => 2), 2);
	advance(130);
	let calls = 0;
	await assert.rejects(deadline.wait(async () => { calls++; }), RequestExecutionStoppedError);
	assert.equal(calls, 0);
	assert.equal(deadline.signal.aborted, true);
	deadline.dispose();
	assert.equal(jobs.size, 0);
});

it('observes late completion without accepting it or resurrecting the deadline', async () => {
	const { clock, advance } = clockFixture();
	const deadline = createRequestDeadline(130, undefined, clock);
	let finish!: (value: string) => void;
	let disposedLate = '';
	const work = deadline.wait(() => new Promise<string>((resolve) => { finish = resolve; }), (result) => { disposedLate = result; });
	const rejected = assert.rejects(work, RequestExecutionStoppedError);
	await Promise.resolve();
	advance(130);
	await rejected;
	finish('late-result');
	await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	assert.equal(disposedLate, 'late-result');
	assert.throws(deadline.throwIfStopped, RequestExecutionStoppedError);
	deadline.dispose();
});

it('does not start work when cancellation arrives at the queued invocation boundary', async () => {
	const { clock } = clockFixture();
	const parent = new AbortController();
	const deadline = createRequestDeadline(130, parent.signal, clock);
	let calls = 0;
	const work = deadline.wait(async () => { calls++; });
	parent.abort('untrusted client text');
	await assert.rejects(work, (error: unknown) => error instanceof RequestExecutionStoppedError && error.reason === 'client_cancelled');
	assert.equal(calls, 0);
	assert.equal(deadline.signal.reason.message, 'Request was cancelled');
	deadline.dispose();
});

it('bounds an unread response and does not await a hanging cancellation acknowledgement', async () => {
	const { clock, advance, jobs } = clockFixture();
	const deadline = createRequestDeadline(130, undefined, clock);
	let cancelled = false;
	const response = deadline.wrapResponse(new Response(new ReadableStream<Uint8Array>({
		cancel() { cancelled = true; return new Promise<void>(() => {}); },
	})));
	advance(130);
	await assert.rejects(response.text(), RequestExecutionStoppedError);
	assert.equal(cancelled, true);
	assert.equal(jobs.size, 0);
});

it('cleans the timer after EOF and preserves response status, headers, and bytes', async () => {
	const { clock, jobs } = clockFixture();
	const deadline = createRequestDeadline(130, undefined, clock);
	const response = deadline.wrapResponse(new Response('test', { status: 201, headers: { 'X-Test': 'yes' } }));
	assert.equal(response.status, 201);
	assert.equal(response.headers.get('X-Test'), 'yes');
	assert.equal(await response.text(), 'test');
	assert.equal(jobs.size, 0);
});

it('cancels upstream and clears resources when the client abandons the wrapped body', async () => {
	const { clock, jobs } = clockFixture();
	const parent = new AbortController();
	const deadline = createRequestDeadline(130, parent.signal, clock);
	let cancelled = false;
	const response = deadline.wrapResponse(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
	await response.body!.cancel();
	assert.equal(cancelled, true);
	assert.equal(jobs.size, 0);
	const stoppedReason = deadline.signal.reason;
	assert.ok(stoppedReason instanceof RequestExecutionStoppedError);
	assert.equal(stoppedReason.reason, 'client_cancelled');
	parent.abort();
	assert.equal(deadline.signal.reason, stoppedReason, 'termination reason cannot change after response cancellation');
});
