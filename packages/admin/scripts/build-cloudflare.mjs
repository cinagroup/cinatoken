import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCloudflarePostgresBundle } from './verify-cloudflare-postgres-bundle.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(
	scriptDir,
	'../../../node_modules/@opennextjs/cloudflare/dist/cli/index.js',
);
const child = spawn(process.execPath, [cli, 'build'], {
	cwd: path.resolve(scriptDir, '..'),
	stdio: 'inherit',
	env: { ...process.env, CINATOKEN_CLOUDFLARE_BUILD: '1' },
});

child.once('error', (error) => {
	console.error(error);
	process.exitCode = 1;
});
child.once('exit', async (code, signal) => {
	if (signal) {
		console.error(`OpenNext terminated by ${signal}`);
		process.exitCode = 1;
		return;
	}
	if ((code ?? 1) !== 0) {
		process.exitCode = code ?? 1;
		return;
	}
	try {
		await verifyCloudflarePostgresBundle(path.resolve(scriptDir, '..'));
		process.exitCode = 0;
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
});
