import test from 'node:test';
import assert from 'node:assert/strict';
import {
	providerAttemptAvailabilityForHttpStatus,
	RequestTimingCollector,
} from './request-timing';
import type { RouteResult } from './model-router';

function route(overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: 'route-a',
		modelSurfaceId: null,
		routePoolId: 'pool-a',
		providerId: 'provider-a',
		providerName: 'Provider A',
		providerModelName: 'model-a',
		gatewayModelId: 'public/model-a',
		gatewayCandidateIndex: 0,
		gatewayRequestedServiceTier: 'priority',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://example.test/v1' } },
		providerApiKey: 'secret',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: 'key-a',
		providerKeyLabel: 'primary',
		providerKeyFingerprint: 'fp-a',
		...overrides,
	};
}

test('RequestTimingCollector snapshots stable timing metrics and attempt metadata', () => {
	const timing = new RequestTimingCollector();
	timing.markGatewayComplete();
	timing.markGatewayComplete();

	const first = timing.startAttempt(route());
	timing.markAttemptHeaders(first, 429);
	timing.markAttemptFailover(first);
	timing.markModelFallback();

	const second = timing.startAttempt(route({
		providerId: 'provider-b',
		providerName: 'Provider B',
		providerKeyId: 'byok:key-b',
	}));
	timing.markAttemptHeaders(second, 200);
	timing.markFinalAttempt(second);
	timing.markFirstByte();
	timing.markFirstEvent();
	timing.markFirstReasoningToken();
	timing.markFirstReasoningToken();
	timing.markFirstToken();
	timing.markFirstToken();
	timing.markStreamComplete();

	const snapshot = timing.snapshot('chatcmpl-public-1');
	assert.equal(snapshot.upstreamAttemptCount, 2);
	assert.equal(snapshot.upstreamFailoverCount, 2);
	assert.equal(typeof snapshot.gatewayOverheadMs, 'number');
	assert.equal(typeof snapshot.upstreamResponseMs, 'number');
	assert.equal(typeof snapshot.finalUpstreamHeadersMs, 'number');
	assert.equal(typeof snapshot.firstReasoningTokenMs, 'number');
	assert.equal(typeof snapshot.firstTokenMs, 'number');
	assert.equal(typeof snapshot.streamDurationMs, 'number');

	const metadata = JSON.parse(snapshot.timingMetadata ?? '{}') as {
		first_byte_ms?: number;
		first_event_ms?: number;
		model_fallback_count?: number;
		attempts?: Array<{ provider_id: string; status: number; selected: boolean }>;
	};
	assert.equal(typeof metadata.first_byte_ms, 'number');
	assert.equal(typeof metadata.first_event_ms, 'number');
	assert.equal(metadata.model_fallback_count, 1);
	assert.equal(metadata.attempts?.length, 2);
	assert.equal(metadata.attempts?.[0]?.status, 429);
	assert.equal(metadata.attempts?.[1]?.provider_id, 'provider-b');
	assert.equal(metadata.attempts?.[1]?.selected, true);
	for (const fact of snapshot.providerAttempts) {
		assert.equal(Number.isFinite(Date.parse(fact.observedAtIso)), true);
	}
	assert.deepEqual(snapshot.providerAttempts.map(({ observedAtIso: _observedAtIso, ...fact }) => fact), [
		{
			attemptIndex: 1,
			routeTargetId: 'route-a',
			providerId: 'provider-a',
			outcome: 'excluded',
			reason: 'rate_limited',
			httpStatus: 429,
		},
		{
			attemptIndex: 2,
			routeTargetId: 'route-a',
			providerId: 'provider-b',
			outcome: 'available',
			reason: 'accepted',
			httpStatus: 200,
		},
	]);
	assert.equal(snapshot.providerResponses?.length, 2);
	assert.deepEqual(
		snapshot.providerResponses?.map(({ latency, ...response }) => ({
			...response,
			latencyType: typeof latency,
		})),
		[
			{
				status: 429,
				endpoint_id: 'route-a',
				is_byok: false,
				model_permaslug: 'public/model-a',
				provider_name: 'Provider A',
				routed_service_tier: 'priority',
				latencyType: 'number',
			},
			{
				status: 200,
				endpoint_id: 'route-a',
				id: 'chatcmpl-public-1',
				is_byok: true,
				model_permaslug: 'public/model-a',
				provider_name: 'Provider B',
				routed_service_tier: 'priority',
				latencyType: 'number',
			},
		],
	);
	const providerResponsesSerialized = JSON.stringify(snapshot.providerResponses);
	for (const forbidden of ['provider-a', 'provider-b', 'key-a', 'key-b', 'fp-a', '"model":"model-a"']) {
		assert.equal(providerResponsesSerialized.includes(forbidden), false, forbidden);
	}

	const publicAttempts = timing.routerMetadataAttempts();
	assert.deepEqual(publicAttempts, [
		{ index: 1, candidateIndex: 0, providerName: 'Provider A', status: 429, selected: false },
		{ index: 2, candidateIndex: 0, providerName: 'Provider B', status: 200, selected: true },
	]);
	const publicSerialized = JSON.stringify(publicAttempts);
	for (const forbidden of ['provider-a', 'provider-b', 'key-a', 'key-b', 'fp-a', 'model-a']) {
		assert.equal(publicSerialized.includes(forbidden), false, forbidden);
	}
});

