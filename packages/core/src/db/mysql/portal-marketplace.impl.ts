import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { MySqlDatabaseClient } from '../../storage/database-client';
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
	input_price: string | number;
	output_price: string | number;
	cache_read_price: string | number | null;
	cache_write_price: string | number | null;
	validated_at: string | null;
	last_used_at: string | null;
	last_failure_at: string | null;
	failure_reason: string | null;
	served_input_tokens: number;
	served_output_tokens: number;
	earned_total: string | number;
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

function buildSharedKeyPatch(patch: UpdateSharedKeyPatch): { sets: string[]; values: (string | number | null)[] } {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];
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

export function createMySqlPortalAccessRepository(db: MySqlDatabaseClient): PortalAccessRepository {
	const pool = db.raw;
	return {
		async insertSession(session: PortalSessionRow) {
			await pool.execute<ResultSetHeader>(
				'INSERT INTO portal_sessions (token_hash, subject, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
				[session.tokenHash, session.subject, session.email, session.createdAt, session.expiresAt]
			);
		},
		async getValidSession(tokenHash, nowIso) {
			const [rows] = await pool.execute<RowDataPacket[]>(
				'SELECT token_hash, subject, email, created_at, expires_at FROM portal_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1',
				[tokenHash, nowIso]
			);
			const row = rows[0] as { token_hash: string; subject: string; email: string; created_at: string; expires_at: string } | undefined;
			return row
				? { tokenHash: row.token_hash, subject: row.subject, email: row.email, createdAt: row.created_at, expiresAt: row.expires_at }
				: null;
		},
		async deleteSession(tokenHash) {
			await pool.execute<ResultSetHeader>('DELETE FROM portal_sessions WHERE token_hash = ?', [tokenHash]);
		},
		async deleteExpiredSessions(nowIso) {
			await pool.execute<ResultSetHeader>('DELETE FROM portal_sessions WHERE expires_at <= ?', [nowIso]);
		},
	};
}

export function createMySqlSharedKeysRepository(db: MySqlDatabaseClient): SharedKeysRepository {
	const pool = db.raw;
	return {
		async insertSharedKey(params: InsertSharedKeyParams) {
			await pool.execute<ResultSetHeader>(
				`INSERT INTO shared_keys
          (id, seller_user_id, channel_type, api_key, key_fingerprint, label, status, weight,
           input_price, output_price, cache_read_price, cache_write_price, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'validating', ?, ?, ?, ?, ?, ?, ?)`,
				[
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
					params.nowIso,
				]
			);
		},
		async getSharedKeyById(id) {
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT ${SHARED_KEY_COLUMNS} FROM shared_keys WHERE id = ? LIMIT 1`,
				[id]
			);
			return rows[0] ? mapSharedKey(rows[0] as unknown as SharedKeySqlRow) : null;
		},
		async listSharedKeysBySeller(sellerUserId) {
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT ${SHARED_KEY_COLUMNS} FROM shared_keys WHERE seller_user_id = ? ORDER BY created_at DESC`,
				[sellerUserId]
			);
			return (rows as unknown as SharedKeySqlRow[]).map(mapSharedKey);
		},
		async listAllSharedKeys(options) {
			const conditions: string[] = [];
			const values: (string | number | null)[] = [];
			if (options?.status) { conditions.push('status = ?'); values.push(options.status); }
			if (options?.channelType) { conditions.push('channel_type = ?'); values.push(options.channelType); }
			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT ${SHARED_KEY_COLUMNS} FROM shared_keys ${where} ${SHARED_KEY_ORDER_SQL}`,
				values
			);
			return (rows as unknown as SharedKeySqlRow[]).map(mapSharedKey);
		},
		async listActiveSharedKeysByChannel(channelType) {
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT ${SHARED_KEY_COLUMNS} FROM shared_keys WHERE channel_type = ? AND status = 'active' ${SHARED_KEY_ORDER_SQL}`,
				[channelType]
			);
			return (rows as unknown as SharedKeySqlRow[]).map(mapSharedKey);
		},
		async updateSharedKey(id, patch) {
			const { sets, values } = buildSharedKeyPatch(patch);
			if (sets.length === 0) return false;
			const [result] = await pool.execute<ResultSetHeader>(
				`UPDATE shared_keys SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ?`,
				[...values, id]
			);
			return result.affectedRows > 0;
		},
		async markSharedKeyFailure(id, reason, nowIso) {
			await pool.execute<ResultSetHeader>(
				`UPDATE shared_keys SET status = 'invalid', failure_reason = ?, last_failure_at = ?, updated_at = ? WHERE id = ?`,
				[reason, nowIso, nowIso, id]
			);
		},
		async deleteSharedKey(id) {
			const [result] = await pool.execute<ResultSetHeader>('DELETE FROM shared_keys WHERE id = ?', [id]);
			return result.affectedRows > 0;
		},
		async addSharedKeyUsage(id, inputTokens, outputTokens, netAmount, nowIso) {
			await pool.execute<ResultSetHeader>(
				`UPDATE shared_keys
          SET served_input_tokens = served_input_tokens + ?,
              served_output_tokens = served_output_tokens + ?,
              earned_total = earned_total + ?,
              last_used_at = ?, updated_at = ?
          WHERE id = ?`,
				[inputTokens, outputTokens, netAmount, nowIso, nowIso, id]
			);
		},
	};
}

