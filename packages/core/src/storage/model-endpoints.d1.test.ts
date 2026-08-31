import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import { createD1ModelEndpointsRepository } from "../db/d1/model-endpoints.impl";
import { createD1ProvidersRepository } from "../db/d1/providers.impl";
import type { InsertUnpublishedModelEndpointParams } from "../db/model-endpoints-types";
import type { D1DatabaseClient } from "./database-client";

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly values: SQLInputValue[] = []
	) {}
	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(
			this.database,
			this.sql,
			values
		) as unknown as D1PreparedStatement;
	}
	run(): D1Result {
		const result = this.database.prepare(this.sql).run(...this.values);
		return {
			success: true,
			results: [],
			meta: { changes: Number(result.changes) },
		} as unknown as D1Result;
	}
	first<T>(): T | null {
		return (this.database.prepare(this.sql).get(...this.values) ??
			null) as T | null;
	}
	all<T>(): D1Result<T> {
		return {
			success: true,
			results: this.database.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as unknown as D1Result<T>;
	}
}

function createClient(database: DatabaseSync): D1DatabaseClient {
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(
				database,
				sql
			) as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
			database.exec("BEGIN IMMEDIATE");
			try {
				const results: D1Result[] = [];
				for (const statement of statements) {
					results.push(await statement.run());
				}
				database.exec("COMMIT");
				return results;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
	return { driver: "d1", raw, drizzle: {} as D1DatabaseClient["drizzle"] };
}

function endpoint(
	id: string,
	tag: string
): InsertUnpublishedModelEndpointParams {
	return {
		id,
		modelId: "model-1",
		providerId: "provider-1",
		providerSlug: "provider-one",
		tag,
		endpointClass: "serverless",
		region: "sg",
		contextLength: 128_000,
		maxPromptTokens: 120_000,
		maxCompletionTokens: 8_000,
		quantization: null,
		supportedParameters: '["tools"]',
		pricing: '{"prompt":"0.000001"}',
		supportsImplicitCaching: true,
		supportsVoiceCloning: null,
		supportsToolChoice:
			'{"auto":true,"function":true,"none":true,"required":false}',
		imageCapabilities: "{}",
		audioCapabilities: JSON.stringify({
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
		}),
		evidenceUrl: null,
		verifiedBy: null,
		verifiedAt: null,
		expiresAt: null,
		status: "draft",
		createdAt: "2026-08-30T00:00:00.000Z",
		updatedAt: "2026-08-30T00:00:00.000Z",
	};
}

test("D1 model-endpoint repository provides bounded CRUD and route linking", async () => {
	const database = new DatabaseSync(":memory:");
	try {
		database.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE models (id TEXT PRIMARY KEY);
			CREATE TABLE providers (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				endpoints TEXT,
				api_key TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'active',
				description TEXT,
				shared_channel_type TEXT,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE route_pools (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL
			);
			CREATE TABLE model_routes (
				id TEXT PRIMARY KEY,
				model_id TEXT NOT NULL REFERENCES models(id),
				provider_id TEXT NOT NULL REFERENCES providers(id),
				provider_model_name TEXT NOT NULL,
				status TEXT NOT NULL,
				route_group TEXT NOT NULL DEFAULT 'default',
				custom_params TEXT,
				routing_metadata TEXT,
				upstream_protocol TEXT NOT NULL,
				upstream_operation TEXT NOT NULL,
				adapter TEXT NOT NULL,
				route_pool_id TEXT REFERENCES route_pools(id)
			);
			INSERT INTO models (id) VALUES ('model-1');
			INSERT INTO providers (id, name, endpoints, api_key)
			VALUES ('provider-1', 'Provider One', '{"openai":{"base":"https://one.example"}}', 'secret-one'),
			       ('provider-2', 'Provider Two', '{"openai":{"base":"https://two.example"}}', 'secret-two');
			INSERT INTO route_pools (id, status) VALUES ('pool-1', 'active');
			INSERT INTO model_routes
				(id, model_id, provider_id, provider_model_name, status, route_group,
				 custom_params, routing_metadata, upstream_protocol, upstream_operation,
				 adapter, route_pool_id)
			VALUES
				('route-1', 'model-1', 'provider-1', 'upstream-one', 'active', 'free', NULL,
				 '{"region":"sg"}', 'openai', 'chat', 'passthrough', 'pool-1'),
				('route-2', 'model-1', 'provider-1', 'upstream-two', 'active', 'default', NULL,
				 NULL, 'openai', 'chat', 'passthrough', NULL);
		`);
		database.exec(
			readFileSync(
				new URL(
					"../../migrations-d1/0047_model_endpoints.sql",
					import.meta.url
				),
				"utf8"
			)
		);

		database
			.prepare(
				"INSERT INTO model_endpoints (id, model_id, provider_id, provider_slug, tag) VALUES (?, ?, ?, ?, ?)"
			)
			.run(
				"endpoint-migrated",
				"model-1",
				"provider-1",
				"provider-one",
				"migrated"
			);
		database
			.prepare(
				"INSERT INTO model_endpoint_routes (endpoint_id, route_target_id, created_at) VALUES (?, ?, ?)"
			)
			.run("endpoint-migrated", "route-1", "2026-08-30T00:30:00.000Z");
		database.exec(
			readFileSync(
				new URL(
					"../../migrations-d1/0048_model_endpoint_route_subject_fingerprint.sql",
					import.meta.url
				),
				"utf8"
			)
		);
		assert.equal(
			database
				.prepare(
					"SELECT subject_fingerprint FROM model_endpoint_routes WHERE route_target_id = ?"
				)
				.get("route-1")?.subject_fingerprint,
			null,
			"the subject migration must leave pre-existing route links unverified"
		);
		database.exec(
			readFileSync(
				new URL(
					"../../migrations-d1/0049_model_endpoint_audio_capabilities.sql",
					import.meta.url
				),
				"utf8"
			)
		);
		assert.equal(
			database
				.prepare("SELECT audio_capabilities FROM model_endpoints WHERE id = ?")
				.get("endpoint-migrated")?.audio_capabilities,
			"{}",
			"the audio migration must leave existing endpoint pricing unknown"
		);
		database
			.prepare(
				"DELETE FROM model_endpoint_routes WHERE endpoint_id = ? AND route_target_id = ?"
			)
			.run("endpoint-migrated", "route-1");
		database
			.prepare("DELETE FROM model_endpoints WHERE id = ?")
			.run("endpoint-migrated");

		const repository = createD1ModelEndpointsRepository(createClient(database));
		await repository.insert(endpoint("endpoint-1", "primary"));
		await repository.insert(endpoint("endpoint-2", "fallback"));
		await assert.rejects(
			repository.insert({
				...endpoint("endpoint-direct-verified", "unsafe"),
				status: "verified",
				verifiedBy: "admin-1",
				verifiedAt: "2026-08-30T00:00:00.000Z",
			} as never),
			/model endpoint insertion cannot publish verification state/u
		);
		assert.equal(await repository.getById("endpoint-direct-verified"), null);

		assert.equal(
			(await repository.getById("endpoint-1"))?.supports_implicit_caching,
			1
		);
		assert.match(
			(await repository.getById("endpoint-1"))?.audio_capabilities ?? "",
			/audio\.transcriptions/
		);
		assert.equal(
			(await repository.getByIdentity?.("model-1", "provider-1", "primary"))
				?.id,
			"endpoint-1"
		);
		assert.equal(
			await repository.getByIdentity?.("model-1", "provider-1", "missing"),
			null
		);
		assert.deepEqual(
			(await repository.list({ modelId: "model-1", status: "draft" })).map(
				(row) => row.id
			),
			["endpoint-2", "endpoint-1"]
		);
		assert.equal(
			(await repository.listByModelId("model-1", { limit: 1 })).length,
			1
		);
		assert.deepEqual(
			(await repository.list({ modelId: "model-1", limit: 1, offset: 1 })).map(
				(row) => row.id
			),
			["endpoint-1"]
		);
		assert.deepEqual(
			(await repository.listByModelId("model-1", { limit: 1, offset: 1 })).map(
				(row) => row.id
			),
			["endpoint-1"]
		);

		assert.equal(
			await repository.updateUnpublished("endpoint-1", {
				status: "draft",
				updatedAt: "2026-08-30T00:00:00.000Z",
				endpointPatch: {
					evidence_url: "https://provider.example/models/model-1",
					status: "verified",
					verified_by: "bypass-admin",
					verified_at: "2026-08-30T01:00:00.000Z",
					created_at: "must-not-change",
					"status = 'disabled' WHERE 1=1 --": "ignored",
				},
			}),
			1
		);
		const unpublished = await repository.getById("endpoint-1");
		assert.equal(unpublished?.status, "draft");
		assert.equal(unpublished?.verified_by, null);
		assert.equal(unpublished?.verified_at, null);
		assert.equal(JSON.parse(unpublished?.audio_capabilities ?? "{}").v, 1);
		assert.equal(unpublished?.created_at, "2026-08-30T00:00:00.000Z");
		await assert.rejects(
			repository.updateUnpublished("endpoint-1", {
				status: "verified",
				updatedAt: "2026-08-30T01:00:00.000Z",
				endpointPatch: {},
			} as never),
			/cannot verify/u
		);

		assert.equal(
			await repository.linkRoute({
				endpointId: "endpoint-1",
				routeTargetId: "route-1",
				subjectFingerprint: "a".repeat(64),
				createdAt: "2026-08-30T01:00:00.000Z",
				expectedEndpointStatus: "draft",
				expectedEndpointUpdatedAt: "2026-08-30T00:00:00.000Z",
				updatedAt: "2026-08-30T01:00:00.000Z",
			}),
			true
		);
		assert.equal((await repository.getById("endpoint-1"))?.status, "draft");
		assert.deepEqual(
			(await repository.listDiscoveryRouteBindings(["endpoint-1"])).map(
				(row) => ({ ...row })
			),
			[
				{
					endpoint_id: "endpoint-1",
					subject_fingerprint: "a".repeat(64),
					id: "route-1",
					model_id: "model-1",
					provider_id: "provider-1",
					provider_model_name: "upstream-one",
					status: "active",
					route_group: "free",
					custom_params: null,
					routing_metadata: '{"region":"sg"}',
					upstream_protocol: "openai",
					upstream_operation: "chat",
					adapter: "passthrough",
					route_pool_id: "pool-1",
					pool_status: "active",
				},
			]
		);
		assert.deepEqual(
			(await repository.listRouteLinks(["endpoint-1"])).map((row) => ({
				...row,
			})),
			[
				{
					endpoint_id: "endpoint-1",
					route_target_id: "route-1",
					subject_fingerprint: "a".repeat(64),
					created_at: "2026-08-30T01:00:00.000Z",
				},
			]
		);
		assert.deepEqual(
			(await repository.listRuntimeBindingsByRouteTargetIds(["route-1"])).map(
				(row) => ({
					route_target_id: row.route_target_id,
					subject_fingerprint: row.subject_fingerprint,
					endpoint_id: row.id,
					model_id: row.model_id,
					provider_id: row.provider_id,
					audio_capabilities: row.audio_capabilities,
				})
			),
			[
				{
					route_target_id: "route-1",
					subject_fingerprint: "a".repeat(64),
					endpoint_id: "endpoint-1",
					model_id: "model-1",
					provider_id: "provider-1",
					audio_capabilities: endpoint("endpoint-1", "primary")
						.audioCapabilities,
				},
			]
		);
		assert.equal(
			await repository.publishVerified({
				endpointId: "endpoint-1",
				expectedStatus: "draft",
				expectedUpdatedAt: "2026-08-30T00:00:00.000Z",
				endpointPatch: {
					evidence_url: "https://provider.example/models/model-1",
				},
				verifiedBy: "admin-1",
				verifiedAt: "2026-08-30T02:00:00.000Z",
				updatedAt: "2026-08-30T02:00:00.000Z",
				routeSubjects: [
					{
						routeTargetId: "route-1",
						expectedSubjectFingerprint: "a".repeat(64),
						subjectFingerprint: "b".repeat(64),
					},
				],
			}),
			true
		);
		assert.equal((await repository.getById("endpoint-1"))?.status, "verified");
		assert.equal(
			await repository.publishVerified({
				endpointId: "endpoint-1",
				expectedStatus: "verified",
				expectedUpdatedAt: "2026-08-30T02:00:00.000Z",
				endpointPatch: {},
				verifiedBy: "admin-1",
				verifiedAt: "2026-08-30T03:00:00.000Z",
				updatedAt: "2026-08-30T03:00:00.000Z",
				routeSubjects: [
					{
						routeTargetId: "route-1",
						expectedSubjectFingerprint: "a".repeat(64),
						subjectFingerprint: "c".repeat(64),
					},
				],
			}),
			false
		);
		const failedPublication = await repository.getById("endpoint-1");
		assert.equal(failedPublication?.status, "draft");
		assert.equal(failedPublication?.verified_by, null);
		assert.equal(
			(await repository.listRouteLinks(["endpoint-1"]))[0]?.subject_fingerprint,
			"b".repeat(64)
		);
		await assert.rejects(
			repository.linkRoute({
				endpointId: "endpoint-2",
				routeTargetId: "route-1",
				subjectFingerprint: null,
				createdAt: "2026-08-30T01:00:00.000Z",
				expectedEndpointStatus: "draft",
				expectedEndpointUpdatedAt: "2026-08-30T00:00:00.000Z",
				updatedAt: "2026-08-30T01:00:00.000Z",
			})
		);
		await assert.rejects(repository.insert(endpoint("endpoint-3", "primary")));
		await assert.rejects(
			repository.listRouteLinks(
				Array.from({ length: 101 }, (_, index) => `endpoint-${index}`)
			),
			RangeError
		);
		await assert.rejects(
			repository.listDiscoveryRouteBindings(
				Array.from({ length: 101 }, (_, index) => `endpoint-${index}`)
			),
			RangeError
		);
		await assert.rejects(
			repository.listRuntimeBindingsByRouteTargetIds(
				Array.from({ length: 101 }, (_, index) => `route-${index}`)
			),
			RangeError
		);

		const providers = createD1ProvidersRepository(createClient(database));
		assert.deepEqual(
			(
				await providers.getProvidersByIds([
					"provider-2",
					"provider-1",
					"provider-2",
				])
			).map((row) => row.id),
			["provider-1", "provider-2"]
		);
		assert.deepEqual(await providers.getProvidersByIds([]), []);
		await assert.rejects(
			providers.getProvidersByIds(
				Array.from({ length: 101 }, (_, index) => `provider-${index}`)
			),
			RangeError
		);

		assert.equal(
			await repository.unlinkRoute({
				endpointId: "endpoint-1",
				routeTargetId: "route-1",
			}),
			1
		);
		assert.equal(
			await repository.linkRoute({
				endpointId: "endpoint-1",
				routeTargetId: "route-2",
				subjectFingerprint: null,
				createdAt: "2026-08-30T02:00:00.000Z",
				expectedEndpointStatus: "verified",
				expectedEndpointUpdatedAt: "2026-08-30T02:00:00.000Z",
				updatedAt: "2026-08-30T04:00:00.000Z",
			}),
			false
		);
		assert.deepEqual(await repository.listRouteLinks(["endpoint-1"]), []);
		assert.equal(
			await repository.linkRoute({
				endpointId: "endpoint-1",
				routeTargetId: "route-2",
				subjectFingerprint: null,
				createdAt: "2026-08-30T02:00:00.000Z",
				expectedEndpointStatus: "draft",
				expectedEndpointUpdatedAt: "2026-08-30T03:00:00.000Z",
				updatedAt: "2026-08-30T04:00:00.000Z",
			}),
			true
		);
		assert.equal(await repository.delete("endpoint-1"), 1);
		assert.deepEqual(await repository.listRouteLinks(["endpoint-1"]), []);
	} finally {
		database.close();
	}
});
