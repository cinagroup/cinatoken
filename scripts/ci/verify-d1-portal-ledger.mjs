import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDirectory = join(root, 'packages/core/migrations-d1');
const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys = ON');

const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
assert.equal(
	migrationFiles.at(-1),
	'0055_generation_metadata_snapshots.sql',
	'D1 migration chain must end with the Generation metadata snapshot migration',
);

for (const file of migrationFiles) {
	const sql = readFileSync(join(migrationsDirectory, file), 'utf8');
	assert.doesNotMatch(
		sql,
		/\bSELECT\s+CASE\b/iu,
		`${file} contains an unparenthesized SELECT CASE that Wrangler can misparse inside a trigger`,
	);
	if (file === '0042_workspaces.sql') {
		database.prepare('INSERT INTO users (id, email) VALUES (?, ?), (?, ?)')
			.run('user-1', 'user@example.com', 'user-2', 'two@example.com');
	}
	if (file === '0043_gateway_keys_workspace.sql') {
		database.prepare(`INSERT INTO api_keys (id, key, user_id, name)
			VALUES (?, ?, ?, ?)`).run('gateway-key-1', 'sk-workspace-backfill', 'user-1', 'Production');
	}
	database.exec(sql);
}

const requestLogColumns = new Set(
	database.prepare('PRAGMA table_info(api_key_request_logs)').all().map((row) => row.name),
);
for (const column of [
	'request_origin',
	'response_streamed',
	'data_region',
	'is_byok',
	'charged_cost_usd',
	'upstream_inference_cost_usd',
]) {
	assert.ok(requestLogColumns.has(column), `0055 did not add api_key_request_logs.${column}`);
}
const generationMigration = readFileSync(
	join(migrationsDirectory, '0055_generation_metadata_snapshots.sql'),
	'utf8',
);
assert.doesNotMatch(
	generationMigration,
	/(?:UPDATE|INSERT\s+INTO)\s+api_key_request_logs/iu,
	'D1 Generation metadata facts must not be inferred for historical request logs',
);

