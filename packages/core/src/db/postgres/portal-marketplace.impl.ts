import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type {
	PortalAccessRepository,
	PortalLedgerRepository,
	SharedKeysRepository,
} from '../../storage/gateway-repository-interfaces';
import {
	nftMintsTable,
	portalSessionsTable,
	sharedKeyEarningsTable,
	sharedKeysTable,
	userEarningsTable,
	withdrawalsTable,
} from '../../storage/drizzle/schema.pg';
import type {
	InsertNftMintParams,
	InsertSharedKeyEarningParams,
	InsertSharedKeyParams,
	InsertWithdrawalParams,
	NftMintRow,
	PortalSessionRow,
	SharedKeyEarningRow,
	SharedKeyRow,
	UpdateSharedKeyPatch,
	UserEarningsRow,
	WithdrawalRow,
} from '../shared-keys-types';

type SharedKeySqlRow = typeof sharedKeysTable.$inferSelect;
type SharedKeyEarningSqlRow = typeof sharedKeyEarningsTable.$inferSelect;
type UserEarningsSqlRow = typeof userEarningsTable.$inferSelect;
type WithdrawalSqlRow = typeof withdrawalsTable.$inferSelect;
type NftMintSqlRow = typeof nftMintsTable.$inferSelect;

function mapSharedKey(row: SharedKeySqlRow): SharedKeyRow {
	return {
		...row,
		inputPrice: Number(row.inputPrice),
		outputPrice: Number(row.outputPrice),
		cacheReadPrice: row.cacheReadPrice === null ? null : Number(row.cacheReadPrice),
		cacheWritePrice: row.cacheWritePrice === null ? null : Number(row.cacheWritePrice),
		earnedTotal: Number(row.earnedTotal),
	};
}

function mapEarning(row: SharedKeyEarningSqlRow): SharedKeyEarningRow {
	return {
		...row,
		grossAmount: Number(row.grossAmount),
		platformFee: Number(row.platformFee),
		netAmount: Number(row.netAmount),
	};
}

function mapUserEarnings(row: UserEarningsSqlRow): UserEarningsRow {
	return {
		...row,
		balance: Number(row.balance),
		lockedAmount: Number(row.lockedAmount),
		lifetimeEarned: Number(row.lifetimeEarned),
		lifetimeWithdrawn: Number(row.lifetimeWithdrawn),
		contributionValue: Number(row.contributionValue),
	};
}

function mapWithdrawal(row: WithdrawalSqlRow): WithdrawalRow {
	return {
		...row,
		amount: Number(row.amount),
		fee: Number(row.fee),
		netAmount: Number(row.netAmount),
		tokenAmount: row.tokenAmount === null ? null : Number(row.tokenAmount),
	};
}

function mapNftMint(row: NftMintSqlRow): NftMintRow {
	return { ...row, valueSnapshot: Number(row.valueSnapshot) };
}

const SHARED_KEY_ORDER = [desc(sharedKeysTable.sellerPriority), desc(sharedKeysTable.weight), asc(sharedKeysTable.id)];

export function createPostgresPortalAccessRepository(db: PostgresDatabaseClient): PortalAccessRepository {
	const drizzle = db.drizzle;
	return {
		async insertSession(session: PortalSessionRow) {
			await drizzle.insert(portalSessionsTable).values(session);
		},
		async getValidSession(tokenHash, nowIso) {
			const row = await drizzle.select().from(portalSessionsTable)
				.where(and(eq(portalSessionsTable.tokenHash, tokenHash), gt(portalSessionsTable.expiresAt, nowIso))).limit(1);
			return row[0] ?? null;
		},
		async deleteSession(tokenHash) {
			await drizzle.delete(portalSessionsTable).where(eq(portalSessionsTable.tokenHash, tokenHash));
		},
		async deleteExpiredSessions(nowIso) {
			await drizzle.delete(portalSessionsTable).where(lte(portalSessionsTable.expiresAt, nowIso));
		},
	};
}

