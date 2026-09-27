import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { PostgresDatabaseClient } from '../../../packages/core/src/storage/database-client';
// @ts-expect-error The owned native JavaScript proxy fixture has no declaration file.
import { startJournalCommitAckDropProxyV381 } from '../../../packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs';
import { createFinalChatQuoteSnapshot } from '../../../packages/proxy/src/services/chat-final-quote-input';
import { parseOpenAiModelFallbacks } from '../../../packages/proxy/src/services/model-fallbacks';
import { authenticatePostgresPersonalKeyV395, PostgresPersonalPeriodPendingV395 } from '../../../packages/proxy/src/services/postgres-personal-key-auth-v395';
import { issuePostgresCompleteChatQuoteV360 } from '../../../packages/proxy/src/services/postgres-complete-chat-quote-v360';
import { admitPostgresCompleteChatQuoteV361 } from '../../../packages/proxy/src/services/postgres-complete-chat-admission-v361';
import { grantPostgresCompleteTextAttemptV362 } from '../../../packages/proxy/src/services/postgres-complete-text-attempt-grant-v362';
import { confirmPostgresCompleteTextNoFetchV370 } from '../../../packages/proxy/src/services/postgres-complete-text-no-fetch-v372';
import { closePostgresCompleteTextNoFetchV388 } from '../../../packages/proxy/src/services/postgres-complete-text-no-fetch-close-v388';
import { readPostgresCompleteTextRoutingProjectionV396 } from '../../../packages/proxy/src/services/postgres-complete-text-routing-projection-v396';
import { attestCompleteTextRoutingV396 } from './attest-complete-text-routing-v396';

type Sql = PostgresDatabaseClient['raw'];
type Urls = { runtime: string; auth: string; cap: string; complete: string; admission: string;
	granter: string; verifier: string; projector: string; resolver: string; closer: string };
type Params = { auditor: Sql; runtimeClient: Pick<PostgresDatabaseClient, 'driver' | 'raw'>; urls: Urls;
	pastDeadline: (grantId: string) => Promise<unknown>; stage: (name: string, detail?: Record<string, unknown>) => void;
	modelId?: string };
const g = 'cinatoken_gateway';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Run after the cloned v397 recovery/count assertions on the same owned v400
 * database. A separate personal identity keeps sent main-fixture obligations
 * intact while proving legal auth period rollover and old-quote invalidation.
 */
