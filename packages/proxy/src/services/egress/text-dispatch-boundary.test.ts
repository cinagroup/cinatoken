import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RouteResult } from '../model-router';
import { dispatchAnthropicRoute } from './anthropic-driver';
import { dispatchGeminiRoute } from './gemini-driver';
import { dispatchOpenAiRoute } from './openai-driver';
import { dispatchOpenAiResponsesRoute } from './openai-responses-driver';

function route(protocol: 'openai' | 'anthropic' | 'gemini'): RouteResult {
	return {
		targetId: `target-${protocol}`,
		modelSurfaceId: 'surface-text',
		routePoolId: 'pool-text',
		providerId: `provider-${protocol}`,
		providerName: `Provider ${protocol}`,
		providerModelName: protocol === 'gemini' ? 'gemini-2.5-flash' : 'private-model',
		gatewayModelId: 'public/model',
		upstreamProtocol: protocol,
		upstreamOperation: protocol === 'anthropic' ? 'messages' : protocol === 'gemini' ? 'models.generate' : 'chat',
		adapter: 'passthrough',
		providerEndpoints: protocol === 'gemini'
			? { gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/models' } }
			: { [protocol]: { base: 'https://provider.test/v1' } },
		providerApiKey: 'provider-secret',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 1,
		routeWeight: 1,
		providerKeyId: null,
		providerKeyLabel: null,
		providerKeyFingerprint: null,
	};
}

async function withFetch(
	implementation: typeof fetch,
	run: () => Promise<void>,
): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = implementation;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
}

test('text drivers cross the admission boundary only after local preparation and immediately before fetch', async () => {
	const events: string[] = [];
	let fetchCalls = 0;
	await withFetch(
		(async (_input, init) => {
			fetchCalls += 1;
			events.push('fetch');
			assert.equal(typeof init?.body, 'string');
			return new Response('{}', { status: 400 });
		}) as typeof fetch,
		async () => {
			const beforeFetch = async (): Promise<void> => {
				assert.equal(fetchCalls, 0);
				events.push('admission');
			};

			await dispatchOpenAiRoute(route('openai'), { messages: [] }, undefined, undefined, undefined, beforeFetch);
			fetchCalls = 0;
			await dispatchOpenAiResponsesRoute(route('openai'), { input: 'hi' }, undefined, undefined, undefined, beforeFetch);
			fetchCalls = 0;
			await dispatchAnthropicRoute(route('anthropic'), { messages: [] }, undefined, undefined, undefined, beforeFetch);
			fetchCalls = 0;
			await dispatchGeminiRoute(route('gemini'), {}, 'generateContent', '', undefined, undefined, undefined, beforeFetch);
		},
	);

	assert.deepEqual(events, [
		'admission', 'fetch',
		'admission', 'fetch',
		'admission', 'fetch',
		'admission', 'fetch',
	]);
});

test('OpenAI Chat streaming forces terminal usage without discarding compatible stream options', async () => {
	await withFetch(
		(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as {
				stream_options?: Record<string, unknown>;
			};
			assert.deepEqual(body.stream_options, {
				exclude_aggregated_audio: true,
				include_usage: true,
			});
			return new Response('{}', { status: 400 });
		}) as typeof fetch,
		async () => {
			await dispatchOpenAiRoute(route('openai'), {
				messages: [],
				stream: true,
				stream_options: {
					include_usage: false,
					exclude_aggregated_audio: true,
				},
			});
		},
	);
});

test('verified service-tier selection overrides stale client or route defaults immediately before egress', async () => {
	const bodies: Record<string, unknown>[] = [];
	await withFetch(
		(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response('{}', { status: 400 });
		}) as typeof fetch,
		async () => {
			const flexRoute = route('openai');
			flexRoute.gatewayServiceTier = 'flex';
			flexRoute.customParams = { service_tier: 'priority' };
			await dispatchOpenAiRoute(flexRoute, {
				messages: [],
				service_tier: 'default',
			});

			const standardRoute = route('anthropic');
			standardRoute.gatewayServiceTier = 'default';
			await dispatchAnthropicRoute(standardRoute, {
				messages: [],
				service_tier: 'priority',
			});
		},
	);

	assert.deepEqual(bodies.map((body) => body.service_tier), ['flex', 'default']);
});

test('verified text-speed capability controls egress and strips unsupported route defaults', async () => {
	const bodies: Record<string, unknown>[] = [];
	await withFetch(
		(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response('{}', { status: 400 });
		}) as typeof fetch,
		async () => {
			const fastRoute = route('openai');
			fastRoute.gatewayTextSpeedControlled = true;
			fastRoute.gatewayTextSpeed = 'fast';
			fastRoute.gatewayRequestedServiceTier = 'priority';
			fastRoute.customParams = { speed: 'standard', service_tier: 'default' };
			await dispatchOpenAiRoute(fastRoute, { messages: [], speed: 'standard' });

			const unsupportedRoute = route('anthropic');
			unsupportedRoute.gatewayTextSpeedControlled = true;
			unsupportedRoute.customParams = { speed: 'fast' };
			await dispatchAnthropicRoute(unsupportedRoute, { messages: [] });
		},
	);

	assert.equal(bodies[0]?.speed, 'fast');
	assert.equal(bodies[0]?.service_tier, 'priority');
	assert.equal('speed' in bodies[1]!, false);
});