const gatewayKeyLimitColumns = new Set(
	database.prepare(`PRAGMA table_info('api_keys')`).all().map((row) => String(row.name)),
);
for (const column of ['limit_micros', 'limit_reset', 'include_byok_in_limit', 'limit_epoch']) {
	assert.ok(gatewayKeyLimitColumns.has(column), `0053 did not add api_keys.${column}`);
}
const guardrailBudgetTableSql = String(
	database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'guardrail_budget_reservations'`).get()?.sql ?? '',
);
assert.match(guardrailBudgetTableSql, /'lifetime'/u, '0053 must add lifetime Guardrail budget windows');
assert.match(guardrailBudgetTableSql, /limit_micros >= 0/u, '0053 must permit an explicit zero Key limit');
assert.match(guardrailBudgetTableSql, /'workspace'/u, '0054 must add the system-only Workspace budget scope');

database.prepare(`UPDATE api_keys
	SET status = 'active', limit_micros = 1000000, limit_reset = 'daily', limit_epoch = 1,
		created_at = '2026-08-31T00:00:00.000Z', updated_at = '2026-08-31T00:00:00.000Z'
	WHERE id = 'gateway-key-1'`).run();
const insertKeyLimitReservation = database.prepare(`INSERT INTO guardrail_budget_reservations (
	id, workspace_id, request_id, assignment_id, guardrail_id, guardrail_version,
	scope_type, scope_id, period, period_start, period_end,
	limit_micros, reserved_micros, settled_micros, state, expires_at, created_at, updated_at
) VALUES (?, 'personal:user-1', ?, 'gateway-key-limit:gateway-key-1',
	'gateway-key-limit:gateway-key-1', ?, 'api_key', 'gateway-key-1', ?, ?, ?, ?, ?, 0,
	'reserved', '2026-08-31T01:02:00.000Z', '2026-08-31T01:00:00.000Z', '2026-08-31T01:00:00.000Z')`);
insertKeyLimitReservation.run(
	'key-limit-reservation-1', 'key-limit-request-1', 2, 'daily',
	'2026-08-31T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1_000_000, 600_000,
);
assert.throws(
	() => insertKeyLimitReservation.run(
		'key-limit-reservation-2', 'key-limit-request-2', 2, 'daily',
		'2026-08-31T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1_000_000, 500_000,
	),
	/gateway_key_limit_exceeded/u,
	'0053 must reject concurrent reservations that exceed the current Key limit',
);
assert.throws(
	() => insertKeyLimitReservation.run(
		'key-limit-reservation-stale', 'key-limit-request-stale', 1, 'daily',
		'2026-08-31T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1_000_000, 1,
	),
	/gateway_key_limit_stale/u,
	'0053 must reject a reservation evaluated against an old Key limit epoch',
);

assert.ok(
	database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get('workspace_budgets'),
	'0054 did not create workspace_budgets',
);
database.prepare(`INSERT INTO workspace_budgets
	(id, workspace_id, reset_interval, limit_micros, created_at, updated_at)
	VALUES (?, 'personal:user-1', 'daily', 1000000, ?, ?),
		(?, 'personal:user-1', 'monthly', 3000000, ?, ?)`).run(
	'workspace-budget-daily', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
	'workspace-budget-monthly', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
);
assert.throws(
	() => database.prepare(`INSERT INTO workspace_budgets
		(id, workspace_id, reset_interval, limit_micros)
		VALUES ('workspace-budget-weekly-invalid', 'personal:user-1', 'weekly', 500000)`).run(),
	/workspace_budget_order_invalid/u,
	'0054 must enforce strict lifetime > monthly > weekly > daily ordering',
);
const insertWorkspaceReservation = database.prepare(`INSERT INTO guardrail_budget_reservations (
	id, workspace_id, request_id, assignment_id, guardrail_id, guardrail_version,
	scope_type, scope_id, period, period_start, period_end,
	limit_micros, reserved_micros, settled_micros, state, expires_at, created_at, updated_at
) VALUES (?, 'personal:user-1', ?, 'workspace-budget:workspace-budget-daily',
	'workspace-budget:workspace-budget-daily', ?, 'workspace', 'personal:user-1', 'daily',
	'2026-08-31T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?, ?, 0,
	'reserved', '2026-08-31T02:02:00.000Z', '2026-08-31T02:00:00.000Z', '2026-08-31T02:00:00.000Z')`);
insertWorkspaceReservation.run('workspace-reservation-1', 'workspace-request-1', 1, 1_000_000, 700_000);
assert.throws(
	() => insertWorkspaceReservation.run('workspace-reservation-2', 'workspace-request-2', 1, 1_000_000, 400_000),
	/workspace_budget_exceeded/u,
	'0054 must reject concurrent reservations that exceed a Workspace budget',
);
database.prepare(`UPDATE workspace_budgets SET limit_micros = 1100000, config_epoch = 1
	WHERE id = 'workspace-budget-daily'`).run();
assert.throws(
	() => insertWorkspaceReservation.run('workspace-reservation-stale', 'workspace-request-stale', 1, 1_100_000, 1),
	/workspace_budget_stale/u,
	'0054 must reject an admission evaluated against an old Workspace budget epoch',
);

assert.ok(
	database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get('management_api_keys'),
	'0051 did not create management_api_keys',
);
const managementKeyColumns = new Set(
	database.prepare(`PRAGMA table_info('management_api_keys')`).all().map((row) => String(row.name)),
);
assert.ok(managementKeyColumns.has('key_hash'), '0051 must persist a Management Key lookup hash');
for (const forbiddenPlaintextColumn of ['key', 'secret', 'api_key']) {
	assert.ok(
		!managementKeyColumns.has(forbiddenPlaintextColumn),
		`0051 must not persist Management Key plaintext in ${forbiddenPlaintextColumn}`,
	);
}
database.prepare(`INSERT INTO management_api_keys
	(id, key_hash, key_preview, account_type, personal_owner_user_id, name, created_by_user_id)
	VALUES (?, ?, ?, 'personal', ?, ?, ?)`).run(
	'management-key-1',
	`sha256:${'a'.repeat(64)}`,
	'sk-cina-mgmt-…aaaa',
	'user-1',
	'Production automation',
	'user-1',
);
assert.deepEqual(
	{ ...database.prepare(`SELECT account_type, personal_owner_user_id, organization_id, status
		FROM management_api_keys WHERE id = ?`).get('management-key-1') },
	{
		account_type: 'personal',
		personal_owner_user_id: 'user-1',
		organization_id: null,
		status: 'active',
	},
	'0051 must preserve a single account owner and active lifecycle state',
);
assert.throws(
	() => database.prepare(`INSERT INTO management_api_keys
		(id, key_hash, key_preview, account_type, personal_owner_user_id, name)
		VALUES (?, ?, ?, 'personal', ?, ?)`).run(
		'management-key-invalid-hash',
		`sha256:${'A'.repeat(64)}`,
		'sk-cina-mgmt-…AAAA',
		'user-1',
		'Invalid hash',
	),
	/CHECK constraint failed/u,
	'0051 must reject a non-canonical Management Key lookup hash',
);
assert.throws(
	() => database.prepare(`INSERT INTO management_api_keys
		(id, key_hash, key_preview, account_type, personal_owner_user_id, name)
		VALUES (?, ?, ?, 'organization', ?, ?)`).run(
		'management-key-invalid-owner',
		`sha256:${'b'.repeat(64)}`,
		'sk-cina-mgmt-…bbbb',
		'user-1',
		'Invalid owner',
	),
	/CHECK constraint failed/u,
	'0051 must reject an account_type/owner mismatch',
);
for (const indexName of [
	'idx_management_api_keys_personal_created',
	'idx_management_api_keys_organization_created',
	'idx_management_api_keys_status_expiry',
]) {
	assert.ok(
		database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName),
		`0051 did not create ${indexName}`,
	);
}

const gatewayKeyColumns = new Set(
	database.prepare(`PRAGMA table_info('api_keys')`).all().map((row) => String(row.name)),
);
assert.ok(gatewayKeyColumns.has('expires_at'), '0052 did not add api_keys.expires_at');
assert.ok(
	database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
		.get('idx_api_keys_status_expiry'),
	'0052 did not create idx_api_keys_status_expiry',
);
database.prepare(`UPDATE api_keys SET expires_at = ? WHERE id = ?`)
	.run('2099-01-01T00:00:00.000Z', 'gateway-key-1');
assert.throws(
	() => database.prepare(`UPDATE api_keys SET expires_at = ? WHERE id = ?`)
		.run('2099-01-01 00:00:00', 'gateway-key-1'),
	/CHECK constraint failed/u,
	'0052 must reject non-canonical Gateway Key expiry timestamps',
);

const routeDataPolicyColumns = new Set(
	database.prepare(`PRAGMA table_info('route_data_policies')`).all().map((row) => String(row.name)),
);
for (const column of ['subject_fingerprint', 'invalidated_at', 'invalidation_reason']) {
	assert.ok(routeDataPolicyColumns.has(column), `0046 did not add route_data_policies.${column}`);
}

for (const endpointTable of ['model_endpoints', 'model_endpoint_routes']) {
	assert.ok(
		database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
			.get(endpointTable),
		`0047 did not create ${endpointTable}`,
	);
}
const endpointRouteColumns = new Set(
	database.prepare(`PRAGMA table_info('model_endpoint_routes')`).all().map((row) => String(row.name)),
);
assert.ok(
	endpointRouteColumns.has('subject_fingerprint'),
	'0048 did not add model_endpoint_routes.subject_fingerprint',
);
assert.doesNotMatch(
	readFileSync(
		join(migrationsDirectory, '0048_model_endpoint_route_subject_fingerprint.sql'),
		'utf8',
	),
	/UPDATE\s+model_endpoint_routes/iu,
	'legacy endpoint-route links must remain NULL until explicitly re-verified',
);
assert.doesNotMatch(
	readFileSync(
		join(migrationsDirectory, '0049_model_endpoint_audio_capabilities.sql'),
		'utf8',
	),
	/UPDATE\s+model_endpoints/iu,
	'legacy endpoint audio pricing must remain unknown instead of being inferred',
);
database.prepare(`INSERT INTO providers (id, name, api_key)
	VALUES (?, ?, ?)`).run('endpoint-provider', 'Endpoint Provider', 'endpoint-secret');
database.prepare(`INSERT INTO models (id, display_name)
	VALUES (?, ?)`).run('endpoint-model', 'Endpoint Model');
database.prepare(`INSERT INTO model_routes
	(id, model_id, provider_id, provider_model_name)
	VALUES (?, ?, ?, ?), (?, ?, ?, ?)`).run(
	'endpoint-route-1', 'endpoint-model', 'endpoint-provider', 'upstream-model',
	'endpoint-route-2', 'endpoint-model', 'endpoint-provider', 'upstream-model',
);
database.prepare(`INSERT INTO model_endpoints
	(id, model_id, provider_id, provider_slug, tag)
	VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`).run(
	'endpoint-1', 'endpoint-model', 'endpoint-provider', 'endpoint-provider', 'standard',
	'endpoint-2', 'endpoint-model', 'endpoint-provider', 'endpoint-provider', 'service-tier',
);
assert.deepEqual(
	{ ...database.prepare(`SELECT supported_parameters, pricing, supports_tool_choice,
		image_capabilities, audio_capabilities, supports_implicit_caching, supports_voice_cloning, status
		FROM model_endpoints WHERE id = ?`).get('endpoint-1') },
	{
		supported_parameters: '[]',
		pricing: '{}',
		supports_tool_choice: '{"auto":null,"function":null,"none":null,"required":null}',
		image_capabilities: '{}',
		audio_capabilities: '{}',
		supports_implicit_caching: null,
		supports_voice_cloning: null,
		status: 'draft',
	},
	'0049 must preserve unknown audio evidence alongside the existing JSON defaults',
);
assert.throws(
	() => database.prepare(`INSERT INTO model_endpoints
		(id, model_id, provider_id, provider_slug, tag)
		VALUES (?, ?, ?, ?, ?)`).run(
		'endpoint-duplicate', 'endpoint-model', 'endpoint-provider', 'other-public-slug', 'standard',
	),
	/UNIQUE constraint failed/u,
	'0047 must enforce the logical (model_id, provider_id, tag) endpoint identity',
);
assert.throws(
	() => database.prepare(`INSERT INTO model_endpoints
		(id, model_id, provider_id, provider_slug, tag, supports_implicit_caching)
		VALUES (?, ?, ?, ?, ?, ?)`).run(
		'endpoint-invalid-bool', 'endpoint-model', 'endpoint-provider', 'endpoint-provider', 'invalid-bool', 2,
	),
	/CHECK constraint failed/u,
	'0047 must reject non-boolean endpoint capability evidence while allowing NULL=unknown',
);
assert.throws(
	() => database.prepare(`INSERT INTO model_endpoints
		(id, model_id, provider_id, provider_slug, tag, status)
		VALUES (?, ?, ?, ?, ?, ?)`).run(
		'endpoint-invalid-status', 'endpoint-model', 'endpoint-provider', 'endpoint-provider', 'invalid-status', 'active',
	),
	/CHECK constraint failed/u,
	'0047 must reject endpoint states outside draft/verified/disabled',
);
database.prepare(`INSERT INTO model_endpoint_routes (endpoint_id, route_target_id)
	VALUES (?, ?)`).run('endpoint-1', 'endpoint-route-1');
assert.equal(
	database.prepare(`SELECT subject_fingerprint FROM model_endpoint_routes
		WHERE route_target_id = ?`).get('endpoint-route-1').subject_fingerprint,
	null,
	'0048 must leave a newly linked route unverified by default',
);
database.prepare(`UPDATE model_endpoint_routes SET subject_fingerprint = ?
	WHERE route_target_id = ?`).run('a'.repeat(64), 'endpoint-route-1');
for (const invalidFingerprint of ['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}g`]) {
	assert.throws(
		() => database.prepare(`UPDATE model_endpoint_routes SET subject_fingerprint = ?
			WHERE route_target_id = ?`).run(invalidFingerprint, 'endpoint-route-1'),
		/CHECK constraint failed/u,
		'0048 must accept only a 64-character lowercase hexadecimal subject fingerprint',
	);
}
assert.throws(
	() => database.prepare(`INSERT INTO model_endpoint_routes (endpoint_id, route_target_id)
		VALUES (?, ?)`).run('endpoint-2', 'endpoint-route-1'),
	/UNIQUE constraint failed/u,
	'0047 must assign each route target to at most one model endpoint',
);
database.prepare(`DELETE FROM model_endpoints WHERE id = ?`).run('endpoint-1');
assert.equal(
	database.prepare(`SELECT COUNT(*) AS count FROM model_endpoint_routes
		WHERE route_target_id = ?`).get('endpoint-route-1').count,
	0,
	'deleting an endpoint must cascade its route link',
);
database.prepare(`INSERT INTO model_endpoint_routes (endpoint_id, route_target_id)
	VALUES (?, ?)`).run('endpoint-2', 'endpoint-route-2');
