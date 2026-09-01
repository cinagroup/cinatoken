import {
	isPendingProviderImportApiKey,
	normalizeUpstreamProtocol,
	type GatewayRepositories,
	type ModelEndpointRow,
	type ModelRouteJoinRow,
} from "@octafuse/core";
import { badRequest } from "./errors";
import {
	createModelEndpointService,
	linkModelEndpointRouteService,
	updateModelEndpointService,
	type AdminModelEndpointMutationInput,
} from "./model-endpoints-service";

const DEEPSEEK_PROVIDER_ID = "deepseek-official";
const DEEPSEEK_PROVIDER_SLUG = "deepseek";
const DEEPSEEK_EVIDENCE_URL =
	"https://api-docs.deepseek.com/quick_start/pricing/";
const DEEPSEEK_EVIDENCE_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const DEEPSEEK_TEXT_OPERATIONS = new Set(["chat", "messages", "responses"]);
const DEEPSEEK_SUPPORTED_PARAMETERS = [
	"logprobs",
	"max_tokens",
	"reasoning_effort",
	"response_format",
	"stop",
	"stream",
	"stream_options",
	"temperature",
	"thinking",
	"tool_choice",
	"tools",
	"top_logprobs",
	"top_p",
	"user_id",
] as const;

type DeepSeekEndpointPreset = {
	modelId: string;
	promptPrice: string;
	completionPrice: string;
	cacheReadPrice: string;
};

/**
 * Peak prices are used deliberately. DeepSeek's public catalog has scheduled
 * off-peak discounts, while the OpenRouter-compatible endpoint document only
 * has one deterministic price per meter. Publishing the peak list price avoids
 * claiming that a temporary discount applies at every request time.
 */
const DEEPSEEK_ENDPOINT_PRESETS: readonly DeepSeekEndpointPreset[] = [
	{
		modelId: "deepseek-v4-flash",
		promptPrice: "0.00000044",
		completionPrice: "0.00000132",
		cacheReadPrice: "0.000000014",
	},
	{
		modelId: "deepseek-v4-pro",
		promptPrice: "0.00000132",
		completionPrice: "0.00000396",
		cacheReadPrice: "0.000000044",
	},
] as const;

export type AdminDeepSeekEndpointBootstrapInput = {
	publish?: unknown;
};

export type AdminDeepSeekEndpointBootstrapModelResult = {
	model_id: string;
	endpoint_id: string | null;
	status: "published" | "skipped_missing_model" | "skipped_no_routes" | "failed";
	linked_routes: number;
	message: string | null;
};

export type AdminDeepSeekEndpointBootstrapOutput = {
	provider_id: typeof DEEPSEEK_PROVIDER_ID;
	evidence_url: typeof DEEPSEEK_EVIDENCE_URL;
	evidence_expires_at: string;
	pricing_basis: "peak";
	published: number;
	linked_routes: number;
	skipped: number;
	failed: number;
	models: AdminDeepSeekEndpointBootstrapModelResult[];
};

function endpointMutation(
	preset: DeepSeekEndpointPreset,
	expiresAt: string
): AdminModelEndpointMutationInput {
	return {
		model_id: preset.modelId,
		provider_id: DEEPSEEK_PROVIDER_ID,
		provider_slug: DEEPSEEK_PROVIDER_SLUG,
		tag: DEEPSEEK_PROVIDER_SLUG,
		endpoint_class: "standard",
		region: null,
		context_length: 1_000_000,
		max_prompt_tokens: null,
		max_completion_tokens: 384_000,
		quantization: null,
		supported_parameters: [...DEEPSEEK_SUPPORTED_PARAMETERS],
		pricing: {
			currency: "USD",
			prompt: preset.promptPrice,
			completion: preset.completionPrice,
			input_cache_read: preset.cacheReadPrice,
		},
		supports_implicit_caching: true,
		supports_voice_cloning: false,
		supports_tool_choice: {
			auto: true,
			function: true,
			none: true,
			required: true,
		},
		image_capabilities: null,
		audio_capabilities: null,
		evidence_url: DEEPSEEK_EVIDENCE_URL,
		expires_at: expiresAt,
		status: "draft",
	};
}

async function findEndpointByIdentity(
	repos: GatewayRepositories,
	modelId: string
): Promise<ModelEndpointRow | null> {
	if (repos.modelEndpoints.getByIdentity) {
		return repos.modelEndpoints.getByIdentity(
			modelId,
			DEEPSEEK_PROVIDER_ID,
			DEEPSEEK_PROVIDER_SLUG
		);
	}
	const rows = await repos.modelEndpoints.list({
		modelId,
		providerId: DEEPSEEK_PROVIDER_ID,
		limit: 100,
		offset: 0,
	});
	return (
		rows.find(
			(row) =>
				row.model_id === modelId &&
				row.provider_id === DEEPSEEK_PROVIDER_ID &&
				row.tag === DEEPSEEK_PROVIDER_SLUG
		) ?? null
	);
}

