import { BYOK_D1_CASES, byokD1Fixture, type ByokD1Case } from './byok-d1-acceptance';

export type CleanupRow = Record<string, string | number | null>;
export const BYOK_OWNED_TABLES = ['users', 'workspaces', 'management_api_keys', 'byok_keys', 'user_audit_logs'] as const;
const timestamp = '2026-09-16T00:00:00.000Z';
const provider = 'c02-native-fixture';
const ciphertext = 'enc:v2:synthetic-no-provider-secret';
function check(ok: unknown): asserts ok { if (!ok) throw new Error('byok_cleanup_ownership'); }
function same(actual: CleanupRow, expected: CleanupRow) {
	check(Object.keys(actual).sort().join(',') === Object.keys(expected).sort().join(','));
	for (const key of Object.keys(expected)) check(actual[key] === expected[key]);
}
function time(value: unknown) { check(typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)); return value; }
function expectedKeys(runId: string, caseId: ByokD1Case, rows: CleanupRow[]) {
	const f = byokD1Fixture(runId, caseId), portal = caseId.endsWith('-portal');
	const full = ['compact-management', 'compact-portal', 'full-old-id', 'insert-rollback', 'audit-rollback', 'concurrent-last-slot'].includes(caseId);
	const compact = caseId.startsWith('compact-') || caseId === 'concurrent-last-slot';
	const crud = caseId.startsWith('crud-');
	const expected: CleanupRow[] = [];
	for (let i = 0; i < (full ? 100 : 3); i++) expected.push({
		id: f.key(i), workspace_id: f.workspace, provider, name: caseId === 'changes-contract' && i === 0 ? 'Changed' : `Synthetic ${i}`,
		api_key_encrypted: ciphertext, label: 'synthetic', sort_order: i, disabled: i % 7 === 0 ? 1 : 0,
		is_fallback: i >= 90 ? 1 : 0, allowed_models_json: i % 3 === 0 ? '["synthetic-model"]' : null,
		allowed_user_ids_json: null, allowed_api_key_hashes_json: null, created_by_management_key_id: f.management,
		deleted_at: null, created_at: timestamp, updated_at: timestamp, always_use_for_provider: 0, always_use_for_matching_models: 0,
	});
	if (full && caseId !== 'full-old-id') {
		Object.assign(expected[49]!, { api_key_encrypted: '', label: 'deleted', disabled: 1, deleted_at: timestamp });
		if (compact) for (let i = 50; i < 100; i++) expected[i]!.sort_order = i - 1;
	}
	let inserted = 100;
	if (caseId === 'concurrent-last-slot') {
		const winners = [100, 101].filter(n => rows.some(row => row.id === f.key(n)));
		check(winners.length === 1); inserted = winners[0]!;
	}
	if (compact || crud) expected.push({ id: f.key(inserted), workspace_id: f.workspace, provider,
		name: crud ? 'Updated' : 'Synthetic new', api_key_encrypted: crud ? '' : ciphertext, label: crud ? 'deleted' : 'synthetic',
		sort_order: crud ? 0 : 99, disabled: crud ? 1 : 0, is_fallback: 0,
		allowed_models_json: null, allowed_user_ids_json: null, allowed_api_key_hashes_json: null,
		created_by_management_key_id: portal ? null : f.management, deleted_at: crud ? timestamp : null,
		created_at: timestamp, updated_at: timestamp, always_use_for_provider: 0, always_use_for_matching_models: 0 });
	if (crud) for (let i = 0; i < 3; i++) expected[i]!.sort_order = 3 - i;
	check(rows.length === expected.length);
	for (const row of expected) { const actual = rows.find(r => r.id === row.id); check(actual); same(actual, row); }
	return { inserted, audits: crud ? 4 : compact ? 2 : full && caseId !== 'full-old-id' ? 1 : 0 };
}

/** Independent fixture oracle: exact IDs, every stored field, audit payload and
 * financial zeroes. A public prefix, matching count or synthetic-looking name
 * alone is never authority to delete a row. No output contains credential data.
 */
