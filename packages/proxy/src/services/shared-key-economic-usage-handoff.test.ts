import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GatewayRepositories, PostgresDatabaseClient } from '@octafuse/core';
import type { RouteResult } from './model-router';
import { EMPTY_USAGE, type UsageFromStream } from './proxy';
import { providerUsageFacts } from './provider-usage-facts';
import {
	createPostgresSharedKeyEconomicProducer,
	createSharedKeyQuoteAttemptCapture,
	type SharedKeyQuoteAttemptInput,
	type SharedKeyQuoteAttemptReference,
} from './shared-key-quote-attempt';
import {
	hasPotentiallyBillableUnknownSharedKeyAttempt,
	prepareSharedKeyEconomicUsageHandoff,
	recordUsage,
} from './usage-tracker';

const requestLogId = 'economic-usage-test';
const routeTargetId = 'route-shared-a';
const providerKeyId = 'sharedkey:shared-a';

function reference(input: SharedKeyQuoteAttemptInput): SharedKeyQuoteAttemptReference {
	return {
		...input,
		transitionId: 'transition-a',
		quoteVersionId: 'quote-a',
		sellerUserId: 'seller-a',
		claimedAt: '2026-09-25T00:00:00.000Z',
	};
}

function usage(raw = '{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}'): UsageFromStream {
	return {
		...EMPTY_USAGE,
		input_tokens: 7,
		output_tokens: 3,
		total_tokens: 10,
		raw_usage: raw,
	};
}

async function claimed() {
	const capture = createSharedKeyQuoteAttemptCapture(requestLogId, async input => reference(input));
	const selectedReference = await capture.beforeFetch({
		providerKeyId, targetId: routeTargetId,
	} as RouteResult);
	assert.ok(selectedReference);
	return { capture, selectedReference };
}

test('actual buyer basis uses selected provider evidence and v2 critical-write input', async () => {
	const { capture, selectedReference } = await claimed();
	capture.fetchBoundaryPermitted(selectedReference);
	capture.upstreamHeadersObserved(selectedReference, 200);
	assert.equal(await capture.observeProviderUsage(selectedReference, usage()), true);
	const outbox = await prepareSharedKeyEconomicUsageHandoff({
		requestLogId, providerKeyId, routeTargetId, usage: usage(),
		shouldChargeBudget: true, chargedCost: 0.00001,
		ordinarySettlement: {
			requestId: requestLogId, budgetEpoch: 1,
			reservedMicros: 100, unknownCost: false,
		},
		economic: { handoff: capture.handoff(), selectedReference },
	});
	assert.equal(outbox.eventVersion, 2);
	assert.equal(outbox.buyerChargeBasis, 'actual');
	assert.equal(outbox.buyerUsageCertainty, 'actual');
	assert.deepEqual(outbox.attempts.map(row => [row.usageCertainty, row.inputTokens,
		row.providerCostCertainty, row.providerCostMicros]), [['actual', 7, 'unknown', null]]);
});

test('ambiguous provider outcome can only hand off an independently reserved buyer debit', async () => {
	const { capture, selectedReference } = await claimed();
	capture.fetchBoundaryPermitted(selectedReference);
	capture.transportAmbiguous(selectedReference);
	const economic = { handoff: capture.handoff(), selectedReference };
	const reserved = await prepareSharedKeyEconomicUsageHandoff({
		requestLogId, providerKeyId, routeTargetId, usage: EMPTY_USAGE,
		shouldChargeBudget: false, chargedCost: 0,
		ordinarySettlement: {
			requestId: requestLogId, budgetEpoch: 1,
			reservedMicros: 100, unknownCost: true,
		},
		economic,
	});
	assert.equal(reserved.buyerChargeBasis, 'reserved');
	assert.equal(reserved.buyerUsageCertainty, 'unknown');
	assert.equal(reserved.attempts[0]?.usageCertainty, 'unknown');
	await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
		requestLogId, providerKeyId, routeTargetId, usage: EMPTY_USAGE,
		shouldChargeBudget: false, chargedCost: 0,
		ordinarySettlement: {
			requestId: requestLogId, budgetEpoch: 1,
			reservedMicros: 100, unknownCost: false,
		},
		economic,
	}), /requires reserved buyer debit/);
});

