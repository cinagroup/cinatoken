import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import type { PostgresRecoveryRunResult } from '../../../core/src/storage/recovery/run-usage-recovery-postgres';
import {
	createPostgresRecoveryQueueOwner,
	POSTGRES_RECOVERY_STAGING_QUEUE,
	POSTGRES_RECOVERY_WAKE_V1,
} from './postgres-recovery-queue-owner';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function result(overrides: Partial<PostgresRecoveryRunResult> = {}): PostgresRecoveryRunResult {
	return {
		discovered: 0, registered: 0, scanned: 0, claimed: 0, committed: 0,
		blocked: 0, deferred: 0, lostOwnership: 0, uncertain: 0, skipped: 0,
		leasesLeftForExpiry: 0, capacityLimited: false, admissionStopped: false,
		stopReason: null, resources: 'confirmed', retainedHolds: 0,
		...overrides,
	};
}

function batch(body: unknown = POSTGRES_RECOVERY_WAKE_V1, queue = POSTGRES_RECOVERY_STAGING_QUEUE): MessageBatch<unknown> {
	return {
		queue,
		messages: [{
			id: 'wake-1', timestamp: new Date(0), attempts: 1, body,
			ack() { throw new Error('candidate must not decide Queue ACK'); },
			retry() { throw new Error('candidate must not decide Queue retry'); },
		}],
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		ackAll() { throw new Error('candidate must not decide Queue ACK'); },
		retryAll() { throw new Error('candidate must not decide Queue retry'); },
	};
}

function context(registrations: Promise<unknown>[], rejectRegistration = false): Pick<ExecutionContext, 'waitUntil'> {
	return {
		waitUntil(promise) {
			if (rejectRegistration) throw new Error('host refused lifecycle registration');
			registrations.push(promise);
		},
	};
}

test('candidate is disabled by default and never reads a binding or starts database work', async () => {
	let opened = 0;
	const owner = createPostgresRecoveryQueueOwner({
		openClient() { opened++; return {}; },
		startRun() { throw new Error('must not start'); },
		retireClient() { throw new Error('must not retire'); },
	});
	const registrations: Promise<unknown>[] = [];
	assert.deepEqual(await owner.queue(batch(), {}, context(registrations)), { status: 'disabled' });
	assert.equal(opened, 0);
	assert.equal(registrations.length, 0);
});

test('only one identity-free fixed staging wake is accepted before registration or database work', async () => {
	let opened = 0;
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true,
		invocationBudgetMs: 60_000,
		openClient() { opened++; return {}; },
		startRun() { throw new Error('must not start'); },
		retireClient() { throw new Error('must not retire'); },
	});
	const registrations: Promise<unknown>[] = [];
	const wrong: MessageBatch<unknown>[] = [
		batch(POSTGRES_RECOVERY_WAKE_V1, 'cinatoken-proxy'),
		batch({ kind: POSTGRES_RECOVERY_WAKE_V1, tenant: 'user-1', model: 'paid-model' }),
		batch(null),
		{ ...batch(), messages: [] },
		{ ...batch(), messages: [...batch().messages, ...batch().messages] },
	];
	for (const item of wrong) assert.deepEqual(await owner.queue(item, {}, context(registrations)), { status: 'invalid_wake' });
	assert.equal(opened, 0);
	assert.equal(registrations.length, 0);
});

test('host registration rejection performs zero client/database work and clears the local gate', async () => {
	let opened = 0;
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true,
		invocationBudgetMs: 60_000,
		openClient() { opened++; return {}; },
		startRun() { return { completion: Promise.resolve(result()) }; },
		retireClient() {},
	});
	assert.deepEqual(await owner.queue(batch(), {}, context([], true)), { status: 'host_rejected' });
	assert.equal(opened, 0);
	const registrations: Promise<unknown>[] = [];
	assert.equal((await owner.queue(batch(), {}, context(registrations))).status, 'run_drained');
	assert.equal(opened, 1);
	assert.equal(registrations.length, 1);
	await registrations[0];
});

test('Queue main Promise owns the SAME completion after an earlier observation ends', async () => {
	const completion = deferred<PostgresRecoveryRunResult>();
	const observation = deferred<void>();
	const started = deferred<void>();
	let opens = 0, starts = 0, retires = 0, returned = false;
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true,
		invocationBudgetMs: 60_000,
		openClient() { opens++; return {}; },
		startRun() { starts++; started.resolve(); return { completion: completion.promise, observation: observation.promise }; },
		retireClient() { retires++; },
	});
	const registrations: Promise<unknown>[] = [];
	// This is the future Queue-handler shape: its main returned Promise awaits owner.queue().
	const queueHandlerPromise = (async () => {
		const outcome = await owner.queue(batch(), {}, context(registrations));
		returned = true;
		return outcome;
	})();
	await started.promise;
	assert.equal(opens, 1);
	assert.equal(starts, 1);
	assert.equal(registrations.length, 1);
	observation.resolve();
	await observation.promise;
	await Promise.resolve();
	assert.equal(returned, false);
	assert.equal(retires, 0);
	const concurrent = await owner.queue(batch(), {}, context([]));
	assert.deepEqual(concurrent, { status: 'busy' });
	completion.resolve(result({ discovered: 1, registered: 1, scanned: 1, claimed: 1, committed: 1 }));
	assert.deepEqual(await queueHandlerPromise, {
		status: 'run_drained', result: { scanned: 1, claimed: 1, committed: 1 }, physicalClose: 'not_observed',
	});
	assert.equal(retires, 1);
	await registrations[0];
});

