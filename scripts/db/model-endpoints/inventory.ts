import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import {
	decryptProviderApiKeyReadOnly,
} from "../../../packages/core/src/lib/provider-key-encryption";
import {
	stableEndpointBackfillJson,
	type EndpointBackfillConsistencyRead,
	type EndpointBackfillDriver,
	type EndpointBackfillInventory,
	type EndpointBackfillInventoryConsistency,
	type EndpointBackfillManifest,
} from "../../../packages/core/src/model-endpoint-backfill";
import {
	createMySqlStorageContext,
	createPostgresStorageContext,
	type StorageContext,
} from "../../../packages/core/src/storage/context";
import type { GatewayRepositories } from "../../../packages/core/src/storage/repositories-types";
import type {
	ModelEndpointRouteLinkRow,
	ModelEndpointRow,
} from "../../../packages/core/src/db/model-endpoints-types";
import type { ModelRouteRow, ProviderRow } from "../../../packages/core/src/types";
import {
	DEFAULT_D1_DATABASE_NAME,
	DEFAULT_D1_PERSIST_TO,
	runD1ExecuteJson,
	type D1ExecutionConfig,
} from "../lib/d1-execute";
import {
	EndpointBackfillDatabaseError,
	EndpointBackfillSchemaError,
	type EndpointBackfillPlanOptions,
} from "./contract";

export type EndpointBackfillInventoryRequest = {
	driver: EndpointBackfillDriver;
	manifest: EndpointBackfillManifest;
	databaseFingerprint: string;
	env: Readonly<Record<string, string | undefined>>;
	d1Source: EndpointBackfillPlanOptions["d1Source"];
	d1PersistTo?: string;
};

export type EndpointBackfillVersionVector =
	EndpointBackfillConsistencyRead["version_vector"];

export type LoadedEndpointBackfillInventory = {
	inventory: EndpointBackfillInventory;
	consistency: EndpointBackfillInventoryConsistency;
};

export type D1ReadExecutor = (
	sql: string,
	config: D1ExecutionConfig
) => Record<string, unknown>[];

export type EndpointBackfillInventoryDependencies = {
	runD1: D1ReadExecutor;
	createPostgres: typeof createPostgresStorageContext;
	createMySql: typeof createMySqlStorageContext;
};

const DEFAULT_DEPENDENCIES: EndpointBackfillInventoryDependencies = {
	runD1: runD1ExecuteJson,
	createPostgres: createPostgresStorageContext,
	createMySql: createMySqlStorageContext,
};

const ENDPOINT_COLUMNS = `id, model_id, provider_id, provider_slug, tag, endpoint_class, region,
	context_length, max_prompt_tokens, max_completion_tokens, quantization,
	supported_parameters, pricing, supports_implicit_caching, supports_voice_cloning,
	supports_tool_choice, image_capabilities, audio_capabilities, evidence_url, verified_by,
	verified_at, expires_at, status, created_at, updated_at`;
const ROUTE_COLUMNS = `id, model_id, provider_id, provider_model_name, priority, status,
	route_group, weight, price_override, custom_params, routing_metadata, upstream_protocol,
	route_pool_id, upstream_operation, adapter`;
const PROVIDER_COLUMNS = `id, name, endpoints, api_key, status, description,
	shared_channel_type, created_at`;
