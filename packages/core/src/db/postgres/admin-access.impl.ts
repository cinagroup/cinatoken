import { and, desc, eq, gt, lte } from 'drizzle-orm';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { AdminAccessRepository } from '../../storage/gateway-repository-interfaces';
import {
	adminApiKeysTable,
	adminSessionsTable,
} from '../../storage/drizzle/schema.pg';
import type { AdminApiKeyRow, AdminSessionRow } from '../admin-access-types';
import { hashLookupKey } from '../../lib/key-hash';

function mapKey(row: typeof adminApiKeysTable.$inferSelect): AdminApiKeyRow {
	return { ...row, status: row.status === 'revoked' ? 'revoked' : 'active' };
}

function mapSession(row: typeof adminSessionsTable.$inferSelect): AdminSessionRow {
	return row;
}

export function createPostgresAdminAccessRepository(db: PostgresDatabaseClient): AdminAccessRepository {
	const drizzle = db.drizzle;
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
			if (Object.keys(patch).length === 0) return false;
			const rows = await drizzle.update(adminApiKeysTable).set({ ...patch, updatedAt: new Date().toISOString() })
				.where(eq(adminApiKeysTable.id, id)).returning({ id: adminApiKeysTable.id });
			return rows.length > 0;
		},
		async rotateApiKey(id, secretKey, keyPrefix) {
			const rows = await drizzle.update(adminApiKeysTable).set({ secretKey, keyPrefix, updatedAt: new Date().toISOString() })
				.where(and(eq(adminApiKeysTable.id, id), eq(adminApiKeysTable.status, 'active'))).returning({ id: adminApiKeysTable.id });
			return rows.length > 0;
		},
		async revokeApiKey(id) {
			const now = new Date().toISOString();
			const rows = await drizzle.update(adminApiKeysTable).set({ status: 'revoked', revokedAt: now, updatedAt: now })
				.where(and(eq(adminApiKeysTable.id, id), eq(adminApiKeysTable.status, 'active'))).returning({ id: adminApiKeysTable.id });
			return rows.length > 0;
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
