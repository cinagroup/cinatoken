import type { PostgresDatabaseClient } from "../../storage/database-client";
import type { ModelEndpointsRepository } from "../../storage/gateway-repository-interfaces";
import {
	MAX_MODEL_ENDPOINT_DISCOVERY_BINDING_RESULTS,
	MAX_MODEL_ENDPOINT_LIST_LIMIT,
	normalizeModelEndpointListLimit,
	normalizeModelEndpointListOffset,
	assertPublishVerifiedModelEndpointParams,
	assertInsertUnpublishedModelEndpointParams,
	type InsertUnpublishedModelEndpointParams,
	type ModelEndpointListFilters,
	type ModelEndpointRouteLinkRow,
	type ModelEndpointRow,
	type ModelEndpointRuntimeBindingRow,
} from "../model-endpoints-types";
import { MODEL_ENDPOINT_PATCH_COLS } from "../patch-allowlists";
import type { ModelEndpointDiscoveryRouteBindingRow } from "../../storage/repository-dtos";

const COLUMNS = `id, model_id, provider_id, provider_slug, tag, endpoint_class, region,
	context_length, max_prompt_tokens, max_completion_tokens, quantization,
	supported_parameters, pricing, supports_implicit_caching, supports_voice_cloning,
	supports_tool_choice, image_capabilities, audio_capabilities, evidence_url, verified_by, verified_at,
	expires_at, status, created_at, updated_at`;

const SELECT_COLUMNS = `id, model_id, provider_id, provider_slug, tag, endpoint_class, region,
	context_length, max_prompt_tokens, max_completion_tokens, quantization,
	supported_parameters, pricing, supports_implicit_caching, supports_voice_cloning,
	supports_tool_choice, image_capabilities, audio_capabilities, evidence_url, verified_by,
	verified_at::text AS verified_at, expires_at::text AS expires_at, status,
	created_at::text AS created_at, updated_at::text AS updated_at`;

const RUNTIME_SELECT_COLUMNS = `mer.route_target_id, mer.subject_fingerprint,
	me.id, me.model_id, me.provider_id, me.provider_slug, me.tag, me.endpoint_class,
	me.region, me.context_length, me.max_prompt_tokens, me.max_completion_tokens,
	me.quantization, me.supported_parameters, me.pricing,
	me.supports_implicit_caching, me.supports_voice_cloning,
	me.supports_tool_choice, me.image_capabilities, me.audio_capabilities, me.evidence_url,
	me.verified_by, me.verified_at::text AS verified_at,
	me.expires_at::text AS expires_at, me.status,
	me.created_at::text AS created_at, me.updated_at::text AS updated_at`;

const PUBLICATION_RESERVED_COLUMNS = new Set([
	"status",
	"verified_by",
	"verified_at",
	"updated_at",
]);

function insertValues(params: InsertUnpublishedModelEndpointParams): unknown[] {
	return [
		params.id,
		params.modelId,
		params.providerId,
		params.providerSlug,
		params.tag,
		params.endpointClass,
		params.region,
		params.contextLength,
		params.maxPromptTokens,
		params.maxCompletionTokens,
		params.quantization,
		params.supportedParameters,
		params.pricing,
		params.supportsImplicitCaching,
		params.supportsVoiceCloning,
		params.supportsToolChoice,
		params.imageCapabilities,
		params.audioCapabilities ?? "{}",
		params.evidenceUrl,
		params.verifiedBy,
		params.verifiedAt,
		params.expiresAt,
		params.status,
		params.createdAt,
		params.updatedAt,
	];
}

