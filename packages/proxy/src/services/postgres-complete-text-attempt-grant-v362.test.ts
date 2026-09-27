import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import type { TextGrantClaimRequestV361 } from './chat-text-grant-egress-contract-v361';
import {
	grantPostgresCompleteTextAttemptV362,
	PostgresCompleteTextAttemptGrantCleanupUnconfirmedError,
	PostgresCompleteTextAttemptGrantRejectedError,
} from './postgres-complete-text-attempt-grant-v362';

const nonce = '11111111-1111-4111-8111-111111111111';
const claim: TextGrantClaimRequestV361 = Object.freeze({
	requestId: 'request-v362', quoteId: '22222222-2222-4222-8222-222222222222',
	finalBodySha256: 'a'.repeat(64), candidateIndex: 0,
	modelId: 'model-a', routeTargetId: 'target-a', providerId: 'provider-a',
	endpointId: 'endpoint-a', credentialClass: 'platform',
	credentialId: 'provider-a', providerCiphertextSha256: 'b'.repeat(64),
	preparedRouteSourceSha256: 'c'.repeat(64), method: 'POST',
	upstreamUrlSha256: 'd'.repeat(64), outboundBodySha256: 'e'.repeat(64),
	outboundBodyCanonicalSha256: 'f'.repeat(64), outboundBodyBytes: 1024,
	credentialFingerprintSha256: '0'.repeat(64),
});
const grantId = '33333333-3333-4333-8333-333333333333';
const future = new Date(Date.now() + 30_000).toISOString();
const recovery = new Date(Date.now() + 15 * 60_000).toISOString();
const recorded = Object.freeze({
	...claim, status: 'grant_recorded', grantId, attemptNumber: 1,
	manifestSourceGeneration: 2, currentSourceGeneration: 2,
	manifestAttestedSourceSha256: '1'.repeat(64),
	currentAttestedSourceSha256: '1'.repeat(64),
	manifestSourceSha256: '2'.repeat(64), expiresAt: future,
	holdRecoveryExpiresAt: recovery,
});

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function harness(options: {
	role?: string;
	value?: unknown;
	commitAck?: ReturnType<typeof deferred>;
	closeAck?: ReturnType<typeof deferred>;
	nowMs?: () => number;
} = {}) {
	const events: string[] = [];
	const calls: Array<{ query: string; params?: unknown[] }> = [];
	const sql = {
		json(value: unknown) { return value; },
		async unsafe(query: string, params?: unknown[]) {
			calls.push({ query, params });
			if (query.startsWith('SELECT current_user')) {
				const role = options.role ?? 'cinatoken_gateway_complete_text_attempt_granter';
				return [{ current_role: role, session_role: role,
					transaction_isolation: 'read committed', claim_type: 'object',
					nonce_present: true }];
			}
			if (query.includes('grant_complete_flat_text_attempt_v362')) {
				return [{ value: options.value ?? recorded }];
			}
			throw new Error('Unexpected SQL');
		},
		async begin<T>(callback: (tx: unknown) => Promise<T>) {
			events.push('begin');
			try {
				const value = await callback(this);
				await options.commitAck?.promise;
				events.push('commit-ack');
				return value;
			} catch (error) {
				events.push('rollback-or-commit-unknown');
				throw error;
			}
		},
		end() {
			events.push('close-start');
			return options.closeAck?.promise ?? Promise.resolve();
		},
	};
	const run = (input = claim) => grantPostgresCompleteTextAttemptV362({
		granterConnectionString: 'postgres://granter:secret@localhost/gateway',
		attemptNonce: nonce, claim: input, nowMs: options.nowMs,
	}, () => sql as unknown as PostgresDatabaseClient['raw']);
	return { run, calls, events };
}

it('returns authority only after the direct LOGIN, COMMIT and client-close acknowledgements', async () => {
	const commitAck = deferred();
	const closeAck = deferred();
	const h = harness({ commitAck, closeAck });
	let settled = false;
	const pending = h.run().then(value => { settled = true; return value; });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.events, ['begin']);
	assert.equal(settled, false);
	commitAck.resolve();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.events, ['begin', 'commit-ack', 'close-start']);
	assert.equal(settled, false);
	closeAck.resolve();
	const grant = await pending;
	assert.equal(grant.status, 'committed');
	assert.equal(grant.commitAcknowledged, true);
	assert.equal(grant.grantId, grantId);
	assert.equal(grant.holdRecoveryExpiresAt, recovery);
	assert.deepEqual(h.calls[1]?.params, [nonce, claim]);
	assert.deepEqual(h.events, ['begin', 'commit-ack', 'close-start']);
});

it('rejects uncertain COMMIT or close ACK after the grant function recorded a row', async () => {
	const commitAck = deferred();
	const h1 = harness({ commitAck });
	const first = h1.run();
	await new Promise(resolve => setTimeout(resolve, 0));
	commitAck.reject(new Error('COMMIT ACK lost'));
	await assert.rejects(first, /COMMIT ACK lost/);
	assert.deepEqual(h1.events, ['begin', 'rollback-or-commit-unknown', 'close-start']);
	const closeAck = deferred();
	const h2 = harness({ closeAck });
	const second = h2.run();
	await new Promise(resolve => setTimeout(resolve, 0));
	closeAck.reject(new Error('close ACK lost'));
	await assert.rejects(second, PostgresCompleteTextAttemptGrantCleanupUnconfirmedError);
	assert.deepEqual(h2.events, ['begin', 'commit-ack', 'close-start']);
});

it('rejects replay, tampered wire identity and wrong LOGIN before a fetch receipt exists', async () => {
	const replay = harness({ value: { status: 'already_recorded_unknown' } });
	await assert.rejects(replay.run(), error => error instanceof
		PostgresCompleteTextAttemptGrantRejectedError
		&& error.status === 'already_recorded_unknown');
	const tampered = harness({ value: { ...recorded, outboundBodySha256: '9'.repeat(64) } });
	await assert.rejects(tampered.run(), /differs from prepared wire/);
	const wrongRole = harness({ role: 'cinatoken_gateway_runtime' });
	await assert.rejects(wrongRole.run(), /call preflight mismatch/);
	assert.equal(wrongRole.calls.length, 1);
});

it('rejects an expired post-ACK grant and malformed claims before opening a connection', async () => {
	let checked = false;
	const expired = harness({ nowMs: () => {
		if (checked) return Date.parse(future) + 1;
		checked = true;
		return Date.parse(future) - 1;
	} });
	await assert.rejects(expired.run(), error => error instanceof
		PostgresCompleteTextAttemptGrantRejectedError
		&& error.status === 'expired_after_ack');
	assert.deepEqual(expired.events, ['begin', 'commit-ack', 'close-start']);
	const invalid = harness();
	await assert.rejects(invalid.run({ ...claim, outboundBodyBytes: 2_097_153 }),
		/attempt claim invalid/);
	assert.equal(invalid.events.length, 0);
});

it('serializes a validated primitive snapshot instead of an inherited toJSON result', async () => {
	const input = Object.assign(Object.create({ toJSON: () => ({ forged: true }) }), claim) as
		TextGrantClaimRequestV361;
	const h = harness();
	const receipt = await h.run(input);
	assert.equal(receipt.grantId, grantId);
	assert.deepEqual(h.calls[1]?.params, [nonce, claim]);
});