test('run uncertainty and unconfirmed resources never project a successful outcome', async () => {
	for (const uncertain of [
		result({ uncertain: 1 }),
		result({ resources: 'unconfirmed', retainedHolds: 1 }),
		result({ leasesLeftForExpiry: 1 }),
	]) {
		let retire = 0;
		const owner = createPostgresRecoveryQueueOwner({
			enabled: true,
			invocationBudgetMs: 60_000,
			openClient() { return {}; },
			startRun() { return { completion: Promise.resolve(uncertain) }; },
			retireClient() { retire++; },
		});
		assert.deepEqual(await owner.queue(batch(), {}, context([])), {
			status: 'outcome_unknown', physicalClose: 'not_observed',
		});
		assert.deepEqual(await owner.queue(batch(), {}, context([])), { status: 'capacity_quarantined' });
		assert.equal(retire, 1);
	}
});

test('busy and unknown are diagnostic results, not an ACK/retry policy for a real Queue handler', async () => {
	const completion = deferred<PostgresRecoveryRunResult>();
	const started = deferred<void>();
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true,
		invocationBudgetMs: 60_000,
		openClient() { return {}; },
		startRun() { started.resolve(); return { completion: completion.promise }; },
		retireClient() {},
	});
	const first = owner.queue(batch(), {}, context([]));
	await started.promise;
	assert.deepEqual(await owner.queue(batch(), {}, context([])), { status: 'busy' });
	completion.resolve(result({ resources: 'unconfirmed', retainedHolds: 1 }));
	assert.deepEqual(await first, { status: 'outcome_unknown', physicalClose: 'not_observed' });
	// The fixture throws on explicit ack/retry, so neither status made a delivery
	// decision here. Cloudflare would implicitly ACK if a real Queue handler simply
	// returned normally; therefore this owner deliberately has no deployment wiring.
});

test('bounded stop is incomplete, even when local resources drain', async () => {
	let opens = 0, retires = 0;
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true,
		invocationBudgetMs: 60_000,
		openClient() { opens++; return {}; },
		startRun() { return { completion: Promise.resolve(result({ admissionStopped: true, stopReason: 'budget' })) }; },
		retireClient() { retires++; },
	});
	for (let i = 0; i < 2; i++) {
		assert.deepEqual(await owner.queue(batch(), {}, context([])), {
			status: 'bounded_incomplete', result: { scanned: 0, claimed: 0, committed: 0 }, physicalClose: 'not_observed',
		});
	}
	assert.deepEqual({ opens, retires }, { opens: 2, retires: 2 });
});

test('open, start, completion and retirement faults stay unknown without raw error text', async () => {
	for (const failing of ['open', 'start', 'completion', 'retire'] as const) {
		let retire = 0;
		const owner = createPostgresRecoveryQueueOwner({
			enabled: true,
			invocationBudgetMs: 60_000,
			openClient() { if (failing === 'open') throw new Error('private credential'); return {}; },
			startRun() {
				if (failing === 'start') throw new Error('private SQL');
				return { completion: failing === 'completion' ? Promise.reject(new Error('private result')) : Promise.resolve(result()) };
			},
			retireClient() { retire++; if (failing === 'retire') throw new Error('private socket'); },
		});
		const outcome = await owner.queue(batch(), {}, context([]));
		assert.deepEqual(outcome, { status: 'outcome_unknown', physicalClose: 'not_observed' });
		assert.doesNotMatch(JSON.stringify(outcome), /private/);
		assert.equal(retire, failing === 'open' ? 0 : 1);
	}
});

test('uncertain client acquisition quarantines the local origin slot after the first wake', async () => {
	const entered = deferred<void>(), failed = deferred<object>();
	let opens = 0, starts = 0;
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true,
		invocationBudgetMs: 60_000,
		openClient() { opens++; entered.resolve(); return failed.promise; },
		startRun() { starts++; return { completion: Promise.resolve(result()) }; },
		retireClient() { throw new Error('no client handle was returned'); },
	});
	const registrations: Promise<unknown>[] = [];
	const first = owner.queue(batch(), {}, context(registrations));
	await entered.promise;
	assert.deepEqual(await owner.queue(batch(), {}, context(registrations)), { status: 'busy' });
	failed.reject(new Error('connection may have been allocated'));
	assert.deepEqual(await first, { status: 'outcome_unknown', physicalClose: 'not_observed' });
	assert.deepEqual(await owner.queue(batch(), {}, context(registrations)), { status: 'capacity_quarantined' });
	assert.equal(opens, 1);
	assert.equal(starts, 0);
	assert.equal(registrations.length, 1);
	await registrations[0];
});

