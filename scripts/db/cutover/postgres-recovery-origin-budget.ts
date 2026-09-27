/**
 * Offline, snapshot-only preflight for adding a dedicated recovery Hyperdrive.
 * All counts must describe the same PostgreSQL instance. In particular,
 * observedClientConnections must count client backends across every database,
 * not just the gateway database. A passing calculation is not live capacity
 * evidence: Hyperdrive origin limits are soft and a supplied snapshot is not
 * authenticated by this pure function.
 */

export const RECOVERY_ORIGIN_BUDGET_MAX_AGE_MS = 15 * 60 * 1000;
export const RECOVERY_ORIGIN_ROLE = 'cinatoken_gateway_recovery';
// https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/
export const HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT = 5;

export interface RecoveryOriginBudgetSnapshot {
	schemaVersion: 1;
	capturedAt: string;
	instance: {
		id: string;
		serverVersionNum: number;
		maxConnections: number;
		superuserReservedConnections: number;
		reservedConnections: number;
		observedClientConnections: number;
		observedClientConnectionsScope: 'all_databases';
		nonHyperdriveConnectionBudget: number;
		safetyHeadroomConnections: number;
	};
	inventory: {
		complete: true;
		scope: 'all_hyperdrives_on_instance';
		instanceId: string;
		origins: Array<{
			id: string;
			instanceId: string;
			roleName: string;
			originConnectionLimit: number;
		}>;
	};
	recovery: {
		role: {
			name: string;
			login: boolean;
			connectionLimit: number;
			timeoutDefaults: {
				transactionMs: number;
				statementMs: number;
				lockMs: number;
				idleInTransactionMs: number;
			};
		};
		hyperdrive: {
			id: string;
			instanceId: string;
			originConnectionLimit: number;
		};
		peakConnectionsNeeded: number;
		runBudgetMs: number;
	};
}

export interface RecoveryOriginBudgetResult {
	readonly kind: 'snapshot-arithmetic-only';
	readonly capturedAt: string;
	readonly instanceId: string;
	readonly normalConnectionCapacity: number;
	readonly existingOriginLimitTotal: number;
	readonly projectedOriginLimitTotal: number;
	readonly nonHyperdriveConnectionBudget: number;
	readonly safetyHeadroomConnections: number;
	readonly configuredSpareConnections: number;
	readonly observedSpareAfterRecoveryPeak: number;
	readonly recoveryRoleName: string;
	readonly recoveryRoleLogin: boolean;
	readonly recoveryRoleConnectionLimit: number;
	readonly roleTimeoutDefaults: Readonly<RecoveryOriginBudgetSnapshot['recovery']['role']['timeoutDefaults']>;
}

export class RecoveryOriginBudgetError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'RecoveryOriginBudgetError';
	}
}

function fail(code: string): never {
	throw new RecoveryOriginBudgetError(code);
}

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
	const object = value as Record<string, unknown>;
	if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) fail(code);
	return object;
}

function safeCount(value: unknown, code: string, minimum = 0): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(code);
	return value;
}

function roleName(value: unknown, code: string): string {
	if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/u.test(value)) fail(code);
	return value;
}

// Cloudflare and database-provider IDs are opaque. In particular, a valid
// Hyperdrive config ID may start with a decimal digit (for example, a hex ID).
function opaqueId(value: unknown, code: string): string {
	if (
		typeof value !== 'string' || value.length === 0 || value.length > 128 ||
		value.trim() !== value || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
	) fail(code);
	return value;
}

function checkedSum(values: readonly number[]): number {
	let total = 0;
	for (const value of values) {
		if (value > Number.MAX_SAFE_INTEGER - total) fail('connection_budget_overflow');
		total += value;
	}
	return total;
}

/**
 * Rejects missing, extra, stale, inconsistent, or overcommitted facts. `nowMs`
 * is explicit so the calculation has no clock, filesystem, or network access.
 * The caller must independently authenticate and collect every fact.
 */
