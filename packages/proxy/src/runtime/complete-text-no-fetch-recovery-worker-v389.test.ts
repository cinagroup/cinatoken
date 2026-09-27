import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import worker, { runNoFetchRecoveryFromBindingsV389 } from './complete-text-no-fetch-recovery-worker-v389';

function binding(user: string): Hyperdrive {
	return { connectionString: `postgres://${user}:temporary@binding.invalid/db`, host: 'binding.invalid',
		port: 5432, user, password: 'temporary', database: 'db', connect() { throw new Error('no socket expected'); } };
}
const env: CompleteTextNoFetchRecoveryV389Env = {
	COMPLETE_TEXT_NO_FETCH_RECOVERY_ENABLED: 'reviewed-v1',
	COMPLETE_TEXT_RECOVERY_WORKER: binding('transport-worker'),
	COMPLETE_TEXT_RECOVERY_OBSERVER: binding('transport-observer'),
	COMPLETE_TEXT_NO_FETCH_RESOLVER: binding('transport-resolver'),
	COMPLETE_TEXT_PLATFORM_CLOSER: binding('transport-closer'),
};

test('scheduled recovery defaults off and exposes no HTTP financial action', async () => {
	let calls = 0;
	const result = await runNoFetchRecoveryFromBindingsV389({ cron: '* * * * *' }, {}, async () => {
		calls++; throw new Error('disabled invocation must not open SQL');
	});
	assert.deepEqual(result, { stopReason: 'disabled' }); assert.equal(calls, 0);
	const response = worker.fetch(); assert.equal(response.status, 404);
	assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('scheduled composition captures all four role transports and passes the bounded durable runner', async () => {
	let calls = 0;
	const result = await runNoFetchRecoveryFromBindingsV389({ cron: '* * * * *' }, env, async (urls, options, ports) => {
		calls++; assert.equal(options, undefined); assert.equal(typeof ports?.sqlFactory, 'function');
		assert.equal(new URL(urls.workerConnectionString).username, 'cinatoken_gateway_complete_text_recovery_worker');
		assert.equal(new URL(urls.observerConnectionString).username, 'cinatoken_gateway_complete_text_recovery_observer');
		assert.equal(new URL(urls.resolverConnectionString).username, 'cinatoken_gateway_complete_text_no_fetch_resolver');
		assert.equal(new URL(urls.closerConnectionString).username, 'cinatoken_gateway_complete_text_platform_closer');
		return { enqueued: 0, claimed: 0, completed: 0, retryScheduled: 0, quarantined: 0, stopReason: 'empty' };
	});
	assert.equal(calls, 1); assert.equal(result.stopReason, 'empty');
});

test('unexpected authority, wrong schedule, missing bindings and shared credentials reject', async () => {
	const forbidden = { ...env, PROVIDER_KEY_ENCRYPTION_SECRET: 'must-not-be-here' };
	await assert.rejects(runNoFetchRecoveryFromBindingsV389({ cron: '* * * * *' }, forbidden), /unexpected authority/u);
	await assert.rejects(runNoFetchRecoveryFromBindingsV389({ cron: '0 * * * *' }, env), /schedule invalid/u);
	await assert.rejects(runNoFetchRecoveryFromBindingsV389({ cron: '* * * * *' }, {
		COMPLETE_TEXT_NO_FETCH_RECOVERY_ENABLED: 'reviewed-v1' }), /four distinct/u);
	await assert.rejects(runNoFetchRecoveryFromBindingsV389({ cron: '* * * * *' }, {
		...env, COMPLETE_TEXT_PLATFORM_CLOSER: env.COMPLETE_TEXT_RECOVERY_WORKER }), /four distinct/u);
});

test('scheduled work is owned by waitUntil and shipped config is disabled with isolated bindings', async () => {
	const promises: Promise<unknown>[] = [];
	worker.scheduled({ cron: '* * * * *' } as ScheduledController,
		{ ...env, COMPLETE_TEXT_NO_FETCH_RECOVERY_ENABLED: 'disabled' },
		{ waitUntil(promise: Promise<unknown>) { promises.push(promise); } } as ExecutionContext);
	assert.equal(promises.length, 1); await promises[0];
	const config = JSON.parse(readFileSync(new URL('../../wrangler.complete-text-no-fetch-recovery-v389.jsonc', import.meta.url), 'utf8'));
	assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false); assert.deepEqual(config.routes, []);
	assert.deepEqual(config.triggers.crons, ['* * * * *']);
	assert.equal(config.vars.COMPLETE_TEXT_NO_FETCH_RECOVERY_ENABLED, 'disabled');
	assert.equal(config.hyperdrive.length, 4); assert.equal(config.secrets, undefined); assert.equal(config.queues, undefined);
	assert.equal(config.services, undefined); assert.equal(config.d1_databases, undefined);
});
