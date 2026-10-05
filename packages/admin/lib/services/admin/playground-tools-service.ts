/**
 * Playground Tools：读 system_config catalog，按指定 provider 直连引擎。
 * 不经 Proxy、不计费、不写 api_key_request_logs；可测非 Active 引擎以验证密钥。
 */
import {
	createRequestDeadline,
	RequestExecutionStoppedError,
	type GatewayRepositories,
	type RequestDeadline,
} from "@octafuse/core";
import {
	AI_DETECTION_CATALOG_KEY,
	AI_DETECTION_IMPLEMENTED_PROVIDERS,
	parseAiDetectionCatalogLenient,
	resolveAiDetectionConfigForProvider,
} from "@octafuse/core/lib/ai-detection-system-config";
import {
	WEB_DEEP_SEARCH_CATALOG_KEY,
	WEB_DEEP_SEARCH_PROVIDERS,
	isWebDeepSearchProvider,
	parseWebDeepSearchCatalogLenient,
	type WebDeepSearchProvider,
} from "@octafuse/core/lib/web-deep-search-system-config";
import {
	WEB_FETCH_CATALOG_KEY,
	WEB_FETCH_PROVIDERS,
	isWebFetchProvider,
	parseWebFetchCatalogLenient,
	type WebFetchProvider,
} from "@octafuse/core/lib/web-fetch-system-config";
import {
	WEB_SEARCH_CATALOG_KEY,
	WEB_SEARCH_PROVIDERS,
	isWebSearchProvider,
	parseWebSearchCatalogLenient,
	type WebSearchProvider,
} from "@octafuse/core/lib/web-search-system-config";
import {
	detectAiRate,
	getAiDetectionDriver,
	AiDetectionProviderError,
} from "@octafuse/tool-engines/ai-detection";
import {
	deepSearchByProvider,
	WebDeepSearchProviderError,
	clampDeepSearchCount,
} from "@octafuse/tool-engines/web-deep-search";
import {
	assertFetchUrlSafe,
	fetchUrlByProvider,
	WebFetchProviderError,
} from "@octafuse/tool-engines/web-fetch";
import {
	searchWebByProvider,
	WebSearchProviderError,
} from "@octafuse/tool-engines/web-search";
import { parseGatewayToolId, type GatewayToolId } from "@/lib/invoke-kind";
import { AdminServiceError, badRequest } from "./errors";
import {
	discardPlaygroundResponse,
	guardPlaygroundControlResponse,
	playgroundStoppedError,
	PLAYGROUND_REQUEST_DEADLINE_MS,
} from "./playground-request-lifecycle";
import {
	safePlaygroundText,
	safePlaygroundWireJson,
} from "@/lib/playground/private-preview";

export type PlaygroundToolInvokeInput = {
	toolId: string;
	/** Catalog provider id（可与 Active 不同） */
	provider: string;
	body: Record<string, unknown>;
};

export type PlaygroundToolInvokeResult = {
	response: Response;
	upstreamUrlForHeader: string;
	latencyMs: number;
	upstreamWireBodyJson: string;
};

function jsonResponse(status: number, body: unknown): Response {
	const outcome =
		body && typeof body === "object" && "upstream_outcome" in body
			? String(body.upstream_outcome)
			: status === 503
			? "known_zero"
			: status < 400
			? "response-received"
			: "unknown";
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"x-playground-upstream-outcome": outcome,
		},
	});
}

function requireString(body: Record<string, unknown>, key: string): string {
	const v = body[key];
	if (typeof v !== "string" || !v.trim()) {
		throw badRequest(`body.${key} must be a non-empty string`);
	}
	return v.trim();
}

