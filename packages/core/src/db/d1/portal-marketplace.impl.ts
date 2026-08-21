import type { D1DatabaseClient } from '../../storage/database-client';
import type {
	PortalAccessRepository,
	PortalLedgerRepository,
	SharedKeysRepository,
} from '../../storage/gateway-repository-interfaces';
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

type SharedKeySqlRow = {
	id: string;
	seller_user_id: string;
	channel_type: string;
	api_key: string;
	key_fingerprint: string;
	label: string | null;
	status: string;
	seller_priority: number;
	weight: number;
	input_price: number;
	output_price: number;
	cache_read_price: number | null;
	cache_write_price: number | null;
	validated_at: string | null;
	last_used_at: string | null;
	last_failure_at: string | null;
	failure_reason: string | null;
	served_input_tokens: number;
	served_output_tokens: number;
	earned_total: number;
	created_at: string;
	updated_at: string;
};

function mapSharedKey(row: SharedKeySqlRow): SharedKeyRow {
	return {
		id: row.id,
		sellerUserId: row.seller_user_id,
		channelType: row.channel_type,
		apiKey: row.api_key,
		keyFingerprint: row.key_fingerprint,
		label: row.label,
		status: row.status,
		sellerPriority: row.seller_priority,
		weight: row.weight,
		inputPrice: Number(row.input_price),
		outputPrice: Number(row.output_price),
		cacheReadPrice: row.cache_read_price === null ? null : Number(row.cache_read_price),
		cacheWritePrice: row.cache_write_price === null ? null : Number(row.cache_write_price),
		validatedAt: row.validated_at,
		lastUsedAt: row.last_used_at,
		lastFailureAt: row.last_failure_at,
		failureReason: row.failure_reason,
		servedInputTokens: Number(row.served_input_tokens),
		servedOutputTokens: Number(row.served_output_tokens),
		earnedTotal: Number(row.earned_total),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

const SHARED_KEY_COLUMNS = `id, seller_user_id, channel_type, api_key, key_fingerprint, label, status,
  seller_priority, weight, input_price, output_price, cache_read_price, cache_write_price,
  validated_at, last_used_at, last_failure_at, failure_reason,
  served_input_tokens, served_output_tokens, earned_total, created_at, updated_at`;

/** 固定排序：同 priority 层内 weight 从高到低；层间 seller_priority 优先。 */
const SHARED_KEY_ORDER_SQL = `ORDER BY seller_priority DESC, weight DESC, id ASC`;

function buildSharedKeyPatch(patch: UpdateSharedKeyPatch): { sets: string[]; values: unknown[] } {
	const sets: string[] = [];
	const values: unknown[] = [];
	if (patch.label !== undefined) { sets.push('label = ?'); values.push(patch.label); }
	if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
	if (patch.weight !== undefined) { sets.push('weight = ?'); values.push(patch.weight); }
	if (patch.sellerPriority !== undefined) { sets.push('seller_priority = ?'); values.push(patch.sellerPriority); }
	if (patch.inputPrice !== undefined) { sets.push('input_price = ?'); values.push(patch.inputPrice); }
	if (patch.outputPrice !== undefined) { sets.push('output_price = ?'); values.push(patch.outputPrice); }
	if (patch.cacheReadPrice !== undefined) { sets.push('cache_read_price = ?'); values.push(patch.cacheReadPrice); }
	if (patch.cacheWritePrice !== undefined) { sets.push('cache_write_price = ?'); values.push(patch.cacheWritePrice); }
	if (patch.failureReason !== undefined) { sets.push('failure_reason = ?'); values.push(patch.failureReason); }
	return { sets, values };
}

export function createD1PortalAccessRepository(db: D1DatabaseClient): PortalAccessRepository {
	const raw = db.raw;
	return {
		async insertSession(session: PortalSessionRow) {
			await raw.prepare('INSERT INTO portal_sessions (token_hash, subject, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
				.bind(session.tokenHash, session.subject, session.email, session.createdAt, session.expiresAt).run();
		},
		async getValidSession(tokenHash, nowIso) {
			const row = await raw.prepare('SELECT token_hash, subject, email, created_at, expires_at FROM portal_sessions WHERE token_hash = ? AND expires_at > ?')
				.bind(tokenHash, nowIso).first<PortalSessionRow>();
			return row ?? null;
		},
		async deleteSession(tokenHash) {
			await raw.prepare('DELETE FROM portal_sessions WHERE token_hash = ?').bind(tokenHash).run();
		},
		async deleteExpiredSessions(nowIso) {
			await raw.prepare('DELETE FROM portal_sessions WHERE expires_at <= ?').bind(nowIso).run();
		},
	};
}

export function createD1SharedKeysRepository(db: D1DatabaseClient): SharedKeysRepository {
	const raw = db.raw;
	return {
		async insertSharedKey(params: InsertSharedKeyParams) {
			await raw.prepare(`INSERT INTO shared_keys
          (id, seller_user_id, channel_type, api_key, key_fingerprint, label, status, weight,
           input_price, output_price, cache_read_price, cache_write_price, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'validating', ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					params.id,
					params.sellerUserId,
					params.channelType,
					params.apiKey,
					params.keyFingerprint,
					params.label ?? null,
					params.weight,
					params.inputPrice,
					params.outputPrice,
					params.cacheReadPrice ?? null,
					params.cacheWritePrice ?? null,
					params.nowIso,
					params.nowIso
				).run();
		},
		async getSharedKeyById(id) {
			const row = await raw.prepare(`SELECT ${SHARED_KEY_COLUMNS} FROM shared_keys WHERE id = ?`)
				.bind(id).first<SharedKeySqlRow>();
			return row ? mapSharedKey(row) : null;
		},
		async listSharedKeysBySeller(sellerUserId) {
			const rows = await raw.prepare(`SELECT ${SHARED_KEY_COLUMNS} FROM shared_keys WHERE seller_user_id = ? ORDER BY created_at DESC`)
				.bind(sellerUserId).all<SharedKeySqlRow>();
			return (rows.results ?? []).map(mapSharedKey);
		},
		async listAllSharedKeys(options) {
			const conditions: string[] = [];
			const values: unknown[] = [];
			if (options?.status) { conditions.push('status = ?'); values.push(options.status); }
			if (options?.channelType) { conditions.push('channel_type = ?'); values.push(options.channelType); }
			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
			const stmt = raw.prepare(`SELECT ${SHARED_KEY_COLUMNS} FROM shared_keys ${where} ${SHARED_KEY_ORDER_SQL}`);
			const rows = await (values.length > 0 ? stmt.bind(...values) : stmt).all<SharedKeySqlRow>();
			return (rows.results ?? []).map(mapSharedKey);
		},
		async listActiveSharedKeysByChannel(channelType) {
			const rows = await raw.prepare(`SELECT ${SHARED_KEY_COLUMNS} FROM shared_keys WHERE channel_type = ? AND status = 'active' ${SHARED_KEY_ORDER_SQL}`)
				.bind(channelType).all<SharedKeySqlRow>();
			return (rows.results ?? []).map(mapSharedKey);
		},
		async updateSharedKey(id, patch) {
			const { sets, values } = buildSharedKeyPatch(patch);
			if (sets.length === 0) return false;
			const result = await raw.prepare(`UPDATE shared_keys SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
				.bind(...values, id).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async markSharedKeyFailure(id, reason, nowIso) {
			await raw.prepare(`UPDATE shared_keys SET status = 'invalid', failure_reason = ?, last_failure_at = ?, updated_at = ? WHERE id = ?`)
				.bind(reason, nowIso, nowIso, id).run();
		},
		async deleteSharedKey(id) {
			const result = await raw.prepare('DELETE FROM shared_keys WHERE id = ?').bind(id).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async addSharedKeyUsage(id, inputTokens, outputTokens, netAmount, nowIso) {
			await raw.prepare(`UPDATE shared_keys
          SET served_input_tokens = served_input_tokens + ?,
              served_output_tokens = served_output_tokens + ?,
              earned_total = earned_total + ?,
              last_used_at = ?, updated_at = ?
          WHERE id = ?`)
				.bind(inputTokens, outputTokens, netAmount, nowIso, nowIso, id).run();
		},
	};
}

export function createD1PortalLedgerRepository(db: D1DatabaseClient): PortalLedgerRepository {
	const raw = db.raw;
	return {
		async getUserEarnings(userId) {
			const row = await raw.prepare(`SELECT user_id, balance, locked_amount, lifetime_earned, lifetime_withdrawn,
          contribution_value, wallet_address, wallet_verified_at, highest_badge_tier, updated_at
          FROM user_earnings WHERE user_id = ?`).bind(userId)
				.first<{
					user_id: string;
					balance: number;
					locked_amount: number;
					lifetime_earned: number;
					lifetime_withdrawn: number;
					contribution_value: number;
					wallet_address: string | null;
					wallet_verified_at: string | null;
					highest_badge_tier: number;
					updated_at: string;
				}>();
			if (!row) return null;
			return {
				userId: row.user_id,
				balance: Number(row.balance),
				lockedAmount: Number(row.locked_amount),
				lifetimeEarned: Number(row.lifetime_earned),
				lifetimeWithdrawn: Number(row.lifetime_withdrawn),
				contributionValue: Number(row.contribution_value),
				walletAddress: row.wallet_address,
				walletVerifiedAt: row.wallet_verified_at,
				highestBadgeTier: row.highest_badge_tier,
				updatedAt: row.updated_at,
			};
		},
		async ensureUserEarnings(userId) {
			await raw.prepare('INSERT OR IGNORE INTO user_earnings (user_id) VALUES (?)').bind(userId).run();
		},
		async updateWallet(userId, walletAddress, verifiedAtIso) {
			await raw.prepare(`INSERT INTO user_earnings (user_id, wallet_address, wallet_verified_at, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET wallet_address = excluded.wallet_address,
            wallet_verified_at = excluded.wallet_verified_at, updated_at = excluded.updated_at`)
				.bind(userId, walletAddress, verifiedAtIso).run();
		},
		async insertEarning(params: InsertSharedKeyEarningParams) {
			const result = await raw.prepare(`INSERT OR IGNORE INTO shared_key_earnings
          (id, request_log_id, shared_key_id, seller_user_id, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, gross_amount, platform_fee, net_amount, currency, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					params.id,
					params.requestLogId,
					params.sharedKeyId,
					params.sellerUserId,
					params.inputTokens,
					params.outputTokens,
					params.cacheReadTokens,
					params.cacheWriteTokens,
					params.grossAmount,
					params.platformFee,
					params.netAmount,
					params.currency,
					params.nowIso
				).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async creditEarningBalance(sellerUserId, netAmount, nowIso) {
			await raw.prepare(`UPDATE user_earnings
          SET balance = balance + ?, lifetime_earned = lifetime_earned + ?,
              contribution_value = contribution_value + ?, updated_at = ?
          WHERE user_id = ?`)
				.bind(netAmount, netAmount, netAmount, nowIso, sellerUserId).run();
		},
		async listEarningsBySeller(sellerUserId, page, pageSize) {
			const offset = (page - 1) * pageSize;
			const rows = await raw.prepare(`SELECT id, request_log_id, shared_key_id, seller_user_id, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, gross_amount, platform_fee, net_amount, currency, created_at
          FROM shared_key_earnings WHERE seller_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
				.bind(sellerUserId, pageSize, offset).all<SharedKeyEarningRow & Record<string, unknown>>();
			const totalRow = await raw.prepare('SELECT COUNT(*) AS total FROM shared_key_earnings WHERE seller_user_id = ?')
				.bind(sellerUserId).first<{ total: number }>();
			return {
				rows: (rows.results ?? []).map((row) => ({
					...row,
					grossAmount: Number(row.grossAmount),
					platformFee: Number(row.platformFee),
					netAmount: Number(row.netAmount),
				})) as SharedKeyEarningRow[],
				total: Number(totalRow?.total ?? 0),
			};
		},
		async insertWithdrawal(params: InsertWithdrawalParams) {
			await raw.prepare(`INSERT INTO withdrawals
          (id, user_id, amount, fee, net_amount, currency, wallet_address, status, token_amount, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`)
				.bind(
					params.id,
					params.userId,
					params.amount,
					params.fee,
					params.netAmount,
					params.currency,
					params.walletAddress,
					params.tokenAmount,
					params.nowIso,
					params.nowIso
				).run();
		},
		async getWithdrawal(id) {
			const row = await raw.prepare(`SELECT id, user_id, amount, fee, net_amount, currency, wallet_address, status,
          token_amount, tx_hash, chain_id, failure_reason, created_at, updated_at, confirmed_at
          FROM withdrawals WHERE id = ?`).bind(id).first<WithdrawalRow & Record<string, unknown>>();
			return row ? { ...row, amount: Number(row.amount), fee: Number(row.fee), netAmount: Number(row.netAmount), tokenAmount: row.tokenAmount == null ? null : Number(row.tokenAmount) } as WithdrawalRow : null;
		},
		async getActiveWithdrawalByUser(userId) {
			const row = await raw.prepare(`SELECT id, user_id, amount, fee, net_amount, currency, wallet_address, status,
          token_amount, tx_hash, chain_id, failure_reason, created_at, updated_at, confirmed_at
          FROM withdrawals WHERE user_id = ? AND status IN ('requested', 'processing', 'submitted') LIMIT 1`)
				.bind(userId).first<WithdrawalRow & Record<string, unknown>>();
			return row ? { ...row, amount: Number(row.amount), fee: Number(row.fee), netAmount: Number(row.netAmount), tokenAmount: row.tokenAmount == null ? null : Number(row.tokenAmount) } as WithdrawalRow : null;
		},
		async listWithdrawalsByUser(userId, page, pageSize) {
			const offset = (page - 1) * pageSize;
			const rows = await raw.prepare(`SELECT id, user_id, amount, fee, net_amount, currency, wallet_address, status,
          token_amount, tx_hash, chain_id, failure_reason, created_at, updated_at, confirmed_at
          FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
				.bind(userId, pageSize, offset).all<WithdrawalRow & Record<string, unknown>>();
			const totalRow = await raw.prepare('SELECT COUNT(*) AS total FROM withdrawals WHERE user_id = ?')
				.bind(userId).first<{ total: number }>();
			return {
				rows: (rows.results ?? []).map((row) => ({
					...row,
					amount: Number(row.amount),
					fee: Number(row.fee),
					netAmount: Number(row.netAmount),
					tokenAmount: row.tokenAmount == null ? null : Number(row.tokenAmount),
				})) as WithdrawalRow[],
				total: Number(totalRow?.total ?? 0),
			};
		},
		async listAllWithdrawals(status) {
			const stmt = status
				? raw.prepare(`SELECT id, user_id, amount, fee, net_amount, currency, wallet_address, status,
            token_amount, tx_hash, chain_id, failure_reason, created_at, updated_at, confirmed_at
            FROM withdrawals WHERE status = ? ORDER BY created_at DESC, id DESC`)
				: raw.prepare(`SELECT id, user_id, amount, fee, net_amount, currency, wallet_address, status,
            token_amount, tx_hash, chain_id, failure_reason, created_at, updated_at, confirmed_at
            FROM withdrawals ORDER BY created_at DESC, id DESC`);
			const rows = await (status ? stmt.bind(status) : stmt).all<WithdrawalRow & Record<string, unknown>>();
			return (rows.results ?? []).map((row) => ({
				...row,
				amount: Number(row.amount),
				fee: Number(row.fee),
				netAmount: Number(row.netAmount),
				tokenAmount: row.tokenAmount == null ? null : Number(row.tokenAmount),
			})) as WithdrawalRow[];
		},
		async lockBalanceForWithdrawal(userId, amount, nowIso) {
			const result = await raw.prepare(`UPDATE user_earnings
          SET balance = balance - ?, locked_amount = locked_amount + ?, updated_at = ?
          WHERE user_id = ? AND balance >= ?`)
				.bind(amount, amount, nowIso, userId, amount).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async settleWithdrawalConfirmed(id, userId, amount, nowIso) {
			await raw.prepare(`UPDATE user_earnings
          SET locked_amount = locked_amount - ?, lifetime_withdrawn = lifetime_withdrawn + ?, updated_at = ?
          WHERE user_id = ?`)
				.bind(amount, amount, nowIso, userId).run();
			await raw.prepare('UPDATE withdrawals SET status = \'confirmed\', confirmed_at = ?, updated_at = ? WHERE id = ?')
				.bind(nowIso, nowIso, id).run();
		},
		async refundWithdrawal(id, userId, amount, reason, nowIso) {
			await raw.prepare(`UPDATE user_earnings
          SET locked_amount = locked_amount - ?, balance = balance + ?, updated_at = ?
          WHERE user_id = ?`)
				.bind(amount, amount, nowIso, userId).run();
			await raw.prepare(`UPDATE withdrawals SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?`)
				.bind(reason, nowIso, id).run();
		},
		async updateWithdrawalStatus(id, patch) {
			const sets: string[] = ['updated_at = ?'];
			const values: unknown[] = [patch.nowIso];
			if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
			if (patch.txHash !== undefined) { sets.push('tx_hash = ?'); values.push(patch.txHash); }
			if (patch.chainId !== undefined) { sets.push('chain_id = ?'); values.push(patch.chainId); }
			if (patch.tokenAmount !== undefined) { sets.push('token_amount = ?'); values.push(patch.tokenAmount); }
			if (patch.failureReason !== undefined) { sets.push('failure_reason = ?'); values.push(patch.failureReason); }
			const result = await raw.prepare(`UPDATE withdrawals SET ${sets.join(', ')} WHERE id = ?`)
				.bind(...values, id).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async insertNftMint(params: InsertNftMintParams) {
			const result = await raw.prepare(`INSERT OR IGNORE INTO nft_mints
          (id, user_id, badge_token_id, tier_name, wallet_address, status, value_snapshot, created_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
				.bind(params.id, params.userId, params.badgeTokenId, params.tierName, params.walletAddress, params.valueSnapshot, params.nowIso)
				.run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async getNftMintsByUser(userId) {
			const rows = await raw.prepare(`SELECT id, user_id, badge_token_id, tier_name, wallet_address, status,
          tx_hash, chain_id, value_snapshot, failure_reason, created_at, confirmed_at
          FROM nft_mints WHERE user_id = ? ORDER BY created_at DESC`)
				.bind(userId).all<NftMintRow & Record<string, unknown>>();
			return (rows.results ?? []).map((row) => ({ ...row, valueSnapshot: Number(row.valueSnapshot) })) as NftMintRow[];
		},
		async listAllNftMints(status) {
			const stmt = status
				? raw.prepare(`SELECT id, user_id, badge_token_id, tier_name, wallet_address, status,
            tx_hash, chain_id, value_snapshot, failure_reason, created_at, confirmed_at
            FROM nft_mints WHERE status = ? ORDER BY created_at DESC`)
				: raw.prepare(`SELECT id, user_id, badge_token_id, tier_name, wallet_address, status,
            tx_hash, chain_id, value_snapshot, failure_reason, created_at, confirmed_at
            FROM nft_mints ORDER BY created_at DESC`);
			const rows = await (status ? stmt.bind(status) : stmt).all<NftMintRow & Record<string, unknown>>();
			return (rows.results ?? []).map((row) => ({ ...row, valueSnapshot: Number(row.valueSnapshot) })) as NftMintRow[];
		},
		async updateNftMintStatus(id, patch) {
			const sets: string[] = [];
			const values: unknown[] = [];
			if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
			if (patch.txHash !== undefined) { sets.push('tx_hash = ?'); values.push(patch.txHash); }
			if (patch.chainId !== undefined) { sets.push('chain_id = ?'); values.push(patch.chainId); }
			if (patch.failureReason !== undefined) { sets.push('failure_reason = ?'); values.push(patch.failureReason); }
			if (patch.confirmedAt !== undefined) { sets.push('confirmed_at = ?'); values.push(patch.confirmedAt); }
			if (sets.length === 0) return false;
			const result = await raw.prepare(`UPDATE nft_mints SET ${sets.join(', ')} WHERE id = ?`)
				.bind(...values, id).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async setHighestBadgeTier(userId, tier, nowIso) {
			await raw.prepare('UPDATE user_earnings SET highest_badge_tier = ?, updated_at = ? WHERE user_id = ?')
				.bind(tier, nowIso, userId).run();
		},
	};
}
