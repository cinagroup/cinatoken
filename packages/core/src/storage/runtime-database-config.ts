import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseDriver } from './database-client';

/**
 * Proxy / Admin 运行时共用的数据库解析结果。
 * - Cloudflare Worker：`d1` 或 Hyperdrive `postgres`
 * - Node：`postgres` / `mysql`（连接串）
 */
export type RuntimeDatabaseConfig =
	| { driver: 'd1'; db: D1Database }
	| { driver: 'postgres'; connectionString: string }
	| { driver: 'mysql'; connectionString: string };

/** Worker 运行时实际使用的最小 Hyperdrive 绑定契约。 */
export interface HyperdriveBinding {
	readonly connectionString: string;
}

/** Cloudflare HTTP Workers only enter the cutover maintenance gate on an exact true value. */
export function isGatewayMaintenanceMode(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === 'true';
}

function parseDatabaseDriver(rawDriver: string | undefined, fallback: DatabaseDriver): DatabaseDriver {
	if (!rawDriver || rawDriver.trim() === '') {
		return fallback;
	}
	const normalized = rawDriver.trim().toLowerCase();
	if (normalized === 'd1') {
		return 'd1';
	}
	if (normalized === 'postgres' || normalized === 'postgresql') {
		return 'postgres';
	}
	if (normalized === 'mysql' || normalized === 'mysql2') {
		return 'mysql';
	}
	throw new Error(
		`Unsupported database driver "${rawDriver}" (set DATABASE_DRIVER). Expected "d1", "postgres" or "mysql".`
	);
}

/**
 * 校验 `DATABASE_DRIVER` 与 `DATABASE_URL` 协议是否一致，不一致则报错。
 * - mysql:// / mysql2:// → 须配 mysql
 * - postgres:// / postgresql:// → 须配 postgres
 * - 无协议前缀（如裸 host/IP）→ 不校验，由驱动自行处理
 */
function assertDriverUrlConsistency(driver: 'postgres' | 'mysql', connectionString: string): void {
	let scheme: string | undefined;
	try {
		const u = new URL(connectionString);
		scheme = u.protocol.replace(/:$/, '').toLowerCase();
	} catch {
		// 无法解析为 URL（如 Unix socket 路径）时跳过校验
		return;
	}

	const isMysqlScheme = scheme === 'mysql' || scheme === 'mysql2';
	const isPgScheme = scheme === 'postgres' || scheme === 'postgresql';

	if (driver === 'mysql' && isPgScheme) {
		throw new Error(
			`DATABASE_DRIVER=mysql 与 DATABASE_URL 协议 "${scheme}://" 不一致，请改为 mysql:// 连接串或将 DATABASE_DRIVER 改为 postgres。`
		);
	}
	if (driver === 'postgres' && isMysqlScheme) {
		throw new Error(
			`DATABASE_DRIVER=postgres（或省略）与 DATABASE_URL 协议 "${scheme}://" 不一致，请改为 postgres:// 连接串或将 DATABASE_DRIVER 改为 mysql。`
		);
	}
}

/**
 * Cloudflare Worker：默认使用 D1；只有显式设置 `DATABASE_DRIVER=postgres`
 * 才会使用 Hyperdrive，避免仅添加双绑定时意外切换生产数据面。
 * Worker 不接受 `DATABASE_URL`，Postgres 连接串只能来自 Hyperdrive 绑定。
 */
export function resolveWorkerDatabaseConfig(bindings: {
	DB?: D1Database;
	HYPERDRIVE?: HyperdriveBinding;
	DATABASE_DRIVER?: string;
}): Extract<RuntimeDatabaseConfig, { driver: 'd1' | 'postgres' }> {
	const raw = bindings.DATABASE_DRIVER?.trim();
	if (raw) {
		const n = raw.toLowerCase();
		if (n === 'postgres' || n === 'postgresql') {
			const connectionString = bindings.HYPERDRIVE?.connectionString?.trim();
			if (!connectionString) {
				throw new Error(
					'Workers with DATABASE_DRIVER=postgres require Hyperdrive binding "HYPERDRIVE".'
				);
			}
			return { driver: 'postgres', connectionString };
		}
		if (n === 'mysql' || n === 'mysql2') {
			throw new Error(
				'Workers do not support MySQL in this deployment. Use D1 or Hyperdrive Postgres, or run the gateway with Node for MySQL.'
			);
		}
		if (n !== 'd1') {
			throw new Error(
				`Unsupported database driver "${raw}" for Workers. Expected "d1" or "postgres".`
			);
		}
	}
	if (!bindings.DB) {
		throw new Error('Workers require D1 binding "DB".');
	}
	return { driver: 'd1', db: bindings.DB };
}

/**
 * Node 入口：由环境变量决定数据库类型与连接串。
 * - **`DATABASE_DRIVER`**：省略时默认为 `postgres`；支持 `postgres` / `mysql`（兼容 `mysql2`）。
 * - `DATABASE_URL`：连接串；须与驱动协议一致（mysql:// ↔ mysql，postgres:// ↔ postgres）。
 */
export function resolveNodeDatabaseConfig(env: {
	DATABASE_DRIVER?: string;
	DATABASE_URL?: string;
}): Extract<RuntimeDatabaseConfig, { connectionString: string }> {
	const driver = parseDatabaseDriver(env.DATABASE_DRIVER, 'postgres');

	if (driver === 'd1') {
		throw new Error('Node runtime does not support D1 binding. Set DATABASE_DRIVER=postgres or mysql.');
	}

	const connectionString = env.DATABASE_URL?.trim();
	if (!connectionString) {
		throw new Error('Node runtime requires DATABASE_URL.');
	}

	assertDriverUrlConsistency(driver, connectionString);

	return { driver, connectionString };
}
