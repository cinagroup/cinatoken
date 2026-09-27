/**
 * 用户路由：OpenAI 兼容 Images API
 * - `POST /v1/images/generations`（JSON）
 * - `POST /v1/images/edits`（multipart）
 *
 * 流程：鉴权 → 解析 model → 预算预检 → openai 路由故障转移 → 成功后按 Images usage token 分项扣费。
 * 日志禁止写入 prompt 原文、参考图与 Base64。
 */
import type {
	GatewayRepositories,
	GuardrailBudgetIntent,
	GuardrailPreflightResult,
} from '@octafuse/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../app';
import { requireApiKey, type ApiKeyContext } from '../../middleware/auth';
import { assignGenerationId } from '../../middleware/generation-id';
import { assertTextRequestActive, textRequestFailureResponse, waitForTextRequestRead } from '../../middleware/text-request-lifecycle';
import { createRequestDispatchBudget } from '../../services/request-dispatch-budget';
import { createRequestDeadline } from '../../services/request-deadline';
import { readImageJsonRequest } from '../../services/image-json-request';
import {
	digestTrustedImageEditIngress,
	digestTrustedImageGenerationIngress,
	type ImageRequestDigestControl,
} from '../../services/image-request-digest';
import {
	preparedImageAttemptMatchesRoute,
	type ImageAttemptContextControl,
	type PreparedImageAttempt,
} from '../../services/image-attempt-context';
import { normalizeImageGenerationParams } from '../../services/image-generation-params';
import { hasJsonStringContent, isJsonString, trimJsonString } from '../../services/egress/json-string-pages';
import { MultipartFile, readStreamingMultipartBody } from '../../services/streaming-multipart-body';
import {
	buildAffinityKey,
	buildTierKeyPrefix,
} from '../../services/route-strategies';
import { proxyImageEdits, proxyImageGenerations, type ProxyResult } from '../../services/proxy';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import { generationRequestContext } from '../../services/generation-request-context';
import {
	createImagePricingContext,
	estimateImageBudgetPrecheck,
	hasAuthoritativeImageTokenUsage,
	imageGuardrailBudgetMicros,
	multipleImageBillingMode,
	recordImageUsage,
	type RecordImageUsageParams,
	type ImageBillingParams,
	type ImageCostBreakdown,
} from '../../services/image-usage-charge';
import { applyOpenAiImageGenerationExtras, countOpenAiGenerationReferenceImages } from '../../services/image-generation-extras';
import {
	countValidImageResults,
	IMAGE_MAX_REFERENCE_COUNT,
	IMAGE_MAX_BYTES_PER_FILE,
	IMAGE_MAX_TOTAL_UPLOAD_BYTES,
	IMAGE_GENERATION_TIMEOUT_MS,
	normalizeImageCommonParams,
	redactImageRequestForLog,
	validateImageUpload,
	type ImageEditUpload,
	type NormalizedImageEditRequest,
} from '../../services/egress/openai-images-driver';
import {
	formatHttpErrorTextForRequestLog,
	materializeNonOkResponse,
} from '../../services/request-log-record-status';
import {
	maybeBlockUserModelCircuit,
	maybeTriggerUserModelCircuitFromUpstream,
	markUserModelSuccess,
} from '../../services/user-model-circuit-route';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { unknownImageOutcomeMetadata, unknownImageOutcomeResponse } from '../../services/image-outcome-error';
import { RequestTimingCollector } from '../../services/request-timing';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';
import { buildModelFallbackPlan } from '../../services/model-fallback-plan';
import type { RouteResult } from '../../services/model-router';
import {
	auditGuardrailOutputDecision,
	forfeitRequestGuardrailBudgets,
	markRequestGuardrailBudgetsDispatched,
	releaseRequestGuardrailBudgets,
	reserveRequestGuardrailBudgets,
	runRequestGuardrails,
} from '../../services/request-guardrails';
import type { OrdinaryBudgetLease } from '../../services/ordinary-budget-lifecycle';
import type { ImageRecoveryRequest, TrustedImagePreparedAttemptContext } from '../../services/image-usage-recovery';
import { gateImageSseDelivery } from '../../services/image-sse-delivery-gate';
import {
	selectConservativeMultimediaBudgetEstimate,
} from '../../services/multimedia-ordinary-budget';
import { applyImageProviderPriceRouting } from '../../services/image-provider-price-routing';
import { buildRouteRequestBody } from '../../services/route-default-params';
import { parseOpenRouterSessionHeader } from '../../services/openrouter-session-routing';
import { privateByokContextForApiKey } from '../../services/byok-key-pool';
import {
	createRouteAwareBudgetAdmission,
	type RouteAwareBudgetAdmission,
	type SingleGrantBudgetTicket,
} from '../../services/request-budget-admission';

type ImagesEnv = Env & { Variables: { apiKey: ApiKeyContext } };
type ImagesContext = Context<ImagesEnv>;

export const imageRoutes = new Hono<ImagesEnv>();

imageRoutes.use('*', requireApiKey);
imageRoutes.use('*', assignGenerationId);

// The PostgreSQL claim repository is composed only by the opt-in app path;
// this route never selects it from request input. Its explicit Error.name is
// the narrow signal that a claim ACK may have been lost before provider fetch.
class ImageSingleGrantBudgetOutcomeUnknownError extends Error {
	constructor() {
		super('Image single-grant dispatch outcome is unknown');
		this.name = 'ImageSingleGrantBudgetOutcomeUnknownError';
	}
}

function imageClaimUncertain(error: unknown): boolean {
	return error instanceof ImageSingleGrantBudgetOutcomeUnknownError
		|| (error instanceof Error && error.name === 'PostgresDispatchClaimUncertainError');
}

function imageClaimDefinitelyDenied(error: unknown): boolean {
	return error instanceof Error && error.name === 'PostgresImageDispatchNotGrantedError';
}

function imageClaimUncertainResponse(c: ImagesContext, requestId: string): Response {
	return gatewayErrorJson(c, {
		status: 503,
		code: GatewayErrorCode.capacityUnavailable,
		message: 'Image dispatch is unavailable',
		metadata: unknownImageOutcomeMetadata(requestId),
	});
}

function imageClaimDeniedResponse(c: ImagesContext, requestId: string): Response {
	return gatewayErrorJson(c, {
		status: 503,
		code: GatewayErrorCode.capacityUnavailable,
		message: 'Image dispatch is unavailable',
		metadata: { request_id: requestId, outcome_unknown: false, retry_safe: true },
	});
}

async function withImageIngressDigestControl<T>(
	c: ImagesContext,
	requestStartedAtMs: number,
	compute: (control: ImageRequestDigestControl) => Promise<T>,
): Promise<T> {
	const inherited = c.get('textRequestLifecycle')?.deadline;
	const owned = inherited ? null : createRequestDeadline(
		requestStartedAtMs + IMAGE_GENERATION_TIMEOUT_MS,
		c.req.raw.signal,
	);
	try { return await compute(inherited ?? owned!); }
	finally { owned?.dispose(); }
}

function modelDisplayName(model: { display_name?: string | null }, baseModelId: string): string {
	return model.display_name != null && String(model.display_name).trim() !== ''
		? String(model.display_name).trim()
		: baseModelId;
}

/** Cap length so a pathological clientModel cannot flood logs / error bodies. */
function truncateModelIdForLog(rawModelId: string, maxLen = 200): string {
	const trimmed = rawModelId.trim();
	if (trimmed.length <= maxLen) {
		return trimmed;
	}
	return `${trimmed.slice(0, maxLen)}…`;
}

/** Endpoint metadata is the only authoritative capability source for optional image parameters. */
export function imageRouteSupportsParameter(
	route: Pick<RouteResult, 'endpoint'>,
	parameter: 'n' | 'stream',
	value?: number,
): boolean {
	const capabilities = route.endpoint?.imageCapabilities;
	if (!capabilities) return false;
	if (parameter === 'stream') return capabilities.supports_streaming === true;
	const entry = Object.entries(capabilities.supported_parameters)
		.find(([name]) => name.trim().toLowerCase() === parameter)?.[1];
	if (!entry) return false;
	if (value === undefined) return true;
	if (entry.type === 'range') return value >= entry.min && value <= entry.max;
	if (entry.type === 'enum') return entry.values.includes(String(value));
	return entry.type === 'boolean';
}

/** Reproduce the driver's route-default merge before deriving billable request facts. */
export function countRouteImageGenerationReferences(
	route: RouteResult,
	upstreamBody: Record<string, unknown>,
): number {
	return countOpenAiGenerationReferenceImages(buildRouteRequestBody(route, upstreamBody));
}

/**
 * `false` is reserved for a proven non-billable terminal outcome. `undefined`
 * preserves dispatched ceilings when the upstream may have consumed the work.
 */
export function imageClientOutcomeBillable(params: {
	status: 'success' | 'error';
	responseOk: boolean;
	costUnknown: boolean;
	imageAbortReason?: 'client_abort' | 'gateway_timeout' | null;
}): boolean | undefined {
	if (
		params.imageAbortReason === 'client_abort'
		|| params.imageAbortReason === 'gateway_timeout'
	) {
		return false;
	}
	if (params.status === 'success') return true;
	if (params.responseOk || params.costUnknown) return undefined;
	return false;
}

export function shouldPreserveImageDispatchedCeiling(params: {
	costUnknown: boolean;
	imageAbortReason?: 'client_abort' | 'gateway_timeout' | null;
}): boolean {
	return params.costUnknown
		&& params.imageAbortReason !== 'client_abort'
		&& params.imageAbortReason !== 'gateway_timeout';
}

/**
 * Return an error message when Content-Type is not multipart/form-data; otherwise null.
 * Hono `parseBody` returns `{}` without reading the body for non-form types, which used to
 * surface as a misleading "Missing model".
 * @internal exported for unit tests
 */
export function validateImagesEditsContentType(contentType: string | null | undefined): string | null {
	const ct = (contentType ?? '').trim();
	if (!ct.toLowerCase().startsWith('multipart/form-data')) {
		return `Unsupported Content-Type for /v1/images/edits: expected multipart/form-data, got "${ct || '(missing)'}"`;
	}
	return null;
}

