/**
 * 模型路由解析：把 `model_routes` 行 + `providers` 拼成可上游请求的 `RouteResult`
 *（`providerEndpoints`、协议、`price_override`、单键 `api_key` 等）。
 * 与 `route-selection` 配合：本模块负责「行 → 可调用对象」，不负责选哪几条 failover。
 * 完整上游 URL 由各 driver 按 capability 调用 `resolveUpstreamEndpoint`。
 */
import type {
	GatewayRepositories,
	ModelRouteRow,
	ProviderRow,
	ProviderEndpointsMap,
	ResolvedModelSurfaceRow,
	UpstreamProtocol,
	VerifiedModelEndpointSnapshot,
} from '@octafuse/core';
import {
	effectiveUpstreamOperation,
	computeRouteDataPolicySubjectFingerprintFromRows,
	extractMeteredProfileFromPriceOverrideJson,
	extractChargedProfileFromPriceOverrideJson,
	fingerprintProviderApiKey,
	isPendingProviderImportApiKey,
	isRouteAdapterCompatible,
	modelEndpointSubjectFingerprintIsValid,
	modelEndpointSupportsOperation,
	normalizeUpstreamProtocol,
	parseVerifiedModelEndpointSnapshot,
	parseProviderEndpoints,
	parseRouteRoutingMetadata,
	providerSupportsUpstreamProtocol,
	type RouteRoutingMetadata,
	verifiedEndpointMatchesLegacyRoutingMetadata,
} from '@octafuse/core';
import { selectActiveRouteRows } from './route-selection';

export interface RouteResult {
	/** `model_routes.id`; stable target identity for traces and admin deep links. */
	targetId: string;
	modelSurfaceId: string | null;
	routePoolId: string | null;
	providerId: string;
	/** `providers.name` 快照，供 `api_key_request_logs` 等落库 */
	providerName: string;
	providerModelName: string;
	/** Verified, request-local endpoint capability and flat-pricing snapshot. */
	endpoint?: VerifiedModelEndpointSnapshot;
	/** Public gateway model id returned to clients; never the provider's private model name. */
	gatewayModelId?: string;
	/** Request-local model-fallback candidate identity; never serialized upstream. */
	gatewayCandidateIndex?: number;
	/** Request-local rank used by provider.sort.partition="none". */
	gatewayGlobalEndpointRank?: number;
	/** SHA-256 binding for verified ZDR/data-collection evidence. */
	dataPolicySubjectFingerprint?: string;
	upstreamProtocol: UpstreamProtocol;
	upstreamOperation: string;
	adapter: string;
	/**
	 * 解析后的 provider endpoints（`providers.endpoints`）。
	 * Driver 按 capability 调用 `resolveUpstreamEndpoint`。
	 */
	providerEndpoints: ProviderEndpointsMap;
	providerApiKey: string;
	/**
	 * `providers.shared_channel_type`：非空表示该 provider 接受用户共享密钥池注入
	 * （openai/anthropic/zhipu/deepseek）；dispatch 阶段按固定顺序替换 `providerApiKey`。
	 */
	providerSharedChannelType: string | null;
	/** 原始 `model_routes.price_override` JSON，供审计与嵌套 profile 解析 */
	priceOverrideRaw: string | null;
	/** 自 `price_override.metered` 解析出的 JSON 字符串（无则 null）；供应侧 `metered_cost` */
	routeMeteredProfileJson: string | null;
	/** 自 `price_override.charged` 解析出的 JSON 字符串（无则 null）；用户预算 `charged_cost` 优先于此 */
	routeChargedProfileJson: string | null;
	customParams: Record<string, unknown> | null;
	/** Gateway-only endpoint capabilities; never merged into the upstream body. */
	routingMetadata?: RouteRoutingMetadata | null;
	/** Sanitized request-time provider preference decision for request-log audit. */
	providerRoutingTrace?: {
		configured_target_ids: string[];
		eligible_target_ids: string[];
		sort: string | null;
		partition: 'model' | 'none';
		global_endpoint_rank: number | null;
		require_parameters: boolean;
		data_collection: 'allow' | 'deny';
		zdr: boolean;
		quantizations: string[] | null;
		max_price: Record<string, number> | null;
	};
	routeGroup: string;
	/** `model_routes.priority`；同层按 route strategy 排序 */
	routePriority: number;
	/** `model_routes.weight`；策略排序用，默认 1 */
	routeWeight: number;
	/** deprecated log fields — 写入 provider id/name/fingerprint */
	providerKeyId?: string | null;
	providerKeyLabel?: string | null;
	providerKeyFingerprint?: string | null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// ignored by caller
	}
	return null;
}

