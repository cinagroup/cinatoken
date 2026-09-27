import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
	inspectOpenRouterGenerationCostCandidateV372,
	OpenRouterCostCandidateRejectedV372,
} from './openrouter-generation-cost-candidate-v372.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const keyHash = 'a'.repeat(64);
const workspaceId = '10000000-0000-4000-8000-000000000001';
const sendStartId = '20000000-0000-4000-8000-000000000002';
const grantId = '30000000-0000-4000-8000-000000000003';
const correlationId = '40000000-0000-4000-8000-000000000004';
const generationId = 'gen-test_1';
const pin = Object.freeze({
	providerId: 'review-openrouter-provider',
	routeTargetId: 'review-openrouter-route',
	endpointId: 'review-openrouter-endpoint',
	credentialId: 'review-openrouter-credential',
	model: 'example/model',
	workspaceId,
	sendApiKeyHash: keyHash,
});
const grant = Object.freeze({
	grantId,
	requestId: 'request-1',
	sendStartId,
	holderRunId: '50000000-0000-4000-8000-000000000005',
	requestCorrelationId: correlationId,
	externalUser: `ct-${correlationId}`,
	outboundUserField: `ct-${correlationId}`,
	credentialClass: 'platform',
	custodyCommitted: true,
	sendStartCommitted: true,
	providerId: pin.providerId,
	routeTargetId: pin.routeTargetId,
	endpointId: pin.endpointId,
	credentialId: pin.credentialId,
	model: pin.model,
	sendApiKeyHash: keyHash,
	outboundBodySha256: 'b'.repeat(64),
	upstreamUrlSha256: sha256(CHAT_URL),
});
const observation = Object.freeze({
	grantId, sendStartId, generationId,
	providerRequestId: 'req-source-1',
});
const keyData = Object.freeze({
	data: { hash: keyHash, workspace_id: workspaceId, disabled: false },
});
const generationData = Object.freeze({
	data: {
		id: generationId,
		request_id: 'req-source-1',
		external_user: `ct-${correlationId}`,
		model: pin.model,
		api_type: 'completions',
		is_byok: false,
		total_cost: 0.0015,
	},
});

function harness(overrides = {}) {
	const calls = [];
	const source = overrides.generationData ?? generationData;
	const key = overrides.keyData ?? keyData;
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		if (overrides.firstResponse && calls.length === 1)
			return overrides.firstResponse;
		if (overrides.secondResponse && calls.length === 2)
			return overrides.secondResponse;
		return Response.json(calls.length === 1 ? key : source);
	};
	return {
		calls,
		input: {
			pin: overrides.pin ?? pin,
			grant: overrides.grant ?? grant,
			observation: overrides.observation ?? observation,
			managementKey: overrides.managementKey ?? 'sk-or-independent-management-review',
			fetchImpl,
		},
	};
}

async function rejectCode(input, code) {
	await assert.rejects(
		inspectOpenRouterGenerationCostCandidateV372(input),
		error => error instanceof OpenRouterCostCandidateRejectedV372
			&& error.code === code,
	);
}

test('independent key metadata and generation GET yield only a positive review candidate', async () => {
	const { input, calls } = harness();
	const result = await inspectOpenRouterGenerationCostCandidateV372(input);
	assert.equal(result.status, 'positive_cost_candidate');
	assert.equal(result.financialAuthority, false);
	assert.equal(result.costObserved, 0.0015);
	assert.equal(result.generationId, generationId);
	assert.match(result.sourceDocumentSha256, /^[0-9a-f]{64}$/u);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url,
		`https://openrouter.ai/api/v1/keys/${keyHash}`);
	assert.equal(calls[1].url,
		`https://openrouter.ai/api/v1/generation?id=${generationId}`);
	for (const { init } of calls) {
		assert.equal(init.method, 'GET');
		assert.equal(init.redirect, 'error');
		assert.equal(init.cache, 'no-store');
		assert.equal(init.headers.Authorization,
			'Bearer sk-or-independent-management-review');
	}
	assert.equal(Object.hasOwn(result, 'providerEventId'), false);
	assert.equal(Object.hasOwn(result, 'billAmountMicros'), false);
});

