import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	appendPostgresCompleteTextHolderFactV367,
	appendPostgresCompleteTextProviderBillFactV367,
	PostgresCompleteTextResultFactCleanupUnconfirmedError,
	PostgresCompleteTextResultFactRejectedError,
} from './postgres-complete-text-result-facts-v367';

const HOLDER_ROLE = 'cinatoken_gateway_complete_text_send_holder';
const BILL_ROLE = 'cinatoken_gateway_complete_text_provider_bill';
const HOLDER_CONNECTION = `postgres://${HOLDER_ROLE}:synthetic@localhost:5432/synthetic?sslmode=disable`;
const BILL_CONNECTION = `postgres://${BILL_ROLE}:synthetic@localhost:5432/synthetic?sslmode=disable`;
const GRANT = '77777777-7777-7777-7777-777777777777';
const RUN = '88888888-8888-8888-8888-888888888888';
const NONCE = '99999999-9999-9999-9999-999999999999';
const FACT = '66666666-6666-6666-6666-666666666666';
const SHA = 'a'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const noFetchText = '{"observation": "fetch_not_called"}';
const noFetchDigest = hash(noFetchText);
type Client = PostgresDatabaseClient['raw'];

function fakeClient(role: string, response: unknown, events: string[], opts: {
	commitFails?: boolean; closeFails?: boolean; returnedRole?: string;
	afterRole?: () => void; expectedArgs?: unknown[];
} = {}) {
	const client = {
		async begin<T>(run: (tx: {
			unsafe: (query: string, args?: unknown[]) => Promise<unknown>;
		}) => Promise<T>) {
			events.push('begin');
			const result = await run({
				async unsafe(query: string, args?: unknown[]) {
					if (query.includes('current_user')) {
						events.push('role'); opts.afterRole?.();
						return [{ current_role: opts.returnedRole ?? role,
							session_role: opts.returnedRole ?? role,
							transaction_isolation: 'read committed' }];
					}
					assert.match(query, /cinatoken_gateway\.append_complete_text_/u);
					assert.ok(args);
					if (opts.expectedArgs) assert.deepEqual(args, opts.expectedArgs);
					events.push('write');
					return [{ value: response }];
				},
			});
			if (opts.commitFails) throw new Error('COMMIT ACK unknown');
			events.push('commit');
			return result;
		},
		end({ timeout }: { timeout: number }) {
			assert.equal(timeout, 1);
			events.push('close');
			return opts.closeFails
				? Promise.reject(new Error('close ACK unknown')) : Promise.resolve();
		},
	};
	return (connection: string, options: { max: 1 }) => {
		assert.equal(connection, role === HOLDER_ROLE ? HOLDER_CONNECTION : BILL_CONNECTION);
		assert.deepEqual(options, { max: 1 });
		return client as unknown as Client;
	};
}

const holderParams = () => ({ holderConnectionString: HOLDER_CONNECTION,
	grantId: GRANT, holderRunId: RUN, expectedEpoch: 1,
	evidenceNonce: NONCE,
	evidence: { kind: 'no_fetch_attestation' as const,
		observation: 'fetch_not_called' as const } });

it('records a bounded holder fact only after COMMIT and LOGIN close ACK', async () => {
	const events: string[] = [];
	const result = await appendPostgresCompleteTextHolderFactV367(holderParams(),
		fakeClient(HOLDER_ROLE, { status: 'fact_recorded', factId: FACT,
			evidenceSha256: noFetchDigest }, events, {
			expectedArgs: [GRANT, RUN, 1, NONCE, 'no_fetch_attestation',
				noFetchText, noFetchDigest],
		}));
	assert.deepEqual(events, ['begin', 'role', 'write', 'commit', 'close']);
	assert.deepEqual(result, { status: 'fact_recorded', commitAcknowledged: true,
		sourceKind: 'holder', kind: 'no_fetch_attestation', grantId: GRANT,
		evidenceNonce: NONCE, factId: FACT, evidenceSha256: noFetchDigest });
});

it('passes an exact 18-digit bill amount to the independent provider-bill LOGIN', async () => {
	const events: string[] = [];
	const amount = '999999999999999999';
	const billText = `{"currency": "USD", "amountMicros": ${amount}, `
		+ `"providerEventId": "evt-1", "billDocumentSha256": "${SHA}", `
		+ `"providerRequestRef": "req-1"}`;
	const result = await appendPostgresCompleteTextProviderBillFactV367({
		billConnectionString: BILL_CONNECTION, grantId: GRANT, evidenceNonce: NONCE,
		evidence: { providerRequestRef: 'req-1', providerEventId: 'evt-1',
			currency: 'USD', amountMicros: amount, billDocumentSha256: SHA },
	}, fakeClient(BILL_ROLE, { status: 'already_recorded', factId: FACT,
		evidenceSha256: hash(billText) }, events, {
		expectedArgs: [GRANT, NONCE, billText, hash(billText)],
	}));
	assert.deepEqual(events, ['begin', 'role', 'write', 'commit', 'close']);
	assert.equal(result.sourceKind, 'provider_bill');
	assert.equal(result.kind, 'provider_bill');
	assert.equal(result.status, 'already_recorded');
});