export function createPostgresSharedKeysRepository(db: PostgresDatabaseClient): SharedKeysRepository {
	const drizzle = db.drizzle;
	return {
		async insertSharedKey(params: InsertSharedKeyParams) {
			await drizzle.insert(sharedKeysTable).values({
				id: params.id,
				sellerUserId: params.sellerUserId,
				channelType: params.channelType,
				apiKey: params.apiKey,
				keyFingerprint: params.keyFingerprint,
				label: params.label ?? null,
				status: 'validating',
				weight: params.weight,
				inputPrice: String(params.inputPrice),
				outputPrice: String(params.outputPrice),
				cacheReadPrice: params.cacheReadPrice == null ? null : String(params.cacheReadPrice),
				cacheWritePrice: params.cacheWritePrice == null ? null : String(params.cacheWritePrice),
				createdAt: params.nowIso,
				updatedAt: params.nowIso,
			});
		},
		async getSharedKeyById(id) {
			const row = await drizzle.select().from(sharedKeysTable).where(eq(sharedKeysTable.id, id)).limit(1);
			return row[0] ? mapSharedKey(row[0]) : null;
		},
		async listSharedKeysBySeller(sellerUserId) {
			const rows = await drizzle.select().from(sharedKeysTable)
				.where(eq(sharedKeysTable.sellerUserId, sellerUserId))
				.orderBy(desc(sharedKeysTable.createdAt));
			return rows.map(mapSharedKey);
		},
		async listAllSharedKeys(options) {
			const conditions = [];
			if (options?.status) conditions.push(eq(sharedKeysTable.status, options.status));
			if (options?.channelType) conditions.push(eq(sharedKeysTable.channelType, options.channelType));
			const rows = await drizzle.select().from(sharedKeysTable)
				.where(conditions.length > 0 ? and(...conditions) : undefined)
				.orderBy(...SHARED_KEY_ORDER);
			return rows.map(mapSharedKey);
		},
		async listActiveSharedKeysByChannel(channelType) {
			const rows = await drizzle.select().from(sharedKeysTable)
				.where(and(eq(sharedKeysTable.channelType, channelType), eq(sharedKeysTable.status, 'active')))
				.orderBy(...SHARED_KEY_ORDER);
			return rows.map(mapSharedKey);
		},
		async updateSharedKey(id, patch: UpdateSharedKeyPatch) {
			if (Object.keys(patch).length === 0) return false;
			const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
			if (patch.label !== undefined) set.label = patch.label;
			if (patch.status !== undefined) set.status = patch.status;
			if (patch.weight !== undefined) set.weight = patch.weight;
			if (patch.sellerPriority !== undefined) set.sellerPriority = patch.sellerPriority;
			if (patch.inputPrice !== undefined) set.inputPrice = String(patch.inputPrice);
			if (patch.outputPrice !== undefined) set.outputPrice = String(patch.outputPrice);
			if (patch.cacheReadPrice !== undefined) set.cacheReadPrice = patch.cacheReadPrice == null ? null : String(patch.cacheReadPrice);
			if (patch.cacheWritePrice !== undefined) set.cacheWritePrice = patch.cacheWritePrice == null ? null : String(patch.cacheWritePrice);
			if (patch.failureReason !== undefined) set.failureReason = patch.failureReason;
			const rows = await drizzle.update(sharedKeysTable).set(set)
				.where(eq(sharedKeysTable.id, id)).returning({ id: sharedKeysTable.id });
			return rows.length > 0;
		},
		async replaceSharedKeySecret(id, protectedSecret) {
			const rows = await drizzle.update(sharedKeysTable)
				.set({ apiKey: protectedSecret, updatedAt: new Date().toISOString() })
				.where(eq(sharedKeysTable.id, id)).returning({ id: sharedKeysTable.id });
			return rows.length > 0;
		},
		async markSharedKeyFailure(id, reason, nowIso) {
			await drizzle.update(sharedKeysTable)
				.set({ status: 'invalid', failureReason: reason, lastFailureAt: nowIso, updatedAt: nowIso })
				.where(eq(sharedKeysTable.id, id));
		},
		async deleteSharedKey(id) {
			const rows = await drizzle.delete(sharedKeysTable).where(eq(sharedKeysTable.id, id))
				.returning({ id: sharedKeysTable.id });
			return rows.length > 0;
		},
		async addSharedKeyUsage(id, inputTokens, outputTokens, netAmount, nowIso) {
			await drizzle.update(sharedKeysTable).set({
				servedInputTokens: sql`${sharedKeysTable.servedInputTokens} + ${inputTokens}`,
				servedOutputTokens: sql`${sharedKeysTable.servedOutputTokens} + ${outputTokens}`,
				earnedTotal: sql`${sharedKeysTable.earnedTotal} + CAST(${netAmount} AS numeric)`,
				lastUsedAt: nowIso,
				updatedAt: nowIso,
			}).where(eq(sharedKeysTable.id, id));
		},
	};
}