database.prepare(`DELETE FROM model_routes WHERE id = ?`).run('endpoint-route-2');
assert.equal(
	database.prepare(`SELECT COUNT(*) AS count FROM model_endpoint_routes
		WHERE route_target_id = ?`).get('endpoint-route-2').count,
	0,
	'deleting a route target must cascade its endpoint link',
);

for (const ledgerTable of [
	'model_endpoint_backfill_database_identity',
	'model_endpoint_backfill_trust_registry',
	'model_endpoint_backfill_runs',
	'model_endpoint_evidence_attestations',
]) {
	assert.ok(
		database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
			.get(ledgerTable),
		`0050 did not create ${ledgerTable}`,
	);
}
const databaseIdentity = database.prepare(`SELECT database_fingerprint
	FROM model_endpoint_backfill_database_identity WHERE singleton = 1`).get();
assert.match(
	String(databaseIdentity?.database_fingerprint ?? ''),
	/^sha256:[0-9a-f]{64}$/u,
	'0050 must persist one database-generated fingerprint',
);
assert.equal(
	database.prepare(`SELECT COUNT(*) AS count
		FROM model_endpoint_backfill_trust_registry`).get().count,
	0,
	'0050 trust registry must be empty until an explicit one-time production bootstrap',
);
database.prepare(`INSERT INTO model_endpoint_backfill_trust_registry
	(singleton, trusted_signers_sha256, initialized_by) VALUES (1, ?, ?)`)
	.run('9'.repeat(64), 'bootstrap-admin');
