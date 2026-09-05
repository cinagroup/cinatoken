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
	type ImageBillingParams,
	type ImageCostBreakdown,
} from '../../services/image-usage-charge';
import { applyOpenAiImageGenerationExtras, countOpenAiGenerationReferenceImages } from '../../services/image-generation-extras';
import {
	countValidImageResults,
	IMAGE_MAX_BYTES_PER_FILE,
	IMAGE_MAX_REFERENCE_COUNT,
	IMAGE_MAX_TOTAL_UPLOAD_BYTES,
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
} from '../../services/request-budget-admission';

type ImagesEnv = Env & { Variables: { apiKey: ApiKeyContext } };
type ImagesContext = Context<ImagesEnv>;

export const imageRoutes = new Hono<ImagesEnv>();

imageRoutes.use('*', requireApiKey);
imageRoutes.use('*', assignGenerationId);

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
			if (typeof value === 'string') return `${key}:string`;
			if (typeof value === 'number' || typeof value === 'boolean') return `${key}:${typeof value}`;
			if (Array.isArray(value)) {
				const first = value[0];
				const itemType =
					first == null
						? 'empty'
						: typeof first === 'object' && first !== null && 'arrayBuffer' in first
							? 'file'
							: typeof first;
				return `${key}:array(${value.length},${itemType})`;
			}
			if (typeof value === 'object' && 'arrayBuffer' in value) return `${key}:file`;
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
	}).catch((error: unknown) => {
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

async function parseMultipartEdits(c: ImagesContext): Promise<MultipartEditsParseResult> {
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
		body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
	} catch {
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
		// Hono File / Blob：先按 size 预检再读入，避免无界 arrayBuffer
		if (typeof value === 'object' && value !== null && 'arrayBuffer' in value) {
			const file = value as File;
			const declaredSize =
				typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : null;
			if (declaredSize != null) {
				if (declaredSize > IMAGE_MAX_BYTES_PER_FILE) {
					return `each image must be at most ${IMAGE_MAX_BYTES_PER_FILE} bytes`;
				}
				if (totalBytes + declaredSize > IMAGE_MAX_TOTAL_UPLOAD_BYTES) {
					return `total image upload must be at most ${IMAGE_MAX_TOTAL_UPLOAD_BYTES} bytes`;
				}
			}
			const buf = new Uint8Array(await file.arrayBuffer());
			if (buf.byteLength > IMAGE_MAX_BYTES_PER_FILE) {
				return `each image must be at most ${IMAGE_MAX_BYTES_PER_FILE} bytes`;
			}
			if (totalBytes + buf.byteLength > IMAGE_MAX_TOTAL_UPLOAD_BYTES) {
				return `total image upload must be at most ${IMAGE_MAX_TOTAL_UPLOAD_BYTES} bytes`;
			}
			totalBytes += buf.byteLength;
			images.push({
				filename: (file as { name?: string }).name || fallbackName,
				mimeType: file.type || 'application/octet-stream',
				bytes: buf,
			});
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
	/** 入口预算预检（客户端取消时按此金额扣费） */
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

	scheduleBackgroundWork(
		c,
		(async () => {
			const outcome = await settlement;
			const status: 'success' | 'error' = outcome.completed && outcome.done
				? 'success'
				: 'error';
			if (status === 'success') markUserModelSuccess(apiKey.userId, baseModelId);
			const imageAbortReason = outcome.imageAbortReason
				?? (outcome.cancelled ? 'client_abort' : null);
			const stickyTraceSnapshot = stickyTrace ? await stickyTrace() : null;
			await recordImageUsage({
				repos,
				requestLogId,
				budgetAccountedAt,
				guardrailBudgetSettlement: guardrailBudgetReserved
					? { requestId: requestLogId }
					: undefined,
				ordinaryBudgetSettlement:
					ordinaryBudgetLease.reserved && ordinaryBudgetLease.state === 'dispatched'
						? {
								requestId: requestLogId,
								budgetEpoch: ordinaryBudgetLease.budgetEpoch!,
								reservedMicros: ordinaryBudgetLease.reservedMicros,
								unknownCost: false,
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
				clientOutcomeBillable: status === 'success',
				upstreamSupplierCostUsdTicks: outcome.upstreamSupplierCostUsdTicks,
				providerKeyId: chosenRoute.providerKeyId ?? null,
				providerKeyLabel: chosenRoute.providerKeyLabel ?? null,
				providerKeyFingerprint: chosenRoute.providerKeyFingerprint ?? null,
				upstreamRequestId,
				timing: timing.snapshot(),
				circuitEvents: circuitEvents.length > 0 ? circuitEvents : undefined,
				suppressErrorAlert: suppressErrorAlert || undefined,
			});
		})().catch(async (err) => {
			console.error(
				`[Gateway Images] stream settlement failed baseModelId=${baseModelId} keyId=${apiKey.keyId} clientModel=${clientModelId} error=${err instanceof Error ? err.message : String(err)}`,
			);
			await forfeitGuardrailBudget('image_stream_settlement_failed');
			await terminateImageOrdinaryBudget(
				ordinaryBudgetLease,
				requestLogId,
				'image_stream_settlement_failed',
			);
		}),
	);
	return proxyResult.response;
}

/**
 * generations / edits 共用：materialize → 用量/状态 → 后台记费 → 统一响应。
 * 优先消费 driver 经 failover 透传的 `meta.parsedBody` / `meta.imageUsage`，避免重复 JSON.parse。
 */
async function finalizeImageResponse(params: FinalizeImageParams): Promise<Response> {
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
		return finalizeImageStreamResponse(params, proxyResult.meta.imageStreamSettlement);
	}
	if (stickyMutationPromise) {
		scheduleBackgroundWork(c, stickyMutationPromise);
	}
	const { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response).catch(
		async (error: unknown) => {
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
		|| (response.ok && usageUnavailable)
		|| imageAbortReason === 'client_abort'
		|| imageAbortReason === 'gateway_timeout';
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

	let responseText: string;
	try {
		if (errorBodyText != null) {
			responseText = errorBodyText;
		} else if (parsedBody !== null && parsedBody !== undefined) {
			responseText = JSON.stringify(parsedBody);
		} else {
			responseText = await response.clone().text();
		}
	} catch (error) {
		await forfeitGuardrailBudget('upstream_response_decode_failed');
		await terminateImageOrdinaryBudget(
			ordinaryBudgetLease,
			requestLogId,
			'upstream_response_decode_failed',
		);
		throw error;
	}

	let userModelCircuitEvent = null;
	if (!response.ok && errorBodyText != null) {
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

	scheduleBackgroundWork(
		c,
		(async () => {
			const stickyTraceSnapshot = stickyTrace ? await stickyTrace() : null;
			await recordImageUsage({
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
			});
		})().catch(async (err) => {
			console.error(
				`[Gateway Images] recordImageUsage failed baseModelId=${baseModelId} keyId=${apiKey.keyId} clientModel=${clientModelId} error=${err instanceof Error ? err.message : String(err)}`
			);
			await forfeitGuardrailBudget('image_usage_settlement_failed');
			await terminateImageOrdinaryBudget(
				ordinaryBudgetLease,
				requestLogId,
				'image_usage_settlement_failed',
			);
		})
	);

	if (status === 'success') {
		return new Response(responseText, {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	if (response.ok && validImages === 0) {
		return gatewayErrorJson(c, {
			status: 502,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: 'Upstream returned no image data',
		});
	}
	if (missingMultiImageTokenUsage) {
		return gatewayErrorJson(c, {
			status: 502,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: 'Multiple-image generation completed without authoritative usage',
		});
	}
	return new Response(responseText, {
		status: response.status >= 400 && response.status < 600 ? response.status : 502,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function handleImageGenerations(c: ImagesContext): Promise<Response> {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const start = Date.now();
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
		body = await c.req.json();
	} catch {
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

	const initialCommon = normalizeImageCommonParams({
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
			promptChars: typeof body.prompt === 'string' ? body.prompt.length : 0,
		});
	}
	if (body.stream !== undefined && typeof body.stream !== 'boolean') {
		return rejectImageRequest(c, 400, 'stream must be a boolean', {
			operation: 'generations', contentType, contentLength, bodyKeys,
			hasModel: true, clientModel: rawModelId,
		});
	}

	const guardrail = await runRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelIds: [rawModelId],
		body: imageGenerationGuardrailBody(rawModelId, initialCommon),
		correlationId: requestCorrelationId,
		now: requestStartedAt,
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
	if (outputGuardrailRejection) return outputGuardrailRejection;

	const fallbackPlan = await buildModelFallbackPlan(repos, {
		modelIds: [rawModelId],
		body,
		requestProtocol: 'openai',
		requestOperation: 'images.generations',
		pricingAt: requestStartedAt,
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
	if (typeof body.response_format === 'string' && body.response_format.trim() !== '') {
		upstreamBody.response_format = body.response_format.trim();
	}
	if (typeof body.output_format === 'string') {
		upstreamBody.output_format = body.output_format;
	}
	if (streamRequested) upstreamBody.stream = true;
	// Seedream 等兼容扩展：用户显式传入时透传；亦可由 route `custom_params` 注入默认值
	applyOpenAiImageGenerationExtras(upstreamBody, body);

	const pricingContext = await createImagePricingContext(repos, start);
	const routeRequestFacts = routes.map((route) => ({
		route,
		endpoint: route.endpoint ?? null,
		endpointId: route.endpoint?.id ?? null,
		priceOverrideRaw: route.priceOverrideRaw,
		referenceCount: countRouteImageGenerationReferences(route, upstreamBody),
	}));
	const pricedRouteFacts = await Promise.all(routeRequestFacts.map(async (facts) => {
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
	}));
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

	let proxyResult: Awaited<ReturnType<typeof proxyImageGenerations>>;
	try {
		proxyResult = await proxyImageGenerations(repos, routes, upstreamBody, c.req.raw.signal, {
			affinityKey,
			tierKeyPrefix,
			strategy: selectedPlan.strategy.base,
			tierStrategies: selectedPlan.strategy.tierOverrides,
			timing,
			routePoolId: selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
			sticky: selectedPlan.hasProviderPreferences
				? null
				: stickyConfigFromSurface(selectedPlan.surface),
			beforeUpstreamDispatch: (route) => budgetAdmission.beforeUpstreamDispatch(route),
			image: {
				requireAuthoritativeUsage: false,
			},
			byok: privateByokContextForApiKey(apiKey),
		});
	} catch (error) {
		await terminateImageGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_failed');
		await terminateImageOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_failed',
		);
		throw error;
	}
	const chosenRouteFacts = selectedRouteRequestFacts.find(({ route, endpointId }) =>
		route.targetId === proxyResult.chosenRoute.targetId
		&& route.providerId === proxyResult.chosenRoute.providerId
		&& endpointId != null
		&& endpointId === proxyResult.chosenRoute.endpoint?.id
		&& route.priceOverrideRaw === proxyResult.chosenRoute.priceOverrideRaw
	);
	if (!chosenRouteFacts) {
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
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const start = Date.now();
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

	const parsed = await parseMultipartEdits(c);
	if (!parsed.ok) {
		return rejectImageRequest(c, 400, parsed.error, {
			operation: 'edits',
			...parsed.diag,
		});
	}
	const { model: rawModelId, totalUploadBytes } = parsed;
	let edit = parsed.edit;

	const guardrail = await runRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelIds: [rawModelId],
		body: imageEditGuardrailBody(rawModelId, edit),
		correlationId: requestCorrelationId,
		now: requestStartedAt,
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
	if (outputGuardrailRejection) return outputGuardrailRejection;

	const fallbackPlan = await buildModelFallbackPlan(repos, {
		modelIds: [rawModelId],
		body: parsed.provider
			? { ...guardrail.body, provider: parsed.provider }
			: guardrail.body,
		requestProtocol: 'openai',
		requestOperation: 'images.edits',
		pricingAt: requestStartedAt,
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

	const pricingContext = await createImagePricingContext(repos, start);
	const routeRequestFacts = routes.map((route) => ({
		route,
		endpoint: route.endpoint ?? null,
		endpointId: route.endpoint?.id ?? null,
		priceOverrideRaw: route.priceOverrideRaw,
		// Multipart reference files are appended after route defaults; the driver
		// explicitly ignores custom `image`/`images` fields.
		referenceCount: edit.images.length,
	}));
	const pricedRouteFacts = await Promise.all(routeRequestFacts.map(async (facts) => {
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
	}));
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

	let proxyResult: Awaited<ReturnType<typeof proxyImageEdits>>;
	try {
		proxyResult = await proxyImageEdits(repos, routes, edit, c.req.raw.signal, {
			affinityKey,
			tierKeyPrefix,
			strategy: selectedPlan.strategy.base,
			tierStrategies: selectedPlan.strategy.tierOverrides,
			timing,
			routePoolId: selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
			sticky: selectedPlan.hasProviderPreferences
				? null
				: stickyConfigFromSurface(selectedPlan.surface),
			beforeUpstreamDispatch: (route) => budgetAdmission.beforeUpstreamDispatch(route),
			byok: privateByokContextForApiKey(apiKey),
		});
	} catch (error) {
		await terminateImageGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_failed');
		await terminateImageOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_dispatch_failed',
		);
		throw error;
	}
	const chosenRouteFacts = selectedRouteRequestFacts.find(({ route, endpointId }) =>
		route.targetId === proxyResult.chosenRoute.targetId
		&& route.providerId === proxyResult.chosenRoute.providerId
		&& endpointId != null
		&& endpointId === proxyResult.chosenRoute.endpoint?.id
		&& route.priceOverrideRaw === proxyResult.chosenRoute.priceOverrideRaw
	);
	if (!chosenRouteFacts) {
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
});
