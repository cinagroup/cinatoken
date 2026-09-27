import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	RecoveryOriginBudgetError,
	RECOVERY_ORIGIN_BUDGET_MAX_AGE_MS,
	HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT,
	validatePostgresRecoveryOriginBudget,
	type RecoveryOriginBudgetSnapshot,
} from './postgres-recovery-origin-budget';

const NOW = Date.parse('2026-09-23T10:00:00.000Z');

function facts(): RecoveryOriginBudgetSnapshot {
	return {
		schemaVersion: 1,
		capturedAt: new Date(NOW - 60_000).toISOString(),
		instance: {
			id: 'ps5_gateway',
			serverVersionNum: 170006,
			maxConnections: 50,
			superuserReservedConnections: 3,
			reservedConnections: 2,
			observedClientConnections: 12,
			observedClientConnectionsScope: 'all_databases',
			nonHyperdriveConnectionBudget: 5,
			safetyHeadroomConnections: 3,
		},
		inventory: {
			complete: true,
			scope: 'all_hyperdrives_on_instance',
			instanceId: 'ps5_gateway',
			origins: [
				{ id: 'cinaauth', instanceId: 'ps5_gateway', roleName: 'cinaauth_runtime', originConnectionLimit: 15 },
				{ id: 'gateway_runtime', instanceId: 'ps5_gateway', roleName: 'cinatoken_gateway_runtime', originConnectionLimit: 5 },
				{ id: 'gateway_migrator', instanceId: 'ps5_gateway', roleName: 'cinatoken_gateway_migrator', originConnectionLimit: 5 },
			],
		},
		recovery: {
			role: {
				name: 'cinatoken_gateway_recovery',
				login: false,
				connectionLimit: 2,
				timeoutDefaults: {
					transactionMs: 30_000,
					statementMs: 15_000,
					lockMs: 5_000,
					idleInTransactionMs: 10_000,
				},
			},
			hyperdrive: { id: 'gateway_recovery', instanceId: 'ps5_gateway', originConnectionLimit: 5 },
			peakConnectionsNeeded: 2,
			runBudgetMs: 60_000,
		},
	};
}

function rejects(mutator: (value: RecoveryOriginBudgetSnapshot) => void, code: string): void {
	const input = facts();
	mutator(input);
	assert.throws(() => validatePostgresRecoveryOriginBudget(input, NOW), (error: unknown) =>
		error instanceof RecoveryOriginBudgetError && error.code === code);
}

test('complete fresh PG17 snapshot fits all origin caps and observed demand', () => {
	const result = validatePostgresRecoveryOriginBudget(facts(), NOW);
	assert.equal(result.kind, 'snapshot-arithmetic-only');
	assert.equal(result.normalConnectionCapacity, 45);
	assert.equal(result.existingOriginLimitTotal, 25);
	assert.equal(result.projectedOriginLimitTotal, 30);
	assert.equal(result.configuredSpareConnections, 7);
	assert.equal(result.observedSpareAfterRecoveryPeak, 28);
	assert.equal(result.recoveryRoleName, 'cinatoken_gateway_recovery');
	assert.equal(result.recoveryRoleLogin, false);
	assert.deepEqual(result.roleTimeoutDefaults, facts().recovery.role.timeoutDefaults);
	assert.ok(Object.isFrozen(result) && Object.isFrozen(result.roleTimeoutDefaults));
});

test('historical PS-5 caps do not permit a new recovery origin even after runtime was reduced to five', () => {
	rejects((input) => {
		input.instance.maxConnections = 25;
		input.instance.reservedConnections = 0;
	}, 'configured_connection_budget_exceeds_capacity');
});

test('missing, extra, stale, future and mixed-instance facts fail closed', () => {
	rejects((input) => { delete (input.instance as Record<string, unknown>).reservedConnections; }, 'invalid_postgres_instance_facts');
	rejects((input) => { (input as unknown as Record<string, unknown>).password = 'must-not-be-accepted'; }, 'invalid_budget_snapshot');
	rejects((input) => { input.inventory.complete = false as true; }, 'incomplete_hyperdrive_inventory');
	rejects((input) => { input.inventory.scope = 'one_database' as 'all_hyperdrives_on_instance'; }, 'incomplete_hyperdrive_inventory');
	rejects((input) => { input.instance.observedClientConnectionsScope = 'gateway_only' as 'all_databases'; }, 'incomplete_observed_connection_scope');
	rejects((input) => { input.inventory.origins[0]!.instanceId = 'different'; }, 'mixed_postgres_instances');
	rejects((input) => { input.inventory.origins[1]!.id = input.inventory.origins[0]!.id; }, 'duplicate_hyperdrive_origin');
	rejects((input) => { input.recovery.hyperdrive.id = input.inventory.origins[0]!.id; }, 'recovery_origin_already_in_inventory');
	rejects((input) => { input.capturedAt = new Date(NOW - RECOVERY_ORIGIN_BUDGET_MAX_AGE_MS - 1).toISOString(); }, 'stale_or_future_budget_snapshot');
	rejects((input) => { input.capturedAt = new Date(NOW + 1).toISOString(); }, 'stale_or_future_budget_snapshot');
	rejects((input) => { input.capturedAt = '2026-02-30T10:00:00.000Z'; }, 'invalid_budget_snapshot_time');
});

