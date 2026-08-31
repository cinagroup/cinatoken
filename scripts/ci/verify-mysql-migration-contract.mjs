import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const mysqlMigrations = readdirSync(join(root, 'packages/core/migrations-mysql'))
	.filter((name) => name.endsWith('.sql'))
	.sort();
assert.equal(
	mysqlMigrations.at(-1),
	'0050_workspace_budgets.sql',
	'MySQL migration chain must end with the Workspace budgets migration',
);

const budget = read('packages/core/migrations-mysql/0035_guardrail_budget_reservations.sql');
for (const contract of [
	'budget_charged_micros BIGINT',
	'CREATE TABLE guardrail_budget_windows',
	'CREATE TABLE guardrail_budget_reservations',
	'uk_guardrail_budget_reservation_request_assignment',
	'utf8mb4_0900_bin',
	'request_id VARCHAR(128)',
	'budget_accounted_effective_at DATETIME(6)',
	'unreserved_micros BIGINT',
	'seed_request_id VARCHAR(128)',
	'fk_guardrail_budget_reservation_window',
	'9007199254740991',
]) {
	assert.ok(budget.includes(contract), `0035 is missing Guardrail budget contract: ${contract}`);
}

const userBudget = read('packages/core/migrations-mysql/0037_user_budget_reservations.sql');
for (const contract of [
	'ADD COLUMN budget_epoch BIGINT NOT NULL DEFAULT 0',
	'ADD COLUMN budget_reserved_micros BIGINT NOT NULL DEFAULT 0',
	'CREATE TABLE user_budget_reservations',
	'request_id VARCHAR(128)',
	'budget_epoch BIGINT NOT NULL',
	'limit_micros BIGINT NOT NULL',
	'reserved_micros BIGINT NOT NULL',
	"CHECK (state IN ('reserved', 'dispatched', 'settled', 'released', 'expired'))",
	'idx_user_budget_reservations_expiry',
	'idx_user_budget_reservations_user_epoch',
	'utf8mb4_0900_bin',
	'9007199254740991',
]) {
	assert.ok(
		userBudget.includes(contract),
		`0037 is missing ordinary-user budget contract: ${contract}`,
	);
}

