import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	closePostgresCompleteTextNoFetchV388,
	PostgresCompleteTextNoFetchCloseCleanupUnconfirmedError,
	PostgresCompleteTextNoFetchCloseRejectedError,
} from './postgres-complete-text-no-fetch-close-v388';

const LOGIN = 'cinatoken_gateway_complete_text_platform_closer';
const CONNECTION = `postgres://${LOGIN}:synthetic@localhost:5432/synthetic?sslmode=disable`;
const GRANT = '11111111-1111-4111-8111-111111111111';
const RESOLUTION = '22222222-2222-4222-8222-222222222222';
const NONCE = '33333333-3333-4333-8333-333333333333';
const TERMINAL = '44444444-4444-4444-8444-444444444444';
const EVENT = '55555555-5555-4555-8555-555555555555';
const role = { current_role: LOGIN, session_role: LOGIN, transaction_isolation: 'read committed' };
const input = () => ({ closerConnectionString: CONNECTION,
	requestId: 'request-v388', grantId: GRANT, resolutionId: RESOLUTION, decisionNonce: NONCE });
const closed = { status: 'closed_no_fetch', requestId: 'request-v388', grantId: GRANT,
	resolutionId: RESOLUTION, terminalId: TERMINAL, eventId: EVENT, decisionNonce: NONCE,
	decisionSha256: 'a'.repeat(64), buyerChargedMicros: 0, supplierCostStatus: 'not_asserted',
	closedAt: '2026-09-26T01:00:00.000Z' };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

function factory(value: unknown, events: string[], options: {
	role?: Record<string, unknown>; afterRole?: () => void;
	commitError?: Error; closeError?: Error; commitWait?: Promise<void>; closeWait?: Promise<void>;
} = {}) {
	return (connection: string, config: { max: 1 }) => {
		assert.equal(connection, CONNECTION);
		assert.deepEqual(config, { max: 1 });
		return {
			async begin<T>(operation: (tx: { unsafe(query: string, args?: unknown[]): Promise<unknown> }) => Promise<T>) {
				events.push('begin');
				let result: T;
				try {
					result = await operation({ async unsafe(query, args) {
						if (query.includes('current_user')) {
							events.push('role'); options.afterRole?.(); return [options.role ?? role];
						}
						assert.match(query, /close_complete_text_no_fetch_v388\(\$1::uuid,\$2::uuid,\$3::uuid\)/u);
						assert.deepEqual(args, [GRANT, RESOLUTION, NONCE]);
						events.push('close-call'); return [{ value }];
					} });
				} catch (error) { events.push('rollback'); throw error; }
				events.push('commit-sent');
				await options.commitWait;
				if (options.commitError) throw options.commitError;
				events.push('commit-ack'); return result;
			},
			async end({ timeout }: { timeout: number }) {
				assert.equal(timeout, 1); events.push('end');
				await options.closeWait;
				if (options.closeError) throw options.closeError;
				events.push('end-ack');
			},
		} as unknown as PostgresDatabaseClient['raw'];
	};
}

it('does not expose a zero buyer terminal before both COMMIT and close acknowledge', async () => {
	const commit = deferred(); const end = deferred(); const events: string[] = [];
	let returned = false;
	const pending = closePostgresCompleteTextNoFetchV388(input(), factory(closed, events,
		{ commitWait: commit.promise, closeWait: end.promise })).then(value => { returned = true; return value; });
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(events, ['begin', 'role', 'close-call', 'commit-sent']);
	assert.equal(returned, false);
	commit.resolve(); await new Promise(resolve => setImmediate(resolve));
	assert.equal(events.at(-1), 'end'); assert.equal(returned, false);
	end.resolve(); const result = await pending;
	assert.equal(Object.isFrozen(result), true);
	assert.equal(result.commitAcknowledged, true); assert.equal(result.closeAcknowledged, true);
	assert.equal(result.buyerChargedMicros, 0); assert.equal(result.supplierCostStatus, 'not_asserted');
	assert.equal('supplierZeroCharge' in result, false); assert.equal('sendAuthority' in result, false);
});

it('same nonce replay returns the immutable terminal without choosing a new amount', async () => {
	const result = await closePostgresCompleteTextNoFetchV388(input(),
		factory({ ...closed, status: 'already_closed_no_fetch' }, []));
	assert.equal(result.status, 'already_closed_no_fetch');
	assert.equal(result.terminalId, TERMINAL); assert.equal(result.eventId, EVENT);
	assert.equal(result.decisionNonce, NONCE);
});

