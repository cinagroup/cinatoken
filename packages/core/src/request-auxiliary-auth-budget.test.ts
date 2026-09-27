import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, it } from 'node:test';
import { createRequestAuxiliaryAuthBudget, RequestAuxiliaryAuthLimitError } from './request-auxiliary-auth-budget';
import { clearGcpServiceAccountTokenCache, getGcpAccessToken, GcpTokenExchangeError, resolveProviderUpstreamSecret } from './gcp-service-account-token';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const account = { type: 'service_account' as const, client_email: 'synthetic@example.invalid', private_key: privateKey };
afterEach(clearGcpServiceAccountTokenCache);

it('validates the independent auth ceiling, immutable snapshots and request isolation', () => {
	for (const n of [0, -1, 1.5, 4, Infinity, NaN]) assert.throws(() => createRequestAuxiliaryAuthBudget(n), RangeError);
	const first = createRequestAuxiliaryAuthBudget(1); const second = createRequestAuxiliaryAuthBudget();
	const snapshot = first.snapshot();
	first.consume();
	assert.throws(() => first.consume(), RequestAuxiliaryAuthLimitError);
	assert.deepEqual(snapshot, { limit: 1, exchangesStarted: 0 });
	assert.deepEqual(first.snapshot(), { limit: 1, exchangesStarted: 1 });
	assert.deepEqual(second.snapshot(), { limit: 3, exchangesStarted: 0 });
	assert.ok(Object.isFrozen(first) && Object.isFrozen(snapshot));
});

it('claims synchronously across concurrent cold exchanges and does not refund failures', async () => {
	const auxiliaryAuth = createRequestAuxiliaryAuthBudget();
	let sends = 0;
	const fetchImpl: typeof fetch = async () => { sends++; throw new Error('private transport detail'); };
	const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
		getGcpAccessToken({ ...account, client_email: `synthetic-${i}@example.invalid` }, { auxiliaryAuth, fetchImpl })));
	assert.equal(sends, 3);
	assert.deepEqual(auxiliaryAuth.snapshot(), { limit: 3, exchangesStarted: 3 });
	assert.equal(results.filter(r => r.status === 'rejected' && r.reason instanceof RequestAuxiliaryAuthLimitError).length, 17);
	assert.equal(results.filter(r => r.status === 'rejected' && r.reason instanceof GcpTokenExchangeError && r.reason.code === 'failed').length, 3);
	assert.throws(() => auxiliaryAuth.consume(), RequestAuxiliaryAuthLimitError);
});

it('cache hits and ordinary API keys need no new auth permit after exhaustion', async () => {
	const auxiliaryAuth = createRequestAuxiliaryAuthBudget(1); let sends = 0;
	const fetchImpl: typeof fetch = async () => { sends++; return Response.json({ access_token: 'synthetic-token', expires_in: 3600 }); };
	assert.equal(await getGcpAccessToken(account, { auxiliaryAuth, fetchImpl }), 'synthetic-token');
	assert.equal(await getGcpAccessToken(account, { auxiliaryAuth, fetchImpl }), 'synthetic-token');
	assert.deepEqual(await resolveProviderUpstreamSecret('synthetic-key', { auxiliaryAuth, fetchImpl }), { secret: 'synthetic-key', isServiceAccount: false });
	await assert.rejects(getGcpAccessToken({ ...account, client_email: 'different@example.invalid' }, { auxiliaryAuth, fetchImpl }), RequestAuxiliaryAuthLimitError);
	assert.equal(sends, 1);
});

it('expired cache data requires a permit again; changing identities does not reset the budget', async () => {
	const auxiliaryAuth = createRequestAuxiliaryAuthBudget(1);
	let now = Date.now(); let sends = 0;
	const fetchImpl: typeof fetch = async () => { sends++; return Response.json({ access_token: 'synthetic-token', expires_in: 3600 }); };
	const options = { auxiliaryAuth, fetchImpl, nowMs: () => now };
	await getGcpAccessToken(account, options);
	now += 3600_000;
	await assert.rejects(getGcpAccessToken(account, options), RequestAuxiliaryAuthLimitError);
	assert.equal(sends, 1);
});

it('pre-cancellation and signing failure consume no auth permits', async () => {
	const auxiliaryAuth = createRequestAuxiliaryAuthBudget();
	const fetchImpl: typeof fetch = async () => { throw new Error('Unexpected fetch'); };
	await assert.rejects(getGcpAccessToken(account, { auxiliaryAuth, fetchImpl, signal: AbortSignal.abort() }),
		(error: unknown) => error instanceof GcpTokenExchangeError && error.code === 'cancelled');
	await assert.rejects(getGcpAccessToken({ ...account, private_key: 'invalid' }, { auxiliaryAuth, fetchImpl }),
		(error: unknown) => error instanceof GcpTokenExchangeError && error.code === 'failed');
	assert.equal(auxiliaryAuth.snapshot().exchangesStarted, 0);
});

it('independent request owners do not share a consumed auth budget', async () => {
	let sends = 0;
	const fetchImpl: typeof fetch = async () => { sends++; return new Response('', { status: 503 }); };
	for (let i = 0; i < 2; i++) {
		const auxiliaryAuth = createRequestAuxiliaryAuthBudget(1);
		await assert.rejects(getGcpAccessToken(account, { auxiliaryAuth, fetchImpl }), GcpTokenExchangeError);
		assert.equal(auxiliaryAuth.snapshot().exchangesStarted, 1);
	}
	assert.equal(sends, 2);
});
