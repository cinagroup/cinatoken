import postgres from 'postgres';
import { assertProvisioningPassword, GATEWAY_MIGRATOR_ROLE, GATEWAY_SCHEMA } from './provision-postgres-roles';

export const PRODUCER_LOGIN_ACTIVATION = 'reviewed-direct-login-v1';
export const DISPATCH_PRODUCER_ROLE = 'cinatoken_gateway_dispatch_producer';
export const FACT_PRODUCER_ROLE = 'cinatoken_gateway_fact_producer';

// These locks match the review-only parent/fact grants. The final key is
// specific to this local identity transition, so concurrent role edits fail.
const PROVISION_LOCK_KEYS = [746923551, 746923553, 746923557, 746923558];
// Local evidence candidate only. A production Hyperdrive origin needs its own
// current instance-wide connection budget and compatible role limit.
const LOCAL_ROLE_CONNECTION_LIMIT = 2;
const DRY_RUN_ROLLBACK = new Error('cinatoken_gateway_producer_login_dry_run_rollback');

type ProducerEnvironment = {
  /** Deliberately ignored; the review-only provisioner never falls back to this URL. */
  DATABASE_URL?: string;
  CINATOKEN_GATEWAY_PRODUCER_ACTIVATION?: string;
  CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL?: string;
  CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD?: string;
  CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD?: string;
  CINATOKEN_GATEWAY_PRODUCER_ROTATE_PASSWORDS?: string;
  CINATOKEN_GATEWAY_PRODUCER_DRY_RUN?: string;
};

function booleanFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value.trim().toLowerCase() === 'false') return false;
  if (value.trim().toLowerCase() === 'true') return true;
  throw new Error(`${name} must be true or false.`);
}

