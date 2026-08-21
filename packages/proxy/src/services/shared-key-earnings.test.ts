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
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeRepos(options: {
	key: SharedKeyRow | null;
	commission?: string | null;
	duplicate?: boolean;
}) {
	const state = {
		earnings: [] as EarnCall[],
		credits: [] as Array<{ sellerUserId: string; netAmount: number }>,
		usage: [] as Array<{ id: string; input: number; output: number; net: number }>,
	};
	const repos = {
		sharedKeys: {
			async getSharedKeyById(id: string) {
				return options.key && options.key.id === id ? options.key : null;
			},
			async addSharedKeyUsage(id: string, inputTokens: number, outputTokens: number, netAmount: number) {
				state.usage.push({ id, input: inputTokens, output: outputTokens, net: netAmount });
			},
		},
		systemConfig: {
			async getConfig() {
				return options.commission === undefined ? null : options.commission;
			},
		},
		portalLedger: {
			async ensureUserEarnings() {},
			async insertEarning(params: EarnCall) {
				if (options.duplicate) return false;
				state.earnings.push(params);
				return true;
			},
			async creditEarningBalance(sellerUserId: string, netAmount: number) {
				state.credits.push({ sellerUserId, netAmount });
			},
		},
	} as unknown as GatewayRepositories;
	return { repos, state };
}

describe('settleSharedKeyEarning', () => {
	it('computes gross minus commission and credits the seller', async () => {
		const key = makeKey({ id: 'k1', inputPrice: 2, outputPrice: 6 });
		const { repos, state } = makeRepos({ key, commission: '0.1' });
		await settleSharedKeyEarning(repos, {
			requestLogId: 'log-1',
			providerKeyId: 'sharedkey:k1',
			usage: { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_tokens: 0, cache_write_tokens: 0 },
		});
		assert.equal(state.earnings.length, 1);
		const earning = state.earnings[0]!;
		// gross = 1M×2 + 0.5M×6 = 5；fee = 0.5；net = 4.5
		assert.equal(earning.grossAmount, 5);
		assert.equal(earning.platformFee, 0.5);
		assert.equal(earning.netAmount, 4.5);
		assert.equal(earning.requestLogId, 'log-1');
		assert.deepEqual(state.credits, [{ sellerUserId: 'seller-1', netAmount: 4.5 }]);
		assert.deepEqual(state.usage, [{ id: 'k1', input: 1_000_000, output: 500_000, net: 4.5 }]);
	});

	it('is idempotent on duplicate request_log_id (no double credit)', async () => {
		const key = makeKey({ id: 'k1' });
		const { repos, state } = makeRepos({ key, duplicate: true });
		await settleSharedKeyEarning(repos, {
			requestLogId: 'log-1',
			providerKeyId: 'sharedkey:k1',
			usage: { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0 },
		});
		assert.equal(state.earnings.length, 0);
		assert.equal(state.credits.length, 0);
		assert.equal(state.usage.length, 0);
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
