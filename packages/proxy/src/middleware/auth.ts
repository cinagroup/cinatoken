/**
 * 用户 API 鉴权中间件：从多种客户端约定位置提取 sk，校验后写入 `c.set('apiKey', …)`。
 * 预算在「大部分路由」上于此拦截；`/v1/chat/completions` 等在具体路由内结合模型 free 通道再判断。
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { authenticateApiKey } from "../services/api-key-auth";
import type { Env } from "../app";
import { GatewayErrorCode } from "../services/gateway-error-codes";
import { gatewayErrorJson } from "../services/gateway-error-response";
import { parseDashScopeRealtimeAuthProtocol } from "@octafuse/core/realtime-protocol";
import { hashLookupKey } from "@octafuse/core";

/** 与 `authenticateApiKey` 结果一致，供 `/v1/*` 处理器使用。 */
export type ApiKeyContext = {
	/** `api_keys.id` */
	keyId: string;
	/** Lowercase SHA-256 hex used only for BYOK allowlist matching. */
	apiKeyHash: string;
	userId: string;
	/** Server-resolved owner of the authenticated Gateway Key. */
	workspaceId: string;
	userEmail: string | null;
	budgetMax: number | null;
	budgetSpent: number;
	/** Monotonic ordinary-budget period generation captured during authentication. */
	budgetEpoch: number;
	budgetPeriod: string;
	budgetResetAt: string | null;
	includeByokInLimit?: boolean;
	metadata: Record<string, unknown> | null;
	chargedCostFactors: string | null;
};

/** Exact Images surfaces whose handlers perform atomic ordinary-budget admission. */
export function isAtomicImageBudgetRoute(
	method: string,
	path: string
): boolean {
	return (
		method === "POST" &&
		/^\/(?:api\/)?v1\/images(?:\/(?:generations|edits))?\/?$/.test(path)
	);
}

/**
 * 按路径兼容多 SDK：`Authorization: Bearer`、Anthropic `x-api-key`、Gemini 查询参数 `key` 或 `x-goog-api-key`。
 * @returns 明文 sk 或 null
 */
function extractApiKey(c: {
	req: {
		header: (name: string) => string | undefined;
		path: string;
		url: string;
	};
}): string | null {
	const auth = c.req.header("Authorization");
	const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
	if (bearer) {
		return bearer;
	}

	// 浏览器 WebSocket 无法自定义 Authorization；实时入口从协商子协议读取 Key。
	if (c.req.path.startsWith("/v1/dashscope/realtime")) {
		const realtimeAuth = parseDashScopeRealtimeAuthProtocol(
			c.req.header("Sec-WebSocket-Protocol")
		);
		if (realtimeAuth) return realtimeAuth.apiKey;
	}

	const path = c.req.path;

	// Anthropic SDK commonly sends x-api-key.
	if (path.startsWith("/v1/messages")) {
		const anthropicKey = c.req.header("x-api-key")?.trim() ?? "";
		if (anthropicKey) {
			return anthropicKey;
		}
	}

	// Gemini SDK commonly sends API key in query string or x-goog-api-key.
	if (path.startsWith("/v1beta/")) {
		try {
			const url = new URL(c.req.url);
			const queryKey = url.searchParams.get("key")?.trim() ?? "";
			if (queryKey) {
				return queryKey;
			}
		} catch {
			// ignore URL parse errors and continue header fallback
		}
		const googHeaderKey = c.req.header("x-goog-api-key")?.trim() ?? "";
		if (googHeaderKey) {
			return googHeaderKey;
		}
	}

	return null;
}

/** 认证失败限速：每 IP 计数（Workers ratelimit binding，per-colo 尽力而为）。
 * 超限返回 429，未超限返回 null（走常规 401）；限速器缺失/故障时静默跳过。 */
export async function throttleAuthFailure(
	c: Context<Env>
): Promise<Response | null> {
	const limiter = c.env.AUTH_RATE_LIMITER ?? c.env.RATE_LIMITER;
	if (!limiter) return null;
	const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
	try {
		const { success } = await limiter.limit({ key: ip });
		if (success) return null;
		return gatewayErrorJson(c, {
			status: 429,
			code: GatewayErrorCode.authRateLimited,
			message: "Too many failed authentication attempts",
			headers: { "Retry-After": "60" },
		});
	} catch {
		return null;
	}
}

/**
 * 校验 API Key 并注入上下文；未授权返回 401，超额预算返回 402（部分路由豁免，见内联注释）。
 */
