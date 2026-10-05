import { and, desc, eq, gt, lte } from 'drizzle-orm';
import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { AdminAccessRepository } from '../../storage/gateway-repository-interfaces';
import { hashLookupKey, matchesLookupKeyHash } from '../../lib/key-hash';
import {
	adminApiKeysTable,
	adminSessionsTable,
} from '../../storage/drizzle/schema.mysql';
import type { AdminApiKeyRow, AdminSessionRow } from '../admin-access-types';
import { asMySqlPool, toMySqlDateTime } from './mysql2-compat';
import { ADMIN_API_KEY_AUDIT_CHANGE, mapAdminApiKeyAuditRow, validateAdminApiKeyAuditContext, type AdminApiKeyAuditSqlRow } from '../admin-access-audit';
import { ADMIN_KEY_COLUMNS, ADMIN_KEY_AUDIT_COLUMNS, adminKeyAuditValues, adminKeyPatchAuditValues,
	adminKeyCreateMask, adminKeyAuditCursorMySqlTime, mapAdminKeySqlRow, validateAdminKeyAuditLimit, validateAdminKeyPermissions,
	type AdminApiKeySqlRow } from '../admin-access-sql';

function mapKey(row: typeof adminApiKeysTable.$inferSelect): AdminApiKeyRow {
	return { ...row, status: row.status === 'revoked' ? 'revoked' : 'active' };
}

function mapSession(row: typeof adminSessionsTable.$inferSelect): AdminSessionRow {
	return row;
}

