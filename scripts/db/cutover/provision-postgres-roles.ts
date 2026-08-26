import postgres from 'postgres';

export const GATEWAY_SCHEMA = 'cinatoken_gateway';
export const GATEWAY_MIGRATOR_ROLE = 'cinatoken_gateway_migrator';
export const GATEWAY_RUNTIME_ROLE = 'cinatoken_gateway_runtime';
const PROVISION_LOCK_KEY = 746923552;
const DRY_RUN_ROLLBACK = new Error('cinatoken_gateway_provisioning_dry_run_rollback');

export function assertProvisioningPassword(name: string, value: string | undefined): string {
	const password = value?.trim();
	if (!password || password.length < 24) {
		throw new Error(`${name} must be at least 24 characters and provided through the environment.`);
	}
	return password;
}

function readBooleanEnv(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === 'true';
}

export async function provisionPostgresRoles(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const connectionString = env.DATABASE_URL?.trim();
	if (!connectionString) {
		throw new Error('DATABASE_URL is required for the PostgreSQL administrator connection.');
	}
	const migratorPassword = assertProvisioningPassword(
		'CINATOKEN_GATEWAY_MIGRATOR_PASSWORD',
		env.CINATOKEN_GATEWAY_MIGRATOR_PASSWORD,
	);
	const runtimePassword = assertProvisioningPassword(
		'CINATOKEN_GATEWAY_RUNTIME_PASSWORD',
		env.CINATOKEN_GATEWAY_RUNTIME_PASSWORD,
	);
	const rotatePasswords = readBooleanEnv(env.CINATOKEN_GATEWAY_ROTATE_PASSWORDS);
	const dryRun = readBooleanEnv(env.CINATOKEN_GATEWAY_DRY_RUN);

	const sql = postgres(connectionString, { max: 1, prepare: true });
	try {
		const [admin] = await sql<Array<{
			user_name: string;
			can_create_role: boolean;
			can_create_schema: boolean;
		}>>`
			SELECT current_user AS user_name,
				COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user), FALSE)
					AS can_create_role,
				has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema
		`;
		if (!admin?.can_create_role || !admin.can_create_schema) {
			throw new Error('DATABASE_URL user must have CREATEROLE and CREATE on the target database.');
		}

		try {
			await sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(${PROVISION_LOCK_KEY})`;
				const [existingSchema] = await tx<Array<{ owner_name: string }>>`
					SELECT owner.rolname AS owner_name
					FROM pg_namespace AS namespace
					JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
					WHERE namespace.nspname = ${GATEWAY_SCHEMA}
				`;
				if (existingSchema && existingSchema.owner_name !== GATEWAY_MIGRATOR_ROLE) {
					throw new Error(
						`Schema ${GATEWAY_SCHEMA} already exists with unexpected owner ${existingSchema.owner_name}.`,
					);
				}

				await tx`SELECT set_config('cinatoken_gateway.migrator_password', ${migratorPassword}, true)`;
				await tx`SELECT set_config('cinatoken_gateway.runtime_password', ${runtimePassword}, true)`;
				await tx`SELECT set_config('cinatoken_gateway.rotate_passwords', ${String(rotatePasswords)}, true)`;
				await tx.unsafe(`
					DO $cinatoken_gateway_roles$
					BEGIN
						IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${GATEWAY_MIGRATOR_ROLE}') THEN
							EXECUTE format(
								'CREATE ROLE ${GATEWAY_MIGRATOR_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
								current_setting('cinatoken_gateway.migrator_password')
							);
						ELSIF current_setting('cinatoken_gateway.rotate_passwords') = 'true' THEN
							EXECUTE format(
								'ALTER ROLE ${GATEWAY_MIGRATOR_ROLE} PASSWORD %L',
								current_setting('cinatoken_gateway.migrator_password')
							);
						END IF;

						IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${GATEWAY_RUNTIME_ROLE}') THEN
							EXECUTE format(
								'CREATE ROLE ${GATEWAY_RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
								current_setting('cinatoken_gateway.runtime_password')
							);
						ELSIF current_setting('cinatoken_gateway.rotate_passwords') = 'true' THEN
							EXECUTE format(
								'ALTER ROLE ${GATEWAY_RUNTIME_ROLE} PASSWORD %L',
								current_setting('cinatoken_gateway.runtime_password')
							);
						END IF;

						EXECUTE format(
							'GRANT CONNECT ON DATABASE %I TO ${GATEWAY_MIGRATOR_ROLE}, ${GATEWAY_RUNTIME_ROLE}',
							current_database()
						);
					END
					$cinatoken_gateway_roles$;

					-- PostgreSQL 18 grants a newly created role back to a CREATEROLE user with
					-- SET FALSE. Ownership assignment requires a temporary SET TRUE membership.
					GRANT ${GATEWAY_MIGRATOR_ROLE} TO CURRENT_USER WITH SET TRUE;
					CREATE SCHEMA IF NOT EXISTS ${GATEWAY_SCHEMA} AUTHORIZATION ${GATEWAY_MIGRATOR_ROLE};
					GRANT ${GATEWAY_MIGRATOR_ROLE} TO CURRENT_USER WITH SET FALSE;
					REVOKE ALL ON SCHEMA ${GATEWAY_SCHEMA} FROM PUBLIC;
					GRANT USAGE ON SCHEMA ${GATEWAY_SCHEMA} TO ${GATEWAY_RUNTIME_ROLE};
				`);

				const roles = await tx<Array<{
				role_name: string;
				can_login: boolean;
				is_superuser: boolean;
				can_create_database: boolean;
				can_create_role: boolean;
				can_replicate: boolean;
			}>>`
				SELECT rolname AS role_name, rolcanlogin AS can_login, rolsuper AS is_superuser,
					rolcreatedb AS can_create_database, rolcreaterole AS can_create_role,
					rolreplication AS can_replicate
				FROM pg_roles
				WHERE rolname IN (${GATEWAY_MIGRATOR_ROLE}, ${GATEWAY_RUNTIME_ROLE})
				ORDER BY rolname
			`;
				if (
				roles.length !== 2 ||
				roles.some((role) =>
					!role.can_login ||
					role.is_superuser ||
					role.can_create_database ||
					role.can_create_role ||
					role.can_replicate
				)
				) {
					throw new Error('Provisioned gateway roles do not satisfy the least-privilege contract.');
				}
				if (dryRun) throw DRY_RUN_ROLLBACK;
			});
		} catch (error) {
			if (error !== DRY_RUN_ROLLBACK) throw error;
		}

		if (dryRun) {
			console.log('PostgreSQL role provisioning dry-run passed; transaction rolled back.');
			return;
		}

		console.log(
			`PostgreSQL roles ready: schema=${GATEWAY_SCHEMA} migrator=${GATEWAY_MIGRATOR_ROLE} runtime=${GATEWAY_RUNTIME_ROLE}`,
		);
		if (rotatePasswords) console.log('Existing gateway role passwords were rotated.');
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
	provisionPostgresRoles().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
