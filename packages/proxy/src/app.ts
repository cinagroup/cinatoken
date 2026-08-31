import type { D1Database, RateLimit } from "@cloudflare/workers-types";
import type {
	GatewayRepositories,
	HyperdriveBinding,
	ManagementApiKeyPrincipal,
	StorageContext,
} from "@octafuse/core";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { ApiKeyContext } from "./middleware/auth";
import { healthRoutes } from "./routes/health";
import { chatRoutes } from "./routes/v1/chat";
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
import { createPresetCaptureRoutes } from "./routes/v1/presets";
import { embeddingsRoutes } from "./routes/v1/embeddings";
import { createOpenRouterPublicCatalogRoutes } from "./routes/v1/openrouter-public-catalog";
import { managementKeyRoutes } from "./routes/v1/management-keys";
import { managementWorkspaceBudgetRoutes } from "./routes/v1/management-workspace-budgets";
import { currentKeyRoutes } from "./routes/v1/current-key";
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

/** Cloudflare Worker bindings：D1 `DB`，或显式选择 Hyperdrive Postgres。 */
export type GatewayBindings = {
	DB?: D1Database;
	HYPERDRIVE?: HyperdriveBinding;
	SHARED_KEY_ENCRYPTION_SECRET?: string;
	/** DeepSeek official upstream key; configured as a Worker Secret. */
	DEEPSEEK_API_KEY?: string;
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
};

export type Env = {
	Bindings: GatewayBindings;
	Variables: {
		apiKey?: ApiKeyContext;
		managementKey?: ManagementApiKeyPrincipal;
		generationId?: string;
		repositories: GatewayRepositories;
		requestBodyLoggingMode: RequestBodyLoggingMode;
	};
};

export type StorageResolver = (
	context: Context<Env>
) => Promise<StorageContext>;

export type ProxyAppOptions = {
	/**
	 * 在所有其它中间件（含 logger / CORS / 存储）之前执行。
	 * Worker 场景下用于尽早校验数据库绑定：Cloudflare 仅在请求进入 fetch 时注入 `env`，无独立「进程启动」钩子，故最早失败点为首个请求的此处。
	 */
	beforeAll?: MiddlewareHandler<Env>;
	/** Node runtime override；Workers 默认读取 REQUEST_BODY_LOGGING binding。 */
	requestBodyLogging?: string;
	/** Node/Docker runtime fallback；Workers 使用平台 Cache API 与 rate-limit binding。 */
	publicStatsRuntime?: PublicStatsRuntimeGuard;
};

export function createProxyApp(
	resolveStorage: StorageResolver,
	options?: ProxyAppOptions
): Hono<Env> {
	const app = new Hono<Env>();
	const {
		publicCatalogRoutes: openRouterPublicCatalogRoutes,
		providersAliasRoutes: openRouterProvidersAliasRoutes,
	} = createOpenRouterPublicCatalogRoutes(options?.publicStatsRuntime);

	if (options?.beforeAll) {
		app.use("*", options.beforeAll);
	}

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
	app.use(
		"*",
		bodyLimit({
			maxSize: 50 * 1024 * 1024,
			onError: (c) =>
				gatewayErrorJson(c, {
					status: 413,
					code: GatewayErrorCode.payloadTooLarge,
					message: "Request body exceeds the maximum allowed size",
				}),
		})
	);
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
				options?.requestBodyLogging ?? c.env.REQUEST_BODY_LOGGING
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
		const storage = await resolveStorage(c);
		c.set("repositories", storage.repositories);
		await next();
	});

	app.route("/health", healthRoutes);
	app.route("/v1", endpointDiscoveryRoutes);
	app.route("/v1/generation", generationRoutes);
	app.route("/v1/chat/completions", chatRoutes);
	app.route("/v1/responses", responsesRoutes);
	app.route("/v1/embeddings", embeddingsRoutes);
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
	// OpenRouter-compatible base URL. Inference handlers remain authenticated;
	// the exact catalog reads below mirror OpenRouter's anonymous live surfaces.
	// OpenRouter's canonical catalog is anonymous. Register it before the
	// authenticated discovery router so only the exact public model/provider
	// paths are widened; ZDR and Image discovery remain authenticated below.
	app.route("/api/v1", openRouterPublicCatalogRoutes);
	app.route("/api/v1/key", currentKeyRoutes);
	app.route("/api/v1/keys", managementKeyRoutes);
	app.route("/api/v1/workspaces", managementWorkspaceBudgetRoutes);
	app.route("/api/v1", endpointDiscoveryRoutes);
	app.route("/api/v1/generation", generationRoutes);
	app.route("/api/v1/chat/completions", chatRoutes);
	app.route("/api/v1/responses", responsesRoutes);
	app.route("/api/v1/embeddings", embeddingsRoutes);
	app.route("/api/v1/images", imageRoutes);
	app.route("/api/v1/audio", audioRoutes);
	app.route("/api/v1/messages", messagesRoutes);
	app.route("/catalog", createCatalogRoutes(options?.publicStatsRuntime));
	const presetCaptureRoutes = createPresetCaptureRoutes(
		async (c, targetPath, body) => {
			const targetUrl = new URL(c.req.url);
			targetUrl.pathname = targetPath;
			targetUrl.search = "";
			const headers = new Headers(c.req.raw.headers);
			headers.delete("content-length");
			const request = new Request(targetUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: c.req.raw.signal,
			});
			try {
				return await app.fetch(request, c.env, c.executionCtx);
			} catch {
				return app.fetch(request, c.env);
			}
		}
	);
	app.route("/api/v1/presets", presetCaptureRoutes);
	app.route("/v1/presets", presetCaptureRoutes);

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
