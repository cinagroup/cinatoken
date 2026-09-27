import type { D1Database } from '@cloudflare/workers-types';
import type { PoolOptions } from 'mysql2/promise';
import type postgres from 'postgres';
import {
	createD1DatabaseClient,
	createMySqlDatabaseClient,
	createPostgresDatabaseClient,
	type GatewayDatabaseClient,
} from './database-client';
import { createD1Repositories } from './repositories-d1';
import type { GatewayRepositories } from './repositories-types';
import type { RuntimeDatabaseConfig } from './runtime-database-config';
import { withUnpublishedPostgresClient } from './postgres-initialization';

export interface StorageContext {
	readonly client: GatewayDatabaseClient;
	readonly repositories: GatewayRepositories;
}

export function createD1StorageContext(db: D1Database): StorageContext {
	const client = createD1DatabaseClient(db);
	const repositories = createD1Repositories(client);
	return { client, repositories };
}

export async function createPostgresStorageContext(
	connectionString: string,
	options: postgres.Options<Record<string, postgres.PostgresType>> = {}
): Promise<StorageContext> {
	const client = await createPostgresDatabaseClient(connectionString, options);
	return withUnpublishedPostgresClient(client.raw, 'repositories', async () => {
		const { createPostgresRepositories } = await import('./repositories-postgres');
		const repositories = createPostgresRepositories(client);
		return { client, repositories };
	});
}

/**
 * Hyperdrive 已负责底层连接池；Worker 仍为每个请求/队列消息创建轻量客户端，
 * 避免把请求作用域对象放入模块级全局状态。参数与 Cloudflare 的 Postgres.js
 * Hyperdrive 建议保持一致。
 */
export async function createWorkerStorageContext(
	config: Extract<RuntimeDatabaseConfig, { driver: 'd1' | 'postgres' }>,
): Promise<StorageContext> {
	if (config.driver === 'd1') {
		return createD1StorageContext(config.db);
	}
	const options: postgres.Options<Record<string, postgres.PostgresType>> = {
		// Bound this invocation's local client pool. This does NOT preserve SET
		// state across Hyperdrive transactions; schema/settings scope is separate.
		max: 1,
		fetch_types: false,
		prepare: true,
	};
	// A stopped caller must not cause a second initialization after a late
	// connection error. Failed clients are closed by their initialization owner.
	return createPostgresStorageContext(config.connectionString, options);
}

export async function createMySqlStorageContext(
	connectionString: string,
	options: PoolOptions = {}
): Promise<StorageContext> {
	const client = await createMySqlDatabaseClient(connectionString, options);
	const { createMySqlRepositories } = await import('./repositories-mysql');
	const repositories = createMySqlRepositories(client);
	return { client, repositories };
}