test('an actual zero buyer settlement requires a selected provider-reported zero', async () => {
	const { capture, selectedReference } = await claimed();
	capture.fetchBoundaryPermitted(selectedReference);
	capture.upstreamHeadersObserved(selectedReference, 200);
	const zeroUsage = { ...EMPTY_USAGE,
		raw_usage: '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}' };
	assert.equal(await capture.observeProviderUsage(selectedReference, zeroUsage), true);
	const actual = await prepareSharedKeyEconomicUsageHandoff({
		requestLogId, providerKeyId, routeTargetId, usage: zeroUsage,
		shouldChargeBudget: false, chargedCost: 0,
		ordinarySettlement: {
			requestId: requestLogId, budgetEpoch: 1,
			reservedMicros: 100, unknownCost: false,
		},
		economic: { handoff: capture.handoff(), selectedReference },
	});
	assert.equal(actual.buyerChargeBasis, 'actual');
	assert.equal(actual.buyerUsageCertainty, 'actual');
	assert.equal(actual.attempts[0]?.inputTokens, 0);
});

test('earlier sent shared-key attempt retains the aggregate reserve after non-shared success', async () => {
	const { capture, selectedReference } = await claimed();
	capture.fetchBoundaryPermitted(selectedReference);
	capture.upstreamHeadersObserved(selectedReference, 429);
	const input = {
		requestLogId, providerKeyId: 'provider-key:private', routeTargetId: 'route-private',
		usage: usage(), shouldChargeBudget: true, chargedCost: 0.00001,
		ordinarySettlement: undefined,
		economic: { handoff: capture.handoff(), selectedReference: null },
	};
	assert.equal(hasPotentiallyBillableUnknownSharedKeyAttempt(input.economic.handoff), true);
	await assert.rejects(prepareSharedKeyEconomicUsageHandoff(input),
		/requires reserved buyer debit/);
	const outbox = await prepareSharedKeyEconomicUsageHandoff({
		...input,
		ordinarySettlement: {
			requestId: requestLogId, budgetEpoch: 1,
			reservedMicros: 300, unknownCost: true,
		},
	});
	assert.equal(outbox.buyerChargeBasis, 'reserved');
	assert.equal(outbox.buyerUsageCertainty, 'unknown');
	assert.equal(outbox.attempts[0]?.usageCertainty, 'unknown');
	assert.equal(outbox.attempts[0]?.providerCostCertainty, 'unknown');
});

test('multi-attempt Chat usage and response cost fields cannot assert a provider bill', async () => {
	const capture = createSharedKeyQuoteAttemptCapture(requestLogId, async input => reference(input));
	const earlier = await capture.beforeFetch({ providerKeyId, targetId: routeTargetId } as RouteResult);
	const selected = await capture.beforeFetch({
		providerKeyId: 'sharedkey:shared-b', targetId: 'route-shared-b',
	} as RouteResult);
	assert.ok(earlier && selected);
	capture.fetchBoundaryPermitted(earlier);
	capture.upstreamHeadersObserved(earlier, 429);
	capture.fetchBoundaryPermitted(selected);
	capture.upstreamHeadersObserved(selected, 200);
	const earlierReported = usage('{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10,"cost":0.111}');
	const selectedReported = usage('{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10,"cost":0.222}');
	assert.equal(await capture.observeProviderUsage(earlier, earlierReported), false);
	assert.equal(await capture.observeProviderUsage(selected, selectedReported), true);
	const handoff = capture.handoff();
	const input = {
		requestLogId, providerKeyId: 'sharedkey:shared-b', routeTargetId: 'route-shared-b',
		usage: selectedReported, shouldChargeBudget: true, chargedCost: 0.00001,
		ordinarySettlement: {
			requestId: requestLogId, budgetEpoch: 1,
			reservedMicros: 300, unknownCost: true,
		},
		economic: { handoff, selectedReference: selected },
	};
	assert.equal(hasPotentiallyBillableUnknownSharedKeyAttempt(handoff), true);
	await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
		...input, ordinarySettlement: { ...input.ordinarySettlement, unknownCost: false },
	}), /requires reserved buyer debit/);
	const prepared = await prepareSharedKeyEconomicUsageHandoff(input);
	assert.equal(prepared.buyerChargeBasis, 'reserved');
	assert.deepEqual(prepared.attempts.map(outcome => [
		outcome.usageCertainty, outcome.providerCostCertainty, outcome.providerCostMicros,
	]), [['unknown', 'unknown', null], ['actual', 'unknown', null]]);
	for (const index of [0, 1]) {
		for (const certainty of ['actual', 'unknown'] as const) {
			const forgedCost = {
				...handoff,
				economicOutcomes: handoff.economicOutcomes.map((outcome, candidate) =>
					candidate === index ? { ...outcome,
						providerCostCertainty: certainty, providerCostMicros: 222000 } : outcome),
			};
			await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
				...input, economic: { handoff: forgedCost, selectedReference: selected },
			}), /provider cost has no verified bill fact/);
		}
	}
	const forgedEarlierUsage = {
		...handoff,
		economicOutcomes: handoff.economicOutcomes.map((outcome, candidate) =>
			candidate === 0 ? { ...outcome, usageCertainty: 'actual' as const,
				inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } : outcome),
	};
	await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
		...input, economic: { handoff: forgedEarlierUsage, selectedReference: selected },
	}), /Earlier shared-key attempt has unowned usage facts/);
});

