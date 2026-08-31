import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { StorageContext } from "../../../packages/core/src/storage/context";
import {
	createMySqlStorageContext,
	createPostgresStorageContext,
} from "../../../packages/core/src/storage/context";
import { createMySqlRepositories } from "../../../packages/core/src/storage/repositories-mysql";
import { createPostgresRepositories } from "../../../packages/core/src/storage/repositories-postgres";
import type { ModelEndpointRow } from "../../../packages/core/src/db/model-endpoints-types";
import {
	EndpointBackfillApplyError,
	type EndpointBackfillApplyRun,
	type EndpointBackfillApplyStore,
	type EndpointBackfillApplyTransaction,
	type EndpointBackfillEvidenceAttestationWrite,
} from "../../../packages/core/src/model-endpoint-backfill-apply";
import type {
	EndpointBackfillInventory,
	EndpointBackfillManifest,
} from "../../../packages/core/src/model-endpoint-backfill";
import {
	EndpointBackfillDatabaseError,
	EndpointBackfillRevisionError,
	EndpointBackfillSchemaError,
} from "./contract";
import {
	buildEndpointBackfillConsistencyRead,
	decryptEndpointBackfillProvidersReadOnly,
	loadEndpointBackfillRepositoryInventoryOnce,
	type EndpointBackfillInventoryRequest,
} from "./inventory";

export const ENDPOINT_BACKFILL_APPLY_MIGRATIONS = {
	postgres: "0049_model_endpoint_evidence_ledger.sql",
	mysql: "0046_model_endpoint_evidence_ledger.sql",
} as const;

const POSTGRES_APPLY_LOCK = 7_291_064_188_253_997_103n;
const MYSQL_APPLY_LOCK = "cinatoken:model-endpoint-backfill:apply";

type Driver = keyof typeof ENDPOINT_BACKFILL_APPLY_MIGRATIONS;

export type EndpointBackfillApplyStoreRequest = {
	driver: Driver;
	manifest: EndpointBackfillManifest;
	databaseFingerprint: string;
	env: Readonly<Record<string, string | undefined>>;
};

export type EndpointBackfillApplyStoreDependencies = {
	createPostgresStorageContext: typeof createPostgresStorageContext;
	createMySqlStorageContext: typeof createMySqlStorageContext;
};

const DEFAULT_APPLY_STORE_DEPENDENCIES: EndpointBackfillApplyStoreDependencies =
	{
		createPostgresStorageContext,
		createMySqlStorageContext,
	};

const MYSQL_DATABASE_TIMESTAMP =
	/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/u;

/**
 * Convert a validated database instant to a UTC TIMESTAMP(6) literal without
 * routing the fractional component through JavaScript's millisecond Date
 * precision. MySQL inventory emits six digits, so revision CAS remains exact.
 */
export function toMySqlUtcDateTime6(value: string): string {
	const match = MYSQL_DATABASE_TIMESTAMP.exec(value);
	if (!match) throw new Error("Invalid MySQL datetime input");
	const [, date, time, rawFraction = "", rawOffset = "Z"] = match;
	const normalizedOffset =
		rawOffset === "Z"
			? "Z"
			: /^[+-]\d{2}$/u.test(rawOffset)
			? `${rawOffset}:00`
			: /^[+-]\d{4}$/u.test(rawOffset)
			? `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}`
			: rawOffset;
	const epoch = Date.parse(`${date}T${time}${normalizedOffset}`);
	if (!Number.isFinite(epoch)) throw new Error("Invalid MySQL datetime input");
	const utcSecond = new Date(epoch)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
	const fraction = rawFraction.padEnd(6, "0").slice(0, 6);
	return `${utcSecond}.${fraction}`;
}

const ENDPOINT_COLUMNS = `id, model_id, provider_id, provider_slug, tag, endpoint_class, region,
	context_length, max_prompt_tokens, max_completion_tokens, quantization,
	supported_parameters, pricing, supports_implicit_caching, supports_voice_cloning,
	supports_tool_choice, image_capabilities, audio_capabilities, evidence_url, verified_by,
	verified_at, expires_at, status, created_at, updated_at`;

