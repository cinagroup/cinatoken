import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	CONFIG_CUTOVER_D1_MIGRATION,
	CONFIG_CUTOVER_POSTGRES_MIGRATION,
	CONFIG_CUTOVER_RECONCILE_SPECS,
	CONFIG_CUTOVER_TARGET_COLUMN_QUERY,
	configCutoverCheckLabel,
	configCutoverTargetColumns,
	countConfigCutoverBatchMismatches,
	missingConfigCutoverTargetTables,
} from './config-cutover-reconcile';
import { ETL_TABLE_ORDER, ETL_TABLES_TO_TRUNCATE, ETL_TARGET_ONLY_TABLES, TABLE_CONFLICT_KEYS } from './migration-tables';

function source(path: string): string {
	return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

test('both D1-to-Postgres ETL paths include Config audit in preflight, transfer, truncate and row-count reconciliation', () => {
	assert.equal(CONFIG_CUTOVER_D1_MIGRATION, '0076_tools_config_group_audit.sql');
	assert.equal(CONFIG_CUTOVER_POSTGRES_MIGRATION, '0081_tools_config_group_audit.sql');
	assert.match(CONFIG_CUTOVER_TARGET_COLUMN_QUERY, /information_schema\.columns/u);
	const allTargetColumns = CONFIG_CUTOVER_RECONCILE_SPECS.flatMap((spec) =>
		spec.columns.map((column) => ({ table_name: spec.table, column_name: column })));
	assert.deepEqual(missingConfigCutoverTargetTables(allTargetColumns), []);
	assert.deepEqual(missingConfigCutoverTargetTables(
		allTargetColumns.filter((column) => column.column_name !== 'revision')),
		['system_config']);
	assert.deepEqual(missingConfigCutoverTargetTables(
		allTargetColumns.filter((column) => column.column_name !== 'created_at')),
		['config_change_audit', 'admin_access_key_audit', 'admin_shared_key_audit', 'config_group_audit']);
	const configIndex = ETL_TABLE_ORDER.indexOf('system_config');
	assert.equal(ETL_TABLE_ORDER[configIndex + 1], 'config_change_audit');
	assert.deepEqual(TABLE_CONFLICT_KEYS.config_change_audit, ['id']);
	assert.ok(ETL_TABLES_TO_TRUNCATE.includes('config_change_audit'));
	assert.equal(ETL_TABLE_ORDER[configIndex + 2], 'config_group_audit');
	assert.deepEqual(TABLE_CONFLICT_KEYS.config_group_audit, ['id']);
	assert.ok(ETL_TABLES_TO_TRUNCATE.includes('config_group_audit'));
	assert.deepEqual(ETL_TARGET_ONLY_TABLES, ['system_config_write_mutex']);
	assert.equal((ETL_TABLE_ORDER as readonly string[]).includes('system_config_write_mutex'), false);
	assert.equal((ETL_TABLES_TO_TRUNCATE as readonly string[]).includes('system_config_write_mutex'), false);
	assert.equal(ETL_TABLE_ORDER[ETL_TABLE_ORDER.indexOf('admin_api_keys') + 1], 'admin_access_key_audit');
	assert.deepEqual(TABLE_CONFLICT_KEYS.admin_access_key_audit, ['id']);
	assert.ok(ETL_TABLES_TO_TRUNCATE.includes('admin_access_key_audit'));
	assert.equal(ETL_TABLE_ORDER[ETL_TABLE_ORDER.indexOf('shared_keys') + 1], 'admin_shared_key_audit');
	assert.deepEqual(TABLE_CONFLICT_KEYS.admin_shared_key_audit, ['id']);
	assert.ok(ETL_TABLES_TO_TRUNCATE.includes('admin_shared_key_audit'));

	const preflight = source('../cutover/preflight-d1-source.ts');
	assert.match(preflight, /SOURCE_D1_REQUIRED_TABLES = \[\s*\.\.\.ETL_TABLE_ORDER/u);
	for (const path of ['../cutover/etl-d1-to-postgres.ts', '../cutover/d1-postgres-etl-worker.ts']) {
		const script = source(path);
		assert.match(script, /assertConfigCutoverSourceReady\(/u, path);
		assert.match(script, /CONFIG_CUTOVER_POSTGRES_MIGRATION/u, path);
		assert.match(script, /spec\.columns\.some\(\(column\) => !columns\.has\(column\)\)/u, path);
		assert.match(script, /missingConfigCutoverTargetTables\(targetColumns\)/u, path);
		assert.match(script, /for \(const tableName of ETL_TABLE_ORDER\)/u, path);
		assert.match(script, /ETL_TABLES_TO_TRUNCATE/u, path);
		assert.match(script, /TABLE_CONFLICT_KEYS\[tableName\]/u, path);
		assert.match(script, /: sourceColumns/u, path);
	}
	for (const path of ['../cutover/reconcile-d1-postgres.ts', '../cutover/d1-postgres-etl-worker.ts']) {
		const script = source(path);
		assert.match(script, /assertConfigCutoverSourceReady\(/u, path);
		assert.match(script, /ETL_TABLE_ORDER\.map\(\(table\)/u, path);
		assert.match(script, /countConfigCutoverBatchMismatches\(spec, sourceRows, targetRows\)/u, path);
		assert.match(script, /missingConfigCutoverTargetTables\(targetColumns\)/u, path);
	}
});

test('integration-key audit cutover compares every safe metadata column and microsecond without key content', () => {
	const spec = CONFIG_CUTOVER_RECONCILE_SPECS[2];
	assert.equal(configCutoverCheckLabel(spec), 'admin_access_key_audit:metadata_exact');
	const row: Record<string, unknown> = { id: 'audit-id', key_id: 'integration-key', action: 'rotated', change_mask: 8,
		actor_kind: 'console', actor_id: 'console:operator', before_permissions_json: '["logs.read"]',
		after_permissions_json: '["logs.read"]', before_status: 'active', after_status: 'active', created_at: '2026-09-30T00:00:00.000123Z' };
	assert.equal(countConfigCutoverBatchMismatches(spec, [row], [{ ...row }]), 0);
	for (const column of spec.columns) assert.equal(countConfigCutoverBatchMismatches(spec, [row], [{ ...row, [column]: column === 'created_at' ? '2026-09-30T00:00:00.000124Z' : 'changed' }]), 1, column);
	assert.ok(!spec.columns.some((column) => /secret|hash|prefix|description|name/u.test(column)));
});

test('Tools group audit cutover preserves all metadata bytes, nulls, complete actors and microseconds', () => {
	const spec = CONFIG_CUTOVER_RECONCILE_SPECS.find((entry) => entry.table === 'config_group_audit');
	assert.ok(spec);
	const expectedColumns = ['id', 'family', 'provider', 'action', 'actor_kind', 'actor_id', 'reason',
		'changed_fields_json', 'active_before', 'active_after', 'credentials_json',
		'revision_before_json', 'revision_after_json', 'source', 'created_at'];
	assert.deepEqual(spec.columns, expectedColumns);
	assert.equal(configCutoverCheckLabel(spec), 'config_group_audit:metadata_exact');
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(source('../../../packages/core/migrations-d1/0076_tools_config_group_audit.sql'));
		assert.deepEqual(database.prepare('PRAGMA table_info(config_group_audit)').all().map((column) => column.name), expectedColumns);
		assert.deepEqual(database.prepare('PRAGMA foreign_key_list(config_group_audit)').all(), []);
		assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'system_config_write_mutex'").get()?.n, 0);
		const values = ['tools-history', 'web-search', 'tavily', 'save_activate', 'console',
			`console:cinaauth:${'A'.repeat(600)}`, 'Operator reviewed — 操作確認',
			'[ {"provider":"tavily","field":"charged"} ]', null, 'tavily',
			'[{"provider":"tavily","field":"apiKey","operation":"keep","configuredBefore":true,"configuredAfter":true}]',
			'[{"key":"BILLING_CURRENCY","revision":null},{"key":"WEB_SEARCH_CATALOG_JSON","revision":"legacy"}]',
			'[{"key":"BILLING_CURRENCY","revision":null},{"key":"WEB_SEARCH_CATALOG_JSON","revision":"1b36b1d4-cd04-45c5-a71a-9ebd06c289e7"}]',
			'admin_api', '2026-10-01T01:02:03.123456Z'];
		database.prepare(`INSERT INTO config_group_audit (${expectedColumns.join(', ')}) VALUES (${expectedColumns.map(() => '?').join(', ')})`).run(...values);
		const rows = database.prepare(`SELECT ${expectedColumns.join(', ')} FROM config_group_audit`).all() as Record<string, unknown>[];
		assert.equal(String(rows[0]?.actor_id).length, 617);
		const target: Record<string, unknown> = { ...rows[0], created_at: '2026-10-01T01:02:03.123456+00:00' };
		assert.equal(countConfigCutoverBatchMismatches(spec, rows, [target]), 0);
		for (const column of expectedColumns) {
			const drift = column === 'created_at' ? '2026-10-01T01:02:03.123457Z' : 'changed';
			assert.equal(countConfigCutoverBatchMismatches(spec, rows, [{ ...target, [column]: drift }]), 1, column);
		}
		assert.equal(countConfigCutoverBatchMismatches(spec, rows, [{ ...target, actor_id: String(target.actor_id).slice(0, 600) }]), 1);
		assert.equal(countConfigCutoverBatchMismatches(spec, rows, [{ ...target, changed_fields_json: '[{"provider":"tavily","field":"charged"}]' }]), 1, 'JSON semantic equality must not hide byte drift');
		assert.equal(countConfigCutoverBatchMismatches(spec, rows, [{ ...target, active_before: '' }]), 1, 'null must not become empty');
		assert.equal(countConfigCutoverBatchMismatches(spec, rows, []), 1);
		for (const column of expectedColumns) {
			const available: Array<{ table_name: string; column_name: string }> = CONFIG_CUTOVER_RECONCILE_SPECS.flatMap((entry) => entry.columns.map((name) => ({ table_name: entry.table, column_name: name })))
				.filter((entry) => entry.table_name !== spec.table || entry.column_name !== column);
			assert.deepEqual(missingConfigCutoverTargetTables(available), ['config_group_audit'], column);
		}
		assert.match(configCutoverTargetColumns(spec, (name) => `"${name}"`), /SS\.US/u);
		for (const driver of ['postgres', 'mysql']) {
			const migration = source(`../../../packages/core/migrations-${driver}/${driver === 'postgres' ? '0081' : '0074'}_tools_config_group_audit.sql`);
			for (const name of ['changed_fields_json', 'credentials_json', 'revision_before_json', 'revision_after_json'])
				assert.match(migration, new RegExp(`\\b${name}\\s+TEXT\\s+NOT NULL`, 'u'));
			assert.match(migration, /INSERT INTO (?:cinatoken_gateway\.)?system_config_write_mutex \(id\) VALUES \(1\)/u);
		}
	} finally { database.close(); }
});

test('integration-key cutover preserves the complete standard OIDC actor and detects drift beyond the old255 boundary', () => {
	const spec = CONFIG_CUTOVER_RECONCILE_SPECS[2];
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(source('../../../packages/core/migrations-d1/0072_admin_access_key_audit.sql'));
		const subject = 'Aa/Case%2F'.repeat(30).slice(0, 254) + 'Z';
		const actor = `console:cinaauth:${subject}`;
		assert.equal(subject.length, 255);
		assert.equal(actor.length, 272);
		const values = ['audit-long-actor', 'integration-key', 'revealed', 0, 'console', actor,
			'["logs.read"]', '["logs.read"]', 'active', 'active', '2026-09-30T00:00:00.123456Z'];
		database.prepare(`INSERT INTO admin_access_key_audit (${spec.columns.join(', ')}) VALUES (${spec.columns.map(() => '?').join(', ')})`)
			.run(...values);
		const rows = database.prepare(`SELECT ${spec.columns.join(', ')} FROM admin_access_key_audit`).all() as Record<string, unknown>[];
		assert.equal(rows[0]?.actor_id, actor);
		const target = { ...rows[0], change_mask: '0', created_at: '2026-09-30T00:00:00.123456+00:00' };
		assert.equal(countConfigCutoverBatchMismatches(spec, rows, [target]), 0);
		for (const changedActor of [actor.slice(0, 255), actor.slice(0, -1) + 'z', actor.toLowerCase()]) {
			assert.equal(countConfigCutoverBatchMismatches(spec, rows, [{ ...target, actor_id: changedActor }]), 1);
		}
		assert.equal(countConfigCutoverBatchMismatches(spec, rows, [{ ...target, created_at: '2026-09-30T00:00:00.123457Z' }]), 1);
	} finally { database.close(); }
});

test('shared-key audit cutover retains detached history and detects drift in every governance metadata column', () => {
	const spec = CONFIG_CUTOVER_RECONCILE_SPECS.find((entry) => entry.table === 'admin_shared_key_audit');
	assert.ok(spec);
	const expectedColumns = ['id', 'key_id', 'action', 'change_mask', 'actor_kind', 'actor_id', 'source', 'reason',
		'before_status', 'before_seller_priority', 'before_weight', 'before_validated',
		'after_status', 'after_seller_priority', 'after_weight', 'after_validated',
		'before_revision', 'after_revision', 'created_at'];
	assert.deepEqual(spec.columns, expectedColumns);
	assert.equal(configCutoverCheckLabel(spec), 'admin_shared_key_audit:metadata_exact');
	assert.ok(!spec.columns.some((column) => /secret|cipher|fingerprint|price|label|api_key/u.test(column)));
	const db = new DatabaseSync(':memory:');
	try {
		db.exec('PRAGMA foreign_keys = ON; CREATE TABLE shared_keys (id TEXT PRIMARY KEY, seller_priority INTEGER, weight INTEGER)');
		db.exec(source('../../../packages/core/migrations-d1/0074_admin_shared_key_audit.sql'));
		const columns = db.prepare('PRAGMA table_info(admin_shared_key_audit)').all() as { name: string }[];
		assert.deepEqual(columns.map((column) => column.name), expectedColumns);
		assert.deepEqual(db.prepare('PRAGMA foreign_key_list(admin_shared_key_audit)').all(), []);
		db.prepare('INSERT INTO shared_keys VALUES (?, ?, ?)').run('shared-key', -2, 10);
		const beforeRevision = `sha256:${'a'.repeat(64)}`;
		const afterRevision = `sha256:${'b'.repeat(64)}`;
		const values = ['audit-1', 'shared-key', 'disabled', 1, 'console', 'console:operator', 'admin_api', 'operator reviewed',
			'active', -2, 10, 1, 'disabled', -2, 10, 1, beforeRevision, afterRevision, '2026-09-30T00:00:00.000123Z'];
		db.prepare(`INSERT INTO admin_shared_key_audit (${expectedColumns.join(', ')}) VALUES (${expectedColumns.map(() => '?').join(', ')})`)
			.run(...values);
		db.prepare('DELETE FROM shared_keys WHERE id = ?').run('shared-key');
		db.exec('BEGIN');
		db.exec(source('../../../packages/core/migrations-d1/0075_admin_shared_key_actor_bounds.sql'));
		db.exec('COMMIT');
		assert.deepEqual(db.prepare('PRAGMA table_info(admin_shared_key_audit)').all().map((column) => column.name), expectedColumns);
		assert.deepEqual(db.prepare('PRAGMA foreign_key_list(admin_shared_key_audit)').all(), []);
		const rows = db.prepare(`SELECT ${expectedColumns.join(', ')} FROM admin_shared_key_audit`).all() as Record<string, unknown>[];
		assert.equal(rows.length, 1);
		assert.equal(countConfigCutoverBatchMismatches(spec, rows, [{ ...rows[0], change_mask: '1', before_validated: '1' }]), 0);
		for (const column of spec.columns) {
			const drift = column === 'created_at' ? '2026-09-30T00:00:00.000124Z' : 'changed';
			assert.equal(countConfigCutoverBatchMismatches(spec, rows, [{ ...rows[0], [column]: drift }]), 1, column);
		}
		const deleted = { ...rows[0], action: 'deleted', change_mask: 8, after_status: null, after_seller_priority: null,
			after_weight: null, after_validated: null, after_revision: null };
		assert.equal(countConfigCutoverBatchMismatches(spec, [deleted], [{ ...deleted }]), 0);
		assert.equal(countConfigCutoverBatchMismatches(spec, [deleted], [{ ...deleted, after_revision: beforeRevision }]), 1);
		assert.equal(countConfigCutoverBatchMismatches(spec, rows, []), 1);
		const longActor = `console:cinaauth:${'s'.repeat(600)}`;
		assert.equal(longActor.length, 617);
		db.prepare(`INSERT INTO admin_shared_key_audit (${expectedColumns.join(', ')}) VALUES (${expectedColumns.map(() => '?').join(', ')})`)
			.run(...values.map((value, index) => index === 0 ? 'audit-long' : index === 5 ? longActor : value));
		const longRows = db.prepare(`SELECT ${expectedColumns.join(', ')} FROM admin_shared_key_audit WHERE id = ?`)
			.all('audit-long') as Record<string, unknown>[];
		assert.equal(longRows[0].actor_id, longActor);
		assert.equal(longRows[0].created_at, values[18]);
		assert.equal(countConfigCutoverBatchMismatches(spec, longRows, [{ ...longRows[0] }]), 0);
		assert.equal(countConfigCutoverBatchMismatches(spec, longRows,
			[{ ...longRows[0], actor_id: `${longActor.slice(0, -1)}x` }]), 1);
		assert.throws(() => countConfigCutoverBatchMismatches(spec, rows, [rows[0], rows[0]]), /duplicate_config_cutover_target_identity/u);
		assert.match(configCutoverTargetColumns(spec, (column) => `"${column}"`), /to_char\("created_at" AT TIME ZONE 'UTC'/u);
	} finally {
		db.close();
	}
});

test('D1 Config values, revisions and audit metadata compare without exposing configuration values', () => {
	const db = new DatabaseSync(':memory:');
	try {
		db.exec('CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT, updated_at TEXT)');
		db.exec(source('../../../packages/core/migrations-d1/0069_config_change_audit.sql'));
		db.exec(source('../../../packages/core/migrations-d1/0070_system_config_revision.sql'));
		db.prepare('INSERT INTO system_config (key, value, revision) VALUES (?, ?, ?)')
			.run('BUSINESS_TIMEZONE', 'not-exported', 'revision-1');
		db.prepare(`INSERT INTO config_change_audit
			(id, config_key, channel, action, actor_kind, actor_id, outcome, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
			'audit-1', 'BUSINESS_TIMEZONE', null, 'set', 'console', 'actor-1', 'committed',
			'2026-09-28T08:00:00.123456Z',
		);

		const [configSpec, auditSpec] = CONFIG_CUTOVER_RECONCILE_SPECS;
		const configRows = db.prepare(`SELECT ${configSpec.columns.join(', ')} FROM system_config`)
			.all() as Record<string, unknown>[];
		const auditRows = db.prepare(`SELECT ${auditSpec.columns.join(', ')} FROM config_change_audit`)
			.all() as Record<string, unknown>[];
		assert.deepEqual(configSpec.columns, ['key', 'value', 'revision']);
		assert.equal(configRows[0]?.value, 'not-exported');
		assert.equal(configCutoverCheckLabel(configSpec), 'system_config:value_revision_exact');
		assert.equal(configCutoverCheckLabel(auditSpec), 'config_change_audit:metadata_exact');
		assert.equal(configCutoverCheckLabel(configSpec).includes('not-exported'), false);
		assert.equal(countConfigCutoverBatchMismatches(configSpec, configRows, [{ ...configRows[0] }]), 0);
		assert.equal(countConfigCutoverBatchMismatches(configSpec, configRows,
			[{ ...configRows[0], value: 'different-secret' }]), 1);
		assert.equal(countConfigCutoverBatchMismatches(configSpec, configRows,
			[{ ...configRows[0], revision: 'revision-2' }]), 1);
		assert.equal(countConfigCutoverBatchMismatches(auditSpec, auditRows,
			[{ ...auditRows[0], created_at: '2026-09-28T08:00:00.123456Z' }]), 0);
		assert.equal(countConfigCutoverBatchMismatches(auditSpec,
			[{ ...auditRows[0], created_at: '2026-09-28T08:00:00.000Z' }],
			[{ ...auditRows[0], created_at: '2026-09-28T08:00:00.000000Z' }]), 0);
		assert.equal(countConfigCutoverBatchMismatches(auditSpec,
			[{ ...auditRows[0], created_at: '2026-09-28T16:00:00.123456+08:00' }],
			[{ ...auditRows[0], created_at: '2026-09-28T08:00:00.123456Z' }]), 0);
		assert.equal(countConfigCutoverBatchMismatches(auditSpec,
			[{ ...auditRows[0], created_at: '2026-09-28T08:00:00.123Z' }],
			[{ ...auditRows[0], created_at: new Date('2026-09-28T08:00:00.123Z') }]), 0);
		assert.equal(countConfigCutoverBatchMismatches(auditSpec, auditRows,
			[{ ...auditRows[0], created_at: '2026-09-28T08:00:00.123457Z' }]), 1);
		assert.equal(countConfigCutoverBatchMismatches(auditSpec, auditRows,
			[{ ...auditRows[0], actor_id: 'other-actor' }]), 1);
		for (const column of ['id', 'config_key', 'channel', 'action', 'actor_kind', 'outcome'] as const) {
			assert.equal(countConfigCutoverBatchMismatches(auditSpec, auditRows,
				[{ ...auditRows[0], [column]: 'changed' }]), 1, column);
		}
		assert.equal(countConfigCutoverBatchMismatches(auditSpec, auditRows, []), 1);
		assert.throws(() => countConfigCutoverBatchMismatches(auditSpec,
			[{ ...auditRows[0], created_at: 'invalid' }], [{ ...auditRows[0] }]),
			/invalid_config_cutover_timestamp/u);
		assert.throws(() => countConfigCutoverBatchMismatches(auditSpec,
			[{ ...auditRows[0] }], [{ ...auditRows[0], created_at: null }]),
			/invalid_config_cutover_timestamp/u);
		assert.match(configCutoverTargetColumns(auditSpec, (column) => `"${column}"`),
			/to_char\("created_at" AT TIME ZONE 'UTC'/u);
	} finally {
		db.close();
	}
});
