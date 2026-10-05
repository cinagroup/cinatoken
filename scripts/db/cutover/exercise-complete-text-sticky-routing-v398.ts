import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { PostgresDatabaseClient } from '../../../packages/core/src/storage/database-client';
import type { CredentialFreeRoutingProjectionV396 } from '../../../packages/proxy/src/services/postgres-complete-text-routing-projection-v396';
import type { CredentialFreeStickyContextV398 } from '../../../packages/proxy/src/services/credential-free-route-attempts-v398';
import { createPostgresCompleteTextStickyRoutingV398 } from '../../../packages/proxy/src/services/postgres-complete-text-sticky-routing-v398';
import { startJournalCommitAckDropProxyV381 } from '../../../packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs';

type Sql = PostgresDatabaseClient['raw'];
type Params = { stickyConnectionString: string; projection: CredentialFreeRoutingProjectionV396;
	candidateIndex: number; selectedTargetId: string; auditor: Sql; stage: (name: string, detail?: Record<string, unknown>) => void;
	getFreshProjection?: () => Promise<CredentialFreeRoutingProjectionV396> };
function fixture(p: Params) {
	const candidate = p.projection.candidates[p.candidateIndex]!;
	const route = candidate.routes.find(r => r.targetId === p.selectedTargetId)!;
	assert.ok(route?.routePoolId);
	const context = { quoteId: p.projection.quoteId, requestId: p.projection.requestId, finalBodySha256: p.projection.finalBodySha256,
		routingEpoch: p.projection.routingEpoch, candidateIndex: p.candidateIndex, routePoolId: route.routePoolId!,
		affinityHash: createHash('sha256').update(`owned-v398:${p.projection.quoteId}`).digest('hex'),
		sessionControlled: true, successPolicy: 'stream_success' as const };
	return { context, port: createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: p.stickyConnectionString, context }) };
}
const bindInput = (context: Pick<CredentialFreeStickyContextV398, 'routePoolId' | 'affinityHash'>, target: string, token: string, expectedToken?: string) => ({
	routePoolId: context.routePoolId, affinityHash: context.affinityHash, routeTargetId: target, bindingToken: token,
	poolEpoch: 0, expiresAt: '2099-01-01T00:00:00Z', nowIso: '2000-01-01T00:00:00Z', expectedToken });

/** Run before any send: a quote alone cannot authorize a sticky mutation. */
export async function exerciseCompleteTextStickyBeforeSendV398(p: Params) {
	const { context, port } = fixture(p);
	assert.equal(await port.routePoolSticky.getBinding(context.routePoolId, context.affinityHash), null);
	await assert.rejects(port.routePoolSticky.tryBind(bindInput(context, p.selectedTargetId, randomUUID())),
		(error: any) => error?.code === '23514' && /proof missing/u.test(error.message));
	p.stage('v398-before-send-quote-cannot-authorize-sticky-write');
}

async function exerciseCompleteTextStickyProofGuardsV398(p: Params) {
	const { context, port } = fixture(p);
	await assert.rejects(port.routePoolSticky.tryBind(bindInput(context, 'not-a-quote-route', randomUUID())),
		(error: any) => error?.code === '23514');
	const cacheContext = { ...context, successPolicy: 'cache_hit' as const,
		affinityHash: createHash('sha256').update(`cache:${context.affinityHash}`).digest('hex') };
	const cachePort = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: p.stickyConnectionString, context: cacheContext });
	const [usage] = await p.auditor.unsafe(`SELECT o.observation->>'cacheReadTokens' AS cache_read,m.beneficial_cache_read_pricing AS beneficial
	 FROM cinatoken_response_observation.observations_v392 o JOIN cinatoken_gateway.complete_text_attempt_grants_v362 g ON g.grant_id=o.grant_id
	 JOIN cinatoken_gateway.complete_text_routing_members_v396 m ON m.quote_id=g.quote_id AND m.route_target_id=g.route_target_id
	 WHERE g.quote_id=$1::uuid AND g.candidate_index=$2::integer AND g.route_target_id=$3::text`, [context.quoteId, p.candidateIndex, p.selectedTargetId]);
	if (!(Number(usage?.cache_read) > 0 && usage?.beneficial === true)) {
		await assert.rejects(cachePort.routePoolSticky.tryBind(bindInput(cacheContext, p.selectedTargetId, randomUUID())),
			(error: any) => error?.code === '23514' && /proof missing/u.test(error.message));
		p.stage('v398-implicit-cache-sticky-requires-real-cache-read-and-beneficial-price');
	}
	const sourceUrl = new URL(p.stickyConnectionString);
	const proxy = await startJournalCommitAckDropProxyV381({ upstreamPort: Number(sourceUrl.port) });
	const proxyUrl = new URL(sourceUrl); proxyUrl.port = String(proxy.port);
	try {
		const lostPort = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: proxyUrl.toString(), context });
		const unknownToken = randomUUID();
		await assert.rejects(lostPort.routePoolSticky.tryBind(bindInput(context, p.selectedTargetId, unknownToken)));
		await proxy.waitForDrop();
		assert.equal(proxy.facts.connections, 1); assert.equal(proxy.facts.droppedCommitAcks, 1);
		assert.equal((await port.routePoolSticky.getBinding(context.routePoolId, context.affinityHash))!.binding_token, unknownToken);
		assert.equal(await port.routePoolSticky.clearBinding({ routePoolId: context.routePoolId, affinityHash: context.affinityHash, expectedToken: unknownToken }), true);
		p.stage('v398-physical-COMMIT-ACK-loss-independent-binding-read-no-automatic-retry', { proxyFacts: { ...proxy.facts } });
	} finally { await proxy.close(); }
}

