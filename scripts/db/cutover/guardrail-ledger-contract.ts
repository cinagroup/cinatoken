export const GUARDRAIL_LEDGER_TABLES = [
	"api_key_request_logs",
	"guardrail_budget_windows",
	"guardrail_budget_reservations",
] as const;

export const GUARDRAIL_LEDGER_DETAIL_LIMIT = 100;

export interface GuardrailLedgerAuditSql {
	activeReservationCount: string;
	reservedWindowMismatchCount: string;
	settledWindowMismatchCount: string;
	unreservedWindowMismatchCount: string;
	windowInvariantCounts: string;
	activeReservationDetails: string;
	windowMismatchDetails: string;
}

type GuardrailLedgerDialect = "d1" | "postgres";

/**
 * The request log, window counters, and reservations form one accounting unit.
 * A partial copy can look internally valid while double-counting or dropping a
 * request, so a cutover may either omit all three or copy all three together.
 */
export function assertGuardrailLedgerTableSelection(
	tableFilter: ReadonlySet<string> | null
): boolean {
	if (tableFilter === null) {
		return true;
	}

	const selected = GUARDRAIL_LEDGER_TABLES.filter((table) =>
		tableFilter.has(table)
	);
	if (selected.length === 0) {
		return false;
	}
	if (selected.length !== GUARDRAIL_LEDGER_TABLES.length) {
		const missing = GUARDRAIL_LEDGER_TABLES.filter(
			(table) => !tableFilter.has(table)
		);
		throw new Error(
			`Guardrail ledger tables are an indivisible cutover group; missing: ${missing.join(
				", "
			)}`
		);
	}
	return true;
}

function buildWindowAuditCte(
	dialect: GuardrailLedgerDialect,
	qualifyTable: (table: string) => string
): string {
	const windows = qualifyTable("guardrail_budget_windows");
	const reservations = qualifyTable("guardrail_budget_reservations");
	const logs = qualifyTable("api_key_request_logs");
	const apiKeys = qualifyTable("api_keys");
	const chargedMicros =
		dialect === "postgres"
			? "ROUND(GREATEST(log.charged_cost, 0) * 1000000)::bigint"
			: "CAST(ROUND(MAX(log.charged_cost, 0) * 1000000) AS INTEGER)";
	const uncoveredLogSum = (
		scopeType: "user" | "api_key",
		scopeColumn: string
	) => `COALESCE((
			SELECT SUM(COALESCE(log.budget_charged_micros, ${chargedMicros}))
			FROM ${logs} AS log
			WHERE log.${scopeColumn} = budget_window.scope_id
			  AND EXISTS (
				SELECT 1 FROM ${apiKeys} AS api_key
				WHERE api_key.id = log.api_key_id
				  AND api_key.workspace_id = budget_window.workspace_id
			  )
			  AND COALESCE(log.budget_accounted_at, log.created_at) >= budget_window.period_start
			  AND COALESCE(log.budget_accounted_at, log.created_at) < budget_window.period_end
			  AND NOT EXISTS (
				SELECT 1
				FROM ${reservations} AS coverage
				WHERE coverage.request_id = log.id
				  AND coverage.workspace_id = budget_window.workspace_id
				  AND coverage.scope_type = '${scopeType}'
				  AND coverage.scope_id = budget_window.scope_id
				  AND coverage.period = budget_window.period
				  AND coverage.period_start = budget_window.period_start
				  AND coverage.state IN ('settled', 'expired')
			  )
		), 0)`;

	return `WITH guardrail_ledger_window_audit AS (
	SELECT
		budget_window.workspace_id,
		budget_window.scope_type,
		budget_window.scope_id,
		budget_window.period,
		budget_window.period_start,
		budget_window.period_end,
		budget_window.reserved_micros AS actual_reserved_micros,
		budget_window.settled_micros AS actual_settled_micros,
		budget_window.unreserved_micros AS actual_unreserved_micros,
		COALESCE((
			SELECT SUM(reservation.settled_micros)
			FROM ${reservations} AS reservation
			WHERE reservation.workspace_id = budget_window.workspace_id
			  AND reservation.scope_type = budget_window.scope_type
			  AND reservation.scope_id = budget_window.scope_id
			  AND reservation.period = budget_window.period
			  AND reservation.period_start = budget_window.period_start
			  AND reservation.state IN ('settled', 'released', 'expired')
		), 0) AS expected_settled_micros,
		CASE budget_window.scope_type
			WHEN 'user' THEN ${uncoveredLogSum("user", "user_id")}
			WHEN 'api_key' THEN ${uncoveredLogSum("api_key", "api_key_id")}
			ELSE 0
		END AS expected_unreserved_micros
	FROM ${windows} AS budget_window
)`;
}

