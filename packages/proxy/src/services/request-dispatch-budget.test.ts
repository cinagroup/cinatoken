import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { failoverDispatch } from './failover-dispatch';
import type { RouteResult } from './model-router';
import { EMPTY_USAGE, proxyChatCompletions, proxyResponses, proxyAnthropicMessages } from './proxy';
import { resetProviderCircuitStateForTests } from './provider-circuit-breaker';
import { createRequestDispatchBudget, RequestDispatchLimitError } from './request-dispatch-budget';
import { RequestBudgetAdmissionError } from './request-budget-admission';
import { GatewayErrorCode } from './gateway-error-codes';

// These routes have no shared/BYOK credentials or sticky state, so no repository
// operation is valid in this fixture. An unexpected access fails the test.
const repos = {} as GatewayRepositories;

function routes(count: number): RouteResult[] {
	return Array.from({ length: count }, (_, index) => ({
		targetId: `target-${index}`,
		modelSurfaceId: null,
		routePoolId: 'pool-dispatch-limit',
		providerId: `provider-${index}`,
		providerName: `provider-${index}`,
		providerModelName: 'test-model',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://upstream.invalid/v1' } },
		providerApiKey: 'synthetic-test-key',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: index,
		routeWeight: 1,
		providerKeyId: `key-${index}`,
		providerKeyLabel: null,
		providerKeyFingerprint: null,
	}));
}

beforeEach(() => resetProviderCircuitStateForTests());

it('caps request dispatches at three even when the candidate pool exceeds the trace cap', async () => {
	let dispatches = 0;
	const result = await failoverDispatch(repos, routes(20), 'openai', async () => {
		dispatches += 1;
		return {
			response: new Response('unavailable', { status: 503 }),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		};
	});
	assert.equal(dispatches, 3);
	assert.equal(result.response.status, 502);
	assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), 'gateway.dispatch_limit_exceeded');
	assert.equal(result.meta?.failoverForbidden, true);
});

it('validates the ceiling and keeps snapshots and separate request budgets isolated', () => {
	for (const limit of [0, -1, 1.5, 4, Infinity, NaN]) {
		assert.throws(() => createRequestDispatchBudget(limit), RangeError);
	}
	const first = createRequestDispatchBudget(1);
	const second = createRequestDispatchBudget();
	const initial = first.snapshot();
	first.consume();
	assert.throws(() => first.consume(), RequestDispatchLimitError);
	assert.deepEqual(initial, { limit: 1, permitsConsumed: 0, auxiliaryAuth: { limit: 3, exchangesStarted: 0 } });
	assert.deepEqual(first.snapshot(), { limit: 1, permitsConsumed: 1, auxiliaryAuth: { limit: 3, exchangesStarted: 0 } });
	assert.deepEqual(second.snapshot(), { limit: 3, permitsConsumed: 0, auxiliaryAuth: { limit: 3, exchangesStarted: 0 } });
});

for (const delegated of [false, true]) {
	it(`never overspends concurrent permits after awaited admission (delegated=${delegated})`, async () => {
		const dispatchBudget = createRequestDispatchBudget(1);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let entered = 0;
		let allEntered!: () => void;
		const ready = new Promise<void>((resolve) => { allEntered = resolve; });
		let sends = 0;
		const pending = routes(6).map((route) => failoverDispatch(repos, [route], 'openai',
			async (_route, _signal, _timing, _attempt, beforeFetch) => {
				await beforeFetch?.();
				sends += 1;
				return { response: new Response('ok'), usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
			}, undefined, {
				affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget,
				delegateBeforeUpstreamDispatchToDriver: delegated,
				beforeUpstreamDispatch: async () => {
					entered += 1;
					if (entered === 6) allEntered();
					await gate;
				},
			}));
		await ready;
		release();
		const results = await Promise.all(pending);
		assert.equal(sends, 1);
		assert.equal(results.filter((result) => result.response.ok).length, 1);
		assert.equal(results.filter((result) => result.meta?.failoverForbidden).length, 5);
		assert.deepEqual(dispatchBudget.snapshot(), { limit: 1, permitsConsumed: 1, auxiliaryAuth: { limit: 3, exchangesStarted: 0 } });
	});
}

it('does not charge a dispatch permit when financial admission is denied', async () => {
	const dispatchBudget = createRequestDispatchBudget();
	const result = await failoverDispatch(repos, routes(5), 'openai', async () => {
		throw new Error('must not invoke driver');
	}, undefined, {
		affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget,
		beforeUpstreamDispatch: async () => {
			throw new RequestBudgetAdmissionError({ code: GatewayErrorCode.budgetExceeded, message: 'Budget exceeded' });
		},
	});
	assert.equal(result.response.status, 402);
	assert.deepEqual(result.dispatchBudget, { limit: 3, permitsConsumed: 0, auxiliaryAuth: { limit: 3, exchangesStarted: 0 } });
});

it('stops an exhausted outer model budget before credential reads or paid admission', async () => {
	const dispatchBudget = createRequestDispatchBudget(1);
	dispatchBudget.consume();
	const route = routes(1)[0]!;
	route.providerSharedChannelType = 'openai';
	const result = await failoverDispatch(repos, [route], 'openai', async () => {
		throw new Error('must not invoke driver');
	}, undefined, {
		affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget,
		beforeUpstreamDispatch: async () => { throw new Error('must not admit payment'); },
	});
	assert.equal(result.response.status, 502);
	assert.equal(result.meta?.admissionDeniedPreDispatch, true);
	assert.deepEqual(result.circuitEvents, []);
});

it('delegates the fetch boundary with no options and excludes local preparation failures', async (t) => {
	let sends = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		sends += 1;
		return Response.json({ error: { message: 'bad request' } }, { status: 400 });
	});
	const result = await proxyChatCompletions(repos, routes(8), (route) => {
		if (route.targetId !== 'target-0') throw new Error('synthetic local preparation failure');
		return { messages: [] };
	});
	assert.equal(sends, 1);
	assert.deepEqual(result.dispatchBudget, { limit: 3, permitsConsumed: 1, auxiliaryAuth: { limit: 3, exchangesStarted: 0 } });
});