const LINK_COLUMNS = `endpoint_id, route_target_id, subject_fingerprint, created_at`;
const PAGE_SIZE = 100;
// Wrangler is launched through the current Node executable, but still needs a
// small set of OS, user-profile, proxy, and CA variables on developer hosts.
// Keep this positive allowlist deliberately free of application/database secrets.
const D1_REMOTE_CHILD_ENV_ALLOWLIST = [
	"ALL_PROXY",
	"APPDATA",
	"CLOUDFLARE_ACCOUNT_ID",
	"COMSPEC",
	"ComSpec",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"LANG",
	"LC_ALL",
	"LOCALAPPDATA",
	"NO_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"PATH",
	"PATHEXT",
	"Path",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"SystemRoot",
	"TEMP",
	"TMP",
	"TZ",
	"USERPROFILE",
	"WINDIR",
	"all_proxy",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Text(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretFingerprint(value: string | undefined): string {
	return `sha256:${sha256Text(value ?? "")}`;
}

export function buildEndpointBackfillConsistencyRead(
	inventory: EndpointBackfillInventory
): EndpointBackfillConsistencyRead {
	const redacted = {
		...inventory,
		providers: inventory.providers.map((provider) => ({
			...provider,
			api_key: secretFingerprint(provider.api_key),
		})),
	};
	const endpointRevisions = inventory.endpoints
		.map((row) => [row.id, row.updated_at, row.status])
		.sort((left, right) => compareCodePoints(String(left[0]), String(right[0])));
	const linkRevisions = inventory.links
		.map((row) => [
			row.endpoint_id,
			row.route_target_id,
			row.created_at,
			row.subject_fingerprint,
		])
		.sort((left, right) =>
			compareCodePoints(
				`${left[0]}\u0000${left[1]}`,
				`${right[0]}\u0000${right[1]}`
			)
		);
	return {
		rows_sha256: `sha256:${sha256Text(stableEndpointBackfillJson(redacted))}`,
		version_vector: {
			migration_head: inventory.source.migration_head,
			models: inventory.models.length,
			providers: inventory.providers.length,
			routes: inventory.routes.length,
			endpoints: inventory.endpoints.length,
			links: inventory.links.length,
			endpoint_revisions_sha256: `sha256:${sha256Text(
				stableEndpointBackfillJson(endpointRevisions)
			)}`,
			link_revisions_sha256: `sha256:${sha256Text(
				stableEndpointBackfillJson(linkRevisions)
			)}`,
		},
	};
}

function compareReads(
	before: EndpointBackfillConsistencyRead,
	after: EndpointBackfillConsistencyRead
): boolean {
	return stableEndpointBackfillJson(before) === stableEndpointBackfillJson(after);
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort(compareCodePoints);
}

function chunks<T>(values: readonly T[], size: number): T[][] {
	const output: T[][] = [];
	for (let offset = 0; offset < values.length; offset += size) {
		output.push(values.slice(offset, offset + size));
	}
	return output;
}

async function mapLimited<T, R>(
	values: readonly T[],
	limit: number,
	mapper: (value: T) => Promise<R>
): Promise<R[]> {
	const output = new Array<R>(values.length);
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, values.length) }, async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= values.length) return;
				output[index] = await mapper(values[index]!);
			}
		})
	);
	return output;
}

function mergeById<T extends { id: string }>(...groups: T[][]): T[] {
	const rows = new Map<string, T>();
	for (const row of groups.flat()) rows.set(row.id, row);
	return [...rows.values()].sort((left, right) =>
		compareCodePoints(left.id, right.id)
	);
}

function mergeLinks(...groups: ModelEndpointRouteLinkRow[][]): ModelEndpointRouteLinkRow[] {
	const rows = new Map<string, ModelEndpointRouteLinkRow>();
	for (const row of groups.flat()) {
		rows.set(`${row.endpoint_id}\u0000${row.route_target_id}`, row);
	}
	return [...rows.values()].sort((left, right) =>
		compareCodePoints(
			`${left.endpoint_id}\u0000${left.route_target_id}`,
			`${right.endpoint_id}\u0000${right.route_target_id}`
		)
	);
}

export async function decryptEndpointBackfillProvidersReadOnly(
	providers: ProviderRow[],
	encryptionSecret: string | undefined
): Promise<ProviderRow[]> {
	return Promise.all(
		providers.map(async (provider) => {
			const stored = provider.api_key ?? "";
			try {
				const plaintext = await decryptProviderApiKeyReadOnly(
					provider.id,
					stored,
					encryptionSecret
				);
				return { ...provider, api_key: plaintext };
			} catch {
				throw new EndpointBackfillDatabaseError(
					`Provider credential for ${provider.id} could not be decrypted in read-only mode`
				);
			}
		})
	);
}