type UserEarningsSqlRow = {
	user_id: string;
	balance: string | number;
	locked_amount: string | number;
	lifetime_earned: string | number;
	lifetime_withdrawn: string | number;
	contribution_value: string | number;
	wallet_address: string | null;
	wallet_verified_at: string | null;
	highest_badge_tier: number;
	updated_at: string;
};

function mapUserEarnings(row: UserEarningsSqlRow): UserEarningsRow {
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
}

type EarningSqlRow = {
	id: string;
	request_log_id: string;
	shared_key_id: string;
	seller_user_id: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	gross_amount: string | number;
	platform_fee: string | number;
	net_amount: string | number;
	currency: string;
	created_at: string;
};

function mapEarning(row: EarningSqlRow): SharedKeyEarningRow {
	return {
		id: row.id,
		requestLogId: row.request_log_id,
		sharedKeyId: row.shared_key_id,
		sellerUserId: row.seller_user_id,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheWriteTokens: row.cache_write_tokens,
		grossAmount: Number(row.gross_amount),
		platformFee: Number(row.platform_fee),
		netAmount: Number(row.net_amount),
		currency: row.currency,
		createdAt: row.created_at,
	};
}

type WithdrawalSqlRow = {
	id: string;
	user_id: string;
	amount: string | number;
	fee: string | number;
	net_amount: string | number;
	currency: string;
	wallet_address: string;
	status: string;
	token_amount: string | number | null;
	tx_hash: string | null;
	chain_id: number | null;
	failure_reason: string | null;
	created_at: string;
	updated_at: string;
	confirmed_at: string | null;
};

function mapWithdrawal(row: WithdrawalSqlRow): WithdrawalRow {
	return {
		id: row.id,
		userId: row.user_id,
		amount: Number(row.amount),
		fee: Number(row.fee),
		netAmount: Number(row.net_amount),
		currency: row.currency,
		walletAddress: row.wallet_address,
		status: row.status,
		tokenAmount: row.token_amount === null ? null : Number(row.token_amount),
		txHash: row.tx_hash,
		chainId: row.chain_id,
		failureReason: row.failure_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		confirmedAt: row.confirmed_at,
	};
}

type NftMintSqlRow = {
	id: string;
	user_id: string;
	badge_token_id: number;
	tier_name: string;
	wallet_address: string;
	status: string;
	tx_hash: string | null;
	chain_id: number | null;
	value_snapshot: string | number;
	failure_reason: string | null;
	created_at: string;
	confirmed_at: string | null;
};

function mapNftMint(row: NftMintSqlRow): NftMintRow {
	return {
		id: row.id,
		userId: row.user_id,
		badgeTokenId: row.badge_token_id,
		tierName: row.tier_name,
		walletAddress: row.wallet_address,
		status: row.status,
		txHash: row.tx_hash,
		chainId: row.chain_id,
		valueSnapshot: Number(row.value_snapshot),
		failureReason: row.failure_reason,
		createdAt: row.created_at,
		confirmedAt: row.confirmed_at,
	};
}

const WITHDRAWAL_COLUMNS = `id, user_id, amount, fee, net_amount, currency, wallet_address, status,
  token_amount, tx_hash, chain_id, failure_reason, created_at, updated_at, confirmed_at`;

const NFT_MINT_COLUMNS = `id, user_id, badge_token_id, tier_name, wallet_address, status,
  tx_hash, chain_id, value_snapshot, failure_reason, created_at, confirmed_at`;

