import type { D1Database, Queue, R2Bucket, RateLimit } from "@cloudflare/workers-types";
import type {
	BatchDispatchMessage,
	GatewayRepositories,
	HyperdriveBinding,
	ManagementApiKeyPrincipal,
	StorageContext,
} from "@octafuse/core";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { isAtomicImageBudgetRoute, requireApiKey, type ApiKeyContext } from "./middleware/auth";
import { healthRoutes } from "./routes/health";
import { chatRoutes } from "./routes/v1/chat";
import { completionsRoutes } from "./routes/v1/completions";
import { responsesRoutes } from "./routes/v1/responses";
import { geminiRoutes } from "./routes/v1/gemini";
import { meRoutes } from "./routes/v1/me";
import { messagesRoutes } from "./routes/v1/messages";
import { createCatalogRoutes } from "./routes/catalog";
import { modelsRoutes } from "./routes/v1/models";
import { endpointDiscoveryRoutes } from "./routes/v1/endpoints";
import { generationRoutes } from "./routes/v1/generation";
import { webSearchRoutes } from "./routes/v1/tools/web-search";
import { webFetchRoutes } from "./routes/v1/tools/web-fetch";
import { webDeepSearchRoutes } from "./routes/v1/tools/web-deep-search";
import { aiDetectionRoutes } from "./routes/v1/tools/ai-detection";
import { toolsPricingRoutes } from "./routes/v1/tools/pricing";
import { imageRoutes } from "./routes/v1/images";
import { audioRoutes } from "./routes/v1/audio";
import { dashScopeRealtimeRoutes } from "./routes/v1/dashscope-realtime";
import { dashScopeMultimodalRoutes } from "./routes/v1/dashscope-multimodal";
import { presetRoutes } from "./routes/v1/presets";
import { embeddingsRoutes } from "./routes/v1/embeddings";
import { rerankRoutes } from "./routes/v1/rerank";
import { createOpenRouterPublicCatalogRoutes } from "./routes/v1/openrouter-public-catalog";
import { managementKeyRoutes } from "./routes/v1/management-keys";
import { managementWorkspaceRoutes } from "./routes/v1/management-workspaces";
import { managementWorkspaceBudgetRoutes } from "./routes/v1/management-workspace-budgets";
import { managementGuardrailRoutes } from "./routes/v1/management-guardrails";
import { byokRoutes } from "./routes/v1/byok";
import { currentKeyRoutes } from "./routes/v1/current-key";
import { analyticsRoutes } from "./routes/v1/analytics";
import { proxyAppVersion } from "./app-version";
import type { DashScopeRealtimeNodeDispatch } from "./services/egress/dashscope-realtime-driver";
import {
	resolveRequestBodyLoggingMode,
	type RequestBodyLoggingMode,
} from "./services/request-body-log-policy";
import type { PublicStatsRuntimeGuard } from "./services/public-stats-runtime-guard";
import {
	GATEWAY_ERROR_CODE_HEADER,
	GatewayErrorCode,
} from "./services/gateway-error-codes";
import { gatewayErrorJson } from "./services/gateway-error-response";
import { MAX_REQUEST_BODY_BYTES } from "./services/bounded-request-body";
import type { RequestCapacityLease } from "./services/request-capacity";
import { resolveRequestStorage } from './runtime/resolve-request-storage';
import { scheduleResourceCompletion } from './runtime/schedule-resource-completion';
import { observeResourceCleanup } from './services/resource-completion';
import { requestCapacityMiddleware, type HttpRequestCapacityPolicy } from "./middleware/request-capacity";
import type { SharedKeyEconomicProducer } from './services/shared-key-quote-attempt';
import type {
	PostgresChatBudgetRequestOwner,
	PostgresChatBudgetRequestOwnerParams,
} from './services/postgres-chat-budget-request-owner';
import {
	createCredentialFreeChatIngressV401,
	type CredentialFreeChatIngressCompositionV401,
} from './services/credential-free-chat-ingress-v401';
import { createImageUsageRecoveryFactory, type ImageUsageRecoveryFactory, type ImageUsageRecoveryOptions } from "./services/image-usage-recovery";
import {
	createPostgresImageUsageRecoveryFactory,
	type PostgresImageRecoveryAuthorities,
} from './services/image-usage-recovery-postgres';
import {
	assertTextRequestActive, textRequestFailureResponse, textRequestLifecycle,
	type TextRequestLifecycle,
} from "./middleware/text-request-lifecycle";