export async function exerciseCompleteTextCoInstallInvariantsV400(p: Params) {
	const suffix = randomUUID(), userId = `v400-auth-user-${suffix}`;
	const workspaceId = `v400-auth-workspace-${suffix}`, keyId = `v400-auth-key-${suffix}`;
	const bearer = `sk-v400-owned-auth-${suffix}`, hash = `sha256:${sha(bearer)}`;
	await p.auditor.unsafe(`INSERT INTO ${g}.users(id,email,budget_max,budget_base,budget_spent,budget_period)
	 VALUES($1,$2,9,7,1,'none')`, [userId, `${suffix}@example.invalid`]);
	await p.auditor.unsafe(`INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
	 VALUES($1,'personal',$2,'Owned v400 auth',$3,'active')`, [workspaceId, userId, `v400-${suffix}`]);
	await p.auditor.unsafe(`INSERT INTO ${g}.api_keys(id,key,key_hash,user_id,workspace_id,status)
	 VALUES($1,$2,$3,$4,$5,'active')`, [keyId, `hashref:${hash}`, hash, userId, workspaceId]);
	const auth = () => authenticatePostgresPersonalKeyV395({ authConnectionString: p.urls.auth, bearer });
	const initial = await auth();
	assert.equal(initial?.keyId, keyId); assert.equal(initial?.userId, userId);
	assert.equal(initial?.workspaceId, workspaceId); assert.equal(initial?.budgetEpoch, 0);
	const financial = async () => {
		const user = await p.auditor.unsafe(`SELECT to_jsonb(u) AS value FROM ${g}.users u WHERE id=$1`, [userId]);
		const holds = await p.auditor.unsafe(`SELECT to_jsonb(r) AS value FROM ${g}.user_budget_reservations r WHERE user_id=$1 ORDER BY request_id`, [userId]);
		const guardrails = await p.auditor.unsafe(`SELECT to_jsonb(r) AS value FROM ${g}.guardrail_budget_reservations r WHERE workspace_id=$1 ORDER BY id`, [workspaceId]);
		const windows = await p.auditor.unsafe(`SELECT to_jsonb(w) AS value FROM ${g}.guardrail_budget_windows w WHERE workspace_id=$1 ORDER BY scope_type,scope_id,period,period_start`, [workspaceId]);
		const audits = await p.auditor.unsafe(`SELECT to_jsonb(a) AS value FROM ${g}.user_audit_logs a WHERE user_id=$1 ORDER BY id`, [userId]);
		return JSON.stringify({ user, holds, guardrails, windows, audits });
	};
	const makeDue = () => p.auditor.unsafe(`UPDATE ${g}.users SET budget_period='daily',
	 budget_reset_at=clock_timestamp()-interval '1 day' WHERE id=$1`, [userId]);
	const quote = async () => {
		const authenticated = await auth(); assert.ok(authenticated);
		const body = { model: p.modelId ?? 'v361-model', messages: [{ role: 'user', content: 'owned auth coinstall invariant' }], max_completion_tokens: 250 };
		const parsed = parseOpenAiModelFallbacks(body); assert.equal(parsed.ok, true);
		if (!parsed.ok) throw new Error('Owned v400 fixture parse rejected');
		const input = await createFinalChatQuoteSnapshot({ requestId: `v400-auth-${randomUUID()}`,
			originalBodySha256: sha(JSON.stringify(body)), finalBody: body, parsed: parsed.value });
		const issued = await issuePostgresCompleteChatQuoteV360({ runtimeClient: p.runtimeClient as PostgresDatabaseClient,
			runtimeConnectionString: p.urls.runtime, capabilityConnectionString: p.urls.cap,
			quoteConnectionString: p.urls.complete, bearer, identity: { apiKeyId: keyId, userId, workspaceId,
				budgetEpoch: authenticated.budgetEpoch, keyLimitEpoch: authenticated.keyLimitEpoch }, finalQuoteInput: input });
		await attestCompleteTextRoutingV396({ verifierConnectionString: p.urls.verifier, modelIds: issued.modelIds });
		const projection = await readPostgresCompleteTextRoutingProjectionV396({ projectorConnectionString: p.urls.projector,
			quote: issued, finalQuoteInput: input });
		return { input, quote: issued, projection };
	};
	// One pre-reset quote remains unadmitted; another acquires a real ordinary
	// reservation and subsequently a never-started, routing-fenced grant.
	const old = await quote(), held = await quote();
	const admission = await admitPostgresCompleteChatQuoteV361({ runtimeClient: p.runtimeClient as PostgresDatabaseClient,
		runtimeConnectionString: p.urls.runtime, admissionConnectionString: p.urls.admission,
		quote: held.quote, guardrailIntents: [] });
	assert.equal(admission.status, 'admitted'); assert.equal(admission.ordinary, 'reserved');
	await makeDue(); const admittedBefore = await financial();
	await assert.rejects(auth(), PostgresPersonalPeriodPendingV395);
	assert.equal(await financial(), admittedBefore);
	p.stage('v400-actual-auth-due-admitted-ordinary-hold-remains-pending-with-financial-state-preserved');
	// A due period independently blocks v362 grant. Restore the same epoch's
	// no-period configuration before creating the genuine never-started grant.
	await p.auditor.unsafe(`UPDATE ${g}.users SET budget_period='none',budget_reset_at=NULL WHERE id=$1`, [userId]);
	const target = held.projection.candidates[0]!.routes.find(r => r.defaultEndpointEligible
		&& r.maxCompletionTokens !== null && r.maxCompletionTokens >= 250)!;
	assert.ok(target, 'owned no-fetch fixture needs an actually projected eligible route');
	const [route] = await p.auditor.unsafe(`SELECT * FROM ${g}.complete_text_quote_routes_v360
	 WHERE quote_id=$1::uuid AND candidate_index=0 AND route_target_id=$2`, [held.quote.quoteId, target.targetId]);
	assert.ok(route);
	const claim = { requestId: held.quote.requestId, quoteId: held.quote.quoteId, finalBodySha256: held.quote.finalBodySha256,
		candidateIndex: 0, modelId: route.model_id, routeTargetId: route.route_target_id, providerId: route.provider_id,
		endpointId: route.endpoint_id, credentialClass: route.credential_class, credentialId: route.credential_id,
		providerCiphertextSha256: route.provider_ciphertext_sha256, preparedRouteSourceSha256: sha('owned-v400-never-started-route'),
		method: 'POST' as const, upstreamUrlSha256: sha('https://v367-local.invalid/v1/chat/completions'),
		outboundBodySha256: sha(held.input.finalBodyUtf8), outboundBodyCanonicalSha256: sha(JSON.stringify(JSON.parse(held.input.finalBodyUtf8))),
		outboundBodyBytes: Buffer.byteLength(held.input.finalBodyUtf8), credentialFingerprintSha256: sha('owned-v400-never-started-credential') };
	const grant = await grantPostgresCompleteTextAttemptV362({ granterConnectionString: p.urls.granter, attemptNonce: randomUUID(), claim });
	await makeDue();
	const grantedBefore = await financial();
	await assert.rejects(auth(), PostgresPersonalPeriodPendingV395); assert.equal(await financial(), grantedBefore);
	p.stage('v400-actual-auth-due-projected-never-started-grant-remains-pending-with-reserved-amount-preserved');
	await p.pastDeadline(grant.grantId);
	const resolution = await confirmPostgresCompleteTextNoFetchV370({ resolverConnectionString: p.urls.resolver,
		grantId: grant.grantId, resolutionNonce: randomUUID() });
	const closed = await closePostgresCompleteTextNoFetchV388({ closerConnectionString: p.urls.closer,
		requestId: held.quote.requestId, grantId: grant.grantId, resolutionId: resolution.resolutionId, decisionNonce: randomUUID() });
	assert.equal(closed.status, 'closed_no_fetch');
	const [proof] = await p.auditor.unsafe(`SELECT
	 (SELECT count(*) FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1) AS starts,
	 (SELECT count(*) FROM cinatoken_response_observation.observations_v392 WHERE request_id=$1) AS observations,
	 (SELECT count(*) FROM ${g}.complete_text_platform_terminals_v388 WHERE request_id=$1) AS terminals,
	 (SELECT count(*) FROM ${g}.complete_text_platform_outbox_v388 WHERE request_id=$1) AS events,
	 (SELECT count(*) FROM ${g}.api_key_request_logs WHERE id=$1) AS logs,
	 (SELECT state FROM ${g}.user_budget_reservations WHERE request_id=$1) AS ordinary_state`, [held.quote.requestId]);
	assert.deepEqual({ starts: Number(proof!.starts), observations: Number(proof!.observations), terminals: Number(proof!.terminals),
		events: Number(proof!.events), logs: Number(proof!.logs), state: proof!.ordinary_state },
	{ starts: 0, observations: 0, terminals: 1, events: 1, logs: 1, state: 'settled' });
	const reset = await auth(); assert.equal(reset?.budgetEpoch, 1); assert.equal(reset?.budgetSpent, 0); assert.equal(reset?.budgetMax, 7);
	const resetBefore = await financial(); assert.equal((await auth())?.budgetEpoch, 1); assert.equal(await financial(), resetBefore);
	await assert.rejects(readPostgresCompleteTextRoutingProjectionV396({ projectorConnectionString: p.urls.projector,
		quote: old.quote, finalQuoteInput: old.input }), (error: any) => error?.status === 'stale');
	await assert.rejects(admitPostgresCompleteChatQuoteV361({ runtimeClient: p.runtimeClient as PostgresDatabaseClient,
		runtimeConnectionString: p.urls.runtime, admissionConnectionString: p.urls.admission, quote: old.quote,
		guardrailIntents: [] }), (error: any) => error?.status === 'stale');
	const [oldRows] = await p.auditor.unsafe(`SELECT
	 (SELECT count(*) FROM ${g}.complete_text_admissions_v361 WHERE request_id=$1) AS admissions,
	 (SELECT count(*) FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1) AS grants,
	 (SELECT count(*) FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1) AS starts`, [old.quote.requestId]);
	assert.deepEqual({ admissions: Number(oldRows!.admissions), grants: Number(oldRows!.grants), starts: Number(oldRows!.starts) },
	{ admissions: 0, grants: 0, starts: 0 });
	p.stage('v400-legal-v370-v388-terminal-enables-auth-reset-old-v396-quote-stale-no-admission-grant-or-start', {
		oldQuoteId: old.quote.quoteId, closedGrantId: grant.grantId, budgetEpoch: 1 });
	// Physical COMMIT response loss of a second legal reset releases no auth
	// receipt. A fresh direct LOGIN reconciles the one persisted audit/epoch.
	await makeDue();
	const [beforeAck] = await p.auditor.unsafe(`SELECT
	 (SELECT count(*) FROM ${g}.complete_text_quotes_v360) AS quotes,
	 (SELECT count(*) FROM ${g}.user_audit_logs WHERE user_id=$1 AND event_type='period_reset') AS audits`, [userId]);
	const port = Number(new URL(p.urls.runtime).port);
	assert.ok(Number.isSafeInteger(port) && port > 0);
	const proxy = await startJournalCommitAckDropProxyV381({ upstreamPort: port });
	try {
		const connection = new URL(p.urls.auth); connection.port = String(proxy.port);
		await assert.rejects(authenticatePostgresPersonalKeyV395({ authConnectionString: connection.href, bearer }));
		await proxy.waitForDrop();
		assert.equal(proxy.facts.connections, 1); assert.equal(proxy.facts.backendCommitCompletes, 1); assert.equal(proxy.facts.droppedCommitAcks, 1);
		const [persisted] = await p.auditor.unsafe(`SELECT u.budget_epoch,u.budget_spent,u.budget_reserved_micros,
		 (SELECT count(*) FROM ${g}.user_audit_logs WHERE user_id=u.id AND event_type='period_reset') AS audits
		 FROM ${g}.users u WHERE id=$1`, [userId]);
		assert.equal(Number(persisted!.budget_epoch), 2); assert.equal(Number(persisted!.budget_spent), 0);
		assert.equal(Number(persisted!.budget_reserved_micros), 0);
		assert.equal(Number(persisted!.audits), Number(beforeAck!.audits) + 1);
		assert.equal((await auth())?.budgetEpoch, 2);
		const [afterAck] = await p.auditor.unsafe(`SELECT
		 (SELECT count(*) FROM ${g}.complete_text_quotes_v360) AS quotes,
		 (SELECT count(*) FROM ${g}.user_audit_logs WHERE user_id=$1 AND event_type='period_reset') AS audits`, [userId]);
		assert.equal(Number(afterAck!.quotes), Number(beforeAck!.quotes));
		assert.equal(Number(afterAck!.audits), Number(persisted!.audits));
		p.stage('v400-real-auth-reset-COMMIT-ACK-loss-fresh-login-reconciles-one-epoch-audit-no-new-quote-or-send', { proxyFacts: { ...proxy.facts } });
	} finally { await proxy.close(); }
	await exerciseUnlimitedEpochGatesV400(p);
}

