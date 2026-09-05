/**
 * Postgres：推理路径模型/路由查询。
 */
import { and, desc, eq } from 'drizzle-orm';
import { MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS } from '../model-modalities';
import type { ModelRow, ModelRouteRow } from '../../types';
import type { ResolvedModelSurfaceRow } from '../../route-topology';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { ModelRoutingRepository } from '../../storage/gateway-repository-interfaces';
import { modelRoutesTable as pgModelRoutesTable } from '../../storage/drizzle/schema.pg';

function mapPgModelRouteToRow(r: {
	id: string;
	modelId: string;
	providerId: string;
	providerModelName: string;
	priority: number;
	status: string;
	routeGroup: string;
	weight: number;
	priceOverride: string | null;
	customParams: string | null;
	routingMetadata: string | null;
	upstreamProtocol: string;
	routePoolId: string | null;
	upstreamOperation: string;
	adapter: string;
	createdAt: string;
}): ModelRouteRow {
	return {
		id: r.id,
		model_id: r.modelId,
		provider_id: r.providerId,
		provider_model_name: r.providerModelName,
		priority: r.priority,
		status: r.status,
		route_group: r.routeGroup,
		weight: r.weight,
		price_override: r.priceOverride,
		custom_params: r.customParams,
		routing_metadata: r.routingMetadata,
		upstream_protocol: r.upstreamProtocol,
		route_pool_id: r.routePoolId,
		upstream_operation: r.upstreamOperation,
		adapter: r.adapter,
	};
}

export function createPostgresModelRoutingRepository(db: PostgresDatabaseClient): ModelRoutingRepository {
	const drizzle = db.drizzle;
	const pg = db.raw;
	return {
		async getModelById(id: string): Promise<ModelRow | null> {
			const rows = await pg<ModelRow[]>`
		SELECT m.id, m.display_name, m.vendor, m.context_window, m.max_tokens, m.pricing_profile,
			(SELECT COALESCE(json_agg(tag ORDER BY tag)::text, '[]') FROM model_tags WHERE model_id = m.id) AS tags,
			m.description, m.metadata, m.input_modalities, m.output_modalities, m.released_at, m.route_policy, m.created_at::text
		FROM models m WHERE m.id = ${id}
	`;
			return rows[0] ?? null;
		},

		async listModelsWithActiveRoutes(): Promise<ModelRow[]> {
			const rows = await pg<ModelRow[]>`
		SELECT m.id, m.display_name, m.vendor, m.context_window, m.max_tokens, m.pricing_profile,
			(SELECT COALESCE(json_agg(mt.tag ORDER BY mt.tag)::text, '[]') FROM model_tags mt WHERE mt.model_id = m.id) AS tags,
			(SELECT COALESCE(json_agg(r.route_group ORDER BY r.route_group)::text, '[]') FROM model_routes r WHERE r.model_id = m.id AND r.status = 'active') AS route_groups,
			m.description, m.metadata, m.input_modalities, m.output_modalities, m.released_at, m.created_at::text
		FROM models m
		WHERE EXISTS (SELECT 1 FROM model_routes r WHERE r.model_id = m.id AND r.status = 'active')
		ORDER BY m.id
	`;
			return rows;
		},

		async listCallableEmbeddingModelCandidates(): Promise<ModelRow[]> {
			return pg<ModelRow[]>`
				SELECT m.id, m.display_name, m.vendor, m.context_window, m.max_tokens, m.pricing_profile,
					(SELECT COALESCE(json_agg(mt.tag ORDER BY mt.tag)::text, '[]') FROM model_tags mt WHERE mt.model_id = m.id) AS tags,
					m.description, m.metadata, m.input_modalities, m.output_modalities, m.released_at, m.created_at::text
				FROM models m
				WHERE m.output_modalities LIKE '%"embeddings"%'
				  AND EXISTS (
					SELECT 1
					FROM model_routes mr
					LEFT JOIN route_pools rp ON rp.id = mr.route_pool_id
					WHERE mr.model_id = m.id
					  AND mr.status = 'active'
					  AND (rp.status IS NULL OR rp.status <> 'disabled')
					  AND (
						(
						  EXISTS (SELECT 1 FROM model_surfaces ms_any WHERE ms_any.route_pool_id = mr.route_pool_id)
						  AND EXISTS (
							SELECT 1 FROM model_surfaces ms
							WHERE ms.route_pool_id = mr.route_pool_id
							  AND ms.status <> 'disabled'
							  AND ms.request_protocol = 'openai'
							  AND ms.request_operation IN ('embeddings', '*')
						  )
						)
						OR (
						  NOT EXISTS (SELECT 1 FROM model_surfaces ms_any WHERE ms_any.route_pool_id = mr.route_pool_id)
						  AND mr.upstream_protocol = 'openai'
						  AND mr.upstream_operation IN ('embeddings', '*')
						)
					  )
				  )
				ORDER BY m.id
				LIMIT ${MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS}
			`;
		},

		async getModelRoutesByModelId(modelId: string): Promise<ModelRouteRow[]> {
			const rows = await drizzle
				.select()
				.from(pgModelRoutesTable)
				.where(and(eq(pgModelRoutesTable.modelId, modelId), eq(pgModelRoutesTable.status, 'active')))
				.orderBy(desc(pgModelRoutesTable.priority));
			return rows.map(mapPgModelRouteToRow);
		},

		async resolveModelSurface(params): Promise<ResolvedModelSurfaceRow | null> {
			const rows = await pg<ResolvedModelSurfaceRow[]>`
				SELECT ms.id, ms.model_id, ms.route_group, ms.request_protocol, ms.request_operation,
					ms.route_pool_id, ms.status, ms.created_at::text, ms.updated_at::text,
					rp.name AS pool_name, rp.strategy AS pool_strategy,
					rp.tier_strategies AS pool_tier_strategies, rp.status AS pool_status,
					rp.sticky_enabled AS pool_sticky_enabled,
					rp.sticky_idle_ttl_seconds AS pool_sticky_idle_ttl_seconds,
					rp.sticky_epoch AS pool_sticky_epoch
				FROM model_surfaces ms
				JOIN route_pools rp ON rp.id = ms.route_pool_id
				WHERE ms.model_id = ${params.modelId}
				  AND lower(ms.route_group) = lower(${params.routeGroup})
				  AND lower(ms.request_protocol) = lower(${params.requestProtocol})
				  AND ms.request_operation IN (${params.requestOperation}, '*')
				  AND ms.status = 'active'
				  AND rp.status = 'active'
				ORDER BY CASE WHEN ms.request_operation = ${params.requestOperation} THEN 0 ELSE 1 END
				LIMIT 1
			`;
			return rows[0] ?? null;
		},

		async getModelRoutesByPoolId(poolId: string): Promise<ModelRouteRow[]> {
			const rows = await drizzle
				.select()
				.from(pgModelRoutesTable)
				.where(
					and(
						eq(pgModelRoutesTable.routePoolId, poolId),
						eq(pgModelRoutesTable.status, 'active')
					)
				)
				.orderBy(desc(pgModelRoutesTable.priority));
			return rows.map(mapPgModelRouteToRow);
		},
	};
}
