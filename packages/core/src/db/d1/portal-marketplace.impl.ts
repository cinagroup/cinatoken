import type { D1DatabaseClient } from '../../storage/database-client';
import { createD1SharedKeyAdminRepository } from '../admin-shared-key-repository';
import { assertSellerSharedKeyPatch, assertSharedKeyValidation, SHARED_KEY_STATE_COLUMNS, sharedKeySellerAssignments, sharedKeyStateValues } from '../shared-key-state';
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

const WITHDRAWAL_COLUMNS = `id, user_id AS userId, amount, fee, net_amount AS netAmount, currency,
  wallet_address AS walletAddress, status, token_amount AS tokenAmount, tx_hash AS txHash,
  chain_id AS chainId, failure_reason AS failureReason, created_at AS createdAt,
  updated_at AS updatedAt, confirmed_at AS confirmedAt`;

const WITHDRAWAL_REFUND_TRIGGER = 'withdrawals_refund_after_status_update';
// Complete sqlite_master definitions produced by formal 0077, with LF/CRLF.
// Do not normalize SQL: even whitespace in a literal can change its meaning.
const WITHDRAWAL_REFUND_DEFINITIONS = new Map([
	['4f5b4aec1fe24c8e57503317a8dc9ce7569892f81d702bdceef554451f7b49b6', 1078],
	['55cd97b1e5ec065ab3b644644ddfe0e9612ece32c277aa1eba3dedd81c648837', 1098],
]);

