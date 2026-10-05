/**
 * MySQL：`system_config`。
 */
import { eq } from 'drizzle-orm';
import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { SystemConfigRepository } from '../../storage/gateway-repository-interfaces';
import { systemConfigTable as mySystemConfigTable } from '../../storage/drizzle/schema.mysql';
import type { SystemConfigRow } from '../system-config-types';
import { asMySqlPool, toMySqlDateTime } from './mysql2-compat';
import { configAuditMetadata } from '../system-config-audit';
import { CONFIG_GROUP_AUDIT_COLUMNS, completeConfigSnapshots, configGroupAuditValues, mapConfigGroupAuditRow, prepareConfigGroup, validateConfigGroupAuditPage, validateConfigSnapshotKeys } from '../system-config-group';
import { applyLockedConfigGroup } from '../system-config-group-transaction';
import type { ConfigSnapshot } from '../system-config-group-types';
import type { MySqlConnectionLike } from './mysql2-compat';

async function lockConfigMutex(connection: MySqlConnectionLike) {
	const [rows] = await connection.execute<{ id: number }[]>('SELECT id FROM system_config_write_mutex WHERE id = 1 FOR UPDATE', []);
	if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== 1) throw new Error('Config write mutex unavailable');
}

const UPSERT_SQL = `INSERT INTO system_config (\`key\`, value, description, updated_at, revision)
	VALUES (?, ?, NULL, ?, ?)
	ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at),
		revision = VALUES(revision)`;
const CAS_INSERT_SQL = `INSERT INTO system_config (\`key\`, value, description, updated_at, revision)
	VALUES (?, ?, NULL, ?, ?)`;
const CAS_UPDATE_SQL = `UPDATE system_config SET value = ?, updated_at = ?, revision = ?
	WHERE \`key\` = ? AND revision = ?`;
const AUDIT_SQL = `INSERT INTO config_change_audit
	(id, config_key, channel, action, actor_kind, actor_id, created_at)
	VALUES (?, ?, ?, ?, ?, ?, ?)`;

function affectedRows(result: unknown): number {
	if (typeof result !== 'object' || result === null || !('affectedRows' in result) ||
		typeof result.affectedRows !== 'number') throw new Error('Invalid MySQL config write result');
	return result.affectedRows;
}

function duplicateKey(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY';
}