function castAsText(
	dialect: GuardrailLedgerDialect,
	expression: string
): string {
	return dialect === "postgres"
		? `(${expression})::text`
		: `CAST(${expression} AS TEXT)`;
}

function buildGuardrailLedgerAuditSql(
	dialect: GuardrailLedgerDialect,
	qualifyTable: (table: string) => string
): GuardrailLedgerAuditSql {
	const reservations = qualifyTable("guardrail_budget_reservations");
	const cte = buildWindowAuditCte(dialect, qualifyTable);
	const count = (condition: string) => `${cte}
	SELECT ${castAsText(dialect, "COUNT(*)")} AS value
	FROM guardrail_ledger_window_audit
	WHERE ${condition}`;
	const invariantCount = (condition: string) =>
		`COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0)`;
	const windowInvariantCounts = `${cte}
	SELECT 'reserved=' || ${castAsText(
		dialect,
		invariantCount("actual_reserved_micros <> 0")
	)}
		|| ',settled=' || ${castAsText(
			dialect,
			invariantCount("actual_settled_micros <> expected_settled_micros")
		)}
		|| ',unreserved=' || ${castAsText(
			dialect,
			invariantCount("actual_unreserved_micros <> expected_unreserved_micros")
		)} AS value
	FROM guardrail_ledger_window_audit`;
	const activeReservationCount = `SELECT ${castAsText(
		dialect,
		"COUNT(*)"
	)} AS value
	FROM ${reservations}
	WHERE state IN ('reserved', 'dispatched')`;
	const activeReservationDetails = `SELECT
	workspace_id,
	request_id,
	assignment_id,
	state,
	scope_type,
	scope_id,
	period,
	${castAsText(dialect, "period_start")} AS period_start,
	${castAsText(dialect, "period_end")} AS period_end,
	${castAsText(dialect, "reserved_micros")} AS reserved_micros,
	${castAsText(dialect, "settled_micros")} AS settled_micros,
	${castAsText(dialect, "expires_at")} AS expires_at
	FROM ${reservations}
	WHERE state IN ('reserved', 'dispatched')
	ORDER BY request_id, assignment_id
	LIMIT ${GUARDRAIL_LEDGER_DETAIL_LIMIT}`;
	const windowMismatchCondition = `actual_reserved_micros <> 0
	   OR actual_settled_micros <> expected_settled_micros
	   OR actual_unreserved_micros <> expected_unreserved_micros`;
	const windowMismatchDetails = `${cte}
	SELECT
	workspace_id,
	scope_type,
	scope_id,
	period,
	${castAsText(dialect, "period_start")} AS period_start,
	${castAsText(dialect, "period_end")} AS period_end,
	${castAsText(dialect, "actual_reserved_micros")} AS actual_reserved_micros,
	${castAsText(dialect, "actual_settled_micros")} AS actual_settled_micros,
	${castAsText(dialect, "expected_settled_micros")} AS expected_settled_micros,
	${castAsText(dialect, "actual_unreserved_micros")} AS actual_unreserved_micros,
	${castAsText(
		dialect,
		"expected_unreserved_micros"
	)} AS expected_unreserved_micros,
	CASE WHEN actual_reserved_micros <> 0 THEN 'true' ELSE 'false' END AS reserved_mismatch,
	CASE WHEN actual_settled_micros <> expected_settled_micros THEN 'true' ELSE 'false' END AS settled_mismatch,
	CASE WHEN actual_unreserved_micros <> expected_unreserved_micros THEN 'true' ELSE 'false' END AS unreserved_mismatch
	FROM guardrail_ledger_window_audit
	WHERE ${windowMismatchCondition}
	ORDER BY workspace_id, scope_type, scope_id, period, period_start
	LIMIT ${GUARDRAIL_LEDGER_DETAIL_LIMIT}`;

	return {
		activeReservationCount,
		reservedWindowMismatchCount: count("actual_reserved_micros <> 0"),
		settledWindowMismatchCount: count(
			"actual_settled_micros <> expected_settled_micros"
		),
		unreservedWindowMismatchCount: count(
			"actual_unreserved_micros <> expected_unreserved_micros"
		),
		windowInvariantCounts,
		activeReservationDetails,
		windowMismatchDetails,
	};
}

export function buildD1GuardrailLedgerAuditSql(): GuardrailLedgerAuditSql {
	return buildGuardrailLedgerAuditSql("d1", (table) => table);
}

export function buildPostgresGuardrailLedgerAuditSql(
	qualifyTable: (table: string) => string
): GuardrailLedgerAuditSql {
	return buildGuardrailLedgerAuditSql("postgres", qualifyTable);
}
