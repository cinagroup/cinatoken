import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	buildPostgresRecoveryRoleSql,
	POSTGRES_RECOVERY_ROLE,
	RECOVERY_FUNCTION_GRANTS,
	RECOVERY_TABLE_GRANTS,
	REQUIRED_TRIGGERS,
	validatePostgresRecoveryRolePolicy,
} from './postgres-recovery-role-policy';
import type { RecoveryOriginBudgetSnapshot } from './postgres-recovery-origin-budget';

const NOW = Date.parse('2026-09-23T10:00:00.000Z');

function facts(): RecoveryOriginBudgetSnapshot {
	return {
		schemaVersion: 1,
		capturedAt: new Date(NOW - 60_000).toISOString(),
		instance: {
			id: 'isolated_pg17', serverVersionNum: 170006, maxConnections: 50,
			superuserReservedConnections: 3, reservedConnections: 2,
			observedClientConnections: 12, observedClientConnectionsScope: 'all_databases',
			nonHyperdriveConnectionBudget: 5, safetyHeadroomConnections: 3,
		},
		inventory: {
			complete: true, scope: 'all_hyperdrives_on_instance', instanceId: 'isolated_pg17',
			origins: [
				{ id: 'cinaauth', instanceId: 'isolated_pg17', roleName: 'cinaauth_runtime', originConnectionLimit: 15 },
				{ id: 'gateway_runtime', instanceId: 'isolated_pg17', roleName: 'cinatoken_gateway_runtime', originConnectionLimit: 5 },
				{ id: 'gateway_migrator', instanceId: 'isolated_pg17', roleName: 'cinatoken_gateway_migrator', originConnectionLimit: 5 },
			],
		},
		recovery: {
			role: {
				name: POSTGRES_RECOVERY_ROLE, login: false, connectionLimit: 2,
				timeoutDefaults: { transactionMs: 30_000, statementMs: 15_000, lockMs: 5_000, idleInTransactionMs: 10_000 },
			},
			hyperdrive: { id: 'gateway_recovery', instanceId: 'isolated_pg17', originConnectionLimit: 5 },
			peakConnectionsNeeded: 2, runBudgetMs: 60_000,
		},
	};
}

function policy(input: RecoveryOriginBudgetSnapshot = facts()) {
	return { originBudgetFacts: input, nowMs: NOW };
}

test('role plan requires a fresh complete origin budget and PostgreSQL 17 or later', () => {
	assert.throws(() => buildPostgresRecoveryRoleSql({ originBudgetFacts: undefined, nowMs: NOW }));
	const pg16 = facts();
	pg16.instance.serverVersionNum = 160017;
	assert.throws(() => buildPostgresRecoveryRoleSql(policy(pg16)), /postgres_17_required/u);
	const stale = facts();
	stale.capturedAt = new Date(NOW - 20 * 60_000).toISOString();
	assert.throws(() => buildPostgresRecoveryRoleSql(policy(stale)), /stale_or_future_budget_snapshot/u);
	const incomplete = facts();
	incomplete.inventory.complete = false as true;
	assert.throws(() => buildPostgresRecoveryRoleSql(policy(incomplete)), /incomplete_hyperdrive_inventory/u);
});

test('policy refuses an active role, absent limits and timeout settings that PostgreSQL would ignore', () => {
	const active = facts();
	active.recovery.role.login = true;
	assert.throws(() => validatePostgresRecoveryRolePolicy(policy(active)), /NOLOGIN/u);
	for (const field of ['transactionMs', 'statementMs', 'lockMs', 'idleInTransactionMs'] as const) {
		const missing = facts();
		delete (missing.recovery.role.timeoutDefaults as unknown as Record<string, unknown>)[field];
		assert.throws(() => buildPostgresRecoveryRoleSql(policy(missing)));
		const zero = facts();
		zero.recovery.role.timeoutDefaults[field] = 0;
		assert.throws(() => buildPostgresRecoveryRoleSql(policy(zero)));
	}
	const ignoredStatement = facts();
	ignoredStatement.recovery.role.timeoutDefaults.statementMs = 30_000;
	assert.throws(() => buildPostgresRecoveryRoleSql(policy(ignoredStatement)), /ordering/u);
	const ignoredLock = facts();
	ignoredLock.recovery.role.timeoutDefaults.lockMs = 15_000;
	assert.throws(() => buildPostgresRecoveryRoleSql(policy(ignoredLock)), /ordering/u);
	const ignoredIdle = facts();
	ignoredIdle.recovery.role.timeoutDefaults.idleInTransactionMs = 30_000;
	assert.throws(() => buildPostgresRecoveryRoleSql(policy(ignoredIdle)), /ordering/u);
});