it('snapshots request, grant, resolution and nonce before awaiting database work', async () => {
	const params = input();
	const result = await closePostgresCompleteTextNoFetchV388(params,
		factory(closed, [], { afterRole() {
			params.requestId = 'mutated'; params.grantId = EVENT;
			params.resolutionId = EVENT; params.decisionNonce = EVENT;
		} }));
	assert.equal(result.requestId, 'request-v388');
	assert.equal(result.grantId, GRANT); assert.equal(result.resolutionId, RESOLUTION);
	assert.equal(result.decisionNonce, NONCE);
});

it('COMMIT uncertainty or failed connection close never returns terminal authority or retries SQL', async () => {
	for (const options of [
		{ commitError: new Error('COMMIT acknowledgement lost') },
		{ closeError: new Error('close acknowledgement lost') },
		{ commitError: new Error('COMMIT acknowledgement lost'), closeError: new Error('close acknowledgement lost') },
	]) {
		const events: string[] = [];
		await assert.rejects(closePostgresCompleteTextNoFetchV388(input(), factory(closed, events, options)), error => {
			if (options.closeError) {
				assert.ok(error instanceof PostgresCompleteTextNoFetchCloseCleanupUnconfirmedError);
				if (options.commitError) assert.ok(error.cause instanceof AggregateError);
			} else assert.equal(error, options.commitError);
			return true;
		});
		assert.equal(events.filter(x => x === 'close-call').length, 1);
		assert.ok(events.includes('end'));
	}
});

it('possible send, contradictory facts, changed holds or account epoch refuse close', async () => {
	for (const status of ['possible_send_unknown', 'fact_contradiction_unknown',
		'holds_differ', 'account_epoch_differs', 'decision_conflict', 'missing_no_fetch_resolution']) {
		const events: string[] = [];
		await assert.rejects(closePostgresCompleteTextNoFetchV388(input(), factory({ status }, events)), error => {
			assert.ok(error instanceof PostgresCompleteTextNoFetchCloseRejectedError);
			assert.equal(error.status, status); return true;
		});
		assert.deepEqual(events, ['begin', 'role', 'close-call', 'rollback', 'end', 'end-ack']);
	}
});

it('rejects wrong request identity, nonzero buyer amount and any supplier zero-cost assertion before COMMIT', async () => {
	for (const change of [
		{ requestId: 'wrong-request' }, { grantId: EVENT }, { resolutionId: EVENT }, { decisionNonce: EVENT },
		{ buyerChargedMicros: 1 }, { buyerChargedMicros: '0' }, { supplierCostStatus: 'verified_zero' },
		{ supplierCostMicros: 0 }, { supplierZeroCharge: true }, { sendAuthority: true },
		{ terminalId: 'invalid' }, { eventId: 'invalid' }, { decisionSha256: 'invalid' }, { closedAt: 'invalid' },
	]) {
		const events: string[] = [];
		await assert.rejects(closePostgresCompleteTextNoFetchV388(input(), factory({ ...closed, ...change }, events)), TypeError);
		assert.equal(events.includes('commit-sent'), false);
		assert.equal(events.at(-1), 'end-ack');
	}
});

it('requires the closer URL and a direct READ COMMITTED closer session', async () => {
	for (const url of [CONNECTION.replace('platform_closer', 'send_holder'), CONNECTION + '#fragment',
		CONNECTION.replace('sslmode=disable', 'sslmode=prefer')]) {
		await assert.rejects(closePostgresCompleteTextNoFetchV388({ ...input(), closerConnectionString: url },
			() => assert.fail('invalid URL opened connection')), TypeError);
	}
	for (const changedRole of [{ ...role, current_role: 'cinatoken_gateway_runtime' },
		{ ...role, session_role: 'cinatoken_gateway_runtime' }, { ...role, transaction_isolation: 'repeatable read' }]) {
		const events: string[] = [];
		await assert.rejects(closePostgresCompleteTextNoFetchV388(input(), factory(closed, events, { role: changedRole })), TypeError);
		assert.equal(events.includes('close-call'), false); assert.equal(events.at(-1), 'end-ack');
	}
});

it('invalid identities fail before connecting', async () => {
	for (const change of [{ requestId: '' }, { requestId: 'x'.repeat(129) },
		{ grantId: 'invalid' }, { resolutionId: 'invalid' }, { decisionNonce: 'invalid' }]) {
		await assert.rejects(closePostgresCompleteTextNoFetchV388({ ...input(), ...change },
			() => assert.fail('invalid identity opened connection')), TypeError);
	}
});
