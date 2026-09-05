import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('Cloudflare Postgres preflight fails before authentication without Hyperdrive', () => {
	const instance = `test-missing-hyperdrive-${process.pid}`;
	const envPath = join(root, 'cloudflare-worker', `${instance}.env`);
	writeFileSync(
		envPath,
		[
			'D1_DATABASE_NAME=test',
			'D1_DATABASE_ID=11111111-2222-4333-8444-555555555555',
			'DATABASE_DRIVER=postgres',
			'',
		].join('\n'),
		'utf8',
	);
	try {
		const result = spawnSync(
			process.execPath,
			['scripts/deploy/deploy-instance.mjs', instance, '--preflight-only'],
			{ cwd: root, env: { ...process.env }, encoding: 'utf8' },
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /HYPERDRIVE_ID is required/u);
		assert.doesNotMatch(result.stdout, /wrangler whoami/u);
	} finally {
		unlinkSync(envPath);
	}
});

test('Cloudflare Batch infrastructure flag fails closed before authentication', () => {
	const instance = `test-invalid-batch-flag-${process.pid}`;
	const envPath = join(root, 'cloudflare-worker', `${instance}.env`);
	writeFileSync(
		envPath,
		[
			'D1_DATABASE_NAME=test',
			'D1_DATABASE_ID=11111111-2222-4333-8444-555555555555',
			'BATCH_INFRA_ENABLED=yes',
			'',
		].join('\n'),
		'utf8',
	);
	try {
		const result = spawnSync(
			process.execPath,
			['scripts/deploy/deploy-instance.mjs', instance, '--preflight-only'],
			{ cwd: root, env: { ...process.env }, encoding: 'utf8' },
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /BATCH_INFRA_ENABLED must be true or false/u);
		assert.doesNotMatch(result.stdout, /wrangler whoami/u);
	} finally {
		unlinkSync(envPath);
	}
});