database.prepare(`INSERT INTO model_endpoint_backfill_runs
	(idempotency_key, manifest_id, manifest_sha256, selected_manifest_sha256,
	 selection_sha256, database_fingerprint, request_sha256, execution_sha256,
	 authorization_sha256, trusted_signers_sha256, manifest_actor_id, manifest_actor_key_id,
	 evidence_reviewers_json, approved_by, approval_key_id, approval_approved_at,
	 approval_expires_at, applied_at, actions_count, endpoints_count)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
	'a'.repeat(64), 'manifest-1', 'b'.repeat(64), 'c'.repeat(64),
	'd'.repeat(64), String(databaseIdentity.database_fingerprint), 'f'.repeat(64), '0'.repeat(64),
	'1'.repeat(64), '9'.repeat(64), 'actor-1', `sha256:${'2'.repeat(64)}`,
	'[{"endpoint_ids":["endpoint-2"],"key_id":"sha256:3333333333333333333333333333333333333333333333333333333333333333","principal":"reviewer-1"}]',
	'approver-1', `sha256:${'4'.repeat(64)}`, '2026-08-30T00:00:00.000Z',
	'2026-09-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z', 1, 1,
);
database.prepare(`INSERT INTO model_endpoint_evidence_attestations
	(idempotency_key, endpoint_id, desired_sha256, before_sha256,
	 verification_state_sha256, evidence_sha256, evidence_url,
	 evidence_observed_at, evidence_expires_at, evidence_reviewed_by,
	 evidence_reviewer_key_id, manifest_actor_id, approved_by, applied_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
	'a'.repeat(64), 'endpoint-2', '1'.repeat(64), null,
	'2'.repeat(64), '3'.repeat(64), 'https://evidence.example/endpoint-2',
	'2026-08-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z', 'reviewer-1',
	`sha256:${'3'.repeat(64)}`, 'actor-1', 'approver-1', '2026-08-31T00:00:00.000Z',
);
for (const mutation of [
	() => database.prepare(`UPDATE model_endpoint_backfill_database_identity
		SET database_fingerprint = ? WHERE singleton = 1`).run(`sha256:${'0'.repeat(64)}`),
	() => database.prepare(`DELETE FROM model_endpoint_backfill_database_identity
		WHERE singleton = 1`).run(),
	() => database.prepare(`UPDATE model_endpoint_backfill_trust_registry
		SET trusted_signers_sha256 = ? WHERE singleton = 1`).run('8'.repeat(64)),
	() => database.prepare(`DELETE FROM model_endpoint_backfill_trust_registry
		WHERE singleton = 1`).run(),
	() => database.prepare(`UPDATE model_endpoint_backfill_runs
		SET actions_count = 2 WHERE idempotency_key = ?`).run('a'.repeat(64)),
	() => database.prepare(`DELETE FROM model_endpoint_backfill_runs
		WHERE idempotency_key = ?`).run('a'.repeat(64)),
	() => database.prepare(`UPDATE model_endpoint_evidence_attestations
		SET desired_sha256 = ? WHERE idempotency_key = ? AND endpoint_id = ?`)
		.run('4'.repeat(64), 'a'.repeat(64), 'endpoint-2'),
	() => database.prepare(`DELETE FROM model_endpoint_evidence_attestations
		WHERE idempotency_key = ? AND endpoint_id = ?`)
		.run('a'.repeat(64), 'endpoint-2'),
]) {
	assert.throws(
		mutation,
		/append-only|immutable/u,
		'0050 identity and evidence ledgers must reject UPDATE and DELETE',
	);
}
assert.throws(
	() => database.prepare('DELETE FROM model_endpoints WHERE id = ?').run('endpoint-2'),
	/FOREIGN KEY constraint failed/u,
	'0050 evidence attestations must retain their referenced endpoint',
);

const userColumns = new Set(
	database.prepare(`PRAGMA table_info('users')`).all().map((row) => String(row.name)),
);
assert.ok(userColumns.has('budget_epoch'), '0040 did not add users.budget_epoch');
assert.ok(
	userColumns.has('budget_reserved_micros'),
	'0040 did not add users.budget_reserved_micros',
);
assert.ok(
	userColumns.has('budget_spent_micros'),
	'0041 did not add authoritative users.budget_spent_micros',
);
assert.ok(
	database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get('user_budget_reservations'),
	'0040 did not create user_budget_reservations',
);
for (const workspaceTable of ['workspaces', 'workspace_memberships']) {
	assert.ok(
		database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
			.get(workspaceTable),
		`0042 did not create ${workspaceTable}`,
	);
}
const userBudgetTriggers = new Set(
	database.prepare(`SELECT name FROM sqlite_master
		WHERE type = 'trigger' AND tbl_name = 'user_budget_reservations'`).all()
		.map((row) => String(row.name)),
);
assert.deepEqual(userBudgetTriggers, new Set([
	'trg_user_budget_reservation_capacity',
	'trg_user_budget_reservation_insert_counter',
	'trg_user_budget_reservation_transition',
	'trg_user_budget_reservation_terminal',
	'trg_user_budget_reservation_late_actual',
]));

assert.deepEqual(
	{ ...database.prepare(`SELECT id, scope_type, personal_owner_user_id, default_scope_key
		FROM workspaces WHERE id = ?`).get('personal:user-1') },
	{
		id: 'personal:user-1',
		scope_type: 'personal',
		personal_owner_user_id: 'user-1',
		default_scope_key: 'personal:user-1',
	},
	'0042 must deterministically backfill a personal Default workspace',
);
const apiKeyColumns = new Set(
	database.prepare(`PRAGMA table_info('api_keys')`).all().map((row) => String(row.name)),
);
const routeColumns = new Set(
	database.prepare(`PRAGMA table_info('model_routes')`).all().map((row) => String(row.name)),
);
assert.ok(routeColumns.has('routing_metadata'), '0045 did not add model_routes.routing_metadata');
assert.ok(apiKeyColumns.has('workspace_id'), '0043 did not add api_keys.workspace_id');
assert.equal(
	database.prepare(`SELECT workspace_id FROM api_keys WHERE id = ?`).get('gateway-key-1').workspace_id,
	'personal:user-1',
	'0043 must deterministically backfill an existing key into the personal Default workspace',
);
for (const indexName of ['idx_api_keys_workspace_created', 'idx_api_keys_workspace_user_created']) {
	assert.ok(
		database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName),
		`0043 did not create ${indexName}`,
	);
}
for (const scopedTable of [
	'request_presets',
	'guardrails',
	'guardrail_assignments',
	'guardrail_budget_windows',
	'guardrail_budget_reservations',
]) {
	const columns = new Set(
		database.prepare(`PRAGMA table_info('${scopedTable}')`).all().map((row) => String(row.name)),
	);
	assert.ok(columns.has('workspace_id'), `0044 did not scope ${scopedTable} by workspace_id`);
}
database.prepare(`INSERT INTO request_presets
	(id, workspace_id, owner_user_id, slug, name, visibility, status)
	VALUES (?, ?, ?, ?, ?, 'private', 'active'), (?, ?, ?, ?, ?, 'private', 'active')`).run(
	'preset-workspace-1', 'personal:user-1', 'user-1', 'same-slug', 'One',
	'preset-workspace-2', 'personal:user-2', 'user-2', 'same-slug', 'Two',
);
assert.equal(
	database.prepare(`SELECT COUNT(*) AS count FROM request_presets WHERE slug = 'same-slug'`).get().count,
	2,
	'0044 must allow the same Preset slug in different Workspaces',
);
assert.throws(
	() => database.prepare(`INSERT INTO request_presets
		(id, workspace_id, owner_user_id, slug, name, visibility, status)
		VALUES (?, ?, ?, ?, ?, 'private', 'active')`).run(
		'preset-workspace-duplicate', 'personal:user-1', 'user-1', 'same-slug', 'Duplicate',
	),
	/UNIQUE constraint failed/u,
	'0044 must keep Preset slugs unique within a Workspace',
);
database.prepare(`INSERT INTO guardrails
	(id, workspace_id, owner_user_id, name, status)
	VALUES (?, ?, ?, ?, 'active'), (?, ?, ?, ?, 'active')`).run(
	'guardrail-workspace-1', 'personal:user-1', 'user-1', 'One',
	'guardrail-workspace-2', 'personal:user-2', 'user-2', 'Two',
);
database.prepare(`INSERT INTO guardrail_assignments
	(id, workspace_id, guardrail_id, scope_type, scope_id)
	VALUES (?, ?, ?, 'user', ?), (?, ?, ?, 'user', ?)`).run(
	'assignment-workspace-1', 'personal:user-1', 'guardrail-workspace-1', 'shared-subject',
	'assignment-workspace-2', 'personal:user-2', 'guardrail-workspace-2', 'shared-subject',
);
assert.throws(
	() => database.prepare(`INSERT INTO guardrail_assignments
		(id, workspace_id, guardrail_id, scope_type, scope_id)
		VALUES (?, ?, ?, 'user', ?)`).run(
		'assignment-cross-workspace', 'personal:user-2', 'guardrail-workspace-1', 'other-subject',
	),
	/FOREIGN KEY constraint failed/u,
	'0044 must reject a Guardrail assignment that crosses Workspace ownership',
);
assert.throws(
	() => database.prepare(`INSERT INTO api_keys (id, key, user_id, workspace_id)
		VALUES (?, ?, ?, NULL)`).run('gateway-key-without-workspace', 'sk-invalid', 'user-1'),
	/api_keys\.workspace_id is required/u,
	'0043 must reject a Gateway Key without a Workspace',
);
database.exec(`UPDATE users SET budget_spent_micros = 8589934592000001 WHERE id = 'user-1'`);
assert.equal(
	database.prepare(`SELECT CAST(budget_spent_micros AS TEXT) AS value FROM users WHERE id = 'user-1'`).get().value,
	'8589934592000001',
	'0041 authoritative INTEGER must preserve a one-micro amount that budget_spent REAL cannot represent',
);
database.prepare('INSERT INTO user_earnings (user_id) VALUES (?)').run('user-1');
database.prepare(`INSERT INTO shared_keys
  (id, seller_user_id, channel_type, api_key, key_fingerprint, status)
  VALUES (?, ?, ?, ?, ?, ?)`)
	.run('key-1', 'user-1', 'openai', 'encrypted', 'fingerprint', 'active');