test('claim-only quote needs no exposure reserve; terminal sent 429 does', async () => {
	const { capture, selectedReference } = await claimed();
	assert.equal(hasPotentiallyBillableUnknownSharedKeyAttempt(capture.handoff()), false);
	capture.fetchBoundaryPermitted(selectedReference);
	assert.equal(hasPotentiallyBillableUnknownSharedKeyAttempt(capture.handoff()), true);
	capture.upstreamHeadersObserved(selectedReference, 429);
	const handoff = capture.handoff();
	assert.equal(hasPotentiallyBillableUnknownSharedKeyAttempt(handoff), true);
	await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
		requestLogId, providerKeyId, routeTargetId, usage: EMPTY_USAGE,
		shouldChargeBudget: false, chargedCost: 0,
		ordinarySettlement: { requestId: requestLogId, budgetEpoch: 1,
			reservedMicros: 300, unknownCost: false },
		economic: { handoff, selectedReference },
	}), /requires reserved buyer debit/);
	const reserved = await prepareSharedKeyEconomicUsageHandoff({
		requestLogId, providerKeyId, routeTargetId, usage: EMPTY_USAGE,
		shouldChargeBudget: false, chargedCost: 0,
		ordinarySettlement: { requestId: requestLogId, budgetEpoch: 1,
			reservedMicros: 300, unknownCost: true },
		economic: { handoff, selectedReference },
	});
	assert.equal(reserved.buyerChargeBasis, 'reserved');
	const invalid = { ...handoff, transport: [{ ...handoff.transport[0]!, stage: 'unrecognized' as never }] };
	assert.throws(() => hasPotentiallyBillableUnknownSharedKeyAttempt(invalid), /invalid transport stage/);
});

test('actual buyer basis rejects wrong reference, mismatched aggregate and digest', async () => {
	const { capture, selectedReference } = await claimed();
	capture.fetchBoundaryPermitted(selectedReference);
	capture.upstreamHeadersObserved(selectedReference, 200);
	assert.equal(await capture.observeProviderUsage(selectedReference, usage()), true);
	const handoff = capture.handoff();
	const base = {
		requestLogId, providerKeyId, routeTargetId, usage: usage(),
		shouldChargeBudget: true, chargedCost: 0.00001,
		ordinarySettlement: undefined,
		economic: { handoff, selectedReference },
	};
	await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
		...base, economic: { handoff, selectedReference: { ...selectedReference } },
	}), /reference differs/);
	await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
		...base, usage: { ...usage(), input_tokens: 8 },
	}), /no matching selected provider fact/);
	await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
		...base, usage: usage('{ "prompt_tokens":7,"completion_tokens":3,"total_tokens":10 }'),
	}), /digest differs/);
	await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
		...base, economic: { handoff, selectedReference: null },
	}), /no quote reference/);
});

