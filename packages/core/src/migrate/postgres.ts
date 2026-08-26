import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/** 与 `packages/core/src/storage/drizzle/client-postgres.ts` 中 GATEWAY_POSTGRES_SEARCH_PATH 保持一致。 */
export const GATEWAY_POSTGRES_SCHEMA = 'cinatoken_gateway';
export const LEGACY_GATEWAY_POSTGRES_SCHEMA = 'octafuse_gateway';
export const GATEWAY_POSTGRES_SEARCH_PATH = `${GATEWAY_POSTGRES_SCHEMA}, public`;

/**
 * Rename the historical gateway schema before any new schema is created.
 * When both names exist we fail closed: choosing either side automatically
 * could orphan an independently migrated dataset.
 */
export const GATEWAY_POSTGRES_SCHEMA_BOOTSTRAP_SQL = `
DO $cinatoken_gateway_schema$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_namespace WHERE nspname = '${LEGACY_GATEWAY_POSTGRES_SCHEMA}'
	) THEN
		IF EXISTS (
			SELECT 1 FROM pg_namespace WHERE nspname = '${GATEWAY_POSTGRES_SCHEMA}'
		) THEN
			RAISE EXCEPTION
				'both ${LEGACY_GATEWAY_POSTGRES_SCHEMA} and ${GATEWAY_POSTGRES_SCHEMA} schemas exist; manual reconciliation is required'
				USING ERRCODE = '55000';
		END IF;

		EXECUTE 'ALTER SCHEMA ${LEGACY_GATEWAY_POSTGRES_SCHEMA} RENAME TO ${GATEWAY_POSTGRES_SCHEMA}';
	END IF;
END
$cinatoken_gateway_schema$;

CREATE SCHEMA IF NOT EXISTS ${GATEWAY_POSTGRES_SCHEMA};
`;

const MIGRATIONS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../migrations-postgres'
);

function logPostgresTarget(connectionString: string): void {
	try {
		const normalized = connectionString.replace(/^postgresql:\/\//i, 'postgres://');
		const u = new URL(normalized);
		const pathDb = u.pathname.replace(/^\//, '').split('?')[0];
		const database = pathDb ? decodeURIComponent(pathDb) : '(路径为空，驱动可能回退为与用户名同名库等默认行为)';
		console.log(
			'[migrate-postgres] 连接目标: host=%s port=%s user=%s database=%s',
			u.hostname,
			u.port || '5432',
			u.username || '(empty)',
			database
		);
	} catch {
		console.error('[migrate-postgres] DATABASE_URL 格式无法解析，请使用 postgres:// 或 postgresql:// 连接串');
	}
}

export async function migratePostgres(): Promise<void> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error('DATABASE_URL is required');
	}

	logPostgresTarget(connectionString);
	console.log('[migrate-postgres] 迁移目录: %s', MIGRATIONS_DIR);

	const sql = postgres(connectionString, {
		max: 1,
		connection: { search_path: GATEWAY_POSTGRES_SEARCH_PATH },
	});
	const MIGRATION_LOCK_KEY = 746923551;
	let applied = 0;
	let skipped = 0;
	let migrationLockAcquired = false;
	try {
		await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
		migrationLockAcquired = true;
		console.log('[migrate-postgres] 已获取迁移锁（pg_advisory_lock=%s）', MIGRATION_LOCK_KEY);

		const t0 = performance.now();
		await sql.unsafe(GATEWAY_POSTGRES_SCHEMA_BOOTSTRAP_SQL);
		await sql`
			CREATE TABLE IF NOT EXISTS cinatoken_gateway.schema_migrations (
				version TEXT PRIMARY KEY,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`;
		console.log(
			'[migrate-postgres] 已确保表 cinatoken_gateway.schema_migrations 存在（%.0f ms）',
			performance.now() - t0
		);

		const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
		const migrationFiles = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));

		if (migrationFiles.length === 0) {
			console.log('[migrate-postgres] 未发现 packages/core/migrations-postgres/*.sql，无需执行');
			return;
		}

		console.log('[migrate-postgres] 共 %d 个迁移文件（按文件名排序）', migrationFiles.length);

		const appliedRows = await sql<{ version: string }[]>`
			SELECT version
			FROM cinatoken_gateway.schema_migrations
		`;
		const appliedVersions = new Set(appliedRows.map((row) => row.version));

		for (const fileName of migrationFiles) {
			if (appliedVersions.has(fileName)) {
				skipped += 1;
				console.log('[migrate-postgres] 跳过（已记录）: %s', fileName);
				continue;
			}

			const sqlText = await readFile(path.join(MIGRATIONS_DIR, fileName), 'utf8');
			const bytes = Buffer.byteLength(sqlText, 'utf8');
			const sizeLabel = bytes < 1024 ? `${bytes} B` : `约 ${Math.round(bytes / 1024)} KB`;
			console.log('[migrate-postgres] 执行: %s（%s）…', fileName, sizeLabel);

			const runStart = performance.now();
			await sql.begin(async (tx) => {
				await tx.unsafe(sqlText);
				await tx`
					INSERT INTO cinatoken_gateway.schema_migrations (version)
					VALUES (${fileName})
					ON CONFLICT (version) DO NOTHING
				`;
			});
			appliedVersions.add(fileName);
			applied += 1;
			console.log('[migrate-postgres] 完成: %s（%.0f ms）', fileName, performance.now() - runStart);
		}

		console.log(
			'[migrate-postgres] 汇总: 新执行 %d 个, 跳过 %d 个, 扫描 %d 个文件',
			applied,
			skipped,
			migrationFiles.length
		);
		console.log('[migrate-postgres] 全部完成。');
	} finally {
		if (migrationLockAcquired) {
			try {
				await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
			} catch (error) {
				console.warn('[migrate-postgres] 释放迁移锁失败: %s', String(error));
			}
		}
		await sql.end();
	}
}