function endpointValues(
	row: ModelEndpointRow,
	status: "draft" | "verified"
): unknown[] {
	return [
		row.id,
		row.model_id,
		row.provider_id,
		row.provider_slug,
		row.tag,
		row.endpoint_class,
		row.region,
		row.context_length,
		row.max_prompt_tokens,
		row.max_completion_tokens,
		row.quantization,
		row.supported_parameters,
		row.pricing,
		row.supports_implicit_caching,
		row.supports_voice_cloning,
		row.supports_tool_choice,
		row.image_capabilities,
		row.audio_capabilities ?? "{}",
		row.evidence_url,
		status === "verified" ? row.verified_by : null,
		status === "verified" ? row.verified_at : null,
		row.expires_at,
		status,
		row.created_at,
		row.updated_at,
	];
}

function inventoryRequest(
	input: EndpointBackfillApplyStoreRequest
): EndpointBackfillInventoryRequest {
	return {
		driver: input.driver,
		manifest: input.manifest,
		databaseFingerprint: input.databaseFingerprint,
		env: input.env,
		d1Source: "remote",
	};
}

export async function finalizeEndpointBackfillApplyInventory(
	inventory: EndpointBackfillInventory,
	evidence: Array<{ endpoint_id: string; desired_sha256: string }>,
	encryptionSecret: string | undefined
): Promise<EndpointBackfillInventory> {
	inventory.providers = await decryptEndpointBackfillProvidersReadOnly(
		inventory.providers,
		encryptionSecret
	);
	inventory.evidence_attestations = evidence;
	const read = buildEndpointBackfillConsistencyRead(inventory);
	inventory.consistency = {
		semantics: "serializable-transaction",
		snapshot_consistent: true,
		before: read,
		after: read,
		drifted: false,
	};
	return inventory;
}

function databaseErrorCode(error: unknown): string {
	let current = error;
	for (let depth = 0; depth < 4 && current; depth += 1) {
		if (typeof current !== "object") return "";
		const candidate = current as {
			code?: unknown;
			errno?: unknown;
			cause?: unknown;
		};
		if (typeof candidate.code === "string") return candidate.code;
		if (typeof candidate.errno === "number") return String(candidate.errno);
		current = candidate.cause;
	}
	return "";
}

function isMissingTableError(error: unknown, driver: Driver): boolean {
	const code = databaseErrorCode(error);
	return driver === "postgres"
		? code === "42P01"
		: code === "ER_NO_SUCH_TABLE" || code === "1146";
}

function safeDatabaseFailure(message: string): EndpointBackfillDatabaseError {
	return new EndpointBackfillDatabaseError(message);
}

function revisionFailure(message: string): EndpointBackfillRevisionError {
	return new EndpointBackfillRevisionError(message);
}

function checkedDatabaseDate(value: unknown): Date {
	const date =
		value instanceof Date
			? new Date(value.getTime())
			: new Date(String(value ?? ""));
	if (!Number.isFinite(date.getTime())) {
		throw safeDatabaseFailure("Endpoint backfill database clock is invalid");
	}
	return date;
}

