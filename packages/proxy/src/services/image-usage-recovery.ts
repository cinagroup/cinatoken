import type { StorageContext } from '@octafuse/core';
import { createDispatchIntentRepositoryD1, type DispatchIntentIdentity } from '@octafuse/core/storage/recovery/dispatch-intent-d1';
import { createUsageSettlementRepositoryD1, type SettlementReference } from '@octafuse/core/storage/recovery/usage-settlement-d1';
import { settlementDigest, settlementId } from '@octafuse/core/storage/recovery/usage-settlement-codec';
import { createUsageRecoveryJobsD1 } from '@octafuse/core/storage/recovery/usage-recovery-jobs-d1';
import { assertUsageRecoverySchemaD1 } from '@octafuse/core/storage/recovery/usage-recovery-schema-d1';
import { SettlementConflictError, SettlementSnapshotInvalidError } from '@octafuse/core/storage/recovery/settlement-recovery-types';
import { prepareImageUsageWrite, type RecordImageUsageParams } from './image-usage-charge';
import type { RouteResult } from './model-router';
import { parseByokKeyId } from './byok-key-pool';
import { normalizeGenerationHttpReferer } from './generation-request-context';
import type { SingleGrantBudgetTicket } from './request-budget-admission';
import type { ImageAttemptRouteIdentity } from './image-attempt-context';

export type ImageUsageRecoveryOptions = Readonly<{ settlementLeaseSeconds: number; streaming?: boolean }>;
export type ImageRecoveryScope = Readonly<{
	requestId: string; userId: string; apiKeyId: string; workspaceId: string;
	modelId: string; operation: 'images.generations' | 'images.edits'; expiresAtMs: number;
	/** Derived by the Images ingress parser before Guardrails or routing mutate the request. */
	requestSha256?: string;
	responseStreamed?: boolean;
}>;
/** Driver-prepared, route-bound digest. Only the server constructs this value. */
export type TrustedImagePreparedAttemptContext = Readonly<{
	operation: 'images.generations' | 'images.edits';
	requestSha256: string;
	contextSha256: string;
	outboundPayloadSha256: string;
	routeIdentity: ImageAttemptRouteIdentity;
}>;
type ImageRecoveryRequestBase = {
	readonly responseStreamed?: boolean;
	/** Conservative dispatch ambiguity, not proof of an upstream send. */
	readonly mayHaveDispatched: boolean;
	/** Confirm durable acceptance BEFORE returning success; returned task owns only the bounded reference. */
	persist(params: RecordImageUsageParams): Promise<() => Promise<void>>;
};
export type ImageRecoveryRequest = ImageRecoveryRequestBase & (
	| {
		/** Only a durable, request-wide single-claim owner may advertise this capability. */
		readonly singleCommittedRequestGrant: true;
		/** Resolve the ticket after a definitive claim result; only a completed mark permits fetch. */
		beforeSingleGrantDispatch(route: RouteResult, attemptIndex: number, ticket: SingleGrantBudgetTicket, checkActive: () => void,
			preparedContext: TrustedImagePreparedAttemptContext | undefined): Promise<void>;
		beforeDispatch?: never;
	}
	| {
		readonly singleCommittedRequestGrant?: false;
		beforeDispatch(route: RouteResult, attemptIndex: number, admit: () => Promise<void>, checkActive: () => void): Promise<void>;
		beforeSingleGrantDispatch?: never;
	}
);
export type ImageUsageRecoveryFactory = ((scope: ImageRecoveryScope) => ImageRecoveryRequest) & {
	readonly supportsStreaming?: boolean;
	/** Explicit legacy D1 behavior; other recovery owners fail closed if SSE is unsupported. */
	readonly allowLegacyStreamingFallback?: true;
	/** Server-only capability. The D1 implementation does not request this digest. */
	readonly requiresTrustedIngressDigest?: true;
	/** Requires the driver's immutable prepared attempt before a durable claim. */
	readonly requiresTrustedAttemptContext?: true;
};

