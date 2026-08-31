import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	ENDPOINT_BACKFILL_MANIFEST_VERSION,
	parseEndpointBackfillManifest,
	sha256EndpointBackfillValue,
	stableEndpointBackfillJson,
	type EndpointBackfillInventory,
	type EndpointBackfillManifest,
} from "../../../packages/core/src/model-endpoint-backfill";
import type { ModelRouteRow, ProviderRow } from "../../../packages/core/src/types";
import type { StorageContext } from "../../../packages/core/src/storage/context";
import {
	ENDPOINT_BACKFILL_EXIT,
	EndpointBackfillCliError,
	EndpointBackfillDatabaseError,
	EndpointBackfillSchemaError,
	parseEndpointBackfillPlanArgs,
	resolveEndpointBackfillDatabaseFingerprint,
	selectEndpointBackfillManifest,
} from "./contract";
import {
	executeEndpointBackfillPlan,
	readEndpointBackfillManifestFile,
	type EndpointBackfillCliDependencies,
	writeEndpointBackfillReportFile,
} from "./cli";
import {
	loadEndpointBackfillInventory,
	type D1ReadExecutor,
	type EndpointBackfillInventoryDependencies,
	type LoadedEndpointBackfillInventory,
} from "./inventory";

const NOW = new Date("2026-08-30T10:00:00.000Z");
const FINGERPRINT = `sha256:${"f".repeat(64)}`;
const PROVIDER_SECRET = "sk-production-secret-must-never-leak";

function rawManifest(
	driver: "d1" | "postgres" | "mysql" = "postgres",
	overrides: Record<string, unknown> = {}
): unknown {
	const requiredMigration = {
		d1: "0049_model_endpoint_audio_capabilities.sql",
		postgres: "0048_model_endpoint_audio_capabilities.sql",
		mysql: "0045_model_endpoint_audio_capabilities.sql",
	}[driver];
	return {
		version: ENDPOINT_BACKFILL_MANIFEST_VERSION,
		manifest_id: "CHANGE-2026-0001",
		created_at: "2026-08-30T09:00:00.000Z",
		actor_id: "cinaauth:admin-1",
		target: {
			driver,
			database_fingerprint: FINGERPRINT,
			required_migration: requiredMigration,
		},
		policy: {
			allow_create: true,
			allow_material_update: false,
			allow_draft_promotion: false,
			allow_route_link_changes: false,
		},
		endpoints: [
			{
				id: "endpoint-1",
				expected_updated_at: null,
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
				supported_parameters: ["temperature", "tool_choice"],
				pricing: {
					currency: "USD",
					prompt: "0.000001",
					completion: "0.000002",
				},
				supports_implicit_caching: false,
				supports_voice_cloning: false,
				supports_tool_choice: {
					auto: true,
					function: true,
					none: true,
					required: true,
				},
				image_capabilities: null,
				audio_capabilities: null,
				evidence: {
					url: "https://provider.example/pricing",
					observed_at: "2026-08-29T00:00:00.000Z",
					expires_at: "2027-08-30T00:00:00.000Z",
					sha256: "a".repeat(64),
					reviewed_by: "cinaauth:reviewer-1",
				},
				route_target_ids: ["route-1"],
			},
		],
		...overrides,
	};
}

const PROVIDER: ProviderRow = {
	id: "provider-1",
	name: "Provider One",
	endpoints: JSON.stringify({
		openai: { base: "https://provider.example/v1" },
	}),
	api_key: PROVIDER_SECRET,
	status: "active",
	description: null,
	shared_channel_type: null,
	created_at: "2026-01-01T00:00:00.000Z",
};

const ROUTE: ModelRouteRow = {
	id: "route-1",
	model_id: "model-1",
	provider_id: "provider-1",
	provider_model_name: "upstream-model-1",
	priority: 10,
	status: "active",
	route_group: "default",
	weight: 1,
	price_override: null,
	custom_params: null,
	routing_metadata: null,
	upstream_protocol: "openai",
	route_pool_id: "pool-1",
	upstream_operation: "chat",
	adapter: "passthrough",
};

function inventory(
	driver: "d1" | "postgres" | "mysql" = "postgres",
	overrides: Partial<EndpointBackfillInventory> = {}
): EndpointBackfillInventory {
	const requiredMigration = {
		d1: "0049_model_endpoint_audio_capabilities.sql",
		postgres: "0048_model_endpoint_audio_capabilities.sql",
		mysql: "0045_model_endpoint_audio_capabilities.sql",
	}[driver];
	return {
		source: {
			driver,
			database_fingerprint: FINGERPRINT,
			required_migration: requiredMigration,
			migration_head: requiredMigration,
			migration_present: true,
		},
		models: [{ id: "model-1" }],
		providers: [PROVIDER],
		routes: [ROUTE],
		endpoints: [],
		links: [],
		...overrides,
	};
}

