import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import type { FinalChatQuoteInput } from './chat-final-quote-input';
import {
	issuePostgresCompleteChatQuoteV360,
	PostgresCompleteChatQuoteCleanupUnconfirmedError,
} from './postgres-complete-chat-quote-v360';

const REQUEST_ID = 'request-complete-quote';
const ORIGINAL_SHA = 'a'.repeat(64);
const CAPABILITY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaabbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const QUOTE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const BODY = JSON.stringify({ model: 'model-a', models: ['model-a', 'model-b'],
	messages: [{ role: 'user', content: 'hello' }] });
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

const input: FinalChatQuoteInput = Object.freeze({
	requestId: REQUEST_ID,
	originalBodySha256: ORIGINAL_SHA,
	finalBodyUtf8: BODY,
	finalBodySha256: sha(BODY),
	modelIds: Object.freeze(['model-a', 'model-b']),
	assertCurrent() {},
});
const identity = Object.freeze({ apiKeyId: 'key-a', userId: 'user-a', workspaceId: 'workspace-a',
	budgetEpoch: 2, keyLimitEpoch: 3 });
const expiresAt = new Date(Date.now() + 60_000).toISOString();

type Call = { query: string; params?: unknown[] };
function harness(options: {
	capabilityRole?: string;
	quoteRole?: string;
	capabilityCloseFails?: boolean;
	quoteValue?: unknown;
} = {}) {
	const events: string[] = [];
	const calls: Record<'runtime' | 'capability' | 'quote', Call[]> = {
		runtime: [], capability: [], quote: [],
	};
	const issued = { status: 'issued', requestId: REQUEST_ID, capability: CAPABILITY,
		apiKeyId: identity.apiKeyId, userId: identity.userId, workspaceId: identity.workspaceId,
		budgetEpoch: identity.budgetEpoch, keyLimitEpoch: identity.keyLimitEpoch, expiresAt };
	const quoted = options.quoteValue ?? { status: 'quoted_complete_subset', quoteId: QUOTE_ID,
		requestId: REQUEST_ID, finalBodySha256: input.finalBodySha256,
		modelIds: [...input.modelIds], routeCount: 3, credentialClass: 'platform',
		maxPerAttemptCeilingMicros: 12_000, threeAttemptCeilingMicros: 36_000, expiresAt };
	function client(kind: 'runtime' | 'capability' | 'quote') {
		const role = kind === 'runtime' ? 'cinatoken_gateway_runtime'
			: kind === 'capability' ? options.capabilityRole ?? 'cinatoken_gateway_request_capability_issuer'
				: options.quoteRole ?? 'cinatoken_gateway_complete_text_quote_issuer';
		return {
			async unsafe(query: string, params?: unknown[]) {
				calls[kind].push({ query, params });
				if (query.startsWith('SELECT current_user')) {
					return [{ current_role: role, session_role: role }];
				}
				if (query.includes('issue_request_capability_v356')) return [{ value: issued }];
				if (query.includes('issue_complete_flat_text_quote_v360')) return [{ value: quoted }];
				throw new Error('Unexpected SQL');
			},
			async begin<T>(callback: (tx: unknown) => Promise<T>) {
				events.push(`${kind}:begin`);
				const result = await callback(this);
				events.push(`${kind}:commit`);
				return result;
			},
			async end() {
				events.push(`${kind}:close`);
				if (kind === 'capability' && options.capabilityCloseFails) throw new Error('ACK lost');
			},
		};
	}
	const runtime = client('runtime');
	const run = () => issuePostgresCompleteChatQuoteV360({
		runtimeClient: { driver: 'postgres', raw: runtime } as unknown as PostgresDatabaseClient,
		runtimeConnectionString: 'postgres://runtime:secret@localhost/gateway',
		capabilityConnectionString: 'postgres://capability:secret@localhost/gateway',
		quoteConnectionString: 'postgres://quote:secret@localhost/gateway',
		bearer: 'sk-cina-authenticated-client-token', identity, finalQuoteInput: input,
	}, {
		capability: () => { events.push('capability:open'); return client('capability') as unknown as PostgresDatabaseClient['raw']; },
		quote: () => { events.push('quote:open'); return client('quote') as unknown as PostgresDatabaseClient['raw']; },
	});
	return { run, events, calls };
}

it('issues v356 from the actual bearer, then v360 from final bytes through separate direct LOGINs', async () => {
	const h = harness();
	const quote = await h.run();
	assert.equal(quote.quoteId, QUOTE_ID);
	assert.equal(quote.threeAttemptCeilingMicros, 36_000);
	assert.deepEqual(quote.modelIds, ['model-a', 'model-b']);
	assert.deepEqual(h.events, ['capability:open', 'capability:begin', 'capability:commit',
		'capability:close', 'quote:open', 'quote:begin', 'quote:commit', 'quote:close']);
	assert.deepEqual(h.calls.capability[1]?.params,
		[REQUEST_ID, 'sk-cina-authenticated-client-token', ORIGINAL_SHA]);
	assert.deepEqual(h.calls.quote[1]?.params, [REQUEST_ID, CAPABILITY, ORIGINAL_SHA, BODY]);
	assert.equal(h.calls.quote.some(call => call.params?.some(value => typeof value === 'number')), false,
		'caller never supplies an amount or route list');
});

it('rejects a LOGIN mismatch before capability issue and closes that client', async () => {
	const h = harness({ capabilityRole: 'cinatoken_gateway_runtime' });
	await assert.rejects(h.run(), /LOGIN mismatch/);
	assert.equal(h.calls.capability.length, 1);
	assert.equal(h.calls.quote.length, 0);
	assert.deepEqual(h.events, ['capability:open', 'capability:begin', 'capability:close']);
});

it('never issues a quote after an uncertain capability client cleanup', async () => {
	const h = harness({ capabilityCloseFails: true });
	await assert.rejects(h.run(), PostgresCompleteChatQuoteCleanupUnconfirmedError);
	assert.equal(h.calls.quote.length, 0);
	assert.equal(h.events.includes('quote:open'), false);
});

it('rejects a quoted amount that is one micro below the complete three-attempt hold', async () => {
	const h = harness({ quoteValue: { status: 'quoted_complete_subset', quoteId: QUOTE_ID,
		requestId: REQUEST_ID, finalBodySha256: input.finalBodySha256,
		modelIds: [...input.modelIds], routeCount: 3, credentialClass: 'platform',
		maxPerAttemptCeilingMicros: 12_000, threeAttemptCeilingMicros: 35_999, expiresAt } });
	await assert.rejects(h.run(), /response differs from final request/);
	assert.equal(h.events.at(-1), 'quote:close');
});

it('rejects a mismatched candidate list even when the amount is otherwise valid', async () => {
	const h = harness({ quoteValue: { status: 'quoted_complete_subset', quoteId: QUOTE_ID,
		requestId: REQUEST_ID, finalBodySha256: input.finalBodySha256,
		modelIds: ['model-a'], routeCount: 3, credentialClass: 'platform',
		maxPerAttemptCeilingMicros: 12_000, threeAttemptCeilingMicros: 36_000, expiresAt } });
	await assert.rejects(h.run(), /response differs from final request/);
});