it('captures nonce, run, epoch and evidence before any database await', async () => {
	const events: string[] = [];
	const params = holderParams();
	const result = await appendPostgresCompleteTextHolderFactV367(params,
		fakeClient(HOLDER_ROLE, { status: 'fact_recorded', factId: FACT,
			evidenceSha256: noFetchDigest }, events, {
			afterRole: () => {
				params.expectedEpoch = 2;
				params.evidenceNonce = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
				params.evidence = { kind: 'no_fetch_attestation',
					observation: 'fetch_not_called' };
			},
			expectedArgs: [GRANT, RUN, 1, NONCE, 'no_fetch_attestation',
				noFetchText, noFetchDigest],
		}));
	assert.equal(result.evidenceNonce, NONCE);
	assert.equal(events.at(-1), 'close');
});

it('returns no persistence claim for a lost COMMIT or close ACK', async () => {
	for (const [label, options] of [
		['commit', { commitFails: true }],
		['close', { closeFails: true }],
	] as const) {
		const events: string[] = [];
		await assert.rejects(appendPostgresCompleteTextHolderFactV367(holderParams(),
			fakeClient(HOLDER_ROLE, { status: 'fact_recorded', factId: FACT,
				evidenceSha256: noFetchDigest }, events, options)),
			label === 'close' ? PostgresCompleteTextResultFactCleanupUnconfirmedError
				: /COMMIT ACK unknown/u);
		assert.equal(events.at(-1), 'close');
	}
});

it('treats conflicting nonce and provider event statuses as acknowledged rejection', async () => {
	for (const status of ['evidence_nonce_conflict', 'provider_event_conflict',
		'send_start_required']) {
		const events: string[] = [];
		await assert.rejects(appendPostgresCompleteTextProviderBillFactV367({
			billConnectionString: BILL_CONNECTION, grantId: GRANT, evidenceNonce: NONCE,
			evidence: { providerRequestRef: 'req-1', providerEventId: 'evt-1',
				currency: 'USD', amountMicros: '0', billDocumentSha256: SHA },
		}, fakeClient(BILL_ROLE, { status }, events)), error =>
			error instanceof PostgresCompleteTextResultFactRejectedError
				&& error.status === status);
		assert.deepEqual(events, ['begin', 'role', 'write', 'commit', 'close']);
	}
});

it('denies wrong role, invalid evidence and a forged digest response', async () => {
	const roleEvents: string[] = [];
	await assert.rejects(appendPostgresCompleteTextHolderFactV367(holderParams(),
		fakeClient(HOLDER_ROLE, {}, roleEvents, { returnedRole: BILL_ROLE })), TypeError);
	assert.deepEqual(roleEvents, ['begin', 'role', 'close']);

	for (const invalid of [
		{ kind: 'provider_bill', providerRequestRef: 'req' },
		{ kind: 'no_fetch_attestation', observation: 'fetch_not_called', token: 'secret' },
		{ kind: 'transport_unknown', observation: 'transport_unknown', phase: 'charged' },
		{ kind: 'provider_zero_charge_observation', providerRequestRef: 'req',
			reportedChargeMicros: 1, signalSha256: SHA },
		{ kind: 'provider_usage', providerRequestRef: '非ASCII',
			inputTokens: 1, outputTokens: 1 },
		{ kind: 'provider_usage', providerRequestRef: 'quote"escape',
			inputTokens: 1, outputTokens: 1 },
		{ kind: 'provider_usage', providerRequestRef: 'back\\slash',
			inputTokens: 1, outputTokens: 1 },
	]) {
		let opened = false;
		await assert.rejects(appendPostgresCompleteTextHolderFactV367({
			...holderParams(), evidence: invalid as never,
		}, () => { opened = true; throw new Error('unexpected connection'); }), TypeError);
		assert.equal(opened, false);
	}

	const digestEvents: string[] = [];
	await assert.rejects(appendPostgresCompleteTextHolderFactV367(holderParams(),
		fakeClient(HOLDER_ROLE, { status: 'fact_recorded', factId: FACT,
			evidenceSha256: 'b'.repeat(64) }, digestEvents)), TypeError);
	assert.deepEqual(digestEvents, ['begin', 'role', 'write', 'commit', 'close']);
});

it('requires the bill LOGIN in the URL and preserves decimal text beyond JS safe integer', async () => {
	let opened = false;
	await assert.rejects(appendPostgresCompleteTextProviderBillFactV367({
		billConnectionString: HOLDER_CONNECTION, grantId: GRANT, evidenceNonce: NONCE,
		evidence: { providerRequestRef: 'req', providerEventId: 'evt',
			currency: 'USD', amountMicros: '0', billDocumentSha256: SHA },
	}, () => { opened = true; throw new Error('unexpected connection'); }), TypeError);
	assert.equal(opened, false);
	await assert.rejects(appendPostgresCompleteTextProviderBillFactV367({
		billConnectionString: BILL_CONNECTION, grantId: GRANT, evidenceNonce: NONCE,
		evidence: { providerRequestRef: 'req', providerEventId: 'evt',
			currency: 'USD', amountMicros: '1000000000000000000',
			billDocumentSha256: SHA },
	}, () => { opened = true; throw new Error('unexpected connection'); }), TypeError);
	assert.equal(opened, false);
});