function eligibleRoute(route: ModelRouteJoinRow): boolean {
	if (route.status !== "active") return false;
	if (route.pool_status != null && route.pool_status !== "active") return false;
	if (route.provider_status != null && route.provider_status !== "active") {
		return false;
	}
	if (!DEEPSEEK_TEXT_OPERATIONS.has(route.upstream_operation)) return false;
	try {
		const protocol = normalizeUpstreamProtocol(route.upstream_protocol);
		return protocol === "openai" || protocol === "anthropic";
	} catch {
		return false;
	}
}

/**
 * Explicit, administrator-triggered publication of the fixed official
 * DeepSeek endpoint presets. Each record is first persisted as a draft, then
 * linked to the exact active routes, and finally crosses the existing atomic
 * verification boundary. A failed model remains non-public and can be safely
 * retried; no provider credential is returned or logged.
 */
export async function bootstrapDeepSeekEndpointsService(
	repos: GatewayRepositories,
	input: AdminDeepSeekEndpointBootstrapInput,
	actorId: string,
	now = new Date()
): Promise<AdminDeepSeekEndpointBootstrapOutput> {
	if (input.publish !== true) {
		throw badRequest("publish must be true for explicit endpoint verification");
	}
	const provider = await repos.providers.getProviderById(DEEPSEEK_PROVIDER_ID);
	if (!provider || provider.id !== DEEPSEEK_PROVIDER_ID) {
		throw badRequest("Official DeepSeek provider is not installed");
	}
	if (provider.status !== "active") {
		throw badRequest("Official DeepSeek provider must be active");
	}
	if (provider.shared_channel_type?.trim()) {
		throw badRequest("Official DeepSeek provider must not be a shared channel");
	}
	if (
		!provider.api_key?.trim() ||
		isPendingProviderImportApiKey(provider.api_key)
	) {
		throw badRequest("Official DeepSeek provider credential is unavailable");
	}

	const expiresAt = new Date(
		now.getTime() + DEEPSEEK_EVIDENCE_TTL_MS
	).toISOString();
	const results: AdminDeepSeekEndpointBootstrapModelResult[] = [];

	for (const preset of DEEPSEEK_ENDPOINT_PRESETS) {
		let endpointId: string | null = null;
		let linkedRoutes = 0;
		try {
			const [model, routes, existing] = await Promise.all([
				repos.modelRouting.getModelById(preset.modelId),
				repos.routes.listModelRoutesWithJoins({
					modelId: preset.modelId,
					providerId: DEEPSEEK_PROVIDER_ID,
				}),
				findEndpointByIdentity(repos, preset.modelId),
			]);
			if (!model || model.id !== preset.modelId) {
				results.push({
					model_id: preset.modelId,
					endpoint_id: null,
					status: "skipped_missing_model",
					linked_routes: 0,
					message: null,
				});
				continue;
			}

			const eligibleRoutes = routes
				.filter(eligibleRoute)
				.sort((left, right) => left.id.localeCompare(right.id));
			if (eligibleRoutes.length === 0) {
				results.push({
					model_id: preset.modelId,
					endpoint_id: existing?.id ?? null,
					status: "skipped_no_routes",
					linked_routes: 0,
					message: null,
				});
				continue;
			}

			const mutation = endpointMutation(preset, expiresAt);
			if (existing) {
				endpointId = existing.id;
				await updateModelEndpointService(
					repos,
					existing.id,
					mutation,
					actorId,
					now
				);
			} else {
				const created = await createModelEndpointService(
					repos,
					mutation,
					actorId,
					now
				);
				endpointId = created.id;
			}

			const existingLinks = await repos.modelEndpoints.listRouteLinks([
				endpointId,
			]);
			const linkedRouteIds = new Set(
				existingLinks.map((link) => link.route_target_id)
			);
			for (const route of eligibleRoutes) {
				if (linkedRouteIds.has(route.id)) continue;
				await linkModelEndpointRouteService(repos, endpointId, route.id, now);
				linkedRouteIds.add(route.id);
				linkedRoutes += 1;
			}

			await updateModelEndpointService(
				repos,
				endpointId,
				{ status: "verified" },
				actorId,
				now
			);
			results.push({
				model_id: preset.modelId,
				endpoint_id: endpointId,
				status: "published",
				linked_routes: linkedRoutes,
				message: null,
			});
		} catch (error) {
			results.push({
				model_id: preset.modelId,
				endpoint_id: endpointId,
				status: "failed",
				linked_routes: linkedRoutes,
				message: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	return {
		provider_id: DEEPSEEK_PROVIDER_ID,
		evidence_url: DEEPSEEK_EVIDENCE_URL,
		evidence_expires_at: expiresAt,
		pricing_basis: "peak",
		published: results.filter((result) => result.status === "published").length,
		linked_routes: results.reduce(
			(total, result) => total + result.linked_routes,
			0
		),
		skipped: results.filter((result) => result.status.startsWith("skipped_"))
			.length,
		failed: results.filter((result) => result.status === "failed").length,
		models: results,
	};
}
