/**
 * 上游调度与故障转移：
 * - 可选 Provider sticky（跨 Tier 优先）→ priority 硬序 + 层内 route strategy 编排尝试序列。
 * - 失败按类别进入 provider 熔断（`provider-circuit-breaker`：429 无头 5s→60s 梯度；普通 5xx 连续 3 次后 10s；524/fetch 不跨请求熔断）。
 * - 全部候选因熔断不可用时返回 429 + Retry-After（而非 502）。
 * - 循环内复查：本次请求内刚被熔断的 provider（同 providerId 多 target）不再打。
 */
import { createResourceCompletionGroup, observeResourceCleanup } from './resource-completion';
import type { GatewayRepositories, PreparationControl, RouteStrategyName, UpstreamProtocol } from '@octafuse/core';
import { DEFAULT_ROUTE_STRATEGY, fingerprintProviderApiKey, preparationRead, RequestAuxiliaryAuthLimitError, type RequestAuxiliaryAuthBudget } from '@octafuse/core';
import type { RoutePoolStickyRoutingConfig } from '@octafuse/core/db/route-pool-sticky-types';
import type { RouteResult } from './model-router';
import type { UsageFromStream } from './proxy';
import { EMPTY_USAGE } from './proxy';
import { buildRouteAttemptPlan } from './route-attempt-planner';
import {
	circuitKeyForRoute,
	expandAttemptsWithSharedKeys,
	parseSharedKeyId,
} from './shared-key-pool';
import {
	expandAttemptsWithPrivateByok,
	type PrivateByokRequestContext,
} from './byok-key-pool';
import {
	getProviderCircuitRemainingMs,
	markProviderFailure,
	markProviderSuccess,
	parseRetryAfterMs,
} from './provider-circuit-breaker';
import type { GatewayCircuitAlertEvent } from './circuit-alert-types';
import {
	classifyUpstreamFetchFailure,
	classifyUpstreamHttpFailure,
	type UpstreamFailureClassification,
} from './upstream-failure-classifier';
import type { RequestTimingAttempt, RequestTimingCollector } from './request-timing';
import { GatewayErrorCode } from './gateway-error-codes';
import type { SharedKeyQuoteAttemptCapture, SharedKeyQuoteAttemptReference } from './shared-key-quote-attempt';
import { gatewayErrorResponse, gatewayNestedErrorResponse } from './gateway-error-response';
import { RequestBudgetAdmissionError } from './request-budget-admission';
import { buildOpenRouterErrorBody, type OpenRouterErrorSkin } from './openrouter-error-protocol';
import { createRequestDeadline, RequestExecutionStoppedError, type RequestDeadline } from './request-deadline';
import {
	createRequestDispatchBudget,
	RequestDispatchLimitError,
	type RequestDispatchBudget,
	type RequestDispatchBudgetSnapshot,
} from './request-dispatch-budget';
import { responseTextWithinLimit, UpstreamResponseBodyTooLargeError } from './egress/bounded-response-body';
import { preparedTextAttemptMatchesRoute } from './egress/prepared-text-attempt';
import { MAX_MATERIALIZED_ERROR_BODY_BYTES } from './request-log-record-status';
import {
	clearStickyBindingSync,
	mergeStickyIntoAttempts,
	resolveStickySession,
	resolveStickyTrace,
	scheduleStickyBind,
	scheduleStickyBindAfter,
	scheduleStickyTouchIfNeeded,
	scheduleStickyTouchAfter,
	shouldInvalidateStickyBinding,
	stickyMutationPromise,
	type StickySession,
	type StickyTraceSnapshot,
} from './provider-sticky-routing';

/** Opportunistic hygiene: ~1/500 sticky-enabled requests purge expired rows. */
const STICKY_STALE_GC_PROBABILITY = 1 / 500;
const STICKY_STALE_GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STICKY_STALE_GC_LIMIT = 500;
/** Model fallback accepts at most eight candidates; never retain a larger request trace. */
const MAX_DISPATCH_ATTEMPT_TRACES = 8;
/** Enough for error classification without retaining a 64 KiB body per candidate. */
const MAX_DISPATCH_TRACE_ERROR_BODY_BYTES = 8 * 1024;

function maybeScheduleStickyStaleGc(
	repos: GatewayRepositories,
	session: StickySession,
	nowMs = Date.now(),
	control?: PreparationControl,
): void {
	if (Math.random() >= STICKY_STALE_GC_PROBABILITY) return;
	const cutoffIso = new Date(nowMs - STICKY_STALE_GC_MAX_AGE_MS).toISOString();
	const removeStale = () => repos.routePoolSticky.deleteStaleBefore(cutoffIso, STICKY_STALE_GC_LIMIT);
	session.mutations.push(
		(control ? control.runOwnedMutation(removeStale) : removeStale()).catch((err) => {
			console.warn('[Gateway Sticky] stale GC failed', err);
		})
	);
}

/** Images 合成 abort（Gateway 超时 / 客户端取消）——禁止 failover 再打上游。 */
export type ImageDispatchAbortReason = 'client_abort' | 'gateway_timeout';

/** 协议 driver 可选透传（如 Images / Audio 已解析的 body / usage，避免 route 侧重复 parse）。 */
export type ProxyDispatchMeta = {
	imageUsage?: import('@octafuse/core').ImageTokenUsage | null;
	parsedBody?: unknown;
	/** Native OpenRouter-compatible Images SSE; settlement resolves only at a validated terminal event. */
	imageStreamSettlement?: Promise<{
		completed: boolean;
		done: boolean;
		cancelled: boolean;
		/** Local capacity rejection after accepted upstream work, not known zero usage. */
		upstreamOutcomeUnknown?: boolean;
		imageAbortReason?: ImageDispatchAbortReason;
		errorMessage: string | null;
		validImages: number;
		imageUsage: import('@octafuse/core').ImageTokenUsage | null;
		upstreamSupplierCostUsdTicks: number | null;
	}>;
	/** 仅 Images：上游 wait 被 abort 时由 driver 写入（见 openai-images-driver） */
	imageAbortReason?: ImageDispatchAbortReason;
	/** 仅 Audio transcriptions：计费时长（秒） */
	audioDurationSeconds?: number | null;
	/** 仅 Audio：duration 来源 */
	audioDurationSource?: 'upstream' | 'media' | 'client' | 'estimated' | null;
	/** 仅 Audio：上传文件字节数 */
	audioFileBytes?: number;
	/** 仅 Audio token 计费：上游 `usage.type=tokens` */
	audioTokenUsage?: import('@octafuse/core').AudioTokenUsage | null;
	/** The final network attempt may have been consumed, but no HTTP response was observed. */
	upstreamOutcomeUnknown?: boolean;
	/** A native JSON response was cancelled after crossing its streaming byte ceiling. */
	responseBodyTooLarge?: boolean;
	/** A paid/accepted upstream response must not be replayed against another provider. */
	failoverForbidden?: boolean;
	/** The response body was generated and sanitized inside the gateway, not supplied by an upstream. */
	gatewayGeneratedError?: boolean;
	/** This attempt was denied before dispatch; earlier attempts may have been sent. */
	admissionDeniedPreDispatch?: boolean;
};