export function createPostgresPortalLedgerRepository(db: PostgresDatabaseClient): PortalLedgerRepository {
	const drizzle = db.drizzle;
	return {
		async getUserEarnings(userId) {
			const row = await drizzle.select().from(userEarningsTable).where(eq(userEarningsTable.userId, userId)).limit(1);
			return row[0] ? mapUserEarnings(row[0]) : null;
		},
		async ensureUserEarnings(userId) {
			await drizzle.insert(userEarningsTable).values({ userId, updatedAt: new Date().toISOString() })
				.onConflictDoNothing({ target: userEarningsTable.userId });
		},
		async updateWallet(userId, walletAddress, verifiedAtIso) {
			const nowIso = new Date().toISOString();
			await drizzle.insert(userEarningsTable).values({ userId, walletAddress, walletVerifiedAt: verifiedAtIso, updatedAt: nowIso })
				.onConflictDoUpdate({
					target: userEarningsTable.userId,
					set: { walletAddress, walletVerifiedAt: verifiedAtIso, updatedAt: nowIso },
				});
		},
		async insertEarning(params: InsertSharedKeyEarningParams) {
			const rows = await drizzle.insert(sharedKeyEarningsTable).values({
				id: params.id,
				requestLogId: params.requestLogId,
				sharedKeyId: params.sharedKeyId,
				sellerUserId: params.sellerUserId,
				inputTokens: params.inputTokens,
				outputTokens: params.outputTokens,
				cacheReadTokens: params.cacheReadTokens,
				cacheWriteTokens: params.cacheWriteTokens,
				grossAmount: String(params.grossAmount),
				platformFee: String(params.platformFee),
				netAmount: String(params.netAmount),
				currency: params.currency,
				createdAt: params.nowIso,
			}).onConflictDoNothing({ target: sharedKeyEarningsTable.requestLogId }).returning({ id: sharedKeyEarningsTable.id });
			return rows.length > 0;
		},
		async recordEarningAndCredit(params: InsertSharedKeyEarningParams) {
			let inserted = false;
			await db.raw.begin(async (tx) => {
				const rows = await tx<{ id: string }[]>`
					INSERT INTO shared_key_earnings
					  (id, request_log_id, shared_key_id, seller_user_id, input_tokens, output_tokens,
					   cache_read_tokens, cache_write_tokens, gross_amount, platform_fee, net_amount,
					   currency, created_at)
					VALUES
					  (${params.id}, ${params.requestLogId}, ${params.sharedKeyId}, ${params.sellerUserId},
					   ${params.inputTokens}, ${params.outputTokens}, ${params.cacheReadTokens},
					   ${params.cacheWriteTokens}, ${params.grossAmount}, ${params.platformFee},
					   ${params.netAmount}, ${params.currency}, ${params.nowIso})
					ON CONFLICT (request_log_id) DO NOTHING
					RETURNING id
				`;
				if (rows.length === 0) return;
				await tx`
					UPDATE user_earnings
					SET balance = balance + ${params.netAmount},
					    lifetime_earned = lifetime_earned + ${params.netAmount},
					    contribution_value = contribution_value + ${params.netAmount},
					    updated_at = ${params.nowIso}
					WHERE user_id = ${params.sellerUserId}
				`;
				inserted = true;
			});
			return inserted;
		},
		async creditEarningBalance(sellerUserId, netAmount, nowIso) {
			await drizzle.update(userEarningsTable).set({
				balance: sql`${userEarningsTable.balance} + CAST(${netAmount} AS numeric)`,
				lifetimeEarned: sql`${userEarningsTable.lifetimeEarned} + CAST(${netAmount} AS numeric)`,
				contributionValue: sql`${userEarningsTable.contributionValue} + CAST(${netAmount} AS numeric)`,
				updatedAt: nowIso,
			}).where(eq(userEarningsTable.userId, sellerUserId));
		},
		async listEarningsBySeller(sellerUserId, page, pageSize) {
			const offset = (page - 1) * pageSize;
			const rows = await drizzle.select().from(sharedKeyEarningsTable)
				.where(eq(sharedKeyEarningsTable.sellerUserId, sellerUserId))
				.orderBy(desc(sharedKeyEarningsTable.createdAt), desc(sharedKeyEarningsTable.id))
				.limit(pageSize).offset(offset);
			const totalRows = await drizzle.select({ count: sql<number>`count(*)::int` })
				.from(sharedKeyEarningsTable).where(eq(sharedKeyEarningsTable.sellerUserId, sellerUserId));
			return { rows: rows.map(mapEarning), total: totalRows[0]?.count ?? 0 };
		},
		async insertWithdrawal(params: InsertWithdrawalParams) {
			await drizzle.insert(withdrawalsTable).values({
				id: params.id,
				userId: params.userId,
				amount: String(params.amount),
				fee: String(params.fee),
				netAmount: String(params.netAmount),
				currency: params.currency,
				walletAddress: params.walletAddress,
				status: 'requested',
				tokenAmount: String(params.tokenAmount),
				createdAt: params.nowIso,
				updatedAt: params.nowIso,
			});
		},
		async createWithdrawalWithBalanceLock(params) {
			let outcome: 'created' | 'insufficient_balance' | 'active_withdrawal_exists' = 'created';
			await db.raw.begin(async (tx) => {
				const active = await tx<{ id: string }[]>`
					SELECT id FROM withdrawals
					WHERE user_id = ${params.userId}
					  AND status IN ('requested', 'processing', 'submitted')
					LIMIT 1 FOR UPDATE
				`;
				if (active.length > 0) {
					outcome = 'active_withdrawal_exists';
					return;
				}
				const locked = await tx<{ user_id: string }[]>`
					UPDATE user_earnings
					SET balance = balance - ${params.amount},
					    locked_amount = locked_amount + ${params.amount},
					    updated_at = ${params.nowIso}
					WHERE user_id = ${params.userId} AND balance >= ${params.amount}
					RETURNING user_id
				`;
				if (locked.length === 0) {
					outcome = 'insufficient_balance';
					return;
				}
				await tx`
					INSERT INTO withdrawals
					  (id, user_id, amount, fee, net_amount, currency, wallet_address, status,
					   token_amount, created_at, updated_at)
					VALUES (${params.id}, ${params.userId}, ${params.amount}, ${params.fee},
					        ${params.netAmount}, ${params.currency}, ${params.walletAddress},
					        'requested', ${params.tokenAmount}, ${params.nowIso}, ${params.nowIso})
				`;
			});
			return outcome;
		},
		async getWithdrawal(id) {
			const row = await drizzle.select().from(withdrawalsTable).where(eq(withdrawalsTable.id, id)).limit(1);
			return row[0] ? mapWithdrawal(row[0]) : null;
		},
		async getActiveWithdrawalByUser(userId) {
			const row = await drizzle.select().from(withdrawalsTable)
				.where(and(
					eq(withdrawalsTable.userId, userId),
					sql`${withdrawalsTable.status} IN ('requested', 'processing', 'submitted')`
				)).limit(1);
			return row[0] ? mapWithdrawal(row[0]) : null;
		},
		async listWithdrawalsByUser(userId, page, pageSize) {
			const offset = (page - 1) * pageSize;
			const rows = await drizzle.select().from(withdrawalsTable)
				.where(eq(withdrawalsTable.userId, userId))
				.orderBy(desc(withdrawalsTable.createdAt), desc(withdrawalsTable.id))
				.limit(pageSize).offset(offset);
			const totalRows = await drizzle.select({ count: sql<number>`count(*)::int` })
				.from(withdrawalsTable).where(eq(withdrawalsTable.userId, userId));
			return { rows: rows.map(mapWithdrawal), total: totalRows[0]?.count ?? 0 };
		},
		async listAllWithdrawals(status) {
			const rows = await drizzle.select().from(withdrawalsTable)
				.where(status ? eq(withdrawalsTable.status, status) : undefined)
				.orderBy(desc(withdrawalsTable.createdAt), desc(withdrawalsTable.id));
			return rows.map(mapWithdrawal);
		},
		async lockBalanceForWithdrawal(userId, amount, nowIso) {
			const rows = await drizzle.update(userEarningsTable).set({
				balance: sql`${userEarningsTable.balance} - CAST(${amount} AS numeric)`,
				lockedAmount: sql`${userEarningsTable.lockedAmount} + CAST(${amount} AS numeric)`,
				updatedAt: nowIso,
			}).where(and(
				eq(userEarningsTable.userId, userId),
				sql`${userEarningsTable.balance} >= CAST(${amount} AS numeric)`
			)).returning({ userId: userEarningsTable.userId });
			return rows.length > 0;
		},
		async settleWithdrawalConfirmed(id, userId, amount, nowIso) {
			void amount;
			await db.raw.begin(async (tx) => {
				const rows = await tx<{ amount: string }[]>`
					UPDATE withdrawals
					SET status = 'confirmed', confirmed_at = ${nowIso}, updated_at = ${nowIso}
					WHERE id = ${id} AND user_id = ${userId}
					  AND status IN ('requested', 'processing', 'submitted')
					RETURNING amount
				`;
				if (rows.length === 0) return;
				await tx`
					UPDATE user_earnings
					SET locked_amount = locked_amount - ${rows[0].amount},
					    lifetime_withdrawn = lifetime_withdrawn + ${rows[0].amount},
					    updated_at = ${nowIso}
					WHERE user_id = ${userId} AND locked_amount >= ${rows[0].amount}
				`;
			});
		},
		async refundWithdrawal(id, userId, amount, reason, nowIso) {
			void amount;
			await db.raw.begin(async (tx) => {
				const rows = await tx<{ amount: string }[]>`
					UPDATE withdrawals
					SET status = 'failed', failure_reason = ${reason}, updated_at = ${nowIso}
					WHERE id = ${id} AND user_id = ${userId}
					  AND status IN ('requested', 'processing', 'submitted')
					RETURNING amount
				`;
				if (rows.length === 0) return;
				await tx`
					UPDATE user_earnings
					SET locked_amount = locked_amount - ${rows[0].amount},
					    balance = balance + ${rows[0].amount},
					    updated_at = ${nowIso}
					WHERE user_id = ${userId} AND locked_amount >= ${rows[0].amount}
				`;
			});
		},
		async updateWithdrawalStatus(id, patch) {
			const set: Record<string, unknown> = { updatedAt: patch.nowIso };
			if (patch.status !== undefined) set.status = patch.status;
			if (patch.txHash !== undefined) set.txHash = patch.txHash;
			if (patch.chainId !== undefined) set.chainId = patch.chainId;
			if (patch.tokenAmount !== undefined) set.tokenAmount = patch.tokenAmount == null ? null : String(patch.tokenAmount);
			if (patch.failureReason !== undefined) set.failureReason = patch.failureReason;
			const rows = await drizzle.update(withdrawalsTable).set(set)
				.where(patch.expectedStatus
					? and(eq(withdrawalsTable.id, id), eq(withdrawalsTable.status, patch.expectedStatus))
					: eq(withdrawalsTable.id, id))
				.returning({ id: withdrawalsTable.id });
			return rows.length > 0;
		},
		async insertNftMint(params: InsertNftMintParams) {
			const rows = await drizzle.insert(nftMintsTable).values({
				id: params.id,
				userId: params.userId,
				badgeTokenId: params.badgeTokenId,
				tierName: params.tierName,
				walletAddress: params.walletAddress,
				status: 'pending',
				valueSnapshot: String(params.valueSnapshot),
				createdAt: params.nowIso,
			}).onConflictDoNothing({ target: [nftMintsTable.userId, nftMintsTable.badgeTokenId] })
				.returning({ id: nftMintsTable.id });
			return rows.length > 0;
		},
		async getNftMintsByUser(userId) {
			const rows = await drizzle.select().from(nftMintsTable).where(eq(nftMintsTable.userId, userId))
				.orderBy(desc(nftMintsTable.createdAt));
			return rows.map(mapNftMint);
		},
		async listAllNftMints(status) {
			const rows = await drizzle.select().from(nftMintsTable)
				.where(status ? eq(nftMintsTable.status, status) : undefined)
				.orderBy(desc(nftMintsTable.createdAt));
			return rows.map(mapNftMint);
		},
		async updateNftMintStatus(id, patch) {
			const set: Record<string, unknown> = {};
			if (patch.status !== undefined) set.status = patch.status;
			if (patch.txHash !== undefined) set.txHash = patch.txHash;
			if (patch.chainId !== undefined) set.chainId = patch.chainId;
			if (patch.failureReason !== undefined) set.failureReason = patch.failureReason;
			if (patch.confirmedAt !== undefined) set.confirmedAt = patch.confirmedAt;
			if (Object.keys(set).length === 0) return false;
			const rows = await drizzle.update(nftMintsTable).set(set)
				.where(patch.expectedStatus
					? and(eq(nftMintsTable.id, id), eq(nftMintsTable.status, patch.expectedStatus))
					: eq(nftMintsTable.id, id))
				.returning({ id: nftMintsTable.id });
			return rows.length > 0;
		},
		async setHighestBadgeTier(userId, tier, nowIso) {
			await drizzle.update(userEarningsTable).set({ highestBadgeTier: tier, updatedAt: nowIso })
				.where(eq(userEarningsTable.userId, userId));
		},
	};
}
