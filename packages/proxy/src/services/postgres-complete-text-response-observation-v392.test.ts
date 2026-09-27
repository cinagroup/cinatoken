import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import { appendPostgresCompleteTextResponseObservationV392, PostgresResponseObservationCleanupUnconfirmedV392 } from './postgres-complete-text-response-observation-v392';
import { canonicalResponseObservationV392, responseObservationNonceV392, type CompleteTextResponseObservationV392 } from './complete-text-response-observation-v392';

const role = 'cinatoken_gateway_complete_text_send_holder';
const identity = { grantId: randomUUID(), holderRunId: randomUUID(), sendStartId: randomUUID(), expectedEpoch: 1 as const };
const observation: CompleteTextResponseObservationV392 = { format: 'json', endMarker: 'json_eof', rawResponseBytes: 1, rawResponseSha256: 'a'.repeat(64),
	providerRequestRef: 'response-local', reportedModel: 'model-local', httpRequestId: null, serviceTier: null,
	inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
	audioInputTokens: null, imageInputTokens: null, textInputTokens: null, audioOutputTokens: null, textOutputTokens: null,
	acceptedPredictionTokens: null, rejectedPredictionTokens: null };
const input = { ...identity, evidenceNonce: responseObservationNonceV392(identity.grantId, identity.holderRunId, identity.sendStartId),
	holderConnectionString: `postgres://${role}:synthetic@localhost:5432/local?sslmode=disable`, observation };
const receipt = { status: 'observation_recorded', requestId: 'request-local', grantId: identity.grantId,
	holderRunId: identity.holderRunId, sendStartId: identity.sendStartId, evidenceNonce: input.evidenceNonce,
	observationId: randomUUID(), factId: randomUUID(), observationSha256: canonicalResponseObservationV392(observation).digest };
function factory(events: string[], options: { row?: unknown; role?: string; commit?: Promise<void>; end?: Promise<void>; commitError?: Error; closeError?: Error } = {}) {
	return () => ({ async begin<T>(fn: (tx: { unsafe(q: string): Promise<unknown> }) => Promise<T>) {
		let result: T;
		try { result = await fn({ async unsafe(q) {
			if (q.includes('current_user')) return [{ current_role: options.role ?? role, session_role: role, transaction_isolation: 'read committed' }];
			if (q.startsWith('SET LOCAL')) { events.push(q); return []; }
			events.push('append'); return [{ value: options.row ?? receipt }];
		} }); } catch (error) { events.push('rollback'); throw error; }
		events.push('commit'); await options.commit; if (options.commitError) throw options.commitError; return result;
	}, async end() { events.push('end'); await options.end; if (options.closeError) throw options.closeError; events.push('closed'); } }) as unknown as PostgresDatabaseClient['raw'];
}
test('receipt stays private until COMMIT and close acknowledge with explicit transaction bounds', async () => {
	let commit!: () => void, end!: () => void; const events: string[] = [];
	const a = new Promise<void>(yes => { commit = yes; }), b = new Promise<void>(yes => { end = yes; }); let returned = false;
	const pending = appendPostgresCompleteTextResponseObservationV392(input, factory(events, { commit: a, end: b })).then(x => { returned = true; return x; });
	await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false); assert.equal(events.at(-1), 'commit');
	commit(); await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false); assert.equal(events.at(-1), 'end');
	end(); const result = await pending; assert.equal(result.commitAcknowledged, true); assert.equal(result.closeAcknowledged, true);
	assert.deepEqual(events.slice(0, 2), ["SET LOCAL lock_timeout='2s'", "SET LOCAL statement_timeout='15s'"]);
});
test('incorrect role rejects before append and malformed receipt rolls transaction back', async () => {
	const events: string[] = []; await assert.rejects(appendPostgresCompleteTextResponseObservationV392(input, factory(events, { role: 'wrong' })), /mismatch/u); assert.equal(events.includes('append'), false);
	for (const row of [{ ...receipt, supplierCostMicros: 0 }, { ...receipt, observationSha256: 'b'.repeat(64) }, { ...receipt, grantId: randomUUID() }]) {
		const log: string[] = []; await assert.rejects(appendPostgresCompleteTextResponseObservationV392(input, factory(log, { row })), /receipt invalid/u);
		assert.ok(log.includes('rollback')); assert.equal(log.includes('commit'), false); assert.ok(log.includes('closed'));
	}
});
test('unknown COMMIT or close never retries and cleanup has the Worker diagnostic name', async () => {
	for (const options of [{ commitError: new Error('lost COMMIT') }, { closeError: new Error('lost close') }]) {
		const events: string[] = [];
		await assert.rejects(appendPostgresCompleteTextResponseObservationV392(input, factory(events, options)), error => {
			if (options.closeError) { assert.ok(error instanceof PostgresResponseObservationCleanupUnconfirmedV392); assert.match(error.name, /CleanupUnconfirmed/u); }
			return true;
		}); assert.equal(events.filter(x => x === 'append').length, 1); assert.ok(events.includes('end'));
	}
});
test('deterministic nonce rejects a caller nonce and replay preserves returned fact identity', async () => {
	await assert.rejects(appendPostgresCompleteTextResponseObservationV392({ ...input, evidenceNonce: randomUUID() }, factory([])), /identity invalid/u);
	const result = await appendPostgresCompleteTextResponseObservationV392(input, factory([], { row: { ...receipt, status: 'already_recorded' } }));
	assert.equal(result.factId, receipt.factId); assert.equal(result.evidenceNonce, input.evidenceNonce);
});
