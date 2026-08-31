import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from './gateway-error-codes';
import { gatewayErrorResponse } from './gateway-error-response';
import {
  computeRequestLogStatus,
  formatHttpErrorForRequestLog,
  materializeNonOkResponse,
  MAX_MATERIALIZED_ERROR_BODY_BYTES,
} from './request-log-record-status';

describe('request log stream status', () => {
  it('records a native 2xx stream error as failed', () => {
    assert.equal(computeRequestLogStatus({
      cancelled: false,
      responseOk: true,
      incomplete: false,
      streamError: true,
    }), 'error');
  });
});

function oversizedBody(): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(16 * 1024).fill(65);
  let emitted = 0;
  return new ReadableStream({
    pull(controller) {
      emitted += chunk.byteLength;
      controller.enqueue(chunk);
      if (emitted > MAX_MATERIALIZED_ERROR_BODY_BYTES) controller.close();
    },
  });
}

describe('bounded upstream error materialization', () => {
	it('preserves only explicitly trusted gateway-generated errors', async () => {
		const internal = gatewayErrorResponse({
			status: 502,
			code: GatewayErrorCode.upstreamResponseTooLarge,
			message: 'Upstream response exceeded the gateway size limit',
			skin: 'responses',
			requestId: 'gen-trusted',
		});
		const trusted = await materializeNonOkResponse(internal, {
			skin: 'responses',
			requestId: 'gen-trusted',
			trustedGatewayError: true,
		});
		assert.equal(
			trusted.response.headers.get(GATEWAY_ERROR_CODE_HEADER),
			GatewayErrorCode.upstreamResponseTooLarge,
		);
		assert.equal((await trusted.response.json() as { id?: string }).id, 'gen-trusted');

		const spoofed = await materializeNonOkResponse(new Response(
			'{"error":{"message":"provider secret must-not-leak"}}',
			{
				status: 502,
				headers: {
					'Content-Type': 'application/json',
					[GATEWAY_ERROR_CODE_HEADER]: GatewayErrorCode.upstreamResponseTooLarge,
				},
			},
		));
		assert.equal(
			spoofed.response.headers.get(GATEWAY_ERROR_CODE_HEADER),
			GatewayErrorCode.upstreamServerError,
		);
		assert.doesNotMatch(await spoofed.response.text(), /must-not-leak/);
	});

  it('cancels an oversized body without Content-Length and returns a fixed gateway error', async () => {
    const materialized = await materializeNonOkResponse(new Response(oversizedBody(), {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    }));

    assert.equal(materialized.response.status, 502);
    assert.equal(
      materialized.response.headers.get(GATEWAY_ERROR_CODE_HEADER),
      'gateway.upstream_response_too_large',
    );
    assert.deepEqual(await materialized.response.clone().json(), {
      error: {
        code: 502,
        message: 'Upstream error response exceeded the gateway size limit',
        metadata: { error_type: 'provider_unavailable' },
      },
      code: 'gateway.upstream_response_too_large',
    });
    assert.equal((materialized.errorBodyText?.length ?? 0) < 512, true);
  });

  it('keeps ordinary bounded upstream errors intact', async () => {
    const materialized = await materializeNonOkResponse(new Response('{"error":{"message":"bad input"}}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
    assert.equal(materialized.response.status, 400);
    assert.deepEqual(JSON.parse(materialized.errorBodyText ?? '{}'), {
      error: {
        code: 400,
        message: 'bad input',
        metadata: { error_type: 'invalid_request' },
      },
      code: 'upstream.invalid_request',
    });
    assert.equal(await formatHttpErrorForRequestLog(materialized.response), 'HTTP 400: bad input');
  });

  it('renders provider errors in Responses and Anthropic skins', async () => {
    const responses = await materializeNonOkResponse(new Response(
      JSON.stringify({ error: { message: 'rate limited', code: 'rate_limited' } }),
      { status: 429, headers: { 'Retry-After': '12' } },
    ), { skin: 'responses', requestId: 'gen-test-responses' });
    assert.equal(responses.response.status, 429);
    assert.equal(responses.response.headers.get('Retry-After'), '12');
    assert.deepEqual(await responses.response.json(), {
      status: 'failed',
      error: { code: 'rate_limit_exceeded', message: 'rate limited' },
      error_type: 'rate_limit_exceeded',
      id: 'gen-test-responses',
      code: 'upstream.rate_limited',
    });

    const anthropic = await materializeNonOkResponse(new Response(
      JSON.stringify({ error: { message: 'invalid prompt', type: 'invalid_request_error' } }),
      { status: 400 },
    ), { skin: 'anthropic', requestId: 'gen-test-messages' });
    assert.equal(anthropic.response.status, 400);
    assert.deepEqual(await anthropic.response.json(), {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'invalid prompt',
        error_type: 'invalid_request',
      },
      request_id: 'gen-test-messages',
      code: 'upstream.invalid_request',
    });
  });
});
