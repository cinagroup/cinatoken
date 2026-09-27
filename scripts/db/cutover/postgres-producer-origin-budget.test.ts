import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DISPATCH_PRODUCER_ROLE,
	FACT_PRODUCER_ROLE,
	PRODUCER_HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT,
	PRODUCER_ORIGIN_BUDGET_MAX_AGE_MS,
	ProducerOriginBudgetError,
	validatePostgresProducerOriginBudget,
	type ProducerOriginBudgetSnapshot,
} from './postgres-producer-origin-budget';

const NOW = Date.parse('2026-09-24T10:00:00.000Z');

function facts(): ProducerOriginBudgetSnapshot {
	return {
		schemaVersion: 1,
		capturedAt: new Date(NOW - 60_000).toISOString(),
		instance: {
			id: 'ps5_gateway', serverVersionNum: 180006, maxConnections: 50,
			superuserReservedConnections: 3, reservedConnections: 2,
			observedClientConnections: 12, observedClientConnectionsScope: 'all_databases',
			nonHyperdriveConnectionBudget: 5, safetyHeadroomConnections: 3,
		},
		inventory: {
			complete: true, scope: 'all_hyperdrives_on_instance', instanceId: 'ps5_gateway',
			origins: [
				{ id: 'cinaauth', instanceId: 'ps5_gateway', roleName: 'cinaauth_runtime', originConnectionLimit: 15 },
				{ id: 'gateway_runtime', instanceId: 'ps5_gateway', roleName: 'cinatoken_gateway_runtime', originConnectionLimit: 5 },
				{ id: 'gateway_migrator', instanceId: 'ps5_gateway', roleName: 'cinatoken_gateway_migrator', originConnectionLimit: 5 },
			],
		},
		proposed: {
			dispatch: {
				role: { name: DISPATCH_PRODUCER_ROLE, login: true, inherit: false, connectionLimit: 2 },
				hyperdrive: { id: 'gateway_dispatch', instanceId: 'ps5_gateway', originConnectionLimit: 5 },
				peakConnectionsNeeded: 2,
			},
			fact: {
				role: { name: FACT_PRODUCER_ROLE, login: true, inherit: false, connectionLimit: 2 },
				hyperdrive: { id: 'gateway_fact', instanceId: 'ps5_gateway', originConnectionLimit: 5 },
				peakConnectionsNeeded: 2,
			},
		},
	};
}

function rejects(mutate: (snapshot: ProducerOriginBudgetSnapshot) => void, code: string): void {
	const input = facts();
	mutate(input);
	assert.throws(() => validatePostgresProducerOriginBudget(input, NOW), (error: unknown) =>
		error instanceof ProducerOriginBudgetError && error.code === code);
}

test('fresh complete PG18 snapshot includes both new origins and both producer peaks', () => {
	const result = validatePostgresProducerOriginBudget(facts(), NOW);
	assert.equal(result.kind, 'snapshot-arithmetic-only');
	assert.equal(result.normalConnectionCapacity, 45);
	assert.equal(result.existingOriginLimitTotal, 25);
	assert.equal(result.projectedOriginLimitTotal, 35);
	assert.equal(result.configuredSpareConnections, 2); // 45 - (35 + 5 direct + 3 headroom)
	assert.equal(result.observedSpareAfterProducerPeaks, 26); // 45 - (12 observed + 2 + 2 + 3)
	assert.deepEqual(Object.keys(result.proposed), ['dispatch', 'fact']);
	assert.equal(result.proposed.dispatch.roleName, DISPATCH_PRODUCER_ROLE);
	assert.equal(result.proposed.fact.roleName, FACT_PRODUCER_ROLE);
	assert.ok(Object.isFrozen(result) && Object.isFrozen(result.proposed)
		&& Object.isFrozen(result.proposed.dispatch) && Object.isFrozen(result.proposed.fact));
});

test('historical PS-5 caps cannot fit both producer origins', () => {
	rejects(input => {
		input.instance.maxConnections = 25;
		input.instance.reservedConnections = 0;
	}, 'configured_connection_budget_exceeds_capacity');
});

test('missing, extra, stale, future, partial and mixed-instance facts fail closed', () => {
	rejects(input => { delete (input.instance as Record<string, unknown>).reservedConnections; }, 'invalid_postgres_instance_facts');
	rejects(input => { (input as unknown as Record<string, unknown>).password = 'unexpected'; }, 'invalid_budget_snapshot');
	rejects(input => { delete (input.proposed as Record<string, unknown>).fact; }, 'invalid_proposed_origins');
	rejects(input => { input.inventory.complete = false as true; }, 'incomplete_hyperdrive_inventory');
	rejects(input => { input.inventory.scope = 'one_database' as 'all_hyperdrives_on_instance'; }, 'incomplete_hyperdrive_inventory');
	rejects(input => { input.instance.observedClientConnectionsScope = 'gateway_only' as 'all_databases'; }, 'incomplete_observed_connection_scope');
	rejects(input => { input.inventory.origins[0]!.instanceId = 'other'; }, 'mixed_postgres_instances');
	rejects(input => { input.proposed.fact.hyperdrive.instanceId = 'other'; }, 'mixed_postgres_instances');
	rejects(input => { input.capturedAt = new Date(NOW - PRODUCER_ORIGIN_BUDGET_MAX_AGE_MS - 1).toISOString(); }, 'stale_or_future_budget_snapshot');
	rejects(input => { input.capturedAt = new Date(NOW + 1).toISOString(); }, 'stale_or_future_budget_snapshot');
	rejects(input => { input.capturedAt = '2026-02-30T10:00:00.000Z'; }, 'invalid_budget_snapshot_time');
	assert.throws(() => validatePostgresProducerOriginBudget(facts(), Number.NaN), /stale_or_future_budget_snapshot/u);
});

