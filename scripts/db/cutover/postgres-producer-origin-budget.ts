/**
 * Pure arithmetic over a caller-supplied, same-instance PostgreSQL snapshot.
 * A pass does not authenticate the inventory or prove live capacity: Hyperdrive
 * origin limits are soft, and neither the database nor Cloudflare is queried.
 */

export const PRODUCER_ORIGIN_BUDGET_MAX_AGE_MS = 15 * 60 * 1000;
export const PRODUCER_HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT = 5;
export const DISPATCH_PRODUCER_ROLE = 'cinatoken_gateway_dispatch_producer';
export const FACT_PRODUCER_ROLE = 'cinatoken_gateway_fact_producer';

type ProposedProducer = {
	role: {
		name: string;
		login: true;
		inherit: false;
		connectionLimit: number;
	};
	hyperdrive: {
		id: string;
		instanceId: string;
		originConnectionLimit: number;
	};
	peakConnectionsNeeded: number;
};

export interface ProducerOriginBudgetSnapshot {
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
	proposed: {
		dispatch: ProposedProducer;
		fact: ProposedProducer;
	};
}

type ProposedResult = Readonly<{
	roleName: string;
	roleConnectionLimit: number;
	originId: string;
	originConnectionLimit: number;
	peakConnectionsNeeded: number;
}>;

export interface ProducerOriginBudgetResult {
	readonly kind: 'snapshot-arithmetic-only';
	readonly capturedAt: string;
	readonly instanceId: string;
	readonly normalConnectionCapacity: number;
	readonly existingOriginLimitTotal: number;
	readonly projectedOriginLimitTotal: number;
	readonly nonHyperdriveConnectionBudget: number;
	readonly safetyHeadroomConnections: number;
	readonly configuredSpareConnections: number;
	readonly observedSpareAfterProducerPeaks: number;
	readonly proposed: Readonly<{ dispatch: ProposedResult; fact: ProposedResult }>;
}

export class ProducerOriginBudgetError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'ProducerOriginBudgetError';
	}
}

function fail(code: string): never {
	throw new ProducerOriginBudgetError(code);
}

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
	const object = value as Record<string, unknown>;
	if (Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object, key))) fail(code);
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

// Hyperdrive config and provider instance IDs are opaque and may start with digits.
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
 * Validates two new, distinct direct-login Hyperdrive origins against one
 * complete inventory. `nowMs` is explicit; the function has no I/O.
 */
export function validatePostgresProducerOriginBudget(facts: unknown, nowMs: number): ProducerOriginBudgetResult {
	const root = exactObject(facts, ['schemaVersion', 'capturedAt', 'instance', 'inventory', 'proposed'], 'invalid_budget_snapshot');
	if (root.schemaVersion !== 1) fail('unsupported_budget_snapshot_version');
	if (typeof root.capturedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(root.capturedAt)) {
		fail('invalid_budget_snapshot_time');
	}
	const capturedMs = Date.parse(root.capturedAt as string);
	if (!Number.isFinite(capturedMs) || new Date(capturedMs).toISOString() !== root.capturedAt) fail('invalid_budget_snapshot_time');
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 || capturedMs > nowMs || nowMs - capturedMs > PRODUCER_ORIGIN_BUDGET_MAX_AGE_MS) {
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
	const roles = new Set<string>();
	const limits: number[] = [];
	for (const item of inventory.origins) {
		const origin = exactObject(item, ['id', 'instanceId', 'roleName', 'originConnectionLimit'], 'invalid_existing_origin');
		const id = opaqueId(origin.id, 'invalid_existing_origin_id');
		if (ids.has(id)) fail('duplicate_hyperdrive_origin');
		ids.add(id);
		if (opaqueId(origin.instanceId, 'invalid_existing_origin_instance') !== instanceId) fail('mixed_postgres_instances');
		roles.add(roleName(origin.roleName, 'invalid_existing_origin_role'));
		limits.push(safeCount(origin.originConnectionLimit, 'invalid_existing_origin_limit', PRODUCER_HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT));
	}

	const proposed = exactObject(root.proposed, ['dispatch', 'fact'], 'invalid_proposed_origins');
	function parseProposed(value: unknown, kind: 'dispatch' | 'fact', expectedRole: string): ProposedResult {
		const entry = exactObject(value, ['role', 'hyperdrive', 'peakConnectionsNeeded'], `invalid_${kind}_origin`);
		const role = exactObject(entry.role, ['name', 'login', 'inherit', 'connectionLimit'], `invalid_${kind}_role`);
		const name = roleName(role.name, `invalid_${kind}_role_name`);
		if (name !== expectedRole || role.login !== true || role.inherit !== false) fail(`dedicated_${kind}_login_role_required`);
		if (roles.has(name)) fail('producer_role_reused_by_existing_origin');
		roles.add(name);
		const roleLimit = safeCount(role.connectionLimit, `invalid_${kind}_role_connection_limit`, 1);
		const hyperdrive = exactObject(entry.hyperdrive, ['id', 'instanceId', 'originConnectionLimit'], `invalid_${kind}_hyperdrive`);
		const id = opaqueId(hyperdrive.id, `invalid_${kind}_hyperdrive_id`);
		if (ids.has(id)) fail('duplicate_hyperdrive_origin');
		ids.add(id);
		if (opaqueId(hyperdrive.instanceId, `invalid_${kind}_hyperdrive_instance`) !== instanceId) fail('mixed_postgres_instances');
		const originLimit = safeCount(hyperdrive.originConnectionLimit, `invalid_${kind}_origin_limit`, PRODUCER_HYPERDRIVE_MIN_ORIGIN_CONNECTION_LIMIT);
		const peak = safeCount(entry.peakConnectionsNeeded, `invalid_${kind}_peak_demand`, 1);
		if (peak > roleLimit || roleLimit > originLimit) fail(`${kind}_role_connection_limit_mismatch`);
		return Object.freeze({ roleName: name, roleConnectionLimit: roleLimit, originId: id,
			originConnectionLimit: originLimit, peakConnectionsNeeded: peak });
	}
	const dispatch = parseProposed(proposed.dispatch, 'dispatch', DISPATCH_PRODUCER_ROLE);
	const fact = parseProposed(proposed.fact, 'fact', FACT_PRODUCER_ROLE);
	const existingTotal = checkedSum(limits);
	const projectedTotal = checkedSum([existingTotal, dispatch.originConnectionLimit, fact.originConnectionLimit]);
	const configuredDemand = checkedSum([projectedTotal, nonHyperdrive, headroom]);
	if (configuredDemand > normalCapacity) fail('configured_connection_budget_exceeds_capacity');
	// Observed backends already include existing Hyperdrives and direct clients.
	// Add only the two proposed producer peaks, then preserve explicit headroom.
	const observedDemand = checkedSum([observed, dispatch.peakConnectionsNeeded, fact.peakConnectionsNeeded, headroom]);
	if (observedDemand > normalCapacity) fail('observed_connection_budget_exceeds_capacity');
	return Object.freeze({
		kind: 'snapshot-arithmetic-only', capturedAt: root.capturedAt as string, instanceId,
		normalConnectionCapacity: normalCapacity, existingOriginLimitTotal: existingTotal,
		projectedOriginLimitTotal: projectedTotal, nonHyperdriveConnectionBudget: nonHyperdrive,
		safetyHeadroomConnections: headroom, configuredSpareConnections: normalCapacity - configuredDemand,
		observedSpareAfterProducerPeaks: normalCapacity - observedDemand,
		proposed: Object.freeze({ dispatch, fact }),
	});
}
