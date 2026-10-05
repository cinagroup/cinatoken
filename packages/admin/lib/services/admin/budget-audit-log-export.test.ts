import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	GlobalUserAuditLogRow,
	UserAuditLogCursor,
} from "@octafuse/core";
import { parseBudgetAuditLogQuery } from "./budget-audit-log-query";
import { exportAdminGlobalBudgetAuditLogsService } from "./budget-audit-log-export";

test("list and export share strict multi-filter parsing; omission means all events", () => {
	const params = new URLSearchParams(
		"event_type=usage_charge,admin_adjust&event_type=admin_adjust&actor_kind=admin_key&user_email=user%40example.com&start_date=2026-09-29+00%3A00%3A00"
	);
	const list = parseBudgetAuditLogQuery(params, "list");
	const csv = parseBudgetAuditLogQuery(params, "export");
	assert.deepEqual(list.filters, csv.filters);
	assert.deepEqual(csv.filters.eventTypes, ["usage_charge", "admin_adjust"]);
	assert.equal(csv.filters.userEmail, "user@example.com");
	assert.equal(
		parseBudgetAuditLogQuery(new URLSearchParams(), "export").filters
			.eventTypes,
		undefined
	);
	assert.deepEqual(
		parseBudgetAuditLogQuery(
			new URLSearchParams("end_date=2026-09-29"),
			"export"
		).filters,
		{
			userId: undefined,
			apiKeyId: undefined,
			userEmail: undefined,
			actorId: undefined,
			correlationId: undefined,
			eventTypes: undefined,
			actorTypes: undefined,
			actorKinds: undefined,
			reasonCodes: undefined,
			sources: undefined,
			startDate: undefined,
			endDate: "2026-09-30 00:00:00",
			endDateExclusive: true,
		}
	);
	for (const invalid of [
		"actor_kind=invalid",
		"actor_type=unknown",
		"event_type=",
		"start_date=2026-02-30",
		"start_date=2026-10-01&end_date=2026-09-29",
		"user_email=x&user_email=y",
		"page=1",
		"surprise=1",
		"user_email=user%40example.com%20",
		`reason_code=${Array.from({ length: 101 }, () => "x").join(",")}`,
	]) {
		assert.throws(
			() => parseBudgetAuditLogQuery(new URLSearchParams(invalid), "export"),
			{ status: 400 },
			invalid
		);
	}
});

function log(
	id: string,
	overrides: Partial<GlobalUserAuditLogRow> = {}
): GlobalUserAuditLogRow {
	return {
		id,
		created_at: "2026-09-29 03:00:00",
		request_log_id: null,
		correlation_id: null,
		event_type: "admin_adjust",
		source: "admin_users",
		reason_code: null,
		reason_text: null,
		actor_type: "admin",
		actor_id: "console:admin",
		user_id: "user-1",
		user_email: "user@example.com",
		api_key_id: null,
		before_user_snapshot: null,
		after_user_snapshot: null,
		change_payload: null,
		changed_fields: null,
		before_spent: 0,
		after_spent: 0,
		delta_spent: 0,
		before_budget_max: null,
		after_budget_max: null,
		before_budget_base: 0,
		after_budget_base: 0,
		...overrides,
	};
}

function repository(rows: GlobalUserAuditLogRow[]) {
	const calls: Array<{
		limit: number;
		after?: UserAuditLogCursor;
		highWater?: UserAuditLogCursor;
	}> = [];
	const repos = {
		userAuditLogs: {
			scanGlobalUserAuditLogsForExport: async (options: {
				limit: number;
				after?: UserAuditLogCursor;
				highWater?: UserAuditLogCursor;
			}) => {
				calls.push(options);
				return rows
					.filter((row) => !options.highWater || row.id <= options.highWater.id)
					.filter((row) => !options.after || row.id < options.after.id)
					.slice(0, options.limit)
					.map((row) => ({
						log: row,
						cursor: { createdAt: row.created_at, id: row.id },
						oversized: false,
					}));
			},
		},
	} as unknown as GatewayRepositories;
	return { repos, calls };
}

