import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { GATEWAY_MIGRATOR_ROLE } from './provision-postgres-roles';

const proposalDir = new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url);
const activationFiles = [
	'shared-key-guardrail-post-reservation-denial-v348.sql',
	'buyer-split-guardrail-grant-marker-v349.sql',
] as const;

/** Review-only atomic successor activation after the v348 buyer split marker. */
export async function activatePostgresBuyerGuardrailSplitV349(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
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
			throw new Error(`Buyer Guardrail split activation must run as ${GATEWAY_MIGRATOR_ROLE}.`);
		}
		await sql.begin(async (tx) => {
			await tx.unsafe("SET LOCAL cinatoken.shared_key_guardrail_denial_v348_activation = 'reviewed-v1'").simple();
			await tx.unsafe("SET LOCAL cinatoken.buyer_split_guardrail_marker_activation = 'reviewed-v1'").simple();
			for (const body of bodies) {
				await tx.unsafe(body).simple();
			}
		});
		console.log('Buyer Guardrail split activated atomically: policy=v349');
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
	activatePostgresBuyerGuardrailSplitV349().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
