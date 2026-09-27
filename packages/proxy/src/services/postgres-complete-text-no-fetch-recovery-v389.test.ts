import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	createPostgresCompleteTextNoFetchRecoveryV389,
	runPostgresCompleteTextNoFetchRecoveryV389,
	PostgresNoFetchRecoveryCleanupUnconfirmedV389,
	type CompleteTextNoFetchRecoveryConnectionsV389,
	type NoFetchRecoveryClaimV389,
	type NoFetchRecoveryClientV389,
	type NoFetchRecoveryObservationV389,
	type NoFetchRecoveryPortsV389,
} from './postgres-complete-text-no-fetch-recovery-v389';
import { PostgresCompleteTextNoFetchRejectedError } from './postgres-complete-text-no-fetch-v372';
import { PostgresCompleteTextNoFetchCloseRejectedError } from './postgres-complete-text-no-fetch-close-v388';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const urls: CompleteTextNoFetchRecoveryConnectionsV389 = {
	workerConnectionString: 'postgres://cinatoken_gateway_complete_text_recovery_worker:owned@localhost/db',
	observerConnectionString: 'postgres://cinatoken_gateway_complete_text_recovery_observer:owned@localhost/db',
	resolverConnectionString: 'postgres://cinatoken_gateway_complete_text_no_fetch_resolver:owned@localhost/db',
	closerConnectionString: 'postgres://cinatoken_gateway_complete_text_platform_closer:owned@localhost/db',
};
const claim: NoFetchRecoveryClaimV389 = Object.freeze({ status: 'claimed', jobId: uuid(1),
	requestId: 'recovery-request', grantId: uuid(2), resolutionNonce: uuid(3), decisionNonce: uuid(4),
	leaseToken: uuid(5), leaseGeneration: 1, leaseUntil: '2099-01-01T00:00:00Z', attemptCount: 1 });