test('provider attempt availability excludes caller errors and cancellations', () => {
	assert.deepEqual(providerAttemptAvailabilityForHttpStatus(200), {
		outcome: 'available', reason: 'accepted',
	});
	assert.deepEqual(providerAttemptAvailabilityForHttpStatus(503), {
		outcome: 'unavailable', reason: 'provider_http_error',
	});
	assert.deepEqual(providerAttemptAvailabilityForHttpStatus(403), {
		outcome: 'excluded', reason: 'client_error',
	});
	assert.deepEqual(providerAttemptAvailabilityForHttpStatus(429), {
		outcome: 'excluded', reason: 'rate_limited',
	});
	assert.deepEqual(providerAttemptAvailabilityForHttpStatus(422), {
		outcome: 'excluded', reason: 'client_error',
	});
	const timing = new RequestTimingCollector();
	const cancelled = timing.startAttempt(route());
	timing.markAttemptError(cancelled, new Error('private abort detail'), {
		clientCancelled: true,
	});
	const [fact] = timing.snapshot().providerAttempts;
	assert.equal(Number.isFinite(Date.parse(fact?.observedAtIso ?? '')), true);
	assert.deepEqual(fact == null ? null : (({ observedAtIso: _observedAtIso, ...value }) => value)(fact), {
		attemptIndex: 1,
		routeTargetId: 'route-a',
		providerId: 'provider-a',
		outcome: 'excluded',
		reason: 'client_cancelled',
		httpStatus: null,
	});
});

test('provider response snapshots fail closed when the bounded attempt limit is exceeded', () => {
	const timing = new RequestTimingCollector();
	for (let index = 0; index < 33; index += 1) {
		const attempt = timing.startAttempt(route({
			targetId: `route-${index}`,
			providerName: `Provider ${index}`,
		}));
		timing.markAttemptHeaders(attempt, 503);
	}

	assert.equal(timing.snapshot().providerResponses, null);
});

test('provider attempt availability uses the latest composite response without rewriting first-header timing', () => {
	const timing = new RequestTimingCollector();
	const attempt = timing.startAttempt(route());
	timing.markAttemptHeaders(attempt, 202);
	const firstHeadersMs = attempt.headers_ms;
	timing.markAttemptHeaders(attempt, 503);
	assert.equal(attempt.status, 202);
	assert.equal(attempt.headers_ms, firstHeadersMs);
	assert.deepEqual((({ observedAtIso: _observedAtIso, ...value }) => value)(
		timing.snapshot().providerAttempts[0]!,
	), {
		attemptIndex: 1,
		routeTargetId: 'route-a',
		providerId: 'provider-a',
		outcome: 'unavailable',
		reason: 'provider_http_error',
		httpStatus: 503,
	});

	timing.markAttemptError(attempt, new Error('poll reset'));
	assert.equal(timing.snapshot().providerAttempts[0]?.httpStatus, null);
});

test('selected accepted attempts are refined by terminal protocol evidence', () => {
	const invalid = new RequestTimingCollector();
	const invalidAttempt = invalid.startAttempt(route());
	invalid.markAttemptHeaders(invalidAttempt, 200);
	invalid.markFinalAttempt(invalidAttempt);
	invalid.finalizeSelectedAttemptAvailability({ invalidResponse: true });
	assert.deepEqual((({ observedAtIso: _observedAtIso, ...value }) => value)(
		invalid.snapshot().providerAttempts[0]!,
	), {
		attemptIndex: 1,
		routeTargetId: 'route-a',
		providerId: 'provider-a',
		outcome: 'unavailable',
		reason: 'invalid_response',
		httpStatus: 200,
	});

	const cancelled = new RequestTimingCollector();
	const cancelledAttempt = cancelled.startAttempt(route());
	cancelled.markAttemptHeaders(cancelledAttempt, 200);
	cancelled.markFinalAttempt(cancelledAttempt);
	cancelled.finalizeSelectedAttemptAvailability({
		clientCancelled: true,
		invalidResponse: true,
	});
	assert.equal(cancelled.snapshot().providerAttempts[0]?.outcome, 'excluded');
	assert.equal(cancelled.snapshot().providerAttempts[0]?.reason, 'client_cancelled');
	assert.equal(cancelled.snapshot().providerAttempts[0]?.httpStatus, 200);

	const rejected = new RequestTimingCollector();
	const rejectedAttempt = rejected.startAttempt(route());
	rejected.markAttemptHeaders(rejectedAttempt, 503);
	rejected.markFinalAttempt(rejectedAttempt);
	rejected.finalizeSelectedAttemptAvailability({ invalidResponse: true });
	assert.equal(rejected.snapshot().providerAttempts[0]?.reason, 'provider_http_error');
});