function postgresTransaction(
	context: StorageContext,
	input: EndpointBackfillApplyStoreRequest,
	raw: any
): EndpointBackfillApplyTransaction {
	const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
		(await raw.unsafe(sql, params as never[])) as T[];
	const txClient = { driver: "postgres", raw, drizzle: {} } as any;
	const txContext: StorageContext = {
		client: txClient,
		repositories: createPostgresRepositories(txClient),
	};
	const applyMigration = ENDPOINT_BACKFILL_APPLY_MIGRATIONS.postgres;
	const assertApplyMigration = async (): Promise<void> => {
		try {
			const migration = await query<{ present: boolean }>(
				"SELECT COALESCE(BOOL_OR(version = $1), FALSE) AS present FROM cinatoken_gateway.schema_migrations",
				[applyMigration]
			);
			if (migration[0]?.present !== true) {
				throw new EndpointBackfillSchemaError(
					`Required apply migration is missing: ${applyMigration}`
				);
			}
		} catch (error) {
			if (error instanceof EndpointBackfillSchemaError) throw error;
			if (isMissingTableError(error, "postgres")) {
				throw new EndpointBackfillSchemaError(
					`Required apply migration is missing: ${applyMigration}`
				);
			}
			throw error;
		}
	};
	return {
		async acquireLock() {
			const rows = await query<{ locked: boolean }>(
				"SELECT pg_try_advisory_xact_lock($1) AS locked",
				[POSTGRES_APPLY_LOCK.toString()]
			);
			if (rows[0]?.locked !== true) {
				throw safeDatabaseFailure(
					"Another endpoint backfill apply holds the database lock"
				);
			}
		},
		async verifyDatabaseIdentity(
			expectedFingerprint,
			expectedTrustedSignersSha256
		) {
			await assertApplyMigration();
			let rows: Array<{
				database_fingerprint: string;
				database_name: string;
				database_oid: string;
				gateway_schema: string;
				apply_role: string;
				current_database_name: string;
				current_database_oid: string;
				current_gateway_schema: string;
				current_apply_role: string;
				trusted_signers_sha256: string;
			}>;
			try {
				rows = await query(
					`SELECT identity.database_fingerprint, identity.database_name,
				 identity.database_oid::text AS database_oid, identity.gateway_schema,
				 identity.apply_role,
				 current_database() AS current_database_name,
				 db.oid::text AS current_database_oid,
				 current_schema() AS current_gateway_schema,
				 current_user AS current_apply_role,
				 registry.trusted_signers_sha256
				 FROM model_endpoint_backfill_database_identity identity
				 JOIN pg_database db ON db.datname = current_database()
				 CROSS JOIN model_endpoint_backfill_trust_registry registry
				 WHERE identity.singleton = 1 AND registry.singleton = 1
				 FOR SHARE OF identity, registry`
				);
			} catch (error) {
				if (isMissingTableError(error, "postgres")) {
					throw new EndpointBackfillSchemaError(
						`Required apply migration is missing: ${applyMigration}`
					);
				}
				throw error;
			}
			const identity = rows[0];
			if (
				rows.length !== 1 ||
				!identity ||
				identity.database_fingerprint !== expectedFingerprint ||
				identity.database_name !== identity.current_database_name ||
				identity.database_oid !== identity.current_database_oid ||
				identity.gateway_schema !== "cinatoken_gateway" ||
				identity.current_gateway_schema !== "cinatoken_gateway" ||
				identity.apply_role !== identity.current_apply_role ||
				identity.trusted_signers_sha256 !== expectedTrustedSignersSha256
			) {
				throw safeDatabaseFailure(
					"Endpoint backfill database identity or signer trust root mismatch"
				);
			}
		},
		async databaseNow() {
			const rows = await query<{ database_now: string }>(
				"SELECT clock_timestamp()::text AS database_now"
			);
			return checkedDatabaseDate(rows[0]?.database_now);
		},
		async findCompletedRun(idempotencyKey) {
			const rows = await query<EndpointBackfillApplyRun>(
				`SELECT idempotency_key, manifest_id, manifest_sha256, selected_manifest_sha256,
					selection_sha256, database_fingerprint, request_sha256, execution_sha256,
					trusted_signers_sha256, authorization_sha256, manifest_actor_id,
					manifest_actor_key_id, evidence_reviewers_json, approved_by, approval_key_id,
					approval_approved_at, approval_expires_at,
					to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS applied_at,
					actions_count, endpoints_count
				 FROM model_endpoint_backfill_runs WHERE idempotency_key = $1`,
				[idempotencyKey]
			);
			return rows[0] ?? null;
		},
		async loadInventory() {
			await assertApplyMigration();
			const inventory = await loadEndpointBackfillRepositoryInventoryOnce(
				txContext,
				inventoryRequest(input)
			);
			const endpointIds = input.manifest.endpoints.map(
				(endpoint) => endpoint.id
			);
			const evidence = await query<{
				endpoint_id: string;
				desired_sha256: string;
			}>(
				`SELECT DISTINCT ON (endpoint_id) endpoint_id, desired_sha256
				 FROM model_endpoint_evidence_attestations
				 WHERE endpoint_id = ANY($1::text[])
				 ORDER BY endpoint_id, applied_at DESC, idempotency_key DESC`,
				[endpointIds]
			);
			return finalizeEndpointBackfillApplyInventory(
				inventory,
				evidence,
				input.env.SHARED_KEY_ENCRYPTION_SECRET
			);
		},
		async assertEndpointRevision(endpointId, expectedUpdatedAt) {
			if (expectedUpdatedAt === null) {
				const rows = await query<{ id: string }>(
					"SELECT id FROM model_endpoints WHERE id = $1 FOR UPDATE",
					[endpointId]
				);
				if (rows.length !== 0)
					throw revisionFailure("Endpoint revision changed during apply");
				return;
			}
			const rows = await query<{ id: string }>(
				"SELECT id FROM model_endpoints WHERE id = $1 AND updated_at = $2::timestamptz FOR UPDATE",
				[endpointId, expectedUpdatedAt]
			);
			if (rows.length !== 1)
				throw revisionFailure("Endpoint revision changed during apply");
		},
		async writeDraft(desired, mode, expectedUpdatedAt) {
			if (mode === "preserve") return;
			if (mode === "create") {
				await query(
					`INSERT INTO model_endpoints (${ENDPOINT_COLUMNS}) VALUES (${Array.from(
						{ length: 25 },
						(_, index) => `$${index + 1}`
					).join(",")})`,
					endpointValues(desired, "draft")
				);
				return;
			}
			const values = endpointValues(desired, "draft");
			const rows = await query<{ id: string }>(
				`UPDATE model_endpoints SET
				 model_id=$2, provider_id=$3, provider_slug=$4, tag=$5, endpoint_class=$6,
				 region=$7, context_length=$8, max_prompt_tokens=$9, max_completion_tokens=$10,
				 quantization=$11, supported_parameters=$12, pricing=$13,
				 supports_implicit_caching=$14, supports_voice_cloning=$15,
				 supports_tool_choice=$16, image_capabilities=$17, audio_capabilities=$18,
				 evidence_url=$19, verified_by=NULL, verified_at=NULL, expires_at=$22,
				 status='draft', updated_at=$25
				 WHERE id=$1 AND updated_at=$26::timestamptz RETURNING id`,
				[...values, expectedUpdatedAt]
			);
			if (rows.length !== 1)
				throw revisionFailure("Endpoint CAS update failed");
		},
		async syncRouteBindings(endpointId, bindings, appliedAt) {
			const desiredRouteIds = bindings.map(
				(binding) => binding.route_target_id
			);
			await query(
				"DELETE FROM model_endpoint_routes WHERE endpoint_id = $1 AND NOT (route_target_id = ANY($2::text[]))",
				[endpointId, desiredRouteIds]
			);
			for (const binding of bindings) {
				const owners = await query<{ endpoint_id: string }>(
					"SELECT endpoint_id FROM model_endpoint_routes WHERE route_target_id = $1 FOR UPDATE",
					[binding.route_target_id]
				);
				if (owners[0] && owners[0].endpoint_id !== endpointId) {
					throw revisionFailure("Route ownership changed during apply");
				}
				await query(
					`INSERT INTO model_endpoint_routes (endpoint_id, route_target_id, subject_fingerprint, created_at)
					 VALUES ($1,$2,$3,$4)
					 ON CONFLICT (endpoint_id, route_target_id)
					 DO UPDATE SET subject_fingerprint = EXCLUDED.subject_fingerprint`,
					[
						endpointId,
						binding.route_target_id,
						binding.subject_fingerprint,
						appliedAt,
					]
				);
			}
		},
		async publish(desired) {
			const rows = await query<{ id: string }>(
				`UPDATE model_endpoints SET evidence_url=$2, verified_by=$3, verified_at=$4,
				 expires_at=$5, status='verified', updated_at=$6 WHERE id=$1 RETURNING id`,
				[
					desired.id,
					desired.evidence_url,
					desired.verified_by,
					desired.verified_at,
					desired.expires_at,
					desired.updated_at,
				]
			);
			if (rows.length !== 1)
				throw safeDatabaseFailure("Endpoint publish failed");
		},
		async insertRun(run) {
			await query(
				`INSERT INTO model_endpoint_backfill_runs
				 (idempotency_key, manifest_id, manifest_sha256, selected_manifest_sha256,
				  selection_sha256, database_fingerprint, request_sha256, execution_sha256,
				  trusted_signers_sha256, authorization_sha256, manifest_actor_id,
				  manifest_actor_key_id, evidence_reviewers_json, approved_by, approval_key_id,
				  approval_approved_at, approval_expires_at, applied_at, actions_count, endpoints_count)
				 VALUES (${Array.from({ length: 20 }, (_, index) => `$${index + 1}`).join(
						","
					)})`,
				[
					run.idempotency_key,
					run.manifest_id,
					run.manifest_sha256,
					run.selected_manifest_sha256,
					run.selection_sha256,
					run.database_fingerprint,
					run.request_sha256,
					run.execution_sha256,
					run.trusted_signers_sha256,
					run.authorization_sha256,
					run.manifest_actor_id,
					run.manifest_actor_key_id,
					run.evidence_reviewers_json,
					run.approved_by,
					run.approval_key_id,
					run.approval_approved_at,
					run.approval_expires_at,
					run.applied_at,
					run.actions_count,
					run.endpoints_count,
				]
			);
		},
		async insertAttestation(attestation) {
			await query(
				`INSERT INTO model_endpoint_evidence_attestations
				 (idempotency_key, endpoint_id, desired_sha256, before_sha256,
				  verification_state_sha256, evidence_sha256, evidence_url,
				  evidence_observed_at, evidence_expires_at, evidence_reviewed_by,
				  evidence_reviewer_key_id, manifest_actor_id, approved_by, applied_at)
				 VALUES (${Array.from({ length: 14 }, (_, index) => `$${index + 1}`).join(
						","
					)})`,
				[
					attestation.idempotency_key,
					attestation.endpoint_id,
					attestation.desired_sha256,
					attestation.before_sha256,
					attestation.verification_state_sha256,
					attestation.evidence_sha256,
					attestation.evidence_url,
					attestation.evidence_observed_at,
					attestation.evidence_expires_at,
					attestation.evidence_reviewed_by,
					attestation.evidence_reviewer_key_id,
					attestation.manifest_actor_id,
					attestation.approved_by,
					attestation.applied_at,
				]
			);
		},
	};
}

