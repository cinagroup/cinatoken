/**
 * D1：`system_config`。
 */
import type { D1DatabaseClient } from '../../storage/database-client';
import type { SystemConfigRepository } from '../../storage/gateway-repository-interfaces';
import type { SystemConfigRow } from '../system-config-types';
import { configAuditMetadata } from '../system-config-audit';
import { CONFIG_GROUP_AUDIT_COLUMNS, completeConfigSnapshots, configGroupAuditValues, configRevisionVector, mapConfigGroupAuditRow, prepareConfigGroup, validateConfigGroupAuditPage, validateConfigSnapshotKeys } from '../system-config-group';
import type { ConfigSnapshot, ConfigRevisionVector } from '../system-config-group-types';

const UPSERT_SQL = `INSERT INTO system_config (key, value, description, updated_at, revision)
	VALUES (?, ?, NULL, datetime('now'), ?)
	ON CONFLICT(key) DO UPDATE SET value = excluded.value,
		updated_at = excluded.updated_at, revision = excluded.revision`;
const CAS_INSERT_SQL = `INSERT INTO system_config (key, value, description, updated_at, revision)
	VALUES (?, ?, NULL, datetime('now'), ?) ON CONFLICT(key) DO NOTHING`;
const CAS_UPDATE_SQL = `UPDATE system_config SET value = ?, updated_at = datetime('now'), revision = ?
	WHERE key = ? AND revision = ?`;
const AUDIT_SQL = `INSERT INTO config_change_audit
	(id, config_key, channel, action, actor_kind, actor_id, created_at)
	VALUES (?, ?, ?, ?, ?, ?, ?)`;
const CONDITIONAL_AUDIT_SQL = `INSERT INTO config_change_audit
	(id, config_key, channel, action, actor_kind, actor_id, created_at)
	SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
		(SELECT 1 FROM system_config WHERE key = ? AND revision = ?)`;
// An ignored audit must fail inside the batch, before D1 commits the config.
// SQLite abs(INT64_MIN) deliberately raises; the CASE only evaluates it on failure.
const ASSERT_AUDIT_SQL = `SELECT CASE WHEN
	EXISTS (SELECT 1 FROM system_config WHERE key = ? AND revision = ?)
	AND changes() = 1 AND EXISTS (SELECT 1 FROM config_change_audit WHERE id = ?)
	THEN 1 ELSE abs(-9223372036854775808) END AS config_audit_committed`;
const ASSERT_CONDITIONAL_AUDIT_SQL = `SELECT CASE WHEN
	NOT EXISTS (SELECT 1 FROM system_config WHERE key = ? AND revision = ?)
	OR (changes() = 1 AND EXISTS (SELECT 1 FROM config_change_audit WHERE id = ?))
	THEN 1 ELSE abs(-9223372036854775808) END AS config_audit_committed`;