export function validatePlaygroundToolInput(
	toolId: GatewayToolId,
	body: Record<string, unknown>
): void {
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw badRequest("body must be a JSON object");
	if (toolId === "web-fetch") {
		const guard = assertFetchUrlSafe(requireString(body, "url"));
		if (!guard.ok) throw badRequest(guard.error);
	} else if (toolId === "ai-detection") requireString(body, "text");
	else if (requireString(body, "query").length < 2)
		throw badRequest("query must be at least 2 characters");
	if (
		body.count !== undefined &&
		(typeof body.count !== "number" || !Number.isFinite(body.count))
	)
		throw badRequest("body.count must be a finite number");
	for (const name of ["allowed_domains", "blocked_domains"])
		if (
			body[name] !== undefined &&
			(!Array.isArray(body[name]) ||
				body[name].some((value) => typeof value !== "string" || !value.trim()))
		)
			throw badRequest(`body.${name} must be an array of non-empty strings`);
}

async function loadCatalogRaw(
	repos: GatewayRepositories,
	key: string,
	owner: RequestDeadline
): Promise<string | null> {
	return owner.wait(() => repos.systemConfig.getConfig(key));
}

export function listPlaygroundToolProviders(
	toolId: GatewayToolId
): readonly string[] {
	switch (toolId) {
		case "web-search":
			return WEB_SEARCH_PROVIDERS;
		case "web-fetch":
			return WEB_FETCH_PROVIDERS;
		case "web-deep-search":
			return WEB_DEEP_SEARCH_PROVIDERS;
		case "ai-detection":
			return AI_DETECTION_IMPLEMENTED_PROVIDERS;
		default: {
			const _exhaustive: never = toolId;
			return _exhaustive;
		}
	}
}

/**
 * 直连引擎试调用（Admin 管理面）。
 */
export async function invokePlaygroundTool(
	repos: GatewayRepositories,
	input: PlaygroundToolInvokeInput,
	requestSignal?: AbortSignal
): Promise<PlaygroundToolInvokeResult> {
	const owner = createRequestDeadline(
		Date.now() + PLAYGROUND_REQUEST_DEADLINE_MS,
		requestSignal
	);
	try {
		return await owner.wait(() =>
			invokeOwnedPlaygroundTool(repos, input, owner)
		);
	} catch (error) {
		if (owner.signal.reason instanceof RequestExecutionStoppedError)
			throw playgroundStoppedError(owner.signal.reason);
		if (error instanceof RequestExecutionStoppedError)
			throw playgroundStoppedError(error);
		if (error instanceof AdminServiceError) throw error;
		throw new AdminServiceError(502, "Playground tool request failed");
	} finally {
		owner.dispose();
	}
}

