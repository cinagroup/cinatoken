import {
	createD1StorageContext,
	isChainJobMessage,
	resolveWorkerDatabaseConfig,
	type ChainJobMessage,
	type GatewayRepositories,
} from '@octafuse/core';
import {
	broadcastPreparedTransaction,
	prepareBadge,
	prepareCredit,
	waitForReceipt,
	type PreparedChainTransaction,
	type SignerEnv,
} from './cinachain';

export interface ChainWorkerEnv extends SignerEnv {
	DB: D1Database;
}

type JobKind = ChainJobMessage['kind'];
type StoredTransaction = PreparedChainTransaction & { chainId: number };

const nowIso = () => new Date().toISOString();

async function getStoredTransaction(
	env: ChainWorkerEnv,
	jobKind: JobKind,
	jobId: string,
): Promise<StoredTransaction | null> {
	const row = await env.DB.prepare(`SELECT tx_hash, raw_transaction, chain_id
	  FROM chain_job_transactions WHERE job_kind = ? AND job_id = ?`)
		.bind(jobKind, jobId)
		.first<{ tx_hash: string; raw_transaction: string; chain_id: number }>();
	return row
		? {
			hash: row.tx_hash as `0x${string}`,
			rawTransaction: row.raw_transaction as `0x${string}`,
			chainId: Number(row.chain_id),
		}
		: null;
}

async function persistPreparedTransaction(
	env: ChainWorkerEnv,
	jobKind: JobKind,
	jobId: string,
	prepared: PreparedChainTransaction,
): Promise<StoredTransaction> {
	const chainId = Number(env.CINACHAIN_CHAIN_ID);
	await env.DB.prepare(`INSERT OR IGNORE INTO chain_job_transactions
	  (job_kind, job_id, tx_hash, raw_transaction, chain_id, created_at)
	  VALUES (?, ?, ?, ?, ?, ?)`)
		.bind(jobKind, jobId, prepared.hash, prepared.rawTransaction, chainId, nowIso())
		.run();
	const stored = await getStoredTransaction(env, jobKind, jobId);
	if (!stored) throw new Error(`Failed to persist ${jobKind} transaction ${jobId}`);
	return stored;
}

async function broadcastStoredTransaction(
	env: ChainWorkerEnv,
	jobKind: JobKind,
	jobId: string,
	transaction: StoredTransaction,
): Promise<void> {
	try {
		await broadcastPreparedTransaction(env, transaction.rawTransaction);
		await env.DB.prepare(`UPDATE chain_job_transactions
		  SET broadcast_at = COALESCE(broadcast_at, ?) WHERE job_kind = ? AND job_id = ?`)
			.bind(nowIso(), jobKind, jobId)
			.run();
	} catch (error) {
		// A retry may rebroadcast a transaction the RPC node already knows. Only
		// treat that as success when the deterministic hash has a receipt.
		try {
			await waitForReceipt(env, transaction.hash);
			await env.DB.prepare(`UPDATE chain_job_transactions
			  SET broadcast_at = COALESCE(broadcast_at, ?) WHERE job_kind = ? AND job_id = ?`)
				.bind(nowIso(), jobKind, jobId)
				.run();
		} catch {
			throw error;
		}
	}
}

async function flushUnbroadcastTransactions(env: ChainWorkerEnv): Promise<void> {
	const rows = await env.DB.prepare(`SELECT job_kind, job_id, tx_hash, raw_transaction, chain_id
	  FROM chain_job_transactions WHERE broadcast_at IS NULL ORDER BY created_at, job_kind, job_id LIMIT 10`)
		.all<{
			job_kind: JobKind;
			job_id: string;
			tx_hash: string;
			raw_transaction: string;
			chain_id: number;
		}>();
	for (const row of rows.results ?? []) {
		await broadcastStoredTransaction(env, row.job_kind, row.job_id, {
			hash: row.tx_hash as `0x${string}`,
			rawTransaction: row.raw_transaction as `0x${string}`,
			chainId: Number(row.chain_id),
		});
	}
}

