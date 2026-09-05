import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from './model-router';
import type { ProviderPreferences } from './provider-routing-preferences';
import {
	buildOpenRouterSessionAffinityKey,
	OPENROUTER_SESSION_IDLE_TTL_SECONDS,
	openRouterSessionDispatchOptions,
	parseOpenRouterSessionHeader,
	prepareOpenRouterSessionRouting,
	resolveOpenRouterStickyRouting,
	routeHasBeneficialCacheReadPricing,
} from './openrouter-session-routing';

describe('OpenRouter session routing control', () => {
	const preferences = (order: string[]): ProviderPreferences => ({ order } as ProviderPreferences);
	const blankRouting = () => prepareOpenRouterSessionRouting({}, new Headers());

	it('uses a present body field over the header and strips it from the wire body', () => {
		const parsed = prepareOpenRouterSessionRouting(
			{ model: 'vendor/model', session_id: 'body-session' },
			new Headers({ 'x-session-id': 'header-session' }),
		);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual(parsed.body, { model: 'vendor/model' });
		assert.equal(parsed.routing.sessionId, 'body-session');
		assert.equal(parsed.routing.source, 'body');
	});

	it('falls back to the header and treats an explicit empty body value as no session', () => {
		const header = prepareOpenRouterSessionRouting(
			{ model: 'vendor/model' },
			new Headers({ 'x-session-id': 'header-session' }),
		);
		assert.equal(header.ok, true);
		if (header.ok) {
			assert.equal(header.routing.sessionId, 'header-session');
			assert.equal(header.routing.source, 'header');
		}

		const emptyBody = prepareOpenRouterSessionRouting(
			{ model: 'vendor/model', session_id: '' },
			new Headers({ 'x-session-id': 'ignored' }),
		);
		assert.equal(emptyBody.ok, true);
		if (emptyBody.ok) {
			assert.equal(emptyBody.routing.sessionId, null);
			assert.equal(emptyBody.routing.source, 'body');
		}
	});

	it('validates the string type and 256 Unicode-character boundary', () => {
		const accepted = prepareOpenRouterSessionRouting(
			{ session_id: '🧭'.repeat(256) },
			new Headers(),
		);
		assert.equal(accepted.ok, true);
		const rejected = prepareOpenRouterSessionRouting(
			{ session_id: '🧭'.repeat(257) },
			new Headers(),
		);
		assert.deepEqual(rejected, {
			ok: false,
			message: 'session_id must not exceed 256 characters',
		});
		assert.deepEqual(
			prepareOpenRouterSessionRouting({ session_id: 7 }, new Headers()),
			{ ok: false, message: 'session_id must be a string' },
		);
		assert.deepEqual(
			prepareOpenRouterSessionRouting({ session_id: '\ud800' }, new Headers()),
			{ ok: false, message: 'session_id must contain valid Unicode' },
		);
	});

	it('parses header-only session grouping without inventing a body control', () => {
		assert.deepEqual(parseOpenRouterSessionHeader(new Headers()), {
			ok: true, sessionId: null,
		});
		assert.deepEqual(parseOpenRouterSessionHeader(new Headers({ 'x-session-id': 'group-1' })), {
			ok: true, sessionId: 'group-1',
		});
		assert.deepEqual(parseOpenRouterSessionHeader(new Headers({ 'x-session-id': '' })), {
			ok: true, sessionId: null,
		});
		assert.deepEqual(parseOpenRouterSessionHeader(new Headers({
			'x-session-id': 'x'.repeat(257),
		})), {
			ok: false,
			message: 'x-session-id must not exceed 256 characters',
		});
	});

	it('uses session_id, then prompt_cache_key, then opening-message hashing', () => {
		const explicit = prepareOpenRouterSessionRouting(
			{ session_id: 'secret-session' },
			new Headers(),
		);
		assert.equal(explicit.ok, true);
		if (!explicit.ok) return;
		const explicitResolved = resolveOpenRouterStickyRouting(
			explicit.routing,
			{ prompt_cache_key: 'ignored', messages: [{ role: 'user', content: 'ignored' }] },
			'chat',
		);
		assert.equal(explicitResolved.stickySource, 'session_id');
		assert.equal(explicitResolved.stickySuccessPolicy, 'stream_success');

		const blank = blankRouting();
		assert.equal(blank.ok, true);
		if (!blank.ok) return;
		const cacheKey = resolveOpenRouterStickyRouting(
			blank.routing,
			{ prompt_cache_key: 'private-key', messages: [{ role: 'user', content: 'ignored' }] },
			'chat',
		);
		assert.equal(cacheKey.stickySource, 'prompt_cache_key');
		assert.equal(cacheKey.stickySuccessPolicy, 'cache_hit');
		assert.equal(cacheKey.stickyKeyDigest?.includes('private-key'), false);

		const messages = resolveOpenRouterStickyRouting(
			blank.routing,
			{
				messages: [
					{ role: 'system', content: { b: 2, a: 1 } },
					{ role: 'user', content: 'opening' },
					{ role: 'assistant', content: 'later output' },
				],
			},
			'chat',
		);
		const reordered = resolveOpenRouterStickyRouting(
			blank.routing,
			{
				messages: [
					{ content: { a: 1, b: 2 }, role: 'system' },
					{ content: 'opening', role: 'user' },
					{ role: 'assistant', content: 'different later output' },
				],
			},
			'chat',
		);
		assert.equal(messages.stickySource, 'messages');
		assert.equal(messages.stickyKeyDigest, reordered.stickyKeyDigest);
		assert.equal(messages.stickyKeyDigest?.includes('opening'), false);
	});

	it('derives protocol-appropriate opening pairs for Responses and Messages', () => {
		const blank = blankRouting();
		assert.equal(blank.ok, true);
		if (!blank.ok) return;
		const responses = resolveOpenRouterStickyRouting(
			blank.routing,
			{ instructions: 'be concise', input: 'hello' },
			'responses',
		);
		const anthropic = resolveOpenRouterStickyRouting(
			blank.routing,
			{ system: [{ type: 'text', text: 'be concise' }], messages: [{ role: 'user', content: 'hello' }] },
			'messages',
		);
		assert.equal(responses.stickySource, 'messages');
		assert.equal(anthropic.stickySource, 'messages');
		assert.notEqual(responses.stickyKeyDigest, anthropic.stickyKeyDigest);
	});

	it('builds an unambiguous tenant/model-scoped affinity key without raw conversation data', () => {
		const first = buildOpenRouterSessionAffinityKey({
			userId: 'user|one', workspaceId: 'workspace-a', stickyKeyDigest: 'a'.repeat(64),
			stickySource: 'session_id', baseModelId: 'model',
		});
		const second = buildOpenRouterSessionAffinityKey({
			userId: 'user', workspaceId: 'workspace-a', stickyKeyDigest: 'b'.repeat(64),
			stickySource: 'session_id', baseModelId: 'model',
		});
		assert.notEqual(first, second);
		assert.notEqual(first, buildOpenRouterSessionAffinityKey({
			userId: 'user|one', workspaceId: 'workspace-b', stickyKeyDigest: 'a'.repeat(64),
			stickySource: 'session_id', baseModelId: 'model',
		}));
	});

	it('forces a ten-minute sticky TTL unless explicit provider.order wins', () => {
		const parsed = prepareOpenRouterSessionRouting({ session_id: 'session-1' }, new Headers());
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const routing = resolveOpenRouterStickyRouting(parsed.routing, {}, 'chat');
		const common = {
			routing,
			userId: 'user-1', workspaceId: 'workspace-1', baseModelId: 'vendor/model', routeGroup: 'default',
			protocol: 'openai' as const, surface: null, hasProviderPreferences: true,
		};
		const sticky = openRouterSessionDispatchOptions({
			...common,
			routingPreferences: preferences([]),
		});
		assert.equal(OPENROUTER_SESSION_IDLE_TTL_SECONDS, 600);
		assert.equal(sticky.sticky?.enabled, true);
		assert.equal(sticky.sticky?.idleTtlSeconds, OPENROUTER_SESSION_IDLE_TTL_SECONDS);
		assert.equal(sticky.stickySuccessPolicy, 'stream_success');

		const ordered = openRouterSessionDispatchOptions({
			...common,
			routingPreferences: preferences(['provider-a']),
		});
		assert.equal(ordered.sticky, null);
		assert.equal(ordered.stickySuccessPolicy, null);
	});

	it('requires cache-read pricing to be lower than prompt pricing', () => {
		const route = (prompt: string, cacheRead?: string): RouteResult => ({
			endpoint: { pricing: { prompt, input_cache_read: cacheRead } },
		} as unknown as RouteResult);
		assert.equal(routeHasBeneficialCacheReadPricing(route('0.000002', '0.000001')), true);
		assert.equal(routeHasBeneficialCacheReadPricing(route('0.000001', '0.000001')), false);
		assert.equal(routeHasBeneficialCacheReadPricing(route('0.000001')), false);
	});
});