test('opaque instance and Hyperdrive IDs can begin with digits without relaxing role names', () => {
	const input = facts();
	input.instance.id = '0f9e2a6c-1111-4444-8888-abcdef012345';
	input.inventory.instanceId = input.instance.id;
	input.inventory.origins.forEach((origin, index) => {
		origin.instanceId = input.instance.id;
		origin.id = `${index}f9e2a6c`; // valid opaque config IDs, including a digit prefix
	});
	input.recovery.hyperdrive.instanceId = input.instance.id;
	input.recovery.hyperdrive.id = '9f9e2a6c-1111-4444-8888-abcdef012345';
	const result = validatePostgresRecoveryOriginBudget(input, NOW);
	assert.equal(result.instanceId, input.instance.id);
	assert.equal(result.projectedOriginLimitTotal, 30);
	rejects((value) => { value.inventory.origins[0]!.roleName = '9role'; }, 'invalid_existing_origin_role');
	rejects((value) => { value.recovery.role.name = '9recovery'; }, 'invalid_recovery_role_name');
});

test('opaque IDs still reject empty, oversized and control-character values', () => {
	rejects((input) => { input.instance.id = ''; }, 'invalid_postgres_instance_id');
	rejects((input) => { input.inventory.origins[0]!.id = ' '; }, 'invalid_existing_origin_id');
	rejects((input) => { input.recovery.hyperdrive.id = '9config\nsecond-line'; }, 'invalid_recovery_hyperdrive_id');
	rejects((input) => { input.inventory.instanceId = '9instance\u2028split'; }, 'invalid_hyperdrive_inventory_instance');
	rejects((input) => { input.inventory.origins[0]!.id = '9'.repeat(129); }, 'invalid_existing_origin_id');
});

test('PG16, absent headroom, unsafe role and timeout settings fail closed', () => {
	rejects((input) => { input.instance.serverVersionNum = 160017; }, 'postgres_17_required');
	rejects((input) => { input.instance.safetyHeadroomConnections = 0; }, 'invalid_safety_headroom');
	rejects((input) => { input.recovery.role.name = 'cinatoken_gateway_runtime'; }, 'dedicated_recovery_role_required');
	rejects((input) => { input.inventory.origins[0]!.roleName = input.recovery.role.name; }, 'recovery_role_reused_by_existing_origin');
	rejects((input) => { input.recovery.role.connectionLimit = 1; }, 'recovery_role_connection_limit_mismatch');
	rejects((input) => { input.recovery.role.connectionLimit = 6; }, 'recovery_role_connection_limit_mismatch');
	rejects((input) => { input.recovery.role.timeoutDefaults.transactionMs = 0; }, 'invalid_transaction_timeout');
	rejects((input) => { input.recovery.role.timeoutDefaults.transactionMs = 60_001; }, 'transaction_timeout_exceeds_run_budget');
});

test('Cloudflare Hyperdrive rejects any existing or proposed origin limit below five', () => {
	assert.equal(HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT, 5);
	rejects((input) => { input.inventory.origins[1]!.originConnectionLimit = 4; }, 'invalid_existing_origin_limit');
	rejects((input) => { input.recovery.hyperdrive.originConnectionLimit = 4; }, 'invalid_recovery_origin_limit');
	const input = facts();
	input.inventory.origins[1]!.originConnectionLimit = 5;
	input.recovery.hyperdrive.originConnectionLimit = 5;
	assert.equal(validatePostgresRecoveryOriginBudget(input, NOW).projectedOriginLimitTotal, 30);
});

test('configured caps and current occupancy are independent blockers', () => {
	rejects((input) => { input.instance.nonHyperdriveConnectionBudget = 15; }, 'configured_connection_budget_exceeds_capacity');
	rejects((input) => { input.instance.observedClientConnections = 41; }, 'observed_connection_budget_exceeds_capacity');
	rejects((input) => { input.instance.observedClientConnections = 46; }, 'observed_connections_exceed_normal_capacity');
	rejects((input) => { input.instance.superuserReservedConnections = 49; }, 'no_normal_connection_capacity');
	rejects((input) => { input.inventory.origins[0]!.originConnectionLimit = Number.MAX_SAFE_INTEGER; }, 'connection_budget_overflow');
});

test('exactly full capacity passes only with the explicitly reserved headroom intact', () => {
	const input = facts();
	input.instance.maxConnections = 43; // normal capacity 38; 30 origins + 5 direct + 3 headroom
	const result = validatePostgresRecoveryOriginBudget(input, NOW);
	assert.equal(result.configuredSpareConnections, 0);
	input.instance.maxConnections = 42;
	assert.throws(() => validatePostgresRecoveryOriginBudget(input, NOW), /configured_connection_budget_exceeds_capacity/u);
});

test('CLI refuses an implicit snapshot and accepts only an explicitly supplied local file', async () => {
	const cli = fileURLToPath(new URL('./postgres-recovery-origin-budget-cli.ts', import.meta.url));
	const missing = spawnSync(process.execPath, ['--import', 'tsx', cli], { encoding: 'utf8' });
	assert.equal(missing.status, 1);
	assert.deepEqual(JSON.parse(missing.stdout), { ok: false, code: 'explicit_snapshot_path_required' });

	const dir = await mkdtemp(join(tmpdir(), 'recovery-origin-budget-'));
	const file = join(dir, 'snapshot.json');
	try {
		const input = facts();
		input.capturedAt = new Date(Date.now()).toISOString();
		await writeFile(file, JSON.stringify(input), 'utf8');
		const accepted = spawnSync(process.execPath, ['--import', 'tsx', cli, `--snapshot=${file}`], { encoding: 'utf8' });
		assert.equal(accepted.status, 0, accepted.stderr);
		const output = JSON.parse(accepted.stdout) as { ok: boolean; budget: { kind: string } };
		assert.equal(output.ok, true);
		assert.equal(output.budget.kind, 'snapshot-arithmetic-only');
	} finally {
		await unlink(file).catch(() => {});
		await rmdir(dir);
	}
});