export function createD1SystemConfigRepository(db: D1DatabaseClient): SystemConfigRepository {
	const raw = db.raw;
	return {
		async getConfigSnapshots(keys) {
			const sorted = validateConfigSnapshotKeys(keys);
			const rows = await raw.prepare(`SELECT key, value, revision FROM system_config WHERE key IN (${sorted.map(() => '?').join(', ')}) ORDER BY key`).bind(...sorted).all<ConfigSnapshot>();
			return completeConfigSnapshots(sorted, rows.results ?? []);
		},
		async applyConfigGroupIfRevisions(input) {
			const { writes, after } = prepareConfigGroup(input);
			const match = (vector: ConfigRevisionVector) => {
				const values: (string | null)[] = [];
				const sql = vector.map(row => {
					values.push(row.key);
					if (row.revision === null) return 'NOT EXISTS (SELECT 1 FROM system_config WHERE key = ?)';
					values.push(row.revision); return 'EXISTS (SELECT 1 FROM system_config WHERE key = ? AND revision = ?)';
				}).join(' AND ');
				return { sql, values };
			};
			const before = match(input.readSet), afterMatch = match(after);
			const needSql = input.safeAudit.action === 'reveal' ? '1' : writes.length
				? writes.map(() => 'NOT EXISTS (SELECT 1 FROM system_config WHERE key = ? AND value COLLATE BINARY IS ?)').join(' OR ') : '0';
			const needValues = input.safeAudit.action === 'reveal' ? [] : writes.flatMap(row => [row.key, row.value]);
			const gate = `(${before.sql}) AND (${needSql})`, gateValues = [...before.values, ...needValues];
			const auditId = input.safeAudit.auditId;
			const statements = [
				raw.prepare(`INSERT INTO config_group_audit (${CONFIG_GROUP_AUDIT_COLUMNS}) SELECT ${Array(15).fill('?').join(', ')} WHERE ${gate}`).bind(...configGroupAuditValues(input, after), ...gateValues),
				raw.prepare(`SELECT CASE WHEN NOT (${gate}) OR (changes() = 1 AND EXISTS (SELECT 1 FROM config_group_audit WHERE id = ?)) THEN 1 ELSE abs(-9223372036854775808) END AS audit_committed`).bind(...gateValues, auditId),
			];
			for (const write of writes) {
				const previous = input.readSet.find(row => row.key === write.key)!;
				statements.push(previous.revision === null
					? raw.prepare(`INSERT INTO system_config (key, value, description, updated_at, revision) SELECT ?, ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM config_group_audit WHERE id = ?) ON CONFLICT(key) DO NOTHING`).bind(write.key, write.value, input.safeAudit.nowIso, write.revision, auditId)
					: raw.prepare(`UPDATE system_config SET value = ?, updated_at = ?, revision = ? WHERE key = ? AND revision = ? AND EXISTS (SELECT 1 FROM config_group_audit WHERE id = ?)`).bind(write.value, input.safeAudit.nowIso, write.revision, write.key, previous.revision, auditId));
				statements.push(raw.prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM config_group_audit WHERE id = ?) OR (changes() = 1 AND EXISTS (SELECT 1 FROM system_config WHERE key = ? AND revision = ? AND value COLLATE BINARY IS ?)) THEN 1 ELSE abs(-9223372036854775808) END AS target_committed`).bind(auditId, write.key, write.revision, write.value));
			}
			const valuesMatch = writes.map(() => 'EXISTS (SELECT 1 FROM system_config WHERE key = ? AND revision = ? AND value COLLATE BINARY IS ?)').join(' AND ') || '1';
			statements.push(raw.prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM config_group_audit WHERE id = ?) OR ((${afterMatch.sql}) AND (${valuesMatch})) THEN 1 ELSE abs(-9223372036854775808) END AS vector_committed`).bind(auditId, ...afterMatch.values, ...writes.flatMap(write => [write.key, write.revision, write.value])));
			statements.push(raw.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM config_group_audit WHERE id = ?) THEN 'applied' WHEN (${before.sql}) THEN 'unchanged' ELSE 'conflict' END AS outcome`).bind(auditId, ...before.values));
			const keys = input.readSet.map(row => row.key);
			statements.push(raw.prepare(`SELECT key, value, revision FROM system_config WHERE key IN (${keys.map(() => '?').join(', ')}) ORDER BY key`).bind(...keys));
			const results = await raw.batch(statements);
			const outcome = (results.at(-2)?.results?.[0] as { outcome?: unknown } | undefined)?.outcome;
			if (outcome !== 'applied' && outcome !== 'unchanged' && outcome !== 'conflict') throw new Error('Invalid config group result');
			const revisionVector = configRevisionVector(completeConfigSnapshots(keys, (results.at(-1)?.results ?? []) as unknown as ConfigSnapshot[]));
			return outcome === 'applied' ? { outcome, auditId, revisionVector } : { outcome, auditId: null, revisionVector };
		},
		async listConfigGroupAudit(family, options) {
			validateConfigGroupAuditPage(family, options);
			const before = options.before;
			const values = before ? [family, before.createdAt, before.createdAt, before.id] : [family];
			const rows = await raw.prepare(`SELECT ${CONFIG_GROUP_AUDIT_COLUMNS} FROM config_group_audit WHERE family = ? ${before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT ${options.limit}`).bind(...values).all<Record<string, unknown>>();
			return (rows.results ?? []).map(mapConfigGroupAuditRow);
		},
		async listSystemConfigRows(): Promise<SystemConfigRow[]> {
			const rows = await raw.prepare('SELECT key, value, description, revision FROM system_config ORDER BY key').all<SystemConfigRow>();
			return rows.results ?? [];
		},

		async upsertSystemConfigValueWithAudit(input): Promise<void> {
			const audit = configAuditMetadata(input);
			const revision = crypto.randomUUID();
			await raw.batch([
				raw.prepare(UPSERT_SQL).bind(input.key, input.value, revision),
				raw.prepare(AUDIT_SQL).bind(
					input.auditId, audit.configKey, audit.channel, audit.action,
					input.actorKind, input.actorId, input.nowIso,
				),
				raw.prepare(ASSERT_AUDIT_SQL).bind(input.key, revision, input.auditId),
			]);
		},

		async upsertSystemConfigValueWithAuditIfRevision(input) {
			const audit = configAuditMetadata(input);
			const revision = crypto.randomUUID();
			const write = input.expectedRevision === null
				? raw.prepare(CAS_INSERT_SQL).bind(input.key, input.value, revision)
				: raw.prepare(CAS_UPDATE_SQL).bind(input.value, revision, input.key, input.expectedRevision);
			const results = await raw.batch([
				write,
				raw.prepare(CONDITIONAL_AUDIT_SQL).bind(
					input.auditId, audit.configKey, audit.channel, audit.action,
					input.actorKind, input.actorId, input.nowIso, input.key, revision,
				),
				raw.prepare(ASSERT_CONDITIONAL_AUDIT_SQL).bind(input.key, revision, input.auditId),
			]);
			if (results[0]?.meta.changes !== 1) return { committed: false, revision: null };
			if (results[1]?.meta.changes !== 1) throw new Error('Config audit did not commit');
			return { committed: true, revision };
		},

		async getConfig(key: string): Promise<string | null> {
			const row = await raw
				.prepare('SELECT value FROM system_config WHERE key = ?')
				.bind(key)
				.first<{ value: string | null }>();
			return row?.value ?? null;
		},

		async getConfigSnapshot(key: string): Promise<{ value: string | null; revision: string | null }> {
			const row = await raw.prepare('SELECT value, revision FROM system_config WHERE key = ?')
				.bind(key).first<{ value: string | null; revision: string }>();
			return { value: row?.value ?? null, revision: row?.revision ?? null };
		},

		async getAllConfig(): Promise<Record<string, string>> {
			const rows = await raw.prepare('SELECT key, value FROM system_config').all<{ key: string; value: string | null }>();
			const out: Record<string, string> = {};
			for (const row of rows.results ?? []) {
				if (row.value != null) out[row.key] = row.value;
			}
			return out;
		},
	};
}