/** Explicit server composition only; no user header/body toggle, migrations, model I/O or production default. */
export function createImageUsageRecoveryFactory(storage: StorageContext, config: ImageUsageRecoveryOptions): ImageUsageRecoveryFactory {
	const client = storage.client, leaseSeconds = config.settlementLeaseSeconds;
	if (client.driver !== 'd1') throw new TypeError('Image usage recovery requires an explicitly provisioned D1 schema');
	if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new TypeError('Invalid image recovery lease');
	const db = client.raw;
	const intents = createDispatchIntentRepositoryD1(db), settlements = createUsageSettlementRepositoryD1(client);
	const jobs = createUsageRecoveryJobsD1(db);
	function fastPath(ref: SettlementReference): () => Promise<void> {
		// Separate activation: this task never receives the response, RouteResult,
		// original request parameters or the prepared payload.
		return async () => {
			await assertUsageRecoverySchemaD1(db);
			const row = await jobs.inspect(ref);
			if (!row || row.state === 'committed' || row.state === 'blocked') return;
			const claim = await jobs.claim({ref,revision:row.revision},leaseSeconds);
			if (claim.status !== 'claimed') return;
			try { await settlements.commit(ref,claim.lease.proof); }
			catch (error) {
				await jobs.fail(claim.lease,error instanceof SettlementSnapshotInvalidError ? 'snapshot_invalid'
					: error instanceof SettlementConflictError ? 'settlement_conflict' : 'execution_error');
				throw new Error('Image accounting deferred to durable recovery');
			}
		};
	}
	const factory: ImageUsageRecoveryFactory = input => {
		const scope = Object.freeze({ requestId: input.requestId, userId: input.userId, apiKeyId: input.apiKeyId,
			workspaceId: input.workspaceId, modelId: input.modelId, operation: input.operation, expiresAtMs: input.expiresAtMs,
			responseStreamed: input.responseStreamed === true });
		if (scope.responseStreamed && (config.streaming !== true || scope.operation !== 'images.generations')) throw new TypeError('Image SSE recovery is not enabled');
		if (![scope.requestId,scope.userId,scope.apiKeyId,scope.workspaceId].every(settlementId)
				|| typeof scope.modelId !== 'string' || scope.modelId.length === 0 || scope.modelId.length > 200
			|| !['images.generations','images.edits'].includes(scope.operation)
			|| !Number.isSafeInteger(scope.expiresAtMs)) throw new TypeError('Invalid image recovery scope');
		let mayHaveDispatched = false;
		let current: { intent: DispatchIntentIdentity; claimId: string; providerId: string; targetId: string; providerKeyId: string | null } | undefined;
		return {
			responseStreamed: scope.responseStreamed,
			// D1 owns an intent per attempt and deliberately does not advertise a
			// request-wide single committed grant.
			get mayHaveDispatched() { return mayHaveDispatched; },
			async beforeDispatch(route, attemptIndex, admit, checkActive) {
				// Copy only routing identity, never the RouteResult with its plaintext credential.
				const providerId = route.providerId, targetId = route.targetId, endpointId = route.endpoint?.id ?? null;
				const providerKeyId = route.providerKeyId ?? null;
				if (![providerId,targetId].every(settlementId) || !Number.isSafeInteger(attemptIndex) || attemptIndex < 1 || attemptIndex > 32) throw new TypeError('Invalid recovery dispatch identity');
				if (endpointId !== null && !settlementId(endpointId)) throw new TypeError('Invalid recovery endpoint identity');
				if (providerKeyId !== null && !settlementId(providerKeyId)) throw new TypeError('Invalid recovery credential reference');
				checkActive();
				await assertUsageRecoverySchemaD1(db);
				checkActive();
				const contextSha256 = await settlementDigest(JSON.stringify({ version:1, modelId:scope.modelId, providerId,targetId,endpointId,providerKeyId,operation:scope.operation,
					...(scope.responseStreamed ? { responseStreamed:true } : {}) }));
				const intent: DispatchIntentIdentity = Object.freeze({ requestId:scope.requestId,userId:scope.userId,apiKeyId:scope.apiKeyId,
					workspaceId:scope.workspaceId,operation:scope.operation,attemptIndex,contextSha256 });
				const claimId = crypto.randomUUID();
				checkActive();
				await intents.prepare(intent,Date.now(),scope.expiresAtMs);
				checkActive();
				await admit();
				checkActive();
				mayHaveDispatched = true; // Set BEFORE ambiguous claim acknowledgement.
				if (await intents.claim(intent,0,claimId,Date.now()) !== 'granted') throw new Error('Image dispatch ownership not granted');
				current = { intent,claimId,providerId,targetId,providerKeyId };
				checkActive();
			},
			async persist(params) {
				const selected = current;
				if (!selected || params.repos !== storage.repositories || params.requestLogId !== scope.requestId
					|| params.userId !== scope.userId || params.apiKeyId !== scope.apiKeyId || params.workspaceId !== scope.workspaceId
					|| params.modelId !== scope.modelId || params.requestOperation !== scope.operation
					|| (params.responseStreamed === true && !scope.responseStreamed)
					|| (scope.responseStreamed && params.responseStreamed !== true && params.status !== 'error')
					|| params.providerId !== selected.providerId || params.routeTargetId !== selected.targetId
					|| (params.providerKeyId ?? null) !== selected.providerKeyId) throw new Error('Image recovery settlement identity conflict');
				const { repos, ...data } = params;
				// The canonical gateway origin gates the complete USD/BYOK snapshot.
				// Removing it would erase isByok and under-settle route-inclusive key limits.
				const requestOrigin = normalizeGenerationHttpReferer(data.requestOrigin ?? null);
				if (data.requestOrigin != null && requestOrigin !== data.requestOrigin) throw new TypeError('Invalid recovery gateway origin');
				// Recovery stores accounting facts, not arbitrary upstream usage JSON, request headers,
				// user profile snapshots, free-form errors, key labels or raw routing diagnostics.
				// Project BEFORE cloning: excluded request bodies/usage extensions are never copied.
				const u = data.imageUsage;
				const counters = u ? { text_tokens:u.text_tokens,cached_text_tokens:u.cached_text_tokens,
					image_input_tokens:u.image_input_tokens,cached_image_input_tokens:u.cached_image_input_tokens,
					image_output_tokens:u.image_output_tokens,total_tokens:u.total_tokens } : null;
				const owned: RecordImageUsageParams = { ...structuredClone({ ...data,
					requestBody:null,upstreamRequestBody:null,userEmail:null,
					errorMessage:data.status === 'error' ? 'Image request failed' : null,
					providerKeyLabel:null,providerKeyFingerprint:null,httpReferer:null,userAgent:null,requestOrigin,sessionId:null,
					stickyTrace:null,providerRoutingTrace:null,circuitEvents:undefined,
					timing:data.timing ? {...data.timing,timingMetadata:null} : null,
					imageUsage:counters ? {...counters,raw_usage:JSON.stringify(counters)} : null,
				}), repos };
				const recordedAtIso = new Date().toISOString();
				const prepared = await prepareImageUsageWrite(owned);
				if (parseByokKeyId(owned.providerKeyId) !== null && prepared.write.requestLog.isByok !== true) {
					throw new Error('Private BYOK recovery requires a complete verified accounting snapshot');
				}
				// Keep budget-specific audit columns; avoid persisting an extra full user profile copy.
				prepared.write.audit.beforeUserSnapshot = null; prepared.write.audit.afterUserSnapshot = null;
				prepared.write.audit.changedFields = null;
				await assertUsageRecoverySchemaD1(db);
				const ref = await settlements.persist({ version:1,intent:selected.intent,dispatchClaimId:selected.claimId,recordedAtIso,params:prepared.write });
				// The snapshot alone is insufficient: confirm its exact-scope atomic enqueue
				// before handing delivery back to the route, including after an insert ACK loss.
				const acceptedJob = await jobs.inspect(ref);
				if (!acceptedJob || acceptedJob.state === 'blocked') throw new Error('Image recovery job acceptance unconfirmed');
				return fastPath(ref);
			},
		};
	};
	return Object.assign(factory, { supportsStreaming: config.streaming === true,
		allowLegacyStreamingFallback: true as const });
}
