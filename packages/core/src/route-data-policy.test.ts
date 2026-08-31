import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteDataPolicyRow } from './db/route-data-policy-types';
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	effectiveRouteDataPolicyStatus,
	effectiveRouteDataPolicyStatusForSubject,
	routeDataPolicyAllowsZdr,
} from './route-data-policy';

const SUBJECT_FINGERPRINT = 'a'.repeat(64);

function policy(overrides: Partial<RouteDataPolicyRow> = {}): RouteDataPolicyRow {
	return {
		route_target_id: 'target-1',
		subject_fingerprint: SUBJECT_FINGERPRINT,
		retention_days: 0,
		training_allowed: false,
		zdr_supported: true,
		evidence_url: 'https://provider.test/privacy',
		verified_by: 'admin',
		verified_at: '2026-08-01T00:00:00.000Z',
		expires_at: '2026-09-01T00:00:00.000Z',
		status: 'verified',
		invalidated_at: null,
		invalidation_reason: null,
		updated_at: '2026-08-01T00:00:00.000Z',
		...overrides,
	};
}

describe('route data policies', () => {
	it('derives effective verification from evidence and expiry', () => {
		const now = new Date('2026-08-15T00:00:00.000Z');
		assert.equal(effectiveRouteDataPolicyStatus(policy(), now), 'verified');
		assert.equal(effectiveRouteDataPolicyStatus(policy({ expires_at: '2026-08-14T00:00:00.000Z' }), now), 'expired');
		assert.equal(effectiveRouteDataPolicyStatus(policy({ status: 'expired', evidence_url: null }), now), 'expired');
		assert.equal(effectiveRouteDataPolicyStatus(policy({ evidence_url: null }), now), 'unknown');
		assert.equal(effectiveRouteDataPolicyStatus(policy({ subject_fingerprint: null }), now), 'unknown');
		assert.equal(effectiveRouteDataPolicyStatus(policy({ invalidated_at: now.toISOString() }), now), 'unknown');
		assert.equal(effectiveRouteDataPolicyStatus(null, now), 'unknown');
	});

	it('requires verified zero retention, no training, and explicit ZDR support', () => {
		const now = new Date('2026-08-15T00:00:00.000Z');
		assert.equal(routeDataPolicyAllowsZdr(policy(), SUBJECT_FINGERPRINT, now), true);
		assert.equal(routeDataPolicyAllowsZdr(policy(), 'b'.repeat(64), now), false);
		assert.equal(routeDataPolicyAllowsZdr(policy(), null, now), false);
		assert.equal(routeDataPolicyAllowsZdr(policy({ retention_days: 1 }), SUBJECT_FINGERPRINT, now), false);
		assert.equal(routeDataPolicyAllowsZdr(policy({ training_allowed: true }), SUBJECT_FINGERPRINT, now), false);
		assert.equal(routeDataPolicyAllowsZdr(policy({ zdr_supported: false }), SUBJECT_FINGERPRINT, now), false);
		assert.equal(routeDataPolicyAllowsZdr(policy({ status: 'unknown' }), SUBJECT_FINGERPRINT, now), false);
		assert.equal(effectiveRouteDataPolicyStatusForSubject(policy(), 'b'.repeat(64), now), 'unknown');
	});

	it('canonically binds endpoint, credential, model, operation, adapter, and custom params', async () => {
		const route = {
			provider_id: 'provider-1', provider_model_name: 'model-a', upstream_protocol: 'openai',
			upstream_operation: 'chat', adapter: 'passthrough', custom_params: '{"temperature":0,"nested":{"b":2,"a":1}}',
		};
		const provider = {
			id: 'provider-1', api_key: 'secret-a', shared_channel_type: null,
			endpoints: '{"openai":{"endpoints":{"chat":"https://api.example/v1/chat/completions"},"base":"https://api.example/v1"}}',
		};
		const first = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
		const reordered = await computeRouteDataPolicySubjectFingerprintFromRows(
			{ ...route, custom_params: '{"nested":{"a":1,"b":2},"temperature":0}' },
			{ ...provider, endpoints: '{"openai":{"base":"https://api.example/v1","endpoints":{"chat":"https://api.example/v1/chat/completions"}}}' },
		);
		assert.match(first, /^[0-9a-f]{64}$/u);
		assert.equal(reordered, first);
		assert.notEqual(await computeRouteDataPolicySubjectFingerprintFromRows(route, { ...provider, api_key: 'secret-b' }), first);
		assert.notEqual(await computeRouteDataPolicySubjectFingerprintFromRows({ ...route, provider_model_name: 'model-b' }, provider), first);
		assert.notEqual(await computeRouteDataPolicySubjectFingerprintFromRows({ ...route, custom_params: '{"temperature":1}' }, provider), first);
	});

	it('treats prototype-named custom parameters as ordinary fingerprinted data', async () => {
		const route = {
			provider_id: 'provider-1', provider_model_name: 'model-a', upstream_protocol: 'openai',
			upstream_operation: 'chat', adapter: 'passthrough', custom_params: '{"__proto__":{"polluted":true}}',
		};
		const provider = {
			id: 'provider-1', api_key: 'secret-a', shared_channel_type: null,
			endpoints: '{"openai":{"base":"https://api.example/v1"}}',
		};
		const withPrototypeKey = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
		const withoutPrototypeKey = await computeRouteDataPolicySubjectFingerprintFromRows(
			{ ...route, custom_params: '{}' },
			provider,
		);

		assert.notEqual(withPrototypeKey, withoutPrototypeKey);
		assert.equal(
			withPrototypeKey,
			await computeRouteDataPolicySubjectFingerprintFromRows(route, provider),
		);
	});
});
