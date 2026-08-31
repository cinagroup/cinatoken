import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMySqlModelEndpointsRepository } from "../db/mysql/model-endpoints.impl";
import { createPostgresModelEndpointsRepository } from "../db/postgres/model-endpoints.impl";
import type {
	InsertUnpublishedModelEndpointParams,
	ModelEndpointRow,
} from "../db/model-endpoints-types";
import type {
	MySqlDatabaseClient,
	PostgresDatabaseClient,
} from "./database-client";

const AUDIO_CAPABILITIES = JSON.stringify({
	v: 1,
	pricing_by_operation: {
		"audio.transcriptions": {
			currency: "USD",
			meter: {
				kind: "duration",
				unit: "second",
				price: "0.0001",
				minimum_units: 1,
				increment_units: 1,
			},
		},
	},
});

function insertParams(): InsertUnpublishedModelEndpointParams {
	return {
		id: "endpoint-1",
		modelId: "model-1",
		providerId: "provider-1",
		providerSlug: "provider-one",
		tag: "standard",
		endpointClass: "standard",
		region: null,
		contextLength: null,
		maxPromptTokens: null,
		maxCompletionTokens: null,
		quantization: null,
		supportedParameters: "[]",
		pricing: "{}",
		supportsImplicitCaching: null,
		supportsVoiceCloning: null,
		supportsToolChoice:
			'{"auto":null,"function":null,"none":null,"required":null}',
		imageCapabilities: "{}",
		audioCapabilities: AUDIO_CAPABILITIES,
		evidenceUrl: null,
		verifiedBy: null,
		verifiedAt: null,
		expiresAt: null,
		status: "draft",
		createdAt: "2026-08-30T00:00:00.000Z",
		updatedAt: "2026-08-30T00:00:00.000Z",
	};
}

function row(): ModelEndpointRow {
	const params = insertParams();
	return {
		id: params.id,
		model_id: params.modelId,
		provider_id: params.providerId,
		provider_slug: params.providerSlug,
		tag: params.tag,
		endpoint_class: params.endpointClass,
		region: params.region,
		context_length: params.contextLength,
		max_prompt_tokens: params.maxPromptTokens,
		max_completion_tokens: params.maxCompletionTokens,
		quantization: params.quantization,
		supported_parameters: params.supportedParameters,
		pricing: params.pricing,
		supports_implicit_caching: params.supportsImplicitCaching,
		supports_voice_cloning: params.supportsVoiceCloning,
		supports_tool_choice: params.supportsToolChoice,
		image_capabilities: params.imageCapabilities,
		audio_capabilities: params.audioCapabilities ?? "{}",
		evidence_url: params.evidenceUrl,
		verified_by: params.verifiedBy,
		verified_at: params.verifiedAt,
		expires_at: params.expiresAt,
		status: params.status,
		created_at: params.createdAt,
		updated_at: params.updatedAt,
	};
}

