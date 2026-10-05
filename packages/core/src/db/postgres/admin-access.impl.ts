import { and, desc, eq, gt, lte } from 'drizzle-orm';
import type postgres from 'postgres';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { AdminAccessRepository } from '../../storage/gateway-repository-interfaces';
import {
	adminApiKeysTable,
	adminSessionsTable,
} from '../../storage/drizzle/schema.pg';
import type { AdminApiKeyRow, AdminSessionRow } from '../admin-access-types';
import { hashLookupKey, matchesLookupKeyHash } from '../../lib/key-hash';
import { ADMIN_API_KEY_AUDIT_CHANGE, mapAdminApiKeyAuditRow, validateAdminApiKeyAuditContext, type AdminApiKeyAuditSqlRow } from '../admin-access-audit';
import { ADMIN_KEY_COLUMNS, ADMIN_KEY_AUDIT_COLUMNS, adminKeyAuditValues, adminKeyPatchAuditValues,
	adminKeyCreateMask, mapAdminKeySqlRow, validateAdminKeyAuditLimit, validateAdminKeyPermissions,
	type AdminApiKeySqlRow } from '../admin-access-sql';

function mapKey(row: typeof adminApiKeysTable.$inferSelect): AdminApiKeyRow {
	return { ...row, status: row.status === 'revoked' ? 'revoked' : 'active' };
}

function mapSession(row: typeof adminSessionsTable.$inferSelect): AdminSessionRow {
	return row;
}

