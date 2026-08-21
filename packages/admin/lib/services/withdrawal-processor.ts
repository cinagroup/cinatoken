/**
 * 提现处理器：requested → processing → submitted(tx) → confirmed / failed。
 * CINA-C（CinaCredit.mintTo）作为链上到账载体；失败一律回滚锁定金额。
 *
 * 触发方式：
 * - 门户 POST /user/withdrawals 后 fire-and-forget；
 * - 管理台 POST /admin/withdrawals/process（cron / 人工兜底）。
 */
import type { GatewayRepositories } from '@octafuse/core';
import { mintCinaCredit, toTokenUnits, waitForCinachainReceipt, isCinachainConfigured } from '@/lib/cinachain';

const TERMINAL_STATUSES = new Set(['confirmed', 'failed']);

export async function processPendingWithdrawals(
	repositories: GatewayRepositories,
	limit = 5
): Promise<{ processed: number; confirmed: number; failed: number }> {
	let processed = 0;
	let confirmed = 0;
	let failed = 0;
	if (!isCinachainConfigured()) return { processed, confirmed, failed };

	const pending = (await repositories.portalLedger.listAllWithdrawals())
		.filter((row) => row.status === 'requested' || row.status === 'submitted')
		.slice(0, limit);

	for (const withdrawal of pending) {
		if (withdrawal.status === 'submitted' && withdrawal.txHash) {
			// 已广播：CAS 认领（并发触发防重复结算回执），等待回执
			const claimed = await repositories.portalLedger.updateWithdrawalStatus(withdrawal.id, {
				status: 'processing',
				expectedStatus: 'submitted',
				nowIso: new Date().toISOString(),
			});
			if (!claimed) continue;
			try {
				const receipt = await waitForCinachainReceipt(withdrawal.txHash as `0x${string}`);
				if (receipt.status === 'success') {
					await repositories.portalLedger.settleWithdrawalConfirmed(
						withdrawal.id,
						withdrawal.userId,
						withdrawal.amount,
						new Date().toISOString()
					);
					confirmed += 1;
				} else {
					await repositories.portalLedger.refundWithdrawal(
						withdrawal.id,
						withdrawal.userId,
						withdrawal.amount,
						`chain tx reverted: ${withdrawal.txHash}`,
						new Date().toISOString()
					);
					failed += 1;
				}
			} catch (error) {
				// 回执超时：回退 submitted，等下轮处理
				await repositories.portalLedger
					.updateWithdrawalStatus(withdrawal.id, { status: 'submitted', expectedStatus: 'processing', nowIso: new Date().toISOString() })
					.catch(() => undefined);
				console.error(
					JSON.stringify({
						level: 'error',
						message: 'portal.withdrawal_receipt_pending',
						withdrawalId: withdrawal.id,
						error: error instanceof Error ? error.message : 'unknown',
					})
				);
			}
			processed += 1;
			continue;
		}

		const claimed = await repositories.portalLedger.updateWithdrawalStatus(withdrawal.id, {
			status: 'processing',
			expectedStatus: 'requested',
			nowIso: new Date().toISOString(),
		});
		if (!claimed) continue;

		try {
			const tokenUnits = toTokenUnits(withdrawal.tokenAmount ?? withdrawal.netAmount);
			const txHash = await mintCinaCredit(withdrawal.walletAddress as `0x${string}`, tokenUnits);
			await repositories.portalLedger.updateWithdrawalStatus(withdrawal.id, {
				status: 'submitted',
				txHash,
				chainId: Number(process.env.CINACHAIN_CHAIN_ID ?? 84532),
				tokenAmount: withdrawal.tokenAmount ?? withdrawal.netAmount,
				nowIso: new Date().toISOString(),
			});
			const receipt = await waitForCinachainReceipt(txHash);
			if (receipt.status === 'success') {
				await repositories.portalLedger.settleWithdrawalConfirmed(
					withdrawal.id,
					withdrawal.userId,
					withdrawal.amount,
					new Date().toISOString()
				);
				confirmed += 1;
			} else {
				await repositories.portalLedger.refundWithdrawal(
					withdrawal.id,
					withdrawal.userId,
					withdrawal.amount,
					`chain tx reverted: ${txHash}`,
					new Date().toISOString()
				);
				failed += 1;
			}
			processed += 1;
		} catch (error) {
			await repositories.portalLedger.refundWithdrawal(
				withdrawal.id,
				withdrawal.userId,
				withdrawal.amount,
				error instanceof Error ? error.message : 'on-chain withdrawal failed',
				new Date().toISOString()
			);
			failed += 1;
			processed += 1;
		}
	}

	return { processed, confirmed, failed };
}

/** 提现单是否已终态。 */
export function isTerminalWithdrawalStatus(status: string): boolean {
	return TERMINAL_STATUSES.has(status);
}
