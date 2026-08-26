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
	/** Producer binding for the chain-jobs queue (re-drive from the sweeper). */
	CHAIN_JOBS?: Queue<ChainJobMessage>;
	CHAIN_JOB_QUEUE_DLQ?: string;
}

type JobKind = ChainJobMessage['kind'];

const nowIso = () => new Date().toISOString();

const SWEEP_REQUESTED_STALE_MS = 5 * 60 * 1000;
const SWEEP_INFLIGHT_STALE_MS = 10 * 60 * 1000;
const SWEEP_MAX_REQUEUES = 20;
const CHAIN_JOB_DLQ_DEFAULT = 'cinatoken-chain-jobs-dlq';

function staleSince(iso: string | null | undefined, staleMs: number): boolean {
	if (!iso) return false;
	const ts = Date.parse(iso);
	return Number.isFinite(ts) && Date.now() - ts > staleMs;
}

/**
 * Cron sweeper: without traffic, a crash between withdrawal insert (locked
 * funds) and queue send, or a dropped/underpriced transaction, would strand
 * jobs forever — queue messages only fire on new activity. Re-drive stale
 * jobs (processing is CAS/idempotent) and drain the outbox. Bounded per run.
 */
async function sweepStaleJobs(env: ChainWorkerEnv): Promise<void> {
	if (!env.CHAIN_JOBS) {
		console.warn(JSON.stringify({
			level: 'warn',
			message: 'cinatoken.chain_sweep_skipped',
			reason: 'CHAIN_JOBS producer binding missing',
		}));
		return;
	}
	const storage = await createWorkerStorageContext(resolveWorkerDatabaseConfig(env));
	const outbox = createChainTransactionOutbox(storage.client);
	await flushUnbroadcastTransactions(storage.repositories, outbox, env);

	const stale: ChainJobMessage[] = [];
	const withdrawals = await storage.repositories.portalLedger.listAllWithdrawals();
	for (const row of withdrawals) {
		if (stale.length >= SWEEP_MAX_REQUEUES) break;
		if (row.status === 'requested' && staleSince(row.updatedAt ?? row.createdAt, SWEEP_REQUESTED_STALE_MS)) {
			stale.push({ kind: 'withdrawal', id: row.id });
		} else if (
			(row.status === 'processing' || row.status === 'submitted') &&
			staleSince(row.updatedAt ?? row.createdAt, SWEEP_INFLIGHT_STALE_MS)
		) {
			stale.push({ kind: 'withdrawal', id: row.id });
		}
	}
	const mints = await storage.repositories.portalLedger.listAllNftMints();
	for (const row of mints) {
		if (stale.length >= SWEEP_MAX_REQUEUES) break;
		if (
			(row.status === 'pending' || row.status === 'processing' || row.status === 'submitted') &&
			staleSince(row.createdAt, SWEEP_INFLIGHT_STALE_MS)
		) {
			stale.push({ kind: 'nft_mint', id: row.id });
		}
	}
	if (stale.length > 0) {
		await env.CHAIN_JOBS.sendBatch(stale.map((body) => ({ body })));
	}
	console.log(JSON.stringify({
		level: 'info',
		message: 'cinatoken.chain_sweep_completed',
		requeued: stale.length,
	}));
}

type ReconciliationDrift = {
	check: 'earnings_vs_journal' | 'locked_vs_active_withdrawals' | 'terminal_with_outbox';
	ids: string[];
};

async function fetchIds(client: unknown, sqlText: string): Promise<string[]> {
	// driver-specific row extraction (D1 {results} vs postgres-js array)
	const driver = (client as { driver?: string }).driver;
	if (driver === 'postgres') {
		const rows = await (client as { raw: { unsafe: (q: string) => Promise<Array<Record<string, unknown>>> } }).raw.unsafe(sqlText);
		return rows.map((row) => String(row.user_id ?? row.job_id ?? ''));
	}
	const db = (client as { raw: { prepare: (q: string) => { all: () => Promise<{ results?: Array<Record<string, unknown>> }> } } }).raw;
	const rows = (await db.prepare(sqlText).all()).results ?? [];
	return rows.map((row) => String(row.user_id ?? row.job_id ?? ''));
}

/**
 * 小时对账（审计 M7）：验证收益入账、锁定资金与 outbox 三方一致 ——
 * sum(shared_key_earnings) ↔ user_earnings、sum(活跃提现) ↔ locked、
 * 终态任务 ↔ 无未取消 outbox 行。漂移发 error 级结构化事件供告警。
 * 只读，不改任何数据；H1 的 flush 修复与 M6 的触发器守卫是其前置。
 */
