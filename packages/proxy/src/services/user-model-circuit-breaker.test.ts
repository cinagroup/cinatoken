import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildClientErrorCircuitOpenResponse,
	buildSensitiveContentCircuitOpenResponse,
	buildUserModelCircuitOpenResponse,
	getUserModelCircuitOpen,
	isSensitiveUpstreamResponse,
	markUserModelSuccess,
	recordClientErrorCircuitTrigger,
	recordSensitiveContentCircuitTrigger,
	recordUserModelCircuitTrigger,
	resetUserModelCircuitStateForTests,
	USER_MODEL_BACKOFF_MS,
} from './user-model-circuit-breaker';
import { maybeTriggerUserModelCircuitFromUpstream } from './user-model-circuit-route';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from './gateway-error-codes';

afterEach(() => {
	resetUserModelCircuitStateForTests();
});

describe('user-model-circuit-breaker — unified backoff', () => {
	it('uses same ladder for sensitive_content and client_error', () => {
		const t0 = 1_000_000;
		recordSensitiveContentCircuitTrigger('u', 'm', 'sensitive', undefined, t0);
		assert.equal(getUserModelCircuitOpen('u', 'm', t0)!.retryAfterSeconds, 20);
		assert.equal(getUserModelCircuitOpen('u', 'm', t0)!.reason, 'sensitive_content');

		resetUserModelCircuitStateForTests();
		recordClientErrorCircuitTrigger('u', 'm', 'bad', t0);
		assert.equal(getUserModelCircuitOpen('u', 'm', t0)!.retryAfterSeconds, 20);
		assert.equal(getUserModelCircuitOpen('u', 'm', t0)!.reason, 'client_error');
	});

	it('escalates 20s → 1min → 3min → 5min → 10min across mixed reasons', () => {
		const t0 = 1_000_000;

		recordUserModelCircuitTrigger('u', 'm', 'sensitive_content', 's1', t0);
		assert.equal(getUserModelCircuitOpen('u', 'm', t0)!.retryAfterSeconds, 20);

		// open 窗口内不升级，但可更新 reason
		recordUserModelCircuitTrigger('u', 'm', 'client_error', 'c1', t0);
		assert.equal(getUserModelCircuitOpen('u', 'm', t0)!.retryAfterSeconds, 20);
		assert.equal(getUserModelCircuitOpen('u', 'm', t0)!.reason, 'client_error');

		let t = t0 + USER_MODEL_BACKOFF_MS[0];
		recordUserModelCircuitTrigger('u', 'm', 'sensitive_content', 's2', t);
		assert.equal(getUserModelCircuitOpen('u', 'm', t)!.retryAfterSeconds, 60);

		t += USER_MODEL_BACKOFF_MS[1];
		recordUserModelCircuitTrigger('u', 'm', 'client_error', 'c2', t);
		assert.equal(getUserModelCircuitOpen('u', 'm', t)!.retryAfterSeconds, 180);

		t += USER_MODEL_BACKOFF_MS[2];
		recordUserModelCircuitTrigger('u', 'm', 'client_error', 'c3', t);
		assert.equal(getUserModelCircuitOpen('u', 'm', t)!.retryAfterSeconds, 300);

		t += USER_MODEL_BACKOFF_MS[3];
		recordUserModelCircuitTrigger('u', 'm', 'sensitive_content', 's3', t);
		assert.equal(getUserModelCircuitOpen('u', 'm', t)!.retryAfterSeconds, 600);

		t += USER_MODEL_BACKOFF_MS[4];
		recordUserModelCircuitTrigger('u', 'm', 'client_error', 'c4', t);
		assert.equal(getUserModelCircuitOpen('u', 'm', t)!.retryAfterSeconds, 600);
	});

	it('clears any reason on success', () => {
		const t0 = 1_000_000;
		recordSensitiveContentCircuitTrigger('u', 'm', 'sensitive', undefined, t0);
		markUserModelSuccess('u', 'm', t0);
		assert.equal(getUserModelCircuitOpen('u', 'm', t0), null);

		recordClientErrorCircuitTrigger('u', 'm', 'bad', t0);
		markUserModelSuccess('u', 'm', t0);
		assert.equal(getUserModelCircuitOpen('u', 'm', t0), null);
	});

	it('scopes circuit by model id', () => {
		recordClientErrorCircuitTrigger('user-1', 'glm-5.2');
		assert.ok(getUserModelCircuitOpen('user-1', 'glm-5.2'));
		assert.equal(getUserModelCircuitOpen('user-1', 'gpt-4.1'), null);
	});
});

