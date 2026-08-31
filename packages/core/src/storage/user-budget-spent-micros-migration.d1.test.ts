import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const migration0040 = readFileSync(fileURLToPath(new URL(
	'../../migrations-d1/0040_user_budget_reservations.sql', import.meta.url,
).href), 'utf8');
const migration0041 = readFileSync(fileURLToPath(new URL(
	'../../migrations-d1/0041_user_budget_spent_micros.sql', import.meta.url,
).href), 'utf8');

function legacyDatabase(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			budget_max REAL,
			budget_spent REAL NOT NULL DEFAULT 0,
			budget_period TEXT NOT NULL DEFAULT 'none',
			budget_reset_at TEXT,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			status TEXT NOT NULL
		);
	`);
	database.exec(migration0040);
	return database;
}

test('D1 0041 backfills unambiguous legacy REAL spend and safely supports a rolling legacy writer', () => {
	const database = legacyDatabase();
	try {
		database.prepare(`INSERT INTO users (
			id, budget_max, budget_spent, budget_period, updated_at
		) VALUES ('legacy-safe', NULL, 2147483648.000001, 'none', '2026-08-30T00:00:00.000Z')`).run();
		database.exec(migration0041);

		assert.deepEqual({ ...database.prepare(`SELECT
			typeof(budget_spent_micros) AS storage_type,
			budget_spent_micros
			FROM users WHERE id = 'legacy-safe'`).get() }, {
			storage_type: 'integer',
			budget_spent_micros: 2_147_483_648_000_001,
		});

		// A still-running pre-0041 Worker changes only the REAL column. The
		// compatibility trigger recovers and canonicalizes it atomically.
		database.prepare(`UPDATE users SET budget_spent = 2147483648.000002
			WHERE id = 'legacy-safe'`).run();
		assert.equal(
			Number(database.prepare(`SELECT budget_spent_micros FROM users
				WHERE id = 'legacy-safe'`).get()?.budget_spent_micros),
			2_147_483_648_000_002,
		);

		assert.throws(
			() => database.prepare(`UPDATE users SET budget_spent = 4294967296.0
				WHERE id = 'legacy-safe'`).run(),
			/unsafe_legacy_budget_spent/,
		);
		assert.equal(
			Number(database.prepare(`SELECT budget_spent_micros FROM users
				WHERE id = 'legacy-safe'`).get()?.budget_spent_micros),
			2_147_483_648_000_002,
		);

		// An integer-only operator repair above the legacy REAL recovery range
		// must update the compatibility mirror without recursively looking like
		// an unsafe pre-0041 REAL-only write.
		database.exec(`UPDATE users SET budget_spent_micros = 8589934592000001
			WHERE id = 'legacy-safe'`);
		assert.deepEqual({ ...database.prepare(`SELECT
			CAST(budget_spent_micros AS TEXT) AS micros,
			budget_spent IS CAST(budget_spent_micros AS REAL) / 1000000.0 AS mirror_matches
			FROM users WHERE id = 'legacy-safe'`).get() }, {
			micros: '8589934592000001',
			mirror_matches: 1,
		});
	} finally {
		database.close();
	}
});

test('D1 0041 aborts rather than inventing micros for an ambiguous legacy REAL value', () => {
	const database = legacyDatabase();
	try {
		database.prepare(`INSERT INTO users (
			id, budget_max, budget_spent, budget_period, updated_at
		) VALUES ('legacy-ambiguous', NULL, 4294967296.0, 'none', '2026-08-30T00:00:00.000Z')`).run();

		database.exec('BEGIN');
		assert.throws(() => database.exec(migration0041), /CHECK constraint failed/);
		database.exec('ROLLBACK');

		const columns = database.prepare(`PRAGMA table_info(users)`).all()
			.map((row) => String(row.name));
		assert.equal(columns.includes('budget_spent_micros'), false);
		assert.equal(
			Number(database.prepare(`SELECT budget_spent FROM users
				WHERE id = 'legacy-ambiguous'`).get()?.budget_spent),
			4_294_967_296,
		);
	} finally {
		database.close();
	}
});
