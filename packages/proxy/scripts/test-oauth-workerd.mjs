// No cloud resources or real credentials. Bundle in memory; block all Worker egress.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const fixture = fileURLToPath(new URL('../src/services/egress/fixtures/oauth-workerd-fixture.ts', import.meta.url));
const bundle = await build({ entryPoints: [fixture], bundle: true, format: 'esm', platform: 'browser', write: false });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const account = JSON.stringify({ type: 'service_account', client_email: 'fixture@example.invalid', private_key: privateKey });
const smoke = process.argv.includes('--runtime-smoke');
const mf = new Miniflare(convertV4MiniflareOptions({
	script: smoke ? 'export default { fetch() { return new Response("runtime-ready"); } }' : bundle.outputFiles[0].text,
	modules: true, compatibilityDate: '2026-08-24',
	compatibilityFlags: ['nodejs_compat', 'enable_request_signal'], cf: false,
	outboundService: async () => { throw new Error('External network forbidden in OAuth fixture'); },
}));
async function run(mode) {
	const response = await mf.dispatchFetch(`http://oauth-fixture.invalid/${mode}`, { headers: { 'X-Synthetic-Account': account } });
	assert.equal(response.status, 200);
	return response.json();
}
try {
	if (smoke) {
		assert.equal(await (await mf.dispatchFetch('http://oauth-fixture.invalid/')).text(), 'runtime-ready');
		console.log('workerd runtime smoke passed.');
	} else {
	const success = await run('success');
	assert.deepEqual(success, { outcome: 'success', tokenMatches: true, calls: 1, aborted: false });
	const timeout = await run('timeout');
	assert.deepEqual(timeout, { outcome: 'timeout', calls: 1, cancelled: 1, locked: false, aborted: true });
	const oversized = await run('overflow');
	assert.deepEqual(oversized, { outcome: 'response_too_large', calls: 1, cancelled: 1, locked: false, aborted: false });
	const [cancelled, independent] = await Promise.all([run('cancel'), run('success')]);
	assert.equal(cancelled.outcome, 'cancelled');
	assert.equal(cancelled.calls, 1);
	assert.equal(cancelled.aborted, true);
	assert.deepEqual(independent, { outcome: 'success', tokenMatches: true, calls: 1, aborted: false });
	console.log('OAuth workerd: 5 scenarios passed; external egress disabled.');
	}
} finally {
	await mf.dispose();
}
