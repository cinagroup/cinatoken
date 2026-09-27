import assert from 'node:assert/strict';
import { beforeEach, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { GatewayRepositories, SharedKeyRow } from '@octafuse/core';
import { failoverDispatch, type FailoverDispatchOptions, type ProxyDispatchResult } from './failover-dispatch';
import { GatewayErrorCode } from './gateway-error-codes';
import type { RouteResult } from './model-router';
import { EMPTY_USAGE, proxyChatCompletions, proxyResponses, proxyAnthropicMessages } from './proxy';
import { resetProviderCircuitStateForTests } from './provider-circuit-breaker';
import { createRequestDispatchBudget } from './request-dispatch-budget';
import { RequestExecutionStoppedError, TEXT_REQUEST_DEADLINE_MS } from './request-deadline';
import { createSharedKeyQuoteAttemptCapture,
	type SharedKeyQuoteAttemptInput, type SharedKeyQuoteAttemptReference } from './shared-key-quote-attempt';

// No repository operation is expected unless the test explicitly installs one.
const repos = {} as GatewayRepositories;
function route(index = 0, protocol: 'openai' | 'anthropic' = 'openai'): RouteResult {
	return {
		targetId: `deadline-target-${index}`, modelSurfaceId: null, routePoolId: 'deadline-pool',
		providerId: `deadline-provider-${index}`, providerName: `Deadline Provider ${index}`,
		providerModelName: 'synthetic-model', upstreamProtocol: protocol,
		upstreamOperation: protocol === 'anthropic' ? 'messages' : 'chat', adapter: 'passthrough',
		providerEndpoints: { [protocol]: { base: 'https://upstream.invalid/v1' } },
		providerApiKey: 'synthetic-test-key', providerSharedChannelType: null,
		priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: null, routeGroup: 'default', routePriority: index, routeWeight: 1,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function options(extra: Partial<FailoverDispatchOptions> = {}): FailoverDispatchOptions {
	return {
		affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority',
		requestDeadlineAtMs: Date.now() + 100, delegateBeforeUpstreamDispatchToDriver: true,
		...extra,
	};
}
beforeEach((t) => {
	resetProviderCircuitStateForTests();
	assert.ok('mock' in t);
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
});

it('rejects an expired request before pool reads, financial admission, or driver preparation', async () => {
	const sharedRoute = { ...route(), providerSharedChannelType: 'openai' };
	const result = await failoverDispatch(repos, [sharedRoute], 'openai', async () => {
		assert.fail('expired request must not invoke a driver');
	}, undefined, options({
		requestDeadlineAtMs: Date.now(),
		beforeUpstreamDispatch: async () => { assert.fail('expired request must not admit'); },
	}));
	assert.equal(result.response.status, 504);
	assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.requestDeadlineExceeded);
	assert.equal(result.meta?.upstreamOutcomeUnknown, false);
	assert.equal(result.meta?.admissionDeniedPreDispatch, true);
	assert.equal(result.meta?.failoverForbidden, true);
	assert.equal(result.dispatchBudget?.permitsConsumed, 0);
});

it('bounds a hung shared-pool read and ignores its late result', async (t) => {
	const entered = deferred<void>();
	const lookup = deferred<SharedKeyRow[]>();
	const sharedRepos: GatewayRepositories = { ...repos, sharedKeys: { ...repos.sharedKeys,
		listActiveSharedKeysByChannel: async () => { entered.resolve(); return lookup.promise; },
	} };
	let sends = 0;
	const pending = failoverDispatch(sharedRepos, [{ ...route(), providerSharedChannelType: 'openai' }], 'openai', async () => {
		sends++;
		return { response: new Response('unexpected'), usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
	}, undefined, options());
	await entered.promise;
	t.mock.timers.tick(100);
	const result = await pending;
	assert.equal(result.response.status, 504);
	lookup.resolve([]);
	await nextTurn();
	assert.equal(sends, 0);
	assert.equal(result.meta?.upstreamOutcomeUnknown, false);
});

for (const rejectAdmission of [false, true]) {
	it(`retains responsibility for an admission write after expiry (reject=${rejectAdmission})`, async (t) => {
		const entered = deferred<void>();
		const admission = deferred<void>();
		let sends = 0;
		let completed = false;
		const pending = failoverDispatch(repos, [route(), route(1)], 'openai', async (_route, _signal, _timing, _attempt, beforeFetch) => {
			await beforeFetch?.();
			sends++;
			return { response: new Response('unexpected'), usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
		}, undefined, options({ beforeUpstreamDispatch: async () => { entered.resolve(); await admission.promise; } }));
		// Observe both outcomes immediately, without masking the assertion below.
		const observed = pending.then((value) => { completed = true; return { value }; }, (error: unknown) => { completed = true; return { error }; });
		await entered.promise;
		t.mock.timers.tick(100);
		await nextTurn();
		assert.equal(completed, false, 'reservation cannot be orphaned by Promise.race');
		if (rejectAdmission) admission.reject(new Error('synthetic admission persistence failure'));
		else admission.resolve();
		const outcome = await observed;
		assert.equal(sends, 0);
		if ('error' in outcome) {
			assert.equal(rejectAdmission, true);
			assert.match(String(outcome.error), /synthetic admission persistence failure/);
		} else {
			assert.equal(rejectAdmission, false);
			assert.equal(outcome.value.response.status, 504);
			assert.equal(outcome.value.meta?.upstreamOutcomeUnknown, false);
			assert.equal(outcome.value.dispatchBudget?.permitsConsumed, 0);
		}
	});
}

it('bounds a transport that ignores abort, records the sent attempt, and cancels a late response', async (t) => {
	const entered = deferred<void>();
	const transport = deferred<ProxyDispatchResult>();
	let sends = 0;
	let cancelled = false;
	const pending = failoverDispatch(repos, [route(), route(1)], 'openai', async (_route, _signal, _timing, _attempt, beforeFetch) => {
		await beforeFetch?.(); sends++; entered.resolve(); return transport.promise;
	}, undefined, options());
	await entered.promise;
	t.mock.timers.tick(100);
	const result = await pending;
	assert.equal(result.response.status, 504);
	assert.equal(result.meta?.upstreamOutcomeUnknown, true);
	assert.equal(result.meta?.failoverForbidden, true);
	assert.equal(result.dispatchBudget?.permitsConsumed, 1);
	assert.equal(result.dispatchAttempts?.length, 1, 'a possibly sent request must retain an attempt fact');
	transport.resolve({
		response: new Response(new ReadableStream({ cancel() { cancelled = true; } })),
		usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: 'synthetic-late',
	});
	await nextTurn();
	assert.equal(cancelled, true);
	assert.equal(sends, 1);
});

it('deadline result retains the exact quote reference for a sent shared-key attempt', async (t) => {
	const entered = deferred<void>();
	const transport = deferred<ProxyDispatchResult>();
	const capture = createSharedKeyQuoteAttemptCapture('request-deadline-shared', async input => ({
		...input, transitionId: 'transition-a', quoteVersionId: 'quote-a',
		sellerUserId: 'seller-a', claimedAt: '2026-09-24T00:00:00+00:00',
	}));
	const candidate = { ...route(), providerKeyId: 'sharedkey:key-a' };
	const pending = failoverDispatch(repos, [candidate], 'openai',
		async (_route, _signal, _timing, _attempt, beforeFetch) => {
			await beforeFetch?.();
			entered.resolve();
			return transport.promise;
		}, undefined, options({ quoteAttemptCapture: capture,
			beforeUpstreamDispatch: async () => {} }));
	await entered.promise;
	t.mock.timers.tick(100);
	const result = await pending;
	assert.equal(result.response.status, 504);
	assert.equal(result.meta?.upstreamOutcomeUnknown, true);
	assert.equal(result.chosenRoute.providerKeyId, candidate.providerKeyId);
	assert.equal(result.quoteAttemptReference?.attemptId, capture.references()[0]?.attemptId);
	assert.equal(capture.handoff().economicOutcomes[0]?.usageCertainty, 'unknown');
	transport.resolve({ response: new Response('late'),
		usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: 'late' });
	await nextTurn();
});

it('deadline waits for an in-flight durable quote claim before selecting the terminal reference', async (t) => {
	const entered = deferred<SharedKeyQuoteAttemptInput>();
	const claim = deferred<SharedKeyQuoteAttemptReference>();
	const capture = createSharedKeyQuoteAttemptCapture('request-deadline-claim', async input => {
		entered.resolve(input);
		return claim.promise;
	});
	let sends = 0;
	const candidate = { ...route(), providerKeyId: 'sharedkey:key-a' };
	let completed = false;
	const pending = failoverDispatch(repos, [candidate], 'openai',
		async (_route, _signal, _timing, _attempt, beforeFetch) => {
			await beforeFetch?.();
			sends += 1;
			return { response: new Response('unexpected'),
				usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
		}, undefined, options({ quoteAttemptCapture: capture,
			beforeUpstreamDispatch: async () => {} })).then(result => {
			completed = true;
			return result;
		});
	const input = await entered.promise;
	t.mock.timers.tick(100);
	await nextTurn();
	assert.equal(completed, false, 'the durable claim must finish before the result is settled');
	claim.resolve({ ...input, transitionId: 'transition-a', quoteVersionId: 'quote-a',
		sellerUserId: 'seller-a', claimedAt: '2026-09-24T00:00:00+00:00' });
	const result = await pending;
	assert.equal(result.response.status, 504);
	assert.equal(result.quoteAttemptReference?.attemptId, input.attemptId);
	assert.equal(capture.handoff().transport[0]?.stage, 'claimed_only');
	assert.equal(sends, 0);
});

it('deadline during next-route preparation selects the last claimed attempt', async (t) => {
	const secondEntered = deferred<void>();
	const secondTransport = deferred<ProxyDispatchResult>();
	const capture = createSharedKeyQuoteAttemptCapture('request-deadline-transition', async input => ({
		...input, transitionId: `transition-${input.routeTargetId}`,
		quoteVersionId: `quote-${input.routeTargetId}`,
		sellerUserId: 'seller-a', claimedAt: '2026-09-24T00:00:00+00:00',
	}));
	const first = { ...route(), routePriority: 2, providerKeyId: 'sharedkey:key-a' };
	const second = { ...route(1), routePriority: 1, providerKeyId: 'sharedkey:key-b' };
	const pending = failoverDispatch(repos, [first, second], 'openai',
		async (candidate, _signal, _timing, _attempt, beforeFetch) => {
			if (candidate.targetId === second.targetId) {
				secondEntered.resolve();
				return secondTransport.promise;
			}
			await beforeFetch?.();
			return { response: new Response('rejected', { status: 429 }),
				usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: 'first-rejected' };
		}, undefined, options({ quoteAttemptCapture: capture,
			beforeUpstreamDispatch: async () => {} }));
	await secondEntered.promise;
	assert.equal(capture.references().length, 1, 'the second candidate has not claimed a quote');
	t.mock.timers.tick(100);
	const result = await pending;
	assert.equal(result.response.status, 504);
	assert.equal(result.chosenRoute.targetId, first.targetId);
	assert.equal(result.quoteAttemptReference?.attemptId, capture.references()[0]?.attemptId);
	assert.equal(result.upstreamRequestId, 'first-rejected');
	assert.equal(result.meta?.upstreamOutcomeUnknown, false);
	assert.equal(result.meta?.admissionDeniedPreDispatch, false);
	secondTransport.resolve({ response: new Response('late'),
		usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: 'late' });
	await nextTurn();
});

it('deadline after the next quote claim selects the new attempt', async (t) => {
	const secondEntered = deferred<void>();
	const secondTransport = deferred<ProxyDispatchResult>();
	const capture = createSharedKeyQuoteAttemptCapture('request-deadline-second-claim', async input => ({
		...input, transitionId: `transition-${input.routeTargetId}`,
		quoteVersionId: `quote-${input.routeTargetId}`,
		sellerUserId: 'seller-a', claimedAt: '2026-09-24T00:00:00+00:00',
	}));
	const first = { ...route(), routePriority: 2, providerKeyId: 'sharedkey:key-a' };
	const second = { ...route(1), routePriority: 1, providerKeyId: 'sharedkey:key-b' };
	const pending = failoverDispatch(repos, [first, second], 'openai',
		async (candidate, _signal, _timing, _attempt, beforeFetch) => {
			await beforeFetch?.();
			if (candidate.targetId === second.targetId) {
				secondEntered.resolve();
				return secondTransport.promise;
			}
			return { response: new Response('rejected', { status: 429 }),
				usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: 'first-rejected' };
		}, undefined, options({ quoteAttemptCapture: capture,
			beforeUpstreamDispatch: async () => {} }));
	await secondEntered.promise;
	assert.equal(capture.references().length, 2);
	t.mock.timers.tick(100);
	const result = await pending;
	assert.equal(result.response.status, 504);
	assert.equal(result.chosenRoute.targetId, second.targetId);
	assert.equal(result.quoteAttemptReference?.attemptId, capture.references()[1]?.attemptId);
	assert.equal(result.meta?.upstreamOutcomeUnknown, true);
	secondTransport.resolve({ response: new Response('late'),
		usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: 'late' });
	await nextTurn();
});

for (const global of [false, true]) {
it(`does not allow a hung error body to bypass the absolute deadline (global=${global})`, { timeout: 2_000 }, async (t) => {
	let sends = 0;
	let cancelled = false;
	const entered = deferred<void>();
	const pending = failoverDispatch(repos, [route()], 'openai', async (_route, _signal, _timing, _attempt, beforeFetch) => {
		await beforeFetch?.(); sends++; entered.resolve();
		return {
			response: new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 }),
			usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: 'synthetic-rejected',
		};
	}, undefined, options({ crossModelCandidateFailover: global }));
	await entered.promise;
	await nextTurn();
	t.mock.timers.tick(100);
	const result = await pending;
	assert.equal(result.response.status, 504);
	assert.equal(result.meta?.upstreamOutcomeUnknown, false, 'observed 503 remains known rejection');
	assert.equal(result.meta?.admissionDeniedPreDispatch, false, 'an observed 503 is not an unsent attempt');
	assert.equal(result.upstreamRequestId, 'synthetic-rejected');
	assert.equal(sends, 1);
	await nextTurn();
	assert.equal(cancelled, true);
});
}

it('bounds sticky CAS cleanup while retaining its background owner and preventing another send', async (t) => {
	t.mock.method(Math, 'random', () => 1); // Disable opportunistic metadata GC in this fixture.
	const entered = deferred<void>();
	const mutation = deferred<boolean>();
	let sends = 0;
	const stickyRepos: GatewayRepositories = { ...repos, routePoolSticky: { ...repos.routePoolSticky,
		getBinding: async () => ({
			route_pool_id: 'deadline-pool', affinity_hash: 'synthetic-hash',
			route_target_id: route().targetId, binding_token: 'synthetic-cas-token', pool_epoch: 0,
			expires_at: new Date(Date.now() + 60_000).toISOString(),
		}),
		clearBinding: async () => { entered.resolve(); return mutation.promise; },
	} };
	const pending = failoverDispatch(stickyRepos, [route(), route(1)], 'openai', async (_route, _signal, _timing, _attempt, beforeFetch) => {
		await beforeFetch?.(); sends++;
		return { response: new Response('busy', { status: 429 }), usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: 'synthetic-rejected' };
	}, undefined, options({ affinityKey: 'synthetic-affinity', sticky: { enabled: true, idleTtlSeconds: 60, epoch: 0 } }));
	await entered.promise;
	t.mock.timers.tick(100);
	const result = await pending;
	assert.equal(result.response.status, 504);
	assert.equal(result.meta?.upstreamOutcomeUnknown, false);
	assert.equal(sends, 1);
	assert.ok(result.stickyMutationPromise);
	mutation.resolve(true);
	await result.stickyMutationPromise;
	assert.equal((await result.stickyTrace?.())?.result, 'cleared');
	assert.equal(sends, 1);
});

for (const [name, proxy, protocol] of [
	['chat', proxyChatCompletions, 'openai'],
	['responses', proxyResponses, 'openai'],
	['messages', proxyAnthropicMessages, 'anthropic'],
] as const) {
	it(`${name}: fallback shares the original deadline and cannot extend it through options`, async (t) => {
		let sends = 0;
		t.mock.method(globalThis, 'fetch', async () => {
			sends++; return Response.json({ error: { message: 'rejected' } }, { status: 400 });
		});
		const dispatchBudget = createRequestDispatchBudget();
		const config = options({ dispatchBudget, requestDeadlineAtMs: Date.now() + 2 * TEXT_REQUEST_DEADLINE_MS });
		const first = await proxy(repos, [route(0, protocol)], { input: 'hello', messages: [] }, undefined, config);
		assert.equal(first.response.status, 400);
		await first.response.text();
		t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
		const second = await proxy(repos, [route(1, protocol)], { input: 'hello', messages: [] }, undefined, config);
		assert.equal(second.response.status, 504);
		assert.equal(second.meta?.upstreamOutcomeUnknown, false);
		assert.equal(sends, 1);
	});

	it(`${name}: default ceiling aborts a silent accepted stream even if downstream never reads`, async (t) => {
		let sends = 0;
		let cancelled = false;
		t.mock.method(globalThis, 'fetch', async () => {
			sends++;
			return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
		});
		const result = await proxy(repos, [route(0, protocol), route(1, protocol)], { input: 'hi', messages: [], stream: true });
		assert.equal(result.response.status, 200);
		t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
		await assert.rejects(result.response.text(), RequestExecutionStoppedError);
		const usage = await result.usagePromise;
		assert.match(usage.stream_error ?? '', /deadline/i);
		assert.notEqual(usage.cancelled, true, 'gateway timeout is not a client disconnect');
		assert.equal(cancelled, true);
		assert.equal(sends, 1);
	});

	it(`${name}: aborts and releases a hung JSON reader even when cancellation is never acknowledged`, async (t) => {
		let cancelled = false;
		let sends = 0;
		const reading = deferred<void>();
		const upstream = new ReadableStream<Uint8Array>({
			pull() { reading.resolve(); return new Promise<void>(() => {}); },
			cancel() { cancelled = true; return new Promise<void>(() => {}); },
		}, { highWaterMark: 0 });
		t.mock.method(globalThis, 'fetch', async () => {
			sends++;
			return new Response(upstream, { headers: { 'Content-Type': 'application/json' } });
		});
		const pending = proxy(repos, [route(0, protocol), route(1, protocol)], { input: 'hi', messages: [] });
		await reading.promise;
		t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
		const result = await pending;
		assert.equal(result.response.status, 504);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true);
		await nextTurn();
		assert.equal(cancelled, true);
		assert.equal(upstream.locked, false, 'aborted JSON parsing must release its reader');
		assert.equal(sends, 1);
	});

	it(`${name}: downstream body cancellation reaches the upstream signal and settles usage`, async (t) => {
		let cancelled = false;
		let signal: AbortSignal | null | undefined;
		t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
			signal = init?.signal;
			return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
		});
		const result = await proxy(repos, [route(0, protocol)], { input: 'hi', messages: [], stream: true });
		await result.response.body?.cancel('private client text');
		const usage = await result.usagePromise;
		assert.equal(signal?.aborted, true);
		assert.equal(signal?.reason.reason, 'client_cancelled');
		assert.equal(cancelled, true);
		assert.equal(usage.cancelled, true);
		assert.equal(usage.stream_error, undefined);
	});

	it(`${name}: last-permit success retains authoritative usage without waiting for cancel acknowledgement`, async (t) => {
		const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
		const wire = name === 'chat'
			? event({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) + 'data: [DONE]\n\n'
			: name === 'responses'
				? event({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }) + 'data: [DONE]\n\n'
				: event({ type: 'message_delta', usage: { input_tokens: 1, output_tokens: 2 } }) + event({ type: 'message_stop' });
		let cancelled = false;
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(new TextEncoder().encode(wire)); },
			cancel() { cancelled = true; return new Promise<void>(() => {}); },
		});
		t.mock.method(globalThis, 'fetch', async () => new Response(upstream, { headers: { 'Content-Type': 'text/event-stream' } }));
		const result = await proxy(repos, [route(0, protocol)], { input: 'hi', messages: [], stream: true }, undefined, options({ dispatchBudget: createRequestDispatchBudget(1) }));
		assert.equal(result.response.status, 200);
		assert.ok((await result.response.text()).length > 0);
		const usage = await result.usagePromise;
		assert.equal(usage.total_tokens, 3);
		assert.ok(usage.raw_usage);
		assert.equal(usage.cancelled, undefined);
		assert.equal(usage.stream_error, undefined);
		assert.equal(cancelled, true);
		assert.equal(upstream.locked, false);
		t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
		assert.equal(usage.stream_error, undefined, 'completed response cleared its deadline');
	});

	it(`${name}: client cancellation before/after fetch preserves known versus unknown outcome`, async (t) => {
		let sends = 0;
		const entered = deferred<void>();
		t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			sends++; entered.resolve();
			return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
		});
		const pre = new AbortController(); pre.abort('sensitive cancellation reason');
		const before = await proxy(repos, [route(0, protocol)], { input: 'hi', messages: [] }, pre.signal);
		assert.equal(before.response.status, 499);
		assert.equal(before.meta?.upstreamOutcomeUnknown, false);
		assert.equal(sends, 0);
		const post = new AbortController();
		const pending = proxy(repos, [route(0, protocol), route(1, protocol)], { input: 'hi', messages: [] }, post.signal);
		await entered.promise;
		post.abort('sensitive cancellation reason');
		const after = await pending;
		assert.equal(after.response.status, 499);
		assert.equal(after.meta?.upstreamOutcomeUnknown, true);
		assert.equal(after.meta?.failoverForbidden, true);
		assert.equal(sends, 1);
		assert.doesNotMatch(await after.response.text(), /sensitive/);
	});
}