const identity = read('packages/core/migrations-mysql/0036_cinaauth_identity_binary_collation.sql');
const preflight = identity.indexOf('CREATE TEMPORARY TABLE cinaauth_identity_binary_preflight');
const foreignKeyDrop = identity.indexOf('DROP FOREIGN KEY fk_organization_memberships_org');
assert.ok(preflight >= 0 && foreignKeyDrop > preflight, 'binary identity preflight must run before dropping the organization FK');
for (const opaqueIdentifier of [
	'external_user_id',
	'portal_sessions',
	'organizations',
	'organization_id',
	'subject',
	'event_id',
	'aggregate_id',
]) {
	assert.ok(identity.includes(opaqueIdentifier), `0036 does not cover opaque identifier: ${opaqueIdentifier}`);
}
assert.doesNotMatch(identity, /LOWER\s*\(/iu, 'opaque CinaAuth identifiers must never be lowercased');
assert.match(identity, /BINARY membership\.organization_id <> BINARY organization\.id/u);

const workspaces = read('packages/core/migrations-mysql/0038_workspaces.sql');
for (const workspaceContract of [
	'CREATE TABLE workspaces',
	'CREATE TABLE workspace_memberships',
	'id VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PRIMARY KEY',
	'organization_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin',
	'membership_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE',
	'workspaces_scope_owner_chk',
	'workspaces_default_key_chk',
	'idx_workspaces_personal_status',
	'idx_workspaces_organization_status',
	'idx_workspace_memberships_workspace_status',
	'idx_workspace_memberships_subject_status',
	"CONCAT('personal:', id)",
	"CONCAT('organization:', id)",
]) {
	assert.ok(workspaces.includes(workspaceContract), `0038 is missing Workspace contract: ${workspaceContract}`);
}
assert.doesNotMatch(workspaces, /LOWER\s*\(/iu, 'opaque Workspace/CinaAuth identifiers must never be lowercased');

const gatewayKeyWorkspace = read('packages/core/migrations-mysql/0039_gateway_keys_workspace.sql');
for (const keyContract of [
	'ADD COLUMN workspace_id VARCHAR(600)',
	'COLLATE utf8mb4_0900_bin',
	"CONCAT('personal:', user_id)",
	'MODIFY COLUMN workspace_id VARCHAR(600)',
	'NOT NULL',
	'fk_api_keys_workspace',
	'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
	'idx_api_keys_workspace_created',
	'idx_api_keys_workspace_user_created',
]) {
	assert.ok(gatewayKeyWorkspace.includes(keyContract), `0039 is missing Gateway Key Workspace contract: ${keyContract}`);
}
assert.doesNotMatch(gatewayKeyWorkspace, /LOWER\s*\(/iu, 'opaque Gateway Key Workspace ids must never be lowercased');

const presetGuardrailWorkspaces = read('packages/core/migrations-mysql/0040_workspace_presets_guardrails.sql');
for (const workspaceContract of [
	'workspace_key CHAR(64)',
	'CHECK (workspace_key = SHA2(workspace_id, 256))',
	'uk_request_presets_workspace_slug (workspace_key, slug)',
	'uk_guardrail_assignments_workspace_scope',
	'guardrail assignment guardrail workspace mismatch',
	'guardrail assignment API key workspace mismatch',
	'ADD PRIMARY KEY (workspace_key, scope_type, scope_id, period, period_start)',
	'fk_guardrail_budget_reservation_window FOREIGN KEY',
]) {
	assert.ok(
		presetGuardrailWorkspaces.includes(workspaceContract),
		`0040 is missing Preset/Guardrail Workspace contract: ${workspaceContract}`,
	);
}
assert.doesNotMatch(presetGuardrailWorkspaces, /LOWER\s*\(/iu, 'opaque Preset/Guardrail Workspace ids must never be lowercased');

const routeRoutingMetadata = read('packages/core/migrations-mysql/0041_route_routing_metadata.sql');
assert.match(routeRoutingMetadata, /ALTER TABLE model_routes ADD COLUMN routing_metadata TEXT/u);

const routeDataPolicySubject = read('packages/core/migrations-mysql/0042_route_data_policy_subject_fingerprint.sql');
for (const contract of [
	'subject_fingerprint CHAR(64)',
	'invalidated_at TIMESTAMP(6)',
	'invalidation_reason VARCHAR(128)',
	"status = 'unknown'",
	'subject_fingerprint_backfill_required',
	"CONCAT('migration-0042-', UUID())",
	'route_data_policies_subject_fingerprint_chk',
]) {
	assert.ok(routeDataPolicySubject.includes(contract), `0042 is missing route data-policy subject contract: ${contract}`);
}
const routeDataPolicyRepository = read('packages/core/src/db/mysql/route-data-policies.impl.ts');
assert.match(
	routeDataPolicyRepository,
	/CONCAT\(\?, ':', SHA2\(p\.route_target_id, 256\)\)/u,
	'provider-wide invalidation audit IDs must stay bounded when route_target_id reaches VARCHAR(512)',
);

const modelEndpoints = read('packages/core/migrations-mysql/0043_model_endpoints.sql');
for (const endpointContract of [
	'CREATE TABLE model_endpoints',
	'id VARCHAR(191) NOT NULL',
	'model_id VARCHAR(512) NOT NULL',
	'provider_id VARCHAR(512) NOT NULL',
	'endpoint_identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin',
	'GENERATED ALWAYS AS',
	"CHAR_LENGTH(model_id), ':', model_id",
	"CHAR_LENGTH(provider_id), ':', provider_id",
	"CHAR_LENGTH(tag), ':', tag",
	'UNIQUE KEY uk_model_endpoints_identity (endpoint_identity_key)',
	"supported_parameters TEXT NOT NULL DEFAULT ('[]')",
	"pricing TEXT NOT NULL DEFAULT ('{}')",
	"supports_tool_choice TEXT NOT NULL DEFAULT ('{\"auto\":null,\"function\":null,\"none\":null,\"required\":null}')",
	"image_capabilities TEXT NOT NULL DEFAULT ('{}')",
	'supports_implicit_caching TINYINT(1)',
	'supports_voice_cloning TINYINT(1)',
	"CHECK (status IN ('draft', 'verified', 'disabled'))",
	'FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE',
	'FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE',
	'CREATE TABLE model_endpoint_routes',
	'endpoint_id VARCHAR(191) NOT NULL',
	'route_target_id VARCHAR(512) NOT NULL',
	'PRIMARY KEY (endpoint_id, route_target_id)',
	'UNIQUE KEY uk_model_endpoint_routes_target (route_target_id)',
	'FOREIGN KEY (endpoint_id) REFERENCES model_endpoints(id) ON DELETE CASCADE',
	'FOREIGN KEY (route_target_id) REFERENCES model_routes(id) ON DELETE CASCADE',
]) {
	assert.ok(modelEndpoints.includes(endpointContract), `0043 is missing endpoint-first contract: ${endpointContract}`);
}
assert.doesNotMatch(
	modelEndpoints,
	/UNIQUE\s+(?:KEY|INDEX)[^(]*\([^)]*(?:model_id|provider_id|tag)\s*\(\d+\)/iu,
	'MySQL endpoint identity must not use a lossy prefix unique index',
);
assert.doesNotMatch(
	modelEndpoints,
	/INSERT\s+INTO\s+model_endpoints/iu,
	'endpoint evidence must not be guessed from legacy route JSON during schema migration',
);

const endpointRouteSubject = read(
	'packages/core/migrations-mysql/0044_model_endpoint_route_subject_fingerprint.sql',
);
for (const subjectContract of [
	'ALTER TABLE model_endpoint_routes',
	'ADD COLUMN subject_fingerprint CHAR(64)',
	'CHARACTER SET ascii COLLATE ascii_bin NULL',
	'model_endpoint_routes_subject_fingerprint_chk',
	"subject_fingerprint REGEXP '^[0-9a-f]{64}$'",
]) {
	assert.ok(
		endpointRouteSubject.includes(subjectContract),
		`0044 is missing endpoint-route subject contract: ${subjectContract}`,
	);
}
assert.doesNotMatch(
	endpointRouteSubject,
	/UPDATE\s+model_endpoint_routes/iu,
	'legacy endpoint-route links must remain NULL until explicitly re-verified',
);

const endpointAudioCapabilities = read(
	'packages/core/migrations-mysql/0045_model_endpoint_audio_capabilities.sql',
);
for (const audioContract of [
	'ALTER TABLE model_endpoints',
	"ADD COLUMN audio_capabilities TEXT NOT NULL DEFAULT ('{}')",
]) {
	assert.ok(
		endpointAudioCapabilities.includes(audioContract),
		`0045 is missing endpoint audio-capabilities contract: ${audioContract}`,
	);
}
assert.doesNotMatch(
	endpointAudioCapabilities,
	/(?:UPDATE|INSERT\s+INTO)\s+model_endpoints/iu,
	'legacy endpoint audio pricing must remain unknown instead of being inferred',
);

const endpointEvidenceLedger = read(
	'packages/core/migrations-mysql/0046_model_endpoint_evidence_ledger.sql',
);
for (const ledgerContract of [
	'CREATE TABLE model_endpoint_backfill_database_identity',
	'database_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL',
	'server_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
	'apply_user VARCHAR(288) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL',
	'@@server_uuid',
	'CURRENT_USER()',
	'CREATE TABLE model_endpoint_backfill_trust_registry',
	'trusted_signers_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
	'CREATE TABLE model_endpoint_backfill_runs',
	'execution_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
	'authorization_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
	'trusted_signers_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
	'manifest_actor_key_id VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
	'evidence_reviewers_json MEDIUMTEXT NOT NULL',
	'approval_approved_at VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
	'approval_expires_at VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
	'CHECK (BINARY approval_expires_at > BINARY approval_approved_at)',
	'CREATE TABLE model_endpoint_evidence_attestations',
	'evidence_reviewer_key_id VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
	'PRIMARY KEY (idempotency_key, endpoint_id)',
	'ON DELETE RESTRICT',
	'INDEX idx_model_endpoint_evidence_latest',
	'BEFORE UPDATE ON model_endpoint_backfill_runs',
	'BEFORE UPDATE ON model_endpoint_backfill_database_identity',
	'BEFORE DELETE ON model_endpoint_backfill_database_identity',
	'BEFORE UPDATE ON model_endpoint_backfill_trust_registry',
	'BEFORE DELETE ON model_endpoint_backfill_trust_registry',
	'BEFORE DELETE ON model_endpoint_backfill_runs',
	'BEFORE UPDATE ON model_endpoint_evidence_attestations',
	'BEFORE DELETE ON model_endpoint_evidence_attestations',
	"SIGNAL SQLSTATE '45000'",
]) {
	assert.ok(
		endpointEvidenceLedger.includes(ledgerContract),
		`0046 is missing endpoint evidence-ledger contract: ${ledgerContract}`,
	);
}

const managementApiKeys = read(
	'packages/core/migrations-mysql/0047_management_api_keys.sql',
);
for (const managementKeyContract of [
	'CREATE TABLE management_api_keys',
	'key_hash VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE',
	"key_hash REGEXP '^sha256:[0-9a-f]{64}$'",
	"CHECK (account_type IN ('personal', 'organization'))",
	'FOREIGN KEY (personal_owner_user_id) REFERENCES users(id) ON DELETE CASCADE',
	'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE',
	'FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL',
	'management_api_keys_account_owner_chk',
	'INDEX idx_management_api_keys_personal_created',
	'INDEX idx_management_api_keys_organization_created',
	'INDEX idx_management_api_keys_status_expiry',
]) {
	assert.ok(
		managementApiKeys.includes(managementKeyContract),
		`0047 is missing Management API key contract: ${managementKeyContract}`,
	);
}
assert.doesNotMatch(
	managementApiKeys,
	/^\s*(?:key|secret|api_key)\s+VARCHAR\b/mu,
	'MySQL 0047 must never persist Management Key plaintext',
);

const gatewayKeyExpiry = read(
	'packages/core/migrations-mysql/0048_gateway_key_expiry.sql',
);
for (const gatewayKeyExpiryContract of [
	'ALTER TABLE api_keys ADD COLUMN expires_at DATETIME(6)',
	'CREATE INDEX idx_api_keys_status_expiry ON api_keys(status, expires_at)',
]) {
	assert.ok(
		gatewayKeyExpiry.includes(gatewayKeyExpiryContract),
		`0048 is missing Gateway Key expiry contract: ${gatewayKeyExpiryContract}`,
	);
}

const gatewayKeyLimits = read('packages/core/migrations-mysql/0049_gateway_key_limits.sql');
for (const gatewayKeyLimitContract of [
	'ADD COLUMN limit_micros BIGINT NULL',
	'ADD COLUMN limit_reset VARCHAR(16) NULL',
	'ADD COLUMN include_byok_in_limit TINYINT NOT NULL DEFAULT 0',
	"CHECK (period IN ('daily', 'weekly', 'monthly', 'lifetime'))",
	'limit_micros >= 0 AND reserved_micros > 0',
]) {
	assert.ok(
		gatewayKeyLimits.includes(gatewayKeyLimitContract),
		`0049 is missing Gateway Key limit contract: ${gatewayKeyLimitContract}`,
	);
}

const workspaceBudgets = read('packages/core/migrations-mysql/0050_workspace_budgets.sql');
for (const workspaceBudgetContract of [
	'CREATE TABLE workspace_budgets',
	"CHECK (reset_interval IN ('daily', 'weekly', 'monthly', 'lifetime'))",
	'UNIQUE INDEX uk_workspace_budgets_interval (workspace_id, reset_interval)',
	"scope_type IN ('user', 'api_key', 'workspace')",
	'DROP CHECK guardrail_budget_windows_scope_chk',
	'DROP CHECK guardrail_budget_reservations_scope_chk',
]) {
	assert.ok(
		workspaceBudgets.includes(workspaceBudgetContract),
		`0050 is missing Workspace budget contract: ${workspaceBudgetContract}`,
	);
}

console.log('MySQL Guardrail/user/Workspace budget, identity, routing, data-policy, and endpoint-first contract: PASS');