for (const [name, proxy] of [
	['chat', proxyChatCompletions], ['responses', proxyResponses], ['messages', proxyAnthropicMessages],
] as const) {
	it(`shares permits across ${name} model invocations and stops before the fourth fetch`, async (t) => {
		let sends = 0;
		t.mock.method(globalThis, 'fetch', async () => {
			sends += 1;
			return Response.json({ error: { message: 'unavailable' } }, { status: 503 });
		});
		const dispatchBudget = createRequestDispatchBudget();
		const modelRoutes = routes(6);
		for (const [index, route] of modelRoutes.entries()) {
			route.providerModelName = `model-${index}`;
			route.upstreamOperation = name === 'chat' ? 'chat' : name;
			if (name === 'messages') {
				route.upstreamProtocol = 'anthropic';
				route.providerEndpoints = { anthropic: { base: 'https://upstream.invalid/v1' } };
			}
			const result = await proxy(repos, [route], { messages: [], input: 'hi' }, undefined, {
				affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget,
			});
			if (index >= 3) {
				assert.equal(result.meta?.failoverForbidden, true);
				assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.dispatchLimitExceeded);
			}
		}
		assert.equal(sends, 3);
		assert.deepEqual(dispatchBudget.snapshot(), { limit: 3, permitsConsumed: 3, auxiliaryAuth: { limit: 3, exchangesStarted: 0 } });
	});
}

it('preserves an accepted stream and its pending usage even on the last permit', async () => {
	const dispatchBudget = createRequestDispatchBudget(1);
	let finishUsage!: (usage: typeof EMPTY_USAGE) => void;
	const usagePromise = new Promise<typeof EMPTY_USAGE>((resolve) => { finishUsage = resolve; });
	const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: hi\n\n')); controller.close(); } }));
	const result = await failoverDispatch(repos, routes(10), 'openai', async () => ({
		response, usagePromise, upstreamRequestId: 'synthetic-accepted',
	}), undefined, { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget });
	assert.equal(result.response, response);
	assert.equal(result.usagePromise, usagePromise);
	assert.equal(result.meta?.failoverForbidden, undefined);
	assert.equal(await result.response.text(), 'data: hi\n\n');
	finishUsage(EMPTY_USAGE);
	assert.equal(await result.usagePromise, EMPTY_USAGE);
});

it('shares three physical POST permits across concurrent model and key chains', { timeout: 15_000 }, async (t) => {
	const received: Array<{ model: string; credential: string | undefined; bytes: number }> = [];
	const server = createServer(async (incoming, outgoing) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks);
		const parsed = JSON.parse(body.toString('utf8')) as { model: string };
		received.push({ model: parsed.model, credential: incoming.headers.authorization, bytes: body.length });
		if (received.length === 3) {
			outgoing.destroy();
			return;
		}
		outgoing.writeHead(429, { 'Content-Type': 'application/json' });
		outgoing.end('{"error":{"message":"synthetic rate limit"}}');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const nativeFetch = globalThis.fetch.bind(globalThis);
	let fetchCalls = 0;
	t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, origin);
		fetchCalls++;
		return nativeFetch(input, init);
	});
	const candidates = routes(16);
	for (const [index, route] of candidates.entries()) {
		route.providerEndpoints = { openai: { base: `${origin}/v1` } };
		route.providerApiKey = `credential-${index}`;
		route.providerModelName = `model-${index}`;
	}
	const dispatchBudget = createRequestDispatchBudget();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let entered = 0;
	let allEntered!: () => void;
	const ready = new Promise<void>((resolve) => { allEntered = resolve; });
	const pending = Array.from({ length: 8 }, (_, index) => proxyChatCompletions(
		repos, candidates.slice(index * 2, index * 2 + 2),
		{ messages: [{ role: 'user', content: 'hi' }] }, undefined,
		{
			affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget,
			beforeUpstreamDispatch: async () => {
				entered++;
				if (entered === 8) allEntered();
				await gate;
			},
		},
	));
	await ready;
	release();
	const results = await Promise.all(pending);
	assert.equal(results.length, 8);
	const unknown = results.filter((result) => result.meta?.upstreamOutcomeUnknown === true);
	assert.equal(unknown.length, 1, 'the reset after a complete POST must stay outcome-unknown');
	assert.equal(unknown[0]?.meta?.failoverForbidden, true);
	assert.equal(results.filter((result) =>
		result.response.headers.get('X-OctaFuse-Error-Code') === GatewayErrorCode.dispatchLimitExceeded).length, 7);
	assert.equal(entered, 8, 'fallback must stop before a ninth admission');
	assert.equal(fetchCalls, 3);
	assert.equal(received.length, 3, 'the server must receive only three complete POST bodies');
	assert.ok(received.every((attempt) => attempt.bytes > 0 && attempt.credential?.startsWith('Bearer credential-')));
	assert.equal(new Set(received.map((attempt) => attempt.model)).size, 3);
	assert.equal(new Set(received.map((attempt) => attempt.credential)).size, 3);
	assert.equal(dispatchBudget.snapshot().permitsConsumed, 3);
});
