import {
	createRequestDeadline,
	RequestExecutionStoppedError,
	type GatewayRepositories,
	type ModelRouteJoinRow,
	type ModelWithRouteCountsRow,
} from "@octafuse/core";
import {
	isAudioModel,
	isImageGenerationModel,
	isRerankModel,
	parseModelModalitiesJson,
	MODEL_INPUT_MODALITIES,
	MODEL_OUTPUT_MODALITIES,
} from "@octafuse/core/db/model-modalities";
import {
	BILLING_CURRENCY_KEY,
	tryParseBillingCurrencyInput,
} from "@octafuse/core/lib/billing-currency";
import {
	WEB_SEARCH_ACTIVE_KEY,
	WEB_SEARCH_CATALOG_KEY,
	parseWebSearchCatalogLenient,
} from "@octafuse/core/lib/web-search-system-config";
import {
	WEB_FETCH_ACTIVE_KEY,
	WEB_FETCH_CATALOG_KEY,
	parseWebFetchCatalogLenient,
} from "@octafuse/core/lib/web-fetch-system-config";
import {
	WEB_DEEP_SEARCH_ACTIVE_KEY,
	WEB_DEEP_SEARCH_CATALOG_KEY,
	parseWebDeepSearchCatalogLenient,
} from "@octafuse/core/lib/web-deep-search-system-config";
import {
	AI_DETECTION_ACTIVE_KEY,
	AI_DETECTION_CATALOG_KEY,
	parseAiDetectionCatalogLenient,
	resolveAiDetectionConfigForProvider,
} from "@octafuse/core/lib/ai-detection-system-config";
import { listPlaygroundToolProviders } from "./playground-tools-service";
import {
	safePlaygroundText,
	safePlaygroundWireJson,
	safePlaygroundCustomParams,
} from "@/lib/playground/private-preview";
import { playgroundUploadLimits } from "@/lib/playground/uploads";
import { hasAdminPermission, type AdminPrincipal } from "@/lib/admin-principal";
import {
	playgroundStoppedError,
	PLAYGROUND_REQUEST_DEADLINE_MS,
} from "./playground-request-lifecycle";
import { AdminServiceError } from "./errors";

export type PlaygroundContextRepositories = {
	routes: Pick<GatewayRepositories["routes"], "listModelRoutesWithJoins">;
	models: Pick<GatewayRepositories["models"], "listModelsWithRouteCounts">;
	systemConfig: Pick<GatewayRepositories["systemConfig"], "getConfig">;
};

function displayJson(raw: string | null, custom = false): string | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		// Price overrides contain numeric factors; never project free-text config.
		const projected = custom
			? safePlaygroundCustomParams(value)
			: numericProjection(value);
		return projected ? safePlaygroundWireJson(JSON.stringify(projected)) : null;
	} catch {
		return null;
	}
}

function numericProjection(value: unknown, depth = 0): unknown {
	if (depth > 12) return null;
	if (
		(typeof value === "number" && Number.isFinite(value)) ||
		typeof value === "boolean"
	)
		return value;
	if (
		typeof value === "string" &&
		(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u.test(value) ||
			[
				"override",
				"multiply",
				"requested",
				"zero",
				"token",
				"per_second",
				"per_character",
			].includes(value))
	)
		return value;
	if (Array.isArray(value))
		return value.map((item) => numericProjection(item, depth + 1));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(
					([key]) =>
						/^[a-z0-9][a-z0-9_x:.-]{0,70}$/u.test(key) &&
						!/(secret|token|key|password|authorization)/iu.test(key)
				)
				.map(([key, item]) => [key, numericProjection(item, depth + 1)])
		);
	return null;
}

function surfaces(raw: string | null) {
	let value: unknown;
	try {
		value = JSON.parse(raw ?? "[]") as unknown;
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(item): item is Record<string, unknown> =>
				!!item &&
				typeof item === "object" &&
				!Array.isArray(item) &&
				typeof (item as Record<string, unknown>).id === "string" &&
				!!(item as Record<string, unknown>).id &&
				["openai", "anthropic", "gemini", "dashscope"].includes(
					String((item as Record<string, unknown>).request_protocol)
				)
		)
		.slice(0, 1000)
		.map((item) => ({
			id: typeof item.id === "string" ? safePlaygroundText(item.id) : "",
			request_protocol:
				typeof item.request_protocol === "string"
					? safePlaygroundText(item.request_protocol)
					: "",
			request_operation:
				typeof item.request_operation === "string"
					? safePlaygroundText(item.request_operation)
					: "",
			status: item.status === "active" ? "active" : "disabled",
		}));
}

