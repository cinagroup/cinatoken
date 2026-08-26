import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FACTORY_MARKER = 'postgres module did not expose a callable factory';

export async function verifyCloudflarePostgresBundle(adminDir) {
	const handlerPath = path.join(
		adminDir,
		'.open-next',
		'server-functions',
		'default',
		'packages',
		'admin',
		'handler.mjs',
	);
	const handler = await readFile(handlerPath, 'utf8');
	const driverSentinels = ['PostgresError', 'MAX_PARAMETERS_EXCEEDED', 'UNSAFE_TRANSACTION'];
	if (!handler.includes(FACTORY_MARKER) || !driverSentinels.every((sentinel) => handler.includes(sentinel))) {
		throw new Error(
			'[admin build] PostgreSQL driver is absent or empty in the OpenNext Worker.',
		);
	}

	console.log('[admin build] PostgreSQL driver is bundled in the OpenNext Worker.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await verifyCloudflarePostgresBundle(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