function mysqlEndpointValues(
	row: ModelEndpointRow,
	status: "draft" | "verified"
): unknown[] {
	return endpointValues(row, status).map((value, index) => {
		if (typeof value === "boolean") return value ? 1 : 0;
		if ([20, 21, 23, 24].includes(index) && typeof value === "string") {
			return toMySqlUtcDateTime6(value);
		}
		return value;
	});
}

function mysqlTransaction(
	input: EndpointBackfillApplyStoreRequest,
	connection: any
): EndpointBackfillApplyTransaction {
	const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
		(await connection.query(sql, params))[0] as T[];
	const execute = async (
		sql: string,
		params: unknown[] = []
	): Promise<ResultSetHeader> =>
		(await connection.execute(sql, params))[0] as ResultSetHeader;
	const txClient = { driver: "mysql", raw: connection, drizzle: {} } as any;
	const txContext: StorageContext = {
		client: txClient,
		repositories: createMySqlRepositories(txClient),
	};
	const applyMigration = ENDPOINT_BACKFILL_APPLY_MIGRATIONS.mysql;
	const assertApplyMigration = async (): Promise<void> => {
		try {
			const migration = await query<{ present: number } & RowDataPacket>(
				"SELECT COALESCE(MAX(BINARY version = BINARY ?), 0) AS present FROM schema_migrations",
				[applyMigration]
			);
			if (Number(migration[0]?.present ?? 0) !== 1) {
				throw new EndpointBackfillSchemaError(
					`Required apply migration is missing: ${applyMigration}`
				);
			}
		} catch (error) {
			if (error instanceof EndpointBackfillSchemaError) throw error;
			if (isMissingTableError(error, "mysql")) {
				throw new EndpointBackfillSchemaError(
					`Required apply migration is missing: ${applyMigration}`
				);
			}
			throw error;
		}
	};
	return {
		async acquireLock() {
			const rows = await query<
				Array<{ locked: number } & RowDataPacket>[number]
			>("SELECT GET_LOCK(?, 0) AS locked", [MYSQL_APPLY_LOCK]);
			if (Number(rows[0]?.locked ?? 0) !== 1) {
				throw safeDatabaseFailure(
					"Another endpoint backfill apply holds the database lock"
				);
			}
		},
		async verifyDatabaseIdentity(
			expectedFingerprint,
			expectedTrustedSignersSha256
		) {
			await assertApplyMigration();
			let rows: Array<
				{
					database_fingerprint: string;
					database_name: string;
					server_uuid: string;
					apply_user: string;
					current_database_name: string;
					current_server_uuid: string;
					current_apply_user: string;
					trusted_signers_sha256: string;
				} & RowDataPacket
			>;
			try {
				rows = await query(
					`SELECT identity.database_fingerprint, identity.database_name,
				 identity.server_uuid, identity.apply_user,
				 DATABASE() AS current_database_name,
				 @@server_uuid AS current_server_uuid,
				 CURRENT_USER() AS current_apply_user,
				 registry.trusted_signers_sha256
				 FROM model_endpoint_backfill_database_identity identity
				 CROSS JOIN model_endpoint_backfill_trust_registry registry
				 WHERE identity.singleton = 1 AND registry.singleton = 1 FOR SHARE`
				);
			} catch (error) {
				if (isMissingTableError(error, "mysql")) {
					throw new EndpointBackfillSchemaError(
						`Required apply migration is missing: ${applyMigration}`
					);
				}
				throw error;
			}
			const identity = rows[0];
			if (
				rows.length !== 1 ||
				!identity ||
				identity.database_fingerprint !== expectedFingerprint ||
				identity.database_name !== identity.current_database_name ||
				identity.server_uuid !== identity.current_server_uuid ||
				identity.apply_user !== identity.current_apply_user ||
				identity.trusted_signers_sha256 !== expectedTrustedSignersSha256
			) {
				throw safeDatabaseFailure(
					"Endpoint backfill database identity or signer trust root mismatch"
				);
			}
		},
		async databaseNow() {
			const rows = await query<{ database_now: string } & RowDataPacket>(
				"SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%dT%H:%i:%s.%fZ') AS database_now"
			);
			return checkedDatabaseDate(rows[0]?.database_now);
		},
		async findCompletedRun(idempotencyKey) {
			const rows = await query<EndpointBackfillApplyRun & RowDataPacket>(
				`SELECT idempotency_key, manifest_id, manifest_sha256, selected_manifest_sha256,
				 selection_sha256, database_fingerprint, request_sha256, execution_sha256,
				 trusted_signers_sha256, authorization_sha256, manifest_actor_id,
				 manifest_actor_key_id, evidence_reviewers_json, approved_by, approval_key_id,
				 approval_approved_at, approval_expires_at,
				 CONCAT(DATE_FORMAT(applied_at, '%Y-%m-%dT%H:%i:%s.'),
				  LPAD(FLOOR(MICROSECOND(applied_at) / 1000), 3, '0'), 'Z') AS applied_at,
				 actions_count, endpoints_count
				 FROM model_endpoint_backfill_runs WHERE idempotency_key = ?`,
				[idempotencyKey]
			);
			return rows[0] ?? null;
		},
		async loadInventory() {
			await assertApplyMigration();
			const inventory = await loadEndpointBackfillRepositoryInventoryOnce(
				txContext,
				inventoryRequest(input)
			);
			const endpointIds = input.manifest.endpoints.map(
				(endpoint) => endpoint.id
			);
			const placeholders = endpointIds.map(() => "?").join(",");
			const evidence = await query<
				{ endpoint_id: string; desired_sha256: string } & RowDataPacket
			>(
				`SELECT endpoint_id, desired_sha256 FROM (
				 SELECT endpoint_id, desired_sha256,
				 ROW_NUMBER() OVER (PARTITION BY endpoint_id ORDER BY applied_at DESC, idempotency_key DESC) AS row_number
				 FROM model_endpoint_evidence_attestations WHERE endpoint_id IN (${placeholders})
				) evidence WHERE row_number = 1`,
				endpointIds
			);
			return finalizeEndpointBackfillApplyInventory(
				inventory,
				evidence,
				input.env.SHARED_KEY_ENCRYPTION_SECRET
			);
		},
		async assertEndpointRevision(endpointId, expectedUpdatedAt) {
			if (expectedUpdatedAt === null) {
				const rows = await query<{ id: string } & RowDataPacket>(
					"SELECT id FROM model_endpoints WHERE BINARY id = BINARY ? FOR UPDATE",
					[endpointId]
				);
				if (rows.length !== 0)
					throw revisionFailure("Endpoint revision changed during apply");
				return;
			}
			const rows = await query<{ id: string } & RowDataPacket>(
				"SELECT id FROM model_endpoints WHERE BINARY id = BINARY ? AND updated_at = ? FOR UPDATE",
				[endpointId, toMySqlUtcDateTime6(expectedUpdatedAt)]
			);
			if (rows.length !== 1)
				throw revisionFailure("Endpoint revision changed during apply");
		},
		async writeDraft(desired, mode, expectedUpdatedAt) {
			if (mode === "preserve") return;
			if (mode === "create") {
				await execute(
					`INSERT INTO model_endpoints (${ENDPOINT_COLUMNS}) VALUES (${Array.from(
						{ length: 25 },
						() => "?"
					).join(",")})`,
					mysqlEndpointValues(desired, "draft")
				);
				return;
			}
			const values = mysqlEndpointValues(desired, "draft");
			const result = await execute(
				`UPDATE model_endpoints SET
				 model_id=?, provider_id=?, provider_slug=?, tag=?, endpoint_class=?, region=?,
				 context_length=?, max_prompt_tokens=?, max_completion_tokens=?, quantization=?,
				 supported_parameters=?, pricing=?, supports_implicit_caching=?, supports_voice_cloning=?,
				 supports_tool_choice=?, image_capabilities=?, audio_capabilities=?, evidence_url=?,
				 verified_by=NULL, verified_at=NULL, expires_at=?, status='draft', updated_at=?
				 WHERE BINARY id = BINARY ? AND updated_at = ?`,
				[
					...values.slice(1, 18),
					values[18],
					values[21],
					values[24],
					desired.id,
					toMySqlUtcDateTime6(expectedUpdatedAt!),
				]
			);
			if (result.affectedRows !== 1)
				throw revisionFailure("Endpoint CAS update failed");
		},
		async syncRouteBindings(endpointId, bindings, appliedAt) {
			const desiredRouteIds = bindings.map(
				(binding) => binding.route_target_id
			);
			if (desiredRouteIds.length === 0) {
				await execute(
					"DELETE FROM model_endpoint_routes WHERE BINARY endpoint_id = BINARY ?",
					[endpointId]
				);
			} else {
				await execute(
					`DELETE FROM model_endpoint_routes WHERE BINARY endpoint_id = BINARY ?
					 AND BINARY route_target_id NOT IN (${desiredRouteIds
							.map(() => "?")
							.join(",")})`,
					[endpointId, ...desiredRouteIds]
				);
			}
			for (const binding of bindings) {
				const owners = await query<{ endpoint_id: string } & RowDataPacket>(
					"SELECT endpoint_id FROM model_endpoint_routes WHERE BINARY route_target_id = BINARY ? FOR UPDATE",
					[binding.route_target_id]
				);
				if (owners[0] && owners[0].endpoint_id !== endpointId) {
					throw revisionFailure("Route ownership changed during apply");
				}
				if (owners.length === 0) {
					await execute(
						"INSERT INTO model_endpoint_routes (endpoint_id, route_target_id, subject_fingerprint, created_at) VALUES (?,?,?,?)",
						[
							endpointId,
							binding.route_target_id,
							binding.subject_fingerprint,
							toMySqlUtcDateTime6(appliedAt),
						]
					);
				} else {
					await execute(
						"UPDATE model_endpoint_routes SET subject_fingerprint=? WHERE BINARY endpoint_id=BINARY ? AND BINARY route_target_id=BINARY ?",
						[binding.subject_fingerprint, endpointId, binding.route_target_id]
					);
				}
			}
		},
		async publish(desired) {
			const result = await execute(
				`UPDATE model_endpoints SET evidence_url=?, verified_by=?, verified_at=?,
				 expires_at=?, status='verified', updated_at=? WHERE BINARY id=BINARY ?`,
				[
					desired.evidence_url,
					desired.verified_by,
					toMySqlUtcDateTime6(desired.verified_at!),
					toMySqlUtcDateTime6(desired.expires_at!),
					toMySqlUtcDateTime6(desired.updated_at),
					desired.id,
				]
			);
			if (result.affectedRows !== 1)
				throw safeDatabaseFailure("Endpoint publish failed");
		},
		async insertRun(run) {
			await execute(
				`INSERT INTO model_endpoint_backfill_runs
				 (idempotency_key, manifest_id, manifest_sha256, selected_manifest_sha256,
				 selection_sha256, database_fingerprint, request_sha256, execution_sha256,
				 trusted_signers_sha256, authorization_sha256, manifest_actor_id,
				 manifest_actor_key_id, evidence_reviewers_json, approved_by, approval_key_id,
				 approval_approved_at, approval_expires_at, applied_at, actions_count, endpoints_count)
				 VALUES (${Array.from({ length: 20 }, () => "?").join(",")})`,
				[
					run.idempotency_key,
					run.manifest_id,
					run.manifest_sha256,
					run.selected_manifest_sha256,
					run.selection_sha256,
					run.database_fingerprint,
					run.request_sha256,
					run.execution_sha256,
					run.trusted_signers_sha256,
					run.authorization_sha256,
					run.manifest_actor_id,
					run.manifest_actor_key_id,
					run.evidence_reviewers_json,
					run.approved_by,
					run.approval_key_id,
					run.approval_approved_at,
					run.approval_expires_at,
					toMySqlUtcDateTime6(run.applied_at),
					run.actions_count,
					run.endpoints_count,
				]
			);
		},
		async insertAttestation(attestation) {
			await execute(
				`INSERT INTO model_endpoint_evidence_attestations
				 (idempotency_key, endpoint_id, desired_sha256, before_sha256,
				 verification_state_sha256, evidence_sha256, evidence_url,
				 evidence_observed_at, evidence_expires_at, evidence_reviewed_by,
				 evidence_reviewer_key_id, manifest_actor_id, approved_by, applied_at)
				 VALUES (${Array.from({ length: 14 }, () => "?").join(",")})`,
				[
					attestation.idempotency_key,
					attestation.endpoint_id,
					attestation.desired_sha256,
					attestation.before_sha256,
					attestation.verification_state_sha256,
					attestation.evidence_sha256,
					attestation.evidence_url,
					toMySqlUtcDateTime6(attestation.evidence_observed_at),
					toMySqlUtcDateTime6(attestation.evidence_expires_at),
					attestation.evidence_reviewed_by,
					attestation.evidence_reviewer_key_id,
					attestation.manifest_actor_id,
					attestation.approved_by,
					toMySqlUtcDateTime6(attestation.applied_at),
				]
			);
		},
	};
}