function safeSchemaError(error: unknown): boolean {
	const candidate = error as { code?: unknown; message?: unknown };
	const code = typeof candidate?.code === "string" ? candidate.code.toUpperCase() : "";
	const message = typeof candidate?.message === "string" ? candidate.message : "";
	return (
		["42P01", "42703", "3F000", "ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"].includes(code) ||
		/\b(?:no such table|no such column|unknown column)\b/iu.test(message) ||
		/\b(?:relation|schema|table)\b[^\r\n]*\bdoes not exist\b/iu.test(message) ||
		/\btable\b[^\r\n]*\bdoesn't exist\b/iu.test(message)
	);
}

function classifyReadFailure(error: unknown, stage: string): never {
	if (
		error instanceof EndpointBackfillDatabaseError ||
		error instanceof EndpointBackfillSchemaError
	) {
		throw error;
	}
	if (safeSchemaError(error)) {
		throw new EndpointBackfillSchemaError(
			`Endpoint backfill schema check failed while reading ${stage}`
		);
	}
	throw new EndpointBackfillDatabaseError(
		`Endpoint backfill database read failed while reading ${stage}`
	);
}

function isReadOnlySessionValue(value: unknown): boolean {
	if (value === true || value === 1) return true;
	if (typeof value !== "string") return false;
	return ["1", "on", "true"].includes(value.trim().toLowerCase());
}

async function prepareAndVerifyRepositoryReadOnlySession(
	context: StorageContext,
	driver: "postgres" | "mysql"
): Promise<void> {
	try {
		if (driver === "postgres") {
			if (context.client.driver !== "postgres") {
				throw new TypeError("PostgreSQL context driver mismatch");
			}
			const rows = await context.client.raw.unsafe<
				Array<{ transaction_read_only: string }>
			>(
				"SELECT current_setting('transaction_read_only') AS transaction_read_only"
			);
			if (!isReadOnlySessionValue(rows[0]?.transaction_read_only)) {
				throw new EndpointBackfillDatabaseError(
					"PostgreSQL endpoint backfill session is not read-only"
				);
			}
			return;
		}

		if (context.client.driver !== "mysql") {
			throw new TypeError("MySQL context driver mismatch");
		}
		await context.client.raw.query("SET SESSION TRANSACTION READ ONLY");
		const [rows] = await context.client.raw.query<
			Array<
				{
					transaction_read_only: number | boolean | string;
				} & RowDataPacket
			>
		>(
			"SELECT @@SESSION.transaction_read_only AS transaction_read_only"
		);
		if (!isReadOnlySessionValue(rows[0]?.transaction_read_only)) {
			throw new EndpointBackfillDatabaseError(
				"MySQL endpoint backfill session is not read-only"
			);
		}
	} catch (error) {
		return classifyReadFailure(error, "read-only session verification");
	}
}

function installMySqlReadOnlyConnectionInitializer(context: StorageContext): void {
	if (context.client.driver !== "mysql") {
		throw new EndpointBackfillDatabaseError(
			"MySQL endpoint backfill context driver mismatch"
		);
	}
	context.client.raw.pool.on("connection", (connection) => {
		// mysql2 emits this event synchronously before handing a new physical
		// connection to the queued caller. Enqueueing the SET here therefore keeps
		// reconnects read-only before their first inventory statement.
		connection.query("SET SESSION TRANSACTION READ ONLY", (error) => {
			if (error) connection.destroy();
		});
	});
}

function sanitizedD1RemoteEnvironment(
	env: Readonly<Record<string, string | undefined>>
): NodeJS.ProcessEnv {
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
	if (!apiToken) {
		throw new EndpointBackfillDatabaseError(
			"CLOUDFLARE_API_TOKEN is required for remote D1 read-only planning"
		);
	}
	const childEnv: NodeJS.ProcessEnv = {};
	for (const name of D1_REMOTE_CHILD_ENV_ALLOWLIST) {
		const value = env[name];
		if (value !== undefined) childEnv[name] = value;
	}
	childEnv.CLOUDFLARE_API_TOKEN = apiToken;
	return childEnv;
}

