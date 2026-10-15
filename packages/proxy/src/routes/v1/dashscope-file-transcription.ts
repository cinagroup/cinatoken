import { assertSharedKeyEncryptionSecret } from '@octafuse/core';
import {
	prepareNativeMediaPolicy,
	admitNativeMediaRequest,
	readNativeMediaJson,
} from '../../services/native-media-request-context';
import { signNativeAsyncTaskReceipt, verifyNativeAsyncTaskReceipt } from '../../services/native-async-task-receipt';
import { estimateAudioBudgetPrecheck } from '../../services/audio-usage-charge';
import { MAX_AUDIO_DURATION_SECONDS } from '../../services/egress/audio-duration';
import { scheduleResourceCompletion } from '../../runtime/schedule-resource-completion';
/**
 * DashScope 异步文件转写透传。
 * `POST /v1/dashscope/services/audio/asr/transcription` 提交任务。
 * `GET /v1/dashscope/tasks/:taskId?model=` 查询任务；成功时按结果里的时长计费，响应仍是任务 JSON。
 */
import { isAudioTranscriptionModel, type ModelRow } from '@octafuse/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../app';
import { requireApiKey, type ApiKeyContext } from '../../middleware/auth';
import { resolveRoutesForSurface, type RouteResult } from '../../services/model-router';
import { resolveModelRouting } from '../../services/resolve-model-route-group';
import { buildAffinityKey, buildTierKeyPrefix, resolveRouteStrategyPlan } from '../../services/route-strategies';
import { proxyDashScopeJsonPassthrough } from '../../services/proxy';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import { recordAudioUsage } from '../../services/audio-usage-charge';
import { apiKeyHasBalance } from '../../services/tool-usage-charge';
import { formatHttpErrorTextForRequestLog, materializeNonOkResponse } from '../../services/request-log-record-status';
import {
	maybeBlockUserModelCircuit,
	maybeTriggerUserModelCircuitFromUpstream,
	markUserModelSuccess,
} from '../../services/user-model-circuit-route';
import { GatewayErrorCode, NO_AVAILABLE_ROUTE_MESSAGE } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { RequestTimingCollector } from '../../services/request-timing';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';

type AsyncEnv = Env & { Variables: { apiKey: ApiKeyContext } };

export const dashScopeFileTranscriptionRoutes = new Hono<AsyncEnv>();
export const dashScopeTaskRoutes = new Hono<AsyncEnv>();

dashScopeFileTranscriptionRoutes.use('*', requireApiKey);
dashScopeTaskRoutes.use('*', requireApiKey);

dashScopeFileTranscriptionRoutes.post('/', async (c) => {
	let body: unknown;
	try {
		body = await readNativeMediaJson(c);
	} catch {
		return gatewayErrorJson(c, { status: 400, code: GatewayErrorCode.invalidJson, message: 'Invalid JSON body' });
	}
	if (body == null || typeof body !== 'object' || Array.isArray(body)) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'JSON body must be an object',
		});
	}
	const requestBody = body as Record<string, unknown>;
	const rawModelId = typeof requestBody.model === 'string' ? requestBody.model.trim() : '';
	if (!rawModelId) {
		return gatewayErrorJson(c, { status: 400, code: GatewayErrorCode.invalidRequest, message: 'Missing model' });
	}
	return runAsyncPassthrough(c, rawModelId, requestBody, null);
});

dashScopeTaskRoutes.get('/:taskId', async (c) => {
	const rawModelId = c.req.query('model')?.trim() ?? '';
	if (!rawModelId) {
		return gatewayErrorJson(c, { status: 400, code: GatewayErrorCode.invalidRequest, message: 'Missing model' });
	}
	const taskId = c.req.param('taskId')?.trim() ?? '';
	if (!taskId) {
		return gatewayErrorJson(c, { status: 400, code: GatewayErrorCode.invalidRequest, message: 'Missing task id' });
	}
	return runAsyncPassthrough(c, rawModelId, { model: rawModelId, task_id: taskId }, taskId);
});