test('text driver fetch rejection is marked as an unknown upstream outcome', async () => {
	await withFetch(
		(async () => {
			throw new TypeError('connection reset');
		}) as typeof fetch,
		async () => {
			const calls = [
				() => dispatchOpenAiRoute(route('openai'), { messages: [] }),
				() => dispatchOpenAiResponsesRoute(route('openai'), { input: 'hi' }),
				() => dispatchAnthropicRoute(route('anthropic'), { messages: [] }),
				() => dispatchGeminiRoute(route('gemini'), {}, 'generateContent', ''),
			];
			for (const call of calls) {
				await assert.rejects(
					call(),
					(error: unknown) =>
						error instanceof TypeError
						&& (error as { upstreamOutcomeUnknown?: boolean }).upstreamOutcomeUnknown === true,
				);
			}
		},
	);
});

test('pre-cancelled text requests do not cross or mark the admission boundary', async () => {
	const controller = new AbortController();
	controller.abort(new DOMException('client disconnected', 'AbortError'));
	let fetchCalls = 0;
	let admissionCalls = 0;
	await withFetch(
		(async () => {
			fetchCalls += 1;
			return Response.json({ error: 'must not run' });
		}) as typeof fetch,
		async () => {
			const beforeFetch = async (): Promise<void> => {
				admissionCalls += 1;
			};
			const calls = [
				() => dispatchOpenAiRoute(
					route('openai'), { messages: [] }, controller.signal,
					undefined, undefined, beforeFetch, 'gen-pre-cancelled',
				),
				() => dispatchOpenAiResponsesRoute(
					route('openai'), { input: 'hi' }, controller.signal,
					undefined, undefined, beforeFetch, 'gen-pre-cancelled',
				),
				() => dispatchAnthropicRoute(
					route('anthropic'), { messages: [] }, controller.signal,
					undefined, undefined, beforeFetch, 'gen-pre-cancelled',
				),
			];
			for (const call of calls) {
				const result = await call();
				assert.equal(result.response.status, 499);
				assert.equal(result.meta?.upstreamOutcomeUnknown, undefined);
				assert.equal(result.meta?.failoverForbidden, true);
				assert.equal(result.meta?.gatewayGeneratedError, true);
				assert.equal((await result.usagePromise).cancelled, true);
			}
		},
	);

	assert.equal(admissionCalls, 0);
	assert.equal(fetchCalls, 0);
});

test('text requests cancelled while admission is pending never reach fetch', async () => {
	let fetchCalls = 0;
	await withFetch(
		(async () => {
			fetchCalls += 1;
			return Response.json({ error: 'must not run' });
		}) as typeof fetch,
		async () => {
			const calls = [
				(signal: AbortSignal, beforeFetch: () => Promise<void>) => dispatchOpenAiRoute(
					route('openai'), { messages: [] }, signal,
					undefined, undefined, beforeFetch, 'gen-admission-cancelled-chat',
				),
				(signal: AbortSignal, beforeFetch: () => Promise<void>) => dispatchOpenAiResponsesRoute(
					route('openai'), { input: 'hi' }, signal,
					undefined, undefined, beforeFetch, 'gen-admission-cancelled-responses',
				),
				(signal: AbortSignal, beforeFetch: () => Promise<void>) => dispatchAnthropicRoute(
					route('anthropic'), { messages: [] }, signal,
					undefined, undefined, beforeFetch, 'gen-admission-cancelled-anthropic',
				),
			];

			for (const call of calls) {
				const controller = new AbortController();
				let releaseAdmission!: () => void;
				let markAdmissionEntered!: () => void;
				const admissionEntered = new Promise<void>((resolve) => {
					markAdmissionEntered = resolve;
				});
				const admissionRelease = new Promise<void>((resolve) => {
					releaseAdmission = resolve;
				});
				const beforeFetch = async (): Promise<void> => {
					markAdmissionEntered();
					await admissionRelease;
				};

				const resultPromise = call(controller.signal, beforeFetch);
				await admissionEntered;
				controller.abort(new DOMException('client disconnected', 'AbortError'));
				releaseAdmission();
				const result = await resultPromise;

				assert.equal(result.response.status, 499);
				assert.equal(result.meta?.upstreamOutcomeUnknown, undefined);
				assert.equal(result.meta?.failoverForbidden, true);
				assert.equal(result.meta?.gatewayGeneratedError, true);
				assert.equal((await result.usagePromise).cancelled, true);
			}
		},
	);

	assert.equal(fetchCalls, 0);
});

test('invalid local endpoint configuration never crosses the dispatch boundary', async () => {
	let fetchCalls = 0;
	let admissionCalls = 0;
	await withFetch(
		(async () => {
			fetchCalls += 1;
			return new Response('{}', { status: 400 });
		}) as typeof fetch,
		async () => {
			const beforeFetch = async (): Promise<void> => {
				admissionCalls += 1;
			};
			const invalidOpenAi = route('openai');
			invalidOpenAi.providerEndpoints = { openai: { base: 'ftp://provider.test/v1' } };
			const invalidAnthropic = route('anthropic');
			invalidAnthropic.providerEndpoints = { anthropic: { base: 'not-a-url' } };
			const invalidGemini = route('gemini');
			invalidGemini.providerEndpoints = { gemini: { base: 'ftp://provider.test/v1/models' } };

			const calls = [
				() => dispatchOpenAiRoute(invalidOpenAi, { messages: [] }, undefined, undefined, undefined, beforeFetch),
				() => dispatchOpenAiResponsesRoute(invalidOpenAi, { input: 'hi' }, undefined, undefined, undefined, beforeFetch),
				() => dispatchAnthropicRoute(invalidAnthropic, { messages: [] }, undefined, undefined, undefined, beforeFetch),
				() => dispatchGeminiRoute(invalidGemini, {}, 'generateContent', '', undefined, undefined, undefined, beforeFetch),
			];
			for (const call of calls) {
				await assert.rejects(call(), /valid URL|http\(s\)/i);
			}
		},
	);

	assert.equal(admissionCalls, 0);
	assert.equal(fetchCalls, 0);
});
