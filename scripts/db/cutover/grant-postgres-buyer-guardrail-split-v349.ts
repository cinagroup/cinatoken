import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { GATEWAY_MIGRATOR_ROLE } from './provision-postgres-roles';

const policyUrl = new URL(
	'../../../packages/core/migrations-proposals/postgres/buyer-split-guardrail-runtime-grant-v349.sql',
	import.meta.url,
);

/** Review-only grant path for the exact Guardrail successor and v349 marker. */
export async function grantPostgresBuyerGuardrailSplitV349(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const connectionString = env.DATABASE_URL?.trim();
	if (!connectionString) {
		throw new Error('DATABASE_URL is required and must authenticate as the gateway migrator role.');
	}
	const policy = await readFile(policyUrl, 'utf8');
	const sql = postgres(connectionString, { max: 1, prepare: true });
	try {
		const [identity] = await sql<Array<{ user_name: string }>>`SELECT current_user AS user_name`;
		if (identity?.user_name !== GATEWAY_MIGRATOR_ROLE) {
			throw new Error(`Buyer Guardrail split grants must run as ${GATEWAY_MIGRATOR_ROLE}.`);
		}
		await sql.begin(async (tx) => {
			await tx.unsafe(policy).simple();
		});
		console.log('Buyer Guardrail split runtime grants reconciled: policy=v349');
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
	grantPostgresBuyerGuardrailSplitV349().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
