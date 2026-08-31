import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEndpointRow } from "../../../packages/core/src/db/model-endpoints-types";
import {
	EndpointBackfillApplyError,
	type EndpointBackfillApplyRun,
	type EndpointBackfillEvidenceAttestationWrite,
} from "../../../packages/core/src/model-endpoint-backfill-apply";
import type { EndpointBackfillManifest } from "../../../packages/core/src/model-endpoint-backfill";
import type { StorageContext } from "../../../packages/core/src/storage/context";
import {
	createEndpointBackfillApplyStore,
	finalizeEndpointBackfillApplyInventory,
	toMySqlUtcDateTime6,
	type EndpointBackfillApplyStoreDependencies,
} from "./apply-store";
import {
	EndpointBackfillDatabaseError,
	EndpointBackfillRevisionError,
	EndpointBackfillSchemaError,
} from "./contract";

const NOW = "2026-08-31T10:11:12.000Z";
const EXPECTED_REVISION = "2026-08-30T01:02:03.123456Z";
const TRUSTED_SIGNERS_SHA256 = "9".repeat(64);

const MANIFEST = {
	target: { database_fingerprint: `sha256:${"f".repeat(64)}` },
	endpoints: [{ id: "endpoint-1" }],
} as EndpointBackfillManifest;

const DESIRED: ModelEndpointRow = {
	id: "endpoint-1",
	model_id: "model-1",
	provider_id: "provider-1",
	provider_slug: "provider-one",
	tag: "provider-one",
	endpoint_class: null,
	region: null,
	context_length: 128_000,
	max_prompt_tokens: 120_000,
	max_completion_tokens: 8_000,
	quantization: null,
	supported_parameters: '["temperature"]',
	pricing: '{"completion":"0.000002","currency":"USD","prompt":"0.000001"}',
	supports_implicit_caching: false,
	supports_voice_cloning: false,
	supports_tool_choice:
		'{"auto":true,"function":true,"none":true,"required":false}',
	image_capabilities: "{}",
	audio_capabilities: "{}",
	evidence_url: "https://evidence.example/endpoint-1",
	verified_by: "cinaauth:admin-1",
	verified_at: NOW,
	expires_at: "2026-09-30T10:11:12.000Z",
	status: "verified",
	created_at: NOW,
	updated_at: NOW,
};

const RUN: EndpointBackfillApplyRun = {
	idempotency_key: "a".repeat(64),
	manifest_id: "manifest-1",
	manifest_sha256: "b".repeat(64),
	selected_manifest_sha256: "c".repeat(64),
	selection_sha256: "d".repeat(64),
	database_fingerprint: MANIFEST.target.database_fingerprint,
	request_sha256: "e".repeat(64),
	execution_sha256: "f".repeat(64),
	trusted_signers_sha256: TRUSTED_SIGNERS_SHA256,
	authorization_sha256: "0".repeat(64),
	manifest_actor_id: "cinaauth:admin-1",
	manifest_actor_key_id: `sha256:${"1".repeat(64)}`,
	evidence_reviewers_json: `[{"endpoint_ids":["endpoint-1"],"key_id":"sha256:${"2".repeat(
		64
	)}","principal":"cinaauth:reviewer-1"}]`,
	approved_by: "cinaauth:approver-1",
	approval_key_id: `sha256:${"3".repeat(64)}`,
	approval_approved_at: "2026-08-31T09:00:00.123Z",
	approval_expires_at: "2026-08-31T11:00:00.234Z",
	applied_at: "2026-08-31T10:11:12.345678Z",
	actions_count: 4,
	endpoints_count: 1,
};

const ATTESTATION: EndpointBackfillEvidenceAttestationWrite = {
	idempotency_key: RUN.idempotency_key,
	endpoint_id: DESIRED.id,
	desired_sha256: "4".repeat(64),
	before_sha256: "5".repeat(64),
	verification_state_sha256: "6".repeat(64),
	evidence_sha256: "7".repeat(64),
	evidence_url: DESIRED.evidence_url!,
	evidence_observed_at: "2026-08-30T08:00:00.456789Z",
	evidence_expires_at: "2026-09-30T08:00:00.567890Z",
	evidence_reviewed_by: "cinaauth:reviewer-1",
	evidence_reviewer_key_id: `sha256:${"2".repeat(64)}`,
	manifest_actor_id: RUN.manifest_actor_id,
	approved_by: RUN.approved_by,
	applied_at: RUN.applied_at,
};

