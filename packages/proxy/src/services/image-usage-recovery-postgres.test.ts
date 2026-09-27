import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StorageContext } from '@octafuse/core';
import { resolveUpstreamEndpoint } from '@octafuse/core';
import type { PostgresDatabaseClient } from '../../../core/src/storage/database-client';
import type { RecordImageUsageParams } from './image-usage-charge';
import {
	buildImageGenerationUpstreamBody,
	captureImageAttemptRouteFacts,
	createPreparedImageGenerationAttempt,
} from './image-attempt-context';
import {
	createPostgresImageUsageRecoveryFactory,
	PostgresImageDispatchNotGrantedError,
} from './image-usage-recovery-postgres';
import type { ImageRecoveryScope, TrustedImagePreparedAttemptContext } from './image-usage-recovery';
import type { RouteResult } from './model-router';
import type { SingleGrantBudgetTicket } from './request-budget-admission';

const REQUEST_SHA = 'a'.repeat(64);
const DISPATCH_ROLE = 'cinatoken_gateway_dispatch_producer';
const FACT_ROLE = 'cinatoken_gateway_fact_producer';
const RUNTIME_ROLE = 'cinatoken_gateway_runtime';
const IDENTITY_SQL = 'SELECT current_user AS current_role, session_user AS session_role';
const scope: ImageRecoveryScope = Object.freeze({
	requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1', workspaceId: 'workspace-1',
	modelId: 'gateway-image-model', operation: 'images.generations',
	expiresAtMs: Date.now() + 30_000, requestSha256: REQUEST_SHA,
});

function route(overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: 'target-1', modelSurfaceId: 'surface-1', routePoolId: 'pool-1',
		providerId: 'provider-1', providerName: 'Provider', providerModelName: 'provider-image-model',
		upstreamProtocol: 'openai', upstreamOperation: 'images.generations', adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://provider.example/v1' } },
		providerApiKey: 'private-secret', providerKeyId: 'key-provider-1', providerKeyFingerprint: 'fingerprint-1',
		priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: null, routeGroup: 'default', routePriority: 1, routeWeight: 1,
		...overrides,
	};
}

async function boundAttempt(selected: RouteResult): Promise<TrustedImagePreparedAttemptContext> {
	const url = resolveUpstreamEndpoint('openai', 'images.generations', selected.providerEndpoints, { providerId: selected.providerId });
	const facts = captureImageAttemptRouteFacts(selected, 'images.generations', url);
	const prepared = createPreparedImageGenerationAttempt(facts,
		buildImageGenerationUpstreamBody(selected, { prompt: 'admitted prompt', n: 1 }));
	const { contextSha256, outboundPayloadSha256 } = await prepared.digestTrustedContext(REQUEST_SHA, {
		signal: new AbortController().signal, throwIfStopped() {},
	});
	return Object.freeze({
		operation: prepared.operation, requestSha256: REQUEST_SHA,
		contextSha256, outboundPayloadSha256, routeIdentity: prepared.routeIdentity,
	});
}

function pg(raw: object): PostgresDatabaseClient {
	return { driver: 'postgres', raw, drizzle: {} } as unknown as PostgresDatabaseClient;
}