function routeRowToResult(
	route: ModelRouteRow,
	provider: ProviderRow,
	endpoint: VerifiedModelEndpointSnapshot,
	dataPolicySubjectFingerprint: string,
): RouteResult {
	const protocol = normalizeUpstreamProtocol(route.upstream_protocol);
	const providerEndpoints = parseProviderEndpoints(provider);
	const customParams = parseJsonObject(route.custom_params);
	const routingMetadata = parseRouteRoutingMetadata(route.routing_metadata);
	if (route.custom_params && !customParams) {
		console.warn(
			`[Gateway Router] ignored invalid custom_params JSON routeId=${route.id} modelId=${route.model_id}`
		);
	}

	const routeGroup =
		typeof route.route_group === 'string' && route.route_group.trim() !== ''
			? route.route_group
			: 'default';

	const routeWeight = typeof route.weight === 'number' && route.weight > 0 ? route.weight : 1;

	return {
		targetId: route.id,
		modelSurfaceId: null,
		routePoolId: route.route_pool_id ?? null,
		providerId: provider.id,
		providerName: provider.name,
		providerModelName: route.provider_model_name,
		endpoint,
		dataPolicySubjectFingerprint,
		upstreamProtocol: protocol,
		upstreamOperation: route.upstream_operation ?? '*',
		adapter: route.adapter ?? 'passthrough',
		providerEndpoints,
		providerApiKey: provider.api_key ?? '',
		providerSharedChannelType: provider.shared_channel_type ?? null,
		priceOverrideRaw: route.price_override,
		routeMeteredProfileJson: extractMeteredProfileFromPriceOverrideJson(route.price_override),
		routeChargedProfileJson: extractChargedProfileFromPriceOverrideJson(route.price_override),
		customParams,
		routingMetadata,
		routeGroup,
		routePriority: route.priority,
		routeWeight,
		providerKeyId: provider.id,
		providerKeyLabel: provider.name,
		providerKeyFingerprint: fingerprintProviderApiKey(provider.api_key ?? ''),
	};
}

function providerIsCallableForRoute(
	provider: ProviderRow | undefined,
	route: ModelRouteRow,
): provider is ProviderRow {
	if (
		!provider
		|| provider.status !== 'active'
		|| Boolean(provider.shared_channel_type?.trim())
		|| !provider.api_key?.trim()
		|| isPendingProviderImportApiKey(provider.api_key)
	) {
		return false;
	}
	try {
		return providerSupportsUpstreamProtocol(
			normalizeUpstreamProtocol(route.upstream_protocol),
			provider,
		);
	} catch {
		return false;
	}
}

export interface SurfaceRouteResolution {
	surface: ResolvedModelSurfaceRow | null;
	routes: RouteResult[];
}

/** request surface 只接收与显式 adapter 拓扑完全匹配的 target。 */
export function routeMatchesSurface(
	route: Pick<RouteResult, 'adapter' | 'upstreamProtocol' | 'upstreamOperation'>,
	request: { protocol: UpstreamProtocol; operation: string }
): boolean {
	return isRouteAdapterCompatible({
		adapter: route.adapter,
		requestProtocol: request.protocol,
		requestOperation: request.operation,
		upstreamProtocol: route.upstreamProtocol,
		upstreamOperation: route.upstreamOperation,
	});
}

/**
 * Resolve an ingress surface to its pool targets.
 *
 * Exact operation surfaces win; migrated wildcard surfaces are the compatibility fallback.
 * If migration 0016 has not been applied yet, the legacy model/group/protocol path remains
 * available so code and schema can be rolled out without a request outage.
 */