/** Summarize multipart/JSON field shapes for diagnostics (keys + type only; never values). */
function summarizeBodyKeys(body: Record<string, unknown>): string[] {
	return Object.keys(body)
		.map((key) => {
			const value = body[key];
			if (value == null) return `${key}:null`;
			if (isJsonString(value)) return `${key}:string`;
			if (typeof value === 'number' || typeof value === 'boolean') return `${key}:${typeof value}`;
			if (Array.isArray(value)) {
				const first = value[0];
				const itemType =
					first == null
						? 'empty'
						: first instanceof MultipartFile || (typeof first === 'object' && first !== null && 'arrayBuffer' in first)
							? 'file'
							: isJsonString(first) ? 'string' : typeof first;
				return `${key}:array(${value.length},${itemType})`;
			}
			if (value instanceof MultipartFile || (typeof value === 'object' && 'arrayBuffer' in value)) return `${key}:file`;
			return `${key}:object`;
		})
		.slice(0, 40);
}

type ImageRejectDiag = {
	operation: 'generations' | 'edits';
	contentType?: string | null;
	contentLength?: string | null;
	bodyKeys?: string[];
	hasModel?: boolean;
	clientModel?: string;
	promptChars?: number;
	referenceCount?: number;
	totalUploadBytes?: number;
};

/**
 * Log + return a client-facing Images 4xx/403. Never logs prompt / base64 / image bytes.
 */
function rejectImageRequest(
	c: ImagesContext,
	status: 400 | 403 | 404 | 502,
	error: string,
	diag: ImageRejectDiag
): Response {
	const apiKey = c.get('apiKey');
	console.warn('[Gateway Images] request rejected', {
		operation: diag.operation,
		status,
		error,
		contentType: diag.contentType ?? c.req.header('content-type') ?? null,
		contentLength: diag.contentLength ?? c.req.header('content-length') ?? null,
		keyId: apiKey?.keyId ?? null,
		userId: apiKey?.userId ?? null,
		bodyKeys: diag.bodyKeys ?? null,
		hasModel: diag.hasModel ?? null,
		clientModel: diag.clientModel ? truncateModelIdForLog(diag.clientModel) : null,
		promptChars: diag.promptChars ?? null,
		referenceCount: diag.referenceCount ?? null,
		totalUploadBytes: diag.totalUploadBytes ?? null,
	});
	return gatewayErrorJson(c, {
		status,
		code:
			status === 403
				? GatewayErrorCode.budgetExceeded
				: status === 404
					? GatewayErrorCode.modelNotFound
					: status === 502
						? GatewayErrorCode.routeResolutionFailed
						: GatewayErrorCode.invalidRequest,
		message: error,
	});
}

export const IMAGE_OUTPUT_GUARDRAIL_UNSUPPORTED = 'unsupported_image_output';

/** Image bytes/Base64/URLs are opaque output and cannot be safely text-filtered. */
export function imageOutputGuardrailBlockReason(outputFilterCount: number): string | null {
	return outputFilterCount > 0 ? IMAGE_OUTPUT_GUARDRAIL_UNSUPPORTED : null;
}

type ImagePromptGuardrailParams = Pick<
	NormalizedImageEditRequest,
	'prompt' | 'n' | 'size' | 'quality' | 'background'
>;

/** Public image request fields only: reference images and routing controls stay outside Guardrails. */
function imagePromptGuardrailBody(
	model: string,
	request: ImagePromptGuardrailParams,
): Record<string, unknown> {
	const body: Record<string, unknown> = { model, prompt: request.prompt, n: request.n };
	if (request.size) body.size = request.size;
	if (request.quality) body.quality = request.quality;
	if (request.background) body.background = request.background;
	return body;
}

/** Generation projection keeps reference images/Base64 and provider controls out of filtering. */
export function imageGenerationGuardrailBody(
	model: string,
	request: ImagePromptGuardrailParams,
): Record<string, unknown> {
	return imagePromptGuardrailBody(model, request);
}

/** Multipart projection keeps uploaded image bytes out of filtering. */
export function imageEditGuardrailBody(
	model: string,
	edit: ImagePromptGuardrailParams,
): Record<string, unknown> {
	return imagePromptGuardrailBody(model, edit);
}

type SuccessfulGuardrail = Extract<GuardrailPreflightResult, { ok: true }>;

async function failClosedForImageOutputGuardrail(
	c: ImagesContext,
	repos: GatewayRepositories,
	apiKey: ApiKeyContext,
	modelId: string,
	requestId: string,
	guardrail: SuccessfulGuardrail,
): Promise<Response | null> {
	const blockedBy = imageOutputGuardrailBlockReason(guardrail.outputFilters.length);
	if (!blockedBy) return null;
	await auditGuardrailOutputDecision(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelIds: [modelId],
		correlationId: requestId,
		trace: guardrail.trace,
		blockedBy,
		redactionCount: 0,
		control: c.get('textRequestLifecycle')?.deadline,
	}).catch((error: unknown) => {
		assertTextRequestActive(c);
		console.warn(JSON.stringify({
			message: 'image output guardrail audit failed',
			request_id: requestId,
			error: error instanceof Error ? error.message : String(error),
		}));
	});
	return gatewayErrorJson(c, {
		status: 403,
		code: GatewayErrorCode.guardrailBlocked,
		message: 'Image output cannot be safely inspected by the configured output guardrail',
	});
}

type ImageGuardrailBudgetLease =
	| { ok: false; blocked: boolean; reason?: 'gateway_key_limit' | 'workspace_budget' | 'guardrail_budget'; message: string }
	| {
			ok: true;
			reserved: boolean;
			dispatched: boolean;
			terminal: boolean;
			beforeUpstreamDispatch(): Promise<void>;
			release(reason: string): Promise<void>;
			forfeit(reason: string): Promise<void>;
	  };

/** @internal exported for lifecycle regression tests. */
export async function admitImageGuardrailBudget(
	repos: GatewayRepositories,
	params: {
		requestId: string;
		intents: GuardrailBudgetIntent[];
		reservedMicros: number;
		now: Date;
	},
): Promise<ImageGuardrailBudgetLease> {
	const admission = await reserveRequestGuardrailBudgets(repos, params);
	if (!admission.ok) return admission;
	let dispatched = false;
	let terminal = false;
	const lease: AdmittedImageGuardrailBudgetLease = {
		ok: true,
		reserved: admission.reserved,
		get dispatched() { return dispatched; },
		get terminal() { return terminal; },
		async beforeUpstreamDispatch(): Promise<void> {
			if (dispatched) return;
			await markRequestGuardrailBudgetsDispatched(
				repos,
				params.requestId,
				admission.reserved,
				params.now,
			);
			dispatched = true;
		},
		async release(reason: string): Promise<void> {
			if (!admission.reserved || terminal) return;
			await releaseRequestGuardrailBudgets(
				repos,
				params.requestId,
				admission.reserved,
				reason,
			);
			terminal = true;
		},
		async forfeit(reason: string): Promise<void> {
			if (!admission.reserved || terminal) return;
			try {
				await forfeitRequestGuardrailBudgets(
					repos,
					params.requestId,
					admission.reserved,
					reason,
				);
				terminal = true;
			} catch (error) {
				console.error(JSON.stringify({
					message: 'image guardrail budget forfeit failed',
					request_id: params.requestId,
					reason,
					error: error instanceof Error ? error.message : String(error),
				}));
			}
		},
	};
	return lease;
}

type AdmittedImageGuardrailBudgetLease = Extract<ImageGuardrailBudgetLease, { ok: true }>;

function routeAwareImageGuardrailLease(
	admission: RouteAwareBudgetAdmission,
): AdmittedImageGuardrailBudgetLease {
	return {
		ok: true,
		get reserved() { return admission.guardrailReserved; },
		get dispatched() { return admission.guardrailDispatched; },
		get terminal() { return admission.guardrailTerminal; },
		beforeUpstreamDispatch: () => Promise.reject(
			new Error('Route-aware image admission requires a selected route'),
		),
		release: (reason) => admission.releaseGuardrailPreDispatch(reason),
		forfeit: (reason) => admission.terminateGuardrailUnknown(reason),
	};
}

function isPreparedImageAttempt(value: unknown): value is PreparedImageAttempt {
	if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false;
	const attempt = value as Partial<PreparedImageAttempt>;
	return (attempt.operation === 'images.generations' || attempt.operation === 'images.edits')
		&& attempt.routeIdentity != null && Object.isFrozen(attempt.routeIdentity)
		&& typeof attempt.digestTrustedContext === 'function';
}

async function beforeImageRecoveryDispatch(
	recovery: ImageRecoveryRequest | undefined,
	budgetAdmission: RouteAwareBudgetAdmission,
	route: RouteResult,
	attemptIndex: number,
	checkActive: () => void,
	preparedAttempt: unknown,
	requestSha256: string | undefined,
	contextControl: ImageAttemptContextControl,
): Promise<void> {
	if (!recovery) return budgetAdmission.beforeUpstreamDispatch(route);
	if (recovery.singleCommittedRequestGrant !== true) {
		return recovery.beforeDispatch(route, attemptIndex,
			() => budgetAdmission.beforeUpstreamDispatch(route), checkActive);
	}
	if (typeof recovery.beforeSingleGrantDispatch !== 'function') {
		throw new Error('Single-grant image recovery callback is unavailable');
	}
	checkActive();
	if (!isPreparedImageAttempt(preparedAttempt)
		|| !preparedImageAttemptMatchesRoute(preparedAttempt, route)) {
		throw new Error('Single-grant image attempt does not match the prepared route');
	}
	let preparedContext: TrustedImagePreparedAttemptContext | undefined;
	if (requestSha256 !== undefined) {
		const { contextSha256, outboundPayloadSha256 } =
			await preparedAttempt.digestTrustedContext(requestSha256, contextControl);
		preparedContext = Object.freeze({
			operation: preparedAttempt.operation, requestSha256,
			contextSha256, outboundPayloadSha256,
			routeIdentity: preparedAttempt.routeIdentity,
		});
	}
	checkActive();
	const prepared = await budgetAdmission.prepareSingleGrant(route);
	const resolution: { state: 'prepared' | 'marking' | 'marked' | 'releasing' | 'release_failed' | 'released' | 'unknown' } = {
		state: 'prepared',
	};
	const ticket: SingleGrantBudgetTicket = Object.freeze({
		async markAfterCommittedClaim() {
			if (resolution.state !== 'prepared') throw new Error('Image single-grant budget ticket already resolved');
			resolution.state = 'marking';
			try {
				await prepared.markAfterCommittedClaim();
				resolution.state = 'marked';
			} catch (error) {
				resolution.state = 'unknown';
				throw error;
			}
		},
		async releaseAfterDefiniteNoClaim() {
			if (resolution.state !== 'prepared' && resolution.state !== 'release_failed') {
				throw new Error('Image single-grant budget ticket cannot be released');
			}
			resolution.state = 'releasing';
			try {
				await prepared.releaseAfterDefiniteNoClaim();
				resolution.state = 'released';
			} catch (error) {
				resolution.state = 'release_failed';
				throw error;
			}
		},
		holdAfterUncertainClaim() {
			if (resolution.state !== 'prepared') throw new Error('Image single-grant budget ticket already resolved');
			prepared.holdAfterUncertainClaim();
			resolution.state = 'unknown';
		},
	});
	try {
		await recovery.beforeSingleGrantDispatch(route, attemptIndex, ticket, checkActive, preparedContext);
	} catch (error) {
		if (resolution.state === 'prepared') {
			prepared.holdAfterUncertainClaim();
			resolution.state = 'unknown';
		}
		if (resolution.state === 'marking' || resolution.state === 'marked'
			|| resolution.state === 'releasing' || resolution.state === 'unknown') {
			throw new ImageSingleGrantBudgetOutcomeUnknownError();
		}
		throw error;
	}
	if (resolution.state === 'marked') {
		try { checkActive(); }
		catch { throw new ImageSingleGrantBudgetOutcomeUnknownError(); }
		return;
	}
	if (resolution.state === 'prepared') {
		prepared.holdAfterUncertainClaim();
		resolution.state = 'unknown';
	}
	if (resolution.state === 'unknown' || resolution.state === 'marking' || resolution.state === 'releasing') {
		throw new ImageSingleGrantBudgetOutcomeUnknownError();
	}
	throw new Error('Single-grant image recovery returned without a committed claim');
}