async function runAsyncPassthrough(
	c: Context<AsyncEnv>,
	rawModelId: string,
	requestBody: Record<string, unknown>,
	taskId: string | null,
): Promise<Response> {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const start = Date.now();
	const timing = new RequestTimingCollector();
	const preview = await resolveModelRouting(repos, rawModelId);
	if (!preview) {
		return gatewayErrorJson(c, {
			status: 404,
			code: GatewayErrorCode.modelNotFound,
			message: `Model not found: ${rawModelId.slice(0, 200)}`,
		});
	}
	if (!isAudioTranscriptionModel(preview.model)) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'DashScope file transcription passthrough requires a transcription model',
		});
	}
	const { model, baseModelId, explicitGroup } = preview;
	const effectiveRouteGroup = explicitGroup?.trim() || 'default';
	const receipt = taskId
		? await verifyNativeAsyncTaskReceipt(
				c.req.header('X-CinaToken-Task-Receipt') ?? c.req.query('receipt'),
				c.env.SHARED_KEY_ENCRYPTION_SECRET,
				apiKey,
				taskId,
			)
		: null;
	if (taskId && (!receipt || receipt.modelId !== baseModelId || receipt.routeGroup !== effectiveRouteGroup))
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.authFailed,
			message: 'A valid task receipt for this workspace and key is required',
		});
	try {
		assertSharedKeyEncryptionSecret(c.env.SHARED_KEY_ENCRYPTION_SECRET);
	} catch {
		return gatewayErrorJson(c, {
			status: 503,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: 'Native async task receipts are unavailable',
		});
	}
	const policy = await prepareNativeMediaPolicy(c, {
		rawModelId,
		body: requestBody,
		protocol: 'dashscope',
		operation: 'audio.transcriptions.async',
		start,
	});
	if (policy instanceof Response) return policy;
	requestBody = policy.body;
	const routes = receipt
		? policy.selected.routes.filter(
				(route) =>
					route.targetId === receipt.targetId &&
					route.providerId === receipt.providerId &&
					(route.providerKeyId ?? null) === receipt.providerKeyId,
			)
		: policy.selected.routes;
	if (!routes.length)
		return gatewayErrorJson(c, {
			status: 409,
			code: GatewayErrorCode.noRoute,
			message: 'The task route is no longer available',
		});
	const poolStrategy = policy.selected.surface?.pool_strategy ?? null;
	const poolTierStrategies = policy.selected.surface?.pool_tier_strategies ?? null;
	const stickySurface = policy.selected.surface;
	const urls = (requestBody.input as { file_urls?: unknown } | undefined)?.file_urls;
	if (
		!taskId &&
		(!Array.isArray(urls) ||
			urls.length < 1 ||
			urls.length > 20 ||
			urls.some((url) => typeof url !== 'string' || !/^https?:\/\//i.test(url)))
	)
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'input.file_urls must contain 1–20 HTTP(S) audio URLs',
		});
	const fileCount = Array.isArray(urls) ? urls.length : 1;
	const unitEstimate = await estimateAudioBudgetPrecheck(
		repos,
		{
			modelPricingProfileJson: model.pricing_profile ?? null,
			catalogModelId: baseModelId,
			userChargedCostFactorsJson: apiKey.chargedCostFactors,
			routeGroup: effectiveRouteGroup,
			fileBytes: 0,
			verifiedDurationCeilingSeconds: MAX_AUDIO_DURATION_SECONDS,
			requestStartedAtMs: start,
		},
		routes.map((route) => route.priceOverrideRaw),
	);
	const estimate = {
		...unitEstimate,
		chargedCost: unitEstimate.chargedCost * fileCount,
		standardCost: unitEstimate.standardCost * fileCount,
		byokStandardCostCeiling: (unitEstimate.byokStandardCostCeiling ?? unitEstimate.standardCost) * fileCount,
	};
	const nativeRequest = taskId ? null : await admitNativeMediaRequest(c, policy, estimate);

	if (!taskId && !apiKeyHasBalance(apiKey)) {
		return gatewayErrorJson(c, { status: 403, code: GatewayErrorCode.budgetExceeded, message: 'Budget exceeded' });
	}
	const modelNameForLog = displayName(model, baseModelId);
	const requestBodyForLog = finalizeRequestLogJson(requestBody);
	const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
		baseModelId,
		modelNameForLog,
		requestBodyForLog,
		requestProtocol: 'dashscope',
		startMs: start,
		timing,
		clientErrorCircuitEnabled: false,
	});
	if (circuitBlocked) return circuitBlocked;
	const strategyPlan = await resolveRouteStrategyPlan({
		routePolicyRaw: model.route_policy ?? null,
		poolStrategy,
		poolTierStrategies,
		protocol: 'dashscope',
		capability: taskId ? 'audio.transcriptions.tasks' : 'audio.transcriptions',
		routeGroup: effectiveRouteGroup,
		repos,
	});
	timing.markGatewayComplete();
	const dispatch = () =>
		proxyDashScopeJsonPassthrough(
			repos,
			routes,
			'audio.transcriptions.async',
			taskId ? null : requestBody,
			c.req.raw.signal,
			{
				affinityKey: buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'dashscope'),
				tierKeyPrefix: buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'dashscope'),
				strategy: strategyPlan.base,
				tierStrategies: strategyPlan.tierOverrides,
				timing,
				sticky: stickyConfigFromSurface(stickySurface),
				inboundHeaders: c.req.raw.headers,
				...(nativeRequest?.options ?? {
					registerResourceCompletion: (task: import('../../services/resource-completion').ResourceCompletion) =>
						scheduleResourceCompletion(c, task),
				}),
				dashScopeJson: {
					taskId,
					asyncHeader: c.req.header('X-DashScope-Async'),
				},
			},
		);
	const proxyResult = nativeRequest ? await nativeRequest.dispatch(dispatch) : await dispatch();
	let { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response);
	if (taskId) {
		if (proxyResult.stickyMutationPromise) scheduleBackgroundWork(c, proxyResult.stickyMutationPromise);
		const headers = new Headers(response.headers);
		headers.set('X-CinaToken-Request-Id', receipt!.requestLogId);
		headers.set('X-CinaToken-Settlement-Basis', 'reserved');
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	}
	if (response.ok) markUserModelSuccess(apiKey.userId, baseModelId);
	const userModelCircuitEvent =
		!response.ok && errorBodyText != null
			? maybeTriggerUserModelCircuitFromUpstream(
					apiKey.userId,
					baseModelId,
					response.status,
					response.headers.get('content-type'),
					errorBodyText,
					formatHttpErrorTextForRequestLog(response.status, response.headers.get('content-type'), errorBodyText),
					{ clientErrorCircuitEnabled: false },
				)
			: null;
	const alertCircuitEvents = userModelCircuitEvent
		? [...proxyResult.circuitEvents, userModelCircuitEvent]
		: proxyResult.circuitEvents;
	const status = response.ok ? 'success' : 'error';
	const meta = proxyResult.meta;
	await (async () => {
		const stickyTraceSnapshot = proxyResult.stickyTrace ? await proxyResult.stickyTrace() : null;
		await recordAudioUsage({
			repos,
			...nativeRequest!.settlement(proxyResult, response.ok || proxyResult.meta?.upstreamOutcomeUnknown === true),
			apiKeyId: apiKey.keyId,
			workspaceId: apiKey.workspaceId,
			userId: apiKey.userId,
			userEmail: apiKey.userEmail,
			ingressHost: apiKey.ingressHost,
			modelId: baseModelId,
			providerId: proxyResult.chosenRoute.providerId,
			providerModelName: proxyResult.chosenRoute.providerModelName,
			modelName: modelNameForLog,
			providerName: proxyResult.chosenRoute.providerName,
			requestBody: requestBodyForLog,
			requestProtocol: 'dashscope',
			requestOperation: 'audio.transcriptions.async',
			upstreamProtocol: proxyResult.chosenRoute.upstreamProtocol,
			upstreamOperation: proxyResult.chosenRoute.upstreamOperation,
			modelSurfaceId: proxyResult.chosenRoute.modelSurfaceId,
			routePoolId: proxyResult.chosenRoute.routePoolId,
			routeTargetId: proxyResult.chosenRoute.targetId,
			adapter: proxyResult.chosenRoute.adapter,
			stickyTrace: stickyTraceSnapshot,
			routeGroup: effectiveRouteGroup,
			status,
			latencyMs: Date.now() - start,
			errorMessage:
				status === 'error'
					? errorBodyText != null
						? formatHttpErrorTextForRequestLog(response.status, response.headers.get('content-type'), errorBodyText)
						: `HTTP ${response.status}`
					: undefined,
			billing: {
				modelPricingProfileJson: model.pricing_profile ?? null,
				catalogModelId: baseModelId,
				userChargedCostFactorsJson: apiKey.chargedCostFactors,
				routeGroup: effectiveRouteGroup,
				routePriceOverrideJson: proxyResult.chosenRoute.priceOverrideRaw,
				durationSeconds: response.ok ? MAX_AUDIO_DURATION_SECONDS * fileCount : 0,
				durationSource: 'precheck',
				fileBytes: 0,
				requestStartedAtMs: start,
			},
			providerKeyId: proxyResult.chosenRoute.providerKeyId ?? null,
			providerKeyLabel: proxyResult.chosenRoute.providerKeyLabel ?? null,
			providerKeyFingerprint: proxyResult.chosenRoute.providerKeyFingerprint ?? null,
			upstreamRequestId: proxyResult.upstreamRequestId,
			timing: timing.snapshot(),
			circuitEvents: alertCircuitEvents.length > 0 ? alertCircuitEvents : undefined,
			suppressErrorAlert: proxyResult.suppressErrorAlert || undefined,
		});
	})().catch(async (error) => {
		await nativeRequest!.terminateUnknown('async_task_usage_settlement_failed');
		throw error;
	});

	if (proxyResult.stickyMutationPromise) scheduleBackgroundWork(c, proxyResult.stickyMutationPromise);
	if (response.ok) {
		const parsed = proxyResult.meta?.parsedBody as { output?: { task_id?: unknown } } | undefined;
		const acceptedTaskId = parsed?.output?.task_id;
		if (typeof acceptedTaskId === 'string' && acceptedTaskId.length > 0) {
			const token = await signNativeAsyncTaskReceipt(
				{
					v: 1,
					taskId: acceptedTaskId,
					requestLogId: policy.requestId,
					workspaceId: apiKey.workspaceId,
					userId: apiKey.userId,
					apiKeyId: apiKey.keyId,
					providerId: proxyResult.chosenRoute.providerId,
					targetId: proxyResult.chosenRoute.targetId,
					providerKeyId: proxyResult.chosenRoute.providerKeyId ?? null,
					modelId: baseModelId,
					routeGroup: effectiveRouteGroup,
					budgetEpoch: apiKey.budgetEpoch,
					reservedMicros: nativeRequest!.admission.ordinaryLease.reservedMicros,
					chargedCeiling: estimate.chargedCost,
					startMs: start,
					exp: start + 24 * 60 * 60 * 1000,
					settledUpfront: true,
				},
				c.env.SHARED_KEY_ENCRYPTION_SECRET,
			);
			const headers = new Headers(response.headers);
			headers.set('X-CinaToken-Task-Receipt', token);
			headers.set('X-CinaToken-Settlement-Basis', 'reserved');
			headers.set('X-CinaToken-Request-Id', policy.requestId);
			response = new Response(
				JSON.stringify({ ...(proxyResult.meta?.parsedBody as Record<string, unknown>), gateway_task_receipt: token }),
				{ status: response.status, statusText: response.statusText, headers },
			);
		}
	}
	return response;
}

function displayName(model: ModelRow, baseModelId: string): string {
	return model.display_name != null && String(model.display_name).trim() !== ''
		? String(model.display_name).trim()
		: baseModelId;
}