export async function resolveRoutesForSurface(
	repos: GatewayRepositories,
	params: {
		modelId: string;
		routeGroup: string;
		requestProtocol: UpstreamProtocol;
		requestOperation: string;
	}
): Promise<SurfaceRouteResolution> {
	let surface: ResolvedModelSurfaceRow | null = null;
	try {
		surface = await repos.modelRouting.resolveModelSurface(params);
	} catch (error) {
		console.warn('[Gateway Router] surface lookup unavailable; using legacy route selection', {
			modelId: params.modelId,
			requestProtocol: params.requestProtocol,
			requestOperation: params.requestOperation,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const rows = surface
		? await repos.modelRouting.getModelRoutesByPoolId(surface.route_pool_id)
		: selectActiveRouteRows(
				await repos.modelRouting.getModelRoutesByModelId(params.modelId),
				params.routeGroup
			);
	const routes = (await resolveRouteResultsFromRows(repos, rows))
		.map((route) => ({
			...route,
			modelSurfaceId: surface?.id ?? null,
			upstreamOperation: effectiveUpstreamOperation(
				route.upstreamOperation,
				params.requestOperation
			),
		}))
		.filter(
			(route) =>
				route.endpoint !== undefined &&
				modelEndpointSupportsOperation(
					route.endpoint,
					route.upstreamOperation
				) &&
				routeMatchesSurface(route, {
					protocol: params.requestProtocol,
					operation: params.requestOperation,
				})
		);
	return { surface, routes };
}

/**
 * 将已筛选、已排序的 `model_routes` 行转为 `RouteResult[]`（顺序不变，通常应按 priority DESC）。
 * @param repos 网关仓储（按行查 provider）
 * @param rows 来自 `getModelRoutesByModelId` 或筛选子集
 * @returns 解析失败的行会被跳过（如 provider 缺失 / disabled / 无 api_key）
 */
export async function resolveRouteResultsFromRows(
	repos: GatewayRepositories,
	rows: ModelRouteRow[]
): Promise<RouteResult[]> {
	const routeTargetIds = [...new Set(rows.map((route) => route.id))];
	const providerIds = [...new Set(rows.map((route) => route.provider_id))];
	if (routeTargetIds.length === 0) return [];
	if (routeTargetIds.length > 100 || providerIds.length > 100) {
		throw new RangeError('runtime route resolution exceeds the 100-row batch safety limit');
	}

	const now = new Date();
	const [bindings, providers] = await Promise.all([
		repos.modelEndpoints.listRuntimeBindingsByRouteTargetIds(routeTargetIds),
		repos.providers.getProvidersByIds(providerIds),
	]);
	const providersById = new Map(providers.map((provider) => [provider.id, provider]));
	const bindingsByTarget = new Map<string, (typeof bindings)[number] | null>();
	for (const binding of bindings) {
		bindingsByTarget.set(
			binding.route_target_id,
			bindingsByTarget.has(binding.route_target_id) ? null : binding,
		);
	}

	const resolved = await Promise.all(rows.map(async (route): Promise<RouteResult | null> => {
		const binding = bindingsByTarget.get(route.id);
		const provider = providersById.get(route.provider_id);
		if (!binding || !providerIsCallableForRoute(provider, route)) return null;
		if (binding.model_id !== route.model_id || binding.provider_id !== route.provider_id) return null;

		const endpoint = parseVerifiedModelEndpointSnapshot(binding, now);
		if (!endpoint || endpoint.modelId !== route.model_id || endpoint.providerId !== provider.id) {
			return null;
		}
		if (!verifiedEndpointMatchesLegacyRoutingMetadata(endpoint, route.routing_metadata)) {
			return null;
		}

		const currentSubjectFingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(
			route,
			provider,
		);
		if (
			!modelEndpointSubjectFingerprintIsValid(binding.subject_fingerprint)
			|| binding.subject_fingerprint !== currentSubjectFingerprint
		) {
			return null;
		}
		return routeRowToResult(route, provider, endpoint, currentSubjectFingerprint);
	}));
	return resolved.filter((route): route is RouteResult => route !== null);
}

/**
 * 解析某统一模型 id 下全部 active 路由，按 priority 从高到低，供流式请求前故障转移依次尝试。
 * @param repos 网关仓储
 * @param modelId `models.id`（不含 `:route_group` 后缀）
 */
export async function resolveAllRoutes(repos: GatewayRepositories, modelId: string): Promise<RouteResult[]> {
	const routes = await repos.modelRouting.getModelRoutesByModelId(modelId);
	return resolveRouteResultsFromRows(repos, routes);
}

/**
 * 返回某模型下 active 路由的原始行（未 JOIN provider；供按协议过滤后再 `resolveRouteResultsFromRows`）。
 * @param repos 网关仓储
 * @param modelId `models.id`
 */
export async function getActiveModelRouteRows(repos: GatewayRepositories, modelId: string): Promise<ModelRouteRow[]> {
	return repos.modelRouting.getModelRoutesByModelId(modelId);
}

/**
 * 仅取最高一条路由（单路）。
 * @param repos 网关仓储
 * @param modelId `models.id`
 * @deprecated 请使用 `resolveAllRoutes` + proxy 故障转移。
 */
export async function resolveModel(repos: GatewayRepositories, modelId: string): Promise<RouteResult | null> {
	const routes = await resolveAllRoutes(repos, modelId);
	return routes.length > 0 ? routes[0]! : null;
}