async function terminateImageOrdinaryBudget(
	lease: OrdinaryBudgetLease,
	requestId: string,
	reason: string,
): Promise<void> {
	try {
		await lease.terminateUnknown(reason);
	} catch (error) {
		console.error(
			`[Gateway Images] ordinary budget cleanup failed requestId=${requestId} state=${lease.state} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function terminateImageGuardrailBudget(
	lease: AdmittedImageGuardrailBudgetLease,
	reason: string,
): Promise<void> {
	try {
		if (lease.dispatched) await lease.forfeit(reason);
		else await lease.release(reason);
	} catch (error) {
		console.error(
			`[Gateway Images] guardrail budget cleanup failed reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function finishImageSingleGrantWithoutDispatch(
	c: ImagesContext,
	requestId: string,
	proxyResult: ProxyResult,
	ordinaryBudgetLease: OrdinaryBudgetLease,
	guardrailBudgetLease: AdmittedImageGuardrailBudgetLease,
): Promise<Response> {
	if (proxyResult.stickyMutationPromise) {
		scheduleBackgroundWork(c, proxyResult.stickyMutationPromise);
	}
	if (proxyResult.response.ok || proxyResult.meta?.upstreamOutcomeUnknown === true
		|| ordinaryBudgetLease.state === 'dispatched' || guardrailBudgetLease.dispatched) {
		await proxyResult.response.body?.cancel('single_grant_response_without_authorization').catch(() => undefined);
		return imageClaimUncertainResponse(c, requestId);
	}
	if (ordinaryBudgetLease.state === 'reserved') {
		await terminateImageOrdinaryBudget(ordinaryBudgetLease, requestId, 'upstream_dispatch_not_started');
	}
	await terminateImageGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_not_started');
	// No committed grant reached the driver. Preserve a gateway denial while
	// normalizing any other local pre-fetch error through the usual public path.
	// Neither case may invoke a recovery settlement or the legacy writer.
	const { response } = await materializeNonOkResponse(proxyResult.response, {
		requestId,
		trustedGatewayError: proxyResult.meta?.gatewayGeneratedError === true
			|| proxyResult.response.headers.has('X-OctaFuse-Error-Code'),
	});
	return response;
}

type MultipartEditsParseResult =
	| {
		ok: true;
		model: string;
		edit: NormalizedImageEditRequest;
		provider: Record<string, unknown> | null;
		totalUploadBytes: number;
	  }
	| {
			ok: false;
			error: string;
			diag: Omit<ImageRejectDiag, 'operation'>;
	  };

export function parseMultipartImageProvider(
	value: unknown,
): { ok: true; value: Record<string, unknown> | null } | { ok: false; message: string } {
	if (value === undefined) return { ok: true, value: null };
	let parsed: unknown = value;
	if (typeof value === 'string') {
		if (value.length > 16_384) {
			return { ok: false, message: 'provider must be at most 16384 characters in multipart requests' };
		}
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			return { ok: false, message: 'provider must be a JSON object in multipart requests' };
		}
	}
	if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, message: 'provider must be a JSON object in multipart requests' };
	}
	return { ok: true, value: parsed as Record<string, unknown> };
}

async function parseMultipartEdits(c: ImagesContext, ownedFiles: MultipartFile[]): Promise<MultipartEditsParseResult> {
	const contentType = c.req.header('content-type') ?? '';
	const contentLength = c.req.header('content-length') ?? null;
	const baseDiag = {
		contentType: contentType || null,
		contentLength,
	};

	const contentTypeError = validateImagesEditsContentType(contentType);
	if (contentTypeError) {
		return {
			ok: false,
			error: contentTypeError,
			diag: {
				...baseDiag,
				bodyKeys: [],
				hasModel: false,
			},
		};
	}

	let body: Record<string, unknown>;
	try {
		body = await readStreamingMultipartBody(c.req.raw, {
			maxFiles: IMAGE_MAX_REFERENCE_COUNT, maxFileBytes: IMAGE_MAX_BYTES_PER_FILE,
		}, c.get('textRequestLifecycle')?.deadline);
		for (const value of Object.values(body).flat()) if (value instanceof MultipartFile) ownedFiles.push(value);
	} catch (error) {
		assertTextRequestActive(c);
		// Preserve the ingress byte-limit error instead of disguising it as bad multipart.
		if (textRequestFailureResponse(error, c)) throw error;
		return {
			ok: false,
			error: 'Invalid multipart body',
			diag: {
				...baseDiag,
				bodyKeys: [],
				hasModel: false,
			},
		};
	}

	const bodyKeys = summarizeBodyKeys(body);
	if (Object.prototype.hasOwnProperty.call(body, 'session_id')) {
		return {
			ok: false,
			error: 'session_id is not supported in an images body; use x-session-id',
			diag: {
				...baseDiag,
				bodyKeys,
				hasModel: typeof body.model === 'string' && body.model.trim() !== '',
			},
		};
	}
	const modelRaw = body.model;
	const model = typeof modelRaw === 'string' ? modelRaw.trim() : '';
	if (!model) {
		return {
			ok: false,
			error: 'Missing model',
			diag: {
				...baseDiag,
				bodyKeys,
				hasModel: false,
			},
		};
	}
	const provider = parseMultipartImageProvider(body.provider);
	if (!provider.ok) {
		return {
			ok: false,
			error: provider.message,
			diag: {
				...baseDiag,
				bodyKeys,
				hasModel: true,
				clientModel: model,
			},
		};
	}

	const common = normalizeImageCommonParams({
		prompt: body.prompt,
		n: body.n,
		size: body.size,
		quality: body.quality,
		background: body.background,
	});
	if (!common.ok) {
		return {
			ok: false,
			error: common.error,
			diag: {
				...baseDiag,
				bodyKeys,
				hasModel: true,
				clientModel: model,
				promptChars: typeof body.prompt === 'string' ? body.prompt.length : 0,
			},
		};
	}

	const images: ImageEditUpload[] = [];
	let totalBytes = 0;
	const collectFile = async (value: unknown, fallbackName: string): Promise<string | null> => {
		if (value == null) return null;
		assertTextRequestActive(c);
		// Keep request-owned pages through permitted failover; do not concatenate
		// them into a whole File/Blob or populate Hono's native body cache.
		if (value instanceof MultipartFile) {
			if (images.length >= IMAGE_MAX_REFERENCE_COUNT) {
				return `At most ${IMAGE_MAX_REFERENCE_COUNT} reference images are allowed`;
			}
			const upload: ImageEditUpload = {
				filename: value.name || fallbackName,
				mimeType: value.type || 'application/octet-stream',
				upload: value,
			};
			const error = validateImageUpload(upload);
			if (error) return error;
			if (totalBytes + value.size > IMAGE_MAX_TOTAL_UPLOAD_BYTES) {
				return `total image upload must be at most ${IMAGE_MAX_TOTAL_UPLOAD_BYTES} bytes`;
			}
			totalBytes += value.size;
			images.push(upload);
			return null;
		}
		if (typeof value === 'string' && value.startsWith('data:')) {
			return null;
		}
		return null;
	};

	const imageField = body.image ?? body.images;
	if (Array.isArray(imageField)) {
		let i = 0;
		for (const item of imageField) {
			const err = await collectFile(item, `image-${i++}.png`);
			if (err) {
				return {
					ok: false,
					error: err,
					diag: {
						...baseDiag,
						bodyKeys,
						hasModel: true,
						clientModel: model,
						promptChars: common.prompt.length,
						referenceCount: images.length,
						totalUploadBytes: totalBytes,
					},
				};
			}
		}
	} else {
		const err = await collectFile(imageField, 'image.png');
		if (err) {
			return {
				ok: false,
				error: err,
				diag: {
					...baseDiag,
					bodyKeys,
					hasModel: true,
					clientModel: model,
					promptChars: common.prompt.length,
					referenceCount: images.length,
					totalUploadBytes: totalBytes,
				},
			};
		}
	}

	// Also accept image[] style keys if parseBody flattened differently
	for (const [key, value] of Object.entries(body)) {
		if (key === 'image' || key === 'images') continue;
		if (!/^image(\[\])?$/i.test(key) && !/^image_\d+$/i.test(key)) continue;
		if (Array.isArray(value)) {
			let i = 0;
			for (const item of value) {
				const err = await collectFile(item, `image-${i++}.png`);
				if (err) {
					return {
						ok: false,
						error: err,
						diag: {
							...baseDiag,
							bodyKeys,
							hasModel: true,
							clientModel: model,
							promptChars: common.prompt.length,
							referenceCount: images.length,
							totalUploadBytes: totalBytes,
						},
					};
				}
			}
		} else {
			const err = await collectFile(value, 'image.png');
			if (err) {
				return {
					ok: false,
					error: err,
					diag: {
						...baseDiag,
						bodyKeys,
						hasModel: true,
						clientModel: model,
						promptChars: common.prompt.length,
						referenceCount: images.length,
						totalUploadBytes: totalBytes,
					},
				};
			}
		}
	}

	if (images.length === 0) {
		return {
			ok: false,
			error: 'At least one image file is required',
			diag: {
				...baseDiag,
				bodyKeys,
				hasModel: true,
				clientModel: model,
				promptChars: common.prompt.length,
				referenceCount: 0,
				totalUploadBytes: totalBytes,
			},
		};
	}
	if (images.length > IMAGE_MAX_REFERENCE_COUNT) {
		return {
			ok: false,
			error: `At most ${IMAGE_MAX_REFERENCE_COUNT} reference images are allowed`,
			diag: {
				...baseDiag,
				bodyKeys,
				hasModel: true,
				clientModel: model,
				promptChars: common.prompt.length,
				referenceCount: images.length,
				totalUploadBytes: totalBytes,
			},
		};
	}
	for (const img of images) {
		const err = validateImageUpload(img);
		if (err) {
			return {
				ok: false,
				error: err,
				diag: {
					...baseDiag,
					bodyKeys,
					hasModel: true,
					clientModel: model,
					promptChars: common.prompt.length,
					referenceCount: images.length,
					totalUploadBytes: totalBytes,
				},
			};
		}
	}

	return {
		ok: true,
		model,
		provider: provider.value,
		edit: {
			prompt: common.prompt,
			n: common.n,
			size: common.size,
			quality: common.quality,
			background: common.background,
			images,
		},
		totalUploadBytes: totalBytes,
	};
}