async function processWithdrawal(
	repositories: GatewayRepositories,
	env: ChainWorkerEnv,
	id: string,
): Promise<void> {
	const withdrawal = await repositories.portalLedger.getWithdrawal(id);
	if (!withdrawal || withdrawal.status === 'confirmed' || withdrawal.status === 'failed') return;

	let stored = await getStoredTransaction(env, 'withdrawal', id);
	if (!stored && withdrawal.txHash) {
		// Compatibility with transactions submitted before the durable outbox.
		const status = await waitForReceipt(env, withdrawal.txHash as `0x${string}`);
		if (status === 'success') {
			await repositories.portalLedger.settleWithdrawalConfirmed(
				id, withdrawal.userId, withdrawal.amount, nowIso(),
			);
		} else {
			await repositories.portalLedger.refundWithdrawal(
				id, withdrawal.userId, withdrawal.amount,
				`chain transaction reverted: ${withdrawal.txHash}`, nowIso(),
			);
		}
		return;
	}

	if (!stored) {
		if (withdrawal.status === 'requested') {
			const claimed = await repositories.portalLedger.updateWithdrawalStatus(id, {
				status: 'processing',
				expectedStatus: 'requested',
				nowIso: nowIso(),
			});
			if (!claimed) return;
		} else if (withdrawal.status !== 'processing') {
			throw new Error(`Withdrawal ${id} has no durable transaction in status ${withdrawal.status}`);
		}
		const tokenMicros = BigInt(Math.round((withdrawal.tokenAmount ?? withdrawal.netAmount) * 1_000_000));
		stored = await persistPreparedTransaction(
			env,
			'withdrawal',
			id,
			await prepareCredit(
				env,
				withdrawal.walletAddress as `0x${string}`,
				tokenMicros * 10n ** 12n,
			),
		);
	}

	await repositories.portalLedger.updateWithdrawalStatus(id, {
		status: 'submitted',
		txHash: stored.hash,
		chainId: stored.chainId,
		expectedStatus: 'processing',
		nowIso: nowIso(),
	});
	await broadcastStoredTransaction(env, 'withdrawal', id, stored);
	const status = await waitForReceipt(env, stored.hash);
	if (status === 'success') {
		await repositories.portalLedger.settleWithdrawalConfirmed(
			id, withdrawal.userId, withdrawal.amount, nowIso(),
		);
	} else {
		await repositories.portalLedger.refundWithdrawal(
			id, withdrawal.userId, withdrawal.amount,
			`chain transaction reverted: ${stored.hash}`, nowIso(),
		);
	}
}

async function processNftMint(
	repositories: GatewayRepositories,
	env: ChainWorkerEnv,
	id: string,
): Promise<void> {
	const mint = (await repositories.portalLedger.listAllNftMints()).find((row) => row.id === id);
	if (!mint || mint.status === 'confirmed' || mint.status === 'failed') return;

	let stored = await getStoredTransaction(env, 'nft_mint', id);
	if (!stored && mint.txHash) {
		const status = await waitForReceipt(env, mint.txHash as `0x${string}`);
		await repositories.portalLedger.updateNftMintStatus(
			id,
			status === 'success'
				? { status: 'confirmed', confirmedAt: nowIso(), expectedStatus: 'submitted' }
				: {
					status: 'failed',
					failureReason: `chain transaction reverted: ${mint.txHash}`,
					expectedStatus: 'submitted',
				},
		);
		return;
	}

	if (!stored) {
		if (mint.status === 'pending') {
			const claimed = await repositories.portalLedger.updateNftMintStatus(id, {
				status: 'processing',
				expectedStatus: 'pending',
			});
			if (!claimed) return;
		} else if (mint.status !== 'processing') {
			throw new Error(`NFT mint ${id} has no durable transaction in status ${mint.status}`);
		}
		stored = await persistPreparedTransaction(
			env,
			'nft_mint',
			id,
			await prepareBadge(env, mint.walletAddress as `0x${string}`, mint.badgeTokenId),
		);
	}

	await repositories.portalLedger.updateNftMintStatus(id, {
		status: 'submitted',
		txHash: stored.hash,
		chainId: stored.chainId,
		expectedStatus: 'processing',
	});
	await broadcastStoredTransaction(env, 'nft_mint', id, stored);
	const status = await waitForReceipt(env, stored.hash);
	await repositories.portalLedger.updateNftMintStatus(
		id,
		status === 'success'
			? { status: 'confirmed', confirmedAt: nowIso(), expectedStatus: 'submitted' }
			: {
				status: 'failed',
				failureReason: `chain transaction reverted: ${stored.hash}`,
				expectedStatus: 'submitted',
			},
	);
}

async function processJob(message: ChainJobMessage, env: ChainWorkerEnv): Promise<void> {
	// Preserve EOA nonce ordering after a crash between outbox persistence and
	// broadcast. No new transaction is signed while an older row is unbroadcast.
	await flushUnbroadcastTransactions(env);
	const storage = createD1StorageContext(resolveWorkerDatabaseConfig(env).db);
	if (message.kind === 'withdrawal') {
		await processWithdrawal(storage.repositories, env, message.id);
	} else {
		await processNftMint(storage.repositories, env, message.id);
	}
}

export default {
	async fetch(): Promise<Response> {
		return Response.json({ name: 'cinatoken-chain-worker', status: 'ok' });
	},
	async queue(batch: MessageBatch<unknown>, env: ChainWorkerEnv): Promise<void> {
		for (const message of batch.messages) {
			if (!isChainJobMessage(message.body)) {
				message.ack();
				continue;
			}
			try {
				await processJob(message.body, env);
				message.ack();
			} catch (error) {
				console.error(JSON.stringify({
					level: 'error',
					message: 'cinatoken.chain_job_failed',
					kind: message.body.kind,
					jobId: message.body.id,
					error: error instanceof Error ? error.message : 'unknown',
				}));
				message.retry({ delaySeconds: 30 });
			}
		}
	},
} satisfies ExportedHandler<ChainWorkerEnv>;