async function repositoryMigrationState(
	context: StorageContext,
	driver: "postgres" | "mysql",
	requiredMigration: string
): Promise<{ migrationHead: string; migrationPresent: boolean }> {
	try {
		if (driver === "postgres") {
			if (context.client.driver !== "postgres") {
				throw new TypeError("PostgreSQL context driver mismatch");
			}
			const rows = await context.client.raw.unsafe<
				Array<{ migration_head: string; migration_present: boolean }>
			>(
				`SELECT COALESCE(MAX(version), '') AS migration_head,
					COALESCE(BOOL_OR(version = $1), FALSE) AS migration_present
				 FROM cinatoken_gateway.schema_migrations`,
				[requiredMigration]
			);
			return {
				migrationHead: String(rows[0]?.migration_head ?? ""),
				migrationPresent: rows[0]?.migration_present === true,
			};
		}
		if (context.client.driver !== "mysql") {
			throw new TypeError("MySQL context driver mismatch");
		}
		const [rows] = await context.client.raw.query<
			Array<
				{
					migration_head: string;
					migration_present: number | boolean;
				} & RowDataPacket
			>
		>(
			`SELECT COALESCE(MAX(version), '') AS migration_head,
				COALESCE(MAX(BINARY version = BINARY ?), 0) AS migration_present
			 FROM schema_migrations`,
			[requiredMigration]
		);
		return {
			migrationHead: String(rows[0]?.migration_head ?? ""),
			migrationPresent:
				rows[0]?.migration_present === true ||
				Number(rows[0]?.migration_present ?? 0) === 1,
		};
	} catch (error) {
		return classifyReadFailure(error, "migration head");
	}
}

async function closeStorageContext(context: StorageContext): Promise<void> {
	try {
		if (context.client.driver === "postgres") {
			await context.client.raw.end({ timeout: 5 });
		} else if (context.client.driver === "mysql") {
			await context.client.raw.end();
		}
	} catch {
		// The read result is already complete. Do not turn a pool cleanup failure
		// into a report that could tempt an operator to repeat a valid plan.
	}
}

async function loadIdentityCandidates(
	repositories: GatewayRepositories,
	manifest: EndpointBackfillManifest
): Promise<ModelEndpointRow[]> {
	const getByIdentity = repositories.modelEndpoints.getByIdentity;
	if (!getByIdentity) {
		throw new EndpointBackfillDatabaseError(
			"Exact model-endpoint identity lookup is unavailable"
		);
	}
	const candidates = await mapLimited(manifest.endpoints, 8, (endpoint) =>
		getByIdentity.call(
			repositories.modelEndpoints,
			endpoint.model_id,
			endpoint.provider_id,
			endpoint.tag
		)
	);
	return mergeById(
		candidates.filter((row): row is ModelEndpointRow => row !== null)
	);
}