type FinalizeImageParams = {
	recovery?: ImageRecoveryRequest;
	c: ImagesContext;
	proxyResult: ProxyResult;
	requestLogId: string;
	budgetAccountedAt: string;
	guardrailBudgetReserved: boolean;
	forfeitGuardrailBudget(reason: string): Promise<void>;
	ordinaryBudgetLease: OrdinaryBudgetLease;
	apiKey: ApiKeyContext;
	repos: GatewayRepositories;
	baseModelId: string;
	effectiveRouteGroup: string;
	modelNameForLog: string;
	requestBodyForLog: string | null;
	sessionId: string | null;
	operation: 'generations' | 'edits';
	billing: ImageBillingParams;
	/** 入口预算预检仅供取消诊断；取消/网关超时不向买家收费。 */
	budgetPrecheck: ImageCostBreakdown;
	/** generations 用 rawModelId；edits 同 */
	clientModelId: string;
	common: {
		prompt: string;
		n: number;
		size?: string;
		quality?: string;
		background?: string;
	};
	multiImageBilling?: ReturnType<typeof multipleImageBillingMode>;
	referenceCount?: number;
	start: number;
	timing: RequestTimingCollector;
};

function finalizeImageStreamResponse(
	params: FinalizeImageParams,
	settlement: NonNullable<ProxyResult['meta']>['imageStreamSettlement'],
): Response {
	if (!settlement) throw new Error('Image stream settlement is missing');
	const recovery = params.recovery?.singleCommittedRequestGrant === true
		|| params.recovery?.mayHaveDispatched ? params.recovery : undefined;
	const {
		c,
		proxyResult,
		requestLogId,
		budgetAccountedAt,
		guardrailBudgetReserved,
		forfeitGuardrailBudget,
		ordinaryBudgetLease,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		sessionId,
		operation,
		billing,
		budgetPrecheck,
		clientModelId,
		common,
		referenceCount,
		start,
		timing,
	} = params;
	const {
		chosenRoute,
		upstreamRequestId,
		circuitEvents,
		suppressErrorAlert,
		stickyTrace,
		stickyMutationPromise,
	} = proxyResult;
	if (stickyMutationPromise) scheduleBackgroundWork(c, stickyMutationPromise);

	const upstreamRequestBodyForLog = finalizeRequestLogJson(
		redactImageRequestForLog({
			operation,
			model: chosenRoute.providerModelName,
			n: common.n,
			size: common.size,
			quality: common.quality,
			background: common.background,
			prompt: common.prompt,
			referenceCount,
		}),
	);

	const accepted = (async () => {
			const outcome = await settlement;
			const status: 'success' | 'error' = outcome.completed && outcome.done
				? 'success'
				: 'error';
			if (status === 'success') markUserModelSuccess(apiKey.userId, baseModelId);
			const imageAbortReason = outcome.imageAbortReason
				?? (outcome.cancelled ? 'client_abort' : null);
			const capacityCostUnknown = shouldPreserveImageDispatchedCeiling({
				costUnknown: outcome.upstreamOutcomeUnknown === true, imageAbortReason,
			});
			const stickyTraceSnapshot = recovery ? null : stickyTrace ? await stickyTrace() : null;
			const usageParams: RecordImageUsageParams = {
				repos,
				requestLogId,
				budgetAccountedAt,
				guardrailBudgetSettlement: guardrailBudgetReserved
					? { requestId: requestLogId, ...(capacityCostUnknown ? { mode: 'reserved' as const } : {}) }
					: undefined,
				ordinaryBudgetSettlement:
					ordinaryBudgetLease.reserved && ordinaryBudgetLease.state === 'dispatched'
						? {
								requestId: requestLogId,
								budgetEpoch: ordinaryBudgetLease.budgetEpoch!,
								reservedMicros: ordinaryBudgetLease.reservedMicros,
								unknownCost: capacityCostUnknown,
							}
						: undefined,
				apiKeyId: apiKey.keyId,
				workspaceId: apiKey.workspaceId,
				userId: apiKey.userId,
				userEmail: apiKey.userEmail,
				modelId: baseModelId,
				providerId: chosenRoute.providerId,
				providerModelName: chosenRoute.providerModelName,
				modelName: modelNameForLog,
				providerName: chosenRoute.providerName,
				requestBody: requestBodyForLog,
				upstreamRequestBody: upstreamRequestBodyForLog,
				requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
				requestOrigin: new URL(c.req.url).origin,
				...generationRequestContext(c.req.raw.headers),
				sessionId,
				responseStreamed: true,
				requestProtocol: 'openai',
				requestOperation: 'images.generations',
				upstreamProtocol: chosenRoute.upstreamProtocol,
				upstreamOperation: chosenRoute.upstreamOperation,
				modelSurfaceId: chosenRoute.modelSurfaceId,
				routePoolId: chosenRoute.routePoolId,
				routeTargetId: chosenRoute.targetId,
				adapter: chosenRoute.adapter,
				stickyTrace: stickyTraceSnapshot,
				providerRoutingTrace: chosenRoute.providerRoutingTrace ?? null,
				routeGroup: effectiveRouteGroup,
				status,
				latencyMs: Date.now() - start,
				errorMessage: status === 'error'
					? outcome.errorMessage ?? 'Image generation stream did not complete'
					: undefined,
				billing,
				effectiveImageCount: outcome.validImages,
				imageUsage: outcome.imageUsage,
				clientAbortPrecheck: imageAbortReason ? budgetPrecheck : null,
				imageAbortReason,
				resultConfirmed: status === 'success',
				upstreamAccepted: true,
				clientOutcomeBillable: capacityCostUnknown ? undefined : status === 'success',
				upstreamSupplierCostUsdTicks: outcome.upstreamSupplierCostUsdTicks,
				providerKeyId: chosenRoute.providerKeyId ?? null,
				providerKeyLabel: chosenRoute.providerKeyLabel ?? null,
				providerKeyFingerprint: chosenRoute.providerKeyFingerprint ?? null,
				upstreamRequestId,
				timing: timing.snapshot(),
				circuitEvents: circuitEvents.length > 0 ? circuitEvents : undefined,
				suppressErrorAlert: suppressErrorAlert || undefined,
			};
			if (recovery) {
				const commit = await recovery.persist(usageParams);
				scheduleBackgroundWork(c, commit().catch(() => {
					console.warn(JSON.stringify({ message:'image accounting awaits durable recovery',request_id:requestLogId }));
				}));
			} else await recordImageUsage(usageParams);
		})();
	scheduleBackgroundWork(c, accepted.catch(async (err) => {
			console.error(
				`[Gateway Images] stream settlement failed baseModelId=${baseModelId} keyId=${apiKey.keyId} clientModel=${clientModelId} error=${err instanceof Error ? err.message : String(err)}`,
			);
			// A lost persistence ACK may already have created a recovery job.
			// Keep the original reservation; never forfeit via a second writer.
			if (recovery) return;
			await forfeitGuardrailBudget('image_stream_settlement_failed');
			await terminateImageOrdinaryBudget(
				ordinaryBudgetLease,
				requestLogId,
				'image_stream_settlement_failed',
			);
		}),
	);
	return gateImageSseDelivery(proxyResult.response, accepted, requestLogId);
}

/**
 * generations / edits 共用：materialize → 用量/状态 → 后台记费 → 统一响应。
 * 优先消费 driver 经 failover 透传的 `meta.parsedBody` / `meta.imageUsage`，避免重复 JSON.parse。
 */
