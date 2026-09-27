import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	confirmPostgresCompleteTextNoFetchV370,
	PostgresCompleteTextNoFetchCleanupUnconfirmedError,
	PostgresCompleteTextNoFetchRejectedError,
} from './postgres-complete-text-no-fetch-v372';

const CONNECTION = 'postgres://cinatoken_gateway_complete_text_no_fetch_resolver:synthetic@localhost:5432/synthetic?sslmode=disable';
const GRANT_ID = '77777777-7777-7777-7777-777777777777';
const NONCE = '88888888-8888-8888-8888-888888888888';
const RESOLUTION_ID = '99999999-9999-9999-9999-999999999999';
const FENCED_AT = '2026-09-25T12:00:00.000Z';
const roleRow = {
	current_role: 'cinatoken_gateway_complete_text_no_fetch_resolver',
	session_role: 'cinatoken_gateway_complete_text_no_fetch_resolver',
	transaction_isolation: 'read committed',
};
const recorded = Object.freeze({
	status: 'verified_no_fetch_recorded', result: 'verified_no_fetch',
	grantId: GRANT_ID, resolutionId: RESOLUTION_ID, fencedAt: FENCED_AT,
});
const replay = Object.freeze({
	status: 'already_verified_no_fetch',
	grantId: GRANT_ID, resolutionId: RESOLUTION_ID, fencedAt: FENCED_AT,
});

type Client = PostgresDatabaseClient['raw'];
function fakeClient(value: unknown, events: string[], opts: {
	commitFails?: boolean; closeFails?: boolean; role?: Record<string, unknown>;
	afterRole?: () => void;
} = {}) {
	const client = {
		async begin<T>(run: (tx: {
			unsafe: (query: string, args?: unknown[]) => Promise<unknown>;
		}) => Promise<T>) {
			events.push('begin');
			const result = await run({
				async unsafe(query: string, args?: unknown[]) {
					if (query.includes('current_user')) {
						events.push('role');
						opts.afterRole?.();
						return [opts.role ?? roleRow];
					}
					assert.match(query, /resolve_complete_text_no_fetch_v370/u);
					assert.deepEqual(args, [GRANT_ID, NONCE]);
					events.push('resolve');
					return [{ value }];
				},
			});
			if (opts.commitFails) throw new Error('COMMIT ACK unknown');
			events.push('commit');
			return result;
		},
		end({ timeout }: { timeout: number }) {
			assert.equal(timeout, 1);
			events.push('close');
			return opts.closeFails ? Promise.reject(new Error('close ACK unknown'))
				: Promise.resolve();
		},
	};
	return (connection: string, config: { max: 1 }) => {
		assert.equal(connection, CONNECTION);
		assert.deepEqual(config, { max: 1 });
		return client as unknown as Client;
	};
}

const request = () => ({
	resolverConnectionString: CONNECTION,
	grantId: GRANT_ID,
	resolutionNonce: NONCE,
});

it('returns a committed no-fetch fact only after direct LOGIN COMMIT and close ACK', async () => {
	const events: string[] = [];
	const result = await confirmPostgresCompleteTextNoFetchV370(request(),
		fakeClient(recorded, events));
	assert.deepEqual(events, ['begin', 'role', 'resolve', 'commit', 'close']);
	assert.deepEqual(result, {
		status: 'verified_no_fetch_recorded',
		commitAcknowledged: true, closeAcknowledged: true,
		grantId: GRANT_ID, resolutionNonce: NONCE,
		resolutionId: RESOLUTION_ID, fencedAt: FENCED_AT,
	});
	assert.equal(Object.isFrozen(result), true);
	assert.equal('sendAuthority' in result, false);
	assert.equal('supplierZeroCharge' in result, false);
});

it('same-nonce replay can confirm the existing immutable fence after uncertain ACK', async () => {
	const events: string[] = [];
	const result = await confirmPostgresCompleteTextNoFetchV370(request(),
		fakeClient(replay, events));
	assert.deepEqual(events, ['begin', 'role', 'resolve', 'commit', 'close']);
	assert.equal(result.status, 'already_verified_no_fetch');
	assert.equal(result.resolutionId, RESOLUTION_ID);
});

it('freezes grant and nonce before the first database await', async () => {
	const params = request();
	const result = await confirmPostgresCompleteTextNoFetchV370(params,
		fakeClient(recorded, [], { afterRole: () => {
			params.grantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
			params.resolutionNonce = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
		} }));
	assert.equal(result.grantId, GRANT_ID);
	assert.equal(result.resolutionNonce, NONCE);
});

it('rejects uncertain COMMIT or close ACK without returning the fence', async () => {
	for (const [label, opts] of [
		['commit', { commitFails: true }],
		['close', { closeFails: true }],
	] as const) {
		const events: string[] = [];
		await assert.rejects(confirmPostgresCompleteTextNoFetchV370(request(),
			fakeClient(recorded, events, opts)), label === 'close'
				? PostgresCompleteTextNoFetchCleanupUnconfirmedError : Error);
		assert.equal(events.filter(x => x === 'resolve').length, 1);
		assert.equal(events.at(-1), 'close');
	}
});

it('rejects unknown or possible-send outcomes after closing the LOGIN', async () => {
	for (const status of ['send_deadline_live', 'possible_send_unknown',
		'fact_contradiction_unknown', 'resolution_conflict']) {
		const events: string[] = [];
		await assert.rejects(confirmPostgresCompleteTextNoFetchV370(request(),
			fakeClient({ status }, events)), error => {
			assert.ok(error instanceof PostgresCompleteTextNoFetchRejectedError);
			assert.equal(error.status, status);
			return true;
		});
		assert.deepEqual(events, ['begin', 'role', 'resolve', 'commit', 'close']);
	}
});

it('requires the resolver URL and direct READ COMMITTED session identity', async () => {
	for (const url of [
		CONNECTION.replace('no_fetch_resolver', 'send_holder'),
		CONNECTION + '#fragment',
		CONNECTION.replace('sslmode=disable', 'sslmode=prefer'),
	]) {
		await assert.rejects(confirmPostgresCompleteTextNoFetchV370({
			...request(), resolverConnectionString: url,
		}, () => { assert.fail('invalid URL reached factory'); }), TypeError);
	}
	const events: string[] = [];
	await assert.rejects(confirmPostgresCompleteTextNoFetchV370(request(),
		fakeClient(recorded, events, { role: { ...roleRow,
			session_role: 'cinatoken_gateway_runtime' } })), TypeError);
	assert.deepEqual(events, ['begin', 'role', 'close']);
});

it('rejects a mismatched or malformed database result after close', async () => {
	for (const value of [
		{ ...recorded, grantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
		{ ...recorded, resolutionId: 'not-a-uuid' },
		{ ...recorded, fencedAt: 'not-a-date' },
		{ ...recorded, result: 'unknown' },
		[],
	]) {
		const events: string[] = [];
		await assert.rejects(confirmPostgresCompleteTextNoFetchV370(request(),
			fakeClient(value, events)), TypeError);
		assert.equal(events.at(-1), 'close');
	}
});

it('rejects invalid IDs before opening any database connection', async () => {
	for (const params of [
		{ ...request(), grantId: 'not-a-uuid' },
		{ ...request(), resolutionNonce: 'not-a-uuid' },
	]) {
		await assert.rejects(confirmPostgresCompleteTextNoFetchV370(params,
			() => { assert.fail('invalid input reached factory'); }), TypeError);
	}
});