function loaded(
	driver: "d1" | "postgres" | "mysql" = "postgres",
	drifted = false,
	inventoryOverrides: Partial<EndpointBackfillInventory> = {}
): LoadedEndpointBackfillInventory {
	const loadedInventory = inventory(driver, inventoryOverrides);
	const vector = {
		migration_head: loadedInventory.source.migration_head,
		models: loadedInventory.models.length,
		providers: loadedInventory.providers.length,
		routes: loadedInventory.routes.length,
		endpoints: loadedInventory.endpoints.length,
		links: loadedInventory.links.length,
		endpoint_revisions_sha256: `sha256:${"1".repeat(64)}`,
		link_revisions_sha256: `sha256:${"2".repeat(64)}`,
	};
	const consistency: LoadedEndpointBackfillInventory["consistency"] = {
			semantics:
				driver === "d1"
					? "d1-non-snapshot-double-read"
					: "repository-double-read",
		snapshot_consistent: false,
		before: {
				rows_sha256: `sha256:${"3".repeat(64)}`,
				version_vector: vector,
			},
			after: {
				rows_sha256: `sha256:${(drifted ? "4" : "3").repeat(64)}`,
				version_vector: vector,
			},
		drifted,
	};
	loadedInventory.consistency = consistency;
	return {
		inventory: loadedInventory,
		consistency,
	};
}

function args(driver: "d1" | "postgres" | "mysql" = "postgres"): string[] {
	return [
		"plan",
		`--driver=${driver}`,
		`--manifest=${resolve("endpoint-backfill-manifest.json")}`,
		`--report=${resolve("endpoint-backfill-report.json")}`,
		"--all-manifest",
	];
}

function repositoryContext(
	driver: "postgres" | "mysql",
	raw: Record<string, unknown>,
	onBusinessRead: () => void = () => undefined
): StorageContext {
	return {
		client: {
			driver,
			raw,
			drizzle: {},
		},
		repositories: {
			models: {
				getModelDetailWithRouteCounts: async () => {
					onBusinessRead();
					return { id: "model-1" };
				},
			},
			providers: {
				getProvidersByIds: async () => {
					onBusinessRead();
					return [PROVIDER];
				},
			},
			routes: {
				getModelRouteRowById: async () => {
					onBusinessRead();
					return ROUTE;
				},
			},
			modelEndpoints: {
				getByIdentity: async () => {
					onBusinessRead();
					return null;
				},
				getById: async () => {
					onBusinessRead();
					return null;
				},
				list: async () => {
					throw new Error(
						"endpoint inventory must not fall back to pagination identity scans"
					);
				},
				listRouteLinks: async () => {
					onBusinessRead();
					return [];
				},
				listRuntimeBindingsByRouteTargetIds: async () => {
					onBusinessRead();
					return [];
				},
			},
		} as unknown as StorageContext["repositories"],
	} as unknown as StorageContext;
}

const unusedPostgresDependency: EndpointBackfillInventoryDependencies["createPostgres"] =
	async () => {
		throw new Error("unused");
	};

const unusedMySqlDependency: EndpointBackfillInventoryDependencies["createMySql"] =
	async () => {
		throw new Error("unused");
	};

async function createTestDirectory(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cinatoken-endpoint-backfill-"));
}

async function removeFlatTestDirectory(path: string): Promise<void> {
	for (const entry of await readdir(path)) {
		await unlink(join(path, entry));
	}
	await rmdir(path);
}