export function createMySqlPortalLedgerRepository(db: MySqlDatabaseClient): PortalLedgerRepository {
	const pool = db.raw;
	return {
		async getUserEarnings(userId) {
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT user_id, balance, locked_amount, lifetime_earned, lifetime_withdrawn,
          contribution_value, wallet_address, wallet_verified_at, highest_badge_tier, updated_at
          FROM user_earnings WHERE user_id = ? LIMIT 1`,
				[userId]
			);
			return rows[0] ? mapUserEarnings(rows[0] as unknown as UserEarningsSqlRow) : null;
		},
		async ensureUserEarnings(userId) {
			await pool.execute<ResultSetHeader>(
				'INSERT IGNORE INTO user_earnings (user_id) VALUES (?)',
				[userId]
			);
		},
		async updateWallet(userId, walletAddress, verifiedAtIso) {
			await pool.execute<ResultSetHeader>(
				`INSERT INTO user_earnings (user_id, wallet_address, wallet_verified_at)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE wallet_address = VALUES(wallet_address),
            wallet_verified_at = VALUES(wallet_verified_at), updated_at = CURRENT_TIMESTAMP(6)`,
				[userId, walletAddress, verifiedAtIso]
			);
		},
		async insertEarning(params: InsertSharedKeyEarningParams) {
			try {
				const [result] = await pool.execute<ResultSetHeader>(
					`INSERT INTO shared_key_earnings
            (id, request_log_id, shared_key_id, seller_user_id, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, gross_amount, platform_fee, net_amount, currency, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
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
						params.nowIso,
					]
				);
				return result.affectedRows > 0;
			} catch (error) {
				if (error instanceof Error && error.message.includes('Duplicate entry')) return false;
				throw error;
			}
		},
		async creditEarningBalance(sellerUserId, netAmount, nowIso) {
			await pool.execute<ResultSetHeader>(
				`UPDATE user_earnings
          SET balance = balance + ?, lifetime_earned = lifetime_earned + ?,
              contribution_value = contribution_value + ?, updated_at = ?
          WHERE user_id = ?`,
				[netAmount, netAmount, netAmount, nowIso, sellerUserId]
			);
		},
		async listEarningsBySeller(sellerUserId, page, pageSize) {
			const offset = (page - 1) * pageSize;
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT id, request_log_id, shared_key_id, seller_user_id, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, gross_amount, platform_fee, net_amount, currency, created_at
          FROM shared_key_earnings WHERE seller_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
				[sellerUserId, pageSize, offset]
			);
			const [totalRows] = await pool.execute<RowDataPacket[]>(
				'SELECT COUNT(*) AS total FROM shared_key_earnings WHERE seller_user_id = ?',
				[sellerUserId]
			);
			return {
				rows: (rows as unknown as EarningSqlRow[]).map(mapEarning),
				total: Number((totalRows[0] as { total: number | string } | undefined)?.total ?? 0),
			};
		},
		async insertWithdrawal(params: InsertWithdrawalParams) {
			await pool.execute<ResultSetHeader>(
				`INSERT INTO withdrawals
          (id, user_id, amount, fee, net_amount, currency, wallet_address, status, token_amount, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
				[
					params.id,
					params.userId,
					params.amount,
					params.fee,
					params.netAmount,
					params.currency,
					params.walletAddress,
					params.tokenAmount,
					params.nowIso,
					params.nowIso,
				]
			);
		},
		async getWithdrawal(id) {
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE id = ? LIMIT 1`,
				[id]
			);
			return rows[0] ? mapWithdrawal(rows[0] as unknown as WithdrawalSqlRow) : null;
		},
		async getActiveWithdrawalByUser(userId) {
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals
          WHERE user_id = ? AND status IN ('requested', 'processing', 'submitted') LIMIT 1`,
				[userId]
			);
			return rows[0] ? mapWithdrawal(rows[0] as unknown as WithdrawalSqlRow) : null;
		},
		async listWithdrawalsByUser(userId, page, pageSize) {
			const offset = (page - 1) * pageSize;
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
				[userId, pageSize, offset]
			);
			const [totalRows] = await pool.execute<RowDataPacket[]>(
				'SELECT COUNT(*) AS total FROM withdrawals WHERE user_id = ?',
				[userId]
			);
			return {
				rows: (rows as unknown as WithdrawalSqlRow[]).map(mapWithdrawal),
				total: Number((totalRows[0] as { total: number | string } | undefined)?.total ?? 0),
			};
		},
		async listAllWithdrawals(status) {
			const [rows] = status
				? await pool.execute<RowDataPacket[]>(
					`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE status = ? ORDER BY created_at DESC, id DESC`,
					[status]
				)
				: await pool.execute<RowDataPacket[]>(
					`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals ORDER BY created_at DESC, id DESC`
				);
			return (rows as unknown as WithdrawalSqlRow[]).map(mapWithdrawal);
		},
		async lockBalanceForWithdrawal(userId, amount, nowIso) {
			const [result] = await pool.execute<ResultSetHeader>(
				`UPDATE user_earnings
          SET balance = balance - ?, locked_amount = locked_amount + ?, updated_at = ?
          WHERE user_id = ? AND balance >= ?`,
				[amount, amount, nowIso, userId, amount]
			);
			return result.affectedRows > 0;
		},
		async settleWithdrawalConfirmed(id, userId, amount, nowIso) {
			await pool.execute<ResultSetHeader>(
				`UPDATE user_earnings
          SET locked_amount = locked_amount - ?, lifetime_withdrawn = lifetime_withdrawn + ?, updated_at = ?
          WHERE user_id = ?`,
				[amount, amount, nowIso, userId]
			);
			await pool.execute<ResultSetHeader>(
				`UPDATE withdrawals SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?`,
				[nowIso, nowIso, id]
			);
		},
		async refundWithdrawal(id, userId, amount, reason, nowIso) {
			await pool.execute<ResultSetHeader>(
				`UPDATE user_earnings
          SET locked_amount = locked_amount - ?, balance = balance + ?, updated_at = ?
          WHERE user_id = ?`,
				[amount, amount, nowIso, userId]
			);
			await pool.execute<ResultSetHeader>(
				`UPDATE withdrawals SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?`,
				[reason, nowIso, id]
			);
		},
		async updateWithdrawalStatus(id, patch) {
			const sets: string[] = ['updated_at = ?'];
			const values: (string | number | null)[] = [patch.nowIso];
			if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
			if (patch.txHash !== undefined) { sets.push('tx_hash = ?'); values.push(patch.txHash); }
			if (patch.chainId !== undefined) { sets.push('chain_id = ?'); values.push(patch.chainId); }
			if (patch.tokenAmount !== undefined) { sets.push('token_amount = ?'); values.push(patch.tokenAmount); }
			if (patch.failureReason !== undefined) { sets.push('failure_reason = ?'); values.push(patch.failureReason); }
			const [result] = await pool.execute<ResultSetHeader>(
				`UPDATE withdrawals SET ${sets.join(', ')} WHERE id = ?`,
				[...values, id]
			);
			return result.affectedRows > 0;
		},
		async insertNftMint(params: InsertNftMintParams) {
			try {
				const [result] = await pool.execute<ResultSetHeader>(
					`INSERT INTO nft_mints
            (id, user_id, badge_token_id, tier_name, wallet_address, status, value_snapshot, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
					[params.id, params.userId, params.badgeTokenId, params.tierName, params.walletAddress, params.valueSnapshot, params.nowIso]
				);
				return result.affectedRows > 0;
			} catch (error) {
				if (error instanceof Error && error.message.includes('Duplicate entry')) return false;
				throw error;
			}
		},
		async getNftMintsByUser(userId) {
			const [rows] = await pool.execute<RowDataPacket[]>(
				`SELECT ${NFT_MINT_COLUMNS} FROM nft_mints WHERE user_id = ? ORDER BY created_at DESC`,
				[userId]
			);
			return (rows as unknown as NftMintSqlRow[]).map(mapNftMint);
		},
		async listAllNftMints(status) {
			const [rows] = status
				? await pool.execute<RowDataPacket[]>(
					`SELECT ${NFT_MINT_COLUMNS} FROM nft_mints WHERE status = ? ORDER BY created_at DESC`,
					[status]
				)
				: await pool.execute<RowDataPacket[]>(`SELECT ${NFT_MINT_COLUMNS} FROM nft_mints ORDER BY created_at DESC`);
			return (rows as unknown as NftMintSqlRow[]).map(mapNftMint);
		},
		async updateNftMintStatus(id, patch) {
			const sets: string[] = [];
			const values: (string | number | null)[] = [];
			if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
			if (patch.txHash !== undefined) { sets.push('tx_hash = ?'); values.push(patch.txHash); }
			if (patch.chainId !== undefined) { sets.push('chain_id = ?'); values.push(patch.chainId); }
			if (patch.failureReason !== undefined) { sets.push('failure_reason = ?'); values.push(patch.failureReason); }
			if (patch.confirmedAt !== undefined) { sets.push('confirmed_at = ?'); values.push(patch.confirmedAt); }
			if (sets.length === 0) return false;
			const [result] = await pool.execute<ResultSetHeader>(
				`UPDATE nft_mints SET ${sets.join(', ')} WHERE id = ?`,
				[...values, id]
			);
			return result.affectedRows > 0;
		},
		async setHighestBadgeTier(userId, tier, nowIso) {
			await pool.execute<ResultSetHeader>(
				'UPDATE user_earnings SET highest_badge_tier = ?, updated_at = ? WHERE user_id = ?',
				[tier, nowIso, userId]
			);
		},
	};
}
