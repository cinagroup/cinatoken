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

const MONEY_MICRO_SCALE = 1_000_000;

function moneyToMicros(value: number): bigint {
	const micros = Math.round(value * MONEY_MICRO_SCALE);
	if (!Number.isSafeInteger(micros)) {
		throw new RangeError('money value exceeds the safe integer-micro range');
	}
	return BigInt(micros);
}

function microsToMoney(value: bigint): number {
	const micros = Number(value);
	if (!Number.isSafeInteger(micros)) {
		throw new RangeError('stored money value exceeds the safe integer-micro range');
	}
	return micros / MONEY_MICRO_SCALE;
}

function postgresErrorField(error: unknown, field: 'code' | 'constraint_name'): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const value = Reflect.get(error, field);
	return typeof value === 'string' ? value : null;
}

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
	const {
		balanceMicros,
		lockedAmountMicros,
		lifetimeEarnedMicros,
		lifetimeWithdrawnMicros,
		contributionValueMicros,
		...publicRow
	} = row;
	return {
		...publicRow,
		balance: microsToMoney(balanceMicros),
		lockedAmount: microsToMoney(lockedAmountMicros),
		lifetimeEarned: microsToMoney(lifetimeEarnedMicros),
		lifetimeWithdrawn: microsToMoney(lifetimeWithdrawnMicros),
		contributionValue: microsToMoney(contributionValueMicros),
	};
}

function mapWithdrawal(row: WithdrawalSqlRow): WithdrawalRow {
	const { amountMicros, feeMicros, netAmountMicros, ...publicRow } = row;
	return {
		...publicRow,
		amount: microsToMoney(amountMicros),
		fee: microsToMoney(feeMicros),
		netAmount: microsToMoney(netAmountMicros),
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
	const insertEarning = async (params: InsertSharedKeyEarningParams): Promise<boolean> => {
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
		}).onConflictDoNothing({ target: sharedKeyEarningsTable.requestLogId })
			.returning({ id: sharedKeyEarningsTable.id });
		return rows.length > 0;
	};
	const insertWithdrawal = async (params: InsertWithdrawalParams): Promise<void> => {
		const amountMicros = moneyToMicros(params.amount);
		const feeMicros = moneyToMicros(params.fee);
		const netAmountMicros = moneyToMicros(params.netAmount);
		await drizzle.insert(withdrawalsTable).values({
			id: params.id,
			userId: params.userId,
			amount: String(params.amount),
			fee: String(params.fee),
			netAmount: String(params.netAmount),
			amountMicros,
			feeMicros,
			netAmountMicros,
			currency: params.currency,
			walletAddress: params.walletAddress,
			status: 'requested',
			tokenAmount: String(params.tokenAmount),
			createdAt: params.nowIso,
			updatedAt: params.nowIso,
		});
	};
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
		insertEarning,
		async recordEarningAndCredit(params: InsertSharedKeyEarningParams) {
			// Migration 0029 owns the canonical balance update and journal append.
			// The request_log_id conflict target prevents duplicate queue delivery
			// from crediting the same earning twice.
			return insertEarning(params);
		},
		async creditEarningBalance(sellerUserId, netAmount, nowIso) {
			const micros = moneyToMicros(netAmount).toString();
			await drizzle.update(userEarningsTable).set({
				balanceMicros: sql`${userEarningsTable.balanceMicros} + CAST(${micros} AS bigint)`,
				lifetimeEarnedMicros: sql`${userEarningsTable.lifetimeEarnedMicros} + CAST(${micros} AS bigint)`,
				contributionValueMicros: sql`${userEarningsTable.contributionValueMicros} + CAST(${micros} AS bigint)`,
				balance: sql`(${userEarningsTable.balanceMicros} + CAST(${micros} AS bigint))::numeric / 1000000`,
				lifetimeEarned: sql`(${userEarningsTable.lifetimeEarnedMicros} + CAST(${micros} AS bigint))::numeric / 1000000`,
				contributionValue: sql`(${userEarningsTable.contributionValueMicros} + CAST(${micros} AS bigint))::numeric / 1000000`,
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
		insertWithdrawal,
		async createWithdrawalWithBalanceLock(params) {
			try {
				await insertWithdrawal(params);
				return 'created';
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const code = postgresErrorField(error, 'code');
				const constraint = postgresErrorField(error, 'constraint_name');
				if (
					message.includes('active_withdrawal_exists') ||
					(code === '23505' && constraint === 'idx_withdrawals_one_active_per_user')
				) {
					return 'active_withdrawal_exists';
				}
				if (message.includes('insufficient_balance')) return 'insufficient_balance';
				throw error;
			}
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
			const micros = moneyToMicros(amount).toString();
			const rows = await drizzle.update(userEarningsTable).set({
				balanceMicros: sql`${userEarningsTable.balanceMicros} - CAST(${micros} AS bigint)`,
				lockedAmountMicros: sql`${userEarningsTable.lockedAmountMicros} + CAST(${micros} AS bigint)`,
				balance: sql`(${userEarningsTable.balanceMicros} - CAST(${micros} AS bigint))::numeric / 1000000`,
				lockedAmount: sql`(${userEarningsTable.lockedAmountMicros} + CAST(${micros} AS bigint))::numeric / 1000000`,
				updatedAt: nowIso,
			}).where(and(
				eq(userEarningsTable.userId, userId),
				sql`${userEarningsTable.balanceMicros} >= CAST(${micros} AS bigint)`
			)).returning({ userId: userEarningsTable.userId });
			return rows.length > 0;
		},
		async settleWithdrawalConfirmed(id, userId, amount, nowIso) {
			void amount;
			await db.raw`
				UPDATE withdrawals
				SET status = 'confirmed', confirmed_at = ${nowIso}, updated_at = ${nowIso}
				WHERE id = ${id} AND user_id = ${userId}
				  AND status IN ('requested', 'processing', 'submitted')
			`;
		},
		async refundWithdrawal(id, userId, amount, reason, nowIso) {
			void amount;
			await db.raw`
				UPDATE withdrawals
				SET status = 'failed', failure_reason = ${reason}, updated_at = ${nowIso}
				WHERE id = ${id} AND user_id = ${userId}
				  AND status IN ('requested', 'processing', 'submitted')
			`;
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