type SqlCall = {
	kind: "query" | "execute" | "unsafe";
	sql: string;
	params: unknown[];
};

function storeInput(driver: "postgres" | "mysql") {
	return {
		driver,
		manifest: MANIFEST,
		databaseFingerprint: MANIFEST.target.database_fingerprint,
		env: { DATABASE_URL: `${driver}://unit.test/cinatoken` },
	} as const;
}

type MySqlHarnessOptions = {
	identityFingerprint?: string;
	identityErrorCode?: string;
	identityApplyUser?: string;
	currentApplyUser?: string;
	trustedSignersSha256?: string;
	revisionFound?: boolean;
};

function createMySqlHarness(options: MySqlHarnessOptions = {}) {
	const identityFingerprint =
		options.identityFingerprint ?? MANIFEST.target.database_fingerprint;
	const identityApplyUser = options.identityApplyUser ?? "endpoint_apply@%";
	const currentApplyUser = options.currentApplyUser ?? identityApplyUser;
	const trustedSignersSha256 =
		options.trustedSignersSha256 ?? TRUSTED_SIGNERS_SHA256;
	const events: string[] = [];
	const calls: SqlCall[] = [];
	let poolOptions: unknown;
	const connection = {
		async query(sql: string, params: unknown[] = []) {
			events.push(`query:${sql}`);
			calls.push({ kind: "query" as const, sql, params });
			if (sql === "SELECT @@SESSION.time_zone AS time_zone") {
				return [[{ time_zone: "+00:00" }], []];
			}
			if (sql.includes("GET_LOCK")) return [[{ locked: 1 }], []];
			if (sql.includes("schema_migrations")) return [[{ present: 1 }], []];
			if (sql.includes("FROM model_endpoint_backfill_database_identity")) {
				if (options.identityErrorCode) {
					throw Object.assign(new Error("missing identity table"), {
						code: options.identityErrorCode,
					});
				}
				return [
					[
						{
							database_fingerprint: identityFingerprint,
							database_name: "cinatoken",
							server_uuid: "11111111-1111-1111-1111-111111111111",
							current_database_name: "cinatoken",
							current_server_uuid: "11111111-1111-1111-1111-111111111111",
							apply_user: identityApplyUser,
							current_apply_user: currentApplyUser,
							trusted_signers_sha256: trustedSignersSha256,
						},
					],
					[],
				];
			}
			if (sql.includes("UTC_TIMESTAMP(6)")) {
				return [[{ database_now: NOW }], []];
			}
			if (sql.includes("SELECT id FROM model_endpoints")) {
				return [
					options.revisionFound === false ? [] : [{ id: "endpoint-1" }],
					[],
				];
			}
			if (sql.includes("SELECT endpoint_id FROM model_endpoint_routes")) {
				return [[], []];
			}
			return [[], []];
		},
		async execute(sql: string, params: unknown[] = []) {
			events.push(`execute:${sql}`);
			calls.push({ kind: "execute" as const, sql, params });
			return [{ affectedRows: 1 }, []];
		},
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
			events.push("connection.release");
		},
	};
	const pool = {
		async getConnection() {
			events.push("pool.getConnection");
			return connection;
		},
		async end() {
			events.push("pool.end");
		},
	};
	const context = {
		client: { driver: "mysql", raw: pool, drizzle: {} },
		repositories: {},
	} as unknown as StorageContext;
	const dependencies = {
		createPostgresStorageContext: async () => {
			throw new Error("unexpected PostgreSQL context");
		},
		createMySqlStorageContext: async (
			_connectionString: string,
			options: unknown
		) => {
			poolOptions = options;
			return context;
		},
	} as unknown as EndpointBackfillApplyStoreDependencies;
	return { events, calls, dependencies, getPoolOptions: () => poolOptions };
}

type PostgresHarnessOptions = {
	identityErrorCode?: string;
	identityApplyRole?: string;
	currentApplyRole?: string;
	trustedSignersSha256?: string;
	revisionFound?: boolean;
};