/** Run only after the actual v394 holder has committed its v392 observation. */
export async function exerciseCompleteTextStickyAfterObservationV398(p: Params) {
	const { context, port } = fixture(p); const first = randomUUID(), second = randomUUID();
	const [before] = await p.auditor.unsafe(`SELECT
	 (SELECT count(*) FROM cinatoken_gateway.complete_text_result_facts_v366) AS facts,
	 (SELECT count(*) FROM cinatoken_response_observation.observations_v392) AS observations,
	 (SELECT count(*) FROM cinatoken_gateway.user_budget_reservations WHERE state='dispatched') AS holds`);
	assert.equal(await port.routePoolSticky.tryBind(bindInput(context, p.selectedTargetId, first)), true);
	assert.equal(await port.routePoolSticky.tryBind(bindInput(context, p.selectedTargetId, second)), false);
	const row = await port.routePoolSticky.getBinding(context.routePoolId, context.affinityHash);
	assert.equal(row!.binding_token, first);
	assert.ok(Date.parse(row!.expires_at) - Date.parse(row!.updated_at!) >= 599_000);
	assert.ok(Date.parse(row!.expires_at) - Date.parse(row!.updated_at!) <= 601_000);
	assert.equal(await port.routePoolSticky.touchBinding({ routePoolId: context.routePoolId, affinityHash: context.affinityHash,
		expectedToken: second, nowIso: '2000-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }), false);
	assert.equal(await port.routePoolSticky.tryBind(bindInput(context, p.selectedTargetId, second, first)), true);
	assert.equal(await port.routePoolSticky.clearBinding({ routePoolId: context.routePoolId, affinityHash: context.affinityHash, expectedToken: first }), false);
	assert.equal(await port.routePoolSticky.clearBinding({ routePoolId: context.routePoolId, affinityHash: context.affinityHash, expectedToken: second }), true);
	assert.equal(await port.routePoolSticky.getBinding(context.routePoolId, context.affinityHash), null);
	await exerciseCompleteTextStickyProofGuardsV398(p);
	const [after] = await p.auditor.unsafe(`SELECT
	 (SELECT count(*) FROM cinatoken_gateway.complete_text_result_facts_v366) AS facts,
	 (SELECT count(*) FROM cinatoken_response_observation.observations_v392) AS observations,
	 (SELECT count(*) FROM cinatoken_gateway.user_budget_reservations WHERE state='dispatched') AS holds`);
	assert.deepEqual(after, before);
	p.stage('v398-real-observation-cas-bind-rebind-clear-server-ttl-no-financial-write');
	if (p.getFreshProjection) {
		const deadline = Date.parse(p.projection.expiresAt) + 30;
		assert.ok(deadline - Date.now() <= 61_000, 'fixture cannot wait for an unbounded projection expiry');
		while (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(25_000, deadline - Date.now())));
		await assert.rejects(port.routePoolSticky.getBinding(context.routePoolId, context.affinityHash), (error: any) => error?.code === '23514');
		const lateToken = randomUUID();
		assert.equal(await port.routePoolSticky.tryBind(bindInput(context, p.selectedTargetId, lateToken)), true);
		assert.equal(await port.routePoolSticky.touchBinding({ routePoolId: context.routePoolId, affinityHash: context.affinityHash,
			expectedToken: lateToken, nowIso: '2000-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }), true);
		const fresh = await p.getFreshProjection();
		const freshPort = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: p.stickyConnectionString,
			context: { ...context, quoteId: fresh.quoteId, requestId: fresh.requestId, finalBodySha256: fresh.finalBodySha256, routingEpoch: fresh.routingEpoch } });
		assert.equal((await freshPort.routePoolSticky.getBinding(context.routePoolId, context.affinityHash))!.binding_token, lateToken);
		assert.equal(await port.routePoolSticky.clearBinding({ routePoolId: context.routePoolId, affinityHash: context.affinityHash, expectedToken: lateToken }), true);
		p.stage('v398-expired-projection-post-response-bind-touch-clear-fresh-quote-independent-read', { originalExpiresAt: p.projection.expiresAt });
	}
}