/** Execute-only projection: never calls provider credential/reveal repositories. */
export async function getPlaygroundContext(
	repos: PlaygroundContextRepositories,
	principal: AdminPrincipal,
	signal?: AbortSignal
) {
	const owner = createRequestDeadline(
		Date.now() + PLAYGROUND_REQUEST_DEADLINE_MS,
		signal
	);
	try {
		owner.throwIfStopped();
		const canReadRouteDetails = hasAdminPermission(principal, "routes.read");
		const [
			routeRows,
			modelRows,
			currency,
			searchRaw,
			searchActive,
			fetchRaw,
			fetchActive,
			deepRaw,
			deepActive,
			detectionRaw,
			detectionActive,
		] = await owner.wait(() =>
			Promise.all([
				repos.routes.listModelRoutesWithJoins({}),
				repos.models.listModelsWithRouteCounts(),
				repos.systemConfig.getConfig(BILLING_CURRENCY_KEY),
				repos.systemConfig.getConfig(WEB_SEARCH_CATALOG_KEY),
				repos.systemConfig.getConfig(WEB_SEARCH_ACTIVE_KEY),
				repos.systemConfig.getConfig(WEB_FETCH_CATALOG_KEY),
				repos.systemConfig.getConfig(WEB_FETCH_ACTIVE_KEY),
				repos.systemConfig.getConfig(WEB_DEEP_SEARCH_CATALOG_KEY),
				repos.systemConfig.getConfig(WEB_DEEP_SEARCH_ACTIVE_KEY),
				repos.systemConfig.getConfig(AI_DETECTION_CATALOG_KEY),
				repos.systemConfig.getConfig(AI_DETECTION_ACTIVE_KEY),
			])
		);
		const search = parseWebSearchCatalogLenient(searchRaw);
		const fetchCatalog = parseWebFetchCatalogLenient(fetchRaw);
		const deep = parseWebDeepSearchCatalogLenient(deepRaw);
		const detection = parseAiDetectionCatalogLenient(detectionRaw);
		const families = [
			{ toolId: "web-search", catalog: search, active: searchActive },
			{ toolId: "web-fetch", catalog: fetchCatalog, active: fetchActive },
			{ toolId: "web-deep-search", catalog: deep, active: deepActive },
			{ toolId: "ai-detection", catalog: detection, active: detectionActive },
		] as const;
		const tools = families.map((family) => ({
			toolId: family.toolId,
			catalog_state: family.catalog ? "available" : "unavailable",
			providers: listPlaygroundToolProviders(family.toolId).map((provider) => {
				const entry = (family.catalog as Record<string, unknown> | null)?.[
					provider
				];
				const configured =
					family.toolId === "ai-detection"
						? !!detection &&
						  resolveAiDetectionConfigForProvider(detection, provider).ok
						: !!entry &&
						  typeof entry === "object" &&
						  "apiKey" in entry &&
						  typeof entry.apiKey === "string" &&
						  !!entry.apiKey.trim();
				return {
					provider,
					available: true,
					configured,
					active: family.active?.trim() === provider,
				};
			}),
		}));
		const providers = [
			...new Map(
				routeRows.map((row) => [
					row.provider_id,
					{
						id: safePlaygroundText(row.provider_id),
						name: safePlaygroundText(row.provider_name ?? row.provider_id),
						status: row.provider_status === "disabled" ? "disabled" : "active",
					},
				])
			).values(),
		];
		return {
			routes: routeRows.map((row) =>
				projectPlaygroundRoute(row, canReadRouteDetails)
			),
			models: modelRows.map(projectPlaygroundModel),
			providers,
			tools,
			billing_currency: tryParseBillingCurrencyInput(currency),
			realtime_supported: typeof WebSocketPair !== "undefined",
			limits: playgroundUploadLimits(),
			billing: "none" as const,
			request_logs: false as const,
			failover: false as const,
		};
	} catch (error) {
		if (error instanceof RequestExecutionStoppedError)
			throw playgroundStoppedError(error);
		throw new AdminServiceError(502, "Playground context unavailable");
	} finally {
		owner.dispose();
	}
}

/** Pure metadata projection, reusable by independently authorized consumers. */
export function projectPlaygroundRoute(
	row: ModelRouteJoinRow,
	canReadRouteDetails: boolean
) {
	return {
		id: safePlaygroundText(row.id),
		model_id: safePlaygroundText(row.model_id),
		provider_id: safePlaygroundText(row.provider_id),
		provider_model_name: safePlaygroundText(row.provider_model_name),
		priority: row.priority,
		status: row.status === "active" ? "active" : "disabled",
		route_group: safePlaygroundText(row.route_group),
		upstream_protocol: row.upstream_protocol,
		upstream_operation: row.upstream_operation,
		adapter: row.adapter,
		route_pool_id: row.route_pool_id,
		pool_name: safePlaygroundText(row.pool_name ?? ""),
		model_name: safePlaygroundText(row.model_name ?? row.model_id),
		provider_name: safePlaygroundText(row.provider_name ?? row.provider_id),
		provider_status: row.provider_status === "disabled" ? "disabled" : "active",
		surfaces: surfaces(row.surfaces),
		price_override_preview: canReadRouteDetails
			? displayJson(row.price_override)
			: null,
		custom_params_preview: canReadRouteDetails
			? displayJson(row.custom_params, true)
			: null,
	};
}

export function projectPlaygroundModel(row: ModelWithRouteCountsRow) {
	return {
		id: safePlaygroundText(row.id),
		display_name: safePlaygroundText(row.display_name ?? row.id),
		kind: isRerankModel(row)
			? "rerank"
			: isAudioModel(row)
			? "audio"
			: isImageGenerationModel(row)
			? "image"
			: "llm",
		input_modalities: (
			parseModelModalitiesJson(row.input_modalities) ?? []
		).filter((value) =>
			(MODEL_INPUT_MODALITIES as readonly string[]).includes(value)
		),
		output_modalities: (
			parseModelModalitiesJson(row.output_modalities) ?? []
		).filter((value) =>
			(MODEL_OUTPUT_MODALITIES as readonly string[]).includes(value)
		),
	};
}

export type PlaygroundContext = Awaited<
	ReturnType<typeof getPlaygroundContext>
>;