type UnknownUpstreamOutcomeError = Error & {
	upstreamOutcomeUnknown: true;
};

/** Preserve the original error while telling failover that a network write may have landed. */
export function markUpstreamOutcomeUnknown(error: unknown): UnknownUpstreamOutcomeError {
	const normalized = error instanceof Error ? error : new Error(String(error));
	return Object.assign(normalized, { upstreamOutcomeUnknown: true as const });
}

function thrownOutcomeIsUnknown(error: unknown): boolean {
	return (
		error != null &&
		typeof error === 'object' &&
		(error as { upstreamOutcomeUnknown?: unknown }).upstreamOutcomeUnknown === true
	);
}

/** Images abort 的 504 不得换 provider / 换路由（避免客户端取消或超时后二次打 OpenAI）。 */
export function shouldFailImmediatelyForImageAbort(meta?: ProxyDispatchMeta | null): boolean {
	const reason = meta?.imageAbortReason;
	return reason === 'client_abort' || reason === 'gateway_timeout';
}

export type ProxyDispatchResult = {
	response: Response;
	resourceCompletion?: import('./resource-completion').ResourceCompletion;
	usagePromise: Promise<UsageFromStream>;
	upstreamRequestId: string | null;
	meta?: ProxyDispatchMeta;
};

export type ProxyFailoverResult = {
	response: Response;
	/** Exact quote claim for the selected dispatch result, when capture was enabled. */
	quoteAttemptReference?: SharedKeyQuoteAttemptReference | null;
	resourceCompletion?: import('./resource-completion').ResourceCompletion;
	usagePromise: Promise<UsageFromStream>;
	upstreamRequestId: string | null;
	chosenRoute: RouteResult;
	/** 本次请求触发的 provider 熔断事件（仅 openedOrExtended） */
	circuitEvents: GatewayCircuitAlertEvent[];
	/** 因已有 provider 熔断短路、无需重复 webhook 告警 */
	suppressErrorAlert: boolean;
	meta?: ProxyDispatchMeta;
	/**
	 * Lazy sticky observation for `route_trace`.
	 * Await inside request-log background work so CAS outcomes are visible.
	 */
	stickyTrace?: (() => Promise<StickyTraceSnapshot>) | undefined;
	/** Background bind/touch mutations (schedule via waitUntil) */
	stickyMutationPromise?: Promise<unknown> | null;
	/** Bounded, sanitized request-level attempt history for model fallback audit. */
	dispatchAttempts?: ProxyDispatchAttemptTrace[];
	/** Independent of the bounded trace array; shared across model/key fallbacks. */
	dispatchBudget?: RequestDispatchBudgetSnapshot;
};

export type ProxyDispatchAttemptTrace = {
	candidateIndex: number | null;
	modelId: string | null;
	globalEndpointRank: number | null;
	routeTargetId: string;
	providerId: string;
	status: number | null;
	outcome: 'success' | 'error' | 'fetch_error';
	contentType?: string | null;
	errorBodyText?: string | null;
};

export type FailoverDispatchOptions = {
	/** Synchronous registration before dispatch; independent from usage/accounting. */
	registerResourceCompletion?: (task: import('./resource-completion').ResourceCompletion) => void;
	affinityKey: string;
	tierKeyPrefix: string;
	strategy: RouteStrategyName;
	/** Per-priority overrides from `route_pools.tier_strategies` */
	tierStrategies?: ReadonlyMap<number, RouteStrategyName> | null;
	timing?: RequestTimingCollector | null;
	/** Route pool id for sticky bindings (null disables sticky) */
	routePoolId?: string | null;
	/** Pool sticky config from surface join */
	sticky?: RoutePoolStickyRoutingConfig | null;
	/** OpenRouter activation gate; omitted preserves the pool's HTTP-success behavior. */
	stickySuccessPolicy?: 'stream_success' | 'cache_hit' | null;
	/** Restrict sticky lookup/binding to routes where cache reads are economically beneficial. */
	stickyRouteEligible?: ((route: RouteResult) => boolean) | null;
	/** Outer cross-model orchestration will continue after a non-OK result. */
	deferFinalAttempt?: boolean;
	/** One request-scoped budget, including outer model loops and BYOK expansion. */
	dispatchBudget?: RequestDispatchBudget;
	/** Absolute request cutoff, shared by every outer model invocation. */
	requestDeadlineAtMs?: number;
	/** Optional ingress owner for credential/sticky preparation only. The caller
	 * drains its mutations; protocol drivers still own response cancellation and settlement. */
	preparationControl?: PreparationControl;
	/** Supplied by the protocol entry point, not by upstream response headers. */
	errorContext?: { skin: OpenRouterErrorSkin; requestId?: string };
	/**
	 * Request-scoped admission boundary. It is awaited immediately before the
	 * first eligible dispatch callback and may fail closed without being
	 * classified as an upstream fetch failure.
	 */
	beforeUpstreamDispatch?: (route: RouteResult, preparedAttempt?: unknown) => Promise<void>;
	/** Opt-in text boundary: reject missing/stale driver identity before quote or grant. */
	requirePreparedTextAttemptIdentity?: boolean;
	/** Review-only exact quote reference capture at the delegated text pre-fetch boundary. */
	quoteAttemptCapture?: SharedKeyQuoteAttemptCapture;
	/**
	 * Text drivers can prepare URL, credentials and serialized body first, then
	 * invoke the admission boundary immediately beside fetch(). Other drivers
	 * retain the legacy failover-level placement until individually audited.
	 * Once a driver reports that dispatch may have landed, failover stops and
	 * accounting preserves the admitted ceiling because replay is forbidden.
	 */
	delegateBeforeUpstreamDispatchToDriver?: boolean;
	/**
	 * A caller with a durable one-claim-per-request admission policy can stop
	 * after the first granted dispatch, including a known non-2xx response.
	 * Requires a delegated driver boundary and a callback that grants every
	 * eligible route; this local option does not create the durable claim.
	 */
	stopAfterFirstGrantedDispatch?: boolean;
	/**
	 * Execute provider.sort.partition="none" as one request-level chain. A
	 * request-shape 4xx stops only that model candidate; replay-forbidden
	 * outcomes still stop the entire chain.
	 */
	crossModelCandidateFailover?: boolean;
	/** Authenticated request scope used to select encrypted private provider keys. */
	byok?: PrivateByokRequestContext | null;
};

type DispatchFn = (
	route: RouteResult,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	beforeFetch?: (preparedAttempt?: unknown) => Promise<void>,
	auxiliaryAuth?: RequestAuxiliaryAuthBudget,
	upstreamHeadersObserved?: (status: number) => void,
) => Promise<ProxyDispatchResult>;

function emptyRoute(protocol: UpstreamProtocol): RouteResult {
	return {
		targetId: '',
		modelSurfaceId: null,
		routePoolId: '',
		providerId: '',
		providerName: '',
		providerModelName: '',
		upstreamProtocol: protocol,
		upstreamOperation: '*',
		adapter: 'passthrough',
		providerEndpoints: {},
		providerApiKey: '',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routingMetadata: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: null,
		providerKeyLabel: null,
		providerKeyFingerprint: null,
	};
}