async function finalizeImageResponse(params: FinalizeImageParams): Promise<Response> {
	const recovery = params.recovery?.singleCommittedRequestGrant === true
		|| params.recovery?.mayHaveDispatched ? params.recovery : undefined;
	const {
		c,
		proxyResult,
		requestLogId,
		budgetAccountedAt,
		guardrailBudgetReserved,
		forfeitGuardrailBudget,
		ordinaryBudgetLease,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		sessionId,
		operation,
		billing,
		budgetPrecheck,
		clientModelId,
		common,
		multiImageBilling,
		referenceCount,
		start,
		timing,
	} = params;

	const {
		chosenRoute,
		upstreamRequestId,
		circuitEvents,
		suppressErrorAlert,
		stickyTrace,
		stickyMutationPromise,
	} = proxyResult;
	if (proxyResult.response.ok && proxyResult.meta?.imageStreamSettlement) {
		if (recovery && recovery.responseStreamed !== true) {
			await proxyResult.response.body?.cancel('image_recovery_stream_contract_unsupported').catch(() => undefined);
			throw new Error('Ordinary Images recovery cannot accept an unexpected streaming result');
		}
		return finalizeImageStreamResponse(params, proxyResult.meta.imageStreamSettlement);
	}
	if (stickyMutationPromise) {
		scheduleBackgroundWork(c, stickyMutationPromise);
	}
	const { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response, {
		requestId: requestLogId,
		trustedGatewayError: proxyResult.meta?.gatewayGeneratedError === true,
	}).catch(
		async (error: unknown) => {
			// A claimed durable dispatch cannot fall back to a second financial path.
			if (recovery) throw error;
			await forfeitGuardrailBudget('upstream_response_materialization_failed');
			await terminateImageOrdinaryBudget(
				ordinaryBudgetLease,
				requestLogId,
				'upstream_response_materialization_failed',
			);
			throw error;
		},
	);
	const usageUnavailable = await proxyResult.usagePromise.then(
		() => false,
		() => true,
	);

	const parsedBody = proxyResult.meta?.parsedBody ?? null;
	const imageUsage = response.ok ? (proxyResult.meta?.imageUsage ?? null) : null;
	const validImages = response.ok ? countValidImageResults(parsedBody) : 0;
	const latency = Date.now() - start;
	const imageAbortReason = proxyResult.meta?.imageAbortReason ?? null;
	const ordinaryCostUnknown = proxyResult.meta?.upstreamOutcomeUnknown === true
		|| proxyResult.meta?.responseBodyTooLarge === true
		|| (response.ok && usageUnavailable);
	const clientAbortPrecheck =
		imageAbortReason === 'client_abort' || imageAbortReason === 'gateway_timeout'
			? budgetPrecheck
			: null;

	let upstreamSupplierCostUsdTicks: number | null = null;
	if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
		const usage = (parsedBody as Record<string, unknown>).usage;
		if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
			const ticks = (usage as Record<string, unknown>).cost_in_usd_ticks;
			if (typeof ticks === 'number' && Number.isFinite(ticks)) {
				upstreamSupplierCostUsdTicks = ticks;
			}
		}
	}

	// Counters and supplier cost have been extracted. The driver already encoded
	// the normalized JSON once; transfer that body instead of another stringify,
	// clone/read and Response copy. Background accounting needs no image payload.
	if (proxyResult.meta) delete proxyResult.meta.parsedBody;

	let userModelCircuitEvent = null;
	if (!response.ok && errorBodyText != null && proxyResult.meta?.gatewayGeneratedError !== true
		&& proxyResult.meta?.admissionDeniedPreDispatch !== true) {
		userModelCircuitEvent = maybeTriggerUserModelCircuitFromUpstream(
			apiKey.userId,
			baseModelId,
			response.status,
			response.headers.get('content-type'),
			errorBodyText,
			formatHttpErrorTextForRequestLog(
				response.status,
				response.headers.get('content-type'),
				errorBodyText
			),
			{ clientErrorCircuitEnabled: false }
		);
	}
	const alertCircuitEvents = userModelCircuitEvent
		? [...circuitEvents, userModelCircuitEvent]
		: circuitEvents;

	const missingMultiImageTokenUsage =
		common.n > 1
		&& multiImageBilling === 'token'
		&& !hasAuthoritativeImageTokenUsage(imageUsage);
	const status: 'success' | 'error' =
		response.ok && validImages > 0 && !missingMultiImageTokenUsage ? 'success' : 'error';
	const settlementCostUnknown = shouldPreserveImageDispatchedCeiling({
		costUnknown: ordinaryCostUnknown,
		imageAbortReason,
	});
	if (status === 'success') markUserModelSuccess(apiKey.userId, baseModelId);
	let errorMessage: string | undefined;
	if (status === 'error') {
		if (missingMultiImageTokenUsage) {
			errorMessage = 'Multiple-image generation completed without authoritative usage';
		} else if (response.ok && validImages === 0) {
			errorMessage = 'Upstream returned no image data';
		} else if (errorBodyText != null) {
			errorMessage = formatHttpErrorTextForRequestLog(
				response.status,
				response.headers.get('content-type'),
				errorBodyText
			);
		} else {
			errorMessage = `HTTP ${response.status}`;
		}
	}

	const upstreamRequestBodyForLog = finalizeRequestLogJson(
		redactImageRequestForLog({
			operation,
			model: chosenRoute.providerModelName,
			n: common.n,
			size: common.size,
			quality: common.quality,
			background: common.background,
			prompt: common.prompt,
			referenceCount,
		})
	);

	const writeUsage = async () => {
			const stickyTraceSnapshot = recovery ? null : stickyTrace ? await stickyTrace() : null;
			const usageParams: RecordImageUsageParams = {
				repos,
				requestLogId,
				budgetAccountedAt,
				guardrailBudgetSettlement: guardrailBudgetReserved
					? {
							requestId: requestLogId,
							...(settlementCostUnknown ? { mode: 'reserved' as const } : {}),
						}
					: undefined,
				ordinaryBudgetSettlement:
					ordinaryBudgetLease.reserved && ordinaryBudgetLease.state === 'dispatched'
						? {
								requestId: requestLogId,
								budgetEpoch: ordinaryBudgetLease.budgetEpoch!,
								reservedMicros: ordinaryBudgetLease.reservedMicros,
								unknownCost: settlementCostUnknown,
							}
						: undefined,
				apiKeyId: apiKey.keyId,
				workspaceId: apiKey.workspaceId,
				userId: apiKey.userId,
				userEmail: apiKey.userEmail,
				modelId: baseModelId,
				providerId: chosenRoute.providerId,
				providerModelName: chosenRoute.providerModelName,
				modelName: modelNameForLog,
				providerName: chosenRoute.providerName,
				requestBody: requestBodyForLog,
				upstreamRequestBody: upstreamRequestBodyForLog,
				requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
				requestOrigin: new URL(c.req.url).origin,
				...generationRequestContext(c.req.raw.headers),
				sessionId,
				responseStreamed: false,
				requestProtocol: 'openai',
				requestOperation: operation === 'generations' ? 'images.generations' : 'images.edits',
				upstreamProtocol: chosenRoute.upstreamProtocol,
				upstreamOperation: chosenRoute.upstreamOperation,
				modelSurfaceId: chosenRoute.modelSurfaceId,
				routePoolId: chosenRoute.routePoolId,
				routeTargetId: chosenRoute.targetId,
				adapter: chosenRoute.adapter,
				stickyTrace: stickyTraceSnapshot,
				providerRoutingTrace: chosenRoute.providerRoutingTrace ?? null,
				routeGroup: effectiveRouteGroup,
				status,
				latencyMs: latency,
				errorMessage,
				billing,
				effectiveImageCount: validImages,
				imageUsage,
				clientAbortPrecheck,
				imageAbortReason,
				resultConfirmed: status === 'success' && validImages > 0,
				upstreamAccepted: response.ok,
				clientOutcomeBillable: imageClientOutcomeBillable({
					status,
					responseOk: response.ok,
					costUnknown: ordinaryCostUnknown,
					imageAbortReason,
				}),
				upstreamSupplierCostUsdTicks,
				providerKeyId: chosenRoute.providerKeyId ?? null,
				providerKeyLabel: chosenRoute.providerKeyLabel ?? null,
				providerKeyFingerprint: chosenRoute.providerKeyFingerprint ?? null,
				upstreamRequestId,
				timing: timing.snapshot(),
				circuitEvents: alertCircuitEvents.length > 0 ? alertCircuitEvents : undefined,
				suppressErrorAlert: suppressErrorAlert || undefined,
			};
			if (recovery) {
				const settle = await recovery.persist(usageParams);
				// The response depends on durable acceptance, not this best-effort fast path.
				scheduleBackgroundWork(c, settle().catch(() => {
					console.warn(JSON.stringify({ message:'image accounting awaits durable recovery',request_id:requestLogId }));
				}));
			} else await recordImageUsage(usageParams);
	};
	if (recovery) {
		try { await writeUsage(); }
		catch {
			await response.body?.cancel('image_settlement_persistence_unconfirmed').catch(() => undefined);
			// Never fall back to the legacy writer/forfeit: a lost persistence ACK may
			// already have left a durable job. Preserve the intent and original budget.
			return gatewayErrorJson(c, { status:503,code:GatewayErrorCode.imageSettlementUnconfirmed,
				metadata:{request_id:requestLogId,outcome_unknown:true,retry_safe:false},
				message:'Image settlement persistence is unconfirmed. Upstream may have completed; do not automatically retry.' });
		}
	} else scheduleBackgroundWork(c, writeUsage().catch(async (err) => {
			console.error(
				`[Gateway Images] recordImageUsage failed baseModelId=${baseModelId} keyId=${apiKey.keyId} clientModel=${clientModelId} error=${err instanceof Error ? err.message : String(err)}`
			);
			await forfeitGuardrailBudget('image_usage_settlement_failed');
			await terminateImageOrdinaryBudget(
				ordinaryBudgetLease,
				requestLogId,
				'image_usage_settlement_failed',
			);
		}));

	if (status === 'success') {
		return new Response(response.body, {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	if (response.ok && validImages === 0) {
		void response.body?.cancel('image_result_invalid').catch(() => undefined);
		return gatewayErrorJson(c, {
			status: 502,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: 'Upstream returned no image data',
			metadata: unknownImageOutcomeMetadata(requestLogId),
		});
	}
	if (missingMultiImageTokenUsage) {
		void response.body?.cancel('image_usage_unavailable').catch(() => undefined);
		return gatewayErrorJson(c, {
			status: 502,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: 'Multiple-image generation completed without authoritative usage',
			metadata: unknownImageOutcomeMetadata(requestLogId),
		});
	}
	// Driver evidence, not the normalized HTTP status, determines uncertainty.
	// Cancellation can be non-billable to the buyer while supplier work is unknown.
	if (ordinaryCostUnknown) {
		return unknownImageOutcomeResponse(response, errorBodyText, requestLogId);
	}
	return new Response(response.body, {
		status: response.status >= 400 && response.status < 600 ? response.status : 502,
		headers: response.headers,
	});
}

async function handleImageGenerations(c: ImagesContext): Promise<Response> {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const lifecycle = c.get('textRequestLifecycle');
	const dispatchBudget = lifecycle?.dispatchBudget ?? createRequestDispatchBudget();
	const start = dispatchBudget.createdAtMs;
	assertTextRequestActive(c);
	const requestStartedAt = new Date(start);
	const requestCorrelationId = c.get('generationId')!;
	const timing = new RequestTimingCollector();
	const contentType = c.req.header('content-type') ?? null;
	const contentLength = c.req.header('content-length') ?? null;
	const parsedSession = parseOpenRouterSessionHeader(c.req.raw.headers);
	if (!parsedSession.ok) {
		return rejectImageRequest(c, 400, parsedSession.message, {
			operation: 'generations', contentType, contentLength, bodyKeys: [], hasModel: false,
		});
	}
	const sessionId = parsedSession.sessionId;

	let body: Record<string, unknown>;
	try {
		body = await waitForTextRequestRead(c, () => readImageJsonRequest(c.req.raw, lifecycle?.deadline.signal));
	} catch (error) {
		assertTextRequestActive(c);
		const failure = textRequestFailureResponse(error, c);
		if (failure) return failure;
		return rejectImageRequest(c, 400, 'Invalid JSON body', {
			operation: 'generations',
			contentType,
			contentLength,
			bodyKeys: [],
			hasModel: false,
		});
	}

	const bodyKeys = summarizeBodyKeys(body);
	if (Object.prototype.hasOwnProperty.call(body, 'session_id')) {
		const clientModel = typeof body.model === 'string' ? body.model.trim() : '';
		return rejectImageRequest(
			c,
			400,
			'session_id is not supported in an images body; use x-session-id',
			{
				operation: 'generations', contentType, contentLength, bodyKeys,
				hasModel: clientModel !== '', clientModel: clientModel || undefined,
			},
		);
	}
	const rawModelId = typeof body.model === 'string' ? body.model.trim() : '';
	if (!rawModelId) {
		return rejectImageRequest(c, 400, 'Missing model', {
			operation: 'generations',
			contentType,
			contentLength,
			bodyKeys,
			hasModel: false,
		});
	}

	const initialCommon = normalizeImageGenerationParams({
		prompt: body.prompt,
		n: body.n,
		size: body.size,
		quality: body.quality,
		background: body.background,
	});
	if (!initialCommon.ok) {
		return rejectImageRequest(c, 400, initialCommon.error, {
			operation: 'generations',
			contentType,
			contentLength,
			bodyKeys,
			hasModel: true,
			clientModel: rawModelId,
			promptChars: isJsonString(body.prompt) ? body.prompt.length : 0,
		});
	}
	if (body.stream !== undefined && typeof body.stream !== 'boolean') {
		return rejectImageRequest(c, 400, 'stream must be a boolean', {
			operation: 'generations', contentType, contentLength, bodyKeys,
			hasModel: true, clientModel: rawModelId,
		});
	}
	const recoveryFactory = c.get('imageUsageRecovery');
	const requestSha256 = recoveryFactory?.requiresTrustedIngressDigest === true
		? await withImageIngressDigestControl(c, start, control =>
			digestTrustedImageGenerationIngress({ body, sessionId, control }))
		: undefined;
	// This request-owned object must not keep raw prompt padding alive while
	// asynchronous Guardrails/routing run. They already receive the trimmed value.
	body.prompt = initialCommon.prompt;

	const guardrail = await runRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelIds: [rawModelId],
		body: imageGenerationGuardrailBody(rawModelId, initialCommon),
		correlationId: requestCorrelationId,
		now: requestStartedAt,
		control: lifecycle?.deadline,
	});
	if (!guardrail.ok) {
		return gatewayErrorJson(c, {
			status: guardrail.status,
			code: guardrail.code === 'guardrail_invalid'
				? GatewayErrorCode.guardrailInvalid
				: GatewayErrorCode.guardrailBlocked,
			message: guardrail.message,
		});
	}
	const guardedPrompt = guardrail.body.prompt;
	if (typeof guardedPrompt !== 'string') {
		return rejectImageRequest(c, 400, 'Guardrail produced an invalid image prompt', {
			operation: 'generations', contentType, contentLength, bodyKeys,
			hasModel: true, clientModel: rawModelId,
		});
	}
	body = { ...body, prompt: guardedPrompt };
	const common = normalizeImageCommonParams({
		prompt: body.prompt,
		n: body.n,
		size: body.size,
		quality: body.quality,
		background: body.background,
	});
	if (!common.ok) {
		return rejectImageRequest(c, 400, common.error, {
			operation: 'generations', contentType, contentLength, bodyKeys,
			hasModel: true, clientModel: rawModelId,
		});
	}
	const outputGuardrailRejection = await failClosedForImageOutputGuardrail(
		c, repos, apiKey, rawModelId, requestCorrelationId, guardrail,
	);
	assertTextRequestActive(c);
	if (outputGuardrailRejection) return outputGuardrailRejection;

	const fallbackPlan = await waitForTextRequestRead(c, buildModelFallbackPlan, repos, {
		modelIds: [rawModelId],
		body,
		requestProtocol: 'openai',
		requestOperation: 'images.generations',
		pricingAt: requestStartedAt,
		control: lifecycle?.deadline,
	});
	if (!fallbackPlan.ok) {
		return rejectImageRequest(c, fallbackPlan.status, fallbackPlan.message, {
			operation: 'generations',
			contentType,
			contentLength,
			bodyKeys,
			hasModel: true,
			clientModel: rawModelId,
			promptChars: common.prompt.length,
		});
	}
	const selectedPlan = fallbackPlan.candidates[0]!;
	const { model, baseModelId, effectiveRouteGroup } = selectedPlan;
	body = selectedPlan.upstreamBody;
	if (body.stream !== undefined && typeof body.stream !== 'boolean') {
		return rejectImageRequest(c, 400, 'stream must be a boolean', {
			operation: 'generations', contentType, contentLength, bodyKeys,
			hasModel: true, clientModel: rawModelId,
		});
	}
	const streamRequested = body.stream === true;
	if (streamRequested && recoveryFactory && recoveryFactory.supportsStreaming !== true
		&& recoveryFactory.allowLegacyStreamingFallback !== true) {
		return gatewayErrorJson(c, {
			status: 503,
			code: GatewayErrorCode.capacityUnavailable,
			message: 'Image stream recovery is unavailable',
			metadata: { request_id: requestCorrelationId },
		});
	}
	let routes = selectedPlan.routes;
	if (streamRequested) {
		routes = routes.filter((route) => imageRouteSupportsParameter(route, 'stream'));
		if (routes.length === 0) {
			return rejectImageRequest(c, 400, 'No configured endpoint proves support for image streaming', {
				operation: 'generations', contentType, contentLength, bodyKeys,
				hasModel: true, clientModel: rawModelId,
			});
		}
	}
	let multiImageBilling: ReturnType<typeof multipleImageBillingMode> = null;
	if (common.n > 1) {
		routes = routes.filter((route) => imageRouteSupportsParameter(route, 'n', common.n));
		if (routes.length === 0) {
			return rejectImageRequest(c, 400, 'No configured endpoint proves support for n > 1', {
				operation: 'generations', contentType, contentLength, bodyKeys,
				hasModel: true, clientModel: rawModelId,
			});
		}
		// The Endpoint precheck below proves every eligible route has a
		// count-based tariff before any upstream dispatch can begin.
		multiImageBilling = 'per_image';
	}
	const modelNameForLog = modelDisplayName(model, baseModelId);

	const upstreamBody: Record<string, unknown> = {
		prompt: common.prompt,
		n: common.n,
	};
	if (common.size) upstreamBody.size = common.size;
	if (common.quality) upstreamBody.quality = common.quality;
	if (common.background) upstreamBody.background = common.background;
	// 仅显式透传：GPT Image 不接受 response_format（DALL·E 遗留），默认由上游决定
	if (isJsonString(body.response_format) && hasJsonStringContent(body.response_format)) {
		upstreamBody.response_format = trimJsonString(body.response_format);
	}
	if (isJsonString(body.output_format)) {
		upstreamBody.output_format = body.output_format;
	}
	if (streamRequested) upstreamBody.stream = true;
	// Seedream 等兼容扩展：用户显式传入时透传；亦可由 route `custom_params` 注入默认值
	applyOpenAiImageGenerationExtras(upstreamBody, body);

	const pricingContext = await waitForTextRequestRead(c, createImagePricingContext, repos, start);
	const routeRequestFacts = routes.map((route) => ({
		route,
		endpoint: route.endpoint ?? null,
		endpointId: route.endpoint?.id ?? null,
		priceOverrideRaw: route.priceOverrideRaw,
		referenceCount: countRouteImageGenerationReferences(route, upstreamBody),
	}));
	const pricedRouteFacts = await waitForTextRequestRead(c, async () => Promise.all(routeRequestFacts.map(async (facts) => {
		const commonPricing = {
			endpoint: facts.endpoint,
			catalogModelId: baseModelId,
			quality: common.quality ?? 'auto',
			size: common.size ?? 'auto',
			isEdit: false,
			operation: 'generations' as const,
			requestStartedAtMs: start,
			pricingContext,
		};
		const [budgetEstimate, requestEstimate] = await Promise.all([
			estimateImageBudgetPrecheck(repos, {
				...commonPricing,
				userChargedCostFactorsJson: apiKey.chargedCostFactors,
				imageCount: common.n,
				referenceCount: facts.referenceCount,
			}, [facts.priceOverrideRaw]),
			estimateImageBudgetPrecheck(repos, {
				...commonPricing,
				userChargedCostFactorsJson: null,
				imageCount: common.n,
				referenceCount: facts.referenceCount,
			}, [facts.priceOverrideRaw]),
		]);
		return { ...facts, budgetEstimate, requestEstimate };
	})));
	const priceRouting = applyImageProviderPriceRouting(pricedRouteFacts);
	if (!priceRouting.ok) {
		return rejectImageRequest(c, 400, priceRouting.message, {
			operation: 'generations', contentType, contentLength, bodyKeys,
			hasModel: true, clientModel: rawModelId,
		});
	}
	routes = priceRouting.candidates.map((candidate) => candidate.route);
	const selectedRouteRequestFacts = priceRouting.candidates;
	const estimateSelection = selectConservativeMultimediaBudgetEstimate(
		selectedRouteRequestFacts.map(({ budgetEstimate }) => budgetEstimate),
	);
	if (!estimateSelection) {
		throw new Error('Image fallback plan has no billable route estimate');
	}
	const { estimate, estimatedChargedCost, estimatedStandardCost } = estimateSelection;
	if (estimatedChargedCost === null) {
		return rejectImageRequest(c, 502, 'No eligible image route has a provable charged-cost ceiling', {
			operation: 'generations', contentType, contentLength, bodyKeys,
			hasModel: true, clientModel: rawModelId,
		});
	}

	const requestBodyForLog = finalizeRequestLogJson(
		redactImageRequestForLog({
			operation: 'generations',
			model: rawModelId,
			n: common.n,
			size: common.size,
			quality: common.quality,
			background: common.background,
			prompt: common.prompt,
		})
	);

	const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
		baseModelId,
		modelNameForLog,
		requestBodyForLog,
		requestProtocol: 'openai',
		startMs: start,
		timing,
		clientErrorCircuitEnabled: false,
		sessionId,
	});
	if (circuitBlocked) {
		return circuitBlocked;
	}

	const affinityKey = buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'openai');
	const tierKeyPrefix = buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'openai');
	timing.markGatewayComplete();
	assertTextRequestActive(c);
	const recovery = streamRequested && !recoveryFactory?.supportsStreaming ? undefined : recoveryFactory?.({
		requestId:requestCorrelationId,userId:apiKey.userId,apiKeyId:apiKey.keyId,workspaceId:apiKey.workspaceId,
		modelId:baseModelId,operation:'images.generations',expiresAtMs:start+IMAGE_GENERATION_TIMEOUT_MS,
		...(requestSha256 ? { requestSha256 } : {}),
		responseStreamed: streamRequested,
	});
	const budgetAdmission = await createRouteAwareBudgetAdmission(repos, {
		ordinary: {
			requestId: requestCorrelationId,
			userId: apiKey.userId,
			apiKeyId: apiKey.keyId,
			budgetMax: apiKey.budgetMax,
			expectedBudgetEpoch: apiKey.budgetEpoch,
			estimatedChargedCost,
			now: new Date(start),
		},
		guardrail: {
			intents: guardrail.budgetIntents,
			reservedMicros: imageGuardrailBudgetMicros(estimate),
			now: new Date(start),
		},
		privateByokGatewayKey: {
			includeInLimit: apiKey.includeByokInLimit === true,
			reservedMicros: Math.max(
				imageGuardrailBudgetMicros(estimate),
				imageGuardrailBudgetMicros({ chargedCost: estimatedStandardCost ?? Number.POSITIVE_INFINITY }),
			),
		},
	});
	const ordinaryBudgetLease = budgetAdmission.ordinaryLease;
	const guardrailBudgetLease = routeAwareImageGuardrailLease(budgetAdmission);

	console.log(
		`[Gateway Images] generations baseModelId=${baseModelId} keyId=${apiKey.keyId} n=${common.n}`
	);

	let singleGrantFetchAuthorized = false;
	let proxyResult: Awaited<ReturnType<typeof proxyImageGenerations>>;
	try {
		proxyResult = await proxyImageGenerations(repos, routes, upstreamBody, c.req.raw.signal, {
			errorContext: { skin: 'chat', requestId: requestCorrelationId },
			dispatchBudget,
			preparationControl: lifecycle?.deadline,
			affinityKey,
			tierKeyPrefix,
			strategy: selectedPlan.strategy.base,
			tierStrategies: selectedPlan.strategy.tierOverrides,
			timing,
			routePoolId: selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
			sticky: selectedPlan.hasProviderPreferences
				? null
				: stickyConfigFromSurface(selectedPlan.surface),
			stopAfterFirstGrantedDispatch: recovery?.singleCommittedRequestGrant === true,
			beforeUpstreamDispatch: async (route, preparedAttempt) => {
				const checkActive = () => assertTextRequestActive(c);
				await beforeImageRecoveryDispatch(recovery, budgetAdmission, route,
					timing.snapshot().upstreamAttemptCount, checkActive, preparedAttempt,
					requestSha256, {
						signal: lifecycle?.deadline.signal ?? c.req.raw.signal,
						throwIfStopped: checkActive,
					});
				if (recovery?.singleCommittedRequestGrant === true) singleGrantFetchAuthorized = true;
			},
			image: {
				requireAuthoritativeUsage: false,
				fetchImpl: c.get('imageFetch'),
			},
			byok: privateByokContextForApiKey(apiKey),
		});
	} catch (error) {
		if (recovery && imageClaimUncertain(error)) {
			return imageClaimUncertainResponse(c, requestCorrelationId);
		}
		if (recovery?.singleCommittedRequestGrant === true && singleGrantFetchAuthorized) {
			return imageClaimUncertainResponse(c, requestCorrelationId);
		}
		if (recovery?.mayHaveDispatched) throw error;
		await terminateImageGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_failed');
		await terminateImageOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_failed',
		);
		if (recovery?.singleCommittedRequestGrant === true && imageClaimDefinitelyDenied(error)) {
			return imageClaimDeniedResponse(c, requestCorrelationId);
		}
		throw error;
	}
	if (recovery?.singleCommittedRequestGrant === true && !singleGrantFetchAuthorized) {
		return finishImageSingleGrantWithoutDispatch(c, requestCorrelationId,
			proxyResult, ordinaryBudgetLease, guardrailBudgetLease);
	}
	const chosenRouteFacts = selectedRouteRequestFacts.find(({ route, endpointId }) =>
		route.targetId === proxyResult.chosenRoute.targetId
		&& route.providerId === proxyResult.chosenRoute.providerId
		&& endpointId != null
		&& endpointId === proxyResult.chosenRoute.endpoint?.id
		&& route.priceOverrideRaw === proxyResult.chosenRoute.priceOverrideRaw
	);
	if (!chosenRouteFacts) {
		if (recovery?.mayHaveDispatched) {
			await proxyResult.response.body?.cancel('chosen_route_facts_mismatch').catch(() => undefined);
			throw new Error('Durable image dispatch has mismatched route facts');
		}
		await terminateImageGuardrailBudget(guardrailBudgetLease, 'chosen_route_facts_mismatch');
		await terminateImageOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'chosen_route_facts_mismatch',
		);
		throw new Error('Chosen image route does not match its admitted endpoint request facts');
	}
	if (ordinaryBudgetLease.state === 'reserved') {
		await terminateImageOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_not_started',
		);
	}
	if (!guardrailBudgetLease.dispatched) {
		await terminateImageGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_not_started');
	}

	return finalizeImageResponse({
		recovery,
		c,
		proxyResult,
		requestLogId: requestCorrelationId,
		budgetAccountedAt: requestStartedAt.toISOString(),
		guardrailBudgetReserved: guardrailBudgetLease.reserved,
		forfeitGuardrailBudget: (reason) => guardrailBudgetLease.forfeit(reason),
		ordinaryBudgetLease,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		sessionId,
		operation: 'generations',
		billing: {
			endpoint: chosenRouteFacts.endpoint,
			catalogModelId: baseModelId,
			userChargedCostFactorsJson: apiKey.chargedCostFactors,
			routePriceOverrideJson: chosenRouteFacts.priceOverrideRaw,
			quality: common.quality ?? 'auto',
			size: common.size ?? 'auto',
			imageCount: common.n,
			isEdit: false,
			referenceCount: chosenRouteFacts.referenceCount,
			operation: 'generations',
			requestStartedAtMs: start,
			pricingContext,
		},
		budgetPrecheck: estimate,
		clientModelId: rawModelId,
		common,
		multiImageBilling,
		referenceCount: chosenRouteFacts.referenceCount,
		start,
		timing,
	});
}

