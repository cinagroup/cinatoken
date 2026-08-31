import type { D1DatabaseClient } from "../../storage/database-client";
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

const RUNTIME_COLUMNS = `mer.route_target_id, mer.subject_fingerprint,
	me.id, me.model_id, me.provider_id, me.provider_slug, me.tag, me.endpoint_class,
	me.region, me.context_length, me.max_prompt_tokens, me.max_completion_tokens,
	me.quantization, me.supported_parameters, me.pricing,
	me.supports_implicit_caching, me.supports_voice_cloning,
	me.supports_tool_choice, me.image_capabilities, me.audio_capabilities, me.evidence_url,
	me.verified_by, me.verified_at, me.expires_at, me.status, me.created_at, me.updated_at`;

const BOOLEAN_COLUMNS = new Set([
	"supports_implicit_caching",
	"supports_voice_cloning",
]);
const PUBLICATION_RESERVED_COLUMNS = new Set([
	"status",
	"verified_by",
	"verified_at",
	"updated_at",
]);

function sqliteBoolean(value: unknown): unknown {
	return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

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
		sqliteBoolean(params.supportsImplicitCaching),
		sqliteBoolean(params.supportsVoiceCloning),
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

export function createD1ModelEndpointsRepository(
	db: D1DatabaseClient
): ModelEndpointsRepository {
	const raw = db.raw;

	const list = async (
		filters: ModelEndpointListFilters = {}
	): Promise<ModelEndpointRow[]> => {
		const conditions: string[] = [];
		const values: unknown[] = [];
		if (filters.modelId !== undefined) {
			conditions.push("model_id = ?");
			values.push(filters.modelId);
		}
		if (filters.providerId !== undefined) {
			conditions.push("provider_id = ?");
			values.push(filters.providerId);
		}
		if (filters.status !== undefined) {
			conditions.push("status = ?");
			values.push(filters.status);
		}
		const where =
			conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const limit = normalizeModelEndpointListLimit(filters.limit);
		const offset = normalizeModelEndpointListOffset(filters.offset);
		const result = await raw
			.prepare(
				`SELECT ${COLUMNS} FROM model_endpoints${where} ORDER BY model_id, provider_id, tag, id LIMIT ? OFFSET ?`
			)
			.bind(...values, limit, offset)
			.all<ModelEndpointRow>();
		return result.results ?? [];
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
				(await raw
					.prepare(`SELECT ${COLUMNS} FROM model_endpoints WHERE id = ?`)
					.bind(id)
					.first<ModelEndpointRow>()) ?? null
			);
		},
		async getByIdentity(modelId, providerId, tag) {
			return (
				(await raw
					.prepare(
						`SELECT ${COLUMNS} FROM model_endpoints WHERE model_id = ? AND provider_id = ? AND tag = ?`
					)
					.bind(modelId, providerId, tag)
					.first<ModelEndpointRow>()) ?? null
			);
		},
		async insert(params) {
			assertInsertUnpublishedModelEndpointParams(params);
			await raw
				.prepare(
					`INSERT INTO model_endpoints (${COLUMNS}) VALUES (${Array.from(
						{ length: 25 },
						() => "?"
					).join(",")})`
				)
				.bind(...insertValues(params))
				.run();
		},
		async updateUnpublished(id, params) {
			if (params.status !== "draft" && params.status !== "disabled") {
				throw new TypeError("model endpoint unpublished update cannot verify");
			}
			const assignments: string[] = [];
			const values: unknown[] = [];
			for (const [key, value] of Object.entries(params.endpointPatch)) {
				if (
					value === undefined ||
					!MODEL_ENDPOINT_PATCH_COLS.has(key) ||
					PUBLICATION_RESERVED_COLUMNS.has(key)
				)
					continue;
				assignments.push(`${key} = ?`);
				values.push(BOOLEAN_COLUMNS.has(key) ? sqliteBoolean(value) : value);
			}
			assignments.push(
				"status = ?",
				"verified_by = NULL",
				"verified_at = NULL",
				"updated_at = ?"
			);
			values.push(params.status, params.updatedAt);
			const result = await raw
				.prepare(
					`UPDATE model_endpoints SET ${assignments.join(", ")} WHERE id = ?`
				)
				.bind(...values, id)
				.run();
			return result.meta.changes ?? 0;
		},
		async delete(id) {
			const result = await raw
				.prepare("DELETE FROM model_endpoints WHERE id = ?")
				.bind(id)
				.run();
			return result.meta.changes ?? 0;
		},
		async listRouteLinks(endpointIds) {
			if (endpointIds.length > MAX_MODEL_ENDPOINT_LIST_LIMIT) {
				throw new RangeError(
					`model endpoint route-link batch exceeds ${MAX_MODEL_ENDPOINT_LIST_LIMIT}`
				);
			}
			const ids = [...new Set(endpointIds)];
			if (ids.length === 0) return [];
			const result = await raw
				.prepare(
					`SELECT endpoint_id, route_target_id, subject_fingerprint, created_at FROM model_endpoint_routes WHERE endpoint_id IN (${ids
						.map(() => "?")
						.join(",")}) ORDER BY endpoint_id, route_target_id`
				)
				.bind(...ids)
				.all<ModelEndpointRouteLinkRow>();
			return result.results ?? [];
		},
		async listDiscoveryRouteBindings(endpointIds) {
			if (endpointIds.length > MAX_MODEL_ENDPOINT_LIST_LIMIT) {
				throw new RangeError(
					`model endpoint discovery binding batch exceeds ${MAX_MODEL_ENDPOINT_LIST_LIMIT}`
				);
			}
			const ids = [...new Set(endpointIds)];
			if (ids.length === 0) return [];
			const result = await raw
				.prepare(
					`SELECT mer.endpoint_id, mer.subject_fingerprint,
						mr.id, mr.model_id, mr.provider_id,
						mr.provider_model_name, mr.status, mr.route_group,
						mr.custom_params, mr.routing_metadata,
						mr.upstream_protocol, mr.upstream_operation, mr.adapter,
						mr.route_pool_id, rp.status AS pool_status
					 FROM model_endpoint_routes mer
					 JOIN model_routes mr ON mr.id = mer.route_target_id
					 LEFT JOIN route_pools rp ON rp.id = mr.route_pool_id
					 WHERE mer.endpoint_id IN (${ids.map(() => "?").join(",")})
					 ORDER BY mer.endpoint_id, mr.id
					 LIMIT ${MAX_MODEL_ENDPOINT_DISCOVERY_BINDING_RESULTS}`
				)
				.bind(...ids)
				.all<ModelEndpointDiscoveryRouteBindingRow>();
			return result.results ?? [];
		},
		async listRuntimeBindingsByRouteTargetIds(routeTargetIds) {
			if (routeTargetIds.length > MAX_MODEL_ENDPOINT_LIST_LIMIT) {
				throw new RangeError(
					`model endpoint runtime binding batch exceeds ${MAX_MODEL_ENDPOINT_LIST_LIMIT}`
				);
			}
			const ids = [...new Set(routeTargetIds)];
			if (ids.length === 0) return [];
			const result = await raw
				.prepare(
					`SELECT ${RUNTIME_COLUMNS}
					 FROM model_endpoint_routes mer
					 JOIN model_endpoints me ON me.id = mer.endpoint_id
					 WHERE mer.route_target_id IN (${ids.map(() => "?").join(",")})
					 ORDER BY mer.route_target_id, me.id`
				)
				.bind(...ids)
				.all<ModelEndpointRuntimeBindingRow>();
			return result.results ?? [];
		},
		async linkRoute(params) {
			const statements = [
				raw
					.prepare(
						`INSERT INTO model_endpoint_routes (endpoint_id, route_target_id, subject_fingerprint, created_at)
						 SELECT ?, ?, ?, ?
						 WHERE EXISTS (
							SELECT 1 FROM model_endpoints
							WHERE id = ? AND status = ? AND updated_at = ?
						 )`
					)
					.bind(
						params.endpointId,
						params.routeTargetId,
						params.subjectFingerprint,
						params.createdAt,
						params.endpointId,
						params.expectedEndpointStatus,
						params.expectedEndpointUpdatedAt
					),
			];
			if (params.expectedEndpointStatus === "verified") {
				statements.push(
					raw
						.prepare(
							`UPDATE model_endpoints
							 SET status = 'draft', verified_by = NULL, verified_at = NULL, updated_at = ?
							 WHERE id = ? AND status = 'verified' AND updated_at = ?`
						)
						.bind(
							params.updatedAt,
							params.endpointId,
							params.expectedEndpointUpdatedAt
						)
				);
			}
			const results = await raw.batch(statements);
			const inserted = results[0]?.meta.changes ?? 0;
			const demoted = results[1]?.meta.changes ?? 0;
			return (
				inserted === 1 &&
				(params.expectedEndpointStatus !== "verified" || demoted === 1)
			);
		},
		async publishVerified(params) {
			assertPublishVerifiedModelEndpointParams(params);
			const publicationToken = `publication:${crypto.randomUUID()}`;
			const subjects = [...params.routeSubjects].sort((left, right) =>
				left.routeTargetId.localeCompare(right.routeTargetId)
			);
			const assignments: string[] = [];
			const values: unknown[] = [];
			for (const [key, value] of Object.entries(params.endpointPatch)) {
				if (
					value === undefined ||
					!MODEL_ENDPOINT_PATCH_COLS.has(key) ||
					PUBLICATION_RESERVED_COLUMNS.has(key)
				) {
					continue;
				}
				assignments.push(`${key} = ?`);
				values.push(BOOLEAN_COLUMNS.has(key) ? sqliteBoolean(value) : value);
			}
			assignments.push(
				"status = 'verified'",
				"verified_by = ?",
				"verified_at = ?",
				"updated_at = ?"
			);
			values.push(params.verifiedBy, params.verifiedAt, params.updatedAt);

			const expectedSubjectsJson = JSON.stringify(
				subjects.map((subject) => ({
					routeTargetId: subject.routeTargetId,
					subjectFingerprint: subject.subjectFingerprint,
				}))
			);
			const statements = [
				raw
					.prepare(
						`UPDATE model_endpoints
						 SET status = 'draft', verified_by = ?, verified_at = NULL, updated_at = ?
						 WHERE id = ? AND status = ? AND updated_at = ?`
					)
					.bind(
						publicationToken,
						params.updatedAt,
						params.endpointId,
						params.expectedStatus,
						params.expectedUpdatedAt
					),
				...subjects.map((subject) =>
					raw
						.prepare(
							`UPDATE model_endpoint_routes
							 SET subject_fingerprint = ?
							 WHERE endpoint_id = ? AND route_target_id = ?
							   AND subject_fingerprint IS ?
							   AND EXISTS (
								SELECT 1 FROM model_endpoints
								WHERE id = ? AND status = 'draft' AND verified_by = ? AND updated_at = ?
							   )`
						)
						.bind(
							subject.subjectFingerprint,
							params.endpointId,
							subject.routeTargetId,
							subject.expectedSubjectFingerprint,
							params.endpointId,
							publicationToken,
							params.updatedAt
						)
				),
				raw
					.prepare(
						`UPDATE model_endpoints SET ${assignments.join(", ")}
						 WHERE id = ? AND status = 'draft' AND verified_by = ? AND updated_at = ?
						   AND (SELECT COUNT(*) FROM model_endpoint_routes WHERE endpoint_id = ?) = ?
						   AND (
							SELECT COUNT(*)
							FROM model_endpoint_routes mer
							JOIN json_each(?) expected
							  ON json_extract(expected.value, '$.routeTargetId') = mer.route_target_id
							 AND json_extract(expected.value, '$.subjectFingerprint') = mer.subject_fingerprint
							WHERE mer.endpoint_id = ?
						   ) = ?`
					)
					.bind(
						...values,
						params.endpointId,
						publicationToken,
						params.updatedAt,
						params.endpointId,
						subjects.length,
						expectedSubjectsJson,
						params.endpointId,
						subjects.length
					),
				raw
					.prepare(
						`UPDATE model_endpoints
						 SET verified_by = NULL, verified_at = NULL
						 WHERE id = ? AND status = 'draft' AND verified_by = ? AND updated_at = ?`
					)
					.bind(params.endpointId, publicationToken, params.updatedAt),
			];
			const results = await raw.batch(statements);
			const publicationResult = results[subjects.length + 1];
			return (publicationResult?.meta.changes ?? 0) === 1;
		},
		async unlinkRoute(params) {
			const result = await raw
				.prepare(
					"DELETE FROM model_endpoint_routes WHERE endpoint_id = ? AND route_target_id = ?"
				)
				.bind(params.endpointId, params.routeTargetId)
				.run();
			return result.meta.changes ?? 0;
		},
	};
}