export function createEndpointBackfillApplyStore(
	input: EndpointBackfillApplyStoreRequest,
	dependencies: EndpointBackfillApplyStoreDependencies = DEFAULT_APPLY_STORE_DEPENDENCIES
): EndpointBackfillApplyStore {
	return {
		async serializableTransaction<T>(
			work: (transaction: EndpointBackfillApplyTransaction) => Promise<T>
		): Promise<T> {
			const connectionString = input.env.DATABASE_URL?.trim();
			if (!connectionString) {
				throw safeDatabaseFailure(
					"DATABASE_URL is required for endpoint backfill apply"
				);
			}
			if (input.driver === "postgres") {
				let context: StorageContext | null = null;
				try {
					context = await dependencies.createPostgresStorageContext(
						connectionString,
						{
							max: 1,
							prepare: true,
							connection: {
								application_name: "cinatoken-endpoint-backfill-apply",
							},
						}
					);
					if (context.client.driver !== "postgres")
						throw new TypeError("driver mismatch");
					const result = await context.client.raw.begin(async (raw) => {
						await raw.unsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
						return work(postgresTransaction(context!, input, raw));
					});
					return result as T;
				} catch (error) {
					if (
						error instanceof EndpointBackfillApplyError ||
						error instanceof EndpointBackfillDatabaseError ||
						error instanceof EndpointBackfillRevisionError ||
						error instanceof EndpointBackfillSchemaError
					)
						throw error;
					throw safeDatabaseFailure(
						"PostgreSQL endpoint backfill transaction did not complete cleanly"
					);
				} finally {
					if (context?.client.driver === "postgres") {
						await context.client.raw.end({ timeout: 5 }).catch(() => undefined);
					}
				}
			}

			let context: StorageContext | null = null;
			let connection: any = null;
			let lockHeld = false;
			try {
				context = await dependencies.createMySqlStorageContext(
					connectionString,
					{
						connectionLimit: 1,
						maxIdle: 1,
						multipleStatements: false,
						timezone: "Z",
					}
				);
				if (context.client.driver !== "mysql")
					throw new TypeError("driver mismatch");
				connection = await context.client.raw.getConnection();
				await connection.query("SET SESSION time_zone = '+00:00'");
				const [timeZoneRows] = await connection.query(
					"SELECT @@SESSION.time_zone AS time_zone"
				);
				if (String(timeZoneRows?.[0]?.time_zone ?? "") !== "+00:00") {
					throw safeDatabaseFailure(
						"MySQL endpoint backfill requires a UTC session"
					);
				}
				await connection.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
				await connection.beginTransaction();
				const transaction = mysqlTransaction(input, connection);
				const originalAcquire = transaction.acquireLock.bind(transaction);
				transaction.acquireLock = async () => {
					await originalAcquire();
					lockHeld = true;
				};
				const result = await work(transaction);
				await connection.commit();
				return result;
			} catch (error) {
				await connection?.rollback().catch(() => undefined);
				if (
					error instanceof EndpointBackfillApplyError ||
					error instanceof EndpointBackfillDatabaseError ||
					error instanceof EndpointBackfillRevisionError ||
					error instanceof EndpointBackfillSchemaError
				)
					throw error;
				throw safeDatabaseFailure(
					"MySQL endpoint backfill transaction did not complete cleanly"
				);
			} finally {
				if (lockHeld) {
					await connection
						?.query("SELECT RELEASE_LOCK(?)", [MYSQL_APPLY_LOCK])
						.catch(() => undefined);
				}
				connection?.release();
				if (context?.client.driver === "mysql")
					await context.client.raw.end().catch(() => undefined);
			}
		},
	};
}