async function runLedgerReconciliation(env: ChainWorkerEnv): Promise<void> {
	const storage = await createWorkerStorageContext(resolveWorkerDatabaseConfig(env));
	const client = storage.client;
	const isPostgres = client.driver === 'postgres';
	// SQLite ROUND 对 REAL 可用；PG 需先转 numeric 才能 ROUND。
	const roundNet = isPostgres
		? 'SUM(CAST(ROUND(CAST(net_amount AS numeric) * 1000000) AS bigint))'
		: 'SUM(CAST(ROUND(net_amount * 1000000) AS INTEGER))';

	const drifts: ReconciliationDrift[] = [];
	const checks: Array<{ check: ReconciliationDrift['check']; sqlText: string }> = [
		{
			check: 'earnings_vs_journal',
			sqlText: `SELECT ue.user_id FROM user_earnings ue
				LEFT JOIN (SELECT seller_user_id AS uid, ${roundNet} AS net
					FROM shared_key_earnings GROUP BY seller_user_id) j ON j.uid = ue.user_id
				WHERE ue.lifetime_earned_micros <> COALESCE(j.net, 0) LIMIT 20`,
		},
		{
			check: 'locked_vs_active_withdrawals',
			sqlText: `SELECT ue.user_id FROM user_earnings ue
				LEFT JOIN (SELECT user_id AS uid, SUM(amount_micros) AS locked FROM withdrawals
					WHERE status IN ('requested','processing','submitted') GROUP BY user_id) a ON a.uid = ue.user_id
				WHERE ue.locked_amount_micros <> COALESCE(a.locked, 0) LIMIT 20`,
		},
		{
			check: 'terminal_with_outbox',
			sqlText: `SELECT cjt.job_id FROM chain_job_transactions cjt
				JOIN withdrawals w ON w.id = cjt.job_id AND cjt.job_kind = 'withdrawal'
				WHERE w.status IN ('confirmed','failed') LIMIT 20`,
		},
	];
	for (const { check, sqlText } of checks) {
		try {
			const ids = await fetchIds(client, sqlText);
			if (ids.length > 0) drifts.push({ check, ids });
		} catch (error) {
			console.error(JSON.stringify({
				level: 'error',
				message: 'cinatoken.ledger_reconciliation_check_failed',
				check,
				error: error instanceof Error ? error.message : String(error),
			}));
		}
	}
	const event = {
		level: drifts.length > 0 ? ('error' as const) : ('info' as const),
		message: 'cinatoken.ledger_integrity',
		ok: drifts.length === 0,
		drifts,
	};
	if (drifts.length > 0) console.error(JSON.stringify(event));
	else console.log(JSON.stringify(event));
}

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
		// Unit guard: tokenAmount is the mint quantity (amount × rate), stored
		// at withdrawal creation. Never fall back to the USD netAmount — a NULL
		// or non-positive tokenAmount is a data/config defect (e.g. rate=0)
		// that would mint the wrong unit or nothing while fully debiting the
		// balance. Nothing is signed yet, so refund immediately.
		const tokenAmount = withdrawal.tokenAmount;
		if (tokenAmount === null || tokenAmount <= 0 || !Number.isFinite(tokenAmount)) {
			await repositories.portalLedger.refundWithdrawal(
				id, withdrawal.userId, withdrawal.amount,
				`invalid tokenAmount (${tokenAmount}) — refusing to mint, refunded`, nowIso(),
			);
			console.error(JSON.stringify({
				level: 'error',
				message: 'cinatoken.withdrawal_invalid_token_amount',
				withdrawalId: id,
				tokenAmount,
			}));
			return;
		}
		const tokenMicros = BigInt(Math.round(tokenAmount * 1_000_000));
		if (tokenMicros <= 0n) {
			await repositories.portalLedger.refundWithdrawal(
				id, withdrawal.userId, withdrawal.amount,
				`tokenAmount rounds to zero micro-units (${tokenAmount}) — refunded`, nowIso(),
			);
			return;
		}
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
	async scheduled(controller: ScheduledController, env: ChainWorkerEnv): Promise<void> {
		void controller;
		// 每小时整点跑账本对账（审计 M7），其余 cron（*/5）跑停滞任务清扫。
		if (controller.cron === '0 * * * *') {
			await runLedgerReconciliation(env);
			return;
		}
		await sweepStaleJobs(env);
	},
	async queue(batch: MessageBatch<unknown>, env: ChainWorkerEnv): Promise<void> {
		// DLQ consumer: the job exhausted its retries. Never re-drive or
		// auto-refund here — the persisted transaction's fate is unknown
		// (broadcast-but-unmined vs never-sent); emit a critical alert event
		// for manual triage (admin /admin/withdrawals, /admin/nft-mints).
		const dlqName = env.CHAIN_JOB_QUEUE_DLQ || CHAIN_JOB_DLQ_DEFAULT;
		if (batch.queue === dlqName) {
			console.error(JSON.stringify({
				level: 'error',
				message: 'cinatoken.chain_job_dead_letter',
				queue: batch.queue,
				jobs: batch.messages.map((message) => message.body),
			}));
			for (const message of batch.messages) message.ack();
			return;
		}
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
