import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInMemoryPublicStatsRuntimeGuard } from './public-stats-runtime-guard';

test('Node fallback cache ignores host but isolates paths and canonicalizes query order', async () => {
	let now = 1_000;
	const guard = createInMemoryPublicStatsRuntimeGuard({ now: () => now, ttlMs: 60_000 });
	await guard.cache!.put(
		new Request('https://first.example/catalog/stats/models?unused=1&range=7d'),
		new Response('cached'),
	);
	const hit = await guard.cache!.match(
		new Request('https://attacker-host.example/catalog/stats/models?range=7d&unused=1')
	);
	assert.equal(await hit?.text(), 'cached');
	now += 60_000;
	assert.equal(
		await guard.cache!.match(
			new Request('https://first.example/catalog/stats/models?range=7d&unused=1')
		),
		undefined
	);
});

test('Node fallback rate limiter is fixed-window and fail-closed after its bound', async () => {
	let now = 0;
	const guard = createInMemoryPublicStatsRuntimeGuard({ now: () => now, limit: 2, periodMs: 60_000 });
	assert.equal((await guard.rateLimiter!.limit({ key: 'catalog-stats:7d' })).success, true);
	assert.equal((await guard.rateLimiter!.limit({ key: 'catalog-stats:7d' })).success, true);
	assert.equal((await guard.rateLimiter!.limit({ key: 'catalog-stats:7d' })).success, false);
	now = 60_000;
	assert.equal((await guard.rateLimiter!.limit({ key: 'catalog-stats:7d' })).success, true);
});

test('singleflight coalesces concurrent loaders and returns independently readable responses', async () => {
	const guard = createInMemoryPublicStatsRuntimeGuard();
	let loads = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const loader = async () => {
		loads += 1;
		await gate;
		return new Response('snapshot');
	};
	const first = guard.singleflight.run('7d', loader);
	const second = guard.singleflight.run('7d', loader);
	release();
	const responses = await Promise.all([first, second]);
	assert.equal(loads, 1);
	assert.deepEqual(await Promise.all(responses.map((response) => response.text())), ['snapshot', 'snapshot']);
});
