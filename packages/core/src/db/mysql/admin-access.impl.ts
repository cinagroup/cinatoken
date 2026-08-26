import { and, desc, eq, gt, lte } from 'drizzle-orm';
import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { AdminAccessRepository } from '../../storage/gateway-repository-interfaces';
import { hashLookupKey } from '../../lib/key-hash';
import {
	adminApiKeysTable,
	adminSessionsTable,
} from '../../storage/drizzle/schema.mysql';
import type { AdminApiKeyRow, AdminSessionRow } from '../admin-access-types';

function mapKey(row: typeof adminApiKeysTable.$inferSelect): AdminApiKeyRow {
	return { ...row, status: row.status === 'revoked' ? 'revoked' : 'active' };
}

function mapSession(row: typeof adminSessionsTable.$inferSelect): AdminSessionRow {
	return row;
}

export function createMySqlAdminAccessRepository(db: MySqlDatabaseClient): AdminAccessRepository {
	const drizzle = db.drizzle;
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
			if (byHash[0]) return mapKey(byHash[0]);
			const row = await drizzle.select().from(adminApiKeysTable)
				.where(and(eq(adminApiKeysTable.secretKey, secretKey), eq(adminApiKeysTable.status, 'active'))).limit(1);
			if (!row[0]) return null;
			await drizzle.update(adminApiKeysTable).set({ secretKeyHash: hash })
				.where(eq(adminApiKeysTable.id, row[0].id));
			return mapKey(row[0]);
		},
		async insertApiKey(params) {
			const now = new Date().toISOString();
			await drizzle.insert(adminApiKeysTable).values({ ...params, secretKeyHash: await hashLookupKey(params.secretKey), description: params.description ?? null, status: 'active', createdAt: now, updatedAt: now });
		},
		async updateApiKey(id, patch) {
			if (Object.keys(patch).length === 0 || !(await getById(id))) return false;
			await drizzle.update(adminApiKeysTable).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(adminApiKeysTable.id, id));
			return true;
		},
		async rotateApiKey(id, secretKey, keyPrefix) {
			const existing = await getById(id);
			if (!existing || existing.status !== 'active') return false;
			await drizzle.update(adminApiKeysTable).set({ secretKey, keyPrefix, updatedAt: new Date().toISOString() }).where(eq(adminApiKeysTable.id, id));
			return true;
		},
		async revokeApiKey(id) {
			const existing = await getById(id);
			if (!existing || existing.status !== 'active') return false;
			const now = new Date().toISOString();
			await drizzle.update(adminApiKeysTable).set({ status: 'revoked', revokedAt: now, updatedAt: now }).where(eq(adminApiKeysTable.id, id));
			return true;
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
