import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { createD1DatabaseClient } from '../../../core/src/storage/database-client';
import { createByokKeysRepository } from '../../../core/src/storage/byok-keys';
import type { ByokMutationPrincipal } from '../../../core/src/db/byok-keys-types';

/** Opt-in synthetic acceptance operations, NOT an HTTP handler or deploy tool.
 * The caller must prove staging identity, reserve cost, own an exclusive attempt,
 * and arrange containment before invoking this module. No import-time I/O.
 * Product SQL is forwarded unchanged to the provided binding. Local SQLite can
 * test the oracle but cannot turn its receipt into native Cloudflare evidence.
 */
export const BYOK_D1_CASES = Object.freeze([
	'changes-contract', 'compact-management', 'compact-portal', 'full-old-id',
	'expired-first', 'insert-rollback', 'audit-rollback', 'crud-management',
	'crud-portal', 'concurrent-last-slot',
] as const);
export type ByokD1Case = typeof BYOK_D1_CASES[number];
const provider = 'c02-native-fixture';
const syntheticCiphertext = 'enc:v2:synthetic-no-provider-secret';
const timestamp = '2026-09-16T00:00:00.000Z';

function check(condition: unknown, code: string): asserts condition {
	if (!condition) throw new Error(`byok_acceptance_${code}`);
}
function same(left: unknown, right: unknown, code: string) {
	check(JSON.stringify(left) === JSON.stringify(right), code);
}
export function byokD1Fixture(runId: string, caseId: ByokD1Case) {
	check(/^c02-byok-[a-f0-9]{12}$/.test(runId), 'run_id');
	const index = BYOK_D1_CASES.indexOf(caseId);
	check(index >= 0, 'case_id');
	const prefix = `${runId}-${index}`;
	return Object.freeze({ prefix, user: `${prefix}-u`, workspace: `${prefix}-w`,
		management: `${prefix}-m`, email: `${prefix}@example.invalid`,
		key: (slot: number) => {
			check(Number.isInteger(slot) && slot >= 0 && slot <= 101, 'slot_id');
			return `${prefix}-k${String(101 - slot).padStart(3, '0')}`;
		},
	});
}
type Fixture = ReturnType<typeof byokD1Fixture>;
type StoredRow = Record<string, string | number | null> & {
	id: string; provider: string; sort_order: number; api_key_encrypted: string;
};
type AuditRow = { event_type: string; change_payload: string; source: string; actor_type: string };
type BatchMeta = { changes: number; rowsRead: number; rowsWritten: number };