export function validatePostgresRecoveryOriginBudget(facts: unknown, nowMs: number): RecoveryOriginBudgetResult {
	const root = exactObject(facts, ['schemaVersion', 'capturedAt', 'instance', 'inventory', 'recovery'], 'invalid_budget_snapshot');
	if (root.schemaVersion !== 1) fail('unsupported_budget_snapshot_version');
	if (typeof root.capturedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(root.capturedAt)) {
		fail('invalid_budget_snapshot_time');
	}
	const capturedMs = Date.parse(root.capturedAt as string);
	if (!Number.isFinite(capturedMs) || new Date(capturedMs).toISOString() !== root.capturedAt) fail('invalid_budget_snapshot_time');
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 || capturedMs > nowMs || nowMs - capturedMs > RECOVERY_ORIGIN_BUDGET_MAX_AGE_MS) {
		fail('stale_or_future_budget_snapshot');
	}

	const instance = exactObject(root.instance, [
		'id', 'serverVersionNum', 'maxConnections', 'superuserReservedConnections', 'reservedConnections',
		'observedClientConnections', 'observedClientConnectionsScope', 'nonHyperdriveConnectionBudget',
		'safetyHeadroomConnections',
	], 'invalid_postgres_instance_facts');
	const instanceId = opaqueId(instance.id, 'invalid_postgres_instance_id');
	const serverVersionNum = safeCount(instance.serverVersionNum, 'invalid_postgres_version', 1);
	if (Math.floor(serverVersionNum / 10_000) < 17) fail('postgres_17_required');
	const maxConnections = safeCount(instance.maxConnections, 'invalid_max_connections', 1);
	const superuserReserved = safeCount(instance.superuserReservedConnections, 'invalid_superuser_reserved_connections');
	const reserved = safeCount(instance.reservedConnections, 'invalid_reserved_connections');
	const observed = safeCount(instance.observedClientConnections, 'invalid_observed_client_connections');
	if (instance.observedClientConnectionsScope !== 'all_databases') fail('incomplete_observed_connection_scope');
	const nonHyperdrive = safeCount(instance.nonHyperdriveConnectionBudget, 'invalid_non_hyperdrive_budget');
	const headroom = safeCount(instance.safetyHeadroomConnections, 'invalid_safety_headroom', 1);
	if (checkedSum([superuserReserved, reserved]) >= maxConnections) fail('no_normal_connection_capacity');
	const normalCapacity = maxConnections - superuserReserved - reserved;
	if (observed > normalCapacity) fail('observed_connections_exceed_normal_capacity');

	const inventory = exactObject(root.inventory, ['complete', 'scope', 'instanceId', 'origins'], 'invalid_hyperdrive_inventory');
	if (inventory.complete !== true || inventory.scope !== 'all_hyperdrives_on_instance') fail('incomplete_hyperdrive_inventory');
	if (opaqueId(inventory.instanceId, 'invalid_hyperdrive_inventory_instance') !== instanceId) fail('mixed_postgres_instances');
	if (!Array.isArray(inventory.origins)) fail('invalid_hyperdrive_inventory');
	const ids = new Set<string>();
	const limits: number[] = [];
	for (const item of inventory.origins) {
		const origin = exactObject(item, ['id', 'instanceId', 'roleName', 'originConnectionLimit'], 'invalid_existing_origin');
		const id = opaqueId(origin.id, 'invalid_existing_origin_id');
		if (ids.has(id)) fail('duplicate_hyperdrive_origin');
		ids.add(id);
		if (opaqueId(origin.instanceId, 'invalid_existing_origin_instance') !== instanceId) fail('mixed_postgres_instances');
		roleName(origin.roleName, 'invalid_existing_origin_role');
		limits.push(safeCount(origin.originConnectionLimit, 'invalid_existing_origin_limit', HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT));
	}

	const recovery = exactObject(root.recovery, ['role', 'hyperdrive', 'peakConnectionsNeeded', 'runBudgetMs'], 'invalid_recovery_budget_facts');
	const role = exactObject(recovery.role, ['name', 'login', 'connectionLimit', 'timeoutDefaults'], 'invalid_recovery_role_facts');
	const recoveryRoleName = roleName(role.name, 'invalid_recovery_role_name');
	if (recoveryRoleName !== RECOVERY_ORIGIN_ROLE || typeof role.login !== 'boolean') fail('dedicated_recovery_role_required');
	const roleConnectionLimit = safeCount(role.connectionLimit, 'invalid_recovery_role_connection_limit', 1);
	const defaults = exactObject(role.timeoutDefaults, ['transactionMs', 'statementMs', 'lockMs', 'idleInTransactionMs'], 'invalid_recovery_role_timeouts');
	const timeoutDefaults = {
		transactionMs: safeCount(defaults.transactionMs, 'invalid_transaction_timeout', 1),
		statementMs: safeCount(defaults.statementMs, 'invalid_statement_timeout', 1),
		lockMs: safeCount(defaults.lockMs, 'invalid_lock_timeout', 1),
		idleInTransactionMs: safeCount(defaults.idleInTransactionMs, 'invalid_idle_transaction_timeout', 1),
	};
	const runBudgetMs = safeCount(recovery.runBudgetMs, 'invalid_recovery_run_budget', 1);
	if (runBudgetMs > 60_000 || timeoutDefaults.transactionMs > runBudgetMs) fail('transaction_timeout_exceeds_run_budget');
	const peakNeeded = safeCount(recovery.peakConnectionsNeeded, 'invalid_recovery_peak_demand', 1);
	const hyperdrive = exactObject(recovery.hyperdrive, ['id', 'instanceId', 'originConnectionLimit'], 'invalid_recovery_hyperdrive');
	const recoveryOriginId = opaqueId(hyperdrive.id, 'invalid_recovery_hyperdrive_id');
	if (ids.has(recoveryOriginId)) fail('recovery_origin_already_in_inventory');
	if (opaqueId(hyperdrive.instanceId, 'invalid_recovery_hyperdrive_instance') !== instanceId) fail('mixed_postgres_instances');
	const recoveryOriginLimit = safeCount(hyperdrive.originConnectionLimit, 'invalid_recovery_origin_limit', HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT);
	if (peakNeeded > roleConnectionLimit || roleConnectionLimit > recoveryOriginLimit) fail('recovery_role_connection_limit_mismatch');
	for (const item of inventory.origins) {
		if ((item as { roleName: string }).roleName === recoveryRoleName) fail('recovery_role_reused_by_existing_origin');
	}

	const existingTotal = checkedSum(limits);
	const projectedTotal = checkedSum([existingTotal, recoveryOriginLimit]);
	const configuredDemand = checkedSum([projectedTotal, nonHyperdrive, headroom]);
	if (configuredDemand > normalCapacity) fail('configured_connection_budget_exceeds_capacity');
	const observedDemand = checkedSum([observed, peakNeeded, headroom]);
	if (observedDemand > normalCapacity) fail('observed_connection_budget_exceeds_capacity');

	return Object.freeze({
		kind: 'snapshot-arithmetic-only',
		capturedAt: root.capturedAt as string,
		instanceId,
		normalConnectionCapacity: normalCapacity,
		existingOriginLimitTotal: existingTotal,
		projectedOriginLimitTotal: projectedTotal,
		nonHyperdriveConnectionBudget: nonHyperdrive,
		safetyHeadroomConnections: headroom,
		configuredSpareConnections: normalCapacity - configuredDemand,
		observedSpareAfterRecoveryPeak: normalCapacity - observedDemand,
		recoveryRoleName,
		recoveryRoleLogin: role.login,
		recoveryRoleConnectionLimit: roleConnectionLimit,
		roleTimeoutDefaults: Object.freeze(timeoutDefaults),
	});
}
