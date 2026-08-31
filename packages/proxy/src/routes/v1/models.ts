/**
 * 用户路由：`GET /v1/models` — OpenAI 兼容列表形态，附带 `model_info`（定价、tags、route_groups 等）。
 * 未传 `route_groups` 时默认仅返回 `default`/`free`，主要为兼容 agent 默认拉列表（FREE/VIP 分组）。
 * 未传 `kind` 时默认仅返回 LLM（排除 Embeddings、文生图与 Audio endpoint 模型）。
 * 可用 `kind=embedding|image|audio|all` 或 `output_modalities` 显式发现其它模型。
 */
import {
	isAudioModel,
	isEmbeddingModel,
	isImageGenerationModel,
	isTextLlmModel,
	parseModelModalitiesJson,
	parsePricingProfile,
} from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import {
	filterRouteGroupsByAllowlist,
	parseMetadata,
	parseModelsKindQuery,
	parseModelsOutputModalitiesQuery,
	parseModelsRouteGroupsQuery,
	parseRouteGroupsJson,
	parseTags,
} from '../../lib/model-list-parse';
import { listPublicModelsWithRoutes } from '../../services/public-models';
import {
	groupVerifiedEndpointBindingsByModel,
	parsePublicModelsRegion,
	summarizePublicEndpointDiscovery,
} from '../../services/public-endpoint-discovery';
import { listVerifiedPublicEndpointBindings } from '../../services/public-model-endpoints';

type ModelsEnv = Env & { Variables: { apiKey: import('../../middleware/auth').ApiKeyContext } };

export const modelsRoutes = new Hono<ModelsEnv>();

modelsRoutes.use('*', requireApiKey);

export {
	DEFAULT_MODELS_ROUTE_GROUPS,
	parseModelsKindQuery,
	parseModelsRouteGroupsQuery,
} from '../../lib/model-list-parse';

/**
 * `/v1/models` 中扩展字段：定价、能力与展示用元数据。
 * 说明：`supports_prompt_cache`、`thinking_config` 等由 Agent 本地维护，不由网关返回。
 */
interface ModelInfoResponse {
	display_name: string | null;
	/** 厂商/品牌；缺省归为 other */
	vendor: string;
	tags: string[];
	/** 来自当前 verified Endpoint 绑定路由的去重 route_group（计费通道） */
	route_groups: string[];
	context_window: number | null;
	max_tokens: number | null;
	/** 网关主定价 JSON；完整阶梯等以此为准 */
	pricing_profile: string | null;
	/**
	 * 由 `pricing_profile` 派生的兼容展示价（$/1M）：取各档中 **最低 input_price** 所在档的 in/out；
	 * 无合法 profile 时为 null。新客户端应解析完整 `pricing_profile`（`tiers`）。
	 */
	input_price: number | null;
	output_price: number | null;
	description: string | null;
	/** Parsed input modality list (e.g. text, image, file). */
	input_modalities: string[] | null;
	/** Parsed output modality list (e.g. text). */
	output_modalities: string[] | null;
	/** Model release date `YYYY-MM-DD`. */
	released_at: string | null;
	/** Current verified endpoint selectors available within the discovery scope. */
	endpoint_slugs: string[];
	/** Current verified provider locations; not an inference residency guarantee. */
	regions: string[];
	metadata?: Record<string, unknown>;
}

interface ModelResponse {
	id: string;
	object: string;
	owned_by: string;
	model_info?: ModelInfoResponse;
}

/** 对外列表：从 `tiers` 取 input 最低价所在档作为 headline in/out；无 profile 返回 null。 */
function displayCompatPricesFromProfile(pricingProfile: string | null): {
	input_price: number | null;
	output_price: number | null;
} {
	const p = parsePricingProfile(pricingProfile ?? undefined);
	if (!p || p.tiers.length === 0) {
		return { input_price: null, output_price: null };
	}
	let best = p.tiers[0]!;
	for (const t of p.tiers) {
		if (t.input_price < best.input_price) {
			best = t;
		}
	}
	return { input_price: best.input_price, output_price: best.output_price };
}