function metadata(result: D1Result): BatchMeta {
	check(result.success, 'd1_failure');
	const m = result.meta;
	for (const value of [m.changes, m.rows_read, m.rows_written])
		check(Number.isSafeInteger(value) && value >= 0, 'd1_metadata');
	return { changes: m.changes, rowsRead: m.rows_read, rowsWritten: m.rows_written };
}
function observeBatches(db: D1Database, batches: BatchMeta[][]) {
	// Bind every other method to the native object; do not copy internal slots,
	// rewrite statements, insert clock probes or split the transaction.
	const batch: D1Database['batch'] = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
		const result = await db.batch<T>(statements);
		batches.push(result.map(metadata));
		return result;
	};
	return new Proxy(db, {
		get(target, property) {
			if (property === 'batch') return batch;
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}
function principal(f: Fixture, portal: boolean): ByokMutationPrincipal {
	const account = { accountType: 'personal' as const, personalOwnerUserId: f.user, organizationId: null };
	return portal ? { ...account, principalType: 'portal_user', userId: f.user, workspaceId: f.workspace }
		: { ...account, keyId: f.management, createdByUserId: f.user };
}
function input(f: Fixture) {
	return { workspaceId: f.workspace, provider, name: 'Synthetic new', apiKey: syntheticCiphertext,
		label: 'synthetic', disabled: false, isFallback: false, alwaysUseForProvider: false,
		alwaysUseForMatchingModels: false, allowedModels: null, allowedUserIds: null, allowedApiKeyHashes: null };
}
async function keys(db: D1Database, f: Fixture) {
	const result = await db.prepare('SELECT * FROM byok_keys WHERE workspace_id = ? ORDER BY sort_order, id LIMIT 103')
		.bind(f.workspace).all<StoredRow>();
	check(result.success && result.results.length <= 102, 'key_bound');
	return result.results;
}
async function audits(db: D1Database, f: Fixture) {
	const result = await db.prepare(`SELECT event_type, change_payload, source, actor_type FROM user_audit_logs
		WHERE user_id = ? ORDER BY created_at, id LIMIT 9`).bind(f.user).all<AuditRow>();
	check(result.success && result.results.length <= 8, 'audit_bound');
	for (const row of result.results) {
		check(!JSON.stringify(row).includes('enc:v2:'), 'audit_ciphertext');
		check(JSON.parse(row.change_payload).workspace_id === f.workspace, 'audit_workspace');
	}
	return result.results;
}
async function seed(db: D1Database, f: Fixture, count: number) {
	// Plain INSERTs are exclusive reservations: a repeated case fails instead of
	// resetting or overwriting a possibly unfinished previous experiment.
	// No usable management token is issued by this fixture. Store the digest of
	// ephemeral random bytes, not a predictable token derived from a public ID.
	const digest = await crypto.subtle.digest('SHA-256', crypto.getRandomValues(new Uint8Array(32)));
	const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
	const statements = [
		db.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'active')").bind(f.user, f.email),
		db.prepare(`INSERT INTO workspaces(id,scope_type,personal_owner_user_id,name,slug,status,created_by_user_id)
			VALUES(?,'personal',?,'Synthetic D1 BYOK','c02-native','active',?)`).bind(f.workspace, f.user, f.user),
		db.prepare(`INSERT INTO management_api_keys(id,key_hash,key_preview,account_type,personal_owner_user_id,
			name,status,created_by_user_id) VALUES(?,?,'synthetic-no-key','personal',?,'Synthetic D1 BYOK','active',?)`)
			.bind(f.management, `sha256:${hash}`, f.user, f.user),
	];
	for (let slot = 0; slot < count; slot++) statements.push(db.prepare(`INSERT INTO byok_keys
		(id,workspace_id,provider,name,api_key_encrypted,label,sort_order,disabled,is_fallback,
		allowed_models_json,created_by_management_key_id,created_at,updated_at)
		VALUES(?,?,?,?,?,'synthetic',?,?,?, ?,?,?,?)`).bind(f.key(slot), f.workspace, provider,
		`Synthetic ${slot}`, syntheticCiphertext, slot, slot % 7 === 0 ? 1 : 0,
		slot >= 90 ? 1 : 0, slot % 3 === 0 ? '["synthetic-model"]' : null, f.management, timestamp, timestamp));
	// Keep each batch under the conservative 100-bound-parameter per statement
	// limit. There are at most 103 bounded statements and 100 synthetic BYOK rows.
	const results = await db.batch(statements);
	check(results.length === statements.length && results.every(r => metadata(r).changes === 1), 'seed');
}

export async function runByokD1Case(db: D1Database, runId: string, caseId: ByokD1Case) {
	const f = byokD1Fixture(runId, caseId), batches: BatchMeta[][] = [];
	const observed = observeBatches(db, batches);
	const repo = createByokKeysRepository(createD1DatabaseClient(observed));
	const portal = caseId.endsWith('-portal'), actor = principal(f, portal);
	const full = ['compact-management', 'compact-portal', 'full-old-id', 'insert-rollback', 'audit-rollback', 'concurrent-last-slot'].includes(caseId);
	await seed(db, f, full ? 100 : 3);
	const original = await keys(db, f);
	const create = (slot = 100, mutationPrincipal = actor, label = 'synthetic') => repo.insertForManagement({
		principal: mutationPrincipal, id: f.key(slot), nowIso: timestamp, input: { ...input(f), label },
	});
	let expectedAudits = 0;
	if (caseId === 'changes-contract') {
		const result = await db.batch([
			db.prepare('UPDATE byok_keys SET name = ? WHERE id = ? AND workspace_id = ?').bind('Changed', f.key(0), f.workspace),
			db.prepare('SELECT changes() AS previous_changes'),
			db.prepare('UPDATE byok_keys SET name = ? WHERE id = ? AND workspace_id = ?').bind('Absent', f.key(101), f.workspace),
			db.prepare('SELECT changes() AS previous_changes'),
		]);
		check(result.length === 4, 'changes_length');
		same(result[1]!.results, [{ previous_changes: 1 }], 'changes_one');
		same(result[3]!.results, [{ previous_changes: 0 }], 'changes_zero');
		batches.push(result.map(metadata));
	} else if (full && caseId !== 'full-old-id') {
		check(await repo.deleteForManagement({ principal: actor, id: f.key(49), nowIso: timestamp }), 'delete_hole');
		expectedAudits = 1;
		const before = await keys(db, f);
		if (caseId === 'insert-rollback' || caseId === 'audit-rollback') {
			let rejected = false;
			try {
				const faultActor = caseId === 'audit-rollback' ? { ...principal(f, false), createdByUserId: `${f.prefix}-absent` } : actor;
				await create(100, faultActor, caseId === 'insert-rollback' ? 'x' : 'synthetic');
			} catch (error) {
				// A timeout/transport rejection proves no rollback. Require the
				// specific SQL constraint we intentionally violated, then reread.
				const expected = caseId === 'insert-rollback' ? 'byok_keys_label_chk' : 'FOREIGN KEY constraint failed';
				rejected = error instanceof Error && error.message.includes(expected);
			}
			check(rejected, 'fault_must_reject');
			same(await keys(db, f), before, 'rollback_all_rows');
		} else {
			if (caseId === 'concurrent-last-slot') {
				// Drain both native operations even if either rejects; an early
				// Promise.all rejection must not race operator cleanup.
				const settled = await Promise.allSettled([create(100), create(101)]);
				const result = settled.map(r => { check(r.status === 'fulfilled', 'concurrent_rejection'); return r.value; });
				check(result.filter(Boolean).length === 1 && result.filter(r => r === null).length === 1, 'last_slot_winner');
			} else check((await create())?.id === f.key(100), 'created');
			expectedAudits = 2;
			const after = await keys(db, f), live = after.filter(r => r.deleted_at === null);
			check(live.length === 100, 'live_capacity');
			same(live.map(r => r.sort_order), Array.from({ length: 100 }, (_, i) => i), 'dense_slots');
			const survivors = original.filter(r => r.id !== f.key(49));
			for (let i = 0; i < survivors.length; i++) same(live[i], { ...survivors[i], sort_order: i }, 'metadata_preserved');
			same(after.find(r => r.id === f.key(49)), before.find(r => r.id === f.key(49)), 'tombstone_preserved');
		}
	} else if (caseId === 'full-old-id') {
		check(await create(0) === null, 'full_rejected');
		same(await keys(db, f), original, 'full_unchanged');
		check(batches.length === 1 && batches[0]!.every(m => m.changes === 0), 'full_zero_changes');
	} else if (caseId === 'expired-first') {
		await db.prepare("UPDATE management_api_keys SET expires_at = datetime('now', '-1 second') WHERE id = ?").bind(f.management).run();
		check(await create() === null, 'expired_create');
		check(await repo.updateForManagement({ principal: actor, id: f.key(0), nowIso: timestamp, patch: { name: 'Denied' } }) === null, 'expired_update');
		check(await repo.deleteForManagement({ principal: actor, id: f.key(0), nowIso: timestamp }) === false, 'expired_delete');
		check(await repo.reorderForManagement({ principal: actor, nowIso: timestamp, input: {
			workspaceId: f.workspace, provider, keys: [2, 1, 0].map(n => ({ id: f.key(n), isFallback: false })),
		} }) === 'not_found', 'expired_reorder');
		same(await keys(db, f), original, 'expired_unchanged');
		check(batches.every(b => b.every(m => m.changes === 0)), 'expired_zero_changes');
	} else {
		check((await create())?.id === f.key(100), 'plain_create');
		check((await repo.updateForManagement({ principal: actor, id: f.key(100), nowIso: timestamp, patch: { name: 'Updated' } }))?.name === 'Updated', 'update');
		check(await repo.reorderForManagement({ principal: actor, nowIso: timestamp, input: {
			workspaceId: f.workspace, provider, keys: [100, 2, 1, 0].map(n => ({ id: f.key(n), isFallback: false })),
		} }) === 'updated', 'reorder');
		same((await keys(db, f)).map(r => r.id), [100, 2, 1, 0].map(f.key), 'reorder_sequence');
		check(await repo.deleteForManagement({ principal: actor, id: f.key(100), nowIso: timestamp }), 'delete');
		expectedAudits = 4;
		const deleted = (await keys(db, f)).find(r => r.id === f.key(100));
		check(deleted?.api_key_encrypted === '' && deleted.disabled === 1 && deleted.deleted_at === timestamp, 'delete_wiped');
	}
	const audit = await audits(db, f);
	check(audit.length === expectedAudits, 'exact_audits');
	const expectedEvents = expectedAudits === 4 ? ['created', 'updated', 'reordered', 'deleted']
		: expectedAudits === 2 ? ['deleted', 'created'] : expectedAudits === 1 ? ['deleted'] : [];
	same(audit.map(a => a.event_type).sort(), expectedEvents.map(a => `byok_key_${a}`).sort(), 'audit_events');
	check(audit.every(a => a.actor_type === (portal ? 'user' : 'service')
		&& a.source === (portal ? 'gateway_portal_byok' : 'gateway_management_byok')), 'audit_actor');
	check((await keys(db, f)).every(r => r.provider === provider), 'temporary_provider_absent');
	return { caseId, result: 'PASS' as const, expectedAudits, batches,
		// Deliberately no "native" flag: only a bound deployment plus receipt can
		// establish where this code ran. No simulated mid-batch clock is provided.
		midBatchWallClockExpiryVerified: false };
}

/** Exact fixture removal, for an operator AFTER request quiescence and receipt
 * verification. Not automatic finally cleanup: preserve failed-state evidence.
 * Every deletion is tied to the generated user/workspace, never a prefix LIKE.
 */
export async function cleanupByokD1Case(db: D1Database, runId: string, caseId: ByokD1Case) {
	const f = byokD1Fixture(runId, caseId);
	const owned = await db.prepare(`SELECT u.id FROM users u JOIN workspaces w ON w.personal_owner_user_id = u.id
		JOIN management_api_keys m ON m.personal_owner_user_id = u.id
		WHERE u.id = ? AND u.email = ? AND w.id = ? AND w.scope_type = 'personal'
		AND w.organization_id IS NULL AND m.id = ? AND m.account_type = 'personal'
		AND m.organization_id IS NULL LIMIT 2`).bind(f.user, f.email, f.workspace, f.management).all();
	check(owned.success && owned.results.length === 1, 'cleanup_ownership');
	const extra = await db.prepare(`SELECT
		(SELECT COUNT(*) FROM byok_keys WHERE workspace_id = ?) AS byok_count,
		(SELECT COUNT(*) FROM user_audit_logs WHERE user_id = ?) AS audit_count,
		(SELECT COUNT(*) FROM workspaces WHERE personal_owner_user_id = ? AND id <> ?) AS extra_workspaces,
		(SELECT COUNT(*) FROM management_api_keys WHERE personal_owner_user_id = ? AND id <> ?) AS extra_management,
		(SELECT COUNT(*) FROM api_keys WHERE user_id = ?) AS inference_keys`)
		.bind(f.workspace, f.user, f.user, f.workspace, f.user, f.management, f.user).first<Record<string, number>>();
	check(extra && extra.byok_count! <= 102 && extra.audit_count! <= 8
		&& extra.extra_workspaces === 0 && extra.extra_management === 0 && extra.inference_keys === 0, 'cleanup_bound');
	const results = await db.batch([
		db.prepare('DELETE FROM user_audit_logs WHERE user_id = ?').bind(f.user),
		db.prepare('DELETE FROM byok_keys WHERE workspace_id = ?').bind(f.workspace),
		db.prepare('DELETE FROM management_api_keys WHERE id = ? AND personal_owner_user_id = ?').bind(f.management, f.user),
		db.prepare('DELETE FROM workspaces WHERE id = ? AND personal_owner_user_id = ?').bind(f.workspace, f.user),
		db.prepare('DELETE FROM users WHERE id = ? AND email = ?').bind(f.user, f.email),
	]);
	same(results.map(r => metadata(r).changes), [extra.audit_count, extra.byok_count, 1, 1, 1], 'cleanup_counts');
	return { caseId, result: 'PASS' as const, changes: results.map(r => r.meta.changes) };
}
