import { pgCoreSchema } from './schema.pg';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgresFactory from 'postgres';
import type postgres from 'postgres';

export type PgDrizzleClient = PostgresJsDatabase<typeof pgCoreSchema>;

/**
 * 与 `packages/core/migrations-postgres/*.sql` 一致：业务表在 `cinatoken_gateway`，不在 `public`。
 * 通过 postgres.js 的 Startup `connection` 参数设置会话级 `search_path`，
 * 并在第一条业务 SQL 前显式执行 SET。后者是 Hyperdrive 的必要兜底：
 * Hyperdrive 可能不转发客户端 Startup 参数。
 *
 * 注意：`postgres` 会把连接串 query 里的参数合并进 `connection` 且可能覆盖同名键；
 * 若 `DATABASE_URL` 含冲突的 `search_path`，请先移除。
 */
export const GATEWAY_POSTGRES_SEARCH_PATH = 'cinatoken_gateway, public';

interface PostgresSessionInitializer {
	unsafe(query: string): Promise<unknown>;
}

type PostgresFactory = typeof postgresFactory;

const TRANSIENT_POSTGRES_CONNECTION_CODES = new Set([
	'CONNECTION_CLOSED',
	'CONNECTION_DESTROYED',
	'CONNECTION_ENDED',
]);

export function isTransientPostgresConnectionError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 5 && current; depth += 1) {
		if (typeof current !== 'object') return false;
		const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
		if (
			typeof candidate.code === 'string' &&
			TRANSIENT_POSTGRES_CONNECTION_CODES.has(candidate.code.toUpperCase())
		) {
			return true;
		}
		if (
			typeof candidate.message === 'string' &&
			/\bCONNECTION_(?:CLOSED|DESTROYED|ENDED)\b/u.test(candidate.message.toUpperCase())
		) {
			return true;
		}
		current = candidate.cause;
	}
	return false;
}

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
	await initializeGatewayPostgresSession(sql);
	const client = drizzle(sql, { schema: pgCoreSchema });
	return { client, sql };
}