test("manifest reader uses a regular file and enforces the hard 10 MiB bound", async () => {
	const directory = await createTestDirectory();
	try {
		const manifestPath = join(directory, "manifest.json");
		await writeFile(manifestPath, JSON.stringify({ manifest_id: "fixture" }));
		assert.deepEqual(await readEndpointBackfillManifestFile(manifestPath), {
			manifest_id: "fixture",
		});

		await writeFile(manifestPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
		await assert.rejects(
			readEndpointBackfillManifestFile(manifestPath),
			(error: unknown) =>
				error instanceof EndpointBackfillCliError &&
				error.exitCode === ENDPOINT_BACKFILL_EXIT.input &&
				error.message ===
					"Could not read a valid JSON manifest from --manifest"
		);
		await assert.rejects(
			readEndpointBackfillManifestFile(directory),
			(error: unknown) =>
				error instanceof EndpointBackfillCliError &&
				error.exitCode === ENDPOINT_BACKFILL_EXIT.input
		);
	} finally {
		await removeFlatTestDirectory(directory);
	}
});

test("report writer publishes atomically, refuses overwrite, and cleans temporary files", async () => {
	const directory = await createTestDirectory();
	try {
		const reportPath = join(directory, "report.json");
		const original = '{"status":"original"}\n';
		await writeEndpointBackfillReportFile(reportPath, original);
		assert.equal(await readFile(reportPath, "utf8"), original);
		assert.deepEqual(await readdir(directory), ["report.json"]);

		await assert.rejects(
			writeEndpointBackfillReportFile(
				reportPath,
				'{"credential":"must-not-replace-or-leak"}\n'
			),
			(error: unknown) => {
				assert.ok(error instanceof EndpointBackfillCliError);
				assert.equal(error.exitCode, ENDPOINT_BACKFILL_EXIT.input);
				assert.equal(
					error.message,
					"Could not create --report; choose a new absolute path in an existing directory"
				);
				assert.equal(error.message.includes("credential"), false);
				return true;
			}
		);
		assert.equal(await readFile(reportPath, "utf8"), original);
		assert.deepEqual(await readdir(directory), ["report.json"]);
	} finally {
		await removeFlatTestDirectory(directory);
	}
});

test("CLI accepts only explicit read-only plan arguments", () => {
	const parsed = parseEndpointBackfillPlanArgs(args());
	assert.equal(parsed.command, "plan");
	assert.equal(parsed.driver, "postgres");
	assert.equal(parsed.allManifest, true);
	assert.throws(
		() => parseEndpointBackfillPlanArgs([...args(), "--apply"]),
		(error) =>
			error instanceof EndpointBackfillCliError &&
			error.exitCode === ENDPOINT_BACKFILL_EXIT.input &&
			/forbidden/u.test(error.message)
	);
	assert.throws(
		() => parseEndpointBackfillPlanArgs(["apply", ...args().slice(1)]),
		/The only supported command is plan/u
	);
	assert.throws(
		() => parseEndpointBackfillPlanArgs([...args(), "--database-url=secret"]),
		(error: unknown) => {
			assert.ok(error instanceof EndpointBackfillCliError);
			assert.match(error.message, /Unknown option/u);
			assert.equal(error.message.includes("secret"), false);
			return true;
		}
	);
});

test("selection can only shrink the manifest and enforces bounded work", () => {
	const manifest = parseEndpointBackfillManifest(rawManifest());
	assert.equal(
		selectEndpointBackfillManifest(manifest, {
			allManifest: false,
			endpointIds: ["endpoint-1"],
		}).endpoints.length,
		1
	);
	assert.throws(
		() =>
			selectEndpointBackfillManifest(manifest, {
				allManifest: false,
				endpointIds: ["not-in-manifest"],
			}),
		/absent from the manifest/u
	);
	const tooMany = {
		...manifest,
		endpoints: Array.from({ length: 101 }, (_, index) => ({
			...manifest.endpoints[0]!,
			id: `endpoint-${index}`,
		})),
	} as EndpointBackfillManifest;
	assert.throws(
		() =>
			selectEndpointBackfillManifest(tooMany, {
				allManifest: true,
				endpointIds: [],
			}),
		/between 1 and 100 endpoints/u
	);
	const tooManyRoutes = {
		...manifest,
		endpoints: [
			{
				...manifest.endpoints[0]!,
				route_target_ids: Array.from(
					{ length: 1_001 },
					(_, index) => `route-${index}`
				),
			},
		],
	} as EndpointBackfillManifest;
	assert.throws(
		() =>
			selectEndpointBackfillManifest(tooManyRoutes, {
				allManifest: true,
				endpointIds: [],
			}),
		/limit is 1000/u
	);
});

test("database fingerprint is environment-only and must match the manifest", () => {
	const manifest = parseEndpointBackfillManifest(rawManifest());
	assert.equal(
		resolveEndpointBackfillDatabaseFingerprint(
			{ ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT },
			manifest,
			"postgres"
		),
		FINGERPRINT
	);
	assert.throws(
		() =>
			resolveEndpointBackfillDatabaseFingerprint({}, manifest, "postgres"),
		/ENDPOINT_BACKFILL_DATABASE_FINGERPRINT/u
	);
	assert.throws(
		() =>
			resolveEndpointBackfillDatabaseFingerprint(
				{ ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: `sha256:${"0".repeat(64)}` },
				manifest,
				"postgres"
			),
		/does not match/u
	);
});

test("validated and blocker reports are canonical and never contain provider secrets", async () => {
	let written = "";
	const dependencies: EndpointBackfillCliDependencies = {
		readManifest: async () => rawManifest(),
		writeReport: async (_path, contents) => {
			written = contents;
		},
		loadInventory: async () => loaded(),
		plan: async (manifest, currentInventory, now, provenance) => {
			const { planEndpointBackfill } = await import(
				"../../../packages/core/src/model-endpoint-backfill"
			);
			return planEndpointBackfill(
				manifest,
				currentInventory,
				now,
				provenance
			);
		},
		now: () => NOW,
	};
	const validated = await executeEndpointBackfillPlan(
		args(),
		{ ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT },
		dependencies
	);
	assert.equal(validated.exitCode, ENDPOINT_BACKFILL_EXIT.ok);
	assert.equal(validated.reportWritten, true);
	assert.match(validated.message, /authorization is unverified/u);
	assert.doesNotMatch(written, new RegExp(PROVIDER_SECRET, "u"));
	const validatedReport = JSON.parse(written) as Record<string, unknown>;
	assert.equal(validatedReport.validation_passed, true);
	assert.equal(validatedReport.authorization_verified, false);
	assert.equal(validatedReport.ready_to_apply, false);
	assert.equal(validatedReport.database_identity_verified, false);
	assert.equal(
		(validatedReport.inventory_consistency as Record<string, unknown>)
			.snapshot_consistent,
		false
	);
	assert.equal(`${stableEndpointBackfillJson(JSON.parse(written))}\n`, written);

	written = "";
	dependencies.loadInventory = async () => loaded("postgres", false, { models: [] });
	const blocked = await executeEndpointBackfillPlan(
		args(),
		{ ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT },
		dependencies
	);
	assert.equal(blocked.exitCode, ENDPOINT_BACKFILL_EXIT.blocked);
	assert.doesNotMatch(written, new RegExp(PROVIDER_SECRET, "u"));
});

test("CLI binds the complete manifest before endpoint selection", async () => {
	const base = rawManifest() as Record<string, unknown>;
	const firstEndpoint = (base.endpoints as Array<Record<string, unknown>>)[0]!;
	const secondEndpoint = {
		...firstEndpoint,
		id: "endpoint-2",
		tag: "provider-one-alt",
		route_target_ids: ["route-2"],
	};
	let raw: unknown = { ...base, endpoints: [firstEndpoint, secondEndpoint] };
	let written = "";
	const dependencies: EndpointBackfillCliDependencies = {
		readManifest: async () => raw,
		writeReport: async (_path, contents) => {
			written = contents;
		},
		loadInventory: async () => loaded(),
		plan: async (manifest, currentInventory, now, provenance) => {
			const { planEndpointBackfill } = await import(
				"../../../packages/core/src/model-endpoint-backfill"
			);
			return planEndpointBackfill(
				manifest,
				currentInventory,
				now,
				provenance
			);
		},
		now: () => NOW,
	};
	const selectedArgs = [
		...args().filter((arg) => arg !== "--all-manifest"),
		"--endpoint-id=endpoint-1",
	];

	const first = await executeEndpointBackfillPlan(
		selectedArgs,
		{ ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT },
		dependencies
	);
	assert.equal(first.exitCode, ENDPOINT_BACKFILL_EXIT.ok);
	const firstReport = JSON.parse(written) as Record<string, string>;
	assert.notEqual(
		firstReport.manifest_sha256,
		firstReport.selected_manifest_sha256
	);

	raw = {
		...base,
		endpoints: [
			firstEndpoint,
			{ ...secondEndpoint, context_length: 256_000 },
		],
	};
	written = "";
	const second = await executeEndpointBackfillPlan(
		selectedArgs,
		{ ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT },
		dependencies
	);
	assert.equal(second.exitCode, ENDPOINT_BACKFILL_EXIT.ok);
	const secondReport = JSON.parse(written) as Record<string, string>;
	assert.notEqual(firstReport.manifest_sha256, secondReport.manifest_sha256);
	assert.equal(
		firstReport.selected_manifest_sha256,
		secondReport.selected_manifest_sha256
	);
	assert.equal(firstReport.selection_sha256, secondReport.selection_sha256);
});

test("drift exits 5 with only safe digests and never invokes the planner", async () => {
	let written = "";
	let planCalls = 0;
	const fullManifest = rawManifest() as Record<string, unknown>;
	const firstEndpoint = (
		fullManifest.endpoints as Array<Record<string, unknown>>
	)[0]!;
	const unselectedEndpoint = {
		...firstEndpoint,
		id: "endpoint-2",
		tag: "provider-one-alt",
		route_target_ids: ["route-2"],
	};
	fullManifest.endpoints = [firstEndpoint, unselectedEndpoint];
	const parsedFullManifest = parseEndpointBackfillManifest(fullManifest);
	const expectedFullManifestSha256 = await sha256EndpointBackfillValue(
		parsedFullManifest
	);
	const driftedInventory = loaded("postgres", true);
	(
		driftedInventory.inventory.source as EndpointBackfillInventory["source"] & {
			database_url: string;
		}
	).database_url = "postgres://report-secret@db.example/cinatoken";
	(
		driftedInventory.consistency as LoadedEndpointBackfillInventory["consistency"] & {
			credential: string;
		}
	).credential = "consistency-secret";
	(
		driftedInventory.consistency.before as LoadedEndpointBackfillInventory["consistency"]["before"] & {
			credential: string;
		}
	).credential = "before-secret";
	const selectedArgs = [
		...args().filter((arg) => arg !== "--all-manifest"),
		"--endpoint-id=endpoint-1",
	];
	const result = await executeEndpointBackfillPlan(
		selectedArgs,
		{ ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT },
		{
			readManifest: async () => fullManifest,
			writeReport: async (_path, contents) => {
				written = contents;
			},
			loadInventory: async () => driftedInventory,
			plan: async () => {
				planCalls += 1;
				throw new Error("must not run");
			},
			now: () => NOW,
		}
	);
	assert.equal(result.exitCode, ENDPOINT_BACKFILL_EXIT.drift);
	assert.equal(planCalls, 0);
	assert.match(written, /concurrent_inventory_drift/u);
	assert.doesNotMatch(written, new RegExp(PROVIDER_SECRET, "u"));
	assert.equal(written.includes("report-secret"), false);
	assert.equal(written.includes("consistency-secret"), false);
	assert.equal(written.includes("before-secret"), false);
	const report = JSON.parse(written) as Record<string, unknown>;
	assert.equal(report.manifest_sha256, expectedFullManifestSha256);
	assert.notEqual(report.manifest_sha256, report.selected_manifest_sha256);
	assert.equal(
		report.selection_sha256,
		await sha256EndpointBackfillValue(["endpoint-1"])
	);
	assert.equal(
		report.database_fingerprint_source,
		"operator_asserted_environment"
	);
	assert.equal(report.database_identity_verified, false);
	assert.equal("consistency" in report, false);
	assert.equal(
		(report.inventory_consistency as Record<string, unknown>).drifted,
		true
	);
	assert.equal(`${stableEndpointBackfillJson(report)}\n`, written);
});

test("schema and database failures retain the production exit-code contract", async () => {
	const baseDependencies: EndpointBackfillCliDependencies = {
		readManifest: async () => rawManifest(),
		writeReport: async () => undefined,
		loadInventory: async () => {
			throw new EndpointBackfillSchemaError("migration head mismatch");
		},
		plan: async () => {
			throw new Error("must not run");
		},
		now: () => NOW,
	};
	const schema = await executeEndpointBackfillPlan(
		args(),
		{ ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT },
		baseDependencies
	);
	assert.equal(schema.exitCode, ENDPOINT_BACKFILL_EXIT.schema);

	baseDependencies.loadInventory = async () => {
		throw new EndpointBackfillDatabaseError("bounded read failed");
	};
	const database = await executeEndpointBackfillPlan(
		args(),
		{ ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT },
		baseDependencies
	);
	assert.equal(database.exitCode, ENDPOINT_BACKFILL_EXIT.database);
});

test("PostgreSQL inventory configures and verifies a single read-only session", async () => {
	const manifest = parseEndpointBackfillManifest(rawManifest("postgres"));
	const queries: string[] = [];
	let capturedOptions: unknown;
	let closed = false;
	const context = repositoryContext("postgres", {
		unsafe: async (sql: string) => {
			queries.push(sql);
			if (sql.includes("current_setting('transaction_read_only')")) {
				return [{ transaction_read_only: "on" }];
			}
			if (sql.includes("schema_migrations")) {
				return [
					{
						migration_head: "0049_future_backward_compatible.sql",
						migration_present: true,
					},
				];
			}
			throw new Error("unexpected PostgreSQL query");
		},
		end: async () => {
			closed = true;
		},
	});
	const createPostgres: EndpointBackfillInventoryDependencies["createPostgres"] =
		async (_connectionString, options) => {
			capturedOptions = options;
			return context;
		};

	const result = await loadEndpointBackfillInventory(
		{
			driver: "postgres",
			manifest,
			databaseFingerprint: FINGERPRINT,
			env: { DATABASE_URL: "postgres://fixture.invalid/cinatoken" },
			d1Source: "local",
		},
		{
			runD1: (() => []) as D1ReadExecutor,
			createPostgres,
			createMySql: unusedMySqlDependency,
		}
	);

	assert.equal(result.inventory.source.migration_head, "0049_future_backward_compatible.sql");
	assert.equal(closed, true);
	assert.equal(
		queries.filter((sql) => sql.includes("transaction_read_only")).length,
		2
	);
	assert.equal(queries.filter((sql) => sql.includes("schema_migrations")).length, 2);
	assert.deepEqual(capturedOptions, {
		max: 1,
		target_session_attrs: "read-only",
		connection: {
			application_name: "cinatoken-endpoint-backfill-plan",
			default_transaction_read_only: true,
		},
	});
});

test("PostgreSQL inventory fails closed when the session probe is writable", async () => {
	const manifest = parseEndpointBackfillManifest(rawManifest("postgres"));
	let businessReads = 0;
	let closed = false;
	const context = repositoryContext(
		"postgres",
		{
			unsafe: async () => [{ transaction_read_only: "off" }],
			end: async () => {
				closed = true;
			},
		},
		() => {
			businessReads += 1;
		}
	);

	await assert.rejects(
		loadEndpointBackfillInventory(
			{
				driver: "postgres",
				manifest,
				databaseFingerprint: FINGERPRINT,
				env: { DATABASE_URL: "postgres://fixture.invalid/cinatoken" },
				d1Source: "local",
			},
			{
				runD1: (() => []) as D1ReadExecutor,
				createPostgres: async () => context,
				createMySql: unusedMySqlDependency,
			}
		),
		(error: unknown) =>
			error instanceof EndpointBackfillDatabaseError &&
			/session is not read-only/u.test(error.message)
	);
	assert.equal(businessReads, 0);
	assert.equal(closed, true);
});

test("PostgreSQL inventory rejects a missing required migration before business reads", async () => {
	const manifest = parseEndpointBackfillManifest(rawManifest("postgres"));
	let businessReads = 0;
	const context = repositoryContext(
		"postgres",
		{
			unsafe: async (sql: string) =>
				sql.includes("transaction_read_only")
					? [{ transaction_read_only: "on" }]
					: [{ migration_head: "0049_future.sql", migration_present: false }],
			end: async () => undefined,
		},
		() => {
			businessReads += 1;
		}
	);

	await assert.rejects(
		loadEndpointBackfillInventory(
			{
				driver: "postgres",
				manifest,
				databaseFingerprint: FINGERPRINT,
				env: { DATABASE_URL: "postgres://fixture.invalid/cinatoken" },
				d1Source: "local",
			},
			{
				runD1: (() => []) as D1ReadExecutor,
				createPostgres: async () => context,
				createMySql: unusedMySqlDependency,
			}
		),
		(error: unknown) =>
			error instanceof EndpointBackfillSchemaError &&
			/missing for postgres/u.test(error.message)
	);
	assert.equal(businessReads, 0);
});

test("MySQL inventory sets and verifies session read-only before each bounded read", async () => {
	const manifest = parseEndpointBackfillManifest(rawManifest("mysql"));
	const queries: string[] = [];
	const initializerQueries: string[] = [];
	let capturedOptions: unknown;
	let closed = false;
	let connectionListener:
		| ((connection: {
				query: (
					sql: string,
					callback: (error: Error | null) => void
				) => void;
				destroy: () => void;
		  }) => void)
		| undefined;
	let connectionEmitted = false;
	const context = repositoryContext("mysql", {
		pool: {
			on: (event: string, listener: typeof connectionListener) => {
				assert.equal(event, "connection");
				connectionListener = listener;
			},
		},
		query: async (sql: string) => {
			if (!connectionEmitted) {
				connectionEmitted = true;
				assert.ok(connectionListener);
				connectionListener({
					query: (initializerSql, callback) => {
						initializerQueries.push(initializerSql);
						callback(null);
					},
					destroy: () => {
						throw new Error("initializer should not destroy a valid connection");
					},
				});
			}
			queries.push(sql);
			if (sql === "SET SESSION TRANSACTION READ ONLY") return [[], []];
			if (sql.includes("@@SESSION.transaction_read_only")) {
				return [[{ transaction_read_only: 1 }], []];
			}
			if (sql.includes("schema_migrations")) {
				return [
					[
						{
							migration_head: "0046_future_backward_compatible.sql",
							migration_present: 1,
						},
					],
					[],
				];
			}
			throw new Error("unexpected MySQL query");
		},
		end: async () => {
			closed = true;
		},
	});
	const createMySql: EndpointBackfillInventoryDependencies["createMySql"] =
		async (_connectionString, options) => {
			capturedOptions = options;
			return context;
		};

	const result = await loadEndpointBackfillInventory(
		{
			driver: "mysql",
			manifest,
			databaseFingerprint: FINGERPRINT,
			env: { DATABASE_URL: "mysql://fixture.invalid/cinatoken" },
			d1Source: "local",
		},
		{
			runD1: (() => []) as D1ReadExecutor,
			createPostgres: unusedPostgresDependency,
			createMySql,
		}
	);

	assert.equal(result.inventory.source.migration_head, "0046_future_backward_compatible.sql");
	assert.equal(closed, true);
	assert.equal(
		queries.filter((sql) => sql === "SET SESSION TRANSACTION READ ONLY").length,
		2
	);
	assert.deepEqual(initializerQueries, ["SET SESSION TRANSACTION READ ONLY"]);
	assert.equal(
		queries.filter((sql) => sql.includes("@@SESSION.transaction_read_only")).length,
		2
	);
	assert.equal(queries.filter((sql) => sql.includes("schema_migrations")).length, 2);
	assert.deepEqual(capturedOptions, {
		connectionLimit: 1,
		maxIdle: 1,
		resetOnRelease: false,
		multipleStatements: false,
	});
});

test("D1 loader uses only SELECT, double-reads, and keeps returned credentials in memory", async () => {
	const manifest = parseEndpointBackfillManifest(rawManifest("d1"));
	const statements: string[] = [];
	const configs: Parameters<D1ReadExecutor>[1][] = [];
	const runD1: D1ReadExecutor = (sql, config) => {
		statements.push(sql);
		configs.push(config);
		assert.match(sql, /^SELECT\b/u);
		assert.doesNotMatch(
			sql,
			/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE)\b/iu
		);
		assert.doesNotMatch(sql, new RegExp(PROVIDER_SECRET, "u"));
		if (sql.includes("FROM d1_migrations")) {
			return [
				{
					migration_head: "0050_future_backward_compatible.sql",
					migration_present: 1,
				},
			];
		}
		if (sql.includes("FROM models")) return [{ id: "model-1" }];
		if (sql.includes("FROM providers")) return [PROVIDER as unknown as Record<string, unknown>];
		if (sql.includes("FROM model_routes")) return [ROUTE as unknown as Record<string, unknown>];
		return [];
	};
	const result = await loadEndpointBackfillInventory(
		{
			driver: "d1",
			manifest,
			databaseFingerprint: FINGERPRINT,
			env: { D1_DATABASE_NAME: "fixture" },
			d1Source: "local",
		},
		{
			runD1,
			createPostgres: async () => {
				throw new Error("unused");
			},
			createMySql: async () => {
				throw new Error("unused");
			},
		}
	);
	assert.equal(result.consistency.semantics, "d1-non-snapshot-double-read");
	assert.equal(result.consistency.drifted, false);
	assert.equal(result.inventory.providers[0]?.api_key, PROVIDER_SECRET);
	assert.equal(
		result.inventory.source.migration_head,
		"0050_future_backward_compatible.sql"
	);
	assert.ok(statements.length >= 12, "all referenced rows must be read twice");
	assert.equal(configs.every((config) => config.env === undefined), true);
});