/** Cloudflare Worker bindings：D1 `DB`，或显式选择 Hyperdrive Postgres。 */
export type GatewayBindings = {
	DB?: D1Database;
	HYPERDRIVE?: HyperdriveBinding;
	/** Review-only separate Images dispatch authority; never the ordinary runtime origin. */
	DISPATCH_HYPERDRIVE?: HyperdriveBinding;
	/** Review-only separate Images fact/job authority; never the ordinary runtime origin. */
	FACT_HYPERDRIVE?: HyperdriveBinding;
	/** Review-only shared-key usage repair LOGIN; never reuse the request Hyperdrive. */
	REPAIR_HYPERDRIVE?: HyperdriveBinding;
	/** Review-only dedicated quote-attempt producer LOGIN; never ordinary runtime. */
	QUOTE_ATTEMPT_HYPERDRIVE?: HyperdriveBinding;
	/** Absent by default; requires injected economic producer before any shared-key send. */
	SHARED_KEY_QUOTE_ATTEMPTS_ENABLED?: string;
	/** Review-only Chat budget quote binding; absent in shipped configurations. */
	AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED?: string;
	/** Review-only explicit request owner; absent from shipped configurations. */
	POSTGRES_CHAT_BUDGET_OWNER_ENABLED?: string;
	/** Default-off exact activation for server-composed v401 Chat; shipped configs omit it. */
	CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED?: string;
	/** Dedicated LOGINs for the default-off Chat budget request owner. */
	BUDGET_ADMISSION_HYPERDRIVE?: HyperdriveBinding;
	BUDGET_RECOVERY_HYPERDRIVE?: HyperdriveBinding;
	/** Exact opt-in for the separate scheduled repair consumer. Shipped config omits it. */
	SHARED_KEY_USAGE_REPAIR_ENABLED?: string;
	SHARED_KEY_ENCRYPTION_SECRET?: string;
	/** DeepSeek official upstream key; configured as a Worker Secret. */
	DEEPSEEK_API_KEY?: string;
	/** Private Batch request/result object storage; emitted only with explicit infra opt-in. */
	BATCH_BUCKET?: R2Bucket;
	/** Prompt-free Batch dispatch queue producer; emitted only with explicit infra opt-in. */
	BATCH_QUEUE?: Queue<BatchDispatchMessage>;
	/** Phase 2 keeps all public Batch routes off even when infrastructure is staged. */
	BATCH_API_ENABLED?: string;
	/** Deployment-specific DLQ name used to distinguish terminal queue delivery. */
	BATCH_QUEUE_DLQ?: string;
	/** 省略时保持 D1；只有 `postgres` 会切换到 `HYPERDRIVE`。 */
	DATABASE_DRIVER?: string;
	/** 最终数据库切换窗口内，在任何存储访问之前拒绝外部 HTTP 流量。 */
	CINATOKEN_MAINTENANCE_MODE?: string;
	/** 请求正文日志策略：默认 off；仅显式 redacted 时写入已脱敏正文。 */
	REQUEST_BODY_LOGGING?: string;
	/** Node upgrade 请求临时注入的实时 WebSocket 调度器；不作为 Worker binding。 */
	NODE_REALTIME_DISPATCH?: DashScopeRealtimeNodeDispatch;
	/** Workers rate-limiting binding：认证失败限速；未注入时跳过。 */
	AUTH_RATE_LIMITER?: RateLimit;
	/** 兼容旧环境变量名；新部署使用 AUTH_RATE_LIMITER。 */
	RATE_LIMITER?: RateLimit;
	/** 公开统计缓存未命中时的独立限流器。 */
	PUBLIC_STATS_RATE_LIMITER?: RateLimit;
	/** Management Analytics Query：每个 Management Key 每分钟最多 64 次。 */
	ANALYTICS_RATE_LIMITER?: RateLimit;
	/** CinaAuth organization roles that project to Workspace API admin membership. */
	CINAAUTH_ORGANIZATION_ADMIN_ROLES?: string;
	/** Credential-free endpoint uptime fact retention (2..30 days; default 7). */
	PROVIDER_ATTEMPT_RETENTION_DAYS?: string;
	/** Per-statement retention delete cap (1..5000; default 5000). */
	PROVIDER_ATTEMPT_RETENTION_BATCH_SIZE?: string;
	/** Per-Cron statement cap (1..20; default 10). */
	PROVIDER_ATTEMPT_RETENTION_MAX_BATCHES?: string;
};