/**
 * `GET /v1/models` — 可选 `route_groups`（CSV）过滤 `model_info.route_groups`；
 * 可选 `kind`：`llm`（默认）| `image` | `audio` | `all`。
 * 未传 `route_groups` 时默认 `default,free`，主要为兼容 agent 默认拉列表方式；
 * 业务需额外分组时可显式传 `route_groups=web` 或 `route_groups=default,free,web`。
 */
modelsRoutes.get('/', async (c) => {
	const repos = c.get('repositories');
	const regionResult = parsePublicModelsRegion(c.req.query('region'));
	if (!regionResult.ok) {
		return c.json({
			error: {
				message: regionResult.message,
				type: 'invalid_request_error',
				param: 'region',
				code: 'invalid_region',
			},
		}, 400);
	}
	const region = regionResult.value;
	const models = await listPublicModelsWithRoutes(repos);
	const endpointBindingsByModel = groupVerifiedEndpointBindingsByModel(
		await listVerifiedPublicEndpointBindings(repos, models)
	);
	const allowedRouteGroups = parseModelsRouteGroupsQuery(c.req.query('route_groups'));
	const kind = parseModelsKindQuery(c.req.query('kind'));
	const outputModalities = parseModelsOutputModalitiesQuery(c.req.query('output_modalities'));

	const list: ModelResponse[] = [];
	for (const m of models) {
		const kindFields = {
			output_modalities: m.output_modalities,
			input_modalities: m.input_modalities,
			pricing_profile: m.pricing_profile,
		};
		if (kind === 'llm' && (!isTextLlmModel(kindFields) || isEmbeddingModel(kindFields))) {
			continue;
		}
		if (kind === 'image' && !isImageGenerationModel(kindFields)) {
			continue;
		}
		if (kind === 'audio' && !isAudioModel(kindFields)) {
			continue;
		}
		if (kind === 'embedding' && !isEmbeddingModel(kindFields)) {
			continue;
		}
		const parsedOutputModalities = parseModelModalitiesJson(m.output_modalities) ?? [];
		if (outputModalities && !outputModalities.some((value) => parsedOutputModalities.includes(value))) {
			continue;
		}
		const { input_price, output_price } = displayCompatPricesFromProfile(m.pricing_profile);
		let routeGroups = filterRouteGroupsByAllowlist(
			parseRouteGroupsJson(m.route_groups ?? null),
			allowedRouteGroups
		);
		if (routeGroups.length === 0) {
			continue;
		}
		const endpointDiscovery = summarizePublicEndpointDiscovery(endpointBindingsByModel.get(m.id) ?? [], {
			routeGroups,
			region,
		});
		if (!endpointDiscovery.has_matching_route) continue;
		routeGroups = filterRouteGroupsByAllowlist(routeGroups, endpointDiscovery.route_groups);
		if (routeGroups.length === 0) continue;
		list.push({
			id: m.id,
			object: 'model',
			owned_by: 'cinatoken',
			model_info: {
				display_name: m.display_name,
				vendor: m.vendor,
				tags: parseTags(m.tags),
				route_groups: routeGroups,
				context_window: m.context_window,
				max_tokens: m.max_tokens,
				pricing_profile: m.pricing_profile,
				input_price,
				output_price,
				description: m.description,
				input_modalities: parseModelModalitiesJson(m.input_modalities),
				output_modalities: parsedOutputModalities.length > 0 ? parsedOutputModalities : null,
				released_at: m.released_at ?? null,
				endpoint_slugs: endpointDiscovery.endpoint_slugs,
				regions: endpointDiscovery.regions,
				metadata: parseMetadata(m.metadata),
			},
		});
	}

	return c.json({
		data: list,
		object: 'list',
		...(region ? {
			region_filter: {
				region,
				scope: 'provider_endpoint_location_discovery',
				inference_data_residency_guaranteed: false,
			},
		} : {}),
	});
});
