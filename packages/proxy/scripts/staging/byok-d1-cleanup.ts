import type { D1Database, D1Result } from '@cloudflare/workers-types';
import { BYOK_D1_CONTROL_KEY, parseByokD1Control } from './byok-d1-one-shot';
import { assertByokCleanupOwnership, BYOK_OWNED_TABLES, type CleanupRow } from './byok-d1-cleanup-ownership';
import { BYOK_D1_FENCE_KEY, BYOK_D1_FENCE_CLOSED, assertByokD1FenceInstalled, byokD1FenceValue } from './byok-d1-write-fence';

/** Staging-only, opt-in native-binding cleanup primitives. No HTTP entry,
 * provisioning, implicit invocation or production fallback. The trusted caller
 * must pin the deployment/database identity, persist an exclusive attempt and
 * provide independent producer-closure checks. Those facts are NOT inferred
 * from a URL, a control row, local active counters or these local unit tests.
 */
export const BYOK_CLEANUP_TABLES = Object.freeze([
	'admin_api_keys', 'admin_sessions', 'api_key_request_logs', 'api_keys', 'batch_items', 'batches', 'byok_keys',
	'chain_job_transactions', 'd1_migrations', 'generation_feedback', 'guardrail_assignments', 'guardrail_budget_reservations',
	'guardrail_budget_windows', 'guardrail_versions', 'guardrails', 'identity_event_inbox', 'management_api_keys',
	'model_endpoint_backfill_database_identity', 'model_endpoint_backfill_runs', 'model_endpoint_backfill_trust_registry',
	'model_endpoint_evidence_attestations', 'model_endpoint_routes', 'model_endpoints', 'model_routes', 'model_surfaces',
	'model_tags', 'models', 'nft_mints', 'organization_memberships', 'organizations', 'portal_ledger_entries', 'portal_sessions',
	'provider_attempt_availability', 'providers', 'public_model_daily_stats', 'request_dispatch_intents', 'request_preset_versions',
	'request_presets', 'request_usage_commit_receipts', 'request_usage_recovery_jobs', 'request_usage_settlements',
	'route_data_policies', 'route_data_policy_audit', 'route_pool_sticky_bindings', 'route_pools', 'shared_key_earnings',
	'shared_keys', 'system_config', 'user_audit_logs', 'user_budget_reservations', 'user_earnings', 'users', 'withdrawals',
	'workspace_budgets', 'workspace_memberships', 'workspaces',
] as const);
export const BYOK_D1_MAINTENANCE_KEY = 'c02_byok_d1_maintenance_v1';
const preserved = ['admin_api_keys', 'd1_migrations', 'model_endpoint_backfill_database_identity', 'system_config'] as const;
const examined = [...preserved, ...BYOK_OWNED_TABLES];
type Query = { sql: string; params: (string | number | null)[] };
type Counts = Record<string, number>;
type Snapshot = { schema: string; counts: Counts; columns: Record<string, string[]>; rows: Record<string, CleanupRow[]> };
export type ByokCleanupBaseline = { version: 1; schemaSha256: string; counts: Counts; preservedRowSha256: Record<string, string>; fence?: 'write-fence-v1' };
const check = (ok: unknown, code: string): void => { if (!ok) throw new Error(`byok_cleanup_${code}`); };
function assert(ok: unknown, code: string): asserts ok { check(ok, code); }
const bytes = (s: string) => new TextEncoder().encode(s).length;
const sorted = (row: CleanupRow) => Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]]));
const canonical = (rows: CleanupRow[]) => JSON.stringify(rows.map(sorted));
const balanced = (parts: string[]): string => parts.length === 1 ? parts[0]! : `(${balanced(parts.slice(0, parts.length >> 1))} AND ${balanced(parts.slice(parts.length >> 1))})`;
async function sha(value: string) {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function baselineCounts(fenced = false): Counts {
	return { ...Object.fromEntries(BYOK_CLEANUP_TABLES.map(t => [t, 0])), admin_api_keys: 1, d1_migrations: 68,
		model_endpoint_backfill_database_identity: 1, system_config: fenced ? 13 : 12 };
}
function sameCounts(a: Counts, b: Counts) {
	check(Object.keys(a).sort().join(',') === Object.keys(b).sort().join(',') && Object.keys(b).every(k => a[k] === b[k]), 'counts');
}
function results<T>(value: D1Result<T>): T[] {
	check(value.success && Array.isArray(value.results), 'read_ack'); return value.results;
}
const schemaSelect = `SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513`;
const schemaJson = `SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (${schemaSelect})`;
const countsQuery = `SELECT ${BYOK_CLEANUP_TABLES.map(t => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(',')}`;

async function snapshot(db: D1Database, expectedSchemaSha256: string): Promise<Snapshot> {
	assert(/^[a-f0-9]{64}$/.test(expectedSchemaSha256), 'schema_pin');
	const definitions = results(await db.prepare(`SELECT type,name,tbl_name,
		CASE WHEN length(CAST(sql AS BLOB)) <= 16384 THEN sql END AS sql,
		length(CAST(sql AS BLOB)) AS sql_bytes FROM main.sqlite_master
		ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513`).all<Record<string, unknown>>());
	assert(definitions.length > 0 && definitions.length <= 512, 'schema_bound');
	const schemaRows = definitions.map(r => {
		assert(typeof r.type === 'string' && r.type.length <= 16 && typeof r.name === 'string' && r.name.length <= 128
			&& typeof r.tbl_name === 'string' && r.tbl_name.length <= 128, 'schema_fields');
		assert(r.sql_bytes === null && r.sql === null || typeof r.sql_bytes === 'number' && r.sql_bytes <= 16384 && typeof r.sql === 'string', 'schema_sql');
		return { type: r.type, name: r.name, tbl_name: r.tbl_name, sql: r.sql };
	});
	const schema = JSON.stringify(schemaRows); check(bytes(schema) <= 262144 && await sha(schema) === expectedSchemaSha256, 'schema_mismatch');
	const tables = schemaRows.filter(r => r.type === 'table' && !r.name.startsWith('sqlite_') && !r.name.startsWith('_cf_')).map(r => r.name).sort();
	check(tables.join(',') === BYOK_CLEANUP_TABLES.slice().sort().join(','), 'all_tables');
	const countRows = results(await db.prepare(countsQuery).all<Counts>()); assert(countRows.length === 1, 'count_row');
	const counts = countRows[0]!;
	for (const t of BYOK_CLEANUP_TABLES) {
		const max = t === 'byok_keys' ? 1020 : t === 'user_audit_logs' ? 80 : t === 'd1_migrations' ? 68 : t === 'system_config' ? 15
			: BYOK_OWNED_TABLES.some(x => x === t) ? 10 : preserved.some(x => x === t) ? 1 : 0;
		check(Number.isSafeInteger(counts[t]) && counts[t]! >= 0 && counts[t]! <= max, 'foreign_rows');
	}
	const columns: Record<string, string[]> = {}, rows: Record<string, CleanupRow[]> = {};
	const descriptions = await db.batch(examined.map(t => db.prepare(`PRAGMA table_info(${t})`)));
	check(descriptions.length === examined.length, 'column_ack');
	for (let i = 0; i < examined.length; i++) {
		const info = results(descriptions[i]!) as Record<string, unknown>[];
		check(info.length > 0 && info.length <= 100 && info.some(c => typeof c.pk === 'number' && c.pk > 0), 'primary_key');
		columns[examined[i]!] = info.map(c => { assert(typeof c.name === 'string' && /^[a-z][a-z0-9_]*$/.test(c.name), 'column_name'); return c.name; });
	}
	const reads = await db.batch(examined.map(t => {
		const names = columns[t]!;
		// SQL-side per-row bound, before D1 serializes data into the Worker.
		const size = names.map(n => `COALESCE(length(CAST(${n} AS BLOB)),0)`).join('+');
		return db.prepare(`SELECT ${names.join(',')} FROM ${t} WHERE (${size}) <= ${t === 'system_config' ? 65536 : 8192} ORDER BY ${names.join(',')} LIMIT ?`).bind(counts[t]! + 1);
	}));
	check(reads.length === examined.length, 'row_ack'); let totalBytes = 0;
	for (let i = 0; i < examined.length; i++) {
		const table = examined[i]!, data = results(reads[i]!) as Record<string, unknown>[];
		check(data.length === counts[table], 'row_bound');
		rows[table] = data.map(row => {
			check(Object.keys(row).sort().join(',') === columns[table]!.slice().sort().join(','), 'row_columns');
			const copy: CleanupRow = {};
			for (const [k, v] of Object.entries(row)) { assert(v === null || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v), 'row_value'); copy[k] = v; }
			return copy;
		});
		totalBytes += bytes(canonical(rows[table]!)); check(totalBytes <= 1_048_576, 'snapshot_bound');
	}
	return { schema, counts, columns, rows };
}