function createPostgresHarness(options: PostgresHarnessOptions = {}) {
	const identityApplyRole = options.identityApplyRole ?? "endpoint_apply";
	const currentApplyRole = options.currentApplyRole ?? identityApplyRole;
	const trustedSignersSha256 =
		options.trustedSignersSha256 ?? TRUSTED_SIGNERS_SHA256;
	const events: string[] = [];
	const calls: SqlCall[] = [];
	const transaction = {
		async unsafe(sql: string, params: unknown[] = []) {
			events.push(`unsafe:${sql}`);
			calls.push({ kind: "unsafe" as const, sql, params });
			if (sql.includes("pg_try_advisory_xact_lock")) {
				return [{ locked: true }];
			}
			if (sql.includes("schema_migrations")) return [{ present: true }];
			if (sql.includes("FROM model_endpoint_backfill_database_identity")) {
				if (options.identityErrorCode) {
					throw Object.assign(new Error("missing identity table"), {
						code: options.identityErrorCode,
					});
				}
				return [
					{
						database_fingerprint: MANIFEST.target.database_fingerprint,
						database_name: "cinatoken",
						database_oid: "16384",
						gateway_schema: "cinatoken_gateway",
						current_database_name: "cinatoken",
						current_database_oid: "16384",
						current_gateway_schema: "cinatoken_gateway",
						apply_role: identityApplyRole,
						current_apply_role: currentApplyRole,
						trusted_signers_sha256: trustedSignersSha256,
					},
				];
			}
			if (sql.includes("clock_timestamp()")) {
				return [{ database_now: NOW }];
			}
			if (sql.includes("SELECT id FROM model_endpoints")) {
				return options.revisionFound === false ? [] : [{ id: "endpoint-1" }];
			}
			if (
				sql.includes("UPDATE model_endpoints") &&
				sql.includes("RETURNING id")
			) {
				return [{ id: "endpoint-1" }];
			}
			return [];
		},
	};
	const raw = {
		async begin<T>(work: (tx: typeof transaction) => Promise<T>) {
			events.push("begin");
			try {
				const result = await work(transaction);
				events.push("commit");
				return result;
			} catch (error) {
				events.push("rollback");
				throw error;
			}
		},
		async end() {
			events.push("client.end");
		},
	};
	const context = {
		client: { driver: "postgres", raw, drizzle: {} },
		repositories: {},
	} as unknown as StorageContext;
	const dependencies = {
		createPostgresStorageContext: async () => context,
		createMySqlStorageContext: async () => {
			throw new Error("unexpected MySQL context");
		},
	} as unknown as EndpointBackfillApplyStoreDependencies;
	return { events, calls, dependencies };
}

test("MySQL TIMESTAMP(6) serialization preserves microseconds and normalizes offsets to UTC", () => {
	assert.equal(
		toMySqlUtcDateTime6("2026-08-31T10:11:12.123456Z"),
		"2026-08-31 10:11:12.123456"
	);
	assert.equal(
		toMySqlUtcDateTime6("2026-08-31T18:11:12.654321+08:00"),
		"2026-08-31 10:11:12.654321"
	);
	assert.equal(
		toMySqlUtcDateTime6("2026-08-31 10:11:12.9"),
		"2026-08-31 10:11:12.900000"
	);
	assert.throws(
		() => toMySqlUtcDateTime6("not-a-timestamp"),
		/Invalid MySQL datetime/u
	);
});

test("apply inventory is proven by the enclosing serializable transaction", async () => {
	const inventory = await finalizeEndpointBackfillApplyInventory(
		{
			source: {
				driver: "postgres",
				database_fingerprint: MANIFEST.target.database_fingerprint,
				required_migration: "0048_model_endpoint_audio_capabilities.sql",
				migration_head: "0049_model_endpoint_evidence_ledger.sql",
				migration_present: true,
			},
			models: [],
			providers: [],
			routes: [],
			endpoints: [],
			links: [],
		},
		[],
		undefined
	);
	assert.equal(inventory.consistency?.semantics, "serializable-transaction");
	assert.equal(inventory.consistency?.snapshot_consistent, true);
	assert.equal(inventory.consistency?.drifted, false);
	assert.deepEqual(inventory.consistency?.before, inventory.consistency?.after);
});