test("D1 loader rejects a missing required migration before business reads", async () => {
	const manifest = parseEndpointBackfillManifest(rawManifest("d1"));
	const statements: string[] = [];
	await assert.rejects(
		loadEndpointBackfillInventory(
			{
				driver: "d1",
				manifest,
				databaseFingerprint: FINGERPRINT,
				env: { D1_DATABASE_NAME: "fixture" },
				d1Source: "local",
			},
			{
				runD1: (sql) => {
					statements.push(sql);
					return [{ migration_head: "0050_future.sql", migration_present: 0 }];
				},
				createPostgres: async () => {
					throw new Error("unused");
				},
				createMySql: async () => {
					throw new Error("unused");
				},
			}
		),
		(error: unknown) =>
			error instanceof EndpointBackfillSchemaError &&
			/missing for d1/u.test(error.message)
	);
	assert.equal(statements.length, 1);
});

test("remote D1 requires a dedicated API token before executing Wrangler", async () => {
	const manifest = parseEndpointBackfillManifest(rawManifest("d1"));
	let calls = 0;
	await assert.rejects(
		loadEndpointBackfillInventory(
			{
				driver: "d1",
				manifest,
				databaseFingerprint: FINGERPRINT,
				env: {
					D1_DATABASE_NAME: "fixture",
					CLOUDFLARE_API_KEY: "global-key-must-not-be-used",
					CLOUDFLARE_EMAIL: "operator@example.com",
				},
				d1Source: "remote",
			},
			{
				runD1: () => {
					calls += 1;
					return [];
				},
				createPostgres: unusedPostgresDependency,
				createMySql: unusedMySqlDependency,
			}
		),
		(error: unknown) =>
			error instanceof EndpointBackfillDatabaseError &&
			/CLOUDFLARE_API_TOKEN is required/u.test(error.message)
	);
	assert.equal(calls, 0);
});

