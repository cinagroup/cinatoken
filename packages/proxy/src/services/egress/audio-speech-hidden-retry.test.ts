import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import { proxyAudioSpeech } from '../proxy';
import { resetProviderCircuitStateForTests } from '../provider-circuit-breaker';
import { materializeNonOkResponse } from '../request-log-record-status';
import {
	dispatchDashScopeMiniMaxTts,
	dispatchDashScopeQwenTts,
	dispatchDashScopeSpeechSynthesizer,
	dispatchOpenAiAudioSpeech,
	type AudioSpeechDispatchOptions,
	type NormalizedAudioSpeechRequest,
} from './audio-speech-driver';

type Variant = 'openai' | 'speech' | 'qwen' | 'minimax';
const variants: Variant[] = ['openai', 'speech', 'qwen', 'minimax'];
const speech: NormalizedAudioSpeechRequest = {
	input: 'hello', voice: 'synthetic', responseFormat: 'wav', speed: 1, streamFormat: 'audio',
};

function route(variant: Variant, index: number, origin: string): RouteResult {
	return {
		targetId: `speech-target-${index}`, modelSurfaceId: null, routePoolId: null,
		providerId: `speech-provider-${index}`, providerName: 'Synthetic', providerModelName: 'synthetic-tts',
		upstreamProtocol: variant === 'openai' ? 'openai' : 'dashscope',
		upstreamOperation: variant === 'openai' || variant === 'speech' ? 'audio.speech' : 'audio.speech.multimodal',
		adapter: variant === 'openai' ? 'passthrough' : variant === 'speech' ? 'dashscope-tts-speech'
			: variant === 'qwen' ? 'dashscope-tts-qwen' : 'dashscope-tts-minimax',
		providerEndpoints: {
			openai: { base: `${origin}/${index}/v1` }, dashscope: { base: `${origin}/${index}/api/v1` },
		},
		providerApiKey: 'synthetic-key', providerSharedChannelType: null,
		priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: null, routeGroup: 'default', routePriority: 2 - index, routeWeight: 1,
		gatewayCandidateIndex: index,
	};
}

function dispatch(variant: Variant, candidate: RouteResult, options: AudioSpeechDispatchOptions) {
	const driver = variant === 'openai' ? dispatchOpenAiAudioSpeech
		: variant === 'speech' ? dispatchDashScopeSpeechSynthesizer
		: variant === 'qwen' ? dispatchDashScopeQwenTts : dispatchDashScopeMiniMaxTts;
	return driver(candidate, speech, undefined, undefined, undefined, options);
}

for (const variant of variants) {
	for (const status of [307, 503] as const) {
		it(`${variant}: Node loopback ${status} after complete TTS POST cannot trigger a second candidate`, { timeout: 5000 }, async t => {
			resetProviderCircuitStateForTests();
			let posts = 0;
			let redirects = 0;
			const server = createServer(async (incoming, outgoing) => {
				for await (const _chunk of incoming) { /* Confirm the provider received the entire POST. */ }
				if (incoming.url === '/redirected') {
					redirects++;
					outgoing.writeHead(200);
					outgoing.end('unexpected redirect');
					return;
				}
				assert.equal(incoming.method, 'POST');
				posts++;
				outgoing.writeHead(status, { Location: '/redirected', 'Content-Type': 'application/json' });
				outgoing.end(JSON.stringify({ error: { message: 'synthetic upstream response' } }));
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			t.after(() => { server.closeAllConnections(); server.close(); });
			const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const candidates = [route(variant, 0, origin), route(variant, 1, origin)];
			const result = await proxyAudioSpeech({} as GatewayRepositories, candidates, speech, undefined, {
				affinityKey: `${variant}-${status}`, tierKeyPrefix: `${variant}-${status}`,
				strategy: 'weight_priority', crossModelCandidateFailover: true,
			});
			assert.equal(posts, 1);
			assert.equal(redirects, 0);
			assert.equal(result.response.status, status);
			assert.equal(result.meta?.upstreamOutcomeUnknown, true);
			assert.equal(result.meta?.failoverForbidden, true);
			const publicError = await materializeNonOkResponse(result.response);
			assert.equal(publicError.response.headers.get('Location'), null);
			assert.equal(publicError.response.status, status === 307 ? 502 : 503);
			assert.doesNotMatch(await publicError.response.text(), /synthetic upstream response/);
		});
	}

	it(`${variant}: HTTP status and failed error-body reads preserve unknown versus clear rejection`, async () => {
		for (const status of [300, 301, 302, 303, 304, 307, 308, 408, 499, 500, 503, 524, 400, 401, 429]) {
			let redirect: RequestRedirect | undefined;
			const result = await dispatch(variant, route(variant, 0, 'https://upstream.example'), {
				fetchImpl: async (_input, init) => {
					redirect = init?.redirect;
					return new Response(status === 304 ? null : '{}', { status });
				},
			});
			const unknown = status >= 300 && status < 400 || status === 408 || status === 499 || status >= 500;
			assert.equal(redirect, 'manual');
			assert.equal(result.meta?.upstreamOutcomeUnknown === true, unknown, `status ${status}`);
			assert.equal(result.meta?.failoverForbidden === true, unknown, `status ${status}`);
			await result.response.text();
		}
		for (const status of [307, 503, 400, 429]) {
			const source = new ReadableStream<Uint8Array>({
				pull(controller) { controller.error(new Error('PRIVATE_RESPONSE_BODY_DETAIL')); },
			});
			const result = await dispatch(variant, route(variant, 0, 'https://upstream.example'), {
				fetchImpl: async () => new Response(source, { status }),
			});
			assert.equal(result.meta?.upstreamOutcomeUnknown === true, status === 307 || status === 503, `body read ${status}`);
			assert.equal(result.meta?.failoverForbidden === true, status === 307 || status === 503, `body read ${status}`);
			assert.doesNotMatch(await result.response.text(), /PRIVATE_RESPONSE_BODY_DETAIL/);
		}
	});

	it(`${variant}: a clear 429 may use the next bounded candidate`, { timeout: 5000 }, async t => {
		resetProviderCircuitStateForTests();
		let posts = 0;
		const server = createServer(async (incoming, outgoing) => {
			for await (const _chunk of incoming) { /* Read each complete attempt. */ }
			assert.equal(incoming.method, 'POST');
			posts++;
			outgoing.writeHead(posts === 1 ? 429 : 400, { 'Content-Type': 'application/json' });
			outgoing.end('{}');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		t.after(() => { server.closeAllConnections(); server.close(); });
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const result = await proxyAudioSpeech({} as GatewayRepositories,
			[route(variant, 0, origin), route(variant, 1, origin)], speech, undefined, {
				affinityKey: `${variant}-429`, tierKeyPrefix: `${variant}-429`,
				strategy: 'weight_priority', crossModelCandidateFailover: true,
			});
		assert.equal(posts, 2);
		assert.equal(result.response.status, 400);
		assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
		await result.response.text();
	});
}