function fixture(
	claim: 'granted' | 'not_granted' | 'uncertain' = 'granted',
	readback: 'confirmed' | 'missing_fact' | 'missing_job' = 'confirmed',
) {
	const events: string[] = [];
	const roles: Record<'runtime' | 'dispatch' | 'fact', unknown> = {
		runtime: RUNTIME_ROLE, dispatch: DISPATCH_ROLE, fact: FACT_ROLE,
	};
	const roleAnswers: Record<'runtime' | 'dispatch' | 'fact', unknown[]> = {
		runtime: [], dispatch: [], fact: [],
	};
	const identity = (name: 'runtime' | 'dispatch' | 'fact') => {
		const answer = roleAnswers[name].length ? roleAnswers[name].shift() : roles[name];
		if (answer instanceof Error) throw answer;
		return [answer && typeof answer === 'object' ? answer
			: { current_role: answer, session_role: answer }];
	};
	const runtime = pg({ async unsafe(query: string) {
		if (query === IDENTITY_SQL) return identity('runtime');
		throw new Error('Unexpected runtime SQL');
	} });
	const storage = { client: runtime, repositories: {} } as unknown as StorageContext;
	const claimProducer = pg({
		async begin<T>(run: (tx: { unsafe: (query: string) => Promise<Array<{ accepted: boolean }>> }) => Promise<T>): Promise<T> {
			const result = await run({
				async unsafe(query: string) {
					if (query === IDENTITY_SQL) return identity('dispatch');
					if (query.includes('prepare_request_dispatch_intent_v1')) {
						events.push('parent.prepare'); return [{ accepted: true }];
					}
					if (query.includes('claim_request_dispatch_intent_v1')) {
						events.push('parent.claim');
						if (claim === 'uncertain') throw new Error('COMMIT ACK lost');
						return [{ accepted: claim === 'granted' }];
					}
					throw new Error('Unexpected parent SQL');
				},
			});
			events.push('parent.commit_ack');
			return result;
		},
		async unsafe(query: string) {
			if (query === IDENTITY_SQL) return identity('dispatch');
			throw new Error('Unexpected dispatch SQL outside transaction');
		},
	});
	let stored: readonly unknown[] | undefined;
	const factUnsafe = async (query: string, args?: readonly unknown[]) => {
			if (query === IDENTITY_SQL) return identity('fact');
			if (query.includes('INSERT INTO cinatoken_gateway.request_usage_settlements')) {
				events.push('fact.insert'); stored = args; return [];
			}
			if (query.includes('FROM cinatoken_gateway.request_usage_settlements s JOIN cinatoken_gateway.request_usage_settlement_outbox o')) {
				events.push('fact.readback');
				if (!stored || readback === 'missing_fact') return [];
				return [{ request_id:stored[0],attempt_index:stored[1],user_id:stored[2],api_key_id:stored[3],
					workspace_id:stored[4],operation:stored[5],context_sha256:stored[6],dispatch_claim_id:stored[7],
					payload_sha256:stored[8],payload_version:stored[9],payload_json:stored[10],recorded_at:stored[11] }];
			}
			if (query.includes('INSERT INTO cinatoken_gateway.request_usage_recovery_jobs')) {
				events.push('job.ensure'); return [];
			}
			if (query.includes('FROM cinatoken_gateway.request_usage_recovery_jobs j')) {
				events.push('job.readback');
				if (!stored || readback === 'missing_job') return [];
				const now = String(Date.now());
				return [{ request_id:stored[0],attempt_index:stored[1],user_id:stored[2],api_key_id:stored[3],
					workspace_id:stored[4],operation:stored[5],context_sha256:stored[6],dispatch_claim_id:stored[7],
					payload_sha256:stored[8],state:'pending',revision:'0',attempts:0,last_transition:'enqueued',
					lease_seconds:null,lease_expires_at_ms:null,available_at_ms:now,last_error:null,
					created_at_ms:now,updated_at_ms:now }];
			}
			throw new Error(`Unexpected fact SQL: ${query.slice(0, 80)}`);
	};
	const factProducer = pg({
		unsafe: factUnsafe,
		async begin<T>(run: (tx: { unsafe: typeof factUnsafe }) => Promise<T>): Promise<T> {
			return run({ unsafe: factUnsafe });
		},
	});
	const factory = createPostgresImageUsageRecoveryFactory(storage, { claimProducer, factProducer }, { maxAttempts: 3 });
	return { events, storage, factory, roles, roleAnswers, get stored() { return stored; } };
}

function ticket(events: string[]): SingleGrantBudgetTicket {
	return {
		async markAfterCommittedClaim() { events.push('budget.mark'); },
		async releaseAfterDefiniteNoClaim() { events.push('budget.release'); },
		holdAfterUncertainClaim() { events.push('budget.hold'); },
	};
}

function usageParams(storage: StorageContext, selected: RouteResult): RecordImageUsageParams {
	const now = new Date().toISOString();
	return {
		repos: storage.repositories, requestLogId:scope.requestId,
		userId:scope.userId,apiKeyId:scope.apiKeyId,workspaceId:scope.workspaceId,userEmail:'private@example.test',
		modelId:scope.modelId,providerId:selected.providerId,providerModelName:selected.providerModelName,
		providerKeyId:selected.providerKeyId,providerKeyFingerprint:selected.providerKeyFingerprint,
		routeTargetId:selected.targetId,modelSurfaceId:selected.modelSurfaceId,routePoolId:selected.routePoolId,
		requestProtocol:'openai',requestOperation:scope.operation,upstreamProtocol:'openai',
		upstreamOperation:selected.upstreamOperation,routeGroup:'default',status:'error',latencyMs:10,
		errorMessage:'upstream secret in free-form error',requestBody:'private prompt',upstreamRequestBody:'private secret',
		billing:{ modelPricingProfileJson:null,imageCount:1,operation:'generations',
			pricingContext:{ pricingAtUtcMs:Date.now(),businessTimezone:'UTC' } },
		timing:{ providerAttempts:[{ attemptIndex:1,routeTargetId:selected.targetId,providerId:selected.providerId,
			outcome:'unavailable',reason:'provider_http_error',httpStatus:503,observedAtIso:now }] } as RecordImageUsageParams['timing'],
	};
}

