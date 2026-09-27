// Native workerd proof for the optional Images producer opener. No SQL or external egress.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const fixture = fileURLToPath(new URL('../src/runtime/fixtures/postgres-image-owner-workerd-fixture.ts', import.meta.url));
const bundle = await build({
	entryPoints: [fixture], bundle: true, format: 'esm', platform: 'node', target: 'es2022',
	conditions: ['workerd'], write: false, metafile: true,
});

test('Worker owner bundle selects the Postgres.js workerd implementation', () => {
	const inputs = Object.keys(bundle.metafile.inputs).map(path => path.replaceAll('\\', '/'));
	assert.ok(inputs.some(path => path.includes('/postgres/cf/src/index.js')));
	assert.ok(!inputs.some(path => path.includes('/postgres/src/index.js')));
});

test('workerd loads the owner and enforces binding and SQL LOGIN checks', { timeout: 30000 }, async () => {
	const mf = new Miniflare(convertV4MiniflareOptions({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: '2026-08-24',
		compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
		cf: false,
		outboundService: async () => { throw new Error('External network forbidden in Images owner fixture'); },
	}));
	try {
		async function scenario(name) {
			const response = await mf.dispatchFetch(`http://owner-fixture.invalid/${name}`);
			assert.equal(response.status, 200, name);
			return response.json();
		}
		assert.deepEqual(await scenario('valid'), {
			outcome: 'opened',
			created: [{ label: 'dispatch', max: 1 }, { label: 'fact', max: 1 }],
			closed: ['dispatch', 'fact'],
		});
		for (const [name, message] of [
			['missing_binding', /FACT_HYPERDRIVE connection string required/],
			['shared_binding', /must be distinct/],
			['query_override', /Invalid.*FACT_HYPERDRIVE/],
			['runtime_wrong', /runtime LOGIN role mismatch/],
		]) {
			const result = await scenario(name);
			assert.equal(result.outcome, 'rejected', name);
			assert.match(result.message, message, name);
			assert.deepEqual(result.created, [], name);
			assert.deepEqual(result.closed, [], name);
		}
		for (const name of ['producer_wrong', 'session_wrong']) {
			const result = await scenario(name);
			assert.equal(result.outcome, 'rejected', name);
			assert.match(result.message, /dispatch_producer LOGIN role mismatch/, name);
			assert.deepEqual(result.created, [{ label: 'dispatch', max: 1 }, { label: 'fact', max: 1 }], name);
			assert.deepEqual(result.closed, ['dispatch', 'fact'], name);
		}
		const uncertain = await scenario('cleanup_failure');
		assert.deepEqual(uncertain, {
			outcome: 'rejected', name: 'PostgresImageProducerCleanupUnconfirmedError',
			message: 'PostgreSQL Images producer cleanup was not confirmed',
			created: [{ label: 'dispatch', max: 1 }, { label: 'fact', max: 1 }],
			closed: ['dispatch', 'fact'],
		});
	} finally {
		await mf.dispose();
	}
});