test('new role remains inert and server defaults are installed for future sessions, not by SET LOCAL', () => {
	const plan = buildPostgresRecoveryRoleSql(policy());
	assert.equal(plan.role, 'cinatoken_gateway_recovery');
	assert.equal(plan.login, false);
	assert.equal(plan.runtimeCompatible, false);
	assert.equal(plan.activation, 'requires_separate_review');
	assert.ok(plan.knownBlockers.includes('legacy_request_log_guard_not_installed'));
	assert.ok(plan.knownBlockers.includes('financial_writer_lock_acl_not_native_verified'));
	assert.match(plan.adminSql, /CREATE ROLE cinatoken_gateway_recovery NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/u);
	assert.match(plan.adminSql, /CONNECTION LIMIT 2 PASSWORD NULL/u);
	assert.match(plan.adminSql, /server_version_num'\)::integer < 170000/u);
	assert.match(plan.adminSql, /IN DATABASE %I SET transaction_timeout TO 30000/u);
	assert.match(plan.adminSql, /IN DATABASE %I SET statement_timeout TO 15000/u);
	assert.match(plan.adminSql, /IN DATABASE %I SET lock_timeout TO 5000/u);
	assert.match(plan.adminSql, /IN DATABASE %I SET idle_in_transaction_session_timeout TO 10000/u);
	assert.match(plan.adminSql, /REVOKE %I FROM %I/u);
	assert.doesNotMatch(plan.adminSql + plan.migratorSql, /SET LOCAL transaction_timeout|ALTER ROLE cinatoken_gateway_runtime|PASSWORD '[^']+'/iu);
	assert.equal((plan.adminSql.match(/\bBEGIN;/gu) ?? []).length, 1);
	assert.equal((plan.migratorSql.match(/\bBEGIN;/gu) ?? []).length, 1);
});

test('grants are table and column scoped; missing schema objects and PUBLIC inheritance block the transaction', () => {
	const plan = buildPostgresRecoveryRoleSql(policy());
	assert.equal(new Set(RECOVERY_TABLE_GRANTS.map((grant) => grant.table)).size, RECOVERY_TABLE_GRANTS.length);
	assert.equal(new Set(RECOVERY_FUNCTION_GRANTS).size, RECOVERY_FUNCTION_GRANTS.length);
	for (const entry of RECOVERY_TABLE_GRANTS) {
		if ('selectColumns' in entry && entry.selectColumns.length) {
			assert.match(plan.migratorSql, new RegExp(`GRANT SELECT \\(${entry.selectColumns.join(', ')}\\) ON TABLE cinatoken_gateway\\.${entry.table}`, 'u'));
		}
		if (entry.privileges.length) {
			assert.match(plan.migratorSql, new RegExp(`GRANT ${entry.privileges.join(', ')} ON TABLE cinatoken_gateway\\.${entry.table} TO cinatoken_gateway_recovery;`, 'u'));
		}
		if (entry.updateColumns.length) {
			assert.match(plan.migratorSql, new RegExp(`GRANT UPDATE \\(${entry.updateColumns.join(', ')}\\) ON TABLE cinatoken_gateway\\.${entry.table}`, 'u'));
		}
	}
	assert.doesNotMatch(plan.migratorSql, /GRANT SELECT ON TABLE cinatoken_gateway\.api_keys\b/u);
	assert.doesNotMatch(plan.migratorSql, /GRANT UPDATE(?: \([^)]*\))? ON TABLE cinatoken_gateway\.(?:api_keys|api_key_request_logs)\b/u);
	for (const signature of RECOVERY_FUNCTION_GRANTS) {
		assert.ok(plan.migratorSql.includes(`GRANT EXECUTE ON FUNCTION cinatoken_gateway.${signature} TO cinatoken_gateway_recovery;`));
	}
	for (const signature of [
		'guard_usage_recovery_job()', 'guard_usage_commit_receipt()',
		'check_usage_commit_transaction()', 'guard_fact_owned_usage_log()',
		'guard_fact_without_legacy_log()',
	]) {
		assert.ok(!new Set<string>(RECOVERY_FUNCTION_GRANTS).has(signature));
		assert.ok(!plan.migratorSql.includes(`GRANT EXECUTE ON FUNCTION cinatoken_gateway.${signature} TO cinatoken_gateway_recovery;`));
	}
	assert.match(plan.migratorSql, /Required recovery table missing, wrong kind or wrong owner/u);
	assert.match(plan.migratorSql, /Required recovery function missing/u);
	assert.match(plan.migratorSql, /Required recovery trigger missing, disabled or has wrong function\/event\/timing/u);
	assert.match(plan.migratorSql, /t\.tgfoid = pg_catalog\.to_regprocedure\(expected_trigger\.function_signature\)/u);
	assert.match(plan.migratorSql, /t\.tgtype = expected_trigger\.trigger_type::smallint/u);
	assert.match(plan.migratorSql, /t\.tgdeferrable = expected_trigger\.is_deferrable::boolean/u);
	assert.match(plan.migratorSql, /t\.tginitdeferred = expected_trigger\.initially_deferred::boolean/u);
	assert.match(plan.migratorSql, /t\.tgqual IS NULL AND pg_catalog\.cardinality\(t\.tgattr\) = 0/u);
	assert.match(plan.migratorSql, /t\.tgnargs = 0 AND t\.tgoldtable IS NULL AND t\.tgnewtable IS NULL/u);
	assert.equal(new Set(REQUIRED_TRIGGERS.map(([table, name]) => `${table}.${name}`)).size, REQUIRED_TRIGGERS.length);
	for (const [table, name, functionName, triggerType, deferrable, initiallyDeferred] of REQUIRED_TRIGGERS) {
		assert.ok(plan.migratorSql.includes(`('${table}', '${name}', 'cinatoken_gateway.${functionName}', '${triggerType}', '${deferrable}', '${initiallyDeferred}')`));
	}
	assert.ok(REQUIRED_TRIGGERS.some(([, name, , type]) => name === 'request_dispatch_intents_guard' && type === 23));
	assert.ok(REQUIRED_TRIGGERS.some(([, name, , type, deferrable, initiallyDeferred]) =>
		name === 'request_usage_commit_transaction_check' && type === 5 && deferrable && initiallyDeferred));
	assert.match(plan.migratorSql, /already has table privilege via PUBLIC/u);
	assert.match(plan.migratorSql, /already has column privilege via PUBLIC/u);
	assert.match(plan.migratorSql, /already has sequence privilege via PUBLIC/u);
	assert.match(plan.migratorSql, /already has function execution via PUBLIC/u);
	assert.match(plan.migratorSql, /recovery_api_key_workspace_matches\(text,text\)/u);
	assert.match(plan.migratorSql, /p\.prosecdef AND p\.provolatile = 'v'/u);
	assert.match(plan.migratorSql, /p\.proconfig = ARRAY\['search_path=pg_catalog, pg_temp'\]::text\[\]/u);
	assert.match(plan.migratorSql, /p\.prorettype = 'pg_catalog\.bool'::pg_catalog\.regtype/u);
	assert.match(plan.migratorSql, /aclexplode\(COALESCE\(p\.proacl, pg_catalog\.acldefault\('f', p\.proowner\)\)\)/u);
	assert.match(plan.migratorSql, /Ordinary runtime must not execute the recovery API-key lock helper/u);
	assert.match(plan.migratorSql, /Request-log workspace trigger function security contract differs/u);
	assert.match(plan.migratorSql, /Legacy log fence ownership or security contract differs/u);
	assert.match(plan.migratorSql, /Legacy log fence is executable by PUBLIC/u);
	assert.match(plan.migratorSql, /Ordinary runtime must not execute the legacy log fence/u);
	assert.match(plan.migratorSql, /guard_fact_without_legacy_log\(\)/u);
	assert.ok(REQUIRED_TRIGGERS.some(([table, name, , type]) =>
		table === 'request_usage_settlements' && name === 'request_usage_settlements_legacy_log_fence' && type === 7));
	assert.match(plan.migratorSql, /Recovery role membership is forbidden/u);
	assert.doesNotMatch(plan.migratorSql, /GRANT (?:ALL|DELETE|TRUNCATE|CREATE)|GRANT [^;]+ ON ALL (?:TABLES|FUNCTIONS|SEQUENCES)|ALTER DEFAULT PRIVILEGES/iu);
});