export type Env = {
	Bindings: GatewayBindings;
	Variables: {
		apiKey?: ApiKeyContext;
		managementKey?: ManagementApiKeyPrincipal;
		generationId?: string;
		textRequestLifecycle?: TextRequestLifecycle;
		requestCapacityLease?: RequestCapacityLease;
		/** Server-composed Images transport; never resolved from a request body/header. */
		imageFetch?: typeof fetch;
		imageUsageRecovery?: ImageUsageRecoveryFactory;
		sharedKeyEconomicProducer?: SharedKeyEconomicProducer;
		chatBudgetRequestOwnerFactory?: (
			params: PostgresChatBudgetRequestOwnerParams,
		) => Promise<PostgresChatBudgetRequestOwner>;
		requestStorage?: StorageContext;
		organizationAdminRoles: string | undefined;
		repositories: GatewayRepositories;
		requestBodyLoggingMode: RequestBodyLoggingMode;
	};
};

export type StorageResolver = (
	context: Context<Env>
) => Promise<StorageContext>;

/** Per-request, server-owned producer clients; close must account for both origins. */
export type PostgresImageRecoveryAppOptions = Readonly<{
	maxAttempts: 1 | 2 | 3;
	open(context: Context<Env>, storage: StorageContext): Promise<Readonly<{
		authorities: PostgresImageRecoveryAuthorities;
		close(): Promise<void>;
	}>>;
}>;

export type ProxyAppOptions = {
	/** Required to detach cancelled initialization. Workers close unused clients; Node retains its shared pool. */
	disposeUnusedStorage?: (storage: StorageContext) => Promise<void>;
	/** Explicit transport composition (e.g. a private staging service binding). Default: native fetch. */
	imageFetch?: typeof fetch;
	/** Disabled by default. Local D1 recovery proposal; ordinary Images only, not an SSE guarantee. */
	imageUsageRecovery?: ImageUsageRecoveryOptions;
	/** Disabled by default. Explicit PG producer owner for nonstreaming Images POST only. */
	postgresImageRecovery?: PostgresImageRecoveryAppOptions;
	/** Review-only quote + economic event composition. Shipped runtimes omit it. */
	sharedKeyEconomicProducer?: SharedKeyEconomicProducer;
	/** Review-only explicit owner factory; production uses direct LOGIN bindings. */
	chatBudgetRequestOwnerFactory?: (
		params: PostgresChatBudgetRequestOwnerParams,
	) => Promise<PostgresChatBudgetRequestOwner>;
	/** Server-only staged Chat authority. Shipped runtimes omit this option; Linux CI has not run. */
	credentialFreeChatV401?: CredentialFreeChatIngressCompositionV401;
	/** Opt-in HTTP-only capacity contract; runtime weights/enabling require separate validation. */
	httpCapacity?: HttpRequestCapacityPolicy;
	/**
	 * 在 logger / CORS / 存储之前执行；已接入的文本/向量生命周期先记录请求到达时间。
	 * Worker 场景下用于尽早校验数据库绑定：Cloudflare 仅在请求进入 fetch 时注入 `env`，无独立「进程启动」钩子，故最早失败点为首个请求的此处。
	 */
	beforeAll?: MiddlewareHandler<Env>;
	/** Node runtime override；Workers 默认读取 REQUEST_BODY_LOGGING binding。 */
	requestBodyLogging?: string;
	/** Node/Docker runtime fallback；Workers 使用平台 Cache API 与 rate-limit binding。 */
	publicStatsRuntime?: PublicStatsRuntimeGuard;
	/** Node runtime override；Workers read the CinaAuth role mapping from bindings. */
	organizationAdminRoles?: string;
};