test('failed client retirement quarantines capacity even when the run completed', async () => {
	let opens = 0, starts = 0, retires = 0;
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true,
		invocationBudgetMs: 60_000,
		openClient() { opens++; return {}; },
		startRun() { starts++; return { completion: Promise.resolve(result()) }; },
		retireClient() { retires++; throw new Error('physical close unknown'); },
	});
	const registrations: Promise<unknown>[] = [];
	assert.deepEqual(await owner.queue(batch(), {}, context(registrations)), {
		status: 'outcome_unknown', physicalClose: 'not_observed',
	});
	assert.deepEqual(await owner.queue(batch(), {}, context(registrations)), { status: 'capacity_quarantined' });
	assert.deepEqual({ opens, starts, retires, registrations: registrations.length },
		{ opens: 1, starts: 1, retires: 1, registrations: 1 });
	await registrations[0];
});

test('retirement failure after expired initialization also quarantines capacity', async () => {
	let time = 0, opens = 0, starts = 0, retires = 0;
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true,
		invocationBudgetMs: 10,
		now: () => time,
		openClient() { opens++; time = 11; return {}; },
		startRun() { starts++; return { completion: Promise.resolve(result()) }; },
		retireClient() { retires++; throw new Error('physical close unknown'); },
	});
	assert.deepEqual(await owner.queue(batch(), {}, context([])), {
		status: 'outcome_unknown', physicalClose: 'not_observed',
	});
	assert.deepEqual(await owner.queue(batch(), {}, context([])), { status: 'capacity_quarantined' });
	assert.deepEqual({ opens, starts, retires }, { opens: 1, starts: 0, retires: 1 });
});

test('a single invocation deadline starts before client opening and cannot be renewed by initialization', async () => {
	let time = 100, starts = 0, retires = 0;
	const entered = deferred<void>(), opened = deferred<object>();
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true, invocationBudgetMs: 10, now: () => time,
		openClient(_environment, deadline) {
			assert.deepEqual(deadline.snapshot(), { status: 'open', remainingMs: 10 });
			entered.resolve();
			return opened.promise;
		},
		startRun() { starts++; throw new Error('expired initialization cannot start recovery'); },
		retireClient() { retires++; },
	});
	const operation = owner.queue(batch(), {}, context([]));
	await entered.promise;
	time = 111;
	opened.resolve({});
	assert.deepEqual(await operation, { status: 'deadline_expired', physicalClose: 'not_observed' });
	assert.equal(starts, 0);
	assert.equal(retires, 1);
});

test('run receives the exact pre-initialization deadline and keeps the original completion owned after expiry', async () => {
	let time = 0, openingDeadline: object | undefined, startingDeadline: object | undefined, retires = 0;
	const completion = deferred<PostgresRecoveryRunResult>(), started = deferred<void>();
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true, invocationBudgetMs: 10, now: () => time,
		openClient(_environment, deadline) { openingDeadline = deadline; return {}; },
		startRun(_client, deadline) { startingDeadline = deadline; started.resolve(); return { completion: completion.promise }; },
		retireClient() { retires++; },
	});
	let returned = false;
	const operation = owner.queue(batch(), {}, context([])).then(outcome => { returned = true; return outcome; });
	await started.promise;
	assert.equal(openingDeadline, startingDeadline);
	time = 11;
	assert.equal((startingDeadline as { snapshot(): { status: string } }).snapshot().status, 'expired');
	await Promise.resolve();
	assert.equal(returned, false);
	assert.equal(retires, 0);
	completion.resolve(result({ admissionStopped: true, stopReason: 'budget' }));
	assert.equal((await operation).status, 'bounded_incomplete');
	assert.equal(retires, 1);
});

test('initial clock failure refuses database work and invalid enabled budgets fail at construction', async () => {
	let reads = 0, opens = 0;
	const owner = createPostgresRecoveryQueueOwner({
		enabled: true, invocationBudgetMs: 10,
		now() { return ++reads === 1 ? 0 : NaN; },
		openClient() { opens++; return {}; },
		startRun() { throw new Error('must not run'); },
		retireClient() { throw new Error('must not retire'); },
	});
	assert.deepEqual(await owner.queue(batch(), {}, context([])), { status: 'clock_invalid', physicalClose: 'not_observed' });
	assert.equal(opens, 0);
	for (const invocationBudgetMs of [undefined, 0, 60_001, NaN]) {
		assert.throws(() => createPostgresRecoveryQueueOwner({
			enabled: true, invocationBudgetMs,
			openClient() { return {}; }, startRun() { return { completion: Promise.resolve(result()) }; }, retireClient() {},
		}), /Invalid PostgreSQL recovery invocation budget/);
	}
});