function logProviderSwitchAlert(route: RouteResult, classification: UpstreamFailureClassification, status?: number): void {
	if (!classification.alertOnKeySwitch) return;
	console.warn(
		`[Gateway Proxy] provider auth issue, trying next provider providerId=${route.providerId} status=${status ?? 'fetch_error'}`
	);
}

function allProvidersBusyResponse(retryAfterMs: number | null): Response {
	const retryAfterSeconds = Math.max(1, Math.ceil((retryAfterMs ?? 30_000) / 1000));
	const code = GatewayErrorCode.circuitUpstreamCapacityExhausted;
	return gatewayNestedErrorResponse({
		status: 429,
		code,
		error: {
			message: `All upstream providers are cooling down. Please retry after ${retryAfterSeconds} seconds.`,
			type: 'upstream_capacity_exhausted',
			retry_after_seconds: retryAfterSeconds,
		},
		headers: { 'Retry-After': String(retryAfterSeconds) },
	});
}

/** HTTP 2xx 与 Cloudflare WebSocket 101 都表示 driver 已成功建立上游请求。 */
export function isSuccessfulDispatchResponse(response: Response): boolean {
	return response.ok || (response.status === 101 && response.webSocket != null);
}

/**
 * 按「可选 sticky → provider priority 层 → route strategy」调度上游请求。
 */
export async function failoverDispatch(
	repos: GatewayRepositories,
	routes: RouteResult[],
	expectedProtocol: UpstreamProtocol | readonly UpstreamProtocol[],
	dispatch: DispatchFn,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions
): Promise<ProxyFailoverResult> {
	if (options?.stopAfterFirstGrantedDispatch === true && (
		options.delegateBeforeUpstreamDispatchToDriver !== true
		|| options.beforeUpstreamDispatch == null
	)) {
		throw new TypeError('stopAfterFirstGrantedDispatch requires delegated durable admission');
	}
	if (options?.quoteAttemptCapture && options.delegateBeforeUpstreamDispatchToDriver !== true) {
		throw new TypeError('Shared-key quote capture requires a delegated pre-fetch boundary');
	}
	if (options?.requirePreparedTextAttemptIdentity === true
		&& options.delegateBeforeUpstreamDispatchToDriver !== true) {
		throw new TypeError('Prepared text identity requires a delegated pre-fetch boundary');
	}
	const resources = createResourceCompletionGroup();
	try {
		// The lease must be retained while the handler still owns it, including
		// dispatches whose headers arrive after the deadline response was returned.
		options?.registerResourceCompletion?.(resources.completion);
		const ownedDispatch: DispatchFn = (...args) => {
			const task = Promise.resolve().then(() => dispatch(...args));
			resources.track(task.then(result => result.resourceCompletion ?? 'confirmed'));
			return task;
		};
		const result = await failoverDispatchWithDeadline(repos, routes, expectedProtocol, ownedDispatch, requestSignal, options,
			completion => resources.track(observeResourceCleanup(() => completion)));
		return { ...result, resourceCompletion: resources.completion };
	} finally { resources.seal(); }
}