export const requireApiKey = createMiddleware<Env>(async (c, next) => {
	const key = extractApiKey(c);
	if (!key) {
		console.warn(
			"[Gateway Auth] 401: missing API key in supported auth locations"
		);
		return (
			(await throttleAuthFailure(c)) ??
			gatewayErrorJson(c, {
				status: 401,
				code: GatewayErrorCode.authFailed,
				message: "Missing or invalid API key",
			})
		);
	}

	const repos = c.get("repositories");
	const authResult = await authenticateApiKey(repos, key);
	if (!authResult) {
		// Never log any substring of a credential. Even a prefix/suffix preview is
		// reusable correlation material and can expose short or structured keys.
		console.warn(
			JSON.stringify({
				message: "gateway authentication failed",
				reason: "api_key_not_found",
			})
		);
		return (
			(await throttleAuthFailure(c)) ??
			gatewayErrorJson(c, {
				status: 401,
				code: GatewayErrorCode.authFailed,
				message: "Invalid API key",
			})
		);
	}
	console.log(
		JSON.stringify({
			message: "gateway authentication succeeded",
			key_id: authResult.keyId,
			user_id: authResult.userId,
		})
	);

	// Allow GET /v1/me (key info) even when budget is 0 or exceeded, so clients can show budget state
	const isKeyInfoRoute = c.req.method === "GET" && c.req.path.endsWith("/me");
	// Allow GET /v1/models even when budget is exceeded (just lists available models, no resource consumption)
	const isModelsRoute =
		c.req.method === "GET" && c.req.path.endsWith("/models");
	// Authenticated read-only OpenRouter endpoint discovery does not consume
	// inference budget. Keep this allowlist path-exact so similarly named routes
	// cannot bypass the budget gate.
	const isEndpointDiscoveryRoute =
		c.req.method === "GET" &&
		(/^\/v1\/models\/[^/]+\/[^/]+\/endpoints$/.test(c.req.path) ||
			/^\/(?:api\/)?v1\/endpoints\/zdr$/.test(c.req.path) ||
			/^\/(?:api\/)?v1\/images\/models(?:\/[^/]+\/[^/]+\/endpoints)?$/.test(
				c.req.path
			));
	// Generation metadata is a tenant-scoped read. It still requires a valid
	// Gateway Bearer key, but an exhausted inference budget must not hide the
	// caller's own request record. Keep both aliases path-exact.
	const isGenerationLookupRoute =
		c.req.method === "GET" &&
		(c.req.path === "/api/v1/generation" || c.req.path === "/v1/generation");
	// Preset CRUD captures configuration only and never dispatches inference.
	// Keep it available when an inference budget is exhausted so callers can
	// inspect or repair the configuration that they will use after replenishing.
	const isPresetManagementRoute =
		(c.req.method === "GET" || c.req.method === "POST") &&
		/^\/(?:api\/)?v1\/presets(?:\/|$)/.test(c.req.path);
	// Atomic ordinary-budget admission for model requests is done in the route
	// after the complete model/route failover plan has been resolved.
	const isModelRequestRoute =
		c.req.method === "POST" &&
		(/^\/(?:api\/)?v1\/(?:chat\/completions|completions|messages|responses)\/?$/.test(
			c.req.path
		) ||
			/^\/v1beta\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(
				c.req.path
			));
	const isFixedPriceToolRoute =
		c.req.method === "POST" &&
		/^\/v1\/tools\/(?:ai-detection|web-search|web-fetch|web-deep-search)\/?$/.test(
			c.req.path
		);
	const isImagesRoute = isAtomicImageBudgetRoute(c.req.method, c.req.path);
	const isAudioRoute =
		c.req.method === "POST" &&
		(c.req.path.endsWith("/audio/transcriptions") ||
			c.req.path.endsWith("/audio/speech"));
	const isDashScopeMultimodalRoute =
		c.req.method === "POST" &&
		c.req.path.endsWith(
			"/dashscope/services/aigc/multimodal-generation/generation"
		);
	const isRealtimeRoute =
		c.req.method === "GET" && /\/dashscope\/realtime\/?$/.test(c.req.path);
	const isToolsPricingRoute =
		c.req.method === "GET" && /\/tools\/pricing\/?$/.test(c.req.path);
	if (
		!isKeyInfoRoute &&
		!isModelsRoute &&
		!isEndpointDiscoveryRoute &&
		!isGenerationLookupRoute &&
		!isPresetManagementRoute &&
		!isModelRequestRoute &&
		!isFixedPriceToolRoute &&
		!isImagesRoute &&
		!isAudioRoute &&
		!isDashScopeMultimodalRoute &&
		!isRealtimeRoute &&
		!isToolsPricingRoute &&
		authResult.budgetMax != null &&
		authResult.budgetSpent >= authResult.budgetMax
	) {
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.budgetExceeded,
			message: "Budget exceeded",
		});
	}

	const lookupHash = await hashLookupKey(key);
	const apiKeyHash = lookupHash.startsWith("sha256:")
		? lookupHash.slice("sha256:".length)
		: lookupHash;
	c.set("apiKey", {
		keyId: authResult.keyId,
		apiKeyHash,
		userId: authResult.userId,
		workspaceId: authResult.workspaceId,
		userEmail: authResult.userEmail,
		budgetMax: authResult.budgetMax,
		budgetSpent: authResult.budgetSpent,
		budgetEpoch: authResult.budgetEpoch,
		budgetPeriod: authResult.budgetPeriod,
		budgetResetAt: authResult.budgetResetAt,
		includeByokInLimit: authResult.includeByokInLimit,
		metadata: authResult.metadata,
		chargedCostFactors: authResult.chargedCostFactors,
	});
	await next();
});