describe("SQL model-endpoint repositories", () => {
	it("round-trips and patches audio_capabilities through PostgreSQL CRUD", async () => {
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const raw = {
			async unsafe(sql: string, params: unknown[] = []): Promise<unknown[]> {
				calls.push({ sql, params });
				if (/^SELECT/u.test(sql.trim())) return [row()];
				if (/\bRETURNING id\b/u.test(sql)) return [{ id: "endpoint-1" }];
				return [];
			},
		};
		const repository = createPostgresModelEndpointsRepository({
			driver: "postgres",
			raw,
			drizzle: {},
		} as unknown as PostgresDatabaseClient);

		await repository.insert(insertParams());
		const inserted = calls.at(-1)!;
		assert.match(inserted.sql, /image_capabilities, audio_capabilities/u);
		assert.equal(inserted.params.length, 25);
		assert.equal(inserted.params[17], AUDIO_CAPABILITIES);
		const callsAfterInsert = calls.length;
		await assert.rejects(
			repository.insert({
				...insertParams(),
				status: "verified",
				verifiedBy: "admin-1",
				verifiedAt: "2026-08-30T00:00:00.000Z",
			} as never),
			/model endpoint insertion cannot publish verification state/u
		);
		assert.equal(calls.length, callsAfterInsert);

		assert.equal(
			(await repository.getById("endpoint-1"))?.audio_capabilities,
			AUDIO_CAPABILITIES
		);
		assert.match(calls.at(-1)!.sql, /audio_capabilities/u);
		assert.equal(
			(await repository.getByIdentity?.("model-1", "provider-1", "standard"))
				?.id,
			"endpoint-1"
		);
		assert.match(
			calls.at(-1)!.sql,
			/WHERE model_id = \$1 AND provider_id = \$2 AND tag = \$3/u
		);
		assert.deepEqual(calls.at(-1)!.params, [
			"model-1",
			"provider-1",
			"standard",
		]);
		await repository.listRuntimeBindingsByRouteTargetIds(["route-1"]);
		assert.match(calls.at(-1)!.sql, /me\.audio_capabilities/u);
		assert.equal(
			await repository.updateUnpublished("endpoint-1", {
				status: "draft",
				updatedAt: "2026-08-30T01:00:00.000Z",
				endpointPatch: {
					audio_capabilities: "{}",
					status: "verified",
					unsafe_column: "ignored",
				},
			}),
			1
		);
		assert.match(calls.at(-1)!.sql, /SET audio_capabilities = \$1/u);
		assert.deepEqual(calls.at(-1)!.params, [
			"{}",
			"draft",
			"2026-08-30T01:00:00.000Z",
			"endpoint-1",
		]);
		assert.equal(await repository.delete("endpoint-1"), 1);
	});

	it("round-trips and patches audio_capabilities through MySQL CRUD", async () => {
		const calls: Array<{
			kind: "query" | "execute";
			sql: string;
			params: unknown[];
		}> = [];
		const raw = {
			async query(
				sql: string,
				params: unknown[] = []
			): Promise<[unknown[], unknown]> {
				calls.push({ kind: "query", sql, params });
				return [[row()], undefined];
			},
			async execute(
				sql: string,
				params: unknown[] = []
			): Promise<[unknown, unknown]> {
				calls.push({ kind: "execute", sql, params });
				return [{ affectedRows: 1 }, undefined];
			},
		};
		const repository = createMySqlModelEndpointsRepository({
			driver: "mysql",
			raw,
			drizzle: {},
		} as unknown as MySqlDatabaseClient);

		await repository.insert(insertParams());
		const inserted = calls.at(-1)!;
		assert.match(inserted.sql, /image_capabilities, audio_capabilities/u);
		assert.equal(inserted.params.length, 25);
		assert.equal(inserted.params[17], AUDIO_CAPABILITIES);
		const callsAfterInsert = calls.length;
		await assert.rejects(
			repository.insert({
				...insertParams(),
				status: "verified",
				verifiedBy: "admin-1",
				verifiedAt: "2026-08-30T00:00:00.000Z",
			} as never),
			/model endpoint insertion cannot publish verification state/u
		);
		assert.equal(calls.length, callsAfterInsert);

		assert.equal(
			(await repository.getById("endpoint-1"))?.audio_capabilities,
			AUDIO_CAPABILITIES
		);
		assert.match(calls.at(-1)!.sql, /audio_capabilities/u);
		assert.equal(
			(await repository.getByIdentity?.("model-1", "provider-1", "standard"))
				?.id,
			"endpoint-1"
		);
		assert.match(calls.at(-1)!.sql, /endpoint_identity_key = SHA2\(CONCAT/u);
		assert.deepEqual(calls.at(-1)!.params, [
			"model-1",
			"model-1",
			"provider-1",
			"provider-1",
			"standard",
			"standard",
			"model-1",
			"provider-1",
			"standard",
		]);
		await repository.listRuntimeBindingsByRouteTargetIds(["route-1"]);
		assert.match(calls.at(-1)!.sql, /me\.audio_capabilities/u);
		assert.equal(
			await repository.updateUnpublished("endpoint-1", {
				status: "draft",
				updatedAt: "2026-08-30T01:00:00.000Z",
				endpointPatch: {
					audio_capabilities: "{}",
					status: "verified",
					unsafe_column: "ignored",
				},
			}),
			1
		);
		assert.match(calls.at(-1)!.sql, /SET audio_capabilities = \?/u);
		assert.deepEqual(calls.at(-1)!.params, [
			"{}",
			"draft",
			"2026-08-30 01:00:00.000000",
			"endpoint-1",
		]);
		assert.equal(await repository.delete("endpoint-1"), 1);
	});

	it("publishes PostgreSQL endpoint subjects inside one rollback-capable transaction", async () => {
		const events: string[] = [];
		let failSubjectWrite = false;
		const transaction = {
			async unsafe(sql: string): Promise<unknown[]> {
				if (/SELECT status, updated_at::text/u.test(sql)) {
					events.push("select:endpoint:for-update");
					return [{ status: "draft", updated_at: "2026-08-30 00:00:00+00" }];
				}
				if (/SELECT route_target_id, subject_fingerprint/u.test(sql)) {
					events.push("select:subjects:for-update");
					return [{ route_target_id: "route-1", subject_fingerprint: null }];
				}
				if (/UPDATE model_endpoint_routes/u.test(sql)) {
					events.push("update:subject");
					if (failSubjectWrite) throw new Error("injected subject failure");
					return [{ endpoint_id: "endpoint-1" }];
				}
				if (/UPDATE model_endpoints/u.test(sql)) {
					events.push("update:endpoint:verified");
					return [{ id: "endpoint-1" }];
				}
				return [];
			},
		};
		const raw = {
			unsafe: async () => [],
			async begin<T>(
				callback: (tx: typeof transaction) => Promise<T>
			): Promise<T> {
				events.push("begin");
				try {
					const result = await callback(transaction);
					events.push("commit");
					return result;
				} catch (error) {
					events.push("rollback");
					throw error;
				}
			},
		};
		const repository = createPostgresModelEndpointsRepository({
			driver: "postgres",
			raw,
			drizzle: {},
		} as unknown as PostgresDatabaseClient);
		const params = {
			endpointId: "endpoint-1",
			expectedStatus: "draft" as const,
			expectedUpdatedAt: "2026-08-30 00:00:00+00",
			endpointPatch: { evidence_url: "https://provider.example/model-1" },
			verifiedBy: "admin-1",
			verifiedAt: "2026-08-30T01:00:00.000Z",
			updatedAt: "2026-08-30T01:00:00.000Z",
			routeSubjects: [
				{
					routeTargetId: "route-1",
					expectedSubjectFingerprint: null,
					subjectFingerprint: "a".repeat(64),
				},
			],
		};

		assert.equal(await repository.publishVerified(params), true);
		assert.deepEqual(events, [
			"begin",
			"select:endpoint:for-update",
			"select:subjects:for-update",
			"update:subject",
			"update:endpoint:verified",
			"commit",
		]);

		events.length = 0;
		failSubjectWrite = true;
		await assert.rejects(
			repository.publishVerified(params),
			/injected subject failure/u
		);
		assert.deepEqual(events, [
			"begin",
			"select:endpoint:for-update",
			"select:subjects:for-update",
			"update:subject",
			"rollback",
		]);
	});

	it("publishes MySQL endpoint subjects on one connection and rolls failures back", async () => {
		const events: string[] = [];
		let failSubjectWrite = false;
		let zeroSubjectWrite = false;
		let zeroEndpointWrite = false;
		let currentSubjectFingerprint: string | null = null;
		const connection = {
			async beginTransaction() {
				events.push("begin");
			},
			async commit() {
				events.push("commit");
			},
			async rollback() {
				events.push("rollback");
			},
			release() {
				events.push("release");
			},
			async query(sql: string): Promise<[unknown[], undefined]> {
				if (/SELECT status, DATE_FORMAT/u.test(sql)) {
					events.push("select:endpoint:for-update");
					return [
						[{ status: "draft", updated_at: "2026-08-30T00:00:00.000000Z" }],
						undefined,
					];
				}
				events.push("select:subjects:for-update");
				return [
					[
						{
							route_target_id: "route-1",
							subject_fingerprint: currentSubjectFingerprint,
						},
					],
					undefined,
				];
			},
			async execute(sql: string): Promise<[unknown, undefined]> {
				if (/UPDATE model_endpoint_routes/u.test(sql)) {
					events.push("update:subject");
					if (failSubjectWrite) throw new Error("injected subject failure");
					if (zeroSubjectWrite) return [{ affectedRows: 0 }, undefined];
					return [{ affectedRows: 1 }, undefined];
				}
				events.push("update:endpoint:verified");
				if (zeroEndpointWrite) return [{ affectedRows: 0 }, undefined];
				return [{ affectedRows: 1 }, undefined];
			},
		};
		const raw = {
			query: async () => [[], undefined],
			execute: async () => [{ affectedRows: 0 }, undefined],
			getConnection: async () => connection,
		};
		const repository = createMySqlModelEndpointsRepository({
			driver: "mysql",
			raw,
			drizzle: {},
		} as unknown as MySqlDatabaseClient);
		const params = {
			endpointId: "endpoint-1",
			expectedStatus: "draft" as const,
			expectedUpdatedAt: "2026-08-30T00:00:00.000000Z",
			endpointPatch: { evidence_url: "https://provider.example/model-1" },
			verifiedBy: "admin-1",
			verifiedAt: "2026-08-30T01:00:00.000Z",
			updatedAt: "2026-08-30T01:00:00.000Z",
			routeSubjects: [
				{
					routeTargetId: "route-1",
					expectedSubjectFingerprint: null,
					subjectFingerprint: "a".repeat(64),
				},
			],
		};

		assert.equal(await repository.publishVerified(params), true);
		assert.deepEqual(events, [
			"begin",
			"select:endpoint:for-update",
			"select:subjects:for-update",
			"update:subject",
			"update:endpoint:verified",
			"commit",
			"release",
		]);

		events.length = 0;
		failSubjectWrite = true;
		await assert.rejects(
			repository.publishVerified(params),
			/injected subject failure/u
		);
		assert.deepEqual(events, [
			"begin",
			"select:endpoint:for-update",
			"select:subjects:for-update",
			"update:subject",
			"rollback",
			"release",
		]);

		events.length = 0;
		failSubjectWrite = false;
		zeroSubjectWrite = true;
		await assert.rejects(
			repository.publishVerified(params),
			/Model endpoint route changed during publication/u
		);
		assert.deepEqual(events, [
			"begin",
			"select:endpoint:for-update",
			"select:subjects:for-update",
			"update:subject",
			"rollback",
			"release",
		]);

		events.length = 0;
		zeroSubjectWrite = false;
		zeroEndpointWrite = true;
		await assert.rejects(
			repository.publishVerified(params),
			/Model endpoint changed during publication/u
		);
		assert.deepEqual(events, [
			"begin",
			"select:endpoint:for-update",
			"select:subjects:for-update",
			"update:subject",
			"update:endpoint:verified",
			"rollback",
			"release",
		]);

		events.length = 0;
		zeroEndpointWrite = false;
		currentSubjectFingerprint = "a".repeat(64);
		assert.equal(
			await repository.publishVerified({
				...params,
				routeSubjects: [
					{
						routeTargetId: "route-1",
						expectedSubjectFingerprint: "a".repeat(64),
						subjectFingerprint: "a".repeat(64),
					},
				],
			}),
			true
		);
		assert.deepEqual(events, [
			"begin",
			"select:endpoint:for-update",
			"select:subjects:for-update",
			"update:endpoint:verified",
			"commit",
			"release",
		]);
	});
});
