import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from './gateway-error-codes';
import {
	classifyUpstreamErrorCode,
	gatewayErrorJson,
	gatewayErrorResponse,
	withUpstreamErrorCodeHeader,
} from './gateway-error-response';

describe('gateway-error-response', () => {
	it('emits OpenRouter nested errors and keeps the legacy code/header as additive compatibility', async () => {
		const app = new Hono();
		app.get('/v1/chat/completions', (c) =>
			gatewayErrorJson(c, {
				status: 403,
				code: GatewayErrorCode.budgetExceeded,
				message: 'Budget exceeded',
			}),
		);
		const res = await app.request('/v1/chat/completions');
		assert.equal(res.status, 402);
		assert.equal(res.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.budgetExceeded);
		assert.equal(res.headers.get('Cache-Control'), 'no-store');
		const body = (await res.json()) as {
			error: { code: number; message: string; metadata: { error_type: string } };
			code: string;
		};
		assert.deepEqual(body.error, {
			code: 402,
			message: 'Budget exceeded',
			metadata: { error_type: 'payment_required' },
		});
		assert.equal(body.code, GatewayErrorCode.budgetExceeded);
	});

	it('uses the Anthropic Messages skin for request-stage errors', async () => {
		const app = new Hono();
		app.get('/api/v1/messages', (c) => gatewayErrorJson(c, {
			status: 401,
			code: GatewayErrorCode.authFailed,
			message: 'Invalid API key',
		}));
		const res = await app.request('/api/v1/messages');
		assert.equal(res.status, 401);
		assert.deepEqual(await res.json(), {
			type: 'error',
			error: {
				type: 'authentication_error',
				message: 'Invalid API key',
				error_type: 'authentication',
			},
			request_id: null,
			code: GatewayErrorCode.authFailed,
		});
	});

	it('uses the assigned generation id only for post-auth Anthropic request errors', async () => {
		const app = new Hono<{ Variables: { generationId: string } }>();
		app.use('*', async (c, next) => {
			c.set('generationId', 'gen-messages-request');
			await next();
		});
		app.get('/api/v1/messages', (c) => gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'Invalid Messages request',
		}));
		const res = await app.request('/api/v1/messages');
		const body = (await res.json()) as { request_id: string | null };
		assert.equal(body.request_id, 'gen-messages-request');
	});

	it('masks runtime/provider details in gateway-produced 5xx errors', async () => {
		const res = gatewayErrorResponse({
			status: 502,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: 'fetch failed Authorization: Bearer secret-value sk-secret12345678',
		});
		const body = (await res.json()) as {
			error: { code: number; message: string; metadata: { error_type: string } };
			code: string;
		};
		assert.equal(res.status, 502);
		assert.equal(body.error.message, 'Upstream provider is unavailable');
		assert.equal(body.error.metadata.error_type, 'provider_unavailable');
		assert.equal(body.code, GatewayErrorCode.upstreamRequestFailed);
	});

	it('publishes a generic 500 server error without leaking internal details', async () => {
		const res = gatewayErrorResponse({
			status: 500,
			code: GatewayErrorCode.internalError,
			message: 'SQL connection failed password=must-not-leak',
		});
		assert.equal(res.status, 500);
		assert.deepEqual(await res.json(), {
			error: {
				code: 500,
				message: 'Internal server error',
				metadata: { error_type: 'server' },
			},
			code: GatewayErrorCode.internalError,
		});
	});

	it('uses 404 for every empty eligible-provider set and 502 for route resolution failures', async () => {
		for (const code of [
			GatewayErrorCode.noRoute,
			GatewayErrorCode.zdrNoRoute,
			GatewayErrorCode.dataCollectionNoRoute,
		]) {
			const noRoute = gatewayErrorResponse({
				status: 503,
				code,
				message: 'internal candidate details',
			});
			assert.equal(noRoute.status, 404);
			assert.deepEqual(await noRoute.json(), {
				error: {
					code: 404,
					message: 'No available model provider meets the routing requirements',
					metadata: { error_type: 'not_found' },
				},
				code,
			});
		}

		const resolution = gatewayErrorResponse({
			status: 500,
			code: GatewayErrorCode.routeResolutionFailed,
			message: 'postgres row provider_secret=must-not-leak',
		});
		assert.equal(resolution.status, 502);
		const resolutionBody = JSON.stringify(await resolution.json());
		assert.match(resolutionBody, /provider_unavailable/);
		assert.doesNotMatch(resolutionBody, /provider_secret|must-not-leak/);
	});

	it('classifies upstream 400 as content_filter vs invalid_request', () => {
		assert.equal(
			classifyUpstreamErrorCode(
				400,
				'application/json',
				JSON.stringify({ error: { message: 'sensitive content blocked' } }),
			),
			GatewayErrorCode.upstreamContentFilter,
		);
		assert.equal(
			classifyUpstreamErrorCode(400, 'application/json', JSON.stringify({ error: { message: 'bad param' } })),
			GatewayErrorCode.upstreamInvalidRequest,
		);
	});

	it('normalizes bounded upstream errors and propagates Retry-After', async () => {
		const raw = JSON.stringify({ error: { message: 'rate limited', code: 'rate_limited' } });
		const res = withUpstreamErrorCodeHeader(new Response(raw, {
			status: 429,
			headers: {
				'Retry-After': '60',
				'X-Upstream-Secret-Debug': 'must-not-leak',
			},
		}), raw);
		assert.equal(res.status, 429);
		assert.equal(res.headers.get('Retry-After'), '60');
		assert.equal(res.headers.get('X-Upstream-Secret-Debug'), null);
		assert.equal(res.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.upstreamRateLimited);
		assert.deepEqual(await res.json(), {
			error: {
				code: 429,
				message: 'rate limited',
				metadata: {
					error_type: 'rate_limit_exceeded',
					provider_code: 'rate_limited',
				},
			},
			code: GatewayErrorCode.upstreamRateLimited,
		});
	});

	it('maps provider auth/5xx failures to a masked 502 without provider codes', async () => {
		for (const upstream of [
			new Response(JSON.stringify({ error: { message: 'bad upstream key sk-secret12345678', code: 'invalid_api_key' } }), { status: 401 }),
			new Response(JSON.stringify({ error: { message: 'database shard db-17 failed', code: 'internal_error' } }), { status: 500 }),
		]) {
			const raw = await upstream.clone().text();
			const res = withUpstreamErrorCodeHeader(upstream, raw);
			const body = (await res.json()) as {
				error: { code: number; message: string; metadata: Record<string, unknown> };
			};
			assert.equal(res.status, 502);
			assert.equal(body.error.code, 502);
			assert.equal(body.error.message, 'Upstream provider is unavailable');
			assert.equal(body.error.metadata.error_type, 'provider_unavailable');
			assert.equal('provider_code' in body.error.metadata, false);
			assert.doesNotMatch(JSON.stringify(body), /secret12345678|db-17|internal_error/);
		}
	});

	it('keeps provider service-unavailable as 503, not overloaded 529, and preserves Retry-After', async () => {
		const raw = JSON.stringify({ error: { message: 'node unavailable', code: 'service_unavailable' } });
		const res = withUpstreamErrorCodeHeader(new Response(raw, {
			status: 503,
			headers: { 'Retry-After': '7' },
		}), raw);
		assert.equal(res.status, 503);
		assert.equal(res.headers.get('Retry-After'), '7');
		const body = (await res.json()) as {
			error: { code: number; message: string; metadata: Record<string, unknown> };
		};
		assert.equal(body.error.code, 503);
		assert.equal(body.error.message, 'Upstream provider is unavailable');
		assert.equal(body.error.metadata.error_type, 'provider_unavailable');
		assert.equal('provider_code' in body.error.metadata, false);
		assert.doesNotMatch(JSON.stringify(body), /node unavailable|service_unavailable|provider_overloaded/);
	});

	it('uses OpenRouter 529 only for an explicitly overloaded provider', async () => {
		const raw = JSON.stringify({ error: { message: 'capacity exhausted', code: 'overloaded' } });
		const res = withUpstreamErrorCodeHeader(new Response(raw, {
			status: 529,
			headers: { 'Retry-After': '3' },
		}), raw);
		assert.equal(res.status, 529);
		assert.equal(res.headers.get('Retry-After'), '3');
		assert.deepEqual(await res.json(), {
			error: {
				code: 529,
				message: 'Upstream provider is temporarily overloaded',
				metadata: { error_type: 'provider_overloaded' },
			},
			code: GatewayErrorCode.upstreamServerError,
		});
	});
});