/** Capture BEFORE arming any fixture. Only digests/counts leave this function;
 * static config/admin values never appear in journal events or return values.
 */
export async function captureByokD1CleanupBaseline(db: D1Database, expectedSchemaSha256: string, fence?: 'write-fence-v1'): Promise<ByokCleanupBaseline> {
	check(fence === undefined || fence === 'write-fence-v1', 'fence_mode');
	const current = await snapshot(db, expectedSchemaSha256); sameCounts(current.counts, baselineCounts(!!fence));
	if (fence) assertByokD1FenceInstalled(JSON.parse(current.schema), current.rows.system_config!);
	check(current.rows.admin_api_keys?.[0]?.status === 'revoked', 'legacy_admin_live');
	const preservedRowSha256: Record<string, string> = {};
	for (const t of preserved) preservedRowSha256[t] = await sha(canonical(current.rows[t]!));
	return { version: 1, schemaSha256: expectedSchemaSha256, counts: current.counts, preservedRowSha256, ...(fence ? { fence } : {}) };
}
const guard = (condition: string, params: Query['params']): Query => ({ sql: `SELECT CASE WHEN ${condition} THEN 1 ELSE json('byok_cleanup_changed') END AS cleanup_guard`, params });
function exactRows(table: string, names: string[], rows: CleanupRow[]): Query {
	// One JSON parameter avoids per-row statements and the 100-parameter limit.
	// PKs plus full-field equality make the counted join an exact row-set check.
	const predicate = balanced(names.map(n => `t.${n} COLLATE BINARY IS json_extract(e.value,'$.${n}') COLLATE BINARY`));
	return guard(`(SELECT COUNT(*) FROM ${table}) = ? AND (SELECT COUNT(*) FROM ${table} t JOIN json_each(?) e ON ${predicate}) = ?`,
		[rows.length, canonical(rows), rows.length]);
}