async function approvedWithdrawalRefundDefinition(raw: D1DatabaseClient['raw']): Promise<string> {
	try {
		// Inspect the actual trigger on every attempt, not a migration marker or
		// a cached successful check. Bound the returned definition and row count.
		const result = await raw.prepare(`SELECT type AS object_type, name AS object_name,
			tbl_name AS table_name, length(CAST(sql AS BLOB)) AS sql_bytes,
			CASE WHEN length(CAST(sql AS BLOB)) <= ? THEN sql END AS definition
			FROM main.sqlite_master WHERE name = ? COLLATE BINARY LIMIT 2`)
			.bind(4096, WITHDRAWAL_REFUND_TRIGGER).all<unknown>();
		if (result.success !== true || !Array.isArray(result.results) || result.results.length !== 1) throw new Error();
		const row = result.results[0];
		if (!row || typeof row !== 'object' || Array.isArray(row)
			|| !('object_type' in row) || row.object_type !== 'trigger'
			|| !('object_name' in row) || row.object_name !== WITHDRAWAL_REFUND_TRIGGER
			|| !('table_name' in row) || row.table_name !== 'withdrawals'
			|| !('definition' in row) || typeof row.definition !== 'string' || row.definition.length > 4096
			|| !('sql_bytes' in row)) throw new Error();
		const bytes = new TextEncoder().encode(row.definition);
		const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
			byte => byte.toString(16).padStart(2, '0')).join('');
		if (bytes.length !== row.sql_bytes || WITHDRAWAL_REFUND_DEFINITIONS.get(digest) !== row.sql_bytes) throw new Error();
		return row.definition;
	} catch {
		// Never expose trigger text or adapter diagnostics through an Admin error.
		throw new Error('withdrawal_rejection_schema_unavailable');
	}
}

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
		earnedTotalExact: String(row.earned_total),
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
		...createD1SharedKeyAdminRepository(db),
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
			if (patch.status === 'invalid' || patch.status === 'validating') sets.push('validated_at = NULL');
			const statusGuard = patch.status === 'active' ? " AND status IN ('active','paused') AND validated_at IS NOT NULL"
				: patch.status === 'paused' ? " AND status IN ('active','paused','disabled')" : '';
			const result = await raw.prepare(`UPDATE shared_keys SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?${statusGuard}`)
				.bind(...values, id).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async updateSharedKeyForSeller(id, patch, expected) {
			const ownedPatch = assertSellerSharedKeyPatch(patch, expected);
			const { sets, values } = sharedKeySellerAssignments(ownedPatch);
			if (sets.length === 0) return false;
			const condition = SHARED_KEY_STATE_COLUMNS.map(column => `${column} IS ?`).join(' AND ');
			const result = await raw.prepare(`UPDATE shared_keys SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND ${condition}`)
				.bind(...values, id, ...sharedKeyStateValues(expected)).run();
			return Number(result.meta.changes ?? 0) === 1;
		},
		async completeSharedKeyValidation(id, expected, result, nowIso) {
			assertSharedKeyValidation(expected, result, nowIso);
			const condition = SHARED_KEY_STATE_COLUMNS.map(column => `${column} IS ?`).join(' AND ');
			const written = await raw.prepare(`UPDATE shared_keys SET status = ?, validated_at = ?, failure_reason = ?,
				last_failure_at = CASE WHEN ? = 1 THEN last_failure_at ELSE ? END, updated_at = ? WHERE id = ? AND ${condition}`)
				.bind(result.valid ? 'active' : 'invalid', result.valid ? nowIso : null, result.valid ? null : result.reason,
					result.valid ? 1 : 0, nowIso, nowIso, id, ...sharedKeyStateValues(expected)).run();
			return Number(written.meta.changes ?? 0) === 1;
		},
		async replaceSharedKeySecret(id, protectedSecret) {
			const result = await raw.prepare("UPDATE shared_keys SET api_key = ?, updated_at = datetime('now') WHERE id = ?")
				.bind(protectedSecret, id).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async markSharedKeyFailure(id, reason, nowIso) {
			await raw.prepare(`UPDATE shared_keys SET status = 'invalid', validated_at = NULL, failure_reason = ?, last_failure_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
				.bind(reason, nowIso, nowIso, id).run();
		},
		async deleteSharedKey(id) {
			const result = await raw.prepare('DELETE FROM shared_keys WHERE id = ?').bind(id).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async addSharedKeyUsage(id, inputTokens, outputTokens, netAmount, nowIso, expected) {
			const result = await raw.prepare(`UPDATE shared_keys
          SET served_input_tokens = served_input_tokens + ?,
              served_output_tokens = served_output_tokens + ?,
              earned_total = earned_total + ?,
              last_used_at = ?, updated_at = ?
			  WHERE id = ? AND served_input_tokens = ? AND served_output_tokens = ? AND earned_total = ?`)
				.bind(inputTokens, outputTokens, netAmount, nowIso, nowIso, id,
					expected.servedInputTokens, expected.servedOutputTokens, expected.earnedTotalExact).run();
			return Number(result.meta.changes ?? 0) === 1;
		},
	};
}

export function createD1PortalLedgerRepository(db: D1DatabaseClient): PortalLedgerRepository {
	const raw = db.raw;
	return {
		async getUserEarnings(userId) {
			const row = await raw.prepare(`SELECT user_id, balance_micros, locked_amount_micros,
		  lifetime_earned_micros, lifetime_withdrawn_micros, contribution_value_micros,
		  wallet_address, wallet_verified_at, highest_badge_tier, updated_at
		  FROM user_earnings WHERE user_id = ?`).bind(userId)
				.first<{
					user_id: string;
					balance_micros: number;
					locked_amount_micros: number;
					lifetime_earned_micros: number;
					lifetime_withdrawn_micros: number;
					contribution_value_micros: number;
					wallet_address: string | null;
					wallet_verified_at: string | null;
					highest_badge_tier: number;
					updated_at: string;
				}>();
			if (!row) return null;
			return {
				userId: row.user_id,
				balance: Number(row.balance_micros) / 1_000_000,
				lockedAmount: Number(row.locked_amount_micros) / 1_000_000,
				lifetimeEarned: Number(row.lifetime_earned_micros) / 1_000_000,
				lifetimeWithdrawn: Number(row.lifetime_withdrawn_micros) / 1_000_000,
				contributionValue: Number(row.contribution_value_micros) / 1_000_000,
				walletAddress: row.wallet_address,
				walletVerifiedAt: row.wallet_verified_at,
				highestBadgeTier: row.highest_badge_tier,
				updatedAt: row.updated_at,
			};
		},
		async getEarningByRequestLogId(requestLogId) {
			const row = await raw.prepare(`SELECT id, request_log_id, shared_key_id, seller_user_id,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
				gross_amount, platform_fee, net_amount, currency, created_at
				FROM shared_key_earnings WHERE request_log_id = ? LIMIT 1`)
				.bind(requestLogId).first<{
					id: string; request_log_id: string; shared_key_id: string; seller_user_id: string;
					input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
					gross_amount: number; platform_fee: number; net_amount: number; currency: string; created_at: string;
				}>();
			return row ? {
				id: row.id, requestLogId: row.request_log_id, sharedKeyId: row.shared_key_id,
				sellerUserId: row.seller_user_id, inputTokens: row.input_tokens,
				outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens,
				cacheWriteTokens: row.cache_write_tokens, grossAmount: Number(row.gross_amount),
				platformFee: Number(row.platform_fee), netAmount: Number(row.net_amount),
				currency: row.currency, createdAt: row.created_at,
			} : null;
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
		async updateWalletIfChallengeUnused(userId, walletAddress, verifiedAtIso, challengeCreatedAtIso) {
			const result = await raw.prepare(`UPDATE user_earnings
          SET wallet_address = ?, wallet_verified_at = ?, updated_at = ?
          WHERE user_id = ? AND (wallet_verified_at IS NULL
            OR julianday(wallet_verified_at) < julianday(?))`)
				.bind(walletAddress, verifiedAtIso, verifiedAtIso, userId, challengeCreatedAtIso).run();
			return Number(result.meta.changes ?? 0) > 0;
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
		async recordEarningAndCredit(params: InsertSharedKeyEarningParams) {
			// Migration 0029 owns the balance update and immutable ledger append in
			// an AFTER INSERT trigger. INSERT OR IGNORE makes request_log_id the
			// idempotency key, so duplicate delivery cannot credit twice.
			return this.insertEarning(params);
		},
		async rebuildSharedKeyUsageFromEarnings(requestLogId, expectedSharedKeyId, nowIso) {
			// One SQLite write statement reads a consistent earning snapshot and
			// assigns the complete derived projection. It never increments balance
			// or statistics, so repeated repair cannot double count.
			const result = await raw.prepare(`UPDATE shared_keys
				SET served_input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM shared_key_earnings WHERE shared_key_id = ?),
					served_output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM shared_key_earnings WHERE shared_key_id = ?),
					earned_total = (SELECT COALESCE(SUM(net_amount), 0) FROM shared_key_earnings WHERE shared_key_id = ?),
					last_used_at = (SELECT MAX(created_at) FROM shared_key_earnings WHERE shared_key_id = ?),
					updated_at = ?
				WHERE id = ? AND EXISTS (
					SELECT 1 FROM shared_key_earnings WHERE request_log_id = ? AND shared_key_id = ?
				)`)
				.bind(expectedSharedKeyId, expectedSharedKeyId, expectedSharedKeyId, expectedSharedKeyId,
					nowIso, expectedSharedKeyId, requestLogId, expectedSharedKeyId).run();
			if (Number(result.meta.changes ?? 0) !== 1) {
				throw new Error('shared_key_usage_rebuild_earning_or_key_missing_or_mismatched');
			}
		},
		async creditEarningBalance(sellerUserId, netAmount, nowIso) {
			const amountMicros = Math.round(netAmount * 1_000_000);
			await raw.prepare(`UPDATE user_earnings
		  SET balance_micros = balance_micros + ?,
		      lifetime_earned_micros = lifetime_earned_micros + ?,
		      contribution_value_micros = contribution_value_micros + ?,
		      balance = CAST(balance_micros + ? AS REAL) / 1000000.0,
		      lifetime_earned = CAST(lifetime_earned_micros + ? AS REAL) / 1000000.0,
		      contribution_value = CAST(contribution_value_micros + ? AS REAL) / 1000000.0,
		      updated_at = ?
		  WHERE user_id = ?`)
				.bind(
					amountMicros, amountMicros, amountMicros,
					amountMicros, amountMicros, amountMicros,
					nowIso, sellerUserId,
				).run();
		},
		async listEarningsBySeller(sellerUserId, page, pageSize) {
			const offset = (page - 1) * pageSize;
			const rows = await raw.prepare(`SELECT id, request_log_id AS requestLogId, shared_key_id AS sharedKeyId,
          seller_user_id AS sellerUserId, input_tokens AS inputTokens, output_tokens AS outputTokens,
          cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
          gross_amount AS grossAmount, platform_fee AS platformFee, net_amount AS netAmount,
          currency, created_at AS createdAt
          FROM shared_key_earnings WHERE seller_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
				.bind(sellerUserId, pageSize, offset).all<SharedKeyEarningRow & Record<string, unknown>>();
			const totalRow = await raw.prepare('SELECT COUNT(*) AS total FROM shared_key_earnings WHERE seller_user_id = ?')
				.bind(sellerUserId).first<{ total: number }>();
			return {
				rows: (rows.results ?? []).map((row) => ({
					...row,
					inputTokens: Number(row.inputTokens),
					outputTokens: Number(row.outputTokens),
					cacheReadTokens: Number(row.cacheReadTokens),
					cacheWriteTokens: Number(row.cacheWriteTokens),
					grossAmount: Number(row.grossAmount),
					platformFee: Number(row.platformFee),
					netAmount: Number(row.netAmount),
				})) as SharedKeyEarningRow[],
				total: Number(totalRow?.total ?? 0),
			};
		},
		async insertWithdrawal(params: InsertWithdrawalParams) {
			await raw.prepare(`INSERT INTO withdrawals
          (id, user_id, amount, fee, net_amount, currency, wallet_address, status, token_amount,
           amount_micros, fee_micros, net_amount_micros, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?)`)
				.bind(
					params.id,
					params.userId,
					params.amount,
					params.fee,
					params.netAmount,
					params.currency,
					params.walletAddress,
					params.tokenAmount,
					Math.round(params.amount * 1_000_000),
					Math.round(params.fee * 1_000_000),
					Math.round(params.netAmount * 1_000_000),
					params.nowIso,
					params.nowIso
				).run();
		},
		async createWithdrawalWithBalanceLock(params) {
			try {
				await this.insertWithdrawal(params);
				return 'created';
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes('active_withdrawal_exists') || message.includes('UNIQUE constraint failed')) {
					return 'active_withdrawal_exists';
				}
				if (message.includes('insufficient_balance')) return 'insufficient_balance';
				throw error;
			}
		},
		async getWithdrawal(id) {
			const row = await raw.prepare(`SELECT ${WITHDRAWAL_COLUMNS}
          FROM withdrawals WHERE id = ?`).bind(id).first<WithdrawalRow & Record<string, unknown>>();
			return row ? { ...row, amount: Number(row.amount), fee: Number(row.fee), netAmount: Number(row.netAmount), tokenAmount: row.tokenAmount == null ? null : Number(row.tokenAmount), chainId: row.chainId == null ? null : Number(row.chainId) } as WithdrawalRow : null;
		},
		async getActiveWithdrawalByUser(userId) {
			const row = await raw.prepare(`SELECT ${WITHDRAWAL_COLUMNS}
          FROM withdrawals WHERE user_id = ? AND status IN ('requested', 'processing', 'submitted') LIMIT 1`)
				.bind(userId).first<WithdrawalRow & Record<string, unknown>>();
			return row ? { ...row, amount: Number(row.amount), fee: Number(row.fee), netAmount: Number(row.netAmount), tokenAmount: row.tokenAmount == null ? null : Number(row.tokenAmount), chainId: row.chainId == null ? null : Number(row.chainId) } as WithdrawalRow : null;
		},
		async listWithdrawalsByUser(userId, page, pageSize) {
			const offset = (page - 1) * pageSize;
			const rows = await raw.prepare(`SELECT ${WITHDRAWAL_COLUMNS}
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
					chainId: row.chainId == null ? null : Number(row.chainId),
				})) as WithdrawalRow[],
				total: Number(totalRow?.total ?? 0),
			};
		},
		async listAllWithdrawals(status) {
			const stmt = status
				? raw.prepare(`SELECT ${WITHDRAWAL_COLUMNS}
            FROM withdrawals WHERE status = ? ORDER BY created_at DESC, id DESC`)
				: raw.prepare(`SELECT ${WITHDRAWAL_COLUMNS}
            FROM withdrawals ORDER BY created_at DESC, id DESC`);
			const rows = await (status ? stmt.bind(status) : stmt).all<WithdrawalRow & Record<string, unknown>>();
			return (rows.results ?? []).map((row) => ({
				...row,
				amount: Number(row.amount),
				fee: Number(row.fee),
				netAmount: Number(row.netAmount),
				tokenAmount: row.tokenAmount == null ? null : Number(row.tokenAmount),
				chainId: row.chainId == null ? null : Number(row.chainId),
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
			void userId;
			void amount;
			await raw.prepare(`UPDATE withdrawals SET status = 'confirmed', confirmed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('requested', 'processing', 'submitted')`)
				.bind(nowIso, nowIso, id).run();
		},
		async refundWithdrawal(id, userId, amount, reason, nowIso) {
			void userId;
			void amount;
			await raw.prepare(`UPDATE withdrawals SET status = 'failed', failure_reason = ?, updated_at = ?
          WHERE id = ? AND status IN ('requested', 'processing', 'submitted')`)
				.bind(reason, nowIso, id).run();
		},
		async rejectRequestedWithdrawal(id, reason, nowIso) {
			const refundDefinition = await approvedWithdrawalRefundDefinition(raw);
			// One SQLite write arbitrates against the chain worker's requested ->
			// processing CAS. The refund and journal trigger share this statement.
			// Recheck the exact approved definition inside the write, so a dropped
			// or replaced trigger after the read cannot admit an unfunded success.
			const result = await raw.prepare(`UPDATE withdrawals
				SET status = 'failed', failure_reason = ?, updated_at = ?
				WHERE id = ? AND status = 'requested' AND tx_hash IS NULL
				AND NOT EXISTS (SELECT 1 FROM chain_job_transactions
					WHERE job_kind = 'withdrawal' AND job_id = withdrawals.id)
				AND EXISTS (SELECT 1 FROM main.sqlite_master
					WHERE type = 'trigger' AND name = ? COLLATE BINARY
					AND tbl_name = 'withdrawals' AND sql = ? COLLATE BINARY)
				RETURNING id`)
				.bind(reason, nowIso, id, WITHDRAWAL_REFUND_TRIGGER, refundDefinition).all<{ id: string }>();
			// D1 meta.changes is total_changes(), including refund/journal and
			// nested trigger writes. Only RETURNING identifies the CAS winner.
			if (result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
				throw new Error('withdrawal_rejection_result_uncertain');
			}
			if (result.results.length === 1) {
				if (result.results[0]?.id !== id) throw new Error('withdrawal_rejection_result_uncertain');
				return { kind: 'rejected', withdrawalId: id };
			}
			// A schema race is unready/unknown, not an ordinary row-state conflict.
			if (await approvedWithdrawalRefundDefinition(raw) !== refundDefinition) {
				throw new Error('withdrawal_rejection_schema_unavailable');
			}
			const existing = await raw.prepare('SELECT id FROM withdrawals WHERE id = ?')
				.bind(id).first<{ id: string }>();
			return existing ? { kind: 'conflict' } : { kind: 'not-found' };
		},
		async updateWithdrawalStatus(id, patch) {
			const sets: string[] = ['updated_at = ?'];
			const values: unknown[] = [patch.nowIso];
			if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
			if (patch.txHash !== undefined) { sets.push('tx_hash = ?'); values.push(patch.txHash); }
			if (patch.chainId !== undefined) { sets.push('chain_id = ?'); values.push(patch.chainId); }
			if (patch.tokenAmount !== undefined) { sets.push('token_amount = ?'); values.push(patch.tokenAmount); }
			if (patch.failureReason !== undefined) { sets.push('failure_reason = ?'); values.push(patch.failureReason); }
			const whereStatus = patch.expectedStatus ? ' AND status = ?' : '';
			const result = await raw.prepare(`UPDATE withdrawals SET ${sets.join(', ')} WHERE id = ?${whereStatus}`)
				.bind(...values, id, ...(patch.expectedStatus !== undefined ? [patch.expectedStatus] : [])).run();
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
			const rows = await raw.prepare(`SELECT id, user_id AS userId, badge_token_id AS badgeTokenId,
          tier_name AS tierName, wallet_address AS walletAddress, status,
          tx_hash AS txHash, chain_id AS chainId, value_snapshot AS valueSnapshot,
          failure_reason AS failureReason, created_at AS createdAt, confirmed_at AS confirmedAt
          FROM nft_mints WHERE user_id = ? ORDER BY created_at DESC`)
				.bind(userId).all<NftMintRow & Record<string, unknown>>();
			return (rows.results ?? []).map((row) => ({
				...row, badgeTokenId: Number(row.badgeTokenId),
				chainId: row.chainId === null ? null : Number(row.chainId),
				valueSnapshot: Number(row.valueSnapshot),
			})) as NftMintRow[];
		},
		async listAllNftMints(status) {
			const stmt = status
				? raw.prepare(`SELECT id, user_id AS userId, badge_token_id AS badgeTokenId,
            tier_name AS tierName, wallet_address AS walletAddress, status,
            tx_hash AS txHash, chain_id AS chainId, value_snapshot AS valueSnapshot,
            failure_reason AS failureReason, created_at AS createdAt, confirmed_at AS confirmedAt
            FROM nft_mints WHERE status = ? ORDER BY created_at DESC`)
				: raw.prepare(`SELECT id, user_id AS userId, badge_token_id AS badgeTokenId,
            tier_name AS tierName, wallet_address AS walletAddress, status,
            tx_hash AS txHash, chain_id AS chainId, value_snapshot AS valueSnapshot,
            failure_reason AS failureReason, created_at AS createdAt, confirmed_at AS confirmedAt
            FROM nft_mints ORDER BY created_at DESC`);
			const rows = await (status ? stmt.bind(status) : stmt).all<NftMintRow & Record<string, unknown>>();
			return (rows.results ?? []).map((row) => ({
				...row, badgeTokenId: Number(row.badgeTokenId),
				chainId: row.chainId === null ? null : Number(row.chainId),
				valueSnapshot: Number(row.valueSnapshot),
			})) as NftMintRow[];
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
			const whereStatus = patch.expectedStatus ? ' AND status = ?' : '';
			const result = await raw.prepare(`UPDATE nft_mints SET ${sets.join(', ')} WHERE id = ?${whereStatus}`)
				.bind(...values, id, ...(patch.expectedStatus !== undefined ? [patch.expectedStatus] : [])).run();
			return Number(result.meta.changes ?? 0) > 0;
		},
		async setHighestBadgeTier(userId, tier, nowIso) {
			await raw.prepare('UPDATE user_earnings SET highest_badge_tier = ?, updated_at = ? WHERE user_id = ?')
				.bind(tier, nowIso, userId).run();
		},
	};
}
