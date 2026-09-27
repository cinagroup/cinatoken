import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Context } from 'hono';
import { RequestAuxiliaryAuthLimitError, type GatewayRepositories, type PostgresDatabaseClient } from '@octafuse/core';
import { prepareSharedKeyEconomicOutbox } from '../../../core/src/db/shared-key-economic-outbox-types';
import { handleChatCompletion, type ChatEnv } from '../routes/v1/chat';
import { failoverDispatch } from './failover-dispatch';
import { dispatchGlobalModelFallback } from './model-fallback-global-dispatch';
import type { ModelFallbackCandidatePlan } from './model-fallback-plan';
import { RequestTimingCollector } from './request-timing';
import { RequestBudgetAdmissionError } from './request-budget-admission';
import { createRequestDispatchBudget, RequestDispatchLimitError } from './request-dispatch-budget';
import { GatewayErrorCode } from './gateway-error-codes';
import type { RouteResult } from './model-router';
import { EMPTY_USAGE, proxyChatCompletions } from './proxy';
import { resetProviderCircuitStateForTests } from './provider-circuit-breaker';
import { resetSharedKeyPoolStateForTests } from './shared-key-pool';
import {
	createConfiguredSharedKeyQuoteAttemptCapture,
	createPostgresSharedKeyEconomicProducer,
	createSharedKeyQuoteAttemptCapture,
	type SharedKeyQuoteAttemptInput,
	type SharedKeyQuoteAttemptReference,
} from './shared-key-quote-attempt';

function route(keyId: string, targetId = `target-${keyId}`): RouteResult {
	return {
		targetId,
		modelSurfaceId: null,
		routePoolId: 'pool-a',
		providerId: 'provider-a',
		providerName: 'provider-a',
		providerModelName: 'model-a',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://example.invalid/v1' } },
		providerApiKey: 'synthetic-secret',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routingMetadata: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: keyId,
		providerKeyLabel: keyId,
		providerKeyFingerprint: 'synthetic-fingerprint',
	};
}

const options = {
	affinityKey: 'request-a',
	tierKeyPrefix: 'tier-a',
	strategy: 'weight_priority' as const,
	delegateBeforeUpstreamDispatchToDriver: true,
};

function reference(input: SharedKeyQuoteAttemptInput): SharedKeyQuoteAttemptReference {
	return {
		...input,
		transitionId: `transition-${input.attemptIndex}`,
		quoteVersionId: `quote-${input.attemptIndex}`,
		sellerUserId: 'seller-a',
		claimedAt: '2026-09-24T00:00:00+00:00',
	};
}

beforeEach(() => {
	resetProviderCircuitStateForTests();
	resetSharedKeyPoolStateForTests();
});

test('review activation is absent by default and rejects partial/wrong backend composition', () => {
	assert.equal(createConfiguredSharedKeyQuoteAttemptCapture({
		activation: undefined, connectionString: undefined,
		databaseDriver: 'd1', requestLogId: 'request-a',
	}), null);
	for (const config of [
		{ activation: 'true', connectionString: 'postgres://synthetic', databaseDriver: 'postgres' },
		{ activation: 'reviewed-v1', connectionString: undefined, databaseDriver: 'postgres' },
		{ activation: 'reviewed-v1', connectionString: 'postgres://synthetic', databaseDriver: 'd1' },
	]) {
		assert.throws(() => createConfiguredSharedKeyQuoteAttemptCapture({
			...config, requestLogId: 'request-a',
		}), /Invalid shared-key quote attempt activation/);
	}
});

test('Chat opt-in without an economic producer returns 503 before body read or fetch', async t => {
	let bodyReads = 0;
	let sends = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		sends++;
		throw new Error('Unexpected upstream send');
	});
	const context = {
		env: { SHARED_KEY_QUOTE_ATTEMPTS_ENABLED: 'reviewed-v1',
			QUOTE_ATTEMPT_HYPERDRIVE: { connectionString: 'postgres://synthetic' } },
		var: { generationId: 'request-exact-a' },
		req: { path: '/v1/chat/completions', json: async () => { bodyReads++; return {}; } },
		get(name: string) {
			if (name === 'repositories') return { client: { driver: 'postgres' } };
			if (name === 'generationId') return 'request-exact-a';
			return undefined;
		},
	} as unknown as Context<ChatEnv>;
	const response = await handleChatCompletion(context);
	assert.equal(response.status, 503);
	assert.equal(bodyReads, 0);
	assert.equal(sends, 0);
});