// OpenRouter's canonical Images generation surface plus the legacy OpenAI alias.
imageRoutes.post('/', handleImageGenerations);
imageRoutes.post('/generations', handleImageGenerations);

imageRoutes.post('/edits', async (c) => {
	const ownedFiles: MultipartFile[] = [];
	try { return await handleImageEdits(c, ownedFiles); }
	finally { for (const file of ownedFiles) file.dispose(); }
});

async function handleImageEdits(c: ImagesContext, ownedFiles: MultipartFile[]): Promise<Response> {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const lifecycle = c.get('textRequestLifecycle');
	const dispatchBudget = lifecycle?.dispatchBudget ?? createRequestDispatchBudget();
	const start = dispatchBudget.createdAtMs;
	assertTextRequestActive(c);
	const requestStartedAt = new Date(start);
	const requestCorrelationId = c.get('generationId')!;
	const timing = new RequestTimingCollector();
	const parsedSession = parseOpenRouterSessionHeader(c.req.raw.headers);
	if (!parsedSession.ok) {
		return rejectImageRequest(c, 400, parsedSession.message, {
			operation: 'edits', bodyKeys: [], hasModel: false,
		});
	}
	const sessionId = parsedSession.sessionId;

	const parsed = await parseMultipartEdits(c, ownedFiles);
	if (!parsed.ok) {
		return rejectImageRequest(c, 400, parsed.error, {
			operation: 'edits',
			...parsed.diag,
		});
	}
	const { model: rawModelId, totalUploadBytes } = parsed;
	const recoveryFactory = c.get('imageUsageRecovery');
	const requestSha256 = recoveryFactory?.requiresTrustedIngressDigest === true
		? await withImageIngressDigestControl(c, start, control =>
			digestTrustedImageEditIngress({
				model: parsed.model, provider: parsed.provider, edit: parsed.edit, sessionId, control,
			}))
		: undefined;
	let edit = parsed.edit;
	edit.releaseAcceptedUpload = () => { for (const file of ownedFiles) file.dispose(); };

	const guardrail = await runRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelIds: [rawModelId],
		body: imageEditGuardrailBody(rawModelId, edit),
		correlationId: requestCorrelationId,
		now: requestStartedAt,
		control: lifecycle?.deadline,
	});
	if (!guardrail.ok) {
		return gatewayErrorJson(c, {
			status: guardrail.status,
			code: guardrail.code === 'guardrail_invalid'
				? GatewayErrorCode.guardrailInvalid
				: GatewayErrorCode.guardrailBlocked,
			message: guardrail.message,
		});
	}
	const guardedPrompt = guardrail.body.prompt;
	if (typeof guardedPrompt !== 'string') {
		return rejectImageRequest(c, 400, 'Guardrail produced an invalid image prompt', {
			operation: 'edits', hasModel: true, clientModel: rawModelId,
			referenceCount: edit.images.length, totalUploadBytes,
		});
	}
	edit = { ...edit, prompt: guardedPrompt };
	const outputGuardrailRejection = await failClosedForImageOutputGuardrail(
		c, repos, apiKey, rawModelId, requestCorrelationId, guardrail,
	);
	assertTextRequestActive(c);
	if (outputGuardrailRejection) return outputGuardrailRejection;

	const fallbackPlan = await waitForTextRequestRead(c, buildModelFallbackPlan, repos, {
		modelIds: [rawModelId],
		body: parsed.provider
			? { ...guardrail.body, provider: parsed.provider }
			: guardrail.body,
		requestProtocol: 'openai',
		requestOperation: 'images.edits',
		pricingAt: requestStartedAt,
		control: lifecycle?.deadline,
	});
	if (!fallbackPlan.ok) {
		return rejectImageRequest(c, fallbackPlan.status, fallbackPlan.message, {
			operation: 'edits',
			contentType: c.req.header('content-type') ?? null,
			contentLength: c.req.header('content-length') ?? null,
			hasModel: true,
			clientModel: rawModelId,
			promptChars: edit.prompt.length,
			referenceCount: edit.images.length,
			totalUploadBytes,
		});
	}
	const selectedPlan = fallbackPlan.candidates[0]!;
	const { model, baseModelId, effectiveRouteGroup } = selectedPlan;
	let routes = selectedPlan.routes;
	let multiImageBilling: ReturnType<typeof multipleImageBillingMode> = null;
	if (edit.n > 1) {
		routes = routes.filter((route) => imageRouteSupportsParameter(route, 'n', edit.n));
		if (routes.length === 0) {
			return rejectImageRequest(c, 400, 'No configured endpoint proves support for n > 1', {
				operation: 'edits', hasModel: true, clientModel: rawModelId,
				referenceCount: edit.images.length, totalUploadBytes,
			});
		}
		multiImageBilling = 'per_image';
	}
	const modelNameForLog = modelDisplayName(model, baseModelId);

	const pricingContext = await waitForTextRequestRead(c, createImagePricingContext, repos, start);
	const routeRequestFacts = routes.map((route) => ({
		route,
		endpoint: route.endpoint ?? null,
		endpointId: route.endpoint?.id ?? null,
		priceOverrideRaw: route.priceOverrideRaw,
		// Multipart reference files are appended after route defaults; the driver
		// explicitly ignores custom `image`/`images` fields.
		referenceCount: edit.images.length,
	}));
	const pricedRouteFacts = await waitForTextRequestRead(c, async () => Promise.all(routeRequestFacts.map(async (facts) => {
		const commonPricing = {
			endpoint: facts.endpoint,
			catalogModelId: baseModelId,
			quality: edit.quality ?? 'auto',
			size: edit.size ?? 'auto',
			isEdit: true,
			operation: 'edits' as const,
			requestStartedAtMs: start,
			pricingContext,
		};
		const [budgetEstimate, requestEstimate] = await Promise.all([
			estimateImageBudgetPrecheck(repos, {
				...commonPricing,
				userChargedCostFactorsJson: apiKey.chargedCostFactors,
				imageCount: edit.n,
				referenceCount: facts.referenceCount,
			}, [facts.priceOverrideRaw]),
			estimateImageBudgetPrecheck(repos, {
				...commonPricing,
				userChargedCostFactorsJson: null,
				imageCount: edit.n,
				referenceCount: facts.referenceCount,
			}, [facts.priceOverrideRaw]),
		]);
		return { ...facts, budgetEstimate, requestEstimate };
	})));
	const priceRouting = applyImageProviderPriceRouting(pricedRouteFacts);
	if (!priceRouting.ok) {
		return rejectImageRequest(c, 400, priceRouting.message, {
			operation: 'edits', hasModel: true, clientModel: rawModelId,
			referenceCount: edit.images.length, totalUploadBytes,
		});
	}
	routes = priceRouting.candidates.map((candidate) => candidate.route);
	const selectedRouteRequestFacts = priceRouting.candidates;
	const estimateSelection = selectConservativeMultimediaBudgetEstimate(
		selectedRouteRequestFacts.map(({ budgetEstimate }) => budgetEstimate),
	);
	if (!estimateSelection) {
		throw new Error('Image fallback plan has no billable route estimate');
	}
	const { estimate, estimatedChargedCost, estimatedStandardCost } = estimateSelection;
	if (estimatedChargedCost === null) {
		return rejectImageRequest(c, 502, 'No eligible image route has a provable charged-cost ceiling', {
			operation: 'edits', hasModel: true, clientModel: rawModelId,
			referenceCount: edit.images.length, totalUploadBytes,
		});
	}

	const requestBodyForLog = finalizeRequestLogJson(
		redactImageRequestForLog({
			operation: 'edits',
			model: rawModelId,
			n: edit.n,
			size: edit.size,
			quality: edit.quality,
			background: edit.background,
			prompt: edit.prompt,
			referenceCount: edit.images.length,
		})
	);

	const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
		baseModelId,
		modelNameForLog,
		requestBodyForLog,
		requestProtocol: 'openai',
		startMs: start,
		timing,
		clientErrorCircuitEnabled: false,
		sessionId,
	});
	if (circuitBlocked) {
		return circuitBlocked;
	}

	const affinityKey = buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'openai');
	const tierKeyPrefix = buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'openai');
	timing.markGatewayComplete();
	assertTextRequestActive(c);
	const recovery = recoveryFactory?.({
		requestId:requestCorrelationId,userId:apiKey.userId,apiKeyId:apiKey.keyId,workspaceId:apiKey.workspaceId,
		modelId:baseModelId,operation:'images.edits',expiresAtMs:start+IMAGE_GENERATION_TIMEOUT_MS,
		...(requestSha256 ? { requestSha256 } : {}),
	});
	const budgetAdmission = await createRouteAwareBudgetAdmission(repos, {
		ordinary: {
			requestId: requestCorrelationId,
			userId: apiKey.userId,
			apiKeyId: apiKey.keyId,
			budgetMax: apiKey.budgetMax,
			expectedBudgetEpoch: apiKey.budgetEpoch,
			estimatedChargedCost,
			now: new Date(start),
		},
		guardrail: {
			intents: guardrail.budgetIntents,
			reservedMicros: imageGuardrailBudgetMicros(estimate),
			now: new Date(start),
		},
		privateByokGatewayKey: {
			includeInLimit: apiKey.includeByokInLimit === true,
			reservedMicros: Math.max(
				imageGuardrailBudgetMicros(estimate),
				imageGuardrailBudgetMicros({ chargedCost: estimatedStandardCost ?? Number.POSITIVE_INFINITY }),
			),
		},
	});
	const ordinaryBudgetLease = budgetAdmission.ordinaryLease;
	const guardrailBudgetLease = routeAwareImageGuardrailLease(budgetAdmission);

	console.log(
		`[Gateway Images] edits baseModelId=${baseModelId} keyId=${apiKey.keyId} refs=${edit.images.length}`
	);

	let singleGrantFetchAuthorized = false;
	let proxyResult: Awaited<ReturnType<typeof proxyImageEdits>>;
	try {
		proxyResult = await proxyImageEdits(repos, routes, edit, c.req.raw.signal, {
			image: { fetchImpl: c.get('imageFetch') },
			errorContext: { skin: 'chat', requestId: requestCorrelationId },
			dispatchBudget,
			preparationControl: lifecycle?.deadline,
			affinityKey,
			tierKeyPrefix,
			strategy: selectedPlan.strategy.base,
			tierStrategies: selectedPlan.strategy.tierOverrides,
			timing,
			routePoolId: selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
			sticky: selectedPlan.hasProviderPreferences
				? null
				: stickyConfigFromSurface(selectedPlan.surface),
			stopAfterFirstGrantedDispatch: recovery?.singleCommittedRequestGrant === true,
			beforeUpstreamDispatch: async (route, preparedAttempt) => {
				const checkActive = () => assertTextRequestActive(c);
				await beforeImageRecoveryDispatch(recovery, budgetAdmission, route,
					timing.snapshot().upstreamAttemptCount, checkActive, preparedAttempt,
					requestSha256, {
						signal: lifecycle?.deadline.signal ?? c.req.raw.signal,
						throwIfStopped: checkActive,
					});
				if (recovery?.singleCommittedRequestGrant === true) singleGrantFetchAuthorized = true;
			},
			byok: privateByokContextForApiKey(apiKey),
		});
	} catch (error) {
		if (recovery && imageClaimUncertain(error)) {
			return imageClaimUncertainResponse(c, requestCorrelationId);
		}
		if (recovery?.singleCommittedRequestGrant === true && singleGrantFetchAuthorized) {
			return imageClaimUncertainResponse(c, requestCorrelationId);
		}
		if (recovery?.mayHaveDispatched) throw error;
		await terminateImageGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_failed');
		await terminateImageOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_failed',
		);
		if (recovery?.singleCommittedRequestGrant === true && imageClaimDefinitelyDenied(error)) {
			return imageClaimDeniedResponse(c, requestCorrelationId);
		}
		throw error;
	}
	if (recovery?.singleCommittedRequestGrant === true && !singleGrantFetchAuthorized) {
		return finishImageSingleGrantWithoutDispatch(c, requestCorrelationId,
			proxyResult, ordinaryBudgetLease, guardrailBudgetLease);
	}
	const chosenRouteFacts = selectedRouteRequestFacts.find(({ route, endpointId }) =>
		route.targetId === proxyResult.chosenRoute.targetId
		&& route.providerId === proxyResult.chosenRoute.providerId
		&& endpointId != null
		&& endpointId === proxyResult.chosenRoute.endpoint?.id
		&& route.priceOverrideRaw === proxyResult.chosenRoute.priceOverrideRaw
	);
	if (!chosenRouteFacts) {
		if (recovery?.mayHaveDispatched) {
			await proxyResult.response.body?.cancel('chosen_route_facts_mismatch').catch(() => undefined);
			throw new Error('Durable image dispatch has mismatched route facts');
		}
		await terminateImageGuardrailBudget(guardrailBudgetLease, 'chosen_route_facts_mismatch');
		await terminateImageOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'chosen_route_facts_mismatch',
		);
		throw new Error('Chosen image edit route does not match its admitted endpoint request facts');
	}
	if (ordinaryBudgetLease.state === 'reserved') {
		await terminateImageOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_not_started',
		);
	}
	if (!guardrailBudgetLease.dispatched) {
		await terminateImageGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_not_started');
	}

	return finalizeImageResponse({
		recovery,
		c,
		proxyResult,
		requestLogId: requestCorrelationId,
		budgetAccountedAt: requestStartedAt.toISOString(),
		guardrailBudgetReserved: guardrailBudgetLease.reserved,
		forfeitGuardrailBudget: (reason) => guardrailBudgetLease.forfeit(reason),
		ordinaryBudgetLease,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		sessionId,
		operation: 'edits',
		billing: {
			endpoint: chosenRouteFacts.endpoint,
			catalogModelId: baseModelId,
			userChargedCostFactorsJson: apiKey.chargedCostFactors,
			routePriceOverrideJson: chosenRouteFacts.priceOverrideRaw,
			quality: edit.quality ?? 'auto',
			size: edit.size ?? 'auto',
			imageCount: edit.n,
			isEdit: true,
			referenceCount: chosenRouteFacts.referenceCount,
			operation: 'edits',
			requestStartedAtMs: start,
			pricingContext,
		},
		budgetPrecheck: estimate,
		clientModelId: rawModelId,
		common: {
			prompt: edit.prompt,
			n: edit.n,
			size: edit.size,
			quality: edit.quality,
			background: edit.background,
		},
		multiImageBilling,
		referenceCount: chosenRouteFacts.referenceCount,
		start,
		timing,
	});
}