test("remote D1 passes only the narrow token and strips broad Wrangler credentials", async () => {
	const manifest = parseEndpointBackfillManifest(rawManifest("d1"));
	const configs: Parameters<D1ReadExecutor>[1][] = [];
	const runD1: D1ReadExecutor = (sql, config) => {
		configs.push(config);
		if (sql.includes("FROM d1_migrations")) {
			return [
				{
					migration_head: "0050_future_backward_compatible.sql",
					migration_present: 1,
				},
			];
		}
		if (sql.includes("FROM models")) return [{ id: "model-1" }];
		if (sql.includes("FROM providers")) {
			return [PROVIDER as unknown as Record<string, unknown>];
		}
		if (sql.includes("FROM model_routes")) {
			return [ROUTE as unknown as Record<string, unknown>];
		}
		return [];
	};

	await loadEndpointBackfillInventory(
		{
			driver: "d1",
			manifest,
			databaseFingerprint: FINGERPRINT,
			env: {
				D1_DATABASE_NAME: "fixture",
				CLOUDFLARE_API_TOKEN: "  narrow-d1-read-token  ",
				CLOUDFLARE_API_KEY: "global-key",
				CLOUDFLARE_EMAIL: "operator@example.com",
				CLOUDFLARE_API_EMAIL: "legacy@example.com",
				CLOUDFLARE_GLOBAL_API_KEY: "global-key-alias",
				CF_API_KEY: "cf-global-key",
				CF_API_EMAIL: "cf@example.com",
				CF_API_TOKEN: "alternate-token",
				DATABASE_URL: "postgres://database-secret@db.example/cinatoken",
				SHARED_KEY_ENCRYPTION_SECRET: "shared-key-secret",
				UNRELATED_SERVICE_API_KEY: "unrelated-secret",
				PATH: "fixture-path",
			},
			d1Source: "remote",
		},
		{
			runD1,
			createPostgres: unusedPostgresDependency,
			createMySql: unusedMySqlDependency,
		}
	);

	assert.ok(configs.length >= 12);
	for (const config of configs) {
		assert.equal(config.source, "remote");
		assert.equal(config.env?.CLOUDFLARE_API_TOKEN, "narrow-d1-read-token");
		assert.equal(config.env?.CLOUDFLARE_API_KEY, undefined);
		assert.equal(config.env?.CLOUDFLARE_EMAIL, undefined);
		assert.equal(config.env?.CLOUDFLARE_API_EMAIL, undefined);
		assert.equal(config.env?.CLOUDFLARE_GLOBAL_API_KEY, undefined);
		assert.equal(config.env?.CF_API_KEY, undefined);
		assert.equal(config.env?.CF_API_EMAIL, undefined);
		assert.equal(config.env?.CF_API_TOKEN, undefined);
		assert.equal(config.env?.DATABASE_URL, undefined);
		assert.equal(config.env?.SHARED_KEY_ENCRYPTION_SECRET, undefined);
		assert.equal(config.env?.UNRELATED_SERVICE_API_KEY, undefined);
		assert.equal(config.env?.PATH, "fixture-path");
	}
});

test("manifest example is strict JSON and contains no credential", async () => {
	const examplePath = resolve(
		"scripts/db/model-endpoints/manifest.example.json"
	);
	const raw = await readFile(examplePath, "utf8");
	assert.doesNotMatch(raw, /api[_-]?key|secret/iu);
	const parsed = parseEndpointBackfillManifest(JSON.parse(raw));
	assert.equal(parsed.target.driver, "postgres");
	assert.equal(parsed.policy.allow_create, false);
});
