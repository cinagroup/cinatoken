import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	assertGuardrailLedgerTableSelection,
	buildD1GuardrailLedgerAuditSql,
	buildPostgresGuardrailLedgerAuditSql,
	GUARDRAIL_LEDGER_TABLES,
} from "./guardrail-ledger-contract";

function scalar(database: DatabaseSync, sql: string): string {
	const row = database.prepare(sql).get() as { value?: unknown } | undefined;
	return String(row?.value ?? "missing");
}

function createLedgerDatabase(): DatabaseSync {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE api_keys (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL
		);
		CREATE TABLE api_key_request_logs (
			id TEXT PRIMARY KEY,
			user_id TEXT,
			api_key_id TEXT,
			charged_cost REAL NOT NULL,
			budget_charged_micros INTEGER,
			budget_accounted_at TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE guardrail_budget_windows (
			workspace_id TEXT NOT NULL,
			scope_type TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			period TEXT NOT NULL,
			period_start TEXT NOT NULL,
			period_end TEXT NOT NULL,
			unreserved_micros INTEGER NOT NULL,
			settled_micros INTEGER NOT NULL,
			reserved_micros INTEGER NOT NULL
		);
		CREATE TABLE guardrail_budget_reservations (
			workspace_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			assignment_id TEXT NOT NULL,
			state TEXT NOT NULL,
			scope_type TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			period TEXT NOT NULL,
			period_start TEXT NOT NULL,
			period_end TEXT NOT NULL,
			reserved_micros INTEGER NOT NULL,
			settled_micros INTEGER NOT NULL,
			expires_at TEXT NOT NULL
		);
		INSERT INTO api_keys VALUES ('key-1', 'personal:user-1');
		INSERT INTO guardrail_budget_windows VALUES (
			'personal:user-1', 'user', 'user-1', 'daily', '2026-08-29T00:00:00.000Z', '2026-08-30T00:00:00.000Z',
			195, 350, 0
		);
		INSERT INTO guardrail_budget_reservations VALUES
			('personal:user-1', 'request-settled', 'assignment-1', 'settled', 'user', 'user-1', 'daily',
			 '2026-08-29T00:00:00.000Z', '2026-08-30T00:00:00.000Z', 500, 300,
			 '2026-08-29T00:05:00.000Z'),
			('personal:user-1', 'request-expired', 'assignment-2', 'expired', 'user', 'user-1', 'daily',
			 '2026-08-29T00:00:00.000Z', '2026-08-30T00:00:00.000Z', 500, 50,
			 '2026-08-29T00:05:00.000Z'),
			('personal:user-1', 'request-released', 'assignment-3', 'released', 'user', 'user-1', 'daily',
			 '2026-08-29T00:00:00.000Z', '2026-08-30T00:00:00.000Z', 500, 0,
			 '2026-08-29T00:05:00.000Z');
		INSERT INTO api_key_request_logs VALUES
			('request-settled', 'user-1', 'key-1', 0.000300, 300, '2026-08-29T00:01:00.000Z', '2026-08-29T00:01:00.000Z'),
			('request-expired', 'user-1', 'key-1', 0.000040, 40, '2026-08-29T00:02:00.000Z', '2026-08-29T00:02:00.000Z'),
			('request-released', 'user-1', 'key-1', 0.000070, 70, '2026-08-29T00:03:00.000Z', '2026-08-29T00:03:00.000Z'),
			('request-unreserved', 'user-1', 'key-1', 0.000125, NULL, NULL, '2026-08-29T00:04:00.000Z');
	`);
	return database;
}

test("Guardrail ledger tables are either all selected or all omitted", () => {
	assert.equal(GUARDRAIL_LEDGER_TABLES.includes("provider_attempt_availability"), true);
	assert.equal(assertGuardrailLedgerTableSelection(null), true);
	assert.equal(
		assertGuardrailLedgerTableSelection(new Set(["users", "models"])),
		false
	);
	assert.equal(
		assertGuardrailLedgerTableSelection(new Set(GUARDRAIL_LEDGER_TABLES)),
		true
	);
	assert.throws(
		() =>
			assertGuardrailLedgerTableSelection(new Set(["api_key_request_logs"])),
		/indivisible cutover group.*guardrail_budget_windows.*guardrail_budget_reservations/u
	);
	assert.throws(
		() =>
			assertGuardrailLedgerTableSelection(
				new Set(["guardrail_budget_windows", "guardrail_budget_reservations"])
			),
		/indivisible cutover group.*api_key_request_logs/u
	);
});

test("D1 ledger audit accepts a drained, exactly accounted window and detects every corruption class", () => {
	const database = createLedgerDatabase();
	const audit = buildD1GuardrailLedgerAuditSql();
	try {
		assert.equal(scalar(database, audit.activeReservationCount), "0");
		assert.equal(scalar(database, audit.reservedWindowMismatchCount), "0");
		assert.equal(scalar(database, audit.settledWindowMismatchCount), "0");
		assert.equal(scalar(database, audit.unreservedWindowMismatchCount), "0");
		assert.equal(
			scalar(database, audit.windowInvariantCounts),
			"reserved=0,settled=0,unreserved=0"
		);

			database.exec(`
			UPDATE guardrail_budget_windows
			SET reserved_micros = 1, settled_micros = 349, unreserved_micros = 194;
			INSERT INTO guardrail_budget_reservations VALUES (
				'personal:user-1', 'request-active', 'assignment-4', 'dispatched', 'user', 'user-1', 'daily',
				'2026-08-29T00:00:00.000Z', '2026-08-30T00:00:00.000Z', 1, 0,
				'2026-08-29T00:10:00.000Z'
			);
		`);

		assert.equal(scalar(database, audit.activeReservationCount), "1");
		assert.equal(scalar(database, audit.reservedWindowMismatchCount), "1");
		assert.equal(scalar(database, audit.settledWindowMismatchCount), "1");
		assert.equal(scalar(database, audit.unreservedWindowMismatchCount), "1");
		assert.equal(
			scalar(database, audit.windowInvariantCounts),
			"reserved=1,settled=1,unreserved=1"
		);
		const detail = database
			.prepare(audit.windowMismatchDetails)
			.get() as Record<string, unknown>;
		assert.equal(detail.actual_settled_micros, "349");
		assert.equal(detail.expected_settled_micros, "350");
		assert.equal(detail.actual_unreserved_micros, "194");
		assert.equal(detail.expected_unreserved_micros, "195");
		assert.equal(detail.reserved_mismatch, "true");
		assert.equal(detail.settled_mismatch, "true");
		assert.equal(detail.unreserved_mismatch, "true");
	} finally {
		database.close();
	}
});

test("PostgreSQL ledger audit preserves the same terminal and log-coverage contract", () => {
	const audit = buildPostgresGuardrailLedgerAuditSql(
		(table) => `"cinatoken_gateway"."${table}"`
	);
	assert.match(
		audit.settledWindowMismatchCount,
		/state IN \('settled', 'released', 'expired'\)/u
	);
	assert.match(
		audit.unreservedWindowMismatchCount,
		/coverage\.state IN \('settled', 'expired'\)/u
	);
	assert.doesNotMatch(
		audit.unreservedWindowMismatchCount,
		/coverage\.state IN \('reserved', 'dispatched'/u
	);
	assert.match(
		audit.unreservedWindowMismatchCount,
		/COALESCE\(log\.budget_accounted_at, log\.created_at\)/u
	);
	assert.match(
		audit.unreservedWindowMismatchCount,
		/ROUND\(GREATEST\(log\.charged_cost, 0\) \* 1000000\)::bigint/u
	);
	for (const table of GUARDRAIL_LEDGER_TABLES.filter(
		(table) => table !== "provider_attempt_availability"
	)) {
		assert.match(
			audit.windowMismatchDetails + audit.activeReservationDetails,
			new RegExp(`"cinatoken_gateway"\\."${table}"`, "u")
		);
	}
});