function adminUrl(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL is required; DATABASE_URL is not used.');
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error('CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL must be a PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.username || !parsed.password || !parsed.hostname ||
      !parsed.pathname || parsed.pathname === '/') {
    throw new Error('CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL requires explicit host, user, password and database.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('This review-only producer provisioner accepts loopback PostgreSQL only.');
  }
  if (!parsed.port || parsed.search || parsed.hash) {
    throw new Error('Review-only producer administrator URL requires an explicit port and no URL options.');
  }
  return value;
}

export interface ProducerLoginProvisionResult {
  dryRun: boolean;
  rotatedExistingPasswords: boolean;
  database: string;
  roles: [typeof DISPATCH_PRODUCER_ROLE, typeof FACT_PRODUCER_ROLE];
}

/**
 * Review-only producer login provisioning. This module deliberately never reads
 * DATABASE_URL and never activates merely because credentials are present.
 */
export async function provisionPostgresProducerLogins(
  env: ProducerEnvironment = {
    CINATOKEN_GATEWAY_PRODUCER_ACTIVATION: process.env.CINATOKEN_GATEWAY_PRODUCER_ACTIVATION,
    CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL: process.env.CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL,
    CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD: process.env.CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD,
    CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD: process.env.CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD,
    CINATOKEN_GATEWAY_PRODUCER_ROTATE_PASSWORDS: process.env.CINATOKEN_GATEWAY_PRODUCER_ROTATE_PASSWORDS,
    CINATOKEN_GATEWAY_PRODUCER_DRY_RUN: process.env.CINATOKEN_GATEWAY_PRODUCER_DRY_RUN,
  },
): Promise<ProducerLoginProvisionResult> {
  if (env.CINATOKEN_GATEWAY_PRODUCER_ACTIVATION !== PRODUCER_LOGIN_ACTIVATION) {
    throw new Error(`Explicit ${PRODUCER_LOGIN_ACTIVATION} producer login activation is required.`);
  }
  const connectionString = adminUrl(env.CINATOKEN_GATEWAY_PRODUCER_ADMIN_URL);
  const dispatchPassword = assertProvisioningPassword(
    'CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD',
    env.CINATOKEN_GATEWAY_DISPATCH_PRODUCER_PASSWORD,
  );
  const factPassword = assertProvisioningPassword(
    'CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD',
    env.CINATOKEN_GATEWAY_FACT_PRODUCER_PASSWORD,
  );
  if (dispatchPassword === factPassword) {
    throw new Error('Dispatch and fact producer passwords must differ.');
  }
  const rotatePasswords = booleanFlag(
    'CINATOKEN_GATEWAY_PRODUCER_ROTATE_PASSWORDS',
    env.CINATOKEN_GATEWAY_PRODUCER_ROTATE_PASSWORDS,
  );
  const dryRun = booleanFlag(
    'CINATOKEN_GATEWAY_PRODUCER_DRY_RUN',
    env.CINATOKEN_GATEWAY_PRODUCER_DRY_RUN,
  );

  const sql = postgres(connectionString, { max: 1, prepare: true, debug: false });
  let database = '';
  try {
    try {
      await sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL lock_timeout = '2s';
          SET LOCAL statement_timeout = '10s';
          SET LOCAL transaction_timeout = '30s';
          SET LOCAL password_encryption = 'scram-sha-256';
          SET LOCAL search_path TO pg_catalog, pg_temp;`).simple();
        for (const key of PROVISION_LOCK_KEYS) {
          const [lock] = await tx<Array<{ acquired: boolean }>>`
            SELECT pg_catalog.pg_try_advisory_xact_lock(${key}) AS acquired`;
          if (!lock?.acquired) throw new Error('Concurrent producer grant or login transition is active.');
        }
        const [context] = await tx<Array<{
          database_name: string;
          is_superuser: boolean;
          can_grant_connect: boolean;
          server_version_num: number;
          schema_owner: string | null;
        }>>`
          SELECT current_database() AS database_name,
            COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles
              WHERE rolname = current_user), FALSE) AS is_superuser,
            pg_catalog.has_database_privilege(current_user, current_database(),
              'CONNECT WITH GRANT OPTION') AS can_grant_connect,
            pg_catalog.current_setting('server_version_num')::integer AS server_version_num,
            (SELECT owner.rolname FROM pg_catalog.pg_namespace n
              JOIN pg_catalog.pg_roles owner ON owner.oid = n.nspowner
              WHERE n.nspname = ${GATEWAY_SCHEMA}) AS schema_owner
        `;
        // PG18 CREATEROLE auto-grants a creator ADMIN membership in new roles.
        // Its grantor is the bootstrap superuser; the creator cannot revoke it.
        if (!context?.is_superuser || !context.can_grant_connect ||
            context.server_version_num < 170000 || context.schema_owner !== GATEWAY_MIGRATOR_ROLE) {
          throw new Error('Review-only producer login activation requires a superuser, PostgreSQL 17+ and migrator-owned gateway schema.');
        }
        database = context.database_name;

        // A role inherits PUBLIC database CONNECT. Refuse activation unless every
        // other connectable database has had that ambient capability removed.
        const otherDatabase = await tx<Array<{ datname: string }>>`
          SELECT d.datname FROM pg_catalog.pg_database d
          WHERE d.datallowconn AND d.datname <> current_database()
            AND EXISTS (
              SELECT 1 FROM pg_catalog.aclexplode(
                COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) acl
              WHERE acl.grantee = 0 AND acl.privilege_type = 'CONNECT')
          LIMIT 1
        `;
        if (otherDatabase.length) {
          throw new Error('PUBLIC CONNECT on another database must be removed before producer login activation.');
        }

        const existing = await tx<Array<{
          rolname: string;
          rolcanlogin: boolean;
          rolinherit: boolean;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolreplication: boolean;
          rolbypassrls: boolean;
          rolvaliduntil: string | null;
          has_scram_password: boolean;
        }>>`
          SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
            rolcreaterole, rolreplication, rolbypassrls, rolvaliduntil::text,
            (SELECT auth.rolpassword LIKE 'SCRAM-SHA-256$%'
              FROM pg_catalog.pg_authid auth WHERE auth.oid = role.oid)
              AS has_scram_password
          FROM pg_catalog.pg_roles role
          WHERE rolname IN (${DISPATCH_PRODUCER_ROLE}, ${FACT_PRODUCER_ROLE})
        `;
        if (existing.some(role => role.rolinherit || role.rolsuper || role.rolcreatedb ||
            role.rolcreaterole || role.rolreplication || role.rolbypassrls ||
            role.rolvaliduntil !== null)) {
          throw new Error('Existing producer role attributes differ from the direct-login contract.');
        }
        if (!rotatePasswords && existing.some(role => role.rolcanlogin &&
            role.has_scram_password !== true)) {
          throw new Error('Existing producer LOGIN lacks a SCRAM verifier; explicit password rotation is required.');
        }
        const memberships = await tx<Array<{ role_name: string }>>`
          SELECT role.rolname AS role_name
          FROM pg_catalog.pg_auth_members member
          JOIN pg_catalog.pg_roles role ON role.oid = member.roleid
          WHERE member.roleid IN (SELECT oid FROM pg_catalog.pg_roles
            WHERE rolname IN (${DISPATCH_PRODUCER_ROLE}, ${FACT_PRODUCER_ROLE}))
            OR member.member IN (SELECT oid FROM pg_catalog.pg_roles
              WHERE rolname IN (${DISPATCH_PRODUCER_ROLE}, ${FACT_PRODUCER_ROLE}))
          LIMIT 1
        `;
        if (memberships.length) {
          throw new Error('Existing producer role membership must be removed before activation.');
        }

        await tx`SELECT pg_catalog.set_config('cinatoken.dispatch_producer_password',
          ${dispatchPassword}, true)`;
        await tx`SELECT pg_catalog.set_config('cinatoken.fact_producer_password',
          ${factPassword}, true)`;
        await tx`SELECT pg_catalog.set_config('cinatoken.rotate_producer_passwords',
          ${String(rotatePasswords)}, true)`;
        await tx.unsafe(`
          DO $producer_login_provision$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                WHERE rolname = '${DISPATCH_PRODUCER_ROLE}') THEN
              EXECUTE pg_catalog.format(
                'CREATE ROLE ${DISPATCH_PRODUCER_ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${LOCAL_ROLE_CONNECTION_LIMIT} PASSWORD %L',
                pg_catalog.current_setting('cinatoken.dispatch_producer_password'));
            ELSIF NOT (SELECT rolcanlogin FROM pg_catalog.pg_roles
                WHERE rolname = '${DISPATCH_PRODUCER_ROLE}') THEN
              EXECUTE pg_catalog.format(
                'ALTER ROLE ${DISPATCH_PRODUCER_ROLE} LOGIN CONNECTION LIMIT ${LOCAL_ROLE_CONNECTION_LIMIT} PASSWORD %L',
                pg_catalog.current_setting('cinatoken.dispatch_producer_password'));
            ELSIF pg_catalog.current_setting('cinatoken.rotate_producer_passwords') = 'true' THEN
              EXECUTE pg_catalog.format(
                'ALTER ROLE ${DISPATCH_PRODUCER_ROLE} CONNECTION LIMIT ${LOCAL_ROLE_CONNECTION_LIMIT} PASSWORD %L',
                pg_catalog.current_setting('cinatoken.dispatch_producer_password'));
            ELSE
              ALTER ROLE ${DISPATCH_PRODUCER_ROLE} CONNECTION LIMIT ${LOCAL_ROLE_CONNECTION_LIMIT};
            END IF;

            IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                WHERE rolname = '${FACT_PRODUCER_ROLE}') THEN
              EXECUTE pg_catalog.format(
                'CREATE ROLE ${FACT_PRODUCER_ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${LOCAL_ROLE_CONNECTION_LIMIT} PASSWORD %L',
                pg_catalog.current_setting('cinatoken.fact_producer_password'));
            ELSIF NOT (SELECT rolcanlogin FROM pg_catalog.pg_roles
                WHERE rolname = '${FACT_PRODUCER_ROLE}') THEN
              EXECUTE pg_catalog.format(
                'ALTER ROLE ${FACT_PRODUCER_ROLE} LOGIN CONNECTION LIMIT ${LOCAL_ROLE_CONNECTION_LIMIT} PASSWORD %L',
                pg_catalog.current_setting('cinatoken.fact_producer_password'));
            ELSIF pg_catalog.current_setting('cinatoken.rotate_producer_passwords') = 'true' THEN
              EXECUTE pg_catalog.format(
                'ALTER ROLE ${FACT_PRODUCER_ROLE} CONNECTION LIMIT ${LOCAL_ROLE_CONNECTION_LIMIT} PASSWORD %L',
                pg_catalog.current_setting('cinatoken.fact_producer_password'));
            ELSE
              ALTER ROLE ${FACT_PRODUCER_ROLE} CONNECTION LIMIT ${LOCAL_ROLE_CONNECTION_LIMIT};
            END IF;
          END;
          $producer_login_provision$;

        `);

        await tx`GRANT CONNECT ON DATABASE ${tx(database)}
          TO ${tx(DISPATCH_PRODUCER_ROLE)}, ${tx(FACT_PRODUCER_ROLE)}`;

        // Database names are quoted as identifiers by the postgres tagged
        // template. Static role names are constants and never accept input.
        for (const role of [DISPATCH_PRODUCER_ROLE, FACT_PRODUCER_ROLE]) {
          await tx`ALTER ROLE ${tx(role)} IN DATABASE ${tx(database)} SET transaction_timeout TO 30000`;
          await tx`ALTER ROLE ${tx(role)} IN DATABASE ${tx(database)} SET statement_timeout TO 15000`;
          await tx`ALTER ROLE ${tx(role)} IN DATABASE ${tx(database)} SET lock_timeout TO 2000`;
          await tx`ALTER ROLE ${tx(role)} IN DATABASE ${tx(database)} SET idle_in_transaction_session_timeout TO 10000`;
          await tx`ALTER ROLE ${tx(role)} IN DATABASE ${tx(database)} SET search_path TO pg_catalog, pg_temp`;
        }

        const roles = await tx<Array<{
          rolname: string;
          rolcanlogin: boolean;
          rolinherit: boolean;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolreplication: boolean;
          rolbypassrls: boolean;
          rolconnlimit: number;
          has_schema_create: boolean;
          has_database_connect: boolean;
          has_database_create: boolean;
          memberships: number;
          settings: string[] | null;
          has_scram_password: boolean;
        }>>`
          SELECT role.rolname, role.rolcanlogin, role.rolinherit, role.rolsuper,
            role.rolcreatedb, role.rolcreaterole, role.rolreplication,
            role.rolbypassrls, role.rolconnlimit,
            pg_catalog.has_schema_privilege(role.oid, ${GATEWAY_SCHEMA}, 'CREATE') AS has_schema_create,
            pg_catalog.has_database_privilege(role.oid, current_database(), 'CONNECT') AS has_database_connect,
            pg_catalog.has_database_privilege(role.oid, current_database(), 'CREATE') AS has_database_create,
            (SELECT count(*)::integer FROM pg_catalog.pg_auth_members member
              WHERE member.roleid = role.oid OR member.member = role.oid) AS memberships,
            (SELECT setting.setconfig FROM pg_catalog.pg_db_role_setting setting
              WHERE setting.setrole = role.oid
                AND setting.setdatabase = (SELECT oid FROM pg_catalog.pg_database
                  WHERE datname = current_database())) AS settings
            , (SELECT auth.rolpassword LIKE 'SCRAM-SHA-256$%'
              FROM pg_catalog.pg_authid auth WHERE auth.oid = role.oid)
              AS has_scram_password
          FROM pg_catalog.pg_roles role
          WHERE role.rolname IN (${DISPATCH_PRODUCER_ROLE}, ${FACT_PRODUCER_ROLE})
          ORDER BY role.rolname
        `;
        const expectedSettings = [
          'transaction_timeout=30000', 'statement_timeout=15000',
          'lock_timeout=2000', 'idle_in_transaction_session_timeout=10000',
          'search_path=pg_catalog, pg_temp',
        ];
        if (roles.length !== 2 || roles.some(role =>
          !role.rolcanlogin || role.rolinherit || role.rolsuper || role.rolcreatedb ||
          role.rolcreaterole || role.rolreplication || role.rolbypassrls ||
          role.rolconnlimit !== LOCAL_ROLE_CONNECTION_LIMIT ||
          role.has_schema_create || !role.has_database_connect ||
          role.has_database_create || role.memberships !== 0 ||
          role.has_scram_password !== true ||
          !expectedSettings.every(setting => role.settings?.includes(setting))
        )) {
          throw new Error('Provisioned producer login roles do not satisfy the reviewed contract.');
        }
        const crossDatabase = await tx<Array<{ datname: string }>>`
          SELECT database.datname FROM pg_catalog.pg_database database
          CROSS JOIN pg_catalog.pg_roles role
          WHERE database.datallowconn AND database.datname <> current_database()
            AND role.rolname IN (${DISPATCH_PRODUCER_ROLE}, ${FACT_PRODUCER_ROLE})
            AND pg_catalog.has_database_privilege(role.oid, database.oid, 'CONNECT')
          LIMIT 1
        `;
        if (crossDatabase.length) {
          throw new Error('Producer login has CONNECT on another database.');
        }
        if (dryRun) throw DRY_RUN_ROLLBACK;
      });
    } catch (error) {
      if (error !== DRY_RUN_ROLLBACK) throw error;
    }
    return {
      dryRun, rotatedExistingPasswords: rotatePasswords,
      database, roles: [DISPATCH_PRODUCER_ROLE, FACT_PRODUCER_ROLE],
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
  provisionPostgresProducerLogins().then(result => {
    console.log(result.dryRun
      ? 'Producer login provisioning dry-run passed; transaction rolled back.'
      : `Producer login roles ready in database ${result.database}.`);
    if (result.rotatedExistingPasswords) console.log('Existing producer passwords were rotated.');
  }).catch(error => {
    // Do not put URLs, passwords, SQL parameter values or server diagnostics on stdout.
    const code = typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
      ? ` (SQLSTATE ${error.code})` : '';
    console.error(`Producer login provisioning failed${code}.`);
    process.exitCode = 1;
  });
}
