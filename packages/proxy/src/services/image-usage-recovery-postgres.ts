import { createHash } from 'node:crypto';
import { resolveUpstreamEndpoint, type StorageContext } from '@octafuse/core';
import type { PostgresDatabaseClient } from '../../../core/src/storage/database-client';
import {
	createParentDispatchIntentRepositoryPostgres,
	type ParentDispatchAttemptBudget,
	type ParentDispatchIntentIdentity,
} from '../../../core/src/storage/recovery/dispatch-intent-postgres-parent';
import {
	createUsageSettlementFactsRepositoryPostgres,
} from '../../../core/src/storage/recovery/usage-settlement-facts-postgres';
import { createUsageRecoveryJobsPostgres } from '../../../core/src/storage/recovery/usage-recovery-jobs-postgres';
import { settlementId } from '@octafuse/core/storage/recovery/usage-settlement-codec';
import { prepareImageUsageWrite, type RecordImageUsageParams } from './image-usage-charge';
import { parseByokKeyId } from './byok-key-pool';
import { normalizeGenerationHttpReferer } from './generation-request-context';
import { captureImageAttemptRouteFacts } from './image-attempt-context';
import type { ImageRecoveryScope, ImageUsageRecoveryFactory, TrustedImagePreparedAttemptContext } from './image-usage-recovery';
import type { RouteResult } from './model-router';
import type { SingleGrantBudgetTicket } from './request-budget-admission';

const SHA256 = /^[a-f0-9]{64}(?![\s\S])/;
const DISPATCH_ROLE = 'cinatoken_gateway_dispatch_producer';
const FACT_ROLE = 'cinatoken_gateway_fact_producer';
const RUNTIME_ROLE = 'cinatoken_gateway_runtime';

type PgQuery = {
	unsafe<T extends unknown[] = Record<string, unknown>[]>(query: string, params?: readonly unknown[]): PromiseLike<T>;
};
type PgTransaction = PgQuery & { begin<T>(run: (tx: PgQuery) => Promise<T>): Promise<T> };
type PostgresProducerAuthority = Pick<PostgresDatabaseClient, 'driver' | 'raw'>;

async function requireRole(query: PgQuery, expected: string): Promise<void> {
	const rows = await query.unsafe<{ current_role: unknown; session_role: unknown }[]>(
		'SELECT current_user AS current_role, session_user AS session_role',
	);
	if (!Array.isArray(rows) || rows.length !== 1
		|| rows[0]?.current_role !== expected || rows[0]?.session_role !== expected) {
		throw new Error(`PostgreSQL Images authority role mismatch: ${expected}`);
	}
}

/** Bind the role check and each repository statement to one PostgreSQL transaction/session. */
function roleCheckedProducer(client: PostgresProducerAuthority, expected: string): PostgresProducerAuthority {
	const raw = client.raw as unknown as PgTransaction;
	const checked: PgTransaction = {
		async unsafe<T extends unknown[] = Record<string, unknown>[]>(query: string, params?: readonly unknown[]): Promise<T> {
			return raw.begin(async tx => {
				await requireRole(tx, expected);
				return await tx.unsafe<T>(query, params);
			});
		},
		begin<T>(run: (tx: PgQuery) => Promise<T>): Promise<T> {
			return raw.begin(async tx => {
				await requireRole(tx, expected);
				return run(tx);
			});
		},
	};
	return { ...client, raw: checked as unknown as PostgresProducerAuthority['raw'] };
}

async function requireFactoryRoles(storage: StorageContext,
	authorities: PostgresImageRecoveryAuthorities): Promise<void> {
	// These preflight reads catch crossed credentials before any parent call. Producer
	// repository statements are checked again on their own transaction/session.
	await requireRole(storage.client.raw as unknown as PgQuery, RUNTIME_ROLE);
	await requireRole(authorities.claimProducer.raw as unknown as PgQuery, DISPATCH_ROLE);
	await requireRole(authorities.factProducer.raw as unknown as PgQuery, FACT_ROLE);
}