export function createMySqlSystemConfigRepository(db: MySqlDatabaseClient): SystemConfigRepository {
	const drizzle = db.drizzle;
	const pool = asMySqlPool(db.raw);
	return {
		async getConfigSnapshots(keys) {
			const sorted = validateConfigSnapshotKeys(keys);
			const [rows] = await pool.execute<ConfigSnapshot[]>(`SELECT \`key\`, value, revision FROM system_config WHERE \`key\` IN (${sorted.map(() => '?').join(', ')}) ORDER BY \`key\``, sorted);
			return completeConfigSnapshots(sorted, rows);
		},
		async applyConfigGroupIfRevisions(input) {
			const prepared = prepareConfigGroup(input), connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				const result = await applyLockedConfigGroup(input, prepared, {
					lock: () => lockConfigMutex(connection),
					read: async keys => { const [rows] = await connection.execute<ConfigSnapshot[]>(`SELECT \`key\`, value, revision FROM system_config WHERE \`key\` IN (${keys.map(() => '?').join(', ')}) ORDER BY \`key\` FOR UPDATE`, [...keys]); return rows; },
					write: async (write, revision) => {
						const [metadata] = await connection.execute(revision === null ? CAS_INSERT_SQL : CAS_UPDATE_SQL, revision === null
							? [write.key, write.value, toMySqlDateTime(input.safeAudit.nowIso), write.revision]
							: [write.value, toMySqlDateTime(input.safeAudit.nowIso), write.revision, write.key, revision]);
						if (affectedRows(metadata) !== 1) throw new Error('Config group target did not commit');
					},
					audit: async () => {
						const values = configGroupAuditValues(input, prepared.after); values[14] = values[14]!.slice(0, -1).replace('T', ' ');
						const [metadata] = await connection.execute(`INSERT INTO config_group_audit (${CONFIG_GROUP_AUDIT_COLUMNS}) VALUES (${Array(15).fill('?').join(', ')})`, values);
						if (affectedRows(metadata) !== 1) throw new Error('Config group audit did not commit');
					},
				});
				await connection.commit(); return result;
			} catch (error) { await connection.rollback(); throw error; }
			finally { connection.release(); }
		},
		async listConfigGroupAudit(family, options) {
			validateConfigGroupAuditPage(family, options);
			const before = options.before;
			const stamp = before?.createdAt.slice(0, -1).replace('T', ' ');
			const values = before ? [family, stamp!, stamp!, before.id] : [family];
			const [rows] = await pool.execute<Record<string, unknown>[]>(`SELECT ${CONFIG_GROUP_AUDIT_COLUMNS.replace('created_at', "DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at")} FROM config_group_audit WHERE family = ? ${before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY config_group_audit.created_at DESC, id DESC LIMIT ${options.limit}`, values);
			return rows.map(mapConfigGroupAuditRow);
		},
		async listSystemConfigRows(): Promise<SystemConfigRow[]> {
			return drizzle
				.select({
					key: mySystemConfigTable.key,
					value: mySystemConfigTable.value,
					description: mySystemConfigTable.description,
					revision: mySystemConfigTable.revision,
				})
				.from(mySystemConfigTable)
				.orderBy(mySystemConfigTable.key);
		},

		async upsertSystemConfigValueWithAudit(input): Promise<void> {
			const audit = configAuditMetadata(input);
			const revision = crypto.randomUUID();
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				await lockConfigMutex(connection);
				const [configResult] = await connection.execute(UPSERT_SQL, [input.key, input.value, toMySqlDateTime(input.nowIso), revision]);
				if (![1, 2].includes(affectedRows(configResult))) throw new Error('Config write did not commit');
				const [auditResult] = await connection.execute(AUDIT_SQL, [
					input.auditId, audit.configKey, audit.channel, audit.action,
					input.actorKind, input.actorId, toMySqlDateTime(input.nowIso),
				]);
				if (affectedRows(auditResult) !== 1) throw new Error('Config audit did not commit');
				await connection.commit();
			} catch (error) {
				await connection.rollback();
				throw error;
			} finally {
				connection.release();
			}
		},

		async upsertSystemConfigValueWithAuditIfRevision(input) {
			const audit = configAuditMetadata(input);
			const revision = crypto.randomUUID();
			const connection = await pool.getConnection();
			let inTransaction = false;
			try {
				await connection.beginTransaction();
				inTransaction = true;
				await lockConfigMutex(connection);
				let result: unknown;
				if (input.expectedRevision === null) {
					try {
						[result] = await connection.execute(CAS_INSERT_SQL, [
							input.key, input.value, toMySqlDateTime(input.nowIso), revision,
						]);
					} catch (error) {
						if (!duplicateKey(error)) throw error;
						await connection.rollback();
						inTransaction = false;
						return { committed: false, revision: null };
					}
				} else {
					[result] = await connection.execute(CAS_UPDATE_SQL, [
						input.value, toMySqlDateTime(input.nowIso), revision,
						input.key, input.expectedRevision,
					]);
				}
				if (affectedRows(result) !== 1) {
					await connection.rollback();
					inTransaction = false;
					return { committed: false, revision: null };
				}
				const [auditResult] = await connection.execute(AUDIT_SQL, [
					input.auditId, audit.configKey, audit.channel, audit.action,
					input.actorKind, input.actorId, toMySqlDateTime(input.nowIso),
				]);
				if (affectedRows(auditResult) !== 1) throw new Error('Config audit did not commit');
				await connection.commit();
				inTransaction = false;
				return { committed: true, revision };
			} catch (error) {
				if (inTransaction) await connection.rollback();
				throw error;
			} finally {
				connection.release();
			}
		},

		async getConfig(key: string): Promise<string | null> {
			const row = await drizzle
				.select({ value: mySystemConfigTable.value })
				.from(mySystemConfigTable)
				.where(eq(mySystemConfigTable.key, key))
				.limit(1);
			return row[0]?.value ?? null;
		},

		async getConfigSnapshot(key: string): Promise<{ value: string | null; revision: string | null }> {
			const rows = await drizzle
				.select({ value: mySystemConfigTable.value, revision: mySystemConfigTable.revision })
				.from(mySystemConfigTable)
				.where(eq(mySystemConfigTable.key, key))
				.limit(1);
			return rows[0] ?? { value: null, revision: null };
		},

		async getAllConfig(): Promise<Record<string, string>> {
			const rows = await drizzle.select({ key: mySystemConfigTable.key, value: mySystemConfigTable.value }).from(mySystemConfigTable);
			const out: Record<string, string> = {};
			for (const row of rows) {
				if (row.value != null) out[row.key] = row.value;
			}
			return out;
		},
	};
}