async function failoverDispatchWithDeadline(
	repos: GatewayRepositories,
	routes: RouteResult[],
	expectedProtocol: UpstreamProtocol | readonly UpstreamProtocol[],
	dispatch: DispatchFn,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions,
	observePreparation?: (completion: Promise<void>) => void,
): Promise<ProxyFailoverResult> {
	if (options?.requestDeadlineAtMs == null) {
		return failoverDispatchWithinDeadline(repos, routes, expectedProtocol, dispatch, requestSignal, options);
	}
	let ownsPreparation = true;
	const deadline = createRequestDeadline(options.requestDeadlineAtMs, requestSignal, undefined, completion => {
		if (ownsPreparation) observePreparation?.(completion);
	});
	const dispatchBudget = options.dispatchBudget ?? createRequestDispatchBudget();
	const execution: DeadlineExecution = {
		deadline,
		route: routes[0] ?? emptyRoute(Array.isArray(expectedProtocol) ? expectedProtocol[0]! : expectedProtocol as UpstreamProtocol),
		quoteAttemptReference: null,
		outcomeUnknown: false,
		dispatchStarted: false,
		upstreamRequestId: null,
		usagePromise: Promise.resolve(EMPTY_USAGE),
		attempts: [],
		circuitEvents: [],
	};
	let responseOwnsDeadline = false;
	try {
		deadline.throwIfStopped();
		const result = await failoverDispatchWithinDeadline(
			repos, routes, expectedProtocol, dispatch, deadline.signal,
			{ ...options, dispatchBudget }, execution,
		);
		// Raw reads already registered remain owned after cancellation. Future
		// response pulls belong to the driver, not this soon-to-be-sealed group.
		ownsPreparation = false;
		if (!result.response.ok) {
			// Materialize the bounded error body while this layer still owns the
			// send/unknown facts. Timing out later in route logging would otherwise
			// turn a known rejection into a generic exception/unknown settlement.
			let response: Response;
			let meta = result.meta;
			try {
				const text = await responseTextWithinLimit(result.response, MAX_MATERIALIZED_ERROR_BODY_BYTES, deadline.signal);
				const headers = new Headers(result.response.headers);
				headers.delete('Content-Length');
				headers.delete('Content-Encoding');
				headers.delete('Transfer-Encoding');
				response = new Response(result.response.status === 304 ? null : text, { status: result.response.status, statusText: result.response.statusText, headers });
			} catch (error) {
				if (!(error instanceof UpstreamResponseBodyTooLargeError)) throw error;
				response = gatewayErrorResponse({
					status: 502, code: GatewayErrorCode.upstreamResponseTooLarge,
					message: 'Upstream error response exceeded the gateway size limit',
					skin: options.errorContext?.skin, requestId: options.errorContext?.requestId,
				});
				meta = { ...meta, gatewayGeneratedError: true };
			}
			deadline.throwIfStopped();
			return { ...result, response, meta };
		}
		deadline.throwIfStopped();
		const response = deadline.wrapResponse(result.response);
		responseOwnsDeadline = true;
		return {
			...result,
			response,
			usagePromise: result.usagePromise.then((usage) =>
				deadline.signal.reason instanceof RequestExecutionStoppedError
				&& deadline.signal.reason.reason === 'deadline_exceeded'
					? { ...usage, stream_error: usage.stream_error ?? 'Request deadline exceeded' }
					: usage,
			),
		};
	} catch (error) {
		if (!(error instanceof RequestExecutionStoppedError)) throw error;
		void execution.response?.body?.cancel('request_execution_stopped').catch(() => undefined);
		// Quote claims are durable admission writes. Wait for an in-flight claim
		// before snapshotting the selected reference for this terminal result.
		await deadline.drainOwnedMutations();
		// A later candidate can be selected for preparation before it claims a
		// quote. If it never reached a claim or dispatch, settle the last quoted
		// attempt instead of returning that unclaimed route with no reference.
		const priorQuotedAttempt = !execution.quoteAttemptReference && !execution.dispatchStarted
			? execution.priorQuotedAttempt : null;
		const selectedQuoteReference = execution.quoteAttemptReference ?? priorQuotedAttempt?.quoteAttemptReference;
		console.warn(JSON.stringify({ message: 'request dispatch stopped', reason: error.reason }));
		const status = error.reason === 'deadline_exceeded' ? 504 : 499;
		const code = error.reason === 'deadline_exceeded' ? GatewayErrorCode.requestDeadlineExceeded : GatewayErrorCode.requestCancelled;
		return {
			response: new Response(JSON.stringify(buildOpenRouterErrorBody({
				skin: options.errorContext?.skin ?? 'chat', status, legacyCode: code,
				requestId: options.errorContext?.requestId,
				errorType: error.reason === 'deadline_exceeded' ? 'timeout' : 'provider_unavailable',
				message: error.message,
			})), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store', 'X-OctaFuse-Error-Code': code } }),
			usagePromise: priorQuotedAttempt?.usagePromise ?? execution.usagePromise,
			...(selectedQuoteReference
				? { quoteAttemptReference: selectedQuoteReference } : {}),
			upstreamRequestId: priorQuotedAttempt?.upstreamRequestId ?? execution.upstreamRequestId,
			chosenRoute: priorQuotedAttempt?.route ?? execution.route,
			circuitEvents: execution.circuitEvents,
			dispatchAttempts: [...execution.attempts],
			dispatchBudget: dispatchBudget.snapshot(),
			stickyTrace: () => resolveStickyTrace(execution.stickySession ?? null),
			stickyMutationPromise: stickyMutationPromise(execution.stickySession ?? null),
			suppressErrorAlert: true,
			meta: {
				gatewayGeneratedError: true, failoverForbidden: true,
				upstreamOutcomeUnknown: priorQuotedAttempt?.outcomeUnknown ?? execution.outcomeUnknown,
				admissionDeniedPreDispatch: !(priorQuotedAttempt?.dispatchStarted ?? execution.dispatchStarted),
			},
		};
	} finally {
		ownsPreparation = false;
		await deadline.drainOwnedMutations();
		if (!responseOwnsDeadline) deadline.dispose();
	}
}

type DeadlineExecution = {
	deadline: RequestDeadline;
	route: RouteResult;
	quoteAttemptReference: SharedKeyQuoteAttemptReference | null;
	priorQuotedAttempt?: {
		route: RouteResult;
		quoteAttemptReference: SharedKeyQuoteAttemptReference;
		outcomeUnknown: boolean;
		dispatchStarted: boolean;
		upstreamRequestId: string | null;
		usagePromise: Promise<UsageFromStream>;
	};
	outcomeUnknown: boolean;
	dispatchStarted: boolean;
	stickySession?: StickySession | null;
	upstreamRequestId: string | null;
	response?: Response;
	usagePromise: Promise<UsageFromStream>;
	attempts: ProxyDispatchAttemptTrace[];
	circuitEvents: GatewayCircuitAlertEvent[];
};

async function failoverDispatchWithinDeadline(
	repos: GatewayRepositories,
	routes: RouteResult[],
	expectedProtocol: UpstreamProtocol | readonly UpstreamProtocol[],
	dispatch: DispatchFn,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions,
	execution?: DeadlineExecution,
): Promise<ProxyFailoverResult> {
	const deadline = execution?.deadline;
	const preparationControl = deadline ?? options?.preparationControl;
	const read = <T>(operation: () => Promise<T>): Promise<T> => preparationRead(preparationControl, operation);
	preparationControl?.throwIfStopped();
	const timing = options?.timing ?? null;
	const dispatchBudget = options?.dispatchBudget ?? createRequestDispatchBudget();
	const dispatchLimitResult = (
		route: RouteResult,
		circuitEvents: GatewayCircuitAlertEvent[] = [],
		auxiliaryAuthLimit = false,
	): ProxyFailoverResult => {
		const snapshot = dispatchBudget.snapshot();
		const reason = auxiliaryAuthLimit ? 'auxiliary_auth_limit_exceeded' : 'dispatch_limit_exceeded';
		const metadata = {
			dispatch_limit: snapshot.limit,
			dispatch_permits_consumed: snapshot.permitsConsumed,
			auxiliary_auth_limit: snapshot.auxiliaryAuth.limit,
			auxiliary_auth_exchanges_started: snapshot.auxiliaryAuth.exchangesStarted,
		};
		console.warn(JSON.stringify({
			message: 'request dispatch stopped',
			reason,
			...metadata,
		}));
		return {
			response: gatewayErrorResponse({
				status: 502,
				code: auxiliaryAuthLimit ? GatewayErrorCode.auxiliaryAuthLimitExceeded : GatewayErrorCode.dispatchLimitExceeded,
				message: auxiliaryAuthLimit ? 'Request auxiliary authentication limit reached' : 'Request upstream dispatch limit reached',
				metadata,
				skin: options?.errorContext?.skin,
				requestId: options?.errorContext?.requestId,
			}),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
			chosenRoute: route,
			circuitEvents,
			suppressErrorAlert: true,
			dispatchBudget: snapshot,
			meta: { gatewayGeneratedError: true, failoverForbidden: true, admissionDeniedPreDispatch: true },
		};
	};
	timing?.markUpstreamDispatchStart();
	const expectedProtocols = Array.isArray(expectedProtocol)
		? expectedProtocol
		: [expectedProtocol];
	const fallbackProtocol = expectedProtocols[0]!;
	const protocolRoutes = routes.filter((route) => {
		if (expectedProtocols.includes(route.upstreamProtocol)) return true;
		console.warn(
			`[Gateway Proxy] unsupported protocol, skipping providerId=${route.providerId} protocol=${route.upstreamProtocol}`
		);
		return false;
	});

	if (protocolRoutes.length === 0) {
		return {
			response: gatewayErrorResponse({
				status: 502,
				code: GatewayErrorCode.noRoute,
				message: 'No routes configured',
			}),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
			chosenRoute: emptyRoute(fallbackProtocol),
			dispatchBudget: dispatchBudget.snapshot(),
			circuitEvents: [],
			suppressErrorAlert: false,
		};
	}

	// A previous model may have spent all permits. Stop before pool expansion,
	// secret reads, sticky lookups, or an additional financial admission.
	try {
		dispatchBudget.assertAvailable();
	} catch (error) {
		if (!(error instanceof RequestDispatchLimitError)) throw error;
		return dispatchLimitResult(protocolRoutes[0]!);
	}

	const affinityKey = options?.affinityKey ?? '';
	const tierKeyPrefix = options?.tierKeyPrefix ?? '';
	const strategy: RouteStrategyName = options?.strategy ?? DEFAULT_ROUTE_STRATEGY;
	const tierStrategies = options?.tierStrategies ?? null;
	const stickyConfig = options?.sticky ?? null;
	const stickyRouteEligible = options?.stickyRouteEligible ?? null;
	const routePoolId =
		options?.routePoolId ?? protocolRoutes.find((r) => r.routePoolId)?.routePoolId ?? null;

	const circuitEvents: GatewayCircuitAlertEvent[] = [];
	if (execution) execution.circuitEvents = circuitEvents;
	const nowMs = Date.now();
	const plan = buildRouteAttemptPlan(
		protocolRoutes,
		{ affinityKey, tierKeyPrefix },
		strategy,
		nowMs,
		tierStrategies,
		// Credential-specific circuits can only be evaluated after shared/BYOK
		// expansion. Filtering the base provider here would incorrectly suppress
		// healthy private credentials for the same route target.
		{ filterCircuit: false },
	);
	// 共享渠道 route 展开为「用户共享 key 固定序列 + provider 自有 key 兜底」；
	// 共享 key 的熔断走复合键（见 circuitKeyForRoute），坏 key 不波及 provider。
	const sharedAndPlatformAttempts = await read(() => expandAttemptsWithSharedKeys(repos, plan.attempts, preparationControl));
	const credentialAttempts = await read(() => expandAttemptsWithPrivateByok(
		repos,
		plan.attempts,
		sharedAndPlatformAttempts,
		options?.byok,
		preparationControl,
	));
	let earliestRetryAfterMs: number | null = null;
	let skippedByCircuit = 0;
	const availableAttempts = credentialAttempts.filter((route) => {
		const remaining = getProviderCircuitRemainingMs(circuitKeyForRoute(route), nowMs);
		if (remaining <= 0) return true;
		skippedByCircuit += 1;
		if (earliestRetryAfterMs == null || remaining < earliestRetryAfterMs) {
			earliestRetryAfterMs = remaining;
		}
		return false;
	});
	const availableTargetIds = new Set(availableAttempts.map((route) => route.targetId));
	const stickyCandidates = stickyRouteEligible
		? protocolRoutes.filter(stickyRouteEligible)
		: protocolRoutes;
	const { session: stickySession, stickyRoute } = stickyConfig?.enabled && stickyCandidates.length > 0
		? await read(() => resolveStickySession(repos, {
				routePoolId,
				affinityKey,
				config: stickyConfig,
				candidates: stickyCandidates,
				targetAvailable: (route) => availableTargetIds.has(route.targetId),
				nowMs,
				control: preparationControl,
			}))
		: { session: null, stickyRoute: null };
	if (execution) execution.stickySession = stickySession;
	const clearSticky = (): Promise<void> => {
		if (!stickySession) return Promise.resolve();
		const startClear = (): Promise<void> => {
			const clear = () => clearStickyBindingSync(repos, stickySession);
			const mutation = options?.preparationControl ? options.preparationControl.runOwnedMutation(clear) : clear();
			stickySession.mutations.push(mutation);
			return mutation;
		};
		// Text's deadline wrapper returns the background mutation on its error
		// result. Images can throw to ingress instead, so its owner must drain it.
		return execution ? read(startClear) : startClear();
	};
	if (stickySession) {
		maybeScheduleStickyStaleGc(repos, stickySession, nowMs, options?.preparationControl);
	}
	const attempts = mergeStickyIntoAttempts(availableAttempts, stickyRoute);

	if (attempts.length === 0) {
		const noCredentials = credentialAttempts.length === 0;
		return {
			response: noCredentials
				? gatewayErrorResponse({
						status: 502,
						code: GatewayErrorCode.noRoute,
						message: 'No usable upstream credentials configured',
					})
				: allProvidersBusyResponse(earliestRetryAfterMs),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
			chosenRoute: protocolRoutes[0]!,
			dispatchBudget: dispatchBudget.snapshot(),
			circuitEvents: [],
			suppressErrorAlert: !noCredentials && skippedByCircuit > 0,
			stickyTrace: () => resolveStickyTrace(stickySession),
			stickyMutationPromise: stickyMutationPromise(stickySession),
		};
	}

	let lastResponse: Response | null = null;
	let lastRoute: RouteResult = protocolRoutes[0]!;
	let lastQuoteReference: SharedKeyQuoteAttemptReference | null = null;
	let lastDispatchMeta: ProxyDispatchMeta | undefined;
	let lastTimingAttempt: RequestTimingAttempt | undefined;
	let stickyAttemptCleared = false;
	let stickyTargetAttempted = false;
	let unknownOutcomeObserved = false;
	let lastDispatchedCandidateIndex: number | null = null;
	// A committed one-claim policy has only one opportunity to cross the
	// delegated boundary. A driver that re-enters beforeFetch must not invoke
	// its durable admission callback twice, even if it catches the first error.
	let singleGrantBoundaryEntered = false;
	const blockedCandidateIndexes = new Set<number>();
	const dispatchAttempts: ProxyDispatchAttemptTrace[] = [];
	if (execution) execution.attempts = dispatchAttempts;
	const dispatchAttemptIndexByCandidate = new Map<number, number>();
	const recordDispatchAttempt = (attempt: ProxyDispatchAttemptTrace): void => {
		if (
			options?.crossModelCandidateFailover === true
			&& attempt.candidateIndex != null
		) {
			const existingIndex = dispatchAttemptIndexByCandidate.get(attempt.candidateIndex);
			if (existingIndex != null) {
				dispatchAttempts[existingIndex] = attempt;
				return;
			}
			if (dispatchAttempts.length >= MAX_DISPATCH_ATTEMPT_TRACES) {
				const evicted = dispatchAttempts.shift();
				if (evicted?.candidateIndex != null) {
					dispatchAttemptIndexByCandidate.delete(evicted.candidateIndex);
				}
				for (const [candidateIndex, index] of dispatchAttemptIndexByCandidate) {
					dispatchAttemptIndexByCandidate.set(candidateIndex, index - 1);
				}
			}
			dispatchAttemptIndexByCandidate.set(attempt.candidateIndex, dispatchAttempts.length);
			dispatchAttempts.push(attempt);
			return;
		}

		if (dispatchAttempts.length >= MAX_DISPATCH_ATTEMPT_TRACES) {
			dispatchAttempts.shift();
		}
		dispatchAttempts.push(attempt);
	};

	const finish = (result: ProxyFailoverResult): ProxyFailoverResult => ({
		...result,
		dispatchBudget: dispatchBudget.snapshot(),
		dispatchAttempts: [...dispatchAttempts],
		stickyTrace: () => resolveStickyTrace(stickySession),
		stickyMutationPromise: stickyMutationPromise(stickySession),
	});
	const candidateIndexOf = (route: RouteResult): number | null =>
		typeof route.gatewayCandidateIndex === 'number' && Number.isInteger(route.gatewayCandidateIndex)
			? route.gatewayCandidateIndex
			: null;
	const hasLaterEligibleAttempt = (afterIndex: number): boolean => {
		for (let index = afterIndex + 1; index < attempts.length; index += 1) {
			const later = attempts[index]!;
			const candidateIndex = candidateIndexOf(later);
			if (candidateIndex != null && blockedCandidateIndexes.has(candidateIndex)) continue;
			if (getProviderCircuitRemainingMs(circuitKeyForRoute(later)) > 0) continue;
			return true;
		}
		return false;
	};

	for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
		const route = attempts[attemptIndex]!;
		deadline?.throwIfStopped();
		const candidateIndex = candidateIndexOf(route);
		if (candidateIndex != null && blockedCandidateIndexes.has(candidateIndex)) continue;

		if (getProviderCircuitRemainingMs(circuitKeyForRoute(route)) > 0) {
			console.warn(
				`[Gateway Proxy] provider cooling down mid-request, skipping providerId=${route.providerId} key=${route.providerKeyId ?? '-'}`
			);
			continue;
		}
		try {
			dispatchBudget.assertAvailable();
		} catch (error) {
			if (!(error instanceof RequestDispatchLimitError)) throw error;
			timing?.markFinalAttempt(lastTimingAttempt);
			void lastResponse?.body?.cancel('dispatch_limit_exceeded').catch(() => undefined);
			// The next candidate was never claimed. A quoted request settles
			// against its last claimed route if it already reached an upstream.
			return finish({
				...dispatchLimitResult(lastResponse && lastQuoteReference ? lastRoute : route,
					circuitEvents),
				...(lastResponse && lastQuoteReference
					? { quoteAttemptReference: lastQuoteReference } : {}),
			});
		}
		if (execution) {
			// The next eligible attempt owns the deadline facts. Retain the last
			// response until this point so all-skipped candidates can still return it.
			void execution.response?.body?.cancel('provider_endpoint_failed').catch(() => undefined);
			execution.priorQuotedAttempt = execution.quoteAttemptReference
				? {
					route: execution.route,
					quoteAttemptReference: execution.quoteAttemptReference,
					outcomeUnknown: execution.outcomeUnknown,
					dispatchStarted: execution.dispatchStarted,
					upstreamRequestId: execution.upstreamRequestId,
					usagePromise: execution.usagePromise,
				} : undefined;
			execution.route = route;
			execution.quoteAttemptReference = null;
			execution.dispatchStarted = false;
			execution.outcomeUnknown = false;
			execution.upstreamRequestId = null;
			execution.response = undefined;
			execution.usagePromise = Promise.resolve(EMPTY_USAGE);
		}
		const isStickyAttempt =
			Boolean(stickyRoute)
			&& route.targetId === stickyRoute!.targetId
			&& !stickyTargetAttempted;
		if (
			options?.crossModelCandidateFailover === true
			&& lastDispatchedCandidateIndex != null
			&& candidateIndex != null
			&& candidateIndex !== lastDispatchedCandidateIndex
		) {
			timing?.markModelTransition();
		}
		if (candidateIndex != null) lastDispatchedCandidateIndex = candidateIndex;

		const timingAttempt = timing?.startAttempt(route);
		lastTimingAttempt = timingAttempt;
		const hasNextAttempt = attemptIndex < attempts.length - 1;
		console.log(
			`[Gateway Proxy] calling provider providerId=${route.providerId} model=${route.providerModelName}${isStickyAttempt ? ' sticky=1' : ''}`
		);
		const delegateAdmissionBoundary =
			options?.delegateBeforeUpstreamDispatchToDriver === true;
		// The callback owns credential-aware policy. Always invoke it for private
		// BYOK too: it may no-op, reserve only the Gateway Key limit, or atomically
		// extend that lease before a later shared/platform fallback.
		const budgetAdmissionRequired = options?.beforeUpstreamDispatch != null;
		if (!delegateAdmissionBoundary && budgetAdmissionRequired) {
			try {
				await options?.beforeUpstreamDispatch?.(route);
				deadline?.throwIfStopped();
			} catch (error) {
				if (!(error instanceof RequestBudgetAdmissionError)) throw error;
				timing?.markFinalAttempt(timingAttempt);
				return finish({
					response: gatewayErrorResponse({
						status: error.status,
						code: error.code,
						message: error.message,
					}),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
					chosenRoute: route,
					circuitEvents,
					suppressErrorAlert: true,
					meta: {
						gatewayGeneratedError: true,
						failoverForbidden: true,
						admissionDeniedPreDispatch: true,
					},
				});
			}
		}
		let admissionBoundaryFailed = false;
		let durableAdmissionGranted = false;
		let pendingAdmission: Promise<void> | undefined;
		let quoteReference: SharedKeyQuoteAttemptReference | null = null;
		let fetchBoundaryReached = false;
		let stickyAttemptDispatched = false;
		const markStickyAttemptDispatched = (): void => {
			if (!isStickyAttempt || !stickySession) return;
			stickyTargetAttempted = true;
			stickyAttemptDispatched = true;
			stickySession.attemptedTargetId = route.targetId;
		};
		const beforeFetch = delegateAdmissionBoundary
			? async (preparedAttempt?: unknown): Promise<void> => {
				try {
					deadline?.throwIfStopped();
					if (options?.requirePreparedTextAttemptIdentity === true
						&& !preparedTextAttemptMatchesRoute(preparedAttempt, route)) {
						throw new RequestBudgetAdmissionError({
							code: GatewayErrorCode.permissionDenied,
							message: 'Text dispatch identity could not be verified',
						});
					}
						if (options?.stopAfterFirstGrantedDispatch === true) {
							if (singleGrantBoundaryEntered) {
								throw new Error('Single-grant dispatch boundary was already entered');
							}
							singleGrantBoundaryEntered = true;
						}
						dispatchBudget.assertAvailable();
						if (options?.quoteAttemptCapture) {
							const claimQuote = async (): Promise<SharedKeyQuoteAttemptReference | null> => {
								const claimed = await options.quoteAttemptCapture!.beforeFetch(route);
								if (execution) execution.quoteAttemptReference = claimed;
								return claimed;
							};
							quoteReference = await (deadline
								? deadline.runOwnedMutation(claimQuote) : claimQuote());
						}
						deadline?.throwIfStopped();
						pendingAdmission = options?.beforeUpstreamDispatch?.(route, preparedAttempt);
						await pendingAdmission;
						durableAdmissionGranted = true;
						deadline?.throwIfStopped();
						// Recheck after the await: another branch can share this budget.
						dispatchBudget.consume();
						if (quoteReference) {
							options?.quoteAttemptCapture?.fetchBoundaryPermitted(quoteReference);
							fetchBoundaryReached = true;
						}
						if (execution) { execution.outcomeUnknown = true; execution.dispatchStarted = true; }
					} catch (error) {
						admissionBoundaryFailed = true;
						throw error;
					}
					markStickyAttemptDispatched();
				}
			: undefined;

		let response: Response;
		let usagePromise: Promise<UsageFromStream>;
		let upstreamRequestId: string | null = null;
		let dispatchMeta: ProxyDispatchMeta | undefined;
		const upstreamHeadersObserved = (status: number): void => {
			if (quoteReference) options?.quoteAttemptCapture?.upstreamHeadersObserved(quoteReference, status);
		};
		try {
			// Delegated drivers mark the attempt at their pre-fetch boundary so a
			// local preparation/admission failure cannot masquerade as upstream I/O.
			if (!beforeFetch) {
				// Drivers not yet audited at fetch claim conservatively at entry.
				dispatchBudget.consume();
				if (execution) { execution.outcomeUnknown = true; execution.dispatchStarted = true; }
				markStickyAttemptDispatched();
			}
			const run = () => dispatch(route, requestSignal, timing, timingAttempt, beforeFetch,
				dispatchBudget.auxiliaryAuth, upstreamHeadersObserved);
			const dispatched = deadline
				? await deadline.wait(run, (late) => { void late.response.body?.cancel('request_execution_stopped').catch(() => undefined); })
				: await run();
			response = dispatched.response;
			usagePromise = dispatched.usagePromise;
			upstreamRequestId = dispatched.upstreamRequestId;
			dispatchMeta = dispatched.meta;
			if (execution) {
				execution.usagePromise = usagePromise;
				execution.upstreamRequestId = upstreamRequestId;
				execution.response = response;
				execution.outcomeUnknown = response.ok || dispatchMeta?.upstreamOutcomeUnknown === true;
			}
		} catch (err) {
			if (quoteReference && fetchBoundaryReached) {
				options?.quoteAttemptCapture?.transportAmbiguous(quoteReference);
			}
			if (err instanceof RequestExecutionStoppedError) {
				// Do not orphan a durable reservation that may commit after expiry.
				// Its caller still owns normal settlement; the late driver cannot send
				// because the delegated boundary rechecks the stopped deadline.
				await pendingAdmission;
				if (execution?.outcomeUnknown) {
					timing?.markAttemptError(timingAttempt, err, { clientCancelled: err.reason === 'client_cancelled' });
					recordDispatchAttempt({
						candidateIndex, modelId: route.gatewayModelId ?? null,
						globalEndpointRank: route.gatewayGlobalEndpointRank ?? null,
						routeTargetId: route.targetId, providerId: route.providerId,
						status: null, outcome: 'fetch_error',
					});
				}
				timing?.markFinalAttempt(timingAttempt);
				throw err;
			}
			if (err instanceof RequestDispatchLimitError) {
				timing?.markFinalAttempt(timingAttempt);
				return finish({
					...dispatchLimitResult(quoteReference || !lastResponse || !lastQuoteReference
						? route : lastRoute, circuitEvents),
					...(quoteReference || (lastResponse && lastQuoteReference)
						? { quoteAttemptReference: quoteReference ?? lastQuoteReference } : {}),
				});
			}
			if (err instanceof RequestAuxiliaryAuthLimitError) {
				// A local auth stop is not a billable inference outcome or a
				// provider fault. Do not trip circuits or continue outer model loops.
				timing?.markFinalAttempt(timingAttempt);
				return finish({
					...dispatchLimitResult(quoteReference || !lastResponse || !lastQuoteReference
						? route : lastRoute,
						circuitEvents, true),
					...(quoteReference || (lastResponse && lastQuoteReference)
						? { quoteAttemptReference: quoteReference ?? lastQuoteReference } : {}),
				});
			}
			// Admission persistence is a local fail-closed error, not an upstream
			// network failure and must never trigger provider/model failover.
			if (admissionBoundaryFailed) {
				if (!(err instanceof RequestBudgetAdmissionError)) throw err;
				timing?.markFinalAttempt(timingAttempt);
				return finish({
					response: gatewayErrorResponse({
						status: err.status,
						code: err.code,
						message: err.message,
					}),
					...(quoteReference ? { quoteAttemptReference: quoteReference } : {}),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
					chosenRoute: route,
					circuitEvents,
					suppressErrorAlert: true,
					meta: {
						gatewayGeneratedError: true,
						failoverForbidden: true,
						admissionDeniedPreDispatch: true,
					},
				});
			}
			timing?.markAttemptError(timingAttempt, err, {
				clientCancelled: requestSignal?.aborted === true,
			});
			const errMessage = err instanceof Error ? err.message : String(err);
			console.warn(
				`[Gateway Proxy] fetch failed providerId=${route.providerId} error=${errMessage}`
			);
			const fetchClassification = classifyUpstreamFetchFailure();
			if (
				stickySession &&
				stickyAttemptDispatched &&
				shouldInvalidateStickyBinding(fetchClassification)
			) {
				await clearSticky();
				stickyAttemptCleared = true;
			}
			// 与 route_resolution_failed 一致：把 fetch 层原文带给客户端（DNS/TLS/abort 等，不含凭据）
			const outcomeUnknown = thrownOutcomeIsUnknown(err);
			lastResponse = gatewayErrorResponse({
				status: 502,
				code: GatewayErrorCode.upstreamRequestFailed,
				message: outcomeUnknown
					? 'Upstream request outcome could not be confirmed; the request was not replayed'
					: errMessage.trim()
					? `Upstream request failed: ${errMessage.trim()}`
					: 'Upstream request failed',
			});
			lastRoute = route;
			lastQuoteReference = quoteReference;
			recordDispatchAttempt({
				candidateIndex,
				modelId: route.gatewayModelId ?? null,
				globalEndpointRank: route.gatewayGlobalEndpointRank ?? null,
				routeTargetId: route.targetId,
				providerId: route.providerId,
				status: null,
				outcome: 'fetch_error',
			});
			if (outcomeUnknown || (options?.stopAfterFirstGrantedDispatch === true && durableAdmissionGranted)) {
				timing?.markFinalAttempt(timingAttempt);
				return finish({
					response: lastResponse,
					...(quoteReference ? { quoteAttemptReference: quoteReference } : {}),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId: null,
					chosenRoute: route,
					circuitEvents,
					suppressErrorAlert: false,
					meta: {
						...(outcomeUnknown ? { upstreamOutcomeUnknown: true } : {}),
						failoverForbidden: true,
					},
				});
			}
			if (hasNextAttempt) timing?.markAttemptFailover(timingAttempt);
			lastDispatchMeta = undefined;
			continue;
		}

		lastResponse = response;
		lastRoute = route;
		lastQuoteReference = quoteReference;

		if (isSuccessfulDispatchResponse(response)) {
			recordDispatchAttempt({
				candidateIndex,
				modelId: route.gatewayModelId ?? null,
				globalEndpointRank: route.gatewayGlobalEndpointRank ?? null,
				routeTargetId: route.targetId,
				providerId: route.providerId,
				status: response.status,
				outcome: 'success',
			});
			timing?.markFinalAttempt(timingAttempt);
			markProviderSuccess(circuitKeyForRoute(route));
			if (stickySession) {
				const stickySuccessPolicy = options?.stickySuccessPolicy ?? null;
				const routeEligible = stickyRouteEligible?.(route) ?? true;
				const completedSuccess = stickySuccessPolicy == null
					? null
					: usagePromise.then(
							(usage) =>
								usage.cancelled !== true
								&& !usage.stream_error,
							() => false,
						);
				const bindReady = stickySuccessPolicy === 'cache_hit'
					? usagePromise.then(
							(usage) =>
								usage.cancelled !== true
								&& !usage.stream_error
								&& Number.isSafeInteger(usage.cache_read_tokens)
								&& usage.cache_read_tokens > 0,
							() => false,
						)
					: completedSuccess;
				if (stickyAttemptDispatched && stickySession.bindingToken) {
					if (completedSuccess) {
						scheduleStickyTouchAfter(repos, stickySession, completedSuccess);
					} else {
						scheduleStickyTouchIfNeeded(repos, stickySession);
					}
				} else if (
					stickySession.lookup !== 'invalid_circuit'
					&& !(stickySession.lookup === 'hit' && stickySession.attemptedTargetId == null)
					&& routeEligible
				) {
					// A primary BYOK route can legitimately succeed before a sticky
					// target in the later shared/platform section. Preserve the valid
					// binding when it was never actually attempted by this request.
					// invalid_circuit: keep the existing binding until the provider cools down;
					// tryBind would lose to CAS on a still-fresh row.
					const bindOptions = {
						rebound:
							stickyAttemptCleared ||
							stickySession.lookup === 'hit' ||
							stickySession.lookup === 'invalid_target',
					};
					if (bindReady) {
						scheduleStickyBindAfter(repos, stickySession, route, bindReady, bindOptions);
					} else {
						scheduleStickyBind(repos, stickySession, route, bindOptions);
					}
				}
			}
			const successfulMeta = unknownOutcomeObserved
				? { ...(dispatchMeta ?? {}), upstreamOutcomeUnknown: true as const }
				: dispatchMeta;
			return finish({
				response,
				...(quoteReference ? { quoteAttemptReference: quoteReference } : {}),
				usagePromise,
				upstreamRequestId,
				chosenRoute: route,
				circuitEvents,
				suppressErrorAlert: false,
				meta: successfulMeta,
			});
		}
		unknownOutcomeObserved ||= dispatchMeta?.upstreamOutcomeUnknown === true;
		const stopAfterGrantedDispatch = options?.stopAfterFirstGrantedDispatch === true && durableAdmissionGranted;
		const replayForbidden = dispatchMeta?.failoverForbidden === true || unknownOutcomeObserved || stopAfterGrantedDispatch;
		lastDispatchMeta = unknownOutcomeObserved
			? {
					...(dispatchMeta ?? {}),
					upstreamOutcomeUnknown: true,
					failoverForbidden: true,
				}
			: stopAfterGrantedDispatch
				? { ...(dispatchMeta ?? {}), failoverForbidden: true }
				: dispatchMeta;

		const classification: UpstreamFailureClassification = shouldFailImmediatelyForImageAbort(dispatchMeta)
			|| dispatchMeta?.failoverForbidden === true || unknownOutcomeObserved
			? { action: 'fail_immediately' }
			: classifyUpstreamHttpFailure(response.status);
		const attemptTrace: ProxyDispatchAttemptTrace = {
			candidateIndex,
			modelId: route.gatewayModelId ?? null,
			globalEndpointRank: route.gatewayGlobalEndpointRank ?? null,
			routeTargetId: route.targetId,
			providerId: route.providerId,
			status: response.status,
			outcome: 'error',
			contentType: response.headers.get('content-type'),
		};
		if (options?.crossModelCandidateFailover === true) {
			try {
				attemptTrace.errorBodyText = await responseTextWithinLimit(
					response.clone(),
					MAX_DISPATCH_TRACE_ERROR_BODY_BYTES,
					requestSignal,
				);
			} catch (error) {
				attemptTrace.errorBodyText = null;
				if (error instanceof RequestExecutionStoppedError) {
					recordDispatchAttempt(attemptTrace);
					timing?.markFinalAttempt(timingAttempt);
					throw error;
				}
			}
		}
		recordDispatchAttempt(attemptTrace);
		if (!stopAfterGrantedDispatch) logProviderSwitchAlert(route, classification, response.status);

		if (
			stickySession &&
			stickyAttemptDispatched &&
			shouldInvalidateStickyBinding(classification, {
				imageAbort: shouldFailImmediatelyForImageAbort(dispatchMeta),
			})
		) {
			await clearSticky();
			stickyAttemptCleared = true;
		}

		if (classification.action === 'fail_immediately') {
			const mayContinueWithAnotherModel =
				options?.crossModelCandidateFailover === true
				&& candidateIndex != null
				&& !replayForbidden
				&& !shouldFailImmediatelyForImageAbort(dispatchMeta);
			if (mayContinueWithAnotherModel) {
				blockedCandidateIndexes.add(candidateIndex);
				if (hasLaterEligibleAttempt(attemptIndex)) {
					timing?.markAttemptFailover(timingAttempt);
					void response.body?.cancel('model_candidate_rejected').catch(() => undefined);
					continue;
				}
			}
			if (!options?.deferFinalAttempt || replayForbidden) {
				timing?.markFinalAttempt(timingAttempt);
			}
			return finish({
				response,
				...(quoteReference ? { quoteAttemptReference: quoteReference } : {}),
				usagePromise: replayForbidden
					? usagePromise
					: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId,
				chosenRoute: route,
				circuitEvents,
				suppressErrorAlert: false,
				meta: lastDispatchMeta,
			});
		}

		if (classification.failureKind) {
			// 共享 key 鉴权失败：永久移出池（DB 置 invalid），仅复合键短熔断
			const sharedKeyId = parseSharedKeyId(route.providerKeyId);
			if (sharedKeyId && classification.alertOnKeySwitch) {
				const failureReason = `upstream auth rejected (HTTP ${response.status})`;
				void repos.sharedKeys
					.markSharedKeyFailure(sharedKeyId, failureReason, new Date().toISOString())
					.catch((err) => {
						console.warn(
							`[Gateway SharedKeys] disable failed keyId=${sharedKeyId} error=${err instanceof Error ? err.message : String(err)}`
						);
					});
			}
			const circuitResult = markProviderFailure(
				circuitKeyForRoute(route),
				classification.failureKind,
				classification.failureKind === 'rate_limit'
					? parseRetryAfterMs(response.headers.get('retry-after'))
					: null
			);
			if (circuitResult.openedOrExtended) {
				circuitEvents.push({
					kind: 'provider',
					providerId: route.providerId,
					providerName: route.providerName,
					keyFingerprint:
						route.providerKeyFingerprint ?? fingerprintProviderApiKey(route.providerApiKey),
					failureKind: circuitResult.failureKind,
					openUntil: circuitResult.openUntil,
					cooldownMs: circuitResult.cooldownMs,
					openedOrExtended: true,
				});
			}
		}
		if (stopAfterGrantedDispatch) {
			timing?.markFinalAttempt(timingAttempt);
			return finish({
				response,
				...(quoteReference ? { quoteAttemptReference: quoteReference } : {}),
				usagePromise,
				upstreamRequestId,
				chosenRoute: route,
				circuitEvents,
				suppressErrorAlert: false,
				meta: lastDispatchMeta,
			});
		}
		if (hasNextAttempt) timing?.markAttemptFailover(timingAttempt);
		console.warn(
			`[Gateway Proxy] provider non-OK, trying next candidate providerId=${route.providerId} status=${response.status}`
		);
		if (
			options?.crossModelCandidateFailover === true
			&& hasLaterEligibleAttempt(attemptIndex)
		) {
			void response.body?.cancel('provider_endpoint_failed').catch(() => undefined);
		}
	}

	if (!lastResponse) {
		return finish({
			response: gatewayErrorResponse({
				status: 502,
				code: GatewayErrorCode.noRoute,
				message: 'No supported upstream protocol route available',
			}),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
			chosenRoute: lastRoute,
			circuitEvents,
			suppressErrorAlert: false,
		});
	}

	if (!options?.deferFinalAttempt) timing?.markFinalAttempt(lastTimingAttempt);
	return finish({
		response: lastResponse,
		...(lastQuoteReference ? { quoteAttemptReference: lastQuoteReference } : {}),
		usagePromise: Promise.resolve(EMPTY_USAGE),
		upstreamRequestId: null,
		chosenRoute: lastRoute,
		circuitEvents,
		suppressErrorAlert: false,
		meta: lastDispatchMeta,
	});
}

/** @deprecated 使用 {@link failoverDispatch} */
export const failoverDispatchWithKeyPool = failoverDispatch;