export function createPostgresModelEndpointsRepository(
	db: PostgresDatabaseClient
): ModelEndpointsRepository {
	const pg = db.raw;
	const query = async <T>(sql: string, params: unknown[] = []) =>
		(await pg.unsafe(sql, params as never[])) as unknown as T[];

	const list = async (
		filters: ModelEndpointListFilters = {}
	): Promise<ModelEndpointRow[]> => {
		const conditions: string[] = [];
		const values: unknown[] = [];
		const bind = (value: unknown) => {
			values.push(value);
			return `$${values.length}`;
		};
		if (filters.modelId !== undefined)
			conditions.push(`model_id = ${bind(filters.modelId)}`);
		if (filters.providerId !== undefined)
			conditions.push(`provider_id = ${bind(filters.providerId)}`);
		if (filters.status !== undefined)
			conditions.push(`status = ${bind(filters.status)}`);
		const where =
			conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const limitPlaceholder = bind(
			normalizeModelEndpointListLimit(filters.limit)
		);
		const offsetPlaceholder = bind(
			normalizeModelEndpointListOffset(filters.offset)
		);
		return query<ModelEndpointRow>(
			`SELECT ${SELECT_COLUMNS} FROM model_endpoints${where} ORDER BY model_id, provider_id, tag, id LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
			values
		);
	};

	return {
		list,
		listByModelId(modelId, options = {}) {
			return list({
				modelId,
				status: options.status,
				limit: options.limit,
				offset: options.offset,
			});
		},
		async getById(id) {
			return (
				(
					await query<ModelEndpointRow>(
						`SELECT ${SELECT_COLUMNS} FROM model_endpoints WHERE id = $1`,
						[id]
					)
				)[0] ?? null
			);
		},
		async getByIdentity(modelId, providerId, tag) {
			return (
				(
					await query<ModelEndpointRow>(
						`SELECT ${SELECT_COLUMNS} FROM model_endpoints WHERE model_id = $1 AND provider_id = $2 AND tag = $3`,
						[modelId, providerId, tag]
					)
				)[0] ?? null
			);
		},
		async insert(params) {
			assertInsertUnpublishedModelEndpointParams(params);
			const placeholders = Array.from(
				{ length: 25 },
				(_, index) => `$${index + 1}`
			).join(",");
			await query(
				`INSERT INTO model_endpoints (${COLUMNS}) VALUES (${placeholders})`,
				insertValues(params)
			);
		},
		async updateUnpublished(id, params) {
			if (params.status !== "draft" && params.status !== "disabled") {
				throw new TypeError("model endpoint unpublished update cannot verify");
			}
			const values: unknown[] = [];
			const assignments: string[] = [];
			for (const [key, value] of Object.entries(params.endpointPatch)) {
				if (
					value === undefined ||
					!MODEL_ENDPOINT_PATCH_COLS.has(key) ||
					PUBLICATION_RESERVED_COLUMNS.has(key)
				)
					continue;
				values.push(value);
				assignments.push(`${key} = $${values.length}`);
			}
			values.push(params.status);
			assignments.push(`status = $${values.length}`);
			assignments.push("verified_by = NULL", "verified_at = NULL");
			values.push(params.updatedAt);
			assignments.push(`updated_at = $${values.length}`);
			values.push(id);
			const rows = await query<{ id: string }>(
				`UPDATE model_endpoints SET ${assignments.join(", ")} WHERE id = $${
					values.length
				} RETURNING id`,
				values
			);
			return rows.length;
		},
		async delete(id) {
			return (
				await query<{ id: string }>(
					"DELETE FROM model_endpoints WHERE id = $1 RETURNING id",
					[id]
				)
			).length;
		},
		async listRouteLinks(endpointIds) {
			if (endpointIds.length > MAX_MODEL_ENDPOINT_LIST_LIMIT) {
				throw new RangeError(
					`model endpoint route-link batch exceeds ${MAX_MODEL_ENDPOINT_LIST_LIMIT}`
				);
			}
			const ids = [...new Set(endpointIds)];
			if (ids.length === 0) return [];
			return query<ModelEndpointRouteLinkRow>(
				"SELECT endpoint_id, route_target_id, subject_fingerprint, created_at::text AS created_at FROM model_endpoint_routes WHERE endpoint_id = ANY($1::text[]) ORDER BY endpoint_id, route_target_id",
				[ids]
			);
		},
		async listDiscoveryRouteBindings(endpointIds) {
			if (endpointIds.length > MAX_MODEL_ENDPOINT_LIST_LIMIT) {
				throw new RangeError(
					`model endpoint discovery binding batch exceeds ${MAX_MODEL_ENDPOINT_LIST_LIMIT}`
				);
			}
			const ids = [...new Set(endpointIds)];
			if (ids.length === 0) return [];
			return query<ModelEndpointDiscoveryRouteBindingRow>(
				`SELECT mer.endpoint_id, mer.subject_fingerprint,
					mr.id, mr.model_id, mr.provider_id,
					mr.provider_model_name, mr.status, mr.route_group,
					mr.custom_params, mr.routing_metadata,
					mr.upstream_protocol, mr.upstream_operation, mr.adapter,
					mr.route_pool_id, rp.status AS pool_status
				 FROM model_endpoint_routes mer
				 JOIN model_routes mr ON mr.id = mer.route_target_id
				 LEFT JOIN route_pools rp ON rp.id = mr.route_pool_id
				 WHERE mer.endpoint_id = ANY($1::text[])
				 ORDER BY mer.endpoint_id, mr.id
				 LIMIT ${MAX_MODEL_ENDPOINT_DISCOVERY_BINDING_RESULTS}`,
				[ids]
			);
		},
		async listRuntimeBindingsByRouteTargetIds(routeTargetIds) {
			if (routeTargetIds.length > MAX_MODEL_ENDPOINT_LIST_LIMIT) {
				throw new RangeError(
					`model endpoint runtime binding batch exceeds ${MAX_MODEL_ENDPOINT_LIST_LIMIT}`
				);
			}
			const ids = [...new Set(routeTargetIds)];
			if (ids.length === 0) return [];
			return query<ModelEndpointRuntimeBindingRow>(
				`SELECT ${RUNTIME_SELECT_COLUMNS}
				 FROM model_endpoint_routes mer
				 JOIN model_endpoints me ON me.id = mer.endpoint_id
				 WHERE mer.route_target_id = ANY($1::text[])
				 ORDER BY mer.route_target_id, me.id`,
				[ids]
			);
		},
		async linkRoute(params) {
			return pg.begin(async (transaction) => {
				const txQuery = async <T>(sql: string, values: unknown[] = []) =>
					(await transaction.unsafe(sql, values as never[])) as unknown as T[];
				const current = (
					await txQuery<{ status: string; updated_at: string }>(
						"SELECT status, updated_at::text AS updated_at FROM model_endpoints WHERE id = $1 FOR UPDATE",
						[params.endpointId]
					)
				)[0];
				if (
					!current ||
					current.status !== params.expectedEndpointStatus ||
					current.updated_at !== params.expectedEndpointUpdatedAt
				) {
					return false;
				}
				await txQuery(
					"INSERT INTO model_endpoint_routes (endpoint_id, route_target_id, subject_fingerprint, created_at) VALUES ($1, $2, $3, $4)",
					[
						params.endpointId,
						params.routeTargetId,
						params.subjectFingerprint,
						params.createdAt,
					]
				);
				if (params.expectedEndpointStatus === "verified") {
					await txQuery(
						"UPDATE model_endpoints SET status = 'draft', verified_by = NULL, verified_at = NULL, updated_at = $1 WHERE id = $2",
						[params.updatedAt, params.endpointId]
					);
				}
				return true;
			});
		},
		async publishVerified(params) {
			assertPublishVerifiedModelEndpointParams(params);
			return pg.begin(async (transaction) => {
				const txQuery = async <T>(sql: string, values: unknown[] = []) =>
					(await transaction.unsafe(sql, values as never[])) as unknown as T[];
				const currentEndpoint = (
					await txQuery<{ status: string; updated_at: string }>(
						"SELECT status, updated_at::text AS updated_at FROM model_endpoints WHERE id = $1 FOR UPDATE",
						[params.endpointId]
					)
				)[0];
				if (
					!currentEndpoint ||
					currentEndpoint.status !== params.expectedStatus ||
					currentEndpoint.updated_at !== params.expectedUpdatedAt
				) {
					return false;
				}

				const expectedSubjects = [...params.routeSubjects].sort((left, right) =>
					left.routeTargetId.localeCompare(right.routeTargetId)
				);
				const currentSubjects = await txQuery<{
					route_target_id: string;
					subject_fingerprint: string | null;
				}>(
					"SELECT route_target_id, subject_fingerprint FROM model_endpoint_routes WHERE endpoint_id = $1 ORDER BY route_target_id FOR UPDATE",
					[params.endpointId]
				);
				if (
					currentSubjects.length !== expectedSubjects.length ||
					currentSubjects.some((subject, index) => {
						const expected = expectedSubjects[index];
						return (
							!expected ||
							subject.route_target_id !== expected.routeTargetId ||
							subject.subject_fingerprint !==
								expected.expectedSubjectFingerprint
						);
					})
				) {
					return false;
				}

				for (const subject of expectedSubjects) {
					const updated = await txQuery<{ endpoint_id: string }>(
						"UPDATE model_endpoint_routes SET subject_fingerprint = $1 WHERE endpoint_id = $2 AND route_target_id = $3 RETURNING endpoint_id",
						[
							subject.subjectFingerprint,
							params.endpointId,
							subject.routeTargetId,
						]
					);
					if (updated.length !== 1) {
						throw new Error("Model endpoint route changed during publication");
					}
				}

				const values: unknown[] = [];
				const assignments: string[] = [];
				for (const [key, value] of Object.entries(params.endpointPatch)) {
					if (
						value === undefined ||
						!MODEL_ENDPOINT_PATCH_COLS.has(key) ||
						PUBLICATION_RESERVED_COLUMNS.has(key)
					) {
						continue;
					}
					values.push(value);
					assignments.push(`${key} = $${values.length}`);
				}
				for (const [column, value] of [
					["verified_by", params.verifiedBy],
					["verified_at", params.verifiedAt],
					["updated_at", params.updatedAt],
				] as const) {
					values.push(value);
					assignments.push(`${column} = $${values.length}`);
				}
				assignments.push("status = 'verified'");
				values.push(params.endpointId);
				const published = await txQuery<{ id: string }>(
					`UPDATE model_endpoints SET ${assignments.join(", ")} WHERE id = $${
						values.length
					} RETURNING id`,
					values
				);
				if (published.length !== 1) {
					throw new Error("Model endpoint changed during publication");
				}
				return true;
			});
		},
		async unlinkRoute(params) {
			return pg.begin(async (transaction) => {
				await transaction.unsafe(
					"SELECT id FROM model_endpoints WHERE id = $1 FOR UPDATE",
					[params.endpointId]
				);
				const rows = (await transaction.unsafe(
					"DELETE FROM model_endpoint_routes WHERE endpoint_id = $1 AND route_target_id = $2 RETURNING endpoint_id",
					[params.endpointId, params.routeTargetId]
				)) as unknown as { endpoint_id: string }[];
				return rows.length;
			});
		},
	};
}
