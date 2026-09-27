import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestCapacityPool, retainCapacityUntilSettled } from './request-capacity';

for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
	test(`rejects invalid capacity ${value} without changing accounting`, () => {
		assert.throws(() => createRequestCapacityPool({ maxRequests: value, maxReservedBytes: 10 }), RangeError);
		assert.throws(() => createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: value }), RangeError);
		const pool = createRequestCapacityPool({ maxRequests: 2, maxReservedBytes: 10 });
		assert.throws(() => pool.tryAcquire(value), RangeError);
		assert.equal(pool.snapshot().requests, 0);
	});
}

test('byte and request caps are independent, inclusive, atomic and reusable', () => {
	const pool = createRequestCapacityPool({ maxRequests: 2, maxReservedBytes: 10 });
	assert.equal(pool.tryAcquire(11), null);
	const first = pool.tryAcquire(6)!;
	assert.equal(pool.tryAcquire(5), null);
	const second = pool.tryAcquire(4)!;
	assert.equal(pool.tryAcquire(1), null);
	first.release(); second.release();
	const a = pool.tryAcquire(1)!, b = pool.tryAcquire(1)!;
	assert.equal(pool.tryAcquire(1), null);
	a.release(); b.release();
	assert.equal(pool.snapshot().reservedBytes, 0);
});

test('mutating config and snapshots cannot expand the pool', () => {
	const config = { maxRequests: 1, maxReservedBytes: 5 };
	const pool = createRequestCapacityPool(config);
	config.maxRequests = 100;
	config.maxReservedBytes = 100;
	const snapshot = Object.assign(pool.snapshot(), { maxRequests: 100, maxReservedBytes: 100, requests: -100, reservedBytes: -100 });
	assert.equal(snapshot.requests, -100);
	const lease = pool.tryAcquire(5)!;
	assert.equal(pool.tryAcquire(1), null);
	assert.equal(pool.snapshot().requests, 1);
	lease.release();
});

test('safe integer maximum does not overflow admission arithmetic', () => {
	const pool = createRequestCapacityPool({ maxRequests: 3, maxReservedBytes: Number.MAX_SAFE_INTEGER });
	const a = pool.tryAcquire(Number.MAX_SAFE_INTEGER - 1)!;
	assert.equal(pool.tryAcquire(2), null);
	const b = pool.tryAcquire(1)!;
	assert.equal(pool.snapshot().reservedBytes, Number.MAX_SAFE_INTEGER);
	a.release(); b.release();
	assert.equal(pool.snapshot().reservedBytes, 0);
});

for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
	test(`handler/response/background release order ${order.join('-')} keeps a single charge`, () => {
		const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 10 });
		const lease = pool.tryAcquire(10)!;
		const releases = [lease.release, lease.retain(), lease.retain()];
		for (const [index, owner] of order.entries()) {
			assert.equal(pool.tryAcquire(1), null);
			releases[owner]!(); releases[owner]!();
			assert.equal(pool.snapshot().requests, index === 2 ? 0 : 1);
			assert.equal(pool.snapshot().reservedBytes, index === 2 ? 0 : 10);
		}
		assert.throws(() => lease.retain(), /already been returned/);
	});
}

test('live background/response work can transfer ownership after handler return, never after idle', () => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 10 });
	const lease = pool.tryAcquire(10)!;
	const background = lease.retain();
	lease.release();
	const nested = lease.retain();
	background();
	assert.equal(pool.snapshot().requests, 1);
	nested();
	assert.throws(() => lease.retain());
});

for (const rejects of [false, true]) test(`promise tracking preserves ${rejects ? 'rejection' : 'value'}`, async () => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 10 });
	const lease = pool.tryAcquire(10)!;
	let settle!: () => void;
	const expected = new Error('synthetic');
	const task = new Promise<number>((resolve, reject) => { settle = () => rejects ? reject(expected) : resolve(42); });
	const owned = retainCapacityUntilSettled(lease, task);
	lease.release();
	assert.equal(pool.snapshot().requests, 1);
	settle();
	if (rejects) await assert.rejects(owned, (error) => error === expected);
	else assert.equal(await owned, 42);
	assert.equal(pool.snapshot().requests, 0);
});

test('late already-started rejection is observed when registration is refused', async () => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 10 });
	const lease = pool.tryAcquire(10)!;
	lease.release();
	assert.throws(() => retainCapacityUntilSettled(lease, Promise.reject(new Error('late'))), /already been returned/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pool.snapshot().requests, 0);
});

test('parallel attempts cannot overbook and independent pools do not share state', async () => {
	const pool = createRequestCapacityPool({ maxRequests: 3, maxReservedBytes: 100 });
	const leases = await Promise.all(Array.from({ length: 100 }, async () => pool.tryAcquire(30)));
	assert.equal(leases.filter(Boolean).length, 3);
	const other = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	const independent = other.tryAcquire(1)!;
	assert.equal(pool.snapshot().reservedBytes, 90);
	for (const lease of leases) lease?.release();
	assert.equal(other.snapshot().requests, 1);
	independent.release();
});
