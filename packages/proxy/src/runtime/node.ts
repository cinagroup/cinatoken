import {
	createMySqlStorageContext,
	createPostgresStorageContext,
	createEncryptedProvidersRepository,
	createEnvironmentProviderKeysRepository,
	createEncryptedSharedKeysRepository,
	createEncryptedByokKeysRepository,
	DEEPSEEK_OFFICIAL_ENVIRONMENT_SECRET_POLICY,
	assertSharedKeyEncryptionSecret,
	resolveNodeDatabaseConfig,
	type RuntimeDatabaseConfig,
	type StorageContext,
} from '@octafuse/core';
import { createAdaptorServer } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import { createProxyApp, type ProxyAppOptions } from '../app';
import {
	createNodeWebSocketServer,
} from './node-realtime';
import { handleNodeRealtimeUpgrade } from './node-realtime-upgrade';
import { createInMemoryPublicStatsRuntimeGuard } from '../services/public-stats-runtime-guard';
import { createSharedStorageInitializer } from './shared-storage-initializer';

const resolveSharedNodeStorage = createSharedStorageInitializer((config: RuntimeDatabaseConfig) =>
	config.driver === 'mysql'
		? createMySqlStorageContext(config.connectionString)
		: config.driver === 'postgres'
			? createPostgresStorageContext(config.connectionString)
			: Promise.reject(new Error('Unexpected Node storage driver')),
);

async function resolveNodeStorage(): Promise<StorageContext> {
	const config = resolveNodeDatabaseConfig(process.env);
	const secret = assertSharedKeyEncryptionSecret(process.env.SHARED_KEY_ENCRYPTION_SECRET);
	const storage = await resolveSharedNodeStorage(config);
	return {
		...storage,
		repositories: {
			...storage.repositories,
			sharedKeys: createEncryptedSharedKeysRepository(storage.repositories.sharedKeys, secret),
			byokKeys: createEncryptedByokKeysRepository(storage.repositories.byokKeys, secret),
			providers: createEnvironmentProviderKeysRepository(
				createEncryptedProvidersRepository(storage.repositories.providers, secret),
				{
					policies: [DEEPSEEK_OFFICIAL_ENVIRONMENT_SECRET_POLICY],
					secrets: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY },
				},
			),
		},
	};
}

export function createNodeApp(options?: Pick<ProxyAppOptions, 'postgresImageRecovery' | 'httpCapacity'>) {
	if (options?.postgresImageRecovery && resolveNodeDatabaseConfig(process.env).driver !== 'postgres') {
		throw new TypeError('PostgreSQL Images recovery requires a PostgreSQL Node database driver');
	}
	return createProxyApp(async () => resolveNodeStorage(), {
		// Initialization belongs to the process-wide pool, not this cancelled request.
		// Still await its terminal result in the request resource receipt; never end it here.
		disposeUnusedStorage: async () => {},
		requestBodyLogging: process.env.REQUEST_BODY_LOGGING,
		organizationAdminRoles: process.env.CINAAUTH_ORGANIZATION_ADMIN_ROLES,
		publicStatsRuntime: createInMemoryPublicStatsRuntimeGuard(),
		postgresImageRecovery: options?.postgresImageRecovery,
		httpCapacity: options?.httpCapacity,
	});
}

function redactDatabaseConnectionUrl(connectionString: string): string {
	try {
		const u = new URL(connectionString);
		if (u.password) {
			u.password = '***';
		}
		return u.toString();
	} catch {
		return '（连接串无法解析为 URL，已省略）';
	}
}

function printNodeStartupBanner(
	port: number,
	dbKind: 'postgres' | 'mysql',
	redactedUrl: string
): void {
	const base = `http://127.0.0.1:${port}`;
	const dbDriver = process.env.DATABASE_DRIVER?.trim() || 'postgres（默认）';
	const nodeEnv = process.env.NODE_ENV?.trim() ?? '（未设置）';
	const runtimeLabel = dbKind === 'mysql' ? 'Node（MySQL）' : 'Node（Postgres）';
	const dbLineLabel = dbKind === 'mysql' ? 'MySQL' : 'Postgres';
	const lines = [
		'',
		'────────────────────────────────────────────────────────────',
		`  cinatoken · gateway-proxy · ${runtimeLabel}`,
		'────────────────────────────────────────────────────────────',
		`  服务地址       ${base}`,
		`  健康检查       GET  ${base}/health`,
		`  Chat           POST ${base}/v1/chat/completions`,
		`  Responses      POST ${base}/v1/responses`,
		`  Images         POST ${base}/v1/images/generations`,
		`  Image edits    POST ${base}/v1/images/edits`,
		`  Anthropic      POST ${base}/v1/messages`,
		`  Gemini         POST ${base}/v1beta/models/{model}:generateContent`,
		`  Web search     POST ${base}/v1/tools/web-search`,
		`  DashScope WS   GET  ${base}/v1/dashscope/realtime`,
		'',
		`  数据库         ${dbLineLabel}  ${redactedUrl}`,
		`  DATABASE_DRIVER ${dbDriver}`,
		`  NODE_ENV       ${nodeEnv}`,
		`  Admin API/UI   独立部署（本进程不含 /admin）`,
		'────────────────────────────────────────────────────────────',
		'',
	];
	console.log(lines.join('\n'));
}

export async function startNodeServer(port = Number(process.env.PORT ?? 8787)): Promise<void> {
	let redactedUrl = '';
	let dbKind: 'postgres' | 'mysql' = 'postgres';
	try {
		const cfg = resolveNodeDatabaseConfig(process.env);
		dbKind = cfg.driver === 'mysql' ? 'mysql' : 'postgres';
		redactedUrl = redactDatabaseConnectionUrl(cfg.connectionString);
	} catch (err) {
		console.error(
			'[Gateway Proxy Node] 启动前校验失败（请检查 DATABASE_URL、DATABASE_DRIVER=postgres|mysql 等）：'
		);
		console.error(err);
		process.exit(1);
	}

	printNodeStartupBanner(port, dbKind, redactedUrl);

	process.on('unhandledRejection', (reason: unknown) => {
		console.error('[Gateway Proxy] unhandledRejection', reason);
	});
	process.on('uncaughtException', (err: Error) => {
		console.error('[Gateway Proxy] uncaughtException', err);
	});

	const app = createNodeApp();
	const server = createAdaptorServer({ fetch: app.fetch });
	const websocketServer = createNodeWebSocketServer();
	// Authentication and route validation run before ws accepts the client.
	server.on('upgrade', (request, socket, head) => {
		void handleNodeRealtimeUpgrade(app, request, socket, head, websocketServer);
	});
	server.listen(port);
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
	startNodeServer().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