export function assertByokCleanupOwnership(runId: string, completed: number,
	rows: Record<typeof BYOK_OWNED_TABLES[number], CleanupRow[]>) {
	check(Number.isInteger(completed) && completed >= 0 && completed <= BYOK_D1_CASES.length);
	const wanted = { users: completed, workspaces: completed, management_api_keys: completed, byok_keys: 0, user_audit_logs: 0 };
	for (const caseId of BYOK_D1_CASES.slice(0, completed)) {
		const f = byokD1Fixture(runId, caseId), portal = caseId.endsWith('-portal');
		const u = rows.users.find(r => r.id === f.user), w = rows.workspaces.find(r => r.id === f.workspace), m = rows.management_api_keys.find(r => r.id === f.management);
		check(u && w && m);
		same(u, { id: f.user, email: f.email, status: 'active', budget_max: null, budget_base: 0, budget_spent: 0,
			budget_period: 'none', budget_reset_at: null, metadata: null, external_system: null, external_user_id: null,
			created_at: time(u.created_at), updated_at: time(u.updated_at), charged_cost_factors: null,
			budget_epoch: 0, budget_reserved_micros: 0, budget_spent_micros: 0 });
		same(w, { id: f.workspace, scope_type: 'personal', organization_id: null, personal_owner_user_id: f.user,
			name: 'Synthetic D1 BYOK', slug: 'c02-native', description: null, is_default: 0, default_scope_key: null,
			status: 'active', settings_json: null, created_by_user_id: f.user, created_at: time(w.created_at), updated_at: time(w.updated_at) });
		check(typeof m.key_hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(m.key_hash));
		same(m, { id: f.management, key_hash: m.key_hash, key_preview: 'synthetic-no-key', account_type: 'personal',
			personal_owner_user_id: f.user, organization_id: null, name: 'Synthetic D1 BYOK', status: 'active',
			expires_at: caseId === 'expired-first' ? time(m.expires_at) : null, last_used_at: null, created_by_user_id: f.user,
			created_at: time(m.created_at), updated_at: time(m.updated_at) });
		const keys = rows.byok_keys.filter(r => r.workspace_id === f.workspace);
		const { inserted, audits } = expectedKeys(runId, caseId, keys); wanted.byok_keys += keys.length; wanted.user_audit_logs += audits;
		const audit = rows.user_audit_logs.filter(r => r.user_id === f.user); check(audit.length === audits);
		const actions = audits === 4 ? ['created', 'updated', 'reordered', 'deleted'] : audits === 2 ? ['created', 'deleted'] : audits === 1 ? ['deleted'] : [];
		for (const action of actions) {
			const found = audit.filter(r => r.event_type === `byok_key_${action}`); check(found.length === 1); const a = found[0]!;
			check(typeof a.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.id));
			const id = action === 'deleted' && audits < 4 ? f.key(49) : f.key(inserted);
			const payload = action === 'reordered' ? { resource_type: 'byok_key_order', workspace_id: f.workspace, provider, action,
				keys: [100, 2, 1, 0].map((n, sort_order) => ({ id: f.key(n), is_fallback: false, sort_order })) }
				: { resource_type: 'byok_key', byok_key_id: id, workspace_id: f.workspace, provider, action, changed_fields: action === 'updated' ? ['name'] : [] };
			same(a, { id: a.id, user_id: f.user, api_key_id: null, event_type: `byok_key_${action}`,
				actor_type: portal ? 'user' : 'service', request_log_id: null, change_payload: JSON.stringify(payload),
				before_user_snapshot: null, after_user_snapshot: null, changed_fields: null, correlation_id: null,
				source: portal ? 'gateway_portal_byok' : 'gateway_management_byok',
				actor_id: portal ? `portal:${f.user}` : `service:management_key:${f.management}`, reason_code: `byok_key_${action}`,
				reason_text: `BYOK ${action === 'reordered' ? 'credentials reordered' : `credential ${action}`} ${portal ? 'through the account portal' : 'through Management API'}`,
				created_at: timestamp });
		}
	}
	for (const table of BYOK_OWNED_TABLES) check(rows[table].length === wanted[table]);
	return wanted;
}