test('Chat quote and economic opt-in requires aggregate budget proof before body read or fetch', async t => {
	let bodyReads = 0;
	let sends = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		sends++;
		throw new Error('Unexpected upstream send');
	});
	const producer = createPostgresSharedKeyEconomicProducer({ driver: 'postgres' } as PostgresDatabaseClient);
	const context = {
		env: { SHARED_KEY_QUOTE_ATTEMPTS_ENABLED: 'reviewed-v1',
			QUOTE_ATTEMPT_HYPERDRIVE: { connectionString: 'postgres://synthetic' } },
		var: { generationId: 'request-no-aggregate-proof' },
		req: { path: '/v1/chat/completions', json: async () => { bodyReads++; return {}; } },
		get(name: string) {
			if (name === 'repositories') return { client: { driver: 'postgres' } };
			if (name === 'generationId') return 'request-no-aggregate-proof';
			if (name === 'sharedKeyEconomicProducer') return producer;
			return undefined;
		},
	} as unknown as Context<ChatEnv>;
	const response = await handleChatCompletion(context);
	assert.equal(response.status, 503);
	assert.equal(bodyReads, 0);
	assert.equal(sends, 0);
});

test('an injected economic producer without quote activation returns 503 before body read or fetch', async t => {
	let bodyReads = 0;
	let sends = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		sends++;
		throw new Error('Unexpected upstream send');
	});
	const producer = createPostgresSharedKeyEconomicProducer({ driver: 'postgres' } as PostgresDatabaseClient);
	const context = {
		env: {},
		var: { generationId: 'request-exact-b' },
		req: { path: '/v1/chat/completions', json: async () => { bodyReads++; return {}; } },
		get(name: string) {
			if (name === 'repositories') return { client: { driver: 'postgres' } };
			if (name === 'generationId') return 'request-exact-b';
			if (name === 'sharedKeyEconomicProducer') return producer;
			return undefined;
		},
	} as unknown as Context<ChatEnv>;
	const response = await handleChatCompletion(context);
	assert.equal(response.status, 503);
	assert.equal(bodyReads, 0);
	assert.equal(sends, 0);
});