export async function loadEndpointBackfillRepositoryInventoryOnce(
	context: StorageContext,
	request: EndpointBackfillInventoryRequest
): Promise<EndpointBackfillInventory> {
	const repositories = context.repositories;
	const requiredMigration = request.manifest.target.required_migration;
	const migrationState = await repositoryMigrationState(
		context,
		request.driver as "postgres" | "mysql",
		requiredMigration
	);
	if (!migrationState.migrationPresent) {
		throw new EndpointBackfillSchemaError(
			`Required migration is missing for ${request.driver}: ${requiredMigration}`
		);
	}
	const migrationHead = migrationState.migrationHead;
	const modelIds = uniqueSorted(request.manifest.endpoints.map((entry) => entry.model_id));
	const providerIds = uniqueSorted(
		request.manifest.endpoints.map((entry) => entry.provider_id)
	);
	const routeIds = uniqueSorted(
		request.manifest.endpoints.flatMap((entry) => entry.route_target_ids)
	);
	const endpointIds = uniqueSorted(request.manifest.endpoints.map((entry) => entry.id));

	try {
		const [modelRows, storedProviders, routeRows, selectedEndpointRows, identityRows] =
			await Promise.all([
				mapLimited(modelIds, 8, (id) =>
					repositories.models.getModelDetailWithRouteCounts(id)
				),
				repositories.providers.getProvidersByIds(providerIds),
				mapLimited(routeIds, 8, (id) => repositories.routes.getModelRouteRowById(id)),
				mapLimited(endpointIds, 8, (id) => repositories.modelEndpoints.getById(id)),
				loadIdentityCandidates(repositories, request.manifest),
			]);
		const [currentLinks, ownerBindings] = await Promise.all([
			repositories.modelEndpoints.listRouteLinks(endpointIds),
			Promise.all(
				chunks(routeIds, PAGE_SIZE).map((ids) =>
					repositories.modelEndpoints.listRuntimeBindingsByRouteTargetIds(ids)
				)
			).then((groups) => groups.flat()),
		]);
		const routeIdSet = new Set(routeIds);
		const ownerEndpointIds = uniqueSorted(ownerBindings.map((row) => row.id));
		const ownerLinks = (
			await Promise.all(
				chunks(ownerEndpointIds, PAGE_SIZE).map((ids) =>
					repositories.modelEndpoints.listRouteLinks(ids)
				)
			)
		)
			.flat()
			.filter((link) => routeIdSet.has(link.route_target_id));
		return {
			source: {
				driver: request.driver,
				database_fingerprint: request.databaseFingerprint,
				required_migration: requiredMigration,
				migration_head: migrationHead,
				migration_present: true,
			},
			models: modelRows.filter((row): row is NonNullable<typeof row> => row !== null).map((row) => ({ id: row.id })),
			providers: storedProviders,
			routes: routeRows.filter((row): row is ModelRouteRow => row !== null),
			endpoints: mergeById(
				selectedEndpointRows.filter((row): row is ModelEndpointRow => row !== null),
				identityRows
			),
			links: mergeLinks(currentLinks, ownerLinks),
			evidence_attestations: [],
		};
	} catch (error) {
		return classifyReadFailure(error, "referenced endpoint inventory");
	}
}

async function loadRepositoryInventory(
	request: EndpointBackfillInventoryRequest,
	dependencies: EndpointBackfillInventoryDependencies
): Promise<LoadedEndpointBackfillInventory> {
	const connectionString = request.env.DATABASE_URL?.trim();
	if (!connectionString) {
		throw new EndpointBackfillDatabaseError(
			"DATABASE_URL is required for PostgreSQL/MySQL read-only planning"
		);
	}
	let context: StorageContext;
	try {
		context =
			request.driver === "postgres"
				? await dependencies.createPostgres(connectionString, {
						max: 1,
						target_session_attrs: "read-only",
						connection: {
							application_name: "cinatoken-endpoint-backfill-plan",
							default_transaction_read_only: true,
						},
					})
				: await dependencies.createMySql(connectionString, {
						connectionLimit: 1,
						maxIdle: 1,
						resetOnRelease: false,
						multipleStatements: false,
					});
	} catch {
		throw new EndpointBackfillDatabaseError(
			`Could not establish the ${request.driver} read-only planning connection`
		);
	}
	try {
		if (request.driver === "mysql") {
			installMySqlReadOnlyConnectionInitializer(context);
		}
		await prepareAndVerifyRepositoryReadOnlySession(
			context,
			request.driver as "postgres" | "mysql"
		);
		const first = await loadEndpointBackfillRepositoryInventoryOnce(context, request);
		const before = buildEndpointBackfillConsistencyRead(first);
		await prepareAndVerifyRepositoryReadOnlySession(
			context,
			request.driver as "postgres" | "mysql"
		);
		const second = await loadEndpointBackfillRepositoryInventoryOnce(context, request);
		const after = buildEndpointBackfillConsistencyRead(second);
		const consistency: EndpointBackfillInventoryConsistency = {
			semantics: "repository-double-read",
			snapshot_consistent: false,
			before,
			after,
			drifted: !compareReads(before, after),
		};
		if (!consistency.drifted) {
			first.providers = await decryptEndpointBackfillProvidersReadOnly(
				first.providers,
				request.env.SHARED_KEY_ENCRYPTION_SECRET
			);
		}
		first.consistency = consistency;
		return {
			inventory: first,
			consistency,
		};
	} finally {
		await closeStorageContext(context);
	}
}

function quoteSqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function assertReadOnlyD1Sql(sql: string): void {
	if (!/^\s*SELECT\b/iu.test(sql)) {
		throw new TypeError("D1 endpoint backfill loader attempted a non-SELECT statement");
	}
	if (/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|VACUUM|ATTACH|DETACH)\b/iu.test(sql)) {
		throw new TypeError("D1 endpoint backfill loader attempted mutating SQL");
	}
}

function d1Rows<T>(
	dependencies: EndpointBackfillInventoryDependencies,
	config: D1ExecutionConfig,
	sql: string,
	stage: string
): T[] {
	assertReadOnlyD1Sql(sql);
	try {
		return dependencies.runD1(sql, config) as unknown as T[];
	} catch (error) {
		return classifyReadFailure(error, stage);
	}
}

function d1SelectByIds<T>(
	dependencies: EndpointBackfillInventoryDependencies,
	config: D1ExecutionConfig,
	table: string,
	columns: string,
	column: string,
	ids: readonly string[],
	stage: string
): T[] {
	return chunks(ids, PAGE_SIZE).flatMap((batch) => {
		if (batch.length === 0) return [];
		const values = batch.map(quoteSqlString).join(", ");
		return d1Rows<T>(
			dependencies,
			config,
			`SELECT ${columns} FROM ${table} WHERE ${column} IN (${values}) ORDER BY ${column}`,
			stage
		);
	});
}