test('wrong route or missing per-attempt outbound correlation never fetches', async () => {
	for (const change of [
		{ grant: { ...grant, routeTargetId: 'other-route' } },
		{ grant: { ...grant, upstreamUrlSha256: 'c'.repeat(64) } },
		{ grant: { ...grant, sendApiKeyHash: 'd'.repeat(64) } },
		{ grant: { ...grant, sendStartCommitted: false } },
		{ grant: { ...grant, custodyCommitted: false } },
		{ observation: { ...observation, grantId: '90000000-0000-4000-8000-000000000009' } },
	]) {
		const { input, calls } = harness(change);
		await rejectCode(input, 'route_or_send_not_pinned');
		assert.equal(calls.length, 0);
	}
	const { input, calls } = harness({
		grant: { ...grant, outboundUserField: 'buyer-supplied-user' },
	});
	await rejectCode(input, 'attempt_correlation_missing');
	assert.equal(calls.length, 0);
});

test('different management and sending API keys are required before lookup', async () => {
	const managementKey = 'sk-or-review-same-key';
	const sameHash = sha256(managementKey);
	const { input, calls } = harness({
		managementKey,
		pin: { ...pin, sendApiKeyHash: sameHash },
		grant: { ...grant, sendApiKeyHash: sameHash },
	});
	await rejectCode(input, 'route_or_send_not_pinned');
	assert.equal(calls.length, 0);
});

test('management lookup must name the pinned send key and workspace', async () => {
	for (const data of [
		{ ...keyData.data, hash: 'e'.repeat(64) },
		{ ...keyData.data, workspace_id: '90000000-0000-4000-8000-000000000009' },
		{ ...keyData.data, disabled: true },
	]) {
		const { input, calls } = harness({ keyData: { data } });
		await rejectCode(input, 'send_key_account_mismatch');
		assert.equal(calls.length, 1);
	}
});

test('generation identity must match the observed send and pinned route', async () => {
	for (const data of [
		{ ...generationData.data, id: 'gen-other' },
		{ ...generationData.data, external_user: 'ct-wrong' },
		{ ...generationData.data, model: 'other/model' },
		{ ...generationData.data, is_byok: true },
		{ ...generationData.data, api_type: 'images' },
	]) {
		const { input, calls } = harness({ generationData: { data } });
		await rejectCode(input, 'generation_identity_mismatch');
		assert.equal(calls.length, 2);
	}
	const { input } = harness({
		generationData: { data: { ...generationData.data,
			request_id: 'req-different' } },
	});
	await rejectCode(input, 'provider_request_mismatch');
});

test('zero remains unproven; missing or invalid cost is rejected', async () => {
	const zero = harness({ generationData: {
		data: { ...generationData.data, total_cost: 0 },
	} });
	const result = await inspectOpenRouterGenerationCostCandidateV372(zero.input);
	assert.equal(result.status, 'zero_unproven');
	assert.equal(result.financialAuthority, false);
	for (const total_cost of [null, -1, '0.0015']) {
		const { input } = harness({ generationData: {
			data: { ...generationData.data, total_cost },
		} });
		await rejectCode(input, 'cost_missing_or_invalid');
	}
});

test('redirect, non-JSON and oversized source responses fail closed', async () => {
	const redirect = harness({ secondResponse: Response.redirect(
		'https://other.example.invalid/steal', 307) });
	await rejectCode(redirect.input, 'source_http_status');
	assert.equal(redirect.calls.length, 2);
	const nonJson = harness({ secondResponse: new Response('ok', {
		headers: { 'Content-Type': 'text/plain' },
	}) });
	await rejectCode(nonJson.input, 'source_content_type');
	const big = harness({ secondResponse: Response.json({
		data: generationData.data, pad: 'x'.repeat(20_000),
	}) });
	await rejectCode(big.input, 'source_body_size');
});