database.prepare(`INSERT INTO api_key_request_logs
  (id, user_id, api_key_id, workspace_id) VALUES (?, ?, ?, ?)`)
	.run('request-1', 'user-1', 'gateway-key-1', 'personal:user-1');

const insertEarning = database.prepare(`INSERT OR IGNORE INTO shared_key_earnings
  (id, request_log_id, shared_key_id, seller_user_id, gross_amount, net_amount)
  VALUES (?, ?, ?, ?, ?, ?)`);
insertEarning.run('earning-1', 'request-1', 'key-1', 'user-1', 1.234567, 1.234567);
insertEarning.run('earning-duplicate', 'request-1', 'key-1', 'user-1', 1.234567, 1.234567);

const earnings = database.prepare(`SELECT balance_micros, lifetime_earned_micros,
  contribution_value_micros FROM user_earnings WHERE user_id = ?`).get('user-1');
assert.deepEqual(
	[earnings.balance_micros, earnings.lifetime_earned_micros, earnings.contribution_value_micros],
	[1_234_567, 1_234_567, 1_234_567],
);

database.prepare(`INSERT INTO withdrawals
  (id, user_id, amount, fee, net_amount, wallet_address, token_amount,
   amount_micros, fee_micros, net_amount_micros, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	.run(
		'withdrawal-1', 'user-1', 1, 0.1, 0.9,
		'0x0000000000000000000000000000000000000001', 0.9,
		1_000_000, 100_000, 900_000,
		'2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z',
	);
const locked = database.prepare(`SELECT balance_micros, locked_amount_micros
  FROM user_earnings WHERE user_id = ?`).get('user-1');
assert.deepEqual([locked.balance_micros, locked.locked_amount_micros], [234_567, 1_000_000]);

assert.throws(
	() => database.exec(`INSERT INTO withdrawals
	  (id, user_id, amount, net_amount, wallet_address, amount_micros,
	   net_amount_micros, created_at, updated_at)
	  VALUES ('withdrawal-2', 'user-1', 0.1, 0.1,
	          '0x0000000000000000000000000000000000000001',
	          100000, 100000, datetime('now'), datetime('now'))`),
	/active_withdrawal_exists/,
);

database.prepare(`UPDATE withdrawals SET status = 'confirmed', confirmed_at = ?, updated_at = ?
  WHERE id = ? AND status = 'requested'`)
	.run('2026-08-24T00:01:00.000Z', '2026-08-24T00:01:00.000Z', 'withdrawal-1');
const settled = database.prepare(`SELECT balance_micros, locked_amount_micros,
  lifetime_withdrawn_micros FROM user_earnings WHERE user_id = ?`).get('user-1');
assert.deepEqual(
	[settled.balance_micros, settled.locked_amount_micros, settled.lifetime_withdrawn_micros],
	[234_567, 0, 1_000_000],
);

const ledger = database.prepare(`SELECT kind, amount_micros
  FROM portal_ledger_entries ORDER BY kind`).all();
assert.deepEqual(
	ledger.map((row) => [row.kind, row.amount_micros]),
	[
		['shared_key_earning', 1_234_567],
		['withdrawal_lock', -1_000_000],
		['withdrawal_settle', -1_000_000],
	],
);

console.log('D1 migration chain and portal ledger invariants: PASS');