export function createByokD1Cleanup(options: {
	db: D1Database; baseline: ByokCleanupBaseline; runId: string;
	assertProducerClosed: () => Promise<void>;
	persist: (event: Record<string, unknown>) => Promise<void>;
	/** Trusted receiver only: exact already-claimed durable permit. Never a public
	 * skip-list; one fixed key is retained, checked in full and never deleted. */
	maintenanceValue?: string;
}) {
	const { db, assertProducerClosed, persist } = options, baseline = structuredClone(options.baseline), runId = options.runId;
	const maintenanceValue = options.maintenanceValue;
	const withoutMaintenance = (rows: CleanupRow[]) => maintenanceValue === undefined ? rows : rows.filter(r => r.key !== BYOK_D1_MAINTENANCE_KEY);
	function checkMaintenance(rows: CleanupRow[]) {
		if (maintenanceValue === undefined) return;
		const permits = rows.filter(r => r.key === BYOK_D1_MAINTENANCE_KEY);
		check(permits.length === 1 && permits[0]!.value === maintenanceValue, 'maintenance_drift');
	}
	let running: Promise<ReturnType<typeof report>> | undefined;
	const state = { result: 'NOT_RUN', stage: 'validate', deleteAttempted: false, deleteAcknowledged: false,
		fixtureRemoved: false, removedRows: 0, statementCount: 0, statementBytes: 0, nativeAcceptanceProved: false };
	function report() { return { ...state }; }
	async function execute() {
		try {
			check(/^c02-byok-[a-f0-9]{12}$/.test(runId) && baseline.version === 1, 'scope');
			check(baseline.fence === undefined || baseline.fence === 'write-fence-v1', 'fence_mode');
			check(maintenanceValue === undefined || baseline.fence === 'write-fence-v1'
				&& typeof maintenanceValue === 'string' && maintenanceValue.length <= 16384 && /^[\x20-\x7e]+$/.test(maintenanceValue), 'maintenance');
			sameCounts(baseline.counts, baselineCounts(!!baseline.fence));
			const postCounts: Counts = { ...baseline.counts, system_config: baseline.counts.system_config! + (maintenanceValue === undefined ? 0 : 1) };
			check(Object.keys(baseline.preservedRowSha256).sort().join(',') === preserved.slice().sort().join(','), 'baseline_rows');
			state.stage = 'producer-closure'; await assertProducerClosed();
			state.stage = 'snapshot'; const current = await snapshot(db, baseline.schemaSha256);
			if (baseline.fence) assertByokD1FenceInstalled(JSON.parse(current.schema), current.rows.system_config!);
			checkMaintenance(current.rows.system_config!);
			state.stage = 'ownership';
			const controls = current.rows.system_config!.filter(r => r.key === BYOK_D1_CONTROL_KEY);
			assert(controls.length === 1 && typeof controls[0]!.value === 'string', 'control');
			const control = parseByokD1Control(controls[0]!.value);
			check(control.runId === runId && control.state === 'stopped' && control.pendingCase === null
				&& control.receipts.length === control.cursor && control.receipts.every(r => r.outcome === 'PASS'), 'quarantine');
			const owned = { users: current.rows.users!, workspaces: current.rows.workspaces!, management_api_keys: current.rows.management_api_keys!,
				byok_keys: current.rows.byok_keys!, user_audit_logs: current.rows.user_audit_logs! };
			const ownedCounts = assertByokCleanupOwnership(runId, control.cursor, owned);
			const expected: Counts = { ...postCounts, ...ownedCounts, system_config: postCounts.system_config! + 1 }; sameCounts(current.counts, expected);
			const kept: Record<string, CleanupRow[]> = {};
			for (const t of preserved) {
				kept[t] = t === 'system_config' ? current.rows[t]!.filter(r => r.key !== BYOK_D1_CONTROL_KEY) : current.rows[t]!;
				check(await sha(canonical(t === 'system_config' ? withoutMaintenance(kept[t]!) : kept[t]!)) === baseline.preservedRowSha256[t], 'baseline_drift');
			}
			state.stage = 'plan';
			const plan: Query[] = [guard(`(${schemaJson}) IS ?`, [current.schema]),
				...BYOK_CLEANUP_TABLES.map(t => guard(`(SELECT COUNT(*) FROM ${t}) = ?`, [expected[t]!])),
				...examined.map(t => exactRows(t, current.columns[t]!, current.rows[t]!))];
			const deletes = ['user_audit_logs', 'byok_keys', 'management_api_keys', 'workspaces', 'users', 'system_config'];
			const cleaningValue = baseline.fence ? byokD1FenceValue('cleaning', runId) : null;
			if (cleaningValue) plan.push({ sql: 'UPDATE system_config SET value = ? WHERE key = ? AND value = ?',
				params: [cleaningValue, BYOK_D1_FENCE_KEY, BYOK_D1_FENCE_CLOSED] }, guard('changes() = ?', [1]));
			for (const table of deletes) {
				const key = table === 'system_config' ? 'key' : 'id';
				const ids = table === 'system_config' ? [BYOK_D1_CONTROL_KEY] : current.rows[table]!.map(r => r[key]);
				plan.push({ sql: `DELETE FROM ${table} WHERE ${key} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(ids)] },
					guard('changes() = ?', [ids.length]));
			}
			// Open deletion only inside THIS native transaction, then restore the
			// persistent closed marker before commit. Late work never observes an
			// externally committed cleaning state. Trigger definitions stay pinned.
			if (cleaningValue) plan.push({ sql: 'UPDATE system_config SET value = ? WHERE key = ? AND value = ?',
				params: [BYOK_D1_FENCE_CLOSED, BYOK_D1_FENCE_KEY, cleaningValue] }, guard('changes() = ?', [1]));
			plan.push(...BYOK_CLEANUP_TABLES.map(t => guard(`(SELECT COUNT(*) FROM ${t}) = ?`, [postCounts[t]!])),
				...preserved.map(t => exactRows(t, current.columns[t]!, kept[t]!)), guard(`(${schemaJson}) IS ?`, [current.schema]));
			state.statementCount = plan.length; state.statementBytes = bytes(JSON.stringify(plan));
			check(plan.length <= 256 && state.statementBytes <= 1_048_576 && plan.every(q => q.params.length <= 100 && bytes(q.sql) <= 100000), 'plan_bound');
			state.stage = 'fresh-closure'; await assertProducerClosed(); const closedAt = performance.now();
			state.stage = 'pending-journal'; await persist({ step: 'byok-cleanup', result: 'PENDING', runId,
				completedCases: control.cursor, statementCount: plan.length, statementSha256: await sha(JSON.stringify(plan)) });
			check(performance.now() - closedAt < 15000, 'stale_closure');
			state.stage = 'delete'; state.deleteAttempted = true;
			const ack = await db.batch(plan.map(q => db.prepare(q.sql).bind(...q.params)));
			check(ack.length === plan.length && ack.every((r, i) => {
				const first = r.results[0];
				return r.success && (plan[i]!.sql.startsWith('SELECT') ? r.results.length === 1 && typeof first === 'object'
					&& first !== null && 'cleanup_guard' in first && first.cleanup_guard === 1 : r.meta.changes === plan[i + 1]!.params[0]);
			}), 'delete_ack');
			state.deleteAcknowledged = true;
			state.stage = 'post-read'; const after = await snapshot(db, baseline.schemaSha256); sameCounts(after.counts, postCounts);
			checkMaintenance(after.rows.system_config!);
			for (const t of preserved) check(await sha(canonical(t === 'system_config' ? withoutMaintenance(after.rows[t]!) : after.rows[t]!)) === baseline.preservedRowSha256[t], 'post_row_drift');
			state.stage = 'post-closure'; await assertProducerClosed();
			state.removedRows = Object.values(ownedCounts).reduce((a, b) => a + b, 0) + 1;
			state.fixtureRemoved = true; state.result = 'CLEANED';
			state.stage = 'ack-journal'; await persist({ step: 'byok-cleanup', result: 'ACK', runId, report: report() });
		} catch { state.result = 'ATTENTION_REQUIRED'; }
		return report();
	}
	return Object.freeze({ run: () => running ??= execute(), report });
}