test("MySQL apply pins UTC before SERIALIZABLE, preserves CAS micros, and releases its lock after commit", async () => {
	const harness = createMySqlHarness();
	const store = createEndpointBackfillApplyStore(
		storeInput("mysql"),
		harness.dependencies
	);
	const result = await store.serializableTransaction(async (transaction) => {
		await transaction.acquireLock();
		await transaction.verifyDatabaseIdentity(
			MANIFEST.target.database_fingerprint,
			TRUSTED_SIGNERS_SHA256
		);
		assert.equal((await transaction.databaseNow()).toISOString(), NOW);
		assert.equal(await transaction.findCompletedRun(RUN.idempotency_key), null);
		await transaction.assertEndpointRevision(DESIRED.id, EXPECTED_REVISION);
		await transaction.writeDraft(DESIRED, "update", EXPECTED_REVISION);
		await transaction.syncRouteBindings(DESIRED.id, [], NOW);
		await transaction.publish(DESIRED);
		await transaction.insertRun(RUN);
		await transaction.insertAttestation(ATTESTATION);
		return "committed";
	});

	assert.equal(result, "committed");
	assert.equal(
		(harness.getPoolOptions() as { timezone?: string }).timezone,
		"Z",
		"mysql2 must not reinterpret database timestamps in the host timezone"
	);
	assert.deepEqual(harness.events.slice(0, 6), [
		"pool.getConnection",
		"query:SET SESSION time_zone = '+00:00'",
		"query:SELECT @@SESSION.time_zone AS time_zone",
		"query:SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
		"begin",
		"query:SELECT GET_LOCK(?, 0) AS locked",
	]);
	assert.match(harness.events[6] ?? "", /schema_migrations/u);
	assert.match(
		harness.events[7] ?? "",
		/model_endpoint_backfill_database_identity/u
	);
	assert.match(harness.events[8] ?? "", /UTC_TIMESTAMP\(6\)/u);
	assert.ok(
		harness.events.indexOf("commit") <
			harness.events.findIndex((event) => event.includes("RELEASE_LOCK"))
	);
	assert.deepEqual(harness.events.slice(-3), [
		"query:SELECT RELEASE_LOCK(?)",
		"connection.release",
		"pool.end",
	]);

	const revision = harness.calls.find((call) =>
		call.sql.includes("AND updated_at = ? FOR UPDATE")
	);
	assert.deepEqual(revision?.params, [
		DESIRED.id,
		"2026-08-30 01:02:03.123456",
	]);
	const draft = harness.calls.find(
		(call) => call.kind === "execute" && call.sql.includes("status='draft'")
	);
	assert.equal(draft?.params.length, 22);
	assert.deepEqual(draft?.params.slice(-4), [
		"2026-09-30 10:11:12.000000",
		"2026-08-31 10:11:12.000000",
		DESIRED.id,
		"2026-08-30 01:02:03.123456",
	]);
	const emptyBindingDelete = harness.calls.find(
		(call) =>
			call.kind === "execute" &&
			call.sql.startsWith("DELETE FROM model_endpoint_routes")
	);
	assert.ok(emptyBindingDelete);
	assert.doesNotMatch(emptyBindingDelete.sql, /NOT IN/u);
	const completedRunRead = harness.calls.find(
		(call) =>
			call.kind === "query" &&
			call.sql.includes("FROM model_endpoint_backfill_runs")
	);
	for (const field of [
		"execution_sha256",
		"trusted_signers_sha256",
		"authorization_sha256",
		"manifest_actor_key_id",
		"evidence_reviewers_json",
		"approval_approved_at",
		"approval_expires_at",
	])
		assert.match(
			completedRunRead?.sql ?? "",
			new RegExp(`\\b${field}\\b`, "u")
		);
	const runInsert = harness.calls.find(
		(call) =>
			call.kind === "execute" &&
			call.sql.includes("INSERT INTO model_endpoint_backfill_runs")
	);
	assert.deepEqual(runInsert?.params, [
		RUN.idempotency_key,
		RUN.manifest_id,
		RUN.manifest_sha256,
		RUN.selected_manifest_sha256,
		RUN.selection_sha256,
		RUN.database_fingerprint,
		RUN.request_sha256,
		RUN.execution_sha256,
		RUN.trusted_signers_sha256,
		RUN.authorization_sha256,
		RUN.manifest_actor_id,
		RUN.manifest_actor_key_id,
		RUN.evidence_reviewers_json,
		RUN.approved_by,
		RUN.approval_key_id,
		RUN.approval_approved_at,
		RUN.approval_expires_at,
		"2026-08-31 10:11:12.345678",
		RUN.actions_count,
		RUN.endpoints_count,
	]);
	const attestationInsert = harness.calls.find(
		(call) =>
			call.kind === "execute" &&
			call.sql.includes("INSERT INTO model_endpoint_evidence_attestations")
	);
	assert.deepEqual(attestationInsert?.params, [
		ATTESTATION.idempotency_key,
		ATTESTATION.endpoint_id,
		ATTESTATION.desired_sha256,
		ATTESTATION.before_sha256,
		ATTESTATION.verification_state_sha256,
		ATTESTATION.evidence_sha256,
		ATTESTATION.evidence_url,
		"2026-08-30 08:00:00.456789",
		"2026-09-30 08:00:00.567890",
		ATTESTATION.evidence_reviewed_by,
		ATTESTATION.evidence_reviewer_key_id,
		ATTESTATION.manifest_actor_id,
		ATTESTATION.approved_by,
		"2026-08-31 10:11:12.345678",
	]);
});