test('explicit factory requires distinct PostgreSQL producer clients and trusted ingress SHA', () => {
	const runtime = pg({});
	const storage = { client: runtime, repositories: {} } as unknown as StorageContext;
	assert.throws(() => createPostgresImageUsageRecoveryFactory(storage,
		{ claimProducer: runtime, factProducer: pg({}) }, { maxAttempts: 3 }), /Distinct PostgreSQL/);
	const { factory } = fixture();
	assert.equal(factory.requiresTrustedIngressDigest, true);
	assert.equal(factory.requiresTrustedAttemptContext, true);
	assert.equal(factory.supportsStreaming, false);
	assert.throws(() => factory({ ...scope, requestSha256: undefined }), /scope/);
	assert.throws(() => factory({ ...scope, responseStreamed: true }), /scope/);
});

test('driver-prepared context must match route and request before parent preparation', async () => {
	const { events, factory } = fixture();
	const selected = route();
	const request = factory(scope);
	await assert.rejects(request.beforeSingleGrantDispatch(selected, 1, ticket(events), () => {}, undefined), /driver-prepared/);
	assert.deepEqual(events, ['budget.release']);
	const second = factory(scope);
	const bound = await boundAttempt(selected);
	await assert.rejects(second.beforeSingleGrantDispatch(route({ providerKeyId: 'other-key' }), 1,
		ticket(events), () => {}, bound), /route mismatch/);
	assert.deepEqual(events, ['budget.release', 'budget.release']);
	assert.equal(request.mayHaveDispatched, false);
});

test('wrong or failed runtime, dispatch and fact identity checks reject before parent work', async () => {
	const selected = route();
	const bound = await boundAttempt(selected);
	for (const who of ['runtime', 'dispatch', 'fact'] as const) {
		const invalid = fixture();
		invalid.roles[who] = who === 'runtime' ? DISPATCH_ROLE : RUNTIME_ROLE;
		const request = invalid.factory(scope);
		await assert.rejects(request.beforeSingleGrantDispatch(selected, 1, ticket(invalid.events), () => {}, bound),
			/authority role mismatch/);
		assert.deepEqual(invalid.events, ['budget.release']);
		assert.equal(request.mayHaveDispatched, false);
		const switched = fixture();
		const expected = { runtime: RUNTIME_ROLE, dispatch: DISPATCH_ROLE, fact: FACT_ROLE }[who];
		switched.roleAnswers[who].push({ current_role: expected, session_role: RUNTIME_ROLE === expected
			? DISPATCH_ROLE : RUNTIME_ROLE });
		await assert.rejects(switched.factory(scope).beforeSingleGrantDispatch(selected, 1,
			ticket(switched.events), () => {}, bound), /authority role mismatch/);
		assert.deepEqual(switched.events, ['budget.release']);
	}
	const failed = fixture();
	failed.roleAnswers.runtime.push(new Error('identity query failed'));
	await assert.rejects(failed.factory(scope).beforeSingleGrantDispatch(selected, 1,
		ticket(failed.events), () => {}, bound), /identity query failed/);
	assert.deepEqual(failed.events, ['budget.release']);
	const malformed = fixture();
	malformed.roleAnswers.fact.push(null);
	await assert.rejects(malformed.factory(scope).beforeSingleGrantDispatch(selected, 1,
		ticket(malformed.events), () => {}, bound), /authority role mismatch/);
	assert.deepEqual(malformed.events, ['budget.release']);
});

test('producer checks run again on the transaction that performs parent and fact SQL', async () => {
	const selected = route();
	const bound = await boundAttempt(selected);
	const crossedDispatch = fixture();
	crossedDispatch.roleAnswers.dispatch.push(DISPATCH_ROLE, FACT_ROLE);
	await assert.rejects(crossedDispatch.factory(scope).beforeSingleGrantDispatch(selected, 1,
		ticket(crossedDispatch.events), () => {}, bound), /authority role mismatch/);
	assert.deepEqual(crossedDispatch.events, ['budget.release']);
	const switchedDispatch = fixture();
	switchedDispatch.roleAnswers.dispatch.push(DISPATCH_ROLE,
		{ current_role: DISPATCH_ROLE, session_role: RUNTIME_ROLE });
	await assert.rejects(switchedDispatch.factory(scope).beforeSingleGrantDispatch(selected, 1,
		ticket(switchedDispatch.events), () => {}, bound), /authority role mismatch/);
	assert.deepEqual(switchedDispatch.events, ['budget.release']);

	const crossedFact = fixture();
	const request = crossedFact.factory(scope);
	await request.beforeSingleGrantDispatch(selected, 1, ticket(crossedFact.events), () => {}, bound);
	crossedFact.roleAnswers.fact.push(FACT_ROLE, DISPATCH_ROLE, DISPATCH_ROLE);
	await assert.rejects(request.persist(usageParams(crossedFact.storage, selected)), /authority role mismatch/);
	assert.equal(crossedFact.events.includes('fact.insert'), false);
	assert.equal(crossedFact.events.includes('job.ensure'), false);
});

