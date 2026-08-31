import type { ResultSetHeader } from "mysql2/promise";
import type { MySqlDatabaseClient } from "../../storage/database-client";
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
import { asMySqlPool, toMySqlDateTime } from "./mysql2-compat";
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
	DATE_FORMAT(verified_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS verified_at,
	DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at, status,
	DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
	DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at`;

const RUNTIME_SELECT_COLUMNS = `mer.route_target_id, mer.subject_fingerprint,
	me.id, me.model_id, me.provider_id, me.provider_slug, me.tag, me.endpoint_class,
	me.region, me.context_length, me.max_prompt_tokens, me.max_completion_tokens,
	me.quantization, me.supported_parameters, me.pricing,
	me.supports_implicit_caching, me.supports_voice_cloning,
	me.supports_tool_choice, me.image_capabilities, me.audio_capabilities, me.evidence_url,
	me.verified_by,
	DATE_FORMAT(me.verified_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS verified_at,
	DATE_FORMAT(me.expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at,
	me.status,
	DATE_FORMAT(me.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
	DATE_FORMAT(me.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at`;

const BOOLEAN_COLUMNS = new Set([
	"supports_implicit_caching",
	"supports_voice_cloning",
]);
const TIMESTAMP_COLUMNS = new Set(["verified_at", "expires_at", "updated_at"]);
const PUBLICATION_RESERVED_COLUMNS = new Set([
	"status",
	"verified_by",
	"verified_at",
	"updated_at",
]);

function mysqlBoolean(value: unknown): unknown {
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
		mysqlBoolean(params.supportsImplicitCaching),
		mysqlBoolean(params.supportsVoiceCloning),
		params.supportsToolChoice,
		params.imageCapabilities,
		params.audioCapabilities ?? "{}",
		params.evidenceUrl,
		params.verifiedBy,
		params.verifiedAt === null ? null : toMySqlDateTime(params.verifiedAt),
		params.expiresAt === null ? null : toMySqlDateTime(params.expiresAt),
		params.status,
		toMySqlDateTime(params.createdAt),
		toMySqlDateTime(params.updatedAt),
	];
}

export function createMySqlModelEndpointsRepository(
	db: MySqlDatabaseClient
): ModelEndpointsRepository {
	const pool = asMySqlPool(db.raw);
	const query = async <T>(sql: string, params: unknown[] = []) =>
		(await pool.query(sql, params))[0] as T[];

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
		values.push(normalizeModelEndpointListLimit(filters.limit));
		values.push(normalizeModelEndpointListOffset(filters.offset));
		return query<ModelEndpointRow>(
			`SELECT ${SELECT_COLUMNS} FROM model_endpoints${where} ORDER BY model_id, provider_id, tag, id LIMIT ? OFFSET ?`,
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
						`SELECT ${SELECT_COLUMNS} FROM model_endpoints WHERE id = ?`,
						[id]
					)
				)[0] ?? null
			);
		},
		async getByIdentity(modelId, providerId, tag) {
			return (
				(
					await query<ModelEndpointRow>(
						`SELECT ${SELECT_COLUMNS} FROM model_endpoints
						 WHERE endpoint_identity_key = SHA2(CONCAT(CHAR_LENGTH(?), ':', ?, CHAR_LENGTH(?), ':', ?, CHAR_LENGTH(?), ':', ?), 256)
						   AND BINARY model_id = BINARY ? AND BINARY provider_id = BINARY ? AND BINARY tag = BINARY ?`,
						[
							modelId,
							modelId,
							providerId,
							providerId,
							tag,
							tag,
							modelId,
							providerId,
							tag,
						]
					)
				)[0] ?? null
			);
		},
		async insert(params) {
			assertInsertUnpublishedModelEndpointParams(params);
			await pool.execute(
				`INSERT INTO model_endpoints (${COLUMNS}) VALUES (${Array.from(
					{ length: 25 },
					() => "?"
				).join(",")})`,
				insertValues(params)
			);
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
				values.push(
					BOOLEAN_COLUMNS.has(key)
						? mysqlBoolean(value)
						: TIMESTAMP_COLUMNS.has(key) && typeof value === "string"
						? toMySqlDateTime(value)
						: value
				);
			}
			assignments.push(
				"status = ?",
				"verified_by = NULL",
				"verified_at = NULL",
				"updated_at = ?"
			);
			values.push(params.status, toMySqlDateTime(params.updatedAt));
			const [result] = await pool.execute<ResultSetHeader>(
				`UPDATE model_endpoints SET ${assignments.join(", ")} WHERE id = ?`,
				[...values, id]
			);
			return result.affectedRows;
		},
		async delete(id) {
			const [result] = await pool.execute<ResultSetHeader>(
				"DELETE FROM model_endpoints WHERE id = ?",
				[id]
			);
			return result.affectedRows;
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
				`SELECT endpoint_id, route_target_id, subject_fingerprint, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at FROM model_endpoint_routes WHERE endpoint_id IN (${ids
					.map(() => "?")
					.join(",")}) ORDER BY endpoint_id, route_target_id`,
				ids
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
				 WHERE mer.endpoint_id IN (${ids.map(() => "?").join(",")})
				 ORDER BY mer.endpoint_id, mr.id
				 LIMIT ${MAX_MODEL_ENDPOINT_DISCOVERY_BINDING_RESULTS}`,
				ids
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
				 WHERE mer.route_target_id IN (${ids.map(() => "?").join(",")})
				 ORDER BY mer.route_target_id, me.id`,
				ids
			);
		},
		async linkRoute(params) {
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				const [rows] = await connection.query<
					Array<{ status: string; updated_at: string }>
				>(
					`SELECT status, DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
					 FROM model_endpoints WHERE id = ? FOR UPDATE`,
					[params.endpointId]
				);
				const current = rows[0];
				if (
					!current ||
					current.status !== params.expectedEndpointStatus ||
					current.updated_at !== params.expectedEndpointUpdatedAt
				) {
					await connection.commit();
					return false;
				}
				await connection.execute(
					"INSERT INTO model_endpoint_routes (endpoint_id, route_target_id, subject_fingerprint, created_at) VALUES (?, ?, ?, ?)",
					[
						params.endpointId,
						params.routeTargetId,
						params.subjectFingerprint,
						toMySqlDateTime(params.createdAt),
					]
				);
				if (params.expectedEndpointStatus === "verified") {
					await connection.execute(
						"UPDATE model_endpoints SET status = 'draft', verified_by = NULL, verified_at = NULL, updated_at = ? WHERE id = ?",
						[toMySqlDateTime(params.updatedAt), params.endpointId]
					);
				}
				await connection.commit();
				return true;
			} catch (error) {
				await connection.rollback();
				throw error;
			} finally {
				connection.release();
			}
		},
		async publishVerified(params) {
			assertPublishVerifiedModelEndpointParams(params);
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				const [endpointRows] = await connection.query<
					Array<{ status: string; updated_at: string }>
				>(
					`SELECT status, DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
					 FROM model_endpoints WHERE id = ? FOR UPDATE`,
					[params.endpointId]
				);
				const currentEndpoint = endpointRows[0];
				if (
					!currentEndpoint ||
					currentEndpoint.status !== params.expectedStatus ||
					currentEndpoint.updated_at !== params.expectedUpdatedAt
				) {
					await connection.commit();
					return false;
				}

				const expectedSubjects = [...params.routeSubjects].sort((left, right) =>
					left.routeTargetId.localeCompare(right.routeTargetId)
				);
				const [currentSubjects] = await connection.query<
					Array<{
						route_target_id: string;
						subject_fingerprint: string | null;
					}>
				>(
					"SELECT route_target_id, subject_fingerprint FROM model_endpoint_routes WHERE endpoint_id = ? ORDER BY route_target_id FOR UPDATE",
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
					await connection.commit();
					return false;
				}

				for (const subject of expectedSubjects) {
					if (
						subject.expectedSubjectFingerprint === subject.subjectFingerprint
					) {
						continue;
					}
					const [updated] = await connection.execute<ResultSetHeader>(
						"UPDATE model_endpoint_routes SET subject_fingerprint = ? WHERE endpoint_id = ? AND route_target_id = ?",
						[
							subject.subjectFingerprint,
							params.endpointId,
							subject.routeTargetId,
						]
					);
					if (updated.affectedRows !== 1) {
						throw new Error("Model endpoint route changed during publication");
					}
				}

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
					values.push(
						BOOLEAN_COLUMNS.has(key)
							? mysqlBoolean(value)
							: TIMESTAMP_COLUMNS.has(key) && typeof value === "string"
							? toMySqlDateTime(value)
							: value
					);
				}
				assignments.push(
					"status = 'verified'",
					"verified_by = ?",
					"verified_at = ?",
					"updated_at = ?"
				);
				values.push(
					params.verifiedBy,
					toMySqlDateTime(params.verifiedAt),
					toMySqlDateTime(params.updatedAt),
					params.endpointId
				);
				const [published] = await connection.execute<ResultSetHeader>(
					`UPDATE model_endpoints SET ${assignments.join(", ")} WHERE id = ?`,
					values
				);
				if (published.affectedRows !== 1) {
					throw new Error("Model endpoint changed during publication");
				}
				await connection.commit();
				return true;
			} catch (error) {
				await connection.rollback();
				throw error;
			} finally {
				connection.release();
			}
		},
		async unlinkRoute(params) {
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				await connection.query(
					"SELECT id FROM model_endpoints WHERE id = ? FOR UPDATE",
					[params.endpointId]
				);
				const [result] = await connection.execute<ResultSetHeader>(
					"DELETE FROM model_endpoint_routes WHERE endpoint_id = ? AND route_target_id = ?",
					[params.endpointId, params.routeTargetId]
				);
				await connection.commit();
				return result.affectedRows;
			} catch (error) {
				await connection.rollback();
				throw error;
			} finally {
				connection.release();
			}
		},
	};
}