async function loadD1InventoryOnce(
	request: EndpointBackfillInventoryRequest,
	dependencies: EndpointBackfillInventoryDependencies,
	config: D1ExecutionConfig
): Promise<EndpointBackfillInventory> {
	const requiredMigration = request.manifest.target.required_migration;
	const migrationRows = d1Rows<{
		migration_head: string;
		migration_present: number | boolean;
	}>(
		dependencies,
		config,
		`SELECT
			COALESCE((SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1), '') AS migration_head,
			EXISTS(SELECT 1 FROM d1_migrations WHERE name = ${quoteSqlString(
				requiredMigration
			)}) AS migration_present`,
		"D1 migration head"
	);
	const migrationHead = String(migrationRows[0]?.migration_head ?? "");
	const migrationPresent =
		migrationRows[0]?.migration_present === true ||
		Number(migrationRows[0]?.migration_present ?? 0) === 1;
	if (!migrationPresent) {
		throw new EndpointBackfillSchemaError(
			`Required migration is missing for d1: ${requiredMigration}`
		);
	}
	const modelIds = uniqueSorted(request.manifest.endpoints.map((entry) => entry.model_id));
	const providerIds = uniqueSorted(
		request.manifest.endpoints.map((entry) => entry.provider_id)
	);
	const routeIds = uniqueSorted(
		request.manifest.endpoints.flatMap((entry) => entry.route_target_ids)
	);
	const endpointIds = uniqueSorted(request.manifest.endpoints.map((entry) => entry.id));
	const models = d1SelectByIds<{ id: string }>(
		dependencies,
		config,
		"models",
		"id",
		"id",
		modelIds,
		"referenced models"
	);
	const storedProviders = d1SelectByIds<ProviderRow>(
		dependencies,
		config,
		"providers",
		PROVIDER_COLUMNS,
		"id",
		providerIds,
		"referenced providers"
	);
	const routes = d1SelectByIds<ModelRouteRow>(
		dependencies,
		config,
		"model_routes",
		ROUTE_COLUMNS,
		"id",
		routeIds,
		"referenced routes"
	);
	const selectedEndpoints = d1SelectByIds<ModelEndpointRow>(
		dependencies,
		config,
		"model_endpoints",
		ENDPOINT_COLUMNS,
		"id",
		endpointIds,
		"selected endpoints"
	);
	const identityCandidates = chunks(request.manifest.endpoints, 25).flatMap((batch) => {
		const predicates = batch.map(
			(entry) =>
				`(model_id = ${quoteSqlString(entry.model_id)} AND provider_id = ${quoteSqlString(
					entry.provider_id
				)} AND tag = ${quoteSqlString(entry.tag)})`
		);
		return d1Rows<ModelEndpointRow>(
			dependencies,
			config,
			`SELECT ${ENDPOINT_COLUMNS} FROM model_endpoints WHERE ${predicates.join(
				" OR "
			)} ORDER BY id`,
			"endpoint identity candidates"
		);
	});
	const currentLinks = d1SelectByIds<ModelEndpointRouteLinkRow>(
		dependencies,
		config,
		"model_endpoint_routes",
		LINK_COLUMNS,
		"endpoint_id",
		endpointIds,
		"current endpoint links"
	);
	const ownerLinks = d1SelectByIds<ModelEndpointRouteLinkRow>(
		dependencies,
		config,
		"model_endpoint_routes",
		LINK_COLUMNS,
		"route_target_id",
		routeIds,
		"route link owners"
	);
	return {
		source: {
			driver: "d1",
			database_fingerprint: request.databaseFingerprint,
			required_migration: requiredMigration,
			migration_head: migrationHead,
			migration_present: true,
		},
		models,
		providers: storedProviders,
		routes,
		endpoints: mergeById(selectedEndpoints, identityCandidates),
		links: mergeLinks(currentLinks, ownerLinks),
		evidence_attestations: [],
	};
}

async function loadD1Inventory(
	request: EndpointBackfillInventoryRequest,
	dependencies: EndpointBackfillInventoryDependencies
): Promise<LoadedEndpointBackfillInventory> {
	const executionEnv =
		request.d1Source === "remote"
			? sanitizedD1RemoteEnvironment(request.env)
			: undefined;
	const config: D1ExecutionConfig = {
		databaseName:
			request.env.D1_DATABASE_NAME?.trim() || DEFAULT_D1_DATABASE_NAME,
		source: request.d1Source,
		persistTo:
			request.d1PersistTo ??
			request.env.D1_PERSIST_TO?.trim() ??
			DEFAULT_D1_PERSIST_TO,
		...(executionEnv ? { env: executionEnv } : {}),
	};
	const first = await loadD1InventoryOnce(request, dependencies, config);
	const before = buildEndpointBackfillConsistencyRead(first);
	const second = await loadD1InventoryOnce(request, dependencies, config);
	const after = buildEndpointBackfillConsistencyRead(second);
	const consistency: EndpointBackfillInventoryConsistency = {
		semantics: "d1-non-snapshot-double-read",
		snapshot_consistent: false,
		before,
		after,
		drifted: !compareReads(before, after),
	};
	if (!consistency.drifted) {
		first.providers = await decryptEndpointBackfillProvidersReadOnly(
			first.providers,
			request.env.SHARED_KEY_ENCRYPTION_SECRET
		);
	}
	first.consistency = consistency;
	return {
		inventory: first,
		consistency,
	};
}

export async function loadEndpointBackfillInventory(
	request: EndpointBackfillInventoryRequest,
	dependencies: EndpointBackfillInventoryDependencies = DEFAULT_DEPENDENCIES
): Promise<LoadedEndpointBackfillInventory> {
	if (request.driver === "d1") {
		return loadD1Inventory(request, dependencies);
	}
	return loadRepositoryInventory(request, dependencies);
}
