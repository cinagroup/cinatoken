import {
	createWorkerStorageContext,
	isChainJobMessage,
	resolveWorkerDatabaseConfig,
	type ChainJobMessage,
	type GatewayRepositories,
	type HyperdriveBinding,
} from '@octafuse/core';
import {
	broadcastPreparedTransaction,
	prepareBadge,
	prepareCredit,
	waitForReceipt,
	type PreparedChainTransaction,
	type SignerEnv,
} from './cinachain';
import {
	createChainTransactionOutbox,
	type ChainTransactionOutbox,
	type StoredChainTransaction,
} from './transaction-outbox';

export interface ChainWorkerEnv extends SignerEnv {
	DB?: D1Database;
	HYPERDRIVE?: HyperdriveBinding;
	DATABASE_DRIVER?: string;
}

type JobKind = ChainJobMessage['kind'];

const nowIso = () => new Date().toISOString();

async function getStoredTransaction(
	outbox: ChainTransactionOutbox,
	jobKind: JobKind,
	jobId: string,
): Promise<StoredChainTransaction | null> {
	return outbox.get(jobKind, jobId);
}

async function persistPreparedTransaction(
	outbox: ChainTransactionOutbox,
	env: ChainWorkerEnv,
	jobKind: JobKind,
	jobId: string,
	prepared: PreparedChainTransaction,
): Promise<StoredChainTransaction> {
	const chainId = Number(env.CINACHAIN_CHAIN_ID);
	return outbox.persist(jobKind, jobId, prepared, chainId, nowIso());
}

async function broadcastStoredTransaction(
	outbox: ChainTransactionOutbox,
	env: ChainWorkerEnv,
	jobKind: JobKind,
	jobId: string,
	transaction: StoredChainTransaction,
): Promise<void> {
	try {
		await broadcastPreparedTransaction(env, transaction.rawTransaction);
		await outbox.markBroadcast(jobKind, jobId, nowIso());
	} catch (error) {
		// A retry may rebroadcast a transaction the RPC node already knows. Only
		// treat that as success when the deterministic hash has a receipt.
		try {
			await waitForReceipt(env, transaction.hash);
			await outbox.markBroadcast(jobKind, jobId, nowIso());
		} catch {
			throw error;
		}
	}
}

/** Terminal-job rows must never be (re)broadcast: the withdrawal/mint they
 *  were signed for was refunded or already settled, so broadcasting would
 *  double-pay (refund + on-chain mint). Cancel them instead. */
async function cancelIfTerminal(
	repositories: GatewayRepositories,
	outbox: ChainTransactionOutbox,
	row: { jobKind: JobKind; jobId: string },
): Promise<boolean> {
	if (row.jobKind === 'withdrawal') {
		const withdrawal = await repositories.portalLedger.getWithdrawal(row.jobId);
		const terminal = !withdrawal || withdrawal.status === 'confirmed' || withdrawal.status === 'failed';
		if (!terminal) return false;
	} else {
		// listAllNftMints is the established lookup; fetched lazily per flush pass
		const mints = await repositories.portalLedger.listAllNftMints();
		const mint = mints.find((candidate) => candidate.id === row.jobId);
		const terminal = !mint || mint.status === 'confirmed' || mint.status === 'failed';
		if (!terminal) return false;
	}
	await outbox.cancel(row.jobKind, row.jobId);
	console.warn(JSON.stringify({
		level: 'warn',
		message: 'cinatoken.chain_outbox_row_cancelled',
		kind: row.jobKind,
		jobId: row.jobId,
		reason: 'job reached terminal status before broadcast',
	}));
	return true;
}

async function flushUnbroadcastTransactions(
	repositories: GatewayRepositories,
	outbox: ChainTransactionOutbox,
	env: ChainWorkerEnv,
): Promise<void> {
	// Drain fully (bounded): signing a new transaction while older rows remain
	// unbroadcast would supersede their nonces and strand them forever.
	for (let pass = 0; pass < 100; pass++) {
		const rows = await outbox.listUnbroadcast(10);
		if (rows.length === 0) return;
		for (const row of rows) {
			if (await cancelIfTerminal(repositories, outbox, row)) continue;
			await broadcastStoredTransaction(outbox, env, row.jobKind, row.jobId, row.transaction);
		}
	}
	throw new Error('flushUnbroadcastTransactions exceeded 100 passes — unbroadcast rows not draining');
}

async function processWithdrawal(
	repositories: GatewayRepositories,
	outbox: ChainTransactionOutbox,
	env: ChainWorkerEnv,
	id: string,
): Promise<void> {
	const withdrawal = await repositories.portalLedger.getWithdrawal(id);
	if (!withdrawal || withdrawal.status === 'confirmed' || withdrawal.status === 'failed') return;

	let stored = await getStoredTransaction(outbox, 'withdrawal', id);
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
			outbox,
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
	await broadcastStoredTransaction(outbox, env, 'withdrawal', id, stored);
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
	outbox: ChainTransactionOutbox,
	env: ChainWorkerEnv,
	id: string,
): Promise<void> {
	const mint = (await repositories.portalLedger.listAllNftMints()).find((row) => row.id === id);
	if (!mint || mint.status === 'confirmed' || mint.status === 'failed') return;

	let stored = await getStoredTransaction(outbox, 'nft_mint', id);
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
			outbox,
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
	await broadcastStoredTransaction(outbox, env, 'nft_mint', id, stored);
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
	const storage = await createWorkerStorageContext(resolveWorkerDatabaseConfig(env));
	const outbox = createChainTransactionOutbox(storage.client);
	// Preserve EOA nonce ordering after a crash between outbox persistence and
	// broadcast. No new transaction is signed while an older row is unbroadcast;
	// rows whose job reached a terminal state (refunded/failed/confirmed) are
	// cancelled instead of broadcast to prevent double-pay.
	await flushUnbroadcastTransactions(storage.repositories, outbox, env);
	if (message.kind === 'withdrawal') {
		await processWithdrawal(storage.repositories, outbox, env, message.id);
	} else {
		await processNftMint(storage.repositories, outbox, env, message.id);
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