test("MySQL apply rolls back mutations and releases a held named lock on failure", async () => {
	const harness = createMySqlHarness();
	const store = createEndpointBackfillApplyStore(
		storeInput("mysql"),
		harness.dependencies
	);
	await assert.rejects(
		store.serializableTransaction(async (transaction) => {
			await transaction.acquireLock();
			throw new Error("untrusted driver detail");
		}),
		(error: unknown) =>
			error instanceof EndpointBackfillDatabaseError &&
			error.message ===
				"MySQL endpoint backfill transaction did not complete cleanly"
	);
	assert.ok(
		harness.events.indexOf("rollback") <
			harness.events.findIndex((event) => event.includes("RELEASE_LOCK"))
	);
	assert.ok(!harness.events.includes("commit"));
	assert.deepEqual(harness.events.slice(-3), [
		"query:SELECT RELEASE_LOCK(?)",
		"connection.release",
		"pool.end",
	]);
});

test("MySQL apply rejects a persisted database identity mismatch before ledger access", async () => {
	const harness = createMySqlHarness({
		identityFingerprint: `sha256:${"0".repeat(64)}`,
	});
	const store = createEndpointBackfillApplyStore(
		storeInput("mysql"),
		harness.dependencies
	);
	await assert.rejects(
		store.serializableTransaction(async (transaction) => {
			await transaction.acquireLock();
			await transaction.verifyDatabaseIdentity(
				MANIFEST.target.database_fingerprint,
				TRUSTED_SIGNERS_SHA256
			);
		}),
		(error: unknown) =>
			error instanceof EndpointBackfillDatabaseError &&
			error.message ===
				"Endpoint backfill database identity or signer trust root mismatch"
	);
	assert.ok(harness.events.includes("rollback"));
	assert.ok(
		!harness.events.some((event) =>
			event.includes("model_endpoint_backfill_runs")
		)
	);
});

test("missing MySQL identity table is classified as an apply schema failure", async () => {
	const harness = createMySqlHarness({ identityErrorCode: "ER_NO_SUCH_TABLE" });
	const store = createEndpointBackfillApplyStore(
		storeInput("mysql"),
		harness.dependencies
	);
	await assert.rejects(
		store.serializableTransaction(async (transaction) => {
			await transaction.acquireLock();
			await transaction.verifyDatabaseIdentity(
				MANIFEST.target.database_fingerprint,
				TRUSTED_SIGNERS_SHA256
			);
		}),
		(error: unknown) => error instanceof EndpointBackfillSchemaError
	);
});

