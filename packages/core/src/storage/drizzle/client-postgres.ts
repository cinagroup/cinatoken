import { pgCoreSchema } from './schema.pg';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgresFactory from 'postgres';
import type postgres from 'postgres';
import { withUnpublishedPostgresClient } from '../postgres-initialization';

export type PgDrizzleClient = PostgresJsDatabase<typeof pgCoreSchema>;

/**
 * 与 `packages/core/migrations-postgres/*.sql` 一致：业务表在 `cinatoken_gateway`，不在 `public`。
 * 通过 postgres.js 的 Startup `connection` 参数设置会话级 `search_path`，
 * 并在第一条业务 SQL 前显式执行 SET，保留直接连接的会话兼容行为。
 * 这不能保证 Hyperdrive 后续查询的 schema：其事务池会 RESET 会话设置，
 * schema 限定／每查询设置必须另行实现与验收，max: 1 不能替代它。
 *
 * 注意：`postgres` 会把连接串 query 里的参数合并进 `connection` 且可能覆盖同名键；
 * 若 `DATABASE_URL` 含冲突的 `search_path`，请先移除。
 */
export const GATEWAY_POSTGRES_SEARCH_PATH = 'cinatoken_gateway, public';

interface PostgresSessionInitializer {
	unsafe(query: string): Promise<unknown>;
}

type PostgresFactory = typeof postgresFactory;

export { isTransientPostgresConnectionError } from '../postgres-connection-error';

/** Normalize CJS/ESM default wrappers emitted by Next/Webpack and OpenNext. */
export function resolvePostgresFactory(candidate: unknown): PostgresFactory {
	let current = candidate;
	for (let depth = 0; depth < 3; depth += 1) {
		if (typeof current === 'function') return current as PostgresFactory;
		if (current && typeof current === 'object' && 'default' in current) {
			current = (current as { default: unknown }).default;
			continue;
		}
		break;
	}
	throw new TypeError('postgres module did not expose a callable factory');
}

export async function initializeGatewayPostgresSession(
	sql: PostgresSessionInitializer,
): Promise<void> {
	await sql.unsafe(`SET search_path TO ${GATEWAY_POSTGRES_SEARCH_PATH}`);
}

export async function initPostgresDrizzle(
	connectionString: string,
	options: postgres.Options<Record<string, postgres.PostgresType>> = {}
): Promise<{ client: PgDrizzleClient; sql: postgres.Sql<Record<string, postgres.PostgresType>> }> {
	const pgOptions: postgres.Options<Record<string, postgres.PostgresType>> = {
		...options,
		connection: {
			...(options.connection ?? {}),
			search_path: GATEWAY_POSTGRES_SEARCH_PATH,
		},
	};

	const sql = resolvePostgresFactory(postgresFactory)(connectionString, pgOptions);
	return withUnpublishedPostgresClient(sql, 'session', async () => {
		await initializeGatewayPostgresSession(sql);
		const client = drizzle(sql, { schema: pgCoreSchema });
		return { client, sql };
	});
}