export class PostgresImageDispatchNotGrantedError extends Error {
	constructor() {
		super('PostgreSQL Images request dispatch was not granted');
		this.name = 'PostgresImageDispatchNotGrantedError';
	}
}

export type PostgresImageRecoveryAuthorities = Readonly<{
	/** An isolated producer role with EXECUTE on the parent functions, never the ordinary runtime role. */
	claimProducer: PostgresProducerAuthority;
	/** An isolated producer role able to persist/read back a fact + outbox and register its job. */
	factProducer: PostgresProducerAuthority;
}>;
export type PostgresImageRecoveryOptions = Readonly<{ maxAttempts: ParentDispatchAttemptBudget }>;

type Selected = Readonly<{
	intent: ParentDispatchIntentIdentity;
	claimId: string;
	providerId: string;
	providerModelName: string;
	targetId: string;
	providerKeyId: string | null;
	providerKeyFingerprint: string | null;
	modelSurfaceId: string | null;
	routePoolId: string | null;
	upstreamOperation: string;
}>;

function copyScope(input: ImageRecoveryScope): ImageRecoveryScope & { requestSha256: string } {
	const scope = Object.freeze({
		requestId: input.requestId,
		userId: input.userId,
		apiKeyId: input.apiKeyId,
		workspaceId: input.workspaceId,
		modelId: input.modelId,
		operation: input.operation,
		expiresAtMs: input.expiresAtMs,
		requestSha256: input.requestSha256,
		responseStreamed: input.responseStreamed === true,
	});
	if (![scope.requestId, scope.userId, scope.apiKeyId, scope.workspaceId].every(settlementId)
		|| typeof scope.modelId !== 'string' || scope.modelId.length < 1 || scope.modelId.length > 200
		|| (scope.operation !== 'images.generations' && scope.operation !== 'images.edits')
		|| !Number.isSafeInteger(scope.expiresAtMs) || scope.expiresAtMs < 1
		|| !SHA256.test(scope.requestSha256 ?? '') || scope.responseStreamed) {
		throw new TypeError('Invalid PostgreSQL Images recovery scope');
	}
	return scope as ImageRecoveryScope & { requestSha256: string };
}

function selectedAttempt(
	scope: ImageRecoveryScope & { requestSha256: string }, route: RouteResult, attemptIndex: number,
	prepared: TrustedImagePreparedAttemptContext | undefined,
): Selected {
	if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 1 || attemptIndex > 3) {
		throw new TypeError('Invalid PostgreSQL Images attempt index');
	}
	if (!prepared || !Object.isFrozen(prepared) || !Object.isFrozen(prepared.routeIdentity)
		|| prepared.operation !== scope.operation || prepared.requestSha256 !== scope.requestSha256
		|| !SHA256.test(prepared.contextSha256) || !SHA256.test(prepared.outboundPayloadSha256)) {
		throw new TypeError('Trusted driver-prepared Images attempt context required');
	}
	const url = resolveUpstreamEndpoint('openai', scope.operation, route.providerEndpoints, { providerId: route.providerId });
	const { upstreamUrl: _upstreamUrl, ...routeFacts } = captureImageAttemptRouteFacts(route, scope.operation, url);
	const expected = { ...routeFacts, upstreamUrlSha256: createHash('sha256').update(url).digest('hex') };
	const identity = prepared.routeIdentity;
	if (Object.keys(identity).length !== Object.keys(expected).length
		|| Object.entries(expected).some(([key, value]) => identity[key as keyof typeof identity] !== value)) {
		throw new TypeError('Driver-prepared Images attempt route mismatch');
	}
	const providerKeyId = identity.providerKeyId;
	if (![identity.providerId, identity.targetId].every(settlementId)
		|| (identity.endpointId !== null && !settlementId(identity.endpointId))
		|| (providerKeyId !== null && !settlementId(providerKeyId))) {
		throw new TypeError('Invalid PostgreSQL Images route identity');
	}
	const intent: ParentDispatchIntentIdentity = Object.freeze({
		requestId: scope.requestId,
		userId: scope.userId,
		apiKeyId: scope.apiKeyId,
		workspaceId: scope.workspaceId,
		operation: scope.operation,
		attemptIndex,
		requestSha256: scope.requestSha256,
		contextSha256: prepared.contextSha256,
	});
	return Object.freeze({
		intent,
		claimId: crypto.randomUUID(),
		providerId: identity.providerId,
		providerModelName: identity.providerModelName,
		targetId: identity.targetId,
		providerKeyId,
		providerKeyFingerprint: identity.providerKeyFingerprint,
		modelSurfaceId: identity.modelSurfaceId,
		routePoolId: identity.routePoolId,
		upstreamOperation: identity.upstreamOperation,
	});
}