export function createMySqlAdminAccessRepository(db: MySqlDatabaseClient): AdminAccessRepository {
	const drizzle = db.drizzle;
	const pool = asMySqlPool(db.raw);
	const auditSql = `INSERT INTO admin_access_key_audit (${ADMIN_KEY_AUDIT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
	const writeAudit = async (connection: Awaited<ReturnType<typeof pool.getConnection>>, values: (string | number | null)[]) => {
		const [result] = await connection.execute<{ affectedRows: number }>(auditSql, values);
		if (result?.affectedRows !== 1) throw new Error('Admin API key audit did not commit');
	};
	const targetError = () => new Error('Admin API key target did not commit');
	const affected = (result: unknown): unknown => result !== null && typeof result === 'object' && !Array.isArray(result)
		? (result as { affectedRows?: unknown }).affectedRows : undefined;
	const confirmUpdate = async (connection: Awaited<ReturnType<typeof pool.getConnection>>, id: string,
		result: unknown, expected: Record<string, string | null>) => {
		if (affected(result) === 1) return;
		if (affected(result) !== 0) throw targetError();
		// Clients may disable FOUND_ROWS. A changed-row count of zero is valid
		// only when the locked row already contains every requested assignment.
		// String aliases preserve all six fractional digits even when mysql2 returns
		// TIMESTAMP columns as Date objects (which would discard microseconds).
		const [rows] = await connection.execute(`SELECT ${ADMIN_KEY_COLUMNS}, secret_key_hash,
			DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS target_updated_at_exact,
			DATE_FORMAT(revoked_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS target_revoked_at_exact
			FROM admin_api_keys WHERE id = ? FOR UPDATE`, [id]);
		if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== id) throw targetError();
		const row = rows[0] as Record<string, unknown>;
		for (const [column, wanted] of Object.entries(expected)) {
			if (column === 'updated_at' || column === 'revoked_at') {
				const actual = row[`target_${column}_exact`];
				if (wanted === null) { if (actual !== null) throw targetError(); continue; }
				if (typeof actual !== 'string') throw targetError();
				try {
					// Compare with the exact DATETIME(6) value sent by the write,
					// rather than normalizing the stored value through millisecond Date.
					if (actual !== `${toMySqlDateTime(wanted).replace(' ', 'T')}Z`) throw targetError();
				} catch { throw targetError(); }
			} else if (row[column] !== wanted) throw targetError();
		}
	};
	// Key row lock serializes lifecycle changes and the matching before/after audit snapshot.
	const transaction = async <T>(operation: (connection: Awaited<ReturnType<typeof pool.getConnection>>) => Promise<T>): Promise<T> => {
		const connection = await pool.getConnection();
		try {
			await connection.beginTransaction();
			const result = await operation(connection);
			await connection.commit();
			return result;
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally { connection.release(); }
	};
	const getById = async (id: string): Promise<AdminApiKeyRow | null> => {
		const row = await drizzle.select().from(adminApiKeysTable).where(eq(adminApiKeysTable.id, id)).limit(1);
		return row[0] ? mapKey(row[0]) : null;
	};
	return {
		async listApiKeys() {
			return (await drizzle.select().from(adminApiKeysTable).orderBy(desc(adminApiKeysTable.createdAt))).map(mapKey);
		},
		async getApiKeyById(id) {
			return getById(id);
		},
		async getActiveApiKeyBySecret(secretKey) {
			// 审计 M2-2：哈希优先查找；miss 回退明文（迁移窗口），命中即惰性回填。
			const hash = await hashLookupKey(secretKey);
			const byHash = await drizzle.select().from(adminApiKeysTable)
				.where(and(eq(adminApiKeysTable.secretKeyHash, hash), eq(adminApiKeysTable.status, 'active'))).limit(1);
			if (byHash[0] && await matchesLookupKeyHash(byHash[0].secretKey, hash)) return mapKey(byHash[0]);
			const row = await drizzle.select().from(adminApiKeysTable)
				.where(and(eq(adminApiKeysTable.secretKey, secretKey), eq(adminApiKeysTable.status, 'active'))).limit(1);
			if (!row[0]) return null;
			await drizzle.update(adminApiKeysTable).set({ secretKeyHash: hash })
				.where(eq(adminApiKeysTable.id, row[0].id));
			return mapKey(row[0]);
		},
		async insertApiKey(params, audit) {
			validateAdminApiKeyAuditContext(audit);
			validateAdminKeyPermissions(params.permissionsJson);
			const hash = await hashLookupKey(params.secretKey);
			await transaction(async (connection) => {
				const [result] = await connection.execute(`INSERT INTO admin_api_keys
					(id, name, description, secret_key, key_prefix, permissions_json, secret_key_hash, status, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [params.id, params.name, params.description ?? null,
					params.secretKey, params.keyPrefix, params.permissionsJson, hash, toMySqlDateTime(audit.nowIso), toMySqlDateTime(audit.nowIso)]);
				if (affected(result) !== 1) throw targetError();
				const values = adminKeyAuditValues(params.id, 'created', adminKeyCreateMask(params.description), audit, null, { permissionsJson: params.permissionsJson });
				values[10] = toMySqlDateTime(audit.nowIso);
				await writeAudit(connection, values);
			});
		},
		async updateApiKey(id, patch, audit) {
			validateAdminApiKeyAuditContext(audit);
			validateAdminKeyPermissions(patch.permissionsJson);
			if (Object.keys(patch).length === 0) return false;
			const secretKeyHash = patch.secretKey === undefined
				? undefined
				: await hashLookupKey(patch.secretKey);
			return transaction(async (connection) => {
				const [rows] = await connection.execute(`SELECT ${ADMIN_KEY_COLUMNS} FROM admin_api_keys WHERE id = ? FOR UPDATE`, [id]);
				const before = (rows as AdminApiKeySqlRow[])[0];
				if (!before) return false;
				const sets: string[] = []; const values: (string | null)[] = [];
				const expected: Record<string, string | null> = { updated_at: audit.nowIso };
				for (const [field, column] of [['name', 'name'], ['description', 'description'], ['permissionsJson', 'permissions_json'], ['status', 'status'], ['revokedAt', 'revoked_at']] as const) {
					const value = patch[field];
					if (value !== undefined) { sets.push(`${column} = ?`); values.push(field === 'revokedAt' && value !== null ? toMySqlDateTime(value) : value); expected[column] = value; }
				}
				if (patch.secretKey !== undefined) {
					sets.push('secret_key = ?', 'secret_key_hash = ?', 'key_prefix = ?'); values.push(patch.secretKey, secretKeyHash!, patch.secretKey.slice(0, 12));
					Object.assign(expected, { secret_key: patch.secretKey, secret_key_hash: secretKeyHash!, key_prefix: patch.secretKey.slice(0, 12) });
				}
				sets.push('updated_at = ?'); values.push(toMySqlDateTime(audit.nowIso));
				const [result] = await connection.execute(`UPDATE admin_api_keys SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
				await confirmUpdate(connection, id, result, expected);
				const auditValues = adminKeyPatchAuditValues(id, audit, before, patch); auditValues[10] = toMySqlDateTime(audit.nowIso);
				await writeAudit(connection, auditValues);
				return true;
			});
		},
		async rotateApiKey(id, secretKey, audit) {
			validateAdminApiKeyAuditContext(audit);
			const hash = await hashLookupKey(secretKey);
			return transaction(async (connection) => {
				const [rows] = await connection.execute(`SELECT ${ADMIN_KEY_COLUMNS} FROM admin_api_keys WHERE id = ? AND status = 'active' FOR UPDATE`, [id]);
				const before = (rows as AdminApiKeySqlRow[])[0]; if (!before) return false;
				const [result] = await connection.execute('UPDATE admin_api_keys SET secret_key = ?, secret_key_hash = ?, key_prefix = ?, updated_at = ? WHERE id = ?',
					[secretKey, hash, secretKey.slice(0, 12), toMySqlDateTime(audit.nowIso), id]);
				await confirmUpdate(connection, id, result, { secret_key: secretKey, secret_key_hash: hash, key_prefix: secretKey.slice(0, 12), updated_at: audit.nowIso });
				const values = adminKeyAuditValues(id, 'rotated', ADMIN_API_KEY_AUDIT_CHANGE.secret, audit, before, {}); values[10] = toMySqlDateTime(audit.nowIso);
				await writeAudit(connection, values); return true;
			});
		},
		async revokeApiKey(id, audit) {
			validateAdminApiKeyAuditContext(audit);
			return transaction(async (connection) => {
				const [rows] = await connection.execute(`SELECT ${ADMIN_KEY_COLUMNS} FROM admin_api_keys WHERE id = ? AND status = 'active' FOR UPDATE`, [id]);
				const before = (rows as AdminApiKeySqlRow[])[0]; if (!before) return false;
				const [result] = await connection.execute("UPDATE admin_api_keys SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?", [toMySqlDateTime(audit.nowIso), toMySqlDateTime(audit.nowIso), id]);
				await confirmUpdate(connection, id, result, { status: 'revoked', revoked_at: audit.nowIso, updated_at: audit.nowIso });
				const values = adminKeyAuditValues(id, 'revoked', ADMIN_API_KEY_AUDIT_CHANGE.status, audit, before, { status: 'revoked' }); values[10] = toMySqlDateTime(audit.nowIso);
				await writeAudit(connection, values); return true;
			});
		},
		async revealApiKeyWithAudit(id, audit) {
			validateAdminApiKeyAuditContext(audit);
			return transaction(async (connection) => {
				const [rows] = await connection.execute(`SELECT ${ADMIN_KEY_COLUMNS} FROM admin_api_keys WHERE id = ? FOR UPDATE`, [id]);
				const before = (rows as AdminApiKeySqlRow[])[0]; if (!before) return null;
				const values = adminKeyAuditValues(id, 'revealed', 0, audit, before, {}); values[10] = toMySqlDateTime(audit.nowIso);
				await writeAudit(connection, values); return mapAdminKeySqlRow(before);
			});
		},
		async listApiKeyAudit(id, { limit, before }) {
			validateAdminKeyAuditLimit(limit);
			const condition = before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
			const values = before ? [id, adminKeyAuditCursorMySqlTime(before.createdAt), adminKeyAuditCursorMySqlTime(before.createdAt), before.id] : [id];
			const [rows] = await pool.execute(`SELECT ${ADMIN_KEY_AUDIT_COLUMNS.replace('created_at', "DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at")}
				FROM admin_access_key_audit WHERE key_id = ? ${condition} ORDER BY admin_access_key_audit.created_at DESC, id DESC LIMIT ${limit}`, values);
			return (rows as AdminApiKeyAuditSqlRow[]).map(mapAdminApiKeyAuditRow);
		},
		async touchApiKey(id) {
			await drizzle.update(adminApiKeysTable).set({ lastUsedAt: new Date().toISOString() }).where(eq(adminApiKeysTable.id, id));
		},
		async insertSession(session) {
			await drizzle.insert(adminSessionsTable).values(session);
		},
		async getValidSession(tokenHash, nowIso) {
			const row = await drizzle.select().from(adminSessionsTable)
				.where(and(eq(adminSessionsTable.tokenHash, tokenHash), gt(adminSessionsTable.expiresAt, nowIso))).limit(1);
			return row[0] ? mapSession(row[0]) : null;
		},
		async deleteSession(tokenHash) {
			await drizzle.delete(adminSessionsTable).where(eq(adminSessionsTable.tokenHash, tokenHash));
		},
		async deleteExpiredSessions(nowIso) {
			await drizzle.delete(adminSessionsTable).where(lte(adminSessionsTable.expiresAt, nowIso));
		},
	};
}