test('only acknowledged parent claim then completed budget mark authorizes fetch', async () => {
	const { events, factory } = fixture();
	const selected = route();
	const request = factory(scope);
	await request.beforeSingleGrantDispatch(selected, 1, ticket(events), () => {}, await boundAttempt(selected));
	assert.deepEqual(events, ['parent.prepare', 'parent.commit_ack', 'parent.claim', 'parent.commit_ack', 'budget.mark']);
	assert.equal(request.mayHaveDispatched, true);
	await assert.rejects(request.beforeSingleGrantDispatch(selected, 2, ticket(events), () => {}, await boundAttempt(selected)), /already attempted/);
});

test('definitive no-claim releases the ticket; uncertain claim holds it without retry', async () => {
	const selected = route();
	const bound = await boundAttempt(selected);
	const denied = fixture('not_granted');
	const deniedRequest = denied.factory(scope);
	await assert.rejects(deniedRequest.beforeSingleGrantDispatch(selected, 1, ticket(denied.events), () => {}, bound),
		PostgresImageDispatchNotGrantedError);
	assert.deepEqual(denied.events, ['parent.prepare', 'parent.commit_ack', 'parent.claim', 'parent.commit_ack', 'budget.release']);
	assert.equal(deniedRequest.mayHaveDispatched, false);
	const uncertain = fixture('uncertain');
	const uncertainRequest = uncertain.factory(scope);
	await assert.rejects(uncertainRequest.beforeSingleGrantDispatch(selected, 1, ticket(uncertain.events), () => {}, bound));
	assert.deepEqual(uncertain.events, ['parent.prepare', 'parent.commit_ack', 'parent.claim', 'budget.hold']);
	assert.equal(uncertainRequest.mayHaveDispatched, true);
});

test('a budget mark failure cannot proceed to persistence', async () => {
	const { events, factory, storage } = fixture();
	const selected = route();
	const request = factory(scope);
	const broken = { ...ticket(events), async markAfterCommittedClaim() {
		events.push('budget.mark_failed'); throw new Error('mark failed');
	} };
	await assert.rejects(request.beforeSingleGrantDispatch(selected, 1, broken, () => {}, await boundAttempt(selected)), /mark failed/);
	assert.equal(request.mayHaveDispatched, true);
	await assert.rejects(request.persist({ repos: storage.repositories } as RecordImageUsageParams), /identity conflict/);
});

test('claimed error outcome becomes one sanitized immutable fact, outbox readback and accepted job', async () => {
	const owner = fixture();
	const { events, factory, storage } = owner;
	const selected = route();
	const request = factory(scope);
	await request.beforeSingleGrantDispatch(selected, 1, ticket(events), () => {}, await boundAttempt(selected));
	const params = usageParams(storage, selected);
	const commit = await request.persist(params);
	await commit();
	assert.deepEqual(events.slice(-4), ['fact.insert', 'fact.readback', 'job.ensure', 'job.readback']);
	const fact = JSON.parse(String(owner.stored?.[10]));
	assert.equal(fact.intent.contextSha256.length, 64);
	assert.equal(fact.intent.requestSha256, undefined);
	assert.equal(fact.params.requestLog.requestBody, null);
	assert.equal(fact.params.requestLog.upstreamRequestBody, null);
	assert.equal(fact.params.requestLog.userEmail, null);
	assert.equal(fact.params.requestLog.providerKeyFingerprint, null);
	assert.equal(fact.params.requestLog.errorMessage, 'Image request failed');
	assert.ok(!JSON.stringify(fact).includes('private prompt'));
	assert.ok(!JSON.stringify(fact).includes('private secret'));
	await assert.rejects(request.persist(params), /identity conflict/);
	for (const [readback, expectedEvents] of [
		['missing_fact', ['fact.insert', 'fact.readback']],
		['missing_job', ['fact.insert', 'fact.readback', 'job.ensure', 'job.readback']],
	] as const) {
		const failed = fixture('granted', readback);
		const failedRequest = failed.factory(scope);
		await failedRequest.beforeSingleGrantDispatch(selected, 1, ticket(failed.events), () => {}, await boundAttempt(selected));
		await assert.rejects(failedRequest.persist({ ...params, repos:failed.storage.repositories }));
		assert.deepEqual(failed.events.slice(-expectedEvents.length), expectedEvents);
	}
});
