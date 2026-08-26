import type { GatewayDatabaseClient } from '@octafuse/core';
import type { PreparedChainTransaction } from './cinachain';

export type ChainJobKind = 'withdrawal' | 'nft_mint';
export type StoredChainTransaction = PreparedChainTransaction & { chainId: number };

export interface ChainTransactionOutbox {
	get(jobKind: ChainJobKind, jobId: string): Promise<StoredChainTransaction | null>;
	persist(
		jobKind: ChainJobKind,
		jobId: string,
		prepared: PreparedChainTransaction,
		chainId: number,
		createdAt: string,
	): Promise<StoredChainTransaction>;
	markBroadcast(jobKind: ChainJobKind, jobId: string, broadcastAt: string): Promise<void>;
	/** Delete a job's row so a terminal (refunded/failed/confirmed) job can
	 *  never have its persisted raw transaction broadcast later. */
	cancel(jobKind: ChainJobKind, jobId: string): Promise<void>;
	listUnbroadcast(limit: number): Promise<Array<{
		jobKind: ChainJobKind;
		jobId: string;
		transaction: StoredChainTransaction;
	}>>;
}

type TransactionRow = {
	job_kind: ChainJobKind;
	job_id: string;
	tx_hash: string;
	raw_transaction: string;
	chain_id: number | string;
};

function mapTransaction(row: TransactionRow): StoredChainTransaction {
	return {
		hash: row.tx_hash as `0x${string}`,
		rawTransaction: row.raw_transaction as `0x${string}`,
		chainId: Number(row.chain_id),
	};
}

function createD1Outbox(client: Extract<GatewayDatabaseClient, { driver: 'd1' }>): ChainTransactionOutbox {
	const db = client.raw;
	const get = async (jobKind: ChainJobKind, jobId: string): Promise<StoredChainTransaction | null> => {
		const row = await db.prepare(`SELECT job_kind, job_id, tx_hash, raw_transaction, chain_id
		  FROM chain_job_transactions WHERE job_kind = ? AND job_id = ?`)
			.bind(jobKind, jobId)
			.first<TransactionRow>();
		return row ? mapTransaction(row) : null;
	};
	return {
		get,
		async persist(jobKind, jobId, prepared, chainId, createdAt) {
			await db.prepare(`INSERT OR IGNORE INTO chain_job_transactions
			  (job_kind, job_id, tx_hash, raw_transaction, chain_id, created_at)
			  VALUES (?, ?, ?, ?, ?, ?)`)
				.bind(jobKind, jobId, prepared.hash, prepared.rawTransaction, chainId, createdAt)
				.run();
			const stored = await get(jobKind, jobId);
			if (!stored) throw new Error(`Failed to persist ${jobKind} transaction ${jobId}`);
			return stored;
		},
		async markBroadcast(jobKind, jobId, broadcastAt) {
			await db.prepare(`UPDATE chain_job_transactions
			  SET broadcast_at = COALESCE(broadcast_at, ?) WHERE job_kind = ? AND job_id = ?`)
				.bind(broadcastAt, jobKind, jobId)
				.run();
		},
		async cancel(jobKind, jobId) {
			await db.prepare(`DELETE FROM chain_job_transactions
			  WHERE job_kind = ? AND job_id = ? AND broadcast_at IS NULL`)
				.bind(jobKind, jobId)
				.run();
		},
		async listUnbroadcast(limit) {
			const rows = await db.prepare(`SELECT job_kind, job_id, tx_hash, raw_transaction, chain_id
			  FROM chain_job_transactions WHERE broadcast_at IS NULL
			  ORDER BY created_at, job_kind, job_id LIMIT ?`)
				.bind(limit)
				.all<TransactionRow>();
			return (rows.results ?? []).map((row) => ({
				jobKind: row.job_kind,
				jobId: row.job_id,
				transaction: mapTransaction(row),
			}));
		},
	};
}

function createPostgresOutbox(
	client: Extract<GatewayDatabaseClient, { driver: 'postgres' }>,
): ChainTransactionOutbox {
	const sql = client.raw;
	const get = async (jobKind: ChainJobKind, jobId: string): Promise<StoredChainTransaction | null> => {
		const rows = await sql<TransactionRow[]>`
			SELECT job_kind, job_id, tx_hash, raw_transaction, chain_id
			FROM chain_job_transactions
			WHERE job_kind = ${jobKind} AND job_id = ${jobId}
			LIMIT 1
		`;
		return rows[0] ? mapTransaction(rows[0]) : null;
	};
	return {
		get,
		async persist(jobKind, jobId, prepared, chainId, createdAt) {
			await sql`
				INSERT INTO chain_job_transactions (
					job_kind, job_id, tx_hash, raw_transaction, chain_id, created_at
				) VALUES (
					${jobKind}, ${jobId}, ${prepared.hash}, ${prepared.rawTransaction},
					${chainId}, ${createdAt}::timestamptz
				)
				ON CONFLICT (job_kind, job_id) DO NOTHING
			`;
			const stored = await get(jobKind, jobId);
			if (!stored) throw new Error(`Failed to persist ${jobKind} transaction ${jobId}`);
			return stored;
		},
		async markBroadcast(jobKind, jobId, broadcastAt) {
			await sql`
				UPDATE chain_job_transactions
				SET broadcast_at = COALESCE(broadcast_at, ${broadcastAt}::timestamptz)
				WHERE job_kind = ${jobKind} AND job_id = ${jobId}
			`;
		},
		async cancel(jobKind, jobId) {
			await sql`
				DELETE FROM chain_job_transactions
				WHERE job_kind = ${jobKind} AND job_id = ${jobId}
				  AND broadcast_at IS NULL
			`;
		},
		async listUnbroadcast(limit) {
			const rows = await sql<TransactionRow[]>`
				SELECT job_kind, job_id, tx_hash, raw_transaction, chain_id
				FROM chain_job_transactions
				WHERE broadcast_at IS NULL
				ORDER BY created_at, job_kind, job_id
				LIMIT ${limit}
			`;
			return rows.map((row) => ({
				jobKind: row.job_kind,
				jobId: row.job_id,
				transaction: mapTransaction(row),
			}));
		},
	};
}

export function createChainTransactionOutbox(client: GatewayDatabaseClient): ChainTransactionOutbox {
	if (client.driver === 'd1') return createD1Outbox(client);
	if (client.driver === 'postgres') return createPostgresOutbox(client);
	throw new Error('Chain Worker supports only D1 or Hyperdrive Postgres storage.');
}
