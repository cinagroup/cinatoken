import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { GATEWAY_MIGRATOR_ROLE } from './provision-postgres-roles';

const proposalDir = new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url);
const activationFiles = [
	'buyer-critical-writer-privilege-split-v346.sql',
	'shared-key-economic-producer-buyer-login-v347.sql',
	'buyer-split-grant-marker-v348.sql',
] as const;

/** Review-only atomic activation. Deploy the legacy grant marker guard first. */
export async function activatePostgresBuyerSplitV348(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const connectionString = env.DATABASE_URL?.trim();
	if (!connectionString) {
		throw new Error('DATABASE_URL is required and must authenticate as the gateway migrator role.');
	}
	const bodies = await Promise.all(activationFiles.map((name) =>
		readFile(new URL(name, proposalDir), 'utf8')));
	const sql = postgres(connectionString, { max: 1, prepare: true });
	try {
		const [identity] = await sql<Array<{ user_name: string }>>`SELECT current_user AS user_name`;
		if (identity?.user_name !== GATEWAY_MIGRATOR_ROLE) {
			throw new Error(`Buyer split activation must run as ${GATEWAY_MIGRATOR_ROLE}.`);
		}
		await sql.begin(async (tx) => {
			await tx.unsafe("SET LOCAL cinatoken.buyer_settlement_privilege_split = 'reviewed-v1'").simple();
			await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_buyer_login_activation = 'reviewed-v1'").simple();
			await tx.unsafe("SET LOCAL cinatoken.buyer_split_grant_marker_activation = 'reviewed-v1'").simple();
			for (const body of bodies) {
				await tx.unsafe(body).simple();
			}
		});
		console.log('Buyer split activated atomically: policy=v348');
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
	activatePostgresBuyerSplitV348().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