test("PostgreSQL apply sets SERIALIZABLE before its transaction-scoped advisory lock and keeps SQL parameter order", async () => {
	const harness = createPostgresHarness();
	const store = createEndpointBackfillApplyStore(
		storeInput("postgres"),
		harness.dependencies
	);
	const result = await store.serializableTransaction(async (transaction) => {
		await transaction.acquireLock();
		await transaction.verifyDatabaseIdentity(
			MANIFEST.target.database_fingerprint,
			TRUSTED_SIGNERS_SHA256
		);
		assert.equal((await transaction.databaseNow()).toISOString(), NOW);
		assert.equal(await transaction.findCompletedRun(RUN.idempotency_key), null);
		await transaction.assertEndpointRevision(DESIRED.id, EXPECTED_REVISION);
		await transaction.writeDraft(DESIRED, "update", EXPECTED_REVISION);
		await transaction.syncRouteBindings(DESIRED.id, [], NOW);
		await transaction.publish(DESIRED);
		await transaction.insertRun(RUN);
		await transaction.insertAttestation(ATTESTATION);
		return "committed";
	});

	assert.equal(result, "committed");
	assert.deepEqual(harness.events.slice(0, 3), [
		"begin",
		"unsafe:SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
		"unsafe:SELECT pg_try_advisory_xact_lock($1) AS locked",
	]);
	assert.match(harness.events[3] ?? "", /schema_migrations/u);
	assert.match(
		harness.events[4] ?? "",
		/model_endpoint_backfill_database_identity/u
	);
	assert.match(harness.events[5] ?? "", /clock_timestamp\(\)/u);
	assert.deepEqual(harness.events.slice(-2), ["commit", "client.end"]);
	const revision = harness.calls.find((call) =>
		call.sql.includes("$2::timestamptz FOR UPDATE")
	);
	assert.deepEqual(revision?.params, [DESIRED.id, EXPECTED_REVISION]);
	const draft = harness.calls.find(
		(call) =>
			call.sql.includes("status='draft'") && call.sql.includes("RETURNING id")
	);
	assert.equal(draft?.params.length, 26);
	assert.equal(draft?.params[0], DESIRED.id);
	assert.equal(draft?.params[25], EXPECTED_REVISION);
	const emptyBindingDelete = harness.calls.find((call) =>
		call.sql.startsWith("DELETE FROM model_endpoint_routes")
	);
	assert.deepEqual(emptyBindingDelete?.params, [DESIRED.id, []]);
	const completedRunRead = harness.calls.find((call) =>
		call.sql.includes("FROM model_endpoint_backfill_runs")
	);
	for (const field of [
		"execution_sha256",
		"trusted_signers_sha256",
		"authorization_sha256",
		"manifest_actor_key_id",
		"evidence_reviewers_json",
		"approval_approved_at",
		"approval_expires_at",
	])
		assert.match(
			completedRunRead?.sql ?? "",
			new RegExp(`\\b${field}\\b`, "u")
		);
	const runInsert = harness.calls.find((call) =>
		call.sql.includes("INSERT INTO model_endpoint_backfill_runs")
	);
	assert.deepEqual(runInsert?.params, [
		RUN.idempotency_key,
		RUN.manifest_id,
		RUN.manifest_sha256,
		RUN.selected_manifest_sha256,
		RUN.selection_sha256,
		RUN.database_fingerprint,
		RUN.request_sha256,
		RUN.execution_sha256,
		RUN.trusted_signers_sha256,
		RUN.authorization_sha256,
		RUN.manifest_actor_id,
		RUN.manifest_actor_key_id,
		RUN.evidence_reviewers_json,
		RUN.approved_by,
		RUN.approval_key_id,
		RUN.approval_approved_at,
		RUN.approval_expires_at,
		RUN.applied_at,
		RUN.actions_count,
		RUN.endpoints_count,
	]);
	const attestationInsert = harness.calls.find((call) =>
		call.sql.includes("INSERT INTO model_endpoint_evidence_attestations")
	);
	assert.deepEqual(attestationInsert?.params, [
		ATTESTATION.idempotency_key,
		ATTESTATION.endpoint_id,
		ATTESTATION.desired_sha256,
		ATTESTATION.before_sha256,
		ATTESTATION.verification_state_sha256,
		ATTESTATION.evidence_sha256,
		ATTESTATION.evidence_url,
		ATTESTATION.evidence_observed_at,
		ATTESTATION.evidence_expires_at,
		ATTESTATION.evidence_reviewed_by,
		ATTESTATION.evidence_reviewer_key_id,
		ATTESTATION.manifest_actor_id,
		ATTESTATION.approved_by,
		ATTESTATION.applied_at,
	]);
});