test('the grant catalogue matches recovery schema artifacts and writer names', () => {
	const proposalNames = [
		'request-usage-settlement-facts.sql', 'request-usage-recovery-jobs.sql', 'request-usage-commit-receipts.sql',
	];
	const proposal = [
		...proposalNames.map((name) => readFileSync(fileURLToPath(new URL(`../../../packages/core/migrations-proposals/postgres/${name}`, import.meta.url)), 'utf8')),
		readFileSync(fileURLToPath(new URL('../../../packages/core/migrations-postgres/0073_recovery_api_key_workspace_lock.sql', import.meta.url)), 'utf8'),
		readFileSync(fileURLToPath(new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url)), 'utf8'),
	].join('\n');
	const writer = readFileSync(fileURLToPath(new URL('../../../packages/core/src/db/postgres/critical-writes.impl.ts', import.meta.url)), 'utf8');
	for (const table of RECOVERY_TABLE_GRANTS.filter((grant) => grant.table.startsWith('request_usage_'))) {
		assert.ok(proposal.includes(`cinatoken_gateway.${table.table}`), table.table);
	}
	for (const signature of RECOVERY_FUNCTION_GRANTS) {
		assert.ok(proposal.includes(`cinatoken_gateway.${signature}`), signature);
	}
	for (const field of ['pgUsersTable', 'pgUserBudgetReservationsTable', 'pgGuardrailBudgetReservationsTable',
		'pgGuardrailBudgetWindowsTable', 'pgPublicModelDailyStatsTable', 'pgProviderAttemptAvailabilityTable']) {
		assert.ok(writer.includes(field), field);
	}
});