function projectUsage(params: RecordImageUsageParams, repos: StorageContext['repositories']): RecordImageUsageParams {
	const { repos: _ignored, ...data } = params;
	const requestOrigin = normalizeGenerationHttpReferer(data.requestOrigin ?? null);
	if (data.requestOrigin != null && requestOrigin !== data.requestOrigin) {
		throw new TypeError('Invalid recovery gateway origin');
	}
	// Copy only the accounting fields accepted by the settlement codec. Raw request,
	// credentials, user profile and upstream usage extensions are never retained.
	const usage = data.imageUsage;
	const counters = usage ? {
		text_tokens: usage.text_tokens,
		cached_text_tokens: usage.cached_text_tokens,
		image_input_tokens: usage.image_input_tokens,
		cached_image_input_tokens: usage.cached_image_input_tokens,
		image_output_tokens: usage.image_output_tokens,
		total_tokens: usage.total_tokens,
	} : null;
	return { ...structuredClone({
		...data,
		requestBody: null,
		upstreamRequestBody: null,
		userEmail: null,
		errorMessage: data.status === 'error' ? 'Image request failed' : null,
		providerKeyLabel: null,
		providerKeyFingerprint: null,
		httpReferer: null,
		userAgent: null,
		requestOrigin,
		sessionId: null,
		stickyTrace: null,
		providerRoutingTrace: null,
		circuitEvents: undefined,
		timing: data.timing ? { ...data.timing, timingMetadata: null } : null,
		imageUsage: counters ? { ...counters, raw_usage: JSON.stringify(counters) } : null,
	}), repos };
}

/**
 * Explicit candidate only. The caller must provision distinct producer clients
 * and an independently operated PostgreSQL recovery consumer. This module is
 * intentionally absent from app composition; constructing it changes no schema
 * or role grants. A successful response requires both the immutable fact/outbox
 * readback and recovery job acceptance, never a legacy financial write.
 */
