#!/usr/bin/env node
import assert from 'node:assert/strict';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const productionWebRoute = Object.freeze({
	accountId: '7ea8e46d8210bad342fa7595f7935fea',
	zoneId: 'bd42026e3facf3317ae32d55de5e2044',
	routeId: '5738534653ef46f48a44e3f3b22e5d8e',
	pattern: 'cinatoken.com/*',
	web: 'cinatoken-web',
	admin: 'cinatoken-admin',
});

/** Change only the existing frontend route after checking its owner and target deployment. */
export async function switchWebRoute({ to, expectedVersion, apply = false, token, fetchImpl = fetch }) {
	assert.ok(to === 'web' || to === 'admin', 'Use --to web or --to admin');
	assert.match(expectedVersion ?? '', /^[a-f0-9-]{36}$/, 'Expected deployed Worker version is required');
	assert.ok(token, 'CLOUDFLARE_API_TOKEN is required');
	const config = productionWebRoute;
	const target = config[to];
	const from = config[to === 'web' ? 'admin' : 'web'];
	const request = async (path, init = {}) => {
		const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
			...init,
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			signal: AbortSignal.timeout(30_000),
		});
		const json = await response.json();
		assert.equal(response.status, 200, `Cloudflare HTTP ${response.status}`);
		assert.equal(json.success, true, `Cloudflare errors: ${(json.errors ?? []).map((error) => error.code).join(',')}`);
		return json.result;
	};
	const routePath = `/zones/${config.zoneId}/workers/routes/${config.routeId}`;
	const before = await request(routePath);
	assert.equal(before.id, config.routeId);
	assert.equal(before.pattern, config.pattern);
	assert.equal(before.script, from, 'Current route owner changed; stop for review');
	assert.equal(before.request_limit_fail_open, false);
	const deployments = await request(`/accounts/${config.accountId}/workers/scripts/${target}/deployments`);
	const current = deployments.deployments[0];
	assert.equal(current?.versions.length, 1, 'Target must have one deployed version');
	assert.equal(current.versions[0].version_id, expectedVersion, 'Target deployment changed; stop for review');
	assert.equal(current.versions[0].percentage, 100);
	const plan = { at: new Date().toISOString(), apply, from, to: target, expectedVersion, before, after: null, mutation: null, secretValuesRecorded: false };
	if (apply) {
		const secondRead = await request(routePath);
		assert.equal(secondRead.script, from, 'Route changed during preflight');
		assert.equal(secondRead.pattern, config.pattern);
		assert.equal(secondRead.request_limit_fail_open, false);
		plan.mutation = await request(routePath, { method: 'PUT', body: JSON.stringify({ pattern: config.pattern, script: target }) });
		plan.after = await request(routePath);
		assert.equal(plan.after.id, config.routeId);
		assert.equal(plan.after.pattern, config.pattern);
		assert.equal(plan.after.script, target);
		assert.equal(plan.after.request_limit_fail_open, false);
	}
	plan.finishedAt = new Date().toISOString();
	return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let recordFile;
	try {
		const args = process.argv.slice(2);
		const options = {};
		for (let index = 0; index < args.length; index += 1) {
			const key = args[index];
			if (key === '--apply') {
				assert.equal(options.apply, undefined);
				options.apply = true;
				continue;
			}
			assert.ok(['--to', '--expected-version', '--record'].includes(key), `Unknown argument: ${key}`);
			assert.equal(options[key], undefined, `Duplicate argument: ${key}`);
			assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value: ${key}`);
			options[key] = args[++index];
		}
		assert.ok(options['--record'], '--record is required');
		// Reserve the receipt before any remote write; never overwrite an earlier attempt.
		recordFile = openSync(options['--record'], 'wx');
		const record = await switchWebRoute({
			to: options['--to'],
			expectedVersion: options['--expected-version'],
			apply: options.apply === true,
			token: process.env.CLOUDFLARE_API_TOKEN,
		});
		writeFileSync(recordFile, `${JSON.stringify({ ...record, actualExit: 0 }, null, 2)}\n`);
		console.log(JSON.stringify(record));
	} catch (error) {
		if (recordFile !== undefined)
			writeFileSync(
				recordFile,
				`${JSON.stringify({ at: new Date().toISOString(), actualExit: 1, error: error.message, secretValuesRecorded: false }, null, 2)}\n`,
			);
		console.error(error.message);
		process.exitCode = 1;
	} finally {
		if (recordFile !== undefined) closeSync(recordFile);
	}
}