test('review-only economic adapter rejects non-PostgreSQL before recording usage', async () => {
	const { capture, selectedReference } = await claimed();
	const producer = createPostgresSharedKeyEconomicProducer({ driver: 'postgres' } as PostgresDatabaseClient);
	await assert.rejects(producer.recordUsageAndOutbox(
		{ client: { driver: 'd1' } } as GatewayRepositories,
		{ request_log_id: requestLogId } as Parameters<typeof producer.recordUsageAndOutbox>[1],
		capture.handoff(), selectedReference,
	), /requires PostgreSQL/);
});

test('economic adapter rejects an aliased or wrong-login buyer before usage reads', async () => {
	const { capture, selectedReference } = await claimed();
	const usageInput = { request_log_id: requestLogId } as Parameters<
		ReturnType<typeof createPostgresSharedKeyEconomicProducer>['recordUsageAndOutbox']
	>[1];
	const identity = (role: string) => [{ current_role: role, session_role: role }];
	const runtimeRaw = { unsafe: async () => identity('cinatoken_gateway_runtime') };
	const sameRaw = createPostgresSharedKeyEconomicProducer({
		driver: 'postgres', raw: runtimeRaw,
	} as unknown as PostgresDatabaseClient);
	const repositories = { client: { driver: 'postgres', raw: runtimeRaw } } as GatewayRepositories;
	await assert.rejects(sameRaw.recordUsageAndOutbox(repositories, usageInput,
		capture.handoff(), selectedReference), /must be distinct/);
	const wrongBuyer = createPostgresSharedKeyEconomicProducer({
		driver: 'postgres', raw: { unsafe: async () => identity('cinatoken_gateway_runtime') },
	} as unknown as PostgresDatabaseClient);
	await assert.rejects(wrongBuyer.recordUsageAndOutbox(repositories, usageInput,
		capture.handoff(), selectedReference), /LOGINs required/);
	assert.throws(() => createPostgresSharedKeyEconomicProducer({
		driver: 'd1',
	} as unknown as PostgresDatabaseClient), /requires PostgreSQL/);
});

test('economic usage cannot fall through to the ordinary runtime critical writer', async () => {
	const { capture, selectedReference } = await claimed();
	let runtimeReads = 0;
	const repos = {
		client: { driver: 'postgres', raw: {} },
		users: { getById: async () => { runtimeReads += 1; return null; } },
	} as unknown as GatewayRepositories;
	const params = {
		shared_key_economic_handoff: { handoff: capture.handoff(), selectedReference },
	} as Parameters<typeof recordUsage>[1];
	await assert.rejects(recordUsage(repos, params), /dedicated buyer critical writer/);
	assert.equal(runtimeReads, 0);
	const runtimeRaw = { unsafe: async () => [{
		current_role: 'cinatoken_gateway_runtime',
		session_role: 'cinatoken_gateway_runtime',
	}] };
	const wrongBuyer = { driver: 'postgres', raw: { unsafe: runtimeRaw.unsafe } } as unknown as PostgresDatabaseClient;
	await assert.rejects(recordUsage(
		{ ...repos, client: { driver: 'postgres', raw: runtimeRaw } } as GatewayRepositories,
		params, wrongBuyer,
	), /LOGINs required/);
	assert.equal(runtimeReads, 0);
});

test('conflicting provider usage aliases cannot support an actual buyer or shared attempt', async () => {
	for (const raw of [
		'{"prompt_tokens":7,"input_tokens":8,"completion_tokens":3,"total_tokens":10}',
		'{"prompt_tokens":7,"completion_tokens":3,"output_tokens":4,"total_tokens":10}',
	]) {
		assert.equal(providerUsageFacts(usage(raw)), null);
		const { capture, selectedReference } = await claimed();
		capture.fetchBoundaryPermitted(selectedReference);
		capture.upstreamHeadersObserved(selectedReference, 200);
		assert.equal(await capture.observeProviderUsage(selectedReference, usage(raw)), false);
		await assert.rejects(prepareSharedKeyEconomicUsageHandoff({
			requestLogId, providerKeyId: 'provider-key:private', routeTargetId: 'route-private',
			usage: usage(raw), shouldChargeBudget: true, chargedCost: 0.00001,
			ordinarySettlement: undefined,
			economic: { handoff: capture.handoff(), selectedReference: null },
		}), /requires reserved buyer debit/);
	}
});