const limits = { scanLimit: 10, maxItems: 1, admissionBudgetMs: 25_000, leaseSeconds: 300 };
const ack = <T>(value: T) => Object.freeze({ ...value, commitAcknowledged: true as const, closeAcknowledged: true as const });
function observation(status: NoFetchRecoveryObservationV389['status']): NoFetchRecoveryObservationV389 {
	return { status, jobId: claim.jobId, requestId: claim.requestId, grantId: claim.grantId,
		resolutionNonce: claim.resolutionNonce, decisionNonce: claim.decisionNonce,
		resolutionId: status === 'ready_to_close' || status === 'confirmed' ? uuid(6) : null,
		terminalId: status === 'confirmed' ? uuid(7) : null, eventId: status === 'confirmed' ? uuid(8) : null };
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
type Step = {
	value: unknown; role?: string; isolation?: string; commitGate?: Promise<void>; closeGate?: Promise<void>;
	commitError?: Error; closeError?: Error; onRole?: () => void;
};
function sqlFactory(steps: Step[]) {
	const actions: { name: string; query?: string; params?: unknown[]; url?: string }[] = [];
	const factory = (url: string) => {
		const step = steps.shift(); assert.ok(step, 'unexpected SQL client');
		actions.push({ name: 'connect', url });
		const query = async (query: string, params?: unknown[]) => {
			actions.push({ name: 'query', query, params });
			if (query.startsWith('SELECT current_user')) {
				step.onRole?.();
				return [{ current_role: step.role ?? new URL(url).username,
					session_role: new URL(url).username, transaction_isolation: step.isolation ?? 'read committed' }];
			}
			return [{ value: step.value }];
		};
		return {
			unsafe: query,
			async begin(run: (tx: { unsafe: typeof query }) => Promise<unknown>) {
				actions.push({ name: 'begin' });
				try {
					const result = await run({ unsafe: query });
					actions.push({ name: 'commit_pending' });
					await step.commitGate;
					if (step.commitError) throw step.commitError;
					actions.push({ name: 'commit' }); return result;
				} catch (error) { actions.push({ name: 'rollback_or_uncertain' }); throw error; }
			},
			async end() {
				actions.push({ name: 'close_pending' }); await step.closeGate;
				if (step.closeError) throw step.closeError;
				actions.push({ name: 'close' });
			},
		} as unknown as PostgresDatabaseClient['raw'];
	};
	return { factory, actions };
}

test('direct claim waits for COMMIT and connection close before exposing durable nonces', async () => {
	const commit = deferred(), close = deferred();
	const fake = sqlFactory([{ value: claim, commitGate: commit.promise, closeGate: close.promise }]);
	const client = createPostgresCompleteTextNoFetchRecoveryV389(urls, fake.factory);
	let returned = false;
	const promise = client.claim(300).then(value => { returned = true; return value; });
	await setImmediate(); assert.equal(returned, false);
	commit.resolve(); await setImmediate(); assert.equal(returned, false);
	close.resolve(); const result = await promise;
	assert.equal(result.status, 'claimed'); assert.equal(result.commitAcknowledged, true);
	assert.equal(result.closeAcknowledged, true); assert.equal(Object.isFrozen(result), true);
	assert.deepEqual(fake.actions.filter(x => x.params).map(x => x.params), [[300]]);
});

test('direct observer snapshots claim identity and rejects mismatches inside its transaction', async () => {
	const mutable = { ...claim };
	const fake = sqlFactory([{ value: observation('ready_to_close'), onRole() {
		mutable.jobId = uuid(90); mutable.leaseToken = uuid(91);
	} }]);
	const client = createPostgresCompleteTextNoFetchRecoveryV389(urls, fake.factory);
	const result = await client.observe(mutable);
	assert.equal(result.status, 'ready_to_close');
	assert.deepEqual(fake.actions.filter(x => x.params).map(x => x.params), [[claim.jobId, claim.leaseToken]]);
	for (const changed of [
		{ jobId: uuid(21) }, { grantId: uuid(22) }, { requestId: 'another-request' },
		{ resolutionNonce: uuid(23) }, { decisionNonce: uuid(24) }, { resolutionId: null },
		{ supplierCostMicros: 0 }, { sendAuthority: true },
	]) {
		const bad = sqlFactory([{ value: { ...observation('ready_to_close'), ...changed } }]);
		await assert.rejects(createPostgresCompleteTextNoFetchRecoveryV389(urls, bad.factory).observe(claim), /response differs/u);
		assert.equal(bad.actions.some(x => x.name === 'commit'), false);
		assert.equal(bad.actions.at(-1)?.name, 'close');
	}
});

test('direct clients require exact LOGIN, bounds and valid return shapes before COMMIT', async () => {
	assert.throws(() => createPostgresCompleteTextNoFetchRecoveryV389({ ...urls,
		workerConnectionString: urls.closerConnectionString }), /direct LOGIN/u);
	for (const step of [
		{ value: claim, role: 'cinatoken_gateway_runtime' },
		{ value: claim, isolation: 'repeatable read' },
		{ value: { ...claim, attemptCount: 8 } },
		{ value: { ...claim, leaseToken: 'bad' } },
		{ value: { ...claim, leaseGeneration: 0 } },
		{ value: { ...claim, leaseUntil: 'bad' } },
	]) {
		const fake = sqlFactory([step]);
		await assert.rejects(createPostgresCompleteTextNoFetchRecoveryV389(urls, fake.factory).claim(300));
		assert.equal(fake.actions.some(x => x.name === 'commit'), false);
	}
	const fake = sqlFactory([]), client = createPostgresCompleteTextNoFetchRecoveryV389(urls, fake.factory);
	assert.throws(() => client.scan(51), /limit invalid/u);
	assert.throws(() => client.claim(4), /duration invalid/u);
	assert.equal(fake.actions.length, 0);
});

test('direct COMMIT or close uncertainty has no receipt and preserves both failure causes', async () => {
	const failedCommit = new Error('COMMIT response lost'), failedClose = new Error('close response lost');
	for (const step of [
		{ value: claim, commitError: failedCommit },
		{ value: claim, closeError: failedClose },
		{ value: claim, commitError: failedCommit, closeError: failedClose },
	]) {
		const fake = sqlFactory([step]);
		await assert.rejects(createPostgresCompleteTextNoFetchRecoveryV389(urls, fake.factory).claim(300), error => {
			if (step.closeError) {
				assert.ok(error instanceof PostgresNoFetchRecoveryCleanupUnconfirmedV389);
				if (step.commitError) assert.ok(error.cause instanceof AggregateError);
			} else assert.equal(error, failedCommit);
			return true;
		});
		assert.equal(fake.actions.filter(x => x.name === 'connect').length, 1);
	}
});

type HarnessOptions = {
	states?: (NoFetchRecoveryObservationV389['status'] | 'lease_lost')[];
	throwAt?: string; resolveRejection?: boolean; closeRejection?: boolean;
	empty?: boolean; noClaimAck?: boolean;
};
function harness(options: HarnessOptions = {}) {
	const calls: string[] = [], argumentsSeen: unknown[] = [];
	const states = [...(options.states ?? ['ready_to_resolve', 'ready_to_close', 'confirmed'])];
	const check = (stage: string) => { calls.push(stage); if (options.throwAt === stage) throw new Error(`${stage} acknowledgement lost`); };
	const client: NoFetchRecoveryClientV389 = {
		async scan() { check('scan'); return ack({ status: 'scanned' as const, enqueued: 1 }); },
		async claim() {
			check('claim');
			if (options.empty) return ack({ status: 'empty' as const });
			if (options.noClaimAck) return { ...ack(claim), commitAcknowledged: false } as never;
			return ack(claim);
		},
		async observe() {
			check('observe'); const status = states.shift(); assert.ok(status);
			return status === 'lease_lost' ? ack({ status }) : ack(observation(status));
		},
		async finish() { check('finish'); return ack({ status: 'completed' as const, jobId: claim.jobId, terminalId: uuid(7), eventId: uuid(8) }); },
		async fail(_claim, code) {
			check(`fail:${code}`); return ack({ status: code === 'possible_send' || code === 'state_conflict'
				? 'quarantined' as const : 'retry_scheduled' as const });
		},
	};
	const ports: NoFetchRecoveryPortsV389 = {
		client, monotonicMs: () => 100,
		async resolve(params) {
			check('resolve'); argumentsSeen.push(params);
			if (options.resolveRejection) throw new PostgresCompleteTextNoFetchRejectedError('resolution_conflict');
			return ack({ status: 'verified_no_fetch_recorded' as const, grantId: params.grantId,
				resolutionNonce: params.resolutionNonce, resolutionId: uuid(6), fencedAt: '2026-09-26T00:00:00Z' });
		},
		async close(params) {
			check('close'); argumentsSeen.push(params);
			if (options.closeRejection) throw new PostgresCompleteTextNoFetchCloseRejectedError('decision_conflict');
			return ack({ status: 'closed_no_fetch' as const, ...params, terminalId: uuid(7), eventId: uuid(8),
				decisionSha256: 'a'.repeat(64), buyerChargedMicros: 0 as const,
				supplierCostStatus: 'not_asserted' as const, closedAt: '2026-09-26T00:00:00Z' });
		},
	};
	return { calls, argumentsSeen, ports };
}

test('runner follows independent durable observations through resolve, close and verified finish', async () => {
	const h = harness();
	const result = await runPostgresCompleteTextNoFetchRecoveryV389(urls, limits, h.ports);
	assert.deepEqual(h.calls, ['scan', 'claim', 'observe', 'resolve', 'observe', 'close', 'observe', 'finish']);
	assert.deepEqual(h.argumentsSeen, [
		{ resolverConnectionString: urls.resolverConnectionString, grantId: claim.grantId, resolutionNonce: claim.resolutionNonce },
		{ closerConnectionString: urls.closerConnectionString, requestId: claim.requestId, grantId: claim.grantId,
			resolutionId: uuid(6), decisionNonce: claim.decisionNonce },
	]);
	assert.deepEqual(result, { enqueued: 1, claimed: 1, completed: 1, retryScheduled: 0, quarantined: 0, stopReason: 'item_limit' });
});

test('fresh invocations adopt existing committed resolution or terminal without new nonces', async () => {
	for (const states of [['ready_to_close', 'confirmed'], ['confirmed']] as const) {
		const h = harness({ states: [...states] });
		const result = await runPostgresCompleteTextNoFetchRecoveryV389(urls, limits, h.ports);
		assert.equal(result.completed, 1); assert.equal(h.calls.includes('resolve'), false);
		assert.equal(h.calls.includes('close'), states[0] === 'ready_to_close');
		assert.equal(h.calls.at(-1), 'finish');
	}
});

test('uncertain scan, claim, observer, resolver, closer or finish stops without fail or a second claim', async () => {
	for (const throwAt of ['scan', 'claim', 'observe', 'resolve', 'close', 'finish']) {
		const h = harness({ throwAt });
		await assert.rejects(runPostgresCompleteTextNoFetchRecoveryV389(urls, limits, h.ports), /acknowledgement lost/u);
		assert.equal(h.calls.at(-1), throwAt);
		assert.equal(h.calls.some(call => call.startsWith('fail:')), false);
		assert.ok(h.calls.filter(call => call === 'claim').length <= 1);
	}
	const h = harness({ noClaimAck: true });
	await assert.rejects(runPostgresCompleteTextNoFetchRecoveryV389(urls, limits, h.ports), /acknowledgement missing/u);
	assert.deepEqual(h.calls, ['scan', 'claim']);
});

test('confirmed nonce conflicts trigger fresh observation and can adopt a concurrent legal close', async () => {
	const h = harness({ resolveRejection: true, closeRejection: true });
	const result = await runPostgresCompleteTextNoFetchRecoveryV389(urls, limits, h.ports);
	assert.equal(result.completed, 1); assert.equal(h.calls.some(call => call.startsWith('fail:')), false);
	assert.equal(h.calls.filter(call => call === 'observe').length, 3);
});

test('possible sends and contradictory state quarantine without money calls; lost lease stops', async () => {
	for (const state of ['possible_send', 'conflict', 'lease_lost'] as const) {
		const h = harness({ states: [state] });
		const result = await runPostgresCompleteTextNoFetchRecoveryV389(urls, limits, h.ports);
		assert.equal(h.calls.includes('resolve') || h.calls.includes('close') || h.calls.includes('finish'), false);
		assert.equal(result.completed, 0);
		assert.equal(result.quarantined, state === 'lease_lost' ? 0 : 1);
		if (state === 'lease_lost') assert.equal(result.stopReason, 'lease_lost');
	}
	const h = harness({ states: ['ready_to_resolve', 'ready_to_resolve'], resolveRejection: true });
	const result = await runPostgresCompleteTextNoFetchRecoveryV389(urls, limits, h.ports);
	assert.equal(result.retryScheduled, 1); assert.equal(h.calls.at(-1), 'fail:resolver_rejected');
});

test('admission budget stops new claims and caller mutation cannot swap financial connections', async () => {
	const h = harness(), mutable = { ...urls };
	const priorScan = h.ports.client!.scan;
	const ports = { ...h.ports, client: { ...h.ports.client!, async scan(n: number) {
		mutable.resolverConnectionString = 'postgres://wrong:wrong@different/db';
		mutable.closerConnectionString = 'postgres://wrong:wrong@different/db';
		return priorScan(n);
	} } };
	assert.equal((await runPostgresCompleteTextNoFetchRecoveryV389(mutable, limits, ports)).completed, 1);
	assert.equal((h.argumentsSeen[0] as { resolverConnectionString: string }).resolverConnectionString, urls.resolverConnectionString);
	assert.equal((h.argumentsSeen[1] as { closerConnectionString: string }).closerConnectionString, urls.closerConnectionString);
	const timed = harness(); let time = 0;
	const result = await runPostgresCompleteTextNoFetchRecoveryV389(urls, limits, {
		...timed.ports, monotonicMs: () => (time += 30_000),
	});
	assert.equal(result.stopReason, 'admission_budget'); assert.deepEqual(timed.calls, ['scan']);
	const empty = harness({ empty: true });
	assert.equal((await runPostgresCompleteTextNoFetchRecoveryV389(urls, limits, empty.ports)).stopReason, 'empty');
});
