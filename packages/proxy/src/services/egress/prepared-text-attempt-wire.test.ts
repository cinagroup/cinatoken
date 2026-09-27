import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { test } from 'node:test';
import type { RouteResult } from '../model-router';
import { dispatchAnthropicRoute } from './anthropic-driver';
import { dispatchGeminiRoute } from './gemini-driver';
import { dispatchOpenAiRoute } from './openai-driver';
import { dispatchOpenAiResponsesRoute } from './openai-responses-driver';
import { preparedTextAttemptMatchesRoute, type PreparedTextAttempt } from './prepared-text-attempt';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Wire = { method: string | undefined; path: string; headers: IncomingHttpHeaders; body: Buffer };

function route(protocol: 'openai' | 'anthropic' | 'gemini', origin: string): RouteResult {
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
		providerEndpoints: { [protocol]: { base: `${origin}/${protocol === 'gemini' ? 'v1beta/models' : 'v1'}` } },
		providerApiKey: `secret-${protocol}`,
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 1,
		routeWeight: 1,
		providerKeyId: `key-${protocol}`,
		providerKeyLabel: null,
		providerKeyFingerprint: null,
	};
}

test('prepared text identity commits to the real loopback URL, method, JSON bytes and effective credential', async () => {
	const wires: Wire[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', chunk => chunks.push(Buffer.from(chunk)));
		request.on('end', () => {
			wires.push({ method: request.method, path: request.url ?? '', headers: request.headers,
				body: Buffer.concat(chunks) });
			response.writeHead(400, { 'content-type': 'application/json' });
			response.end('{}');
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const origin = `http://127.0.0.1:${address.port}`;
		const cases: Array<{
			name: string;
			selected: RouteResult;
			send: (beforeFetch: (prepared: PreparedTextAttempt) => Promise<void>) => Promise<unknown>;
			binding: PreparedTextAttempt['credentialBindings'][number]['location'];
		}> = [
			{ name: 'chat', selected: route('openai', origin), binding: 'authorization-bearer',
				send: beforeFetch => dispatchOpenAiRoute(route('openai', origin), { messages: [{ role: 'user', content: 'hello' }] },
					undefined, undefined, undefined, beforeFetch) },
			{ name: 'responses', selected: route('openai', origin), binding: 'authorization-bearer',
				send: beforeFetch => dispatchOpenAiResponsesRoute(route('openai', origin), { input: 'hello' },
					undefined, undefined, undefined, beforeFetch) },
			{ name: 'anthropic', selected: route('anthropic', origin), binding: 'x-api-key',
				send: beforeFetch => dispatchAnthropicRoute(route('anthropic', origin), { messages: [] },
					undefined, undefined, undefined, beforeFetch) },
			{ name: 'gemini-query', selected: route('gemini', origin), binding: 'query-key',
				send: beforeFetch => dispatchGeminiRoute(route('gemini', origin), {}, 'generateContent', '',
					undefined, undefined, undefined, beforeFetch) },
			{ name: 'gemini-existing-query-key', selected: route('gemini', origin), binding: 'query-key',
				send: beforeFetch => dispatchGeminiRoute(route('gemini', origin), {}, 'generateContent',
					'key=key-from-route-query', undefined, undefined, undefined, beforeFetch) },
			{ name: 'gemini-bearer', selected: (() => {
				const selected = route('gemini', origin);
				selected.providerEndpoints = { gemini: { base: `${origin}/v1beta/models`, auth: 'bearer' } };
				return selected;
			})(), binding: 'authorization-bearer',
				send: beforeFetch => {
				const selected = route('gemini', origin);
				selected.providerEndpoints = { gemini: { base: `${origin}/v1beta/models`, auth: 'bearer' } };
				return dispatchGeminiRoute(selected, {}, 'generateContent', '',
					undefined, undefined, undefined, beforeFetch);
			} },
		];
		for (const item of cases) {
			let prepared: PreparedTextAttempt | undefined;
			const previous = wires.length;
			await item.send(async attempt => {
				assert.equal(wires.length, previous, `${item.name}: no wire before admission`);
				prepared = attempt;
			});
			assert.ok(prepared, `${item.name}: prepared identity`);
			assert.equal(wires.length, previous + 1, `${item.name}: one wire`);
			const wire = wires[previous]!;
			const absoluteUrl = new URL(wire.path, origin).toString();
			assert.equal(prepared.method, wire.method);
			assert.equal(prepared.upstreamUrlSha256, sha256(absoluteUrl));
			assert.equal(prepared.outboundBodySha256, sha256(wire.body));
			assert.equal(prepared.outboundBodyBytes, wire.body.byteLength);
			assert.equal(preparedTextAttemptMatchesRoute(prepared, item.selected), true);
			assert.equal(Object.isFrozen(prepared), true);
			assert.equal(Object.isFrozen(prepared.routeIdentity), true);
			assert.equal(Object.isFrozen(prepared.credentialBindings), true);
			const actualSecret = item.binding === 'query-key'
				? new URL(absoluteUrl).searchParams.get('key')
				: item.binding === 'x-api-key'
					? wire.headers['x-api-key']
					: wire.headers.authorization?.replace(/^Bearer /, '');
			assert.equal(typeof actualSecret, 'string');
			assert.deepEqual(prepared.credentialBindings.map(binding => binding.location), [item.binding]);
			assert.equal(prepared.credentialBindings[0]!.sha256, sha256(actualSecret!));
			if (item.name === 'gemini-existing-query-key') {
				assert.equal(actualSecret, 'key-from-route-query');
				assert.notEqual(prepared.credentialBindings[0]!.sha256, sha256('secret-gemini'));
			}
			assert.equal(JSON.stringify(prepared).includes(actualSecret!), false);
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});

test('callback mutation cannot change the already frozen JSON wire projection or captured credential', async () => {
	let wireBody = '';
	let wireAuth = '';
	const original = globalThis.fetch;
	globalThis.fetch = (async (_input, init) => {
		wireBody = await new Response(init?.body).text();
		wireAuth = new Headers(init?.headers).get('authorization') ?? '';
		return new Response('{}', { status: 400 });
	}) as typeof fetch;
	try {
		const selected = route('openai', 'https://provider.example');
		const body = { messages: [{ role: 'user', content: 'before' }] };
		let prepared: PreparedTextAttempt | undefined;
		await dispatchOpenAiRoute(selected, body, undefined, undefined, undefined, async attempt => {
			prepared = attempt;
			body.messages[0]!.content = 'after';
			selected.providerApiKey = 'rotated-secret';
			assert.equal(preparedTextAttemptMatchesRoute(attempt, selected), false);
		});
		assert.ok(prepared);
		assert.match(wireBody, /before/);
		assert.doesNotMatch(wireBody, /after/);
		assert.equal(prepared.outboundBodySha256, sha256(wireBody));
		assert.equal(wireAuth, 'Bearer secret-openai');
		assert.equal(prepared.credentialBindings[0]!.sha256, sha256('secret-openai'));
	} finally {
		globalThis.fetch = original;
	}
});