test('the API-key lock helper narrows privilege without changing row-lock semantics', () => {
	const migration = readFileSync(fileURLToPath(new URL('../../../packages/core/migrations-postgres/0073_recovery_api_key_workspace_lock.sql', import.meta.url)), 'utf8');
	assert.match(migration, /CREATE FUNCTION cinatoken_gateway\.recovery_api_key_workspace_matches\(/u);
	assert.match(migration, /SET LOCAL lock_timeout = '2s';/u);
	assert.match(migration, /RETURNS boolean[\s\S]*?VOLATILE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path TO pg_catalog, pg_temp/u);
	assert.match(migration, /FROM cinatoken_gateway\.api_keys AS key\s+WHERE key\.id = p_api_key_id\s+FOR UPDATE;/u);
	assert.match(migration, /RETURN COALESCE\(locked_workspace_id = p_workspace_id, false\);/u);
	assert.match(migration, /REVOKE ALL ON FUNCTION cinatoken_gateway\.recovery_api_key_workspace_matches\(text,text\)\s+FROM PUBLIC;/u);
	assert.match(migration, /IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = 'cinatoken_gateway_runtime'\) THEN\s+EXECUTE 'REVOKE ALL ON FUNCTION cinatoken_gateway\.recovery_api_key_workspace_matches\(text,text\)\s+FROM cinatoken_gateway_runtime';/u);
	assert.doesNotMatch(migration, /EXECUTE\s+format|INSERT INTO|UPDATE\s+cinatoken_gateway\.api_keys|DELETE FROM/u);
});