describe('user-model-circuit-breaker — short-circuit response codes', () => {
	it('sensitive short-circuit is 429 + circuit.sensitive_content', async () => {
		const info = recordSensitiveContentCircuitTrigger('user-1', 'glm-5.2');
		const res = buildSensitiveContentCircuitOpenResponse(info);
		assert.equal(res.status, 429);
		assert.equal(res.headers.get('Retry-After'), String(info.retryAfterSeconds));
		assert.equal(res.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.circuitSensitiveContent);
		const body = (await res.json()) as {
			error: { code: number; metadata: { error_type: string; retry_after_seconds: number } };
			code: string;
		};
		assert.equal(body.error.code, 429);
		assert.equal(body.error.metadata.error_type, 'rate_limit_exceeded');
		assert.equal(body.error.metadata.retry_after_seconds, info.retryAfterSeconds);
		assert.equal(body.code, GatewayErrorCode.circuitSensitiveContent);
	});

	it('client_error short-circuit is 400 + circuit.client_error', async () => {
		const info = recordClientErrorCircuitTrigger('u', 'm', 'HTTP 400: invalid temperature');
		const res = buildClientErrorCircuitOpenResponse(info);
		assert.equal(res.status, 400);
		assert.equal(res.headers.get('Retry-After'), null);
		assert.equal(res.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.circuitClientError);
		const body = (await res.json()) as {
			error: { code: number; message: string; metadata: { error_type: string; reason: string } };
			code: string;
		};
		assert.equal(body.error.code, 400);
		assert.equal(body.error.metadata.error_type, 'invalid_request');
		assert.equal(body.error.metadata.reason, 'upstream_client_error_circuit_open');
		assert.match(body.error.message, /invalid temperature/);
		assert.equal(body.code, GatewayErrorCode.circuitClientError);
	});

	it('uses post-Router generation ids in Responses and Anthropic circuit envelopes', async () => {
		const info = recordUserModelCircuitTrigger('u-skins', 'm-skins', 'sensitive_content', undefined, 1_000);
		const responses = buildUserModelCircuitOpenResponse(info, {
			skin: 'responses',
			requestId: 'gen-responses-circuit',
		});
		assert.deepEqual(await responses.json(), {
			status: 'failed',
			error: {
				code: 'rate_limit_exceeded',
				message: `Sensitive content was blocked upstream. Please retry this user/model after ${info.retryAfterSeconds} seconds.`,
			},
			error_type: 'rate_limit_exceeded',
			id: 'gen-responses-circuit',
			code: GatewayErrorCode.circuitSensitiveContent,
		});

		const anthropic = buildUserModelCircuitOpenResponse(info, {
			skin: 'anthropic',
			requestId: 'gen-anthropic-circuit',
		});
		assert.deepEqual(await anthropic.json(), {
			type: 'error',
			error: {
				type: 'rate_limit_error',
				message: `Sensitive content was blocked upstream. Please retry this user/model after ${info.retryAfterSeconds} seconds.`,
				error_type: 'rate_limit_exceeded',
			},
			request_id: 'gen-anthropic-circuit',
			code: GatewayErrorCode.circuitSensitiveContent,
		});
	});
});

describe('user-model-circuit-breaker — trigger helper', () => {
	it('detects sensitive upstream responses', () => {
		assert.equal(
			isSensitiveUpstreamResponse(
				400,
				'application/json',
				JSON.stringify({
					error: {
						message:
							'系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示词。',
					},
				})
			),
			true
		);
		assert.equal(
			isSensitiveUpstreamResponse(400, 'application/json', JSON.stringify({ error: { message: 'bad request' } })),
			false
		);
	});

	it('returns user_model circuit event for sensitive vs client_error', () => {
		const sensitive = maybeTriggerUserModelCircuitFromUpstream(
			'user-1',
			'glm-5.2',
			400,
			'application/json',
			JSON.stringify({ error: { message: 'sensitive content blocked' } })
		);
		assert.equal(sensitive?.kind, 'user_model');
		assert.equal(sensitive?.reason, 'sensitive_content');
		assert.equal(sensitive?.cooldownMs, 20_000);

		resetUserModelCircuitStateForTests();
		const clientErr = maybeTriggerUserModelCircuitFromUpstream(
			'user-1',
			'glm-5.2',
			400,
			'application/json',
			JSON.stringify({ error: { message: 'invalid_request_error' } }),
			'HTTP 400: invalid_request_error'
		);
		assert.equal(clientErr?.kind, 'user_model');
		assert.equal(clientErr?.reason, 'client_error');
		assert.equal(clientErr?.cooldownMs, 20_000);
	});

	it('skips ordinary 400 when clientErrorCircuitEnabled is false (images/audio)', () => {
		const skipped = maybeTriggerUserModelCircuitFromUpstream(
			'user-1',
			'gpt-image-1',
			400,
			'application/json',
			JSON.stringify({ error: { message: 'Invalid size' } }),
			'HTTP 400: Invalid size',
			{ clientErrorCircuitEnabled: false }
		);
		assert.equal(skipped, null);
		assert.equal(getUserModelCircuitOpen('user-1', 'gpt-image-1'), null);
	});

	it('still records sensitive_content when clientErrorCircuitEnabled is false', () => {
		const sensitive = maybeTriggerUserModelCircuitFromUpstream(
			'user-1',
			'gpt-image-1',
			400,
			'application/json',
			JSON.stringify({ error: { message: 'sensitive content blocked' } }),
			'HTTP 400: sensitive content blocked',
			{ clientErrorCircuitEnabled: false }
		);
		assert.equal(sensitive?.kind, 'user_model');
		assert.equal(sensitive?.reason, 'sensitive_content');
		assert.equal(sensitive?.cooldownMs, 20_000);
		assert.equal(getUserModelCircuitOpen('user-1', 'gpt-image-1')!.reason, 'sensitive_content');
	});

	it('default (no options) still records ordinary 400 as client_error', () => {
		const clientErr = maybeTriggerUserModelCircuitFromUpstream(
			'user-1',
			'glm-5.2',
			400,
			'application/json',
			JSON.stringify({ error: { message: 'invalid temperature' } }),
			'HTTP 400: invalid temperature'
		);
		assert.equal(clientErr?.reason, 'client_error');
		assert.ok(getUserModelCircuitOpen('user-1', 'glm-5.2'));
	});
});