export function createPostgresImageUsageRecoveryFactory(
	storage: StorageContext, authorities: PostgresImageRecoveryAuthorities,
	options: PostgresImageRecoveryOptions,
): ImageUsageRecoveryFactory {
	if (storage.client.driver !== 'postgres'
		|| authorities?.claimProducer?.driver !== 'postgres'
		|| authorities?.factProducer?.driver !== 'postgres'
		|| authorities.claimProducer.raw === storage.client.raw
		|| authorities.factProducer.raw === storage.client.raw
		|| authorities.claimProducer.raw === authorities.factProducer.raw) {
		throw new TypeError('Distinct PostgreSQL Images recovery authorities required');
	}
	const maxAttempts = options?.maxAttempts;
	if (maxAttempts !== 1 && maxAttempts !== 2 && maxAttempts !== 3) {
		throw new TypeError('Invalid PostgreSQL Images attempt budget');
	}
	const parent = createParentDispatchIntentRepositoryPostgres(
		roleCheckedProducer(authorities.claimProducer, DISPATCH_ROLE));
	const checkedFact = roleCheckedProducer(authorities.factProducer, FACT_ROLE);
	const facts = createUsageSettlementFactsRepositoryPostgres(checkedFact);
	const jobs = createUsageRecoveryJobsPostgres(checkedFact);
	const factory: ImageUsageRecoveryFactory = input => {
		const scope = copyScope(input);
		let entered = false;
		let ambiguous = false;
		let selected: Selected | undefined;
		let marked = false;
		let persistEntered = false;
		return {
			responseStreamed: false,
			singleCommittedRequestGrant: true,
			get mayHaveDispatched() { return ambiguous; },
			async beforeSingleGrantDispatch(
				route: RouteResult, attemptIndex: number, ticket: SingleGrantBudgetTicket,
				checkActive: () => void, prepared: TrustedImagePreparedAttemptContext | undefined,
			) {
				if (entered) throw new Error('PostgreSQL Images single dispatch grant already attempted');
				entered = true;
				let claimAttempted = false;
				try {
					checkActive();
					const attempt = selectedAttempt(scope, route, attemptIndex, prepared);
					if (attemptIndex > maxAttempts) throw new TypeError('Images attempt exceeds parent dispatch budget');
					await requireFactoryRoles(storage, authorities);
					checkActive();
					await parent.prepare(attempt.intent, scope.expiresAtMs, maxAttempts);
					checkActive();
					// From this point a lost COMMIT acknowledgement is an unknown send right.
					ambiguous = true;
					claimAttempted = true;
					const outcome = await parent.claim(attempt.intent, 0, attempt.claimId);
					if (outcome !== 'granted') {
						ambiguous = false;
						await ticket.releaseAfterDefiniteNoClaim();
						throw new PostgresImageDispatchNotGrantedError();
					}
					selected = attempt;
					await ticket.markAfterCommittedClaim();
					marked = true;
					checkActive();
				} catch (error) {
					if (!claimAttempted) {
						// No claim call has happened; even an ambiguous prepare ACK cannot grant dispatch.
						await ticket.releaseAfterDefiniteNoClaim();
					} else if (ambiguous && !selected) {
						// No readback grant, claim retry or budget release after an uncertain ACK.
						ticket.holdAfterUncertainClaim();
					}
					throw error;
				}
			},
			async persist(params: RecordImageUsageParams) {
				const owner = selected;
				if (!owner || !marked || persistEntered || params.repos !== storage.repositories
					|| params.requestLogId !== scope.requestId
					|| params.userId !== scope.userId || params.apiKeyId !== scope.apiKeyId
					|| params.workspaceId !== scope.workspaceId || params.modelId !== scope.modelId
					|| params.requestOperation !== scope.operation || params.responseStreamed === true
					|| params.providerId !== owner.providerId || params.providerModelName !== owner.providerModelName
					|| params.routeTargetId !== owner.targetId
					|| (params.providerKeyId ?? null) !== owner.providerKeyId
					|| (params.providerKeyFingerprint ?? null) !== owner.providerKeyFingerprint
					|| (params.modelSurfaceId ?? null) !== owner.modelSurfaceId
					|| (params.routePoolId ?? null) !== owner.routePoolId
					|| params.upstreamOperation !== owner.upstreamOperation) {
					throw new Error('PostgreSQL Images settlement identity conflict');
				}
				persistEntered = true;
			await requireFactoryRoles(storage, authorities);
				const owned = projectUsage(params, storage.repositories);
				const recordedAtIso = new Date().toISOString();
				const prepared = await prepareImageUsageWrite(owned);
				if (parseByokKeyId(owned.providerKeyId) !== null && prepared.write.requestLog.isByok !== true) {
					throw new Error('Private BYOK recovery requires a complete verified accounting snapshot');
				}
				prepared.write.audit.beforeUserSnapshot = null;
				prepared.write.audit.afterUserSnapshot = null;
				prepared.write.audit.changedFields = null;
				const { requestSha256: _requestSha256, ...intent } = owner.intent;
				const ref = await facts.persist({
					version: 1,
					intent,
					dispatchClaimId: owner.claimId,
					recordedAtIso,
					params: prepared.write,
				});
				const job = await jobs.ensure(ref);
				if (job.state === 'blocked') throw new Error('PostgreSQL Images recovery job is blocked');
				// The durable job is the activation boundary. An independently owned
				// recovery consumer performs the fenced financial commit.
				return async () => undefined;
			},
		};
	};
	return Object.assign(factory, { supportsStreaming: false, requiresTrustedIngressDigest: true as const,
		requiresTrustedAttemptContext: true as const });
}