test('proposed and existing Hyperdrive identities must remain distinct', () => {
	rejects(input => { input.inventory.origins[1]!.id = input.inventory.origins[0]!.id; }, 'duplicate_hyperdrive_origin');
	rejects(input => { input.proposed.dispatch.hyperdrive.id = input.inventory.origins[0]!.id; }, 'duplicate_hyperdrive_origin');
	rejects(input => { input.proposed.fact.hyperdrive.id = input.proposed.dispatch.hyperdrive.id; }, 'duplicate_hyperdrive_origin');
	rejects(input => { input.inventory.origins[0]!.roleName = DISPATCH_PRODUCER_ROLE; }, 'producer_role_reused_by_existing_origin');
	rejects(input => { input.inventory.origins[0]!.roleName = FACT_PRODUCER_ROLE; }, 'producer_role_reused_by_existing_origin');
	rejects(input => { input.proposed.fact.role.name = DISPATCH_PRODUCER_ROLE; }, 'dedicated_fact_login_role_required');
	rejects(input => { input.proposed.dispatch.role.name = 'cinatoken_gateway_runtime'; }, 'dedicated_dispatch_login_role_required');
});

test('direct LOGIN, NOINHERIT and bounded connection limits are mandatory', () => {
	rejects(input => { input.proposed.dispatch.role.login = false as true; }, 'dedicated_dispatch_login_role_required');
	rejects(input => { input.proposed.fact.role.inherit = true as false; }, 'dedicated_fact_login_role_required');
	rejects(input => { input.proposed.dispatch.role.connectionLimit = 0; }, 'invalid_dispatch_role_connection_limit');
	rejects(input => { input.proposed.fact.role.connectionLimit = 1; }, 'fact_role_connection_limit_mismatch');
	rejects(input => { input.proposed.fact.role.connectionLimit = 6; }, 'fact_role_connection_limit_mismatch');
	rejects(input => { input.proposed.dispatch.peakConnectionsNeeded = 0; }, 'invalid_dispatch_peak_demand');
	rejects(input => { input.proposed.fact.hyperdrive.originConnectionLimit = 4; }, 'invalid_fact_origin_limit');
	rejects(input => { input.inventory.origins[0]!.originConnectionLimit = 4; }, 'invalid_existing_origin_limit');
	assert.equal(PRODUCER_HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT, 5);
});

test('PG version, IDs, count ranges and overflow are checked', () => {
	rejects(input => { input.instance.serverVersionNum = 160017; }, 'postgres_17_required');
	rejects(input => { input.instance.id = ''; }, 'invalid_postgres_instance_id');
	rejects(input => { input.proposed.fact.hyperdrive.id = 'bad\norigin'; }, 'invalid_fact_hyperdrive_id');
	rejects(input => { input.proposed.dispatch.hyperdrive.id = '9'.repeat(129); }, 'invalid_dispatch_hyperdrive_id');
	rejects(input => { input.instance.safetyHeadroomConnections = 0; }, 'invalid_safety_headroom');
	rejects(input => { input.instance.superuserReservedConnections = 49; }, 'no_normal_connection_capacity');
	rejects(input => { input.inventory.origins[0]!.originConnectionLimit = Number.MAX_SAFE_INTEGER; }, 'connection_budget_overflow');
	rejects(input => { input.instance.observedClientConnections = 46; }, 'observed_connections_exceed_normal_capacity');
	const input = facts();
	input.instance.id = '0f9e2a6c';
	input.inventory.instanceId = input.instance.id;
	input.inventory.origins.forEach((origin, index) => { origin.id = `${index}origin`; origin.instanceId = input.instance.id; });
	input.proposed.dispatch.hyperdrive.id = '1dispatch';
	input.proposed.fact.hyperdrive.id = '2fact';
	input.proposed.dispatch.hyperdrive.instanceId = input.instance.id;
	input.proposed.fact.hyperdrive.instanceId = input.instance.id;
	assert.equal(validatePostgresProducerOriginBudget(input, NOW).instanceId, input.instance.id);
});

test('configured caps and observed occupancy are separate gates', () => {
	rejects(input => { input.instance.nonHyperdriveConnectionBudget = 8; }, 'configured_connection_budget_exceeds_capacity');
	rejects(input => { input.instance.observedClientConnections = 41; }, 'observed_connection_budget_exceeds_capacity');
	const atConfiguredBoundary = facts();
	atConfiguredBoundary.instance.maxConnections = 48; // normal 43 = 35 origins + 5 direct + 3 headroom
	assert.equal(validatePostgresProducerOriginBudget(atConfiguredBoundary, NOW).configuredSpareConnections, 0);
	atConfiguredBoundary.instance.maxConnections = 47;
	assert.throws(() => validatePostgresProducerOriginBudget(atConfiguredBoundary, NOW), /configured_connection_budget_exceeds_capacity/u);
});
