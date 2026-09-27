import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GatewayRepositories, SharedKeyRow } from '@octafuse/core';
import { settleSharedKeyEarning } from './shared-key-earnings';

type EarnCall = Parameters<GatewayRepositories['portalLedger']['insertEarning']>[0];

function makeKey(overrides: Partial<SharedKeyRow> & { id: string }): SharedKeyRow {
	return {
		sellerUserId: 'seller-1',
		channelType: 'openai',
		apiKey: 'sk-x',
		keyFingerprint: '…x111',
		label: null,
		status: 'active',
		sellerPriority: 0,
		weight: 1,
		inputPrice: 2,
		outputPrice: 6,
		cacheReadPrice: null,
		cacheWritePrice: null,
		validatedAt: null,
		lastUsedAt: null,
		lastFailureAt: null,
		failureReason: null,
		servedInputTokens: 0,
		servedOutputTokens: 0,
		earnedTotal: 0,
		earnedTotalExact: '0',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeRepos(options: {
	key: SharedKeyRow | null;
	commission?: string | null;
	rebuildFailures?: number;
	incrementFailures?: number;
	incrementAckLosses?: number;
	holdFirstTwoRecordInserts?: boolean;
	afterInsert?: (earning: EarnCall) => Promise<void>;
}) {
	const state = {
		earnings: [] as EarnCall[],
		credits: [] as Array<{ sellerUserId: string; netAmount: number }>,
		usage: null as { id: string; input: number; output: number; net: number } | null,
		rebuildCalls: 0,
		incrementCalls: 0,
		recordCalls: 0,
		keyReads: 0,
		commissionReads: 0,
		earningReads: 0,
	};
	let rebuildFailures = options.rebuildFailures ?? 0;
	let incrementFailures = options.incrementFailures ?? 0;
	let incrementAckLosses = options.incrementAckLosses ?? 0;
	const releaseInserts: Array<() => void> = [];
	const repos = {
		sharedKeys: {
			async getSharedKeyById(id: string) {
				state.keyReads++;
				if (!options.key || options.key.id !== id) return null;
				return {
					...options.key,
					servedInputTokens: state.usage?.input ?? options.key.servedInputTokens,
					servedOutputTokens: state.usage?.output ?? options.key.servedOutputTokens,
					earnedTotal: state.usage?.net ?? options.key.earnedTotal,
					earnedTotalExact: String(state.usage?.net ?? options.key.earnedTotal),
				};
			},
			async addSharedKeyUsage(
				id: string, input: number, output: number, net: number, _nowIso: string,
				expected: { servedInputTokens: number; servedOutputTokens: number; earnedTotalExact: string },
			) {
				state.incrementCalls++;
				if (incrementFailures > 0) {
					incrementFailures--;
					throw new Error('summary store unavailable');
				}
				if (options.key?.id !== id) return false;
				if ((state.usage?.input ?? options.key.servedInputTokens) !== expected.servedInputTokens ||
					(state.usage?.output ?? options.key.servedOutputTokens) !== expected.servedOutputTokens ||
					String(state.usage?.net ?? options.key.earnedTotal) !== expected.earnedTotalExact) return false;
				state.usage = {
					id, input: (state.usage?.input ?? 0) + input,
					output: (state.usage?.output ?? 0) + output,
					net: (state.usage?.net ?? 0) + net,
				};
				if (incrementAckLosses > 0) {
					incrementAckLosses--;
					throw new Error('summary ACK lost after commit');
				}
				return true;
			},
		},
		systemConfig: {
			async getConfig() {
				state.commissionReads++;
				return options.commission === undefined ? null : options.commission;
			},
		},
		portalLedger: {
			async ensureUserEarnings() {},
			async getEarningByRequestLogId(requestLogId: string) {
				state.earningReads++;
				return state.earnings.find((row) => row.requestLogId === requestLogId) ?? null;
			},
			async recordEarningAndCredit(params: EarnCall) {
				state.recordCalls++;
				if (state.earnings.some((row) => row.requestLogId === params.requestLogId)) return false;
				state.earnings.push(params);
				state.credits.push({ sellerUserId: params.sellerUserId, netAmount: params.netAmount });
				if (options.holdFirstTwoRecordInserts) {
					await new Promise<void>((resolve) => {
						releaseInserts.push(resolve);
						if (releaseInserts.length === 2) releaseInserts.splice(0).forEach((release) => release());
					});
				}
				await options.afterInsert?.(params);
				return true;
			},
			async rebuildSharedKeyUsageFromEarnings(requestLogId: string, expectedSharedKeyId: string) {
				state.rebuildCalls++;
				if (rebuildFailures > 0) {
					rebuildFailures--;
					throw new Error('summary store unavailable');
				}
				const rows = state.earnings.filter((row) => row.sharedKeyId === expectedSharedKeyId);
				if (!rows.some((row) => row.requestLogId === requestLogId)) throw new Error('authoritative earning missing');
				state.usage = {
					id: expectedSharedKeyId,
					input: rows.reduce((sum, row) => sum + row.inputTokens, 0),
					output: rows.reduce((sum, row) => sum + row.outputTokens, 0),
					net: rows.reduce((sum, row) => sum + row.netAmount, 0),
				};
			},
		},
	} as unknown as GatewayRepositories;
	return { repos, state };
}

describe('settleSharedKeyEarning', () => {
	it('computes gross minus commission and credits the seller', async () => {
		const key = makeKey({ id: 'k1', inputPrice: 2, outputPrice: 6 });
		const { repos, state } = makeRepos({ key, commission: '0.1' });
		const status = await settleSharedKeyEarning(repos, {
			requestLogId: 'log-1',
			providerKeyId: 'sharedkey:k1',
			usage: { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_tokens: 0, cache_write_tokens: 0 },
		});
		assert.equal(status, 'settled');
		assert.equal(state.earnings.length, 1);
		const earning = state.earnings[0]!;
		// gross = 1M×2 + 0.5M×6 = 5；fee = 0.5；net = 4.5
		assert.equal(earning.grossAmount, 5);
		assert.equal(earning.platformFee, 0.5);
		assert.equal(earning.netAmount, 4.5);
		assert.equal(earning.requestLogId, 'log-1');
		assert.deepEqual(state.credits, [{ sellerUserId: 'seller-1', netAmount: 4.5 }]);
		assert.deepEqual(state.usage, { id: 'k1', input: 1_000_000, output: 500_000, net: 4.5 });
		assert.equal(state.incrementCalls, 1);
		assert.equal(state.rebuildCalls, 0);
		assert.equal(state.earningReads, 0);
	});

	it('repeats the derived projection on duplicate request_log_id without a second credit', async () => {
		const key = makeKey({ id: 'k1' });
		const { repos, state } = makeRepos({ key });
		const input = {
			requestLogId: 'log-1',
			providerKeyId: 'sharedkey:k1',
			usage: { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0 },
		};
		assert.equal(await settleSharedKeyEarning(repos, input), 'settled');
		const firstProjection = state.usage;
		const keyReads = state.keyReads;
		const commissionReads = state.commissionReads;
		key.inputPrice = 0;
		key.outputPrice = 0;
		assert.equal(await settleSharedKeyEarning(repos, input), 'duplicate');
		assert.equal(state.earnings.length, 1);
		assert.equal(state.credits.length, 1);
		assert.equal(state.rebuildCalls, 1);
		assert.deepEqual(state.usage, firstProjection);
		assert.equal(state.keyReads, keyReads + 1);
		assert.equal(state.commissionReads, commissionReads);
	});

	it('repairs a failed post-credit projection on retry without double credit', async () => {
		const { repos, state } = makeRepos({ key: makeKey({ id: 'k1', inputPrice: 1, outputPrice: 0 }), incrementFailures: 1 });
		const status = await settleSharedKeyEarning(repos, {
			requestLogId: 'log-repair', providerKeyId: 'sharedkey:k1',
			usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
		});
		assert.equal(status, 'settled');
		assert.equal(state.recordCalls, 2);
		assert.equal(state.rebuildCalls, 1);
		assert.equal(state.incrementCalls, 1);
		assert.equal(state.earnings.length, 1);
		assert.equal(state.credits.length, 1);
		assert.deepEqual(state.usage, { id: 'k1', input: 1_000_000, output: 0, net: 0.9 });
	});

	it('later rerun repairs a committed earning after all immediate summary attempts failed and the key price changed', async () => {
		const key = makeKey({ id: 'k1', inputPrice: 1, outputPrice: 0 });
		const { repos, state } = makeRepos({ key, incrementFailures: 1, rebuildFailures: 2 });
		const input = {
			requestLogId: 'log-delayed-repair', providerKeyId: 'sharedkey:k1',
			usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
		};
		assert.equal(await settleSharedKeyEarning(repos, input), 'failed');
		assert.equal(state.earnings.length, 1);
		assert.equal(state.credits.length, 1);
		assert.equal(state.usage, null);
		const keyReads = state.keyReads;
		key.inputPrice = 0;
		assert.equal(await settleSharedKeyEarning(repos, input), 'duplicate');
		assert.equal(state.keyReads, keyReads + 1);
		assert.equal(state.recordCalls, 3);
		assert.equal(state.credits.length, 1);
		assert.deepEqual(state.usage, { id: 'k1', input: 1_000_000, output: 0, net: 0.9 });
	});

	it('an incremental update with a lost ACK is corrected by canonical rebuild, not added twice', async () => {
		const { repos, state } = makeRepos({ key: makeKey({ id: 'k1', inputPrice: 1, outputPrice: 0 }), incrementAckLosses: 1 });
		const status = await settleSharedKeyEarning(repos, {
			requestLogId: 'log-ack-loss', providerKeyId: 'sharedkey:k1',
			usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
		});
		assert.equal(status, 'settled');
		assert.equal(state.credits.length, 1);
		assert.equal(state.incrementCalls, 1);
		assert.equal(state.rebuildCalls, 1);
		assert.deepEqual(state.usage, { id: 'k1', input: 1_000_000, output: 0, net: 0.9 });
	});

	it('a rebuild between earning commit and fast increment forces the stale increment into repair', async () => {
		let repos: GatewayRepositories;
		let rebuildOnce = true;
		const fixture = makeRepos({
			key: makeKey({ id: 'k1', inputPrice: 1, outputPrice: 0 }),
			afterInsert: async (earning) => {
				if (!rebuildOnce) return;
				rebuildOnce = false;
				await repos.portalLedger.rebuildSharedKeyUsageFromEarnings(earning.requestLogId, earning.sharedKeyId, earning.nowIso);
			},
		});
		repos = fixture.repos;
		const status = await settleSharedKeyEarning(repos, {
			requestLogId: 'log-interleaved-rebuild', providerKeyId: 'sharedkey:k1',
			usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
		});
		assert.equal(status, 'settled');
		assert.equal(fixture.state.incrementCalls, 1);
		assert.equal(fixture.state.rebuildCalls, 2);
		assert.equal(fixture.state.credits.length, 1);
		assert.deepEqual(fixture.state.usage, { id: 'k1', input: 1_000_000, output: 0, net: 0.9 });
	});

	it('two normal settlements with the same initial projection use CAS then rebuild', async () => {
		const { repos, state } = makeRepos({
			key: makeKey({ id: 'k1', inputPrice: 1, outputPrice: 0 }),
			holdFirstTwoRecordInserts: true,
		});
		const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
		const statuses = await Promise.all([
			settleSharedKeyEarning(repos, { requestLogId: 'log-concurrent-1', providerKeyId: 'sharedkey:k1', usage }),
			settleSharedKeyEarning(repos, { requestLogId: 'log-concurrent-2', providerKeyId: 'sharedkey:k1', usage }),
		]);
		assert.deepEqual(statuses, ['settled', 'settled']);
		assert.equal(state.credits.length, 2);
		assert.equal(state.incrementCalls, 2);
		assert.equal(state.rebuildCalls, 1);
		assert.deepEqual(state.usage, { id: 'k1', input: 2_000_000, output: 0, net: 1.8 });
	});

	it('ignores non-shared provider keys and zero-token requests', async () => {
		const key = makeKey({ id: 'k1' });
		const plain = makeRepos({ key });
		await settleSharedKeyEarning(plain.repos, {
			requestLogId: 'log-1',
			providerKeyId: 'provider-9',
			usage: { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0 },
		});
		assert.equal(plain.state.earnings.length, 0);

		const zeroTokens = makeRepos({ key });
		await settleSharedKeyEarning(zeroTokens.repos, {
			requestLogId: 'log-2',
			providerKeyId: 'sharedkey:k1',
			usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
		});
		assert.equal(zeroTokens.state.earnings.length, 0);
	});

	it('falls back to default commission when config is missing or invalid', async () => {
		const key = makeKey({ id: 'k1', inputPrice: 1, outputPrice: 0 });
		for (const commission of [null, 'not-a-number']) {
			const { repos, state } = makeRepos({ key, commission });
			await settleSharedKeyEarning(repos, {
				requestLogId: 'log-x',
				providerKeyId: 'sharedkey:k1',
				usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
			});
			// 默认 10%：gross=1 → net=0.9
			assert.equal(state.earnings[0]!.netAmount, 0.9);
		}
	});
});
