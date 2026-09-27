import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { URL } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

export type SqliteD1Hooks = {
	beforeStatement?: (sql: string, values: readonly SQLInputValue[]) => void;
	/** Standalone SQL already committed; delay/fail only its acknowledgement. */
	afterStatement?: (sql: string, values: readonly SQLInputValue[]) => void | Promise<void>;
	/** Batch already committed; must not roll back when acknowledgement fails. */
	afterBatch?: (sql: readonly string[]) => void | Promise<void>;
};

function input(value: unknown): SQLInputValue {
	if (value === null || typeof value === 'string' || typeof value === 'number') return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	throw new TypeError('Unsupported D1 fixture binding');
}

/** Test-only D1 shape. SQL and batch rollback run in real SQLite, not mocked repositories. */
class Statement {
	constructor(
		readonly database: DatabaseSync,
		readonly sql: string,
		readonly hooks: SqliteD1Hooks,
		readonly values: SQLInputValue[] = [],
	) {}
	bind(...values: unknown[]): D1PreparedStatement {
		return new Statement(this.database, this.sql, this.hooks, values.map(input));
	}
	execute<T>(): D1Result<T> {
		this.hooks.beforeStatement?.(this.sql, this.values);
		const statement = this.database.prepare(this.sql);
		const results = statement.all(...this.values);
		const writes = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(this.sql);
		const counts = this.database.prepare('SELECT changes() AS changes, last_insert_rowid() AS id').get()!;
		const changes = writes ? Number(counts.changes) : 0;
		return {
			success: true,
			// D1's generic is caller-specified; SQLite cannot infer the row schema.
			results: results as T[],
			meta: { changes, changed_db: changes > 0, last_row_id: Number(counts.id),
				duration: 0, size_after: 0, rows_read: results.length, rows_written: changes },
		};
	}
	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const result = this.execute<T>();
		await this.hooks.afterStatement?.(this.sql, this.values);
		return result;
	}
	async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.all<T>(); }
	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		const row = (await this.all<Record<string, unknown>>()).results[0];
		return (row == null ? null : column == null ? row : row[column] ?? null) as T | null;
	}
	raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
	async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
		this.hooks.beforeStatement?.(this.sql, this.values);
		const statement = this.database.prepare(this.sql);
		statement.setReturnArrays(true);
		const rows = statement.all(...this.values) as T[];
		return options?.columnNames ? [statement.columns().map(column => column.name), ...rows] : rows;
	}
}

/** No network or mocked SQL success. An explicit test-owned path supports restart tests. */
export function createSqliteD1(hooks: SqliteD1Hooks = {}, options: { filename?: string; applyMigrations?: boolean } = {}) {
	const sqlite = new DatabaseSync(options.filename ?? ':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	const migrations = new URL('../../../core/migrations-d1/', import.meta.url);
	const files = readdirSync(migrations).filter(file => file.endsWith('.sql')).sort();
	try {
		if (options.applyMigrations !== false) {
			for (const file of files) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
		}
	} catch (error) {
		sqlite.close();
		throw error;
	}
	const binding: D1Database = {
		prepare: sql => new Statement(sqlite, sql, hooks),
		async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
			sqlite.exec('BEGIN');
			let results: D1Result<T>[];
			const sql: string[] = [];
			try {
				results = statements.map(statement => {
					if (!(statement instanceof Statement) || statement.database !== sqlite) {
						throw new Error('Statement does not belong to this fixture');
					}
					sql.push(statement.sql);
					return statement.execute<T>();
				});
				sqlite.exec('COMMIT');
			} catch (error) {
				sqlite.exec('ROLLBACK');
				throw error;
			}
			await hooks.afterBatch?.(sql);
			return results;
		},
		async exec(sql) { sqlite.exec(sql); return { count: 1, duration: 0 }; },
		withSession() { throw new Error('D1 sessions are not emulated by this local fixture'); },
		async dump() { throw new Error('D1 dump is not emulated by this local fixture'); },
	};
	return { sqlite, binding, hooks, migrationFiles: files };
}
