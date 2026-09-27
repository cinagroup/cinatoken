import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	claimPostgresCompleteTextCustodyV365,
	recordPostgresCompleteTextSendStartV365,
	PostgresCompleteTextSendStartCleanupUnconfirmedError,
	PostgresCompleteTextSendStartRejectedError,
} from './postgres-complete-text-send-start-v365';

const CONNECTION = 'postgres://cinatoken_gateway_complete_text_send_holder:synthetic@localhost:5432/synthetic?sslmode=disable';
const GRANT_ID = '77777777-7777-7777-7777-777777777777';
const RUN_ID = '88888888-8888-8888-8888-888888888888';
const START_ID = '66666666-6666-6666-6666-666666666666';
const UPLOAD_SHA = 'a'.repeat(64);
const now = Date.parse('2026-09-25T12:00:00.000Z');
const later = new Date(now + 30_000).toISOString();
const roleRow = {
	current_role: 'cinatoken_gateway_complete_text_send_holder',
	session_role: 'cinatoken_gateway_complete_text_send_holder',
	transaction_isolation: 'read committed',
};

type Client = PostgresDatabaseClient['raw'];
function fakeClient(value: unknown, events: string[], opts: {
	commitFails?: boolean; closeFails?: boolean; role?: Record<string, unknown>;
	afterRole?: () => void; afterClose?: () => void; expectedWriteArgs?: unknown[];
} = {}) {
	const client = {
		async begin<T>(run: (tx: { unsafe: (query: string, args?: unknown[]) => Promise<unknown> }) => Promise<T>) {
			events.push('begin');
			const result = await run({
				async unsafe(query: string, args?: unknown[]) {
					if (query.includes('current_user')) {
						events.push('role'); opts.afterRole?.(); return [opts.role ?? roleRow];
					}
					assert.ok(query.includes('cinatoken_gateway.'));
					assert.ok(args && args.length >= 2);
					if (opts.expectedWriteArgs) assert.deepEqual(args, opts.expectedWriteArgs);
					events.push('write');
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
			opts.afterClose?.();
			return opts.closeFails
				? Promise.reject(new Error('close ACK unknown')) : Promise.resolve();
		},
	};
	return (_connection: string, config: { max: 1 }) => {
		assert.equal(_connection, CONNECTION);
		assert.deepEqual(config, { max: 1 });
		return client as unknown as Client;
	};
}

it('returns fresh custody and send-start receipts only after separate COMMIT and close acknowledgments', async () => {
	const custodyEvents: string[] = [];
	const custody = await claimPostgresCompleteTextCustodyV365({
		holderConnectionString: CONNECTION, grantId: GRANT_ID, holderRunId: RUN_ID,
		nowMs: () => now,
	}, fakeClient({
		status: 'custody_claim_recorded', grantId: GRANT_ID, holderRunId: RUN_ID,
		leaseEpoch: 1, leaseUntil: later,
	}, custodyEvents));
	assert.deepEqual(custodyEvents, ['begin', 'role', 'write', 'commit', 'close']);
	assert.equal(custody.commitAcknowledged, true);
	assert.equal(custody.leaseEpoch, 1);

	const startEvents: string[] = [];
	const start = await recordPostgresCompleteTextSendStartV365({
		holderConnectionString: CONNECTION, grantId: GRANT_ID, holderRunId: RUN_ID,
		expectedEpoch: 1, uploadSha256: UPLOAD_SHA, nowMs: () => now,
	}, fakeClient({
		status: 'start_recorded', sendStartId: START_ID,
		grantId: GRANT_ID, holderRunId: RUN_ID, leaseEpoch: 1,
		uploadSha256: UPLOAD_SHA, expiresAt: later,
	}, startEvents));
	assert.deepEqual(startEvents, ['begin', 'role', 'write', 'commit', 'close']);
	assert.equal(start.commitAcknowledged, true);
	assert.equal(start.uploadSha256, UPLOAD_SHA);
});

it('rejects replay and mismatched results after acknowledged close', async () => {
	for (const [label, response] of [
		['replay', { status: 'already_possible_send' }],
		['wrong upload', { status: 'start_recorded', sendStartId: START_ID,
			grantId: GRANT_ID, holderRunId: RUN_ID, leaseEpoch: 1,
			uploadSha256: 'b'.repeat(64), expiresAt: later }],
	] as const) {
		const events: string[] = [];
		await assert.rejects(recordPostgresCompleteTextSendStartV365({
			holderConnectionString: CONNECTION, grantId: GRANT_ID, holderRunId: RUN_ID,
			expectedEpoch: 1, uploadSha256: UPLOAD_SHA, nowMs: () => now,
		}, fakeClient(response, events)), label === 'replay'
			? PostgresCompleteTextSendStartRejectedError : TypeError, label);
		assert.deepEqual(events, ['begin', 'role', 'write', 'commit', 'close']);
	}
});

it('rejects custody replay and expiry discovered only after connection close', async () => {
	const replayEvents: string[] = [];
	await assert.rejects(claimPostgresCompleteTextCustodyV365({
		holderConnectionString: CONNECTION, grantId: GRANT_ID, holderRunId: RUN_ID,
		nowMs: () => now,
	}, fakeClient({ status: 'already_claimed_unknown' }, replayEvents)),
	PostgresCompleteTextSendStartRejectedError);
	assert.deepEqual(replayEvents, ['begin', 'role', 'write', 'commit', 'close']);

	let observedNow = now;
	await assert.rejects(recordPostgresCompleteTextSendStartV365({
		holderConnectionString: CONNECTION, grantId: GRANT_ID, holderRunId: RUN_ID,
		expectedEpoch: 1, uploadSha256: UPLOAD_SHA, nowMs: () => observedNow,
	}, fakeClient({ status: 'start_recorded', sendStartId: START_ID,
		grantId: GRANT_ID, holderRunId: RUN_ID, leaseEpoch: 1,
		uploadSha256: UPLOAD_SHA, expiresAt: later }, [],
	{ afterClose: () => { observedNow = Date.parse(later) + 1; } })), TypeError);
});

it('uses the validated send-start epoch and upload digest captured before the DB await', async () => {
	const params = {
		holderConnectionString: CONNECTION, grantId: GRANT_ID, holderRunId: RUN_ID,
		expectedEpoch: 1, uploadSha256: UPLOAD_SHA, nowMs: () => now,
	};
	const result = await recordPostgresCompleteTextSendStartV365(params,
		fakeClient({ status: 'start_recorded', sendStartId: START_ID,
			grantId: GRANT_ID, holderRunId: RUN_ID, leaseEpoch: 1,
			uploadSha256: UPLOAD_SHA, expiresAt: later }, [], {
				afterRole: () => { params.expectedEpoch = 2; params.uploadSha256 = 'b'.repeat(64); },
				expectedWriteArgs: [GRANT_ID, RUN_ID, 1, UPLOAD_SHA],
		}));
	assert.equal(result.leaseEpoch, 1);
	assert.equal(result.uploadSha256, UPLOAD_SHA);
});

it('lost COMMIT or close ACK and wrong direct LOGIN never return send authority', async () => {
	for (const [label, opts] of [
		['commit', { commitFails: true }],
		['close', { closeFails: true }],
		['role', { role: { ...roleRow, current_role: 'cinatoken_gateway_runtime' } }],
	] as const) {
		const events: string[] = [];
		await assert.rejects(recordPostgresCompleteTextSendStartV365({
			holderConnectionString: CONNECTION, grantId: GRANT_ID, holderRunId: RUN_ID,
			expectedEpoch: 1, uploadSha256: UPLOAD_SHA, nowMs: () => now,
		}, fakeClient({ status: 'start_recorded', sendStartId: START_ID,
			grantId: GRANT_ID, holderRunId: RUN_ID, leaseEpoch: 1,
			uploadSha256: UPLOAD_SHA, expiresAt: later }, events, opts)),
		label === 'close' ? PostgresCompleteTextSendStartCleanupUnconfirmedError : Error, label);
		assert.equal(events.at(-1), 'close');
	}
});