export function createPostgresAdminAccessRepository(db: PostgresDatabaseClient): AdminAccessRepository {
	const drizzle = db.drizzle;
	const pg = db.raw;
	const auditSql = `INSERT INTO cinatoken_gateway.admin_access_key_audit (${ADMIN_KEY_AUDIT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`;
	const writeAudit = async (tx: postgres.TransactionSql<Record<string, postgres.PostgresType>>, values: (string | number | null)[]) => {
		const rows = await tx.unsafe(auditSql, values);
		if (rows.length !== 1) throw new Error('Admin API key audit did not commit');
	};
	const writeTarget = async (tx: postgres.TransactionSql<Record<string, postgres.PostgresType>>, id: string,
		sql: string, values: (string | null)[]) => {
		const rows = await tx.unsafe<{ id: string }[]>(`${sql} RETURNING id`, values);
		if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== id) throw new Error('Admin API key target did not commit');
	};
	return {
		async listApiKeys() {
			return (await drizzle.select().from(adminApiKeysTable).orderBy(desc(adminApiKeysTable.createdAt))).map(mapKey);
		},
		async getApiKeyById(id) {
			const row = await drizzle.select().from(adminApiKeysTable).where(eq(adminApiKeysTable.id, id)).limit(1);
			return row[0] ? mapKey(row[0]) : null;
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
			await pg.begin(async (tx) => {
				await writeTarget(tx, params.id, `INSERT INTO cinatoken_gateway.admin_api_keys
					(id, name, description, secret_key, key_prefix, permissions_json, secret_key_hash, status, created_at, updated_at)
					VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)`, [params.id, params.name, params.description ?? null,
					params.secretKey, params.keyPrefix, params.permissionsJson, hash, audit.nowIso, audit.nowIso]);
				await writeAudit(tx, adminKeyAuditValues(params.id, 'created', adminKeyCreateMask(params.description), audit, null, { permissionsJson: params.permissionsJson }));
			});
		},
		async updateApiKey(id, patch, audit) {
			validateAdminApiKeyAuditContext(audit);
			validateAdminKeyPermissions(patch.permissionsJson);
			if (Object.keys(patch).length === 0) return false;
			const secretKeyHash = patch.secretKey === undefined
				? undefined
				: await hashLookupKey(patch.secretKey);
			return pg.begin(async (tx) => {
				const rows = await tx.unsafe<AdminApiKeySqlRow[]>(`SELECT ${ADMIN_KEY_COLUMNS} FROM cinatoken_gateway.admin_api_keys WHERE id = $1 FOR UPDATE`, [id]);
				const before = rows[0]; if (!before) return false;
				const sets: string[] = []; const values: (string | null)[] = [];
				for (const [field, column] of [['name', 'name'], ['description', 'description'], ['permissionsJson', 'permissions_json'], ['status', 'status'], ['revokedAt', 'revoked_at']] as const) {
					const value = patch[field]; if (value !== undefined) { values.push(value); sets.push(`${column} = $${values.length}`); }
				}
				if (patch.secretKey !== undefined) {
					for (const [column, value] of [['secret_key', patch.secretKey], ['secret_key_hash', secretKeyHash!], ['key_prefix', patch.secretKey.slice(0, 12)]]) {
						values.push(value!); sets.push(`${column} = $${values.length}`);
					}
				}
				values.push(audit.nowIso); sets.push(`updated_at = $${values.length}`); values.push(id);
				await writeTarget(tx, id, `UPDATE cinatoken_gateway.admin_api_keys SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
				await writeAudit(tx, adminKeyPatchAuditValues(id, audit, before, patch)); return true;
			});
		},
		async rotateApiKey(id, secretKey, audit) {
			validateAdminApiKeyAuditContext(audit);
			const secretKeyHash = await hashLookupKey(secretKey);
			return pg.begin(async (tx) => {
				const rows = await tx.unsafe<AdminApiKeySqlRow[]>(`SELECT ${ADMIN_KEY_COLUMNS} FROM cinatoken_gateway.admin_api_keys WHERE id = $1 AND status = 'active' FOR UPDATE`, [id]);
				const before = rows[0]; if (!before) return false;
				await writeTarget(tx, id, 'UPDATE cinatoken_gateway.admin_api_keys SET secret_key = $1, secret_key_hash = $2, key_prefix = $3, updated_at = $4 WHERE id = $5', [secretKey, secretKeyHash, secretKey.slice(0, 12), audit.nowIso, id]);
				await writeAudit(tx, adminKeyAuditValues(id, 'rotated', ADMIN_API_KEY_AUDIT_CHANGE.secret, audit, before, {})); return true;
			});
		},
		async revokeApiKey(id, audit) {
			validateAdminApiKeyAuditContext(audit);
			return pg.begin(async (tx) => {
				const rows = await tx.unsafe<AdminApiKeySqlRow[]>(`SELECT ${ADMIN_KEY_COLUMNS} FROM cinatoken_gateway.admin_api_keys WHERE id = $1 AND status = 'active' FOR UPDATE`, [id]);
				const before = rows[0]; if (!before) return false;
				await writeTarget(tx, id, "UPDATE cinatoken_gateway.admin_api_keys SET status = 'revoked', revoked_at = $1, updated_at = $1 WHERE id = $2", [audit.nowIso, id]);
				await writeAudit(tx, adminKeyAuditValues(id, 'revoked', ADMIN_API_KEY_AUDIT_CHANGE.status, audit, before, { status: 'revoked' })); return true;
			});
		},
		async revealApiKeyWithAudit(id, audit) {
			validateAdminApiKeyAuditContext(audit);
			return pg.begin(async (tx) => {
				const rows = await tx.unsafe<AdminApiKeySqlRow[]>(`SELECT ${ADMIN_KEY_COLUMNS} FROM cinatoken_gateway.admin_api_keys WHERE id = $1 FOR UPDATE`, [id]);
				const before = rows[0]; if (!before) return null;
				await writeAudit(tx, adminKeyAuditValues(id, 'revealed', 0, audit, before, {})); return mapAdminKeySqlRow(before);
			});
		},
		async listApiKeyAudit(id, { limit, before }) {
			validateAdminKeyAuditLimit(limit);
			const condition = before ? 'AND (created_at < $2 OR (created_at = $2 AND id < $3))' : '';
			const values = before ? [id, before.createdAt, before.id] : [id];
			const rows = await pg.unsafe<AdminApiKeyAuditSqlRow[]>(`SELECT ${ADMIN_KEY_AUDIT_COLUMNS.replace('created_at', `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`)}
				FROM cinatoken_gateway.admin_access_key_audit WHERE key_id = $1 ${condition} ORDER BY admin_access_key_audit.created_at DESC, id DESC LIMIT ${limit}`, values);
			return rows.map(mapAdminApiKeyAuditRow);
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