test('one request scope captures distinct exact references before each shared-key send', async () => {
	const inputs: SharedKeyQuoteAttemptInput[] = [];
	const captures = createSharedKeyQuoteAttemptCapture('request-a', async input => {
		inputs.push(input);
		return reference(input);
	});
	const events: string[] = [];
	const routes = [route('sharedkey:key-a'), route('sharedkey:key-b')];
	const result = await failoverDispatch({} as GatewayRepositories, routes, 'openai',
		async (candidate, _signal, _timing, _attempt, beforeFetch) => {
			await beforeFetch?.();
			events.push(`send:${candidate.providerKeyId}`);
			return { response: new Response(candidate.providerKeyId === 'sharedkey:key-a' ? 'busy' : 'ok', {
				status: candidate.providerKeyId === 'sharedkey:key-a' ? 429 : 200,
			}), usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
		}, undefined, {
			...options,
			beforeUpstreamDispatch: async candidate => { events.push(`budget:${candidate.providerKeyId}`); },
			quoteAttemptCapture: {
				...captures,
				beforeFetch: async candidate => {
					const claimed = await captures.beforeFetch(candidate);
					events.push(`quote:${candidate.providerKeyId}`);
					return claimed;
				},
			},
		});
	assert.equal(result.response.status, 200);
	assert.deepEqual(events, [
		'quote:sharedkey:key-a', 'budget:sharedkey:key-a', 'send:sharedkey:key-a',
		'quote:sharedkey:key-b', 'budget:sharedkey:key-b', 'send:sharedkey:key-b',
	]);
	assert.deepEqual(inputs.map(row => [row.requestLogId, row.attemptIndex,
		row.sharedKeyId, row.routeTargetId]), [
		['request-a', 1, 'key-a', 'target-sharedkey:key-a'],
		['request-a', 2, 'key-b', 'target-sharedkey:key-b'],
	]);
	assert.notEqual(inputs[0]?.attemptId, inputs[1]?.attemptId);
	assert.deepEqual(captures.references().map(row => row.quoteVersionId), ['quote-1', 'quote-2']);
	assert.deepEqual(captures.handoff().transport.map(row => [row.stage, row.upstreamHttpStatus]), [
		['fetch_boundary_permitted', null], ['fetch_boundary_permitted', null],
	]);
});

test('claim error, invalid returned identity and non-delegated use stop before any send', async () => {
	let sends = 0;
	for (const claim of [
		async () => { throw new Error('SQL or commit acknowledgement failed'); },
		async (input: SharedKeyQuoteAttemptInput) => reference({ ...input, sharedKeyId: 'other' }),
	]) {
		const capture = createSharedKeyQuoteAttemptCapture('request-a', claim);
		await assert.rejects(failoverDispatch({} as GatewayRepositories,
			[route('sharedkey:key-a'), route('sharedkey:key-b')], 'openai',
			async (_candidate, _signal, _timing, _attempt, beforeFetch) => {
				await beforeFetch?.();
				sends++;
				return { response: new Response('ok'), usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null };
			}, undefined, { ...options, quoteAttemptCapture: capture }),
		/failed|mismatched/);
		assert.equal(capture.references().length, 0);
	}
	assert.equal(sends, 0);
	const capture = createSharedKeyQuoteAttemptCapture('request-a', async input => reference(input));
	await assert.rejects(failoverDispatch({} as GatewayRepositories,
		[route('sharedkey:key-a')], 'openai', async () => {
			sends++;
			return { response: new Response('ok'), usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null };
		}, undefined, { ...options, delegateBeforeUpstreamDispatchToDriver: false,
			quoteAttemptCapture: capture }), /requires a delegated pre-fetch boundary/);
	assert.equal(sends, 0);
});

test('budget denial after a quote claim leaves only a pre-send reference and sends nothing', async () => {
	let sends = 0;
	const capture = createSharedKeyQuoteAttemptCapture('request-budget-denied',
		async input => reference(input));
	const result = await failoverDispatch({} as GatewayRepositories,
		[route('sharedkey:key-a'), route('sharedkey:key-b')], 'openai',
		async (_candidate, _signal, _timing, _attempt, beforeFetch) => {
			await beforeFetch?.();
			sends++;
			return { response: new Response('ok'), usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null };
		}, undefined, { ...options, quoteAttemptCapture: capture,
			beforeUpstreamDispatch: async () => { throw new RequestBudgetAdmissionError({
				code: GatewayErrorCode.budgetExceeded, message: 'Synthetic budget denial',
			}); },
		});
	assert.equal(result.response.status, 402);
	assert.equal(result.meta?.admissionDeniedPreDispatch, true);
	assert.equal(sends, 0);
	assert.equal(capture.references().length, 1);
	assert.deepEqual(result.quoteAttemptReference, capture.references()[0]);
	assert.deepEqual(capture.handoff().transport.map(row => row.stage), ['claimed_only']);
	assert.deepEqual(capture.handoff().economicOutcomes.map(row => [row.usageCertainty, row.providerCostCertainty,
		row.inputTokens, row.providerCostMicros]), [['unknown', 'unknown', null, null]]);
});

test('terminal HTTP rejection retains the exact final quote reference with unknown usage', async () => {
	for (const statuses of [[400], [429, 429]]) {
		const capture = createSharedKeyQuoteAttemptCapture(`request-rejected-${statuses.join('-')}`,
			async input => reference(input));
		const routes = statuses.map((_, index) => route(`sharedkey:key-${index + 1}`));
		let sends = 0;
		const result = await failoverDispatch({} as GatewayRepositories, routes, 'openai',
			async (_candidate, _signal, _timing, _attempt, beforeFetch, _auxiliaryAuth, upstreamHeadersObserved) => {
				await beforeFetch?.();
				const status = statuses[sends++]!;
				upstreamHeadersObserved?.(status);
				return { response: new Response('rejected', { status }),
					usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
			}, undefined, { ...options, quoteAttemptCapture: capture });
		assert.equal(result.response.status, statuses.at(-1));
		assert.equal(sends, statuses.length);
		assert.equal(result.chosenRoute.providerKeyId, routes.at(-1)?.providerKeyId);
		assert.equal(result.quoteAttemptReference?.attemptId,
			capture.references().at(-1)?.attemptId);
		assert.deepEqual(capture.handoff().economicOutcomes.map(row => row.usageCertainty),
			statuses.map(() => 'unknown'));
	}
});

test('a non-shared final route cannot inherit an earlier shared quote reference', async () => {
	const capture = createSharedKeyQuoteAttemptCapture('request-nonshared-final',
		async input => reference(input));
	const result = await failoverDispatch({} as GatewayRepositories,
		[route('sharedkey:key-a'), route('private:key-b')], 'openai',
		async (candidate, _signal, _timing, _attempt, beforeFetch, _auxiliaryAuth, upstreamHeadersObserved) => {
			await beforeFetch?.();
			const status = candidate.providerKeyId === 'sharedkey:key-a' ? 429 : 400;
			upstreamHeadersObserved?.(status);
			return { response: new Response('rejected', { status }),
				usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
		}, undefined, { ...options, quoteAttemptCapture: capture });
	assert.equal(result.response.status, 400);
	assert.equal(result.chosenRoute.providerKeyId, 'private:key-b');
	assert.equal(result.quoteAttemptReference, undefined);
	assert.equal(capture.references().length, 1);
});

test('first granted terminal HTTP rejection retains its quote reference', async () => {
	const capture = createSharedKeyQuoteAttemptCapture('request-granted-rejection',
		async input => reference(input));
	let sends = 0;
	const result = await failoverDispatch({} as GatewayRepositories,
		[route('sharedkey:key-a'), route('sharedkey:key-b')], 'openai',
		async (_candidate, _signal, _timing, _attempt, beforeFetch, _auxiliaryAuth, upstreamHeadersObserved) => {
			await beforeFetch?.();
			sends += 1;
			upstreamHeadersObserved?.(429);
			return { response: new Response('busy', { status: 429 }),
				usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
		}, undefined, { ...options, quoteAttemptCapture: capture,
			beforeUpstreamDispatch: async () => {}, stopAfterFirstGrantedDispatch: true });
	assert.equal(result.response.status, 429);
	assert.equal(sends, 1);
	assert.equal(result.quoteAttemptReference?.attemptId, capture.references()[0]?.attemptId);
	assert.equal(capture.handoff().economicOutcomes[0]?.usageCertainty, 'unknown');
});

test('dispatch limit after a rejected shared attempt selects the claimed route', async () => {
	const capture = createSharedKeyQuoteAttemptCapture('request-dispatch-limit',
		async input => reference(input));
	let sends = 0;
	const result = await failoverDispatch({} as GatewayRepositories,
		[route('sharedkey:key-a'), route('sharedkey:key-b')], 'openai',
		async (_candidate, _signal, _timing, _attempt, beforeFetch, _auxiliaryAuth, upstreamHeadersObserved) => {
			await beforeFetch?.();
			sends += 1;
			upstreamHeadersObserved?.(429);
			return { response: new Response('busy', { status: 429 }),
				usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
		}, undefined, { ...options, quoteAttemptCapture: capture,
			dispatchBudget: createRequestDispatchBudget(1) });
	assert.equal(result.response.status, 502);
	assert.equal(result.chosenRoute.providerKeyId, 'sharedkey:key-a');
	assert.equal(result.quoteAttemptReference?.attemptId, capture.references()[0]?.attemptId);
	assert.equal(capture.references().length, 1);
	assert.equal(capture.handoff().economicOutcomes[0]?.usageCertainty, 'unknown');
	assert.equal(sends, 1);
});

test('local dispatch and auxiliary-auth limits retain a quote-only terminal claim', async () => {
	for (const error of [new RequestDispatchLimitError(), new RequestAuxiliaryAuthLimitError()]) {
		const capture = createSharedKeyQuoteAttemptCapture(`request-local-limit-${error.name}`,
			async input => reference(input));
		let sends = 0;
		const result = await failoverDispatch({} as GatewayRepositories,
			[route('sharedkey:key-a')], 'openai',
			async (_candidate, _signal, _timing, _attempt, beforeFetch) => {
				await beforeFetch?.();
				sends += 1;
				return { response: new Response('unexpected'),
					usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
			}, undefined, { ...options, quoteAttemptCapture: capture,
				beforeUpstreamDispatch: async () => { throw error; } });
		assert.equal(result.response.status, 502);
		assert.equal(result.quoteAttemptReference?.attemptId, capture.references()[0]?.attemptId);
		assert.equal(capture.handoff().transport[0]?.stage, 'claimed_only');
		assert.equal(capture.handoff().economicOutcomes[0]?.usageCertainty, 'unknown');
		assert.equal(sends, 0);
	}
});

test('real Chat loopback binds only the selected provider usage to its exact quote attempt', async t => {
	const received: string[] = [];
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) { /* consume the full POST */ }
		const authorization = request.headers.authorization ?? '';
		received.push(authorization);
		if (authorization === 'Bearer secret-a') {
			response.writeHead(429, { 'content-type': 'text/plain' });
			response.end('busy');
			return;
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion',
			created: 1, model: 'model-a',
			choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const address = server.address() as AddressInfo;
	const base = `http://127.0.0.1:${address.port}/v1`;
	const routes = [
		{ ...route('sharedkey:key-a'), providerApiKey: 'secret-a', providerEndpoints: { openai: { base } } },
		{ ...route('sharedkey:key-b'), providerApiKey: 'secret-b', providerEndpoints: { openai: { base } } },
	];
	const capture = createSharedKeyQuoteAttemptCapture('request-headers', async input => reference(input));
	const result = await proxyChatCompletions({} as GatewayRepositories, routes,
		{ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }, undefined,
		{ ...options, quoteAttemptCapture: capture }, 'request-headers');
	const responseBody = await result.response.text();
	assert.equal(result.response.status, 200, responseBody);
	const aggregateUsage = await result.usagePromise;
	assert.equal(aggregateUsage.input_tokens, 7);
	assert.ok(result.quoteAttemptReference);
	assert.equal(await capture.observeProviderUsage(result.quoteAttemptReference, aggregateUsage), true);
	assert.deepEqual(received, ['Bearer secret-a', 'Bearer secret-b']);
	const handoff = capture.handoff();
	assert.equal(handoff.quoteAttempts.length, 2);
	assert.deepEqual(handoff.transport.map(row => [row.reference.attemptId, row.stage, row.upstreamHttpStatus]), [
		[handoff.quoteAttempts[0]?.attemptId, 'upstream_headers_observed', 429],
		[handoff.quoteAttempts[1]?.attemptId, 'upstream_headers_observed', 200],
	]);
	assert.notEqual(handoff.quoteAttempts[0]?.attemptId, handoff.quoteAttempts[1]?.attemptId);
	assert.equal(handoff.quoteAttempts[1]?.attemptId, result.quoteAttemptReference.attemptId);
	assert.deepEqual(handoff.economicOutcomes.map(outcome => [
		outcome.usageCertainty, outcome.inputTokens, outcome.outputTokens,
		outcome.providerCostCertainty, outcome.providerCostMicros,
	]), [
		['unknown', null, null, 'unknown', null],
		['actual', 7, 3, 'unknown', null],
	]);
	assert.equal(handoff.economicOutcomes[0]?.evidenceKind, 'manual_review');
	assert.equal(handoff.economicOutcomes[1]?.evidenceKind, 'provider_usage');
	assert.match(handoff.economicOutcomes[1]?.evidenceSha256 ?? '', /^[0-9a-f]{64}$/);
	const prepared = prepareSharedKeyEconomicOutbox('request-headers', 100, {
		buyerChargeBasis: 'actual', buyerUsageCertainty: 'actual', attempts: handoff.economicOutcomes,
	});
	const persisted = JSON.parse(prepared.attemptsJson) as Array<Record<string, unknown>>;
	assert.equal(persisted[0]?.usage_certainty, 'unknown');
	assert.equal(persisted[1]?.usage_certainty, 'actual');
	assert.equal(persisted[1]?.input_tokens, 7);
	assert.equal(persisted[1]?.provider_cost_certainty, 'unknown');
});

test('incomplete, cancelled and conflicting usage never upgrades an attempt', async () => {
	const capture = createSharedKeyQuoteAttemptCapture('request-evidence', async input => reference(input));
	const claimed = await capture.beforeFetch(route('sharedkey:key-a'));
	assert.ok(claimed);
	const actual = {
		...EMPTY_USAGE,
		input_tokens: 7, output_tokens: 3, total_tokens: 10,
		raw_usage: '{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}',
	};
	assert.equal(await capture.observeProviderUsage(claimed, actual), false);
	capture.fetchBoundaryPermitted(claimed);
	assert.equal(await capture.observeProviderUsage(claimed, actual), false);
	capture.upstreamHeadersObserved(claimed, 200);
	assert.equal(await capture.observeProviderUsage(claimed, { ...actual, raw_usage: null }), false);
	assert.equal(await capture.observeProviderUsage(claimed, { ...actual, cancelled: true }), false);
	assert.equal(await capture.observeProviderUsage(claimed, { ...actual, stream_error: 'truncated' }), false);
	assert.equal(await capture.observeProviderUsage(claimed, {
		...actual, raw_usage: '{"prompt_tokens":7}',
	}), false);
	assert.equal(capture.handoff().economicOutcomes[0]?.usageCertainty, 'unknown');
	assert.equal(await capture.observeProviderUsage(claimed, actual), true);
	assert.equal(await capture.observeProviderUsage(claimed, actual), true);
	assert.equal(await capture.observeProviderUsage(claimed, {
		...actual, input_tokens: 8, total_tokens: 11,
		raw_usage: '{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}',
	}), false);
	assert.equal(capture.handoff().economicOutcomes[0]?.inputTokens, 7);
	await assert.rejects(capture.observeProviderUsage({ ...claimed }, actual), /Unowned/);
});

test('a provider-reported zero usage is actual usage, while rejection and ambiguity stay unknown', async () => {
	const capture = createSharedKeyQuoteAttemptCapture('request-zero', async input => reference(input));
	const zero = { ...EMPTY_USAGE, raw_usage: '{"prompt_tokens":0,"completion_tokens":0}' };
	const accepted = await capture.beforeFetch(route('sharedkey:accepted'));
	const rejected = await capture.beforeFetch(route('sharedkey:rejected'));
	const ambiguous = await capture.beforeFetch(route('sharedkey:ambiguous'));
	assert.ok(accepted && rejected && ambiguous);
	for (const row of [accepted, rejected, ambiguous]) capture.fetchBoundaryPermitted(row);
	capture.upstreamHeadersObserved(accepted, 200);
	capture.upstreamHeadersObserved(rejected, 429);
	capture.transportAmbiguous(ambiguous);
	assert.equal(await capture.observeProviderUsage(accepted, zero), true);
	assert.equal(await capture.observeProviderUsage(rejected, zero), false);
	assert.equal(await capture.observeProviderUsage(ambiguous, zero), false);
	assert.deepEqual(capture.handoff().economicOutcomes.map(row => [
		row.usageCertainty, row.providerCostCertainty, row.evidenceKind,
	]), [
		['actual', 'unknown', 'provider_usage'],
		['unknown', 'unknown', 'manual_review'],
		['unknown', 'unknown', 'manual_review'],
	]);
});

test('real Chat loopback socket loss remains transport ambiguous and never replays another key', async t => {
	let received = 0;
	const server = createServer(async request => {
		for await (const _chunk of request) { /* consume the full POST */ }
		received += 1;
		request.socket.destroy();
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const address = server.address() as AddressInfo;
	const base = `http://127.0.0.1:${address.port}/v1`;
	const routes = [route('sharedkey:key-a'), route('sharedkey:key-b')].map(candidate => ({
		...candidate, providerEndpoints: { openai: { base } },
	}));
	const capture = createSharedKeyQuoteAttemptCapture('request-ambiguous', async input => reference(input));
	const result = await proxyChatCompletions({} as GatewayRepositories, routes,
		{ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }, undefined,
		{ ...options, quoteAttemptCapture: capture }, 'request-ambiguous');
	assert.equal(result.response.status, 502);
	assert.equal(result.meta?.upstreamOutcomeUnknown, true);
	assert.equal(received, 1);
	assert.equal(result.quoteAttemptReference?.attemptId, capture.references()[0]?.attemptId);
	assert.deepEqual(capture.handoff().transport.map(row => [row.stage, row.upstreamHttpStatus]),
		[['transport_ambiguous', null]]);
	assert.equal(capture.handoff().economicOutcomes[0]?.usageCertainty, 'unknown');
});

test('raw 200 headers remain observed when Chat rejects the provider body as invalid', async t => {
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) { /* consume the full POST */ }
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end('{}');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const address = server.address() as AddressInfo;
	const candidate = { ...route('sharedkey:key-a'),
		providerEndpoints: { openai: { base: `http://127.0.0.1:${address.port}/v1` } } };
	const capture = createSharedKeyQuoteAttemptCapture('request-invalid-body', async input => reference(input));
	const result = await proxyChatCompletions({} as GatewayRepositories, [candidate],
		{ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }, undefined,
		{ ...options, quoteAttemptCapture: capture }, 'request-invalid-body');
	assert.equal(result.response.status, 502);
	assert.equal(result.quoteAttemptReference?.attemptId, capture.references()[0]?.attemptId);
	assert.deepEqual(capture.handoff().transport.map(row => [row.stage, row.upstreamHttpStatus]),
		[['upstream_headers_observed', 200]]);
	assert.equal(capture.handoff().economicOutcomes[0]?.usageCertainty, 'unknown');
});

test('late headers cannot rewrite a request already settled as transport ambiguous', async () => {
	const capture = createSharedKeyQuoteAttemptCapture('request-late', async input => reference(input));
	const claimed = await capture.beforeFetch(route('sharedkey:key-a'));
	assert.ok(claimed);
	assert.throws(() => capture.fetchBoundaryPermitted({ ...claimed }), /Unowned/);
	capture.fetchBoundaryPermitted(claimed);
	capture.transportAmbiguous(claimed);
	assert.doesNotThrow(() => capture.upstreamHeadersObserved(claimed, 200));
	assert.deepEqual(capture.handoff().transport.map(row => [row.stage, row.upstreamHttpStatus]),
		[['transport_ambiguous', null]]);
});

test('partition-none global loop forwards the same request-scoped capture', async () => {
	const selected = { ...route('sharedkey:key-a'), gatewayCandidateIndex: 0,
		gatewayGlobalEndpointRank: 1, gatewayModelId: 'model-a' };
	const capture = createSharedKeyQuoteAttemptCapture('request-global',
		async input => reference(input));
	let forwarded = false;
	const result = await dispatchGlobalModelFallback({
		repos: {} as GatewayRepositories,
		candidates: [{ requestedModelId: 'model-a', baseModelId: 'model-a',
			effectiveRouteGroup: 'default', upstreamBody: { model: 'model-a' },
			routes: [selected] } as ModelFallbackCandidatePlan],
		globalRoutes: [selected], userId: 'synthetic-user',
		publicCorrelationId: 'request-global', timing: new RequestTimingCollector(),
		beforeUpstreamDispatch: async () => {},
		quoteAttemptCapture: capture,
		proxy: async (_repos, _routes, _body, _signal, passed) => {
			forwarded = passed?.quoteAttemptCapture === capture;
			await passed?.quoteAttemptCapture?.beforeFetch(selected);
			return { response: new Response('ok'), usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null, chosenRoute: selected, circuitEvents: [],
				suppressErrorAlert: false };
		},
		affinityKey: 'request-global', tierKeyPrefix: 'tier-global',
	});
	assert.equal(result.ok, true);
	assert.equal(forwarded, true);
	assert.equal(capture.references()[0]?.requestLogId, 'request-global');
});