test("CSV uses bounded keyset, safe fixed columns, UTC, and honest snapshot/currency states", async () => {
	const before = JSON.stringify({
		budget_max: null,
		budget_spent: 1.123456,
		budget_base: 0,
		budget_period: "daily",
		budget_reset_at: "2026-09-30T00:00:00Z",
	});
	const after = JSON.stringify({
		budget_max: 5,
		budget_spent: 2.000001,
		budget_base: 1,
	});
	const { repos, calls } = repository([
		log("z", {
			user_email: '=HYPERLINK("https://evil.test")',
			reason_text: "+formula",
			before_user_snapshot: before,
			after_user_snapshot: after,
		}),
		log("y", {
			before_user_snapshot: null,
			after_user_snapshot: JSON.stringify({ budget_spent: 0 }),
		}),
		log("x", {
			before_user_snapshot: JSON.stringify({}),
			after_user_snapshot: "{broken",
		}),
	]);
	const csv = await exportAdminGlobalBudgetAuditLogsService(
		repos,
		{},
		{
			limits: { maxRows: 5, maxBytes: 100_000, maxMs: 20_000, batchSize: 2 },
		}
	);
	assert.equal(calls.length, 2);
	assert.equal(calls[0]!.after, undefined);
	assert.deepEqual(calls[1]!.highWater, {
		createdAt: "2026-09-29 03:00:00",
		id: "z",
	});
	assert.deepEqual(calls[1]!.after, {
		createdAt: "2026-09-29 03:00:00",
		id: "y",
	});
	assert.match(csv, /^\uFEFFaudit_id,created_at_utc,/u);
	assert.match(csv, /2026-09-29T03:00:00\.000Z/u);
	assert.match(csv, /"'=HYPERLINK\(""https:\/\/evil\.test""\)"/u);
	assert.match(csv, /"'\+formula"/u);
	assert.match(csv, /"unlimited","","known","5"/u);
	assert.match(csv, /"0\.876545"/u);
	assert.match(csv, /"missing","present","missing_snapshot"/u);
	assert.match(csv, /"present","invalid","missing_field"/u);
	assert.match(csv, /"unknown"\r\n/u);
	assert.doesNotMatch(
		csv,
		/change_payload|before_user_snapshot|after_user_snapshot/u
	);
});

test("CSV labels SQL UTC, ISO UTC, and offset audit timestamps with the same UTC instant", async () => {
	const { repos } = repository([
		log("z", { created_at: "2026-09-29 03:00:00.123456" }),
		log("y", { created_at: "2026-09-29T03:00:00.123456Z" }),
		log("x", { created_at: "2026-09-29T05:00:00.123+02:00" }),
	]);
	const csv = await exportAdminGlobalBudgetAuditLogsService(
		repos,
		{},
		{
			limits: { maxRows: 3, maxBytes: 100_000, maxMs: 20_000, batchSize: 4 },
		}
	);
	assert.equal([...csv.matchAll(/"2026-09-29T03:00:00\.123Z"/gu)].length, 3);
});

test("CSV fails rather than returning a truncated file on row, byte, time, or cancellation limits", async () => {
	const { repos } = repository([log("z"), log("y"), log("x")]);
	await assert.rejects(
		exportAdminGlobalBudgetAuditLogsService(
			repos,
			{},
			{
				limits: { maxRows: 2, maxBytes: 100_000, maxMs: 20_000, batchSize: 2 },
			}
		),
		{ status: 413, message: "Audit export row limit exceeded" }
	);
	await assert.rejects(
		exportAdminGlobalBudgetAuditLogsService(
			repos,
			{},
			{
				limits: { maxRows: 10, maxBytes: 100, maxMs: 20_000, batchSize: 2 },
			}
		),
		{ status: 413, message: "Audit export byte limit exceeded" }
	);
	let ticks = 0;
	await assert.rejects(
		exportAdminGlobalBudgetAuditLogsService(
			repos,
			{},
			{
				limits: { maxRows: 10, maxBytes: 100_000, maxMs: 20, batchSize: 2 },
				now: () => ++ticks * 10,
			}
		),
		{ status: 504, message: "Audit export time limit exceeded" }
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		exportAdminGlobalBudgetAuditLogsService(
			repos,
			{},
			{ signal: controller.signal }
		),
		{ status: 408 }
	);
});

test("CSV rejects an oversized database field before interpreting a truncated snapshot", async () => {
	const row = log("oversized", { before_user_snapshot: '{"budget_spent":1}' });
	const repos = {
		userAuditLogs: {
			scanGlobalUserAuditLogsForExport: async () => [
				{
					log: { ...row, before_user_snapshot: null },
					cursor: { createdAt: row.created_at, id: row.id },
					oversized: true,
				},
			],
		},
	} as unknown as GatewayRepositories;
	await assert.rejects(exportAdminGlobalBudgetAuditLogsService(repos, {}), {
		status: 413,
		message: "Audit export source field limit exceeded",
	});
});

test("CSV returns no file after a database-side statement timeout or cancellation", async () => {
	for (const failure of [
		{ code: "ER_QUERY_TIMEOUT", errno: 3024 },
		{ code: "57014", message: "canceling statement due to statement timeout" },
	]) {
		let calls = 0;
		const repos = {
			userAuditLogs: {
				scanGlobalUserAuditLogsForExport: async () => {
					calls += 1;
					throw failure;
				},
			},
		} as unknown as GatewayRepositories;
		await assert.rejects(exportAdminGlobalBudgetAuditLogsService(repos, {}), {
			status: 504,
			message: "Audit export query cancelled or timed out",
		});
		assert.equal(calls, 1);
	}
});