export function createProxyApp(
	resolveStorage: StorageResolver,
	options?: ProxyAppOptions
): Hono<Env> {
	const app = new Hono<Env>();
	const credentialFreeChatIngressV401 = createCredentialFreeChatIngressV401(
		options?.credentialFreeChatV401,
		Boolean(options?.chatBudgetRequestOwnerFactory || options?.sharedKeyEconomicProducer),
	);
	const imageFetch = options?.imageFetch;
	const imageRecovery = options?.imageUsageRecovery ? Object.freeze({ ...options.imageUsageRecovery }) : undefined;
	const postgresImageRecovery = options?.postgresImageRecovery;
	if (imageFetch !== undefined && typeof imageFetch !== 'function') throw new TypeError('Invalid Images transport');
	if (postgresImageRecovery) {
		if (imageRecovery) throw new TypeError('D1 and PostgreSQL Images recovery are mutually exclusive');
		if (!options?.httpCapacity) throw new TypeError('PostgreSQL Images recovery requires explicit HTTP capacity');
		if (typeof postgresImageRecovery.open !== 'function'
			|| ![1, 2, 3].includes(postgresImageRecovery.maxAttempts)) {
			throw new TypeError('Invalid PostgreSQL Images recovery composition');
		}
	}
	// Admission must precede any upload read, storage, authentication or mutation.
	if (options?.httpCapacity) app.use("*", requestCapacityMiddleware(options.httpCapacity));
	// Capture arrival before runtime checks, upload handling, storage and auth.
	app.use("*", textRequestLifecycle);
	const {
		publicCatalogRoutes: openRouterPublicCatalogRoutes,
		managementCatalogRoutes: openRouterManagementCatalogRoutes,
		providersAliasRoutes: openRouterProvidersAliasRoutes,
	} = createOpenRouterPublicCatalogRoutes(options?.publicStatsRuntime);

	if (options?.beforeAll) {
		app.use("*", options.beforeAll);
	}
	if (imageFetch) app.use('*', async (c, next) => { c.set('imageFetch', imageFetch); await next(); });
	if (options?.sharedKeyEconomicProducer) app.use('*', async (c, next) => {
		c.set('sharedKeyEconomicProducer', options.sharedKeyEconomicProducer);
		await next();
	});
	if (options?.chatBudgetRequestOwnerFactory) app.use('*', async (c, next) => {
		c.set('chatBudgetRequestOwnerFactory', options.chatBudgetRequestOwnerFactory);
		await next();
	});

	/**
	 * Hono's default logger prints the full request URL, including query strings.
	 * Generation IDs and Gemini API keys may be carried in the query, so log only
	 * the already-parsed pathname and bounded request metadata.
	 */
	app.use("*", async (c, next) => {
		const startedAt = Date.now();
		const requestLog = {
			method: c.req.method,
			path: c.req.path,
		};
		console.log(
			JSON.stringify({ message: "gateway request started", ...requestLog })
		);
		try {
			await next();
		} finally {
			console.log(
				JSON.stringify({
					message: "gateway request completed",
					...requestLog,
					status: c.res.status,
					duration_ms: Math.max(0, Date.now() - startedAt),
				})
			);
		}
	});
	// Unbounded c.req.json()/parseBody() on the Node runtime is a memory-DoS
	// vector (Workers platforms cap bodies natively). 50 MiB covers large
	// model payloads incl. image multipart uploads.
	const legacyBodyLimit = bodyLimit({
			maxSize: MAX_REQUEST_BODY_BYTES,
			onError: (c) =>
				gatewayErrorJson(c, {
					status: 413,
					code: GatewayErrorCode.payloadTooLarge,
					message: "Request body exceeds the maximum allowed size",
				}),
		});
	app.use("*", (c, next) => c.get('textRequestLifecycle') ? next() : legacyBodyLimit(c, next));
	app.use(
		"*",
		cors({
			origin: "*",
			allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowHeaders: [
				"Content-Type",
				"Authorization",
				"HTTP-Referer",
				"X-Title",
				"X-OpenRouter-Title",
				"X-OpenRouter-Categories",
				"X-OpenRouter-Metadata",
				"X-OpenRouter-Experimental-Metadata",
			],
			exposeHeaders: [
				"X-Generation-Id",
				"Retry-After",
				"X-OctaFuse-Error-Code",
			],
		})
	);

	app.use("*", async (c, next) => {
		c.set(
			"requestBodyLoggingMode",
			resolveRequestBodyLoggingMode(
				options?.requestBodyLogging ?? c.env?.REQUEST_BODY_LOGGING
			)
		);
		await next();
	});

	/**
	 * Log bounded 4xx metadata without cloning or consuming the response body.
	 * Cloning a stream and cancelling only one tee branch can stall delivery while
	 * the client branch has not started reading. The stable error-code header is
	 * enough for aggregation; route-level diagnostics remain more specific.
	 */
	app.use("*", async (c, next) => {
		await next();
		const status = c.res.status;
		if (status < 400 || status >= 500) return;
		console.warn("[Gateway] client error response", {
			method: c.req.method,
			path: c.req.path,
			status,
			code: c.res.headers.get(GATEWAY_ERROR_CODE_HEADER),
		});
	});

	app.use("*", async (c, next) => {
		c.set(
			"organizationAdminRoles",
			options?.organizationAdminRoles ??
				c.env?.CINAAUTH_ORGANIZATION_ADMIN_ROLES
		);
		await next();
	});

	app.use("*", async (c, next) => {
		assertTextRequestActive(c);
		const storage = await resolveRequestStorage(c, resolveStorage, options?.disposeUnusedStorage);
		assertTextRequestActive(c);
		c.set("repositories", storage.repositories);
		c.set('requestStorage', storage);
		if (imageRecovery) c.set('imageUsageRecovery', createImageUsageRecoveryFactory(storage, imageRecovery));
		await next();
	});

	// The terminal Chat handler keeps capacity, upload, CORS and storage ownership.
	app.use('*', credentialFreeChatIngressV401);

	// Refuse unauthenticated Images traffic before opening two dedicated PG origins.
	// The route checks the key again; this opt-in preflight never relaxes route auth.
	app.use("*", (c, next) => postgresImageRecovery
		&& isAtomicImageBudgetRoute(c.req.method, c.req.path)
			? requireApiKey(c, next) : next());

	app.use("*", async (c, next) => {
		if (postgresImageRecovery && isAtomicImageBudgetRoute(c.req.method, c.req.path)) {
			const storage = c.get('requestStorage');
			if (!storage) throw new Error('Request storage unavailable');
			if (storage.client.driver !== 'postgres') {
				throw new TypeError('PostgreSQL Images recovery requires PostgreSQL runtime storage');
			}
			let owner: Awaited<ReturnType<PostgresImageRecoveryAppOptions['open']>>;
			try { owner = await postgresImageRecovery.open(c, storage); }
			catch (error) {
				// The opener must label a failed partial-open cleanup. Keep numeric
				// capacity held when it cannot certify both producer origins retired.
				if (error instanceof Error && error.name === 'PostgresImageProducerCleanupUnconfirmedError') {
					scheduleResourceCompletion(c, Promise.resolve('unconfirmed'));
				}
				throw error;
			}
			if (!owner || typeof owner.close !== 'function') {
				scheduleResourceCompletion(c, Promise.resolve('unconfirmed'));
				throw new TypeError('PostgreSQL Images producer owner must provide a close receipt');
			}
			try {
				c.set('imageUsageRecovery', createPostgresImageUsageRecoveryFactory(
					storage, owner.authorities, { maxAttempts: postgresImageRecovery.maxAttempts },
				));
				await next();
			} finally {
				// Current PG fast path does no SQL; all producer queries are awaited by
				// the nonstreaming route. An uncertain close keeps the capacity hold.
				scheduleResourceCompletion(c, observeResourceCleanup(() => owner.close()));
			}
			return;
		}
		await next();
	});

	app.route("/health", healthRoutes);
	app.route("/v1", endpointDiscoveryRoutes);
	app.route("/v1/generation", generationRoutes);
	app.route("/v1/chat/completions", chatRoutes);
	app.route("/v1/completions", completionsRoutes);
	app.route("/v1/responses", responsesRoutes);
	app.route("/v1/embeddings", embeddingsRoutes);
	app.route("/v1/rerank", rerankRoutes);
	app.route("/v1/images", imageRoutes);
	app.route("/v1/audio", audioRoutes);
	app.route("/v1/dashscope/realtime", dashScopeRealtimeRoutes);
	app.route(
		"/v1/dashscope/services/aigc/multimodal-generation/generation",
		dashScopeMultimodalRoutes
	);
	app.route("/v1/messages", messagesRoutes);
	app.route("/v1beta", geminiRoutes);
	app.route("/v1/me", meRoutes);
	app.route("/v1/models", modelsRoutes);
	app.route("/v1/providers", openRouterProvidersAliasRoutes);
	app.route("/v1/tools/web-search", webSearchRoutes);
	app.route("/v1/tools/web-fetch", webFetchRoutes);
	app.route("/v1/tools/web-deep-search", webDeepSearchRoutes);
	app.route("/v1/tools/ai-detection", aiDetectionRoutes);
	app.route("/v1/tools/pricing", toolsPricingRoutes);
	// OpenRouter-compatible base URL. Models and Providers remain anonymous;
	// canonical per-model Endpoints requires a Management key. Register the
	// exact contracts before the legacy Gateway-key discovery aliases below.
	app.route("/api/v1", openRouterPublicCatalogRoutes);
	app.route("/api/v1", openRouterManagementCatalogRoutes);
	app.route("/api/v1/key", currentKeyRoutes);
	app.route("/api/v1/keys", managementKeyRoutes);
	app.route("/api/v1/workspaces", managementWorkspaceRoutes);
	app.route("/api/v1/workspaces", managementWorkspaceBudgetRoutes);
	app.route("/api/v1/guardrails", managementGuardrailRoutes);
	app.route("/api/v1/byok", byokRoutes);
	app.route("/api/v1/analytics", analyticsRoutes);
	app.route("/api/v1", endpointDiscoveryRoutes);
	app.route("/api/v1/generation", generationRoutes);
	app.route("/api/v1/chat/completions", chatRoutes);
	app.route("/api/v1/completions", completionsRoutes);
	app.route("/api/v1/responses", responsesRoutes);
	app.route("/api/v1/embeddings", embeddingsRoutes);
	app.route("/api/v1/rerank", rerankRoutes);
	app.route("/api/v1/images", imageRoutes);
	app.route("/api/v1/audio", audioRoutes);
	app.route("/api/v1/dashscope/realtime", dashScopeRealtimeRoutes);
	app.route("/api/v1/messages", messagesRoutes);
	app.route("/catalog", createCatalogRoutes(options?.publicStatsRuntime));
	app.route("/api/v1/presets", presetRoutes);
	app.route("/v1/presets", presetRoutes);

	app.get("/", (c) =>
		c.json({ name: "cinatoken-proxy", version: proxyAppVersion })
	);

	app.notFound((c) =>
		gatewayErrorJson(c, {
			status: 404,
			code: GatewayErrorCode.routeNotFound,
			message: "Resource not found",
		})
	);

	app.onError((error, c) => {
		const stopped = textRequestFailureResponse(error, c);
		if (stopped) return stopped;
		console.error(
			JSON.stringify({
				message: "unhandled gateway request error",
				error_type: error.name,
				path: c.req.path,
			})
		);
		return gatewayErrorJson(c, {
			status: 500,
			code: GatewayErrorCode.internalError,
			message: "Internal server error",
		});
	});

	return app;
}