async function invokeOwnedPlaygroundTool(
	repos: GatewayRepositories,
	input: PlaygroundToolInvokeInput,
	owner: RequestDeadline
): Promise<PlaygroundToolInvokeResult> {
	owner.throwIfStopped();
	const fetchImpl: typeof fetch = async (url, init) => {
		owner.throwIfStopped();
		const response = await owner.wait(
			() => fetch(url, { ...init, signal: owner.signal }),
			discardPlaygroundResponse
		);
		return guardPlaygroundControlResponse(response, owner);
	};
	const toolId = parseGatewayToolId(input.toolId);
	if (!toolId) {
		throw badRequest(`Unknown toolId: ${input.toolId}`);
	}
	validatePlaygroundToolInput(toolId, input.body);
	const provider = input.provider?.trim() ?? "";
	if (!provider) {
		throw badRequest("provider is required");
	}
	const allowed = listPlaygroundToolProviders(toolId);
	if (!(allowed as readonly string[]).includes(provider)) {
		throw badRequest(
			`provider "${provider}" is not available for tool "${toolId}". Allowed: ${allowed.join(
				", "
			)}`
		);
	}

	const start = Date.now();
	const wire = {
		toolId,
		provider,
		body: input.body,
		mode: "playground-direct-engine" as const,
	};
	let upstreamWireBodyJson = safePlaygroundWireJson(
		JSON.stringify(wire, null, 2)
	);
	const credentials: string[] = [];
	const rememberCredential = (...values: string[]) => {
		credentials.push(...values);
		upstreamWireBodyJson = safePlaygroundWireJson(
			JSON.stringify(wire),
			credentials
		);
	};

	try {
		let payload: unknown;
		let upstreamLabel = `catalog://${toolId}/${provider}`;

		switch (toolId) {
			case "web-search": {
				if (!isWebSearchProvider(provider))
					throw badRequest("invalid web-search provider");
				const catalogRaw = await loadCatalogRaw(
					repos,
					WEB_SEARCH_CATALOG_KEY,
					owner
				);
				const catalog = parseWebSearchCatalogLenient(catalogRaw);
				const entry = catalog?.[provider as WebSearchProvider];
				const apiKey = entry?.apiKey?.trim() ?? "";
				if (apiKey) rememberCredential(apiKey);
				if (!apiKey) {
					return {
						response: jsonResponse(503, {
							error: `Web search provider "${provider}" has no API key in WEB_SEARCH_CATALOG`,
						}),
						upstreamUrlForHeader: upstreamLabel,
						latencyMs: Date.now() - start,
						upstreamWireBodyJson,
					};
				}
				const query = requireString(input.body, "query");
				if (query.length < 2)
					throw badRequest("query must be at least 2 characters");
				const results = await searchWebByProvider(provider, {
					apiKey,
					query,
					count:
						typeof input.body.count === "number" ? input.body.count : undefined,
					allowedDomains: Array.isArray(input.body.allowed_domains)
						? (input.body.allowed_domains as string[])
						: undefined,
					blockedDomains: Array.isArray(input.body.blocked_domains)
						? (input.body.blocked_domains as string[])
						: undefined,
					fetchImpl,
				});
				payload = { provider, results, playground: true };
				upstreamLabel = `engine://web-search/${provider}`;
				break;
			}
			case "web-fetch": {
				if (!isWebFetchProvider(provider))
					throw badRequest("invalid web-fetch provider");
				const catalogRaw = await loadCatalogRaw(
					repos,
					WEB_FETCH_CATALOG_KEY,
					owner
				);
				const catalog = parseWebFetchCatalogLenient(catalogRaw);
				const entry = catalog?.[provider as WebFetchProvider];
				const apiKey = entry?.apiKey?.trim() ?? "";
				if (apiKey) rememberCredential(apiKey);
				if (!apiKey) {
					return {
						response: jsonResponse(503, {
							error: `Web fetch provider "${provider}" has no API key in WEB_FETCH_CATALOG`,
						}),
						upstreamUrlForHeader: upstreamLabel,
						latencyMs: Date.now() - start,
						upstreamWireBodyJson,
					};
				}
				const url = requireString(input.body, "url");
				const guard = assertFetchUrlSafe(url);
				if (!guard.ok) {
					throw badRequest(guard.error);
				}
				const result = await fetchUrlByProvider(provider, {
					apiKey,
					url,
					fetchImpl,
				});
				payload = { provider, result, playground: true };
				upstreamLabel = `engine://web-fetch/${provider}`;
				break;
			}
			case "web-deep-search": {
				if (!isWebDeepSearchProvider(provider)) {
					throw badRequest("invalid web-deep-search provider");
				}
				const catalogRaw = await loadCatalogRaw(
					repos,
					WEB_DEEP_SEARCH_CATALOG_KEY,
					owner
				);
				const catalog = parseWebDeepSearchCatalogLenient(catalogRaw);
				const entry = catalog?.[provider as WebDeepSearchProvider];
				const apiKey = entry?.apiKey?.trim() ?? "";
				if (apiKey) rememberCredential(apiKey);
				if (!apiKey) {
					return {
						response: jsonResponse(503, {
							error: `Web deep search provider "${provider}" has no API key in WEB_DEEP_SEARCH_CATALOG`,
						}),
						upstreamUrlForHeader: upstreamLabel,
						latencyMs: Date.now() - start,
						upstreamWireBodyJson,
					};
				}
				const query = requireString(input.body, "query");
				if (query.length < 2)
					throw badRequest("query must be at least 2 characters");
				const count =
					typeof input.body.count === "number"
						? clampDeepSearchCount(input.body.count)
						: undefined;
				const results = await deepSearchByProvider(provider, {
					apiKey,
					query,
					count,
					fetchImpl,
				});
				payload = { provider, results, playground: true };
				upstreamLabel = `engine://web-deep-search/${provider}`;
				break;
			}
			case "ai-detection": {
				const catalogRaw = await loadCatalogRaw(
					repos,
					AI_DETECTION_CATALOG_KEY,
					owner
				);
				const catalog = parseAiDetectionCatalogLenient(catalogRaw);
				if (!catalog) {
					return {
						response: jsonResponse(503, {
							error: "AI_DETECTION_CATALOG is missing or invalid",
						}),
						upstreamUrlForHeader: upstreamLabel,
						latencyMs: Date.now() - start,
						upstreamWireBodyJson,
					};
				}
				const resolved = resolveAiDetectionConfigForProvider(catalog, provider);
				if (!resolved.ok) {
					const message =
						resolved.reason === "active_missing_key"
							? `AI detection provider "${resolved.provider}" credentials incomplete in catalog`
							: resolved.reason === "provider_not_implemented"
							? `AI detection provider "${resolved.provider}" is not implemented`
							: resolved.reason === "invalid_catalog"
							? "AI_DETECTION_CATALOG is invalid"
							: `Invalid AI detection provider: ${
									"raw" in resolved ? resolved.raw : provider
							  }`;
					return {
						response: jsonResponse(503, { error: message }),
						upstreamUrlForHeader: upstreamLabel,
						latencyMs: Date.now() - start,
						upstreamWireBodyJson,
					};
				}
				const driver = getAiDetectionDriver(resolved.config.provider);
				rememberCredential(
					...[
						resolved.config.entry.apiKey,
						resolved.config.entry.secretId,
						resolved.config.entry.secretKey,
					].filter((value): value is string => typeof value === "string")
				);
				if (!driver) {
					return {
						response: jsonResponse(503, {
							error: `No driver for AI detection provider "${resolved.config.provider}"`,
						}),
						upstreamUrlForHeader: upstreamLabel,
						latencyMs: Date.now() - start,
						upstreamWireBodyJson,
					};
				}
				const text = requireString(input.body, "text");
				const result = await detectAiRate(text, driver, resolved.config, {
					fetchImpl,
				});
				payload = {
					provider: resolved.config.provider,
					score: result.overallScore,
					total_chars: result.totalChars,
					segments: result.segments.map((s) => ({
						index: s.index,
						chars: s.chars,
						score: s.score,
					})),
					playground: true,
					note: "Playground direct engine call — no billing, no request log",
				};
				upstreamLabel = `engine://ai-detection/${resolved.config.provider}`;
				break;
			}
			default: {
				const _exhaustive: never = toolId;
				throw badRequest(`Unsupported tool: ${String(_exhaustive)}`);
			}
		}

		owner.throwIfStopped();

		return {
			response: jsonResponse(200, payload),
			upstreamUrlForHeader: upstreamLabel,
			latencyMs: Date.now() - start,
			upstreamWireBodyJson,
		};
	} catch (e) {
		if (
			e instanceof WebSearchProviderError ||
			e instanceof WebFetchProviderError ||
			e instanceof WebDeepSearchProviderError ||
			e instanceof AiDetectionProviderError
		) {
			return {
				response: jsonResponse(e.status, {
					error: safePlaygroundText(e.message, credentials),
					provider: e.provider,
					playground: true,
					upstream_outcome: e.upstreamOutcome,
				}),
				upstreamUrlForHeader: `engine://${toolId}/${provider}`,
				latencyMs: Date.now() - start,
				upstreamWireBodyJson,
			};
		}
		throw e;
	}
}
