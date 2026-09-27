import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ModelFallbackPlanResult } from './model-fallback-plan';
import type { ParsedModelFallbacks } from './model-fallbacks';
import {
	createFinalChatQuoteInput,
	createFinalChatQuoteSnapshot,
	originalChatBodySha256,
} from './chat-final-quote-input';

type Plan = Extract<ModelFallbackPlanResult, { ok: true }>;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

function fixture() {
	const body: Record<string, unknown> = {
		z: 2,
		models: ['m2', 'm1', 'm2'],
		model: ' m1 ',
		messages: [{ role: 'user', content: 'hello' }],
	};
	const parsed: ParsedModelFallbacks = {
		modelIds: ['m1', 'm2'],
		upstreamBody: { model: 'm1', messages: body.messages, z: 2 },
		hasFallbacks: true,
	};
	const plan = {
		ok: true,
		candidates: [
			{ requestedModelId: 'm1', baseModelId: 'm1',
				upstreamBody: parsed.upstreamBody, routes: [{ targetId: 'target-1' }] },
			{ requestedModelId: 'm2', baseModelId: 'm2',
				upstreamBody: parsed.upstreamBody, routes: [{ targetId: 'target-2' }] },
		],
		endpointPartition: 'model',
		globalRoutes: [],
	} as unknown as Plan;
	return { body, parsed, plan };
}

test('final Chat quote input binds original bytes and post-transform ordered candidates', async () => {
	const { body, parsed, plan } = fixture();
	const original = '{ "model": " m1 ", "models": ["m2", "m1", "m2"] }';
	const originalBytes = new TextEncoder().encode(original);
	const originalBodySha256 = await originalChatBodySha256(
		originalBytes.buffer as ArrayBuffer,
	);
	const captured = await createFinalChatQuoteInput({
		requestId: 'request-1',
		originalBodySha256,
		finalBody: body,
		parsed,
		plan,
	});
	assert.equal(originalBodySha256, hash(original));
	assert.notEqual(originalBodySha256, hash(JSON.stringify(body)));
	assert.deepEqual(JSON.parse(captured.finalBodyUtf8).models, ['m1', 'm2']);
	assert.equal(JSON.parse(captured.finalBodyUtf8).model, 'm1');
	assert.equal(captured.finalBodySha256, hash(captured.finalBodyUtf8));
	assert.deepEqual(captured.modelIds, ['m1', 'm2']);
	captured.assertCurrent(body, parsed, plan);
});

test('final Chat quote input rejects a body or candidate plan mutated after capture', async () => {
	const { body, parsed, plan } = fixture();
	const captured = await createFinalChatQuoteInput({
		requestId: 'request-1',
		originalBodySha256: hash('original'),
		finalBody: body,
		parsed,
		plan,
	});
	(body.messages as Array<Record<string, unknown>>)[0]!.content = 'changed';
	assert.throws(() => captured.assertCurrent(body, parsed, plan), /changed after planning/u);
	(body.messages as Array<Record<string, unknown>>)[0]!.content = 'hello';
	(plan.candidates[1]!.routes[0] as { targetId: string }).targetId = 'unquoted-target';
	assert.throws(() => captured.assertCurrent(body, parsed, plan), /changed after planning/u);
});

test('final Chat quote input rejects an incomplete or reordered candidate plan', async () => {
	const { body, parsed, plan } = fixture();
	plan.candidates.reverse();
	await assert.rejects(createFinalChatQuoteInput({
		requestId: 'request-1',
		originalBodySha256: hash('original'),
		finalBody: body,
		parsed,
		plan,
	}), /differs from normalized body/u);
});

test('final Chat quote input is independent of object insertion order', async () => {
	const { body, parsed, plan } = fixture();
	const captured = await createFinalChatQuoteInput({
		requestId: 'request-1',
		originalBodySha256: hash('original'),
		finalBody: body,
		parsed,
		plan,
	});
	const reordered = {
		messages: body.messages,
		model: body.model,
		models: body.models,
		z: body.z,
	};
	captured.assertCurrent(reordered, parsed, plan);
});

test('final Chat quote input rejects non-JSON transform data', async () => {
	const { body, parsed, plan } = fixture();
	body.extra = undefined;
	await assert.rejects(createFinalChatQuoteInput({
		requestId: 'request-1',
		originalBodySha256: hash('original'),
		finalBody: body,
		parsed,
		plan,
	}), /undefined/u);
});

test('pre-plan snapshot captures the full normalized candidate list without a route plan', async () => {
	const { body, parsed } = fixture();
	parsed.modelIds = Array.from({ length: 8 }, (_, index) => `model-${index}`);
	const captured = await createFinalChatQuoteSnapshot({
		requestId: 'secretless-request', originalBodySha256: hash('ingress'), finalBody: body, parsed,
	});
	assert.deepEqual(captured.modelIds, parsed.modelIds);
	assert.deepEqual(JSON.parse(captured.finalBodyUtf8).models, parsed.modelIds);
	assert.equal(captured.finalBodySha256, hash(captured.finalBodyUtf8));
	assert.equal(Object.isFrozen(captured), true);
	assert.equal(Object.isFrozen(captured.modelIds), true);
	captured.assertCurrent(body, parsed);
	parsed.modelIds.reverse();
	assert.throws(() => captured.assertCurrent(body, parsed), /changed after capture/u);
});

test('pre-plan snapshot copies identity, body and models before asynchronous hashing', async () => {
	const { body, parsed } = fixture();
	const params = { requestId: 'original-request', originalBodySha256: hash('original'),
		finalBody: body, parsed };
	const pending = createFinalChatQuoteSnapshot(params);
	params.requestId = 'changed-request';
	params.originalBodySha256 = hash('changed');
	parsed.modelIds[0] = 'changed-model';
	(body.messages as Array<Record<string, unknown>>)[0]!.content = 'changed-content';
	const captured = await pending;
	assert.equal(captured.requestId, 'original-request');
	assert.equal(captured.originalBodySha256, hash('original'));
	assert.deepEqual(captured.modelIds, ['m1', 'm2']);
	assert.equal(JSON.parse(captured.finalBodyUtf8).messages[0].content, 'hello');
	assert.equal(captured.finalBodySha256, hash(captured.finalBodyUtf8));
	assert.throws(() => captured.assertCurrent(body, parsed), /changed after capture/u);
});

test('legacy plan mutation during hashing cannot change the captured routing plan', async () => {
	const { body, parsed, plan } = fixture();
	const pending = createFinalChatQuoteInput({
		requestId: 'request-1', originalBodySha256: hash('original'), finalBody: body, parsed, plan,
	});
	(plan.candidates[1]!.routes[0] as { targetId: string }).targetId = 'unquoted-target';
	const captured = await pending;
	assert.throws(() => captured.assertCurrent(body, parsed, plan), /changed after planning/u);
});
