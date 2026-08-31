import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('non-interactive bootstrap fails before creating resources when secrets are absent', () => {
	const instance = `test-missing-secrets-${process.pid}`;
	const envPath = join(root, 'cloudflare-worker', `${instance}.env`);
	assert.equal(existsSync(envPath), false);
	const env = { ...process.env };
	for (const name of [
		'SHARED_KEY_ENCRYPTION_SECRET',
		'CINATOKEN_OIDC_CLIENT_SECRET',
		'CINATOKEN_OIDC_BRIDGE_SECRET',
		'CINATOKEN_OIDC_TRANSACTION_SECRET',
		'CINATOKEN_IDENTITY_EVENTS_SECRET',
		'CINACHAIN_RPC_URL',
		'CINACHAIN_MINTER_PRIVATE_KEY',
		'CINABADGE_CONTRACT_ADDRESS',
		'CINACREDIT_CONTRACT_ADDRESS',
	]) {
		delete env[name];
	}
	const result = spawnSync(
		process.execPath,
		[
			'scripts/deploy/bootstrap-cloudflare.mjs',
			'--yes',
			'--instance',
			instance,
			'--prefix',
			instance,
		],
		{ cwd: root, env, encoding: 'utf8' },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /requires secret values in process environment/u);
	assert.equal(existsSync(envPath), false);
});