async function exerciseUnlimitedEpochGatesV400(p: Params) {
	const suffix = randomUUID(), userId = `v400-zero-user-${suffix}`;
	const workspaceId = `v400-zero-workspace-${suffix}`, keyId = `v400-zero-key-${suffix}`;
	const bearer = `sk-v400-owned-zero-${suffix}`, hash = `sha256:${sha(bearer)}`;
	await p.auditor.unsafe(`INSERT INTO ${g}.users(id,email,budget_max,budget_base,budget_spent,budget_period)
	 VALUES($1,$2,NULL,7,1,'none')`, [userId, `${suffix}@example.invalid`]);
	await p.auditor.unsafe(`INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
	 VALUES($1,'personal',$2,'Owned v400 zero hold',$3,'active')`, [workspaceId, userId, `v400-zero-${suffix}`]);
	await p.auditor.unsafe(`INSERT INTO ${g}.api_keys(id,key,key_hash,user_id,workspace_id,status)
	 VALUES($1,$2,$3,$4,$5,'active')`, [keyId, `hashref:${hash}`, hash, userId, workspaceId]);
	const auth = () => authenticatePostgresPersonalKeyV395({ authConnectionString: p.urls.auth, bearer });
	const makeDue = () => p.auditor.unsafe(`UPDATE ${g}.users SET budget_period='daily',
	 budget_reset_at=clock_timestamp()-interval '1 day' WHERE id=$1`, [userId]);
	const financial = async () => {
		const [row] = await p.auditor.unsafe(`SELECT to_jsonb(u) AS user,
		 (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY request_id),'[]'::jsonb) FROM ${g}.user_budget_reservations r WHERE user_id=u.id) AS holds,
		 (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb) FROM ${g}.guardrail_budget_reservations r WHERE workspace_id=$2) AS guardrails,
		 (SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY scope_type,scope_id,period,period_start),'[]'::jsonb) FROM ${g}.guardrail_budget_windows w WHERE workspace_id=$2) AS windows,
		 (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM ${g}.user_audit_logs a WHERE user_id=u.id) AS audits
		 FROM ${g}.users u WHERE id=$1`, [userId, workspaceId]);
		return JSON.stringify(row);
	};
	const admitted = async () => {
		const authenticated = await auth(); assert.ok(authenticated);
		const body = { model: p.modelId ?? 'v361-model', messages: [{ role: 'user', content: 'owned unlimited epoch invariant' }], max_completion_tokens: 250 };
		const parsed = parseOpenAiModelFallbacks(body); assert.equal(parsed.ok, true);
		if (!parsed.ok) throw new Error('Owned v400 unlimited fixture parse rejected');
		const input = await createFinalChatQuoteSnapshot({ requestId: `v400-zero-${randomUUID()}`,
			originalBodySha256: sha(JSON.stringify(body)), finalBody: body, parsed: parsed.value });
		const quote = await issuePostgresCompleteChatQuoteV360({ runtimeClient: p.runtimeClient as PostgresDatabaseClient,
			runtimeConnectionString: p.urls.runtime, capabilityConnectionString: p.urls.cap,
			quoteConnectionString: p.urls.complete, bearer, identity: { apiKeyId: keyId, userId, workspaceId,
				budgetEpoch: authenticated.budgetEpoch, keyLimitEpoch: authenticated.keyLimitEpoch }, finalQuoteInput: input });
		await attestCompleteTextRoutingV396({ verifierConnectionString: p.urls.verifier, modelIds: quote.modelIds });
		const projection = await readPostgresCompleteTextRoutingProjectionV396({ projectorConnectionString: p.urls.projector,
			quote, finalQuoteInput: input });
		const receipt = await admitPostgresCompleteChatQuoteV361({ runtimeClient: p.runtimeClient as PostgresDatabaseClient,
			runtimeConnectionString: p.urls.runtime, admissionConnectionString: p.urls.admission, quote, guardrailIntents: [] });
		assert.equal(receipt.status, 'admitted'); assert.equal(receipt.ordinary, 'unlimited'); assert.equal(receipt.guardrailCount, 0);
		const target = projection.candidates[0]!.routes.find(r => r.defaultEndpointEligible && r.maxCompletionTokens !== null && r.maxCompletionTokens >= 250)!;
		assert.ok(target);
		const [route] = await p.auditor.unsafe(`SELECT * FROM ${g}.complete_text_quote_routes_v360 WHERE quote_id=$1::uuid AND candidate_index=0 AND route_target_id=$2`, [quote.quoteId, target.targetId]);
		assert.ok(route);
		const claim = { requestId: quote.requestId, quoteId: quote.quoteId, finalBodySha256: quote.finalBodySha256,
			candidateIndex: 0, modelId: route.model_id, routeTargetId: route.route_target_id, providerId: route.provider_id,
			endpointId: route.endpoint_id, credentialClass: route.credential_class, credentialId: route.credential_id,
			providerCiphertextSha256: route.provider_ciphertext_sha256, preparedRouteSourceSha256: sha('owned-v400-unlimited-never-started-route'),
			method: 'POST' as const, upstreamUrlSha256: sha('https://v367-local.invalid/v1/chat/completions'),
			outboundBodySha256: sha(input.finalBodyUtf8), outboundBodyCanonicalSha256: sha(JSON.stringify(JSON.parse(input.finalBodyUtf8))),
			outboundBodyBytes: Buffer.byteLength(input.finalBodyUtf8), credentialFingerprintSha256: sha('owned-v400-unlimited-never-started-credential') };
		const [zero] = await p.auditor.unsafe(`SELECT budget_reserved_micros,
		 (SELECT count(*) FROM ${g}.user_budget_reservations WHERE request_id=$2) AS ordinary,
		 (SELECT count(*) FROM ${g}.guardrail_budget_reservations WHERE request_id=$2) AS guardrails
		 FROM ${g}.users WHERE id=$1`, [userId, quote.requestId]);
		assert.equal(Number(zero!.budget_reserved_micros), 0); assert.equal(Number(zero!.ordinary), 0); assert.equal(Number(zero!.guardrails), 0);
		return { quote, claim };
	};
	// A genuine unlimited admission has no hold or grant, so period reset is legal.
	// Its retained claim must still fail the actual v362 old-epoch grant gate.
	const old = await admitted();
	await makeDue(); assert.equal((await auth())?.budgetEpoch, 1);
	const oldBefore = await financial();
	await assert.rejects(grantPostgresCompleteTextAttemptV362({ granterConnectionString: p.urls.granter,
		attemptNonce: randomUUID(), claim: old.claim }), (error: any) => error?.status === 'stale');
	assert.equal(await financial(), oldBefore);
	const [noGrant] = await p.auditor.unsafe(`SELECT
	 (SELECT count(*) FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1) AS grants,
	 (SELECT count(*) FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1) AS starts`, [old.quote.requestId]);
	assert.equal(Number(noGrant!.grants), 0); assert.equal(Number(noGrant!.starts), 0);
	p.stage('v400-actual-admitted-unlimited-grant-free-quote-reset-invalidates-old-epoch-v362-claim', { oldQuoteId: old.quote.quoteId });
	await p.auditor.unsafe(`UPDATE ${g}.users SET budget_max=NULL,budget_period='none',budget_reset_at=NULL WHERE id=$1`, [userId]);
	const zero = await admitted();
	const grant = await grantPostgresCompleteTextAttemptV362({ granterConnectionString: p.urls.granter,
		attemptNonce: randomUUID(), claim: zero.claim });
	await makeDue(); const pendingBefore = await financial();
	await assert.rejects(auth(), PostgresPersonalPeriodPendingV395); assert.equal(await financial(), pendingBefore);
	const [unresolved] = await p.auditor.unsafe(`SELECT
	 (SELECT count(*) FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1) AS grants,
	 (SELECT count(*) FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1) AS starts,
	 (SELECT count(*) FROM ${g}.complete_text_platform_terminals_v388 WHERE request_id=$1) AS terminals,
	 (SELECT count(*) FROM ${g}.user_budget_reservations WHERE request_id=$1) AS ordinary,
	 (SELECT count(*) FROM ${g}.guardrail_budget_reservations WHERE request_id=$1) AS guardrails`, [zero.quote.requestId]);
	assert.deepEqual({ grants: Number(unresolved!.grants), starts: Number(unresolved!.starts), terminals: Number(unresolved!.terminals),
		ordinary: Number(unresolved!.ordinary), guardrails: Number(unresolved!.guardrails) }, { grants: 1, starts: 0, terminals: 0, ordinary: 0, guardrails: 0 });
	p.stage('v400-real-never-started-unresolved-unlimited-zero-hold-grant-still-blocks-auth-reset', {
		grantId: grant.grantId, grantClient: 'actual-v362-default-client', freshDedicatedLogin: true,
		factory: 'postgres-default-per-call', commitAndCloseAcknowledged: true,
		ordinaryRows: 0, guardrailRows: 0, sendStarts: 0,
	});
}