test("PostgreSQL apply delegates rollback to begin and always closes the client", async () => {
	const harness = createPostgresHarness();
	const store = createEndpointBackfillApplyStore(
		storeInput("postgres"),
		harness.dependencies
	);
	await assert.rejects(
		store.serializableTransaction(async (transaction) => {
			await transaction.acquireLock();
			throw new Error("untrusted driver detail");
		}),
		(error: unknown) =>
			error instanceof EndpointBackfillDatabaseError &&
			error.message ===
				"PostgreSQL endpoint backfill transaction did not complete cleanly"
	);
	assert.deepEqual(harness.events.slice(-2), ["rollback", "client.end"]);
	assert.ok(!harness.events.includes("commit"));
});

test("missing PostgreSQL identity table is classified as an apply schema failure", async () => {
	const harness = createPostgresHarness({ identityErrorCode: "42P01" });
	const store = createEndpointBackfillApplyStore(
		storeInput("postgres"),
		harness.dependencies
	);
	await assert.rejects(
		store.serializableTransaction(async (transaction) => {
			await transaction.acquireLock();
			await transaction.verifyDatabaseIdentity(
				MANIFEST.target.database_fingerprint,
				TRUSTED_SIGNERS_SHA256
			);
		}),
		(error: unknown) => error instanceof EndpointBackfillSchemaError
	);
});

test("database identity is bound to the PostgreSQL role and MySQL account", async () => {
	for (const [driver, harness] of [
		[
			"postgres",
			createPostgresHarness({ currentApplyRole: "unexpected_role" }),
		],
		["mysql", createMySqlHarness({ currentApplyUser: "unexpected@%" })],
	] as const) {
		const store = createEndpointBackfillApplyStore(
			storeInput(driver),
			harness.dependencies
		);
		await assert.rejects(
			store.serializableTransaction(async (transaction) => {
				await transaction.acquireLock();
				await transaction.verifyDatabaseIdentity(
					MANIFEST.target.database_fingerprint,
					TRUSTED_SIGNERS_SHA256
				);
			}),
			(error: unknown) =>
				error instanceof EndpointBackfillDatabaseError &&
				error.message ===
					"Endpoint backfill database identity or signer trust root mismatch"
		);
		assert.ok(harness.events.includes("rollback"));
	}
});

test("endpoint revision conflicts remain drift exit 5 through transaction rollback", async () => {
	for (const [driver, harness] of [
		["postgres", createPostgresHarness({ revisionFound: false })],
		["mysql", createMySqlHarness({ revisionFound: false })],
	] as const) {
		const store = createEndpointBackfillApplyStore(
			storeInput(driver),
			harness.dependencies
		);
		await assert.rejects(
			store.serializableTransaction(async (transaction) => {
				await transaction.assertEndpointRevision(DESIRED.id, EXPECTED_REVISION);
			}),
			(error: unknown) =>
				error instanceof EndpointBackfillRevisionError && error.exitCode === 5
		);
		assert.ok(harness.events.includes("rollback"));
	}
});

test("core authorization and execution failures survive driver rollback classification", async () => {
	for (const [driver, harness] of [
		["postgres", createPostgresHarness()],
		["mysql", createMySqlHarness()],
	] as const) {
		const store = createEndpointBackfillApplyStore(
			storeInput(driver),
			harness.dependencies
		);
		await assert.rejects(
			store.serializableTransaction(async () => {
				throw new EndpointBackfillApplyError(
					"execution_mismatch",
					"approved execution changed"
				);
			}),
			(error: unknown) =>
				error instanceof EndpointBackfillApplyError &&
				error.code === "execution_mismatch"
		);
		assert.ok(harness.events.includes("rollback"));
	}
});
