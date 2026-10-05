import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { GatewayRepositories } from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import { adminEarningsRoutes } from "./earnings";

function appFor(
	logs: Array<{ id: string; provider_key_id: string | null }>,
	total = logs.length
) {
	let ledgerReadsOrWrites = 0;
	let logReads = 0;
	const queries: Array<{ page: number; pageSize: number; startDate: string }> =
		[];
	const repositories = {
		requestLogs: {
			async getRequestLogs(options: {
				page: number;
				pageSize: number;
				startDate: string;
			}) {
				assert.equal(options.page, 1);
				queries.push(options);
				logReads++;
				return { logs, total };
			},
		},
		sharedKeys: {
			async getSharedKeyById() {
				ledgerReadsOrWrites++;
				throw new Error(
					"current key must not supply historical price or owner"
				);
			},
			async addSharedKeyUsage() {
				ledgerReadsOrWrites++;
				throw new Error("historical usage must not be incremented");
			},
		},
		systemConfig: {
			async getConfig() {
				ledgerReadsOrWrites++;
				throw new Error("current commission must not price history");
			},
		},
		portalLedger: {
			async ensureUserEarnings() {
				ledgerReadsOrWrites++;
				throw new Error("historical ledger must not be written");
			},
			async recordEarningAndCredit() {
				ledgerReadsOrWrites++;
				throw new Error("historical ledger must not be written");
			},
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<AdminEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			type: "console",
			id: "console:test",
			username: "test",
		});
		await next();
	});
	app.route("/admin/earnings", adminEarningsRoutes);
	return { app, queries, counts: () => ({ logReads, ledgerReadsOrWrites }) };
}

const endpoint = "/admin/earnings/rederive?since=2026-09-01T00%3A00%3A00.000Z";
const reviewFacts = (candidateLogIds: string[]) => ({
	candidateLogIds,
	reviewOnly: true,
	balancesChanged: false,
	queued: false,
	range: { since: "2026-09-01T00:00:00.000Z", limit: 200, page: 1 },
	reviewScope: "first_page_since",
	evidenceRequirement: "original_price_commission_owner",
});

test("historical apply returns review candidates without repricing or crediting from current state", async () => {
	const { app, counts } = appFor([
		{ id: "historical-shared", provider_key_id: "sharedkey:key-1" },
		{ id: "ordinary", provider_key_id: "provider:key-2" },
	]);
	const response = await app.request(`${endpoint}&apply=1`, { method: "POST" });
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		success: false,
		dryRun: false,
		error:
			"Historical shared-key earnings require original price, commission, and owner evidence",
		code: "historical_earning_evidence_required",
		data: {
			windowSince: "2026-09-01T00:00:00.000Z",
			scanned: 2,
			windowTotal: 2,
			scanComplete: true,
			candidates: 1,
			reviewRequired: 1,
			...reviewFacts(["historical-shared"]),
		},
	});
	assert.deepEqual(counts(), { logReads: 1, ledgerReadsOrWrites: 0 });
});

test("dry run and empty apply remain read-only", async () => {
	const nonShared = [{ id: "ordinary", provider_key_id: "provider:key-2" }];
	const { app, counts } = appFor(nonShared);
	const dryRun = await app.request(endpoint, { method: "POST" });
	assert.equal(dryRun.status, 200);
	assert.deepEqual(await dryRun.json(), {
		success: true,
		dryRun: true,
		data: {
			windowSince: "2026-09-01T00:00:00.000Z",
			scanned: 1,
			windowTotal: 1,
			scanComplete: true,
			candidates: 0,
			reviewRequired: 0,
			...reviewFacts([]),
		},
	});
	const apply = await app.request(`${endpoint}&apply=1`, { method: "POST" });
	assert.equal(apply.status, 200);
	assert.deepEqual(await apply.json(), {
		success: true,
		dryRun: false,
		data: {
			windowSince: "2026-09-01T00:00:00.000Z",
			scanned: 1,
			windowTotal: 1,
			scanComplete: true,
			candidates: 0,
			reviewRequired: 0,
			...reviewFacts([]),
		},
	});
	assert.deepEqual(counts(), { logReads: 2, ledgerReadsOrWrites: 0 });
});

test("empty first-page candidates do not make incomplete historical apply look complete", async () => {
	const { app, counts } = appFor(
		[{ id: "ordinary", provider_key_id: "provider:key-2" }],
		3
	);
	const dryRun = await app.request(endpoint, { method: "POST" });
	assert.equal(dryRun.status, 200);
	assert.deepEqual(await dryRun.json(), {
		success: true,
		dryRun: true,
		data: {
			windowSince: "2026-09-01T00:00:00.000Z",
			scanned: 1,
			windowTotal: 3,
			scanComplete: false,
			candidates: 0,
			reviewRequired: 0,
			...reviewFacts([]),
		},
	});
	const apply = await app.request(`${endpoint}&apply=1`, { method: "POST" });
	assert.equal(apply.status, 409);
	assert.deepEqual(await apply.json(), {
		success: false,
		dryRun: false,
		error:
			"Historical shared-key earnings scan is incomplete; later pages require review",
		code: "historical_earning_scan_incomplete",
		data: {
			windowSince: "2026-09-01T00:00:00.000Z",
			scanned: 1,
			windowTotal: 3,
			scanComplete: false,
			candidates: 0,
			reviewRequired: 0,
			...reviewFacts([]),
		},
	});
	assert.deepEqual(counts(), { logReads: 2, ledgerReadsOrWrites: 0 });
});

test("review DTO rejects unsafe or inconsistent storage without financial reads or writes", async () => {
	for (const [logs, total] of [
		[[{ id: "safe", provider_key_id: "sharedkey:key-1" }], -1],
		[
			[{ id: "safe", provider_key_id: "sharedkey:key-1" }],
			Number.MAX_SAFE_INTEGER + 1,
		],
		[[{ id: "sk-secret-value", provider_key_id: "sharedkey:key-1" }], 1],
		[[{ id: "bad/target", provider_key_id: "sharedkey:key-1" }], 1],
		[
			[
				{ id: "same", provider_key_id: "sharedkey:key-1" },
				{ id: "same", provider_key_id: "sharedkey:key-1" },
			],
			2,
		],
	] as const) {
		const { app, counts } = appFor([...logs], total);
		const response = await app.request(endpoint, { method: "POST" });
		assert.equal(response.status, 500);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(counts(), { logReads: 1, ledgerReadsOrWrites: 0 });
		assert.ok(!(await response.text()).includes("secret-value"));
	}
});

test("ambiguous or malformed review queries fail before any log or ledger read", async () => {
	const malformed = [
		"since=",
		"since=2026-02-30T00%3A00%3A00Z",
		"since=2026-09-01",
		"since=2026-09-01T00%3A00%3A00%2B00%3A00",
		"since=2026-09-01T24%3A00%3A00Z",
		"limit=0",
		"limit=1001",
		"limit=-1",
		"limit=1.5",
		"limit=1e2",
		"limit=%20",
		"limit=01",
		"limit=Infinity",
		"apply=true",
		"apply=",
		"apply=2",
		"apply=0&apply=1",
		"limit=20&limit=20",
		"unexpected=1",
		"since=2026-09-01T00%3A00%3A00Z&since=2026-09-01T00%3A00%3A00Z",
	];
	for (const query of malformed) {
		const { app, counts } = appFor([]);
		const response = await app.request(`/admin/earnings/rederive?${query}`, {
			method: "POST",
		});
		assert.equal(response.status, 400, query);
		assert.equal(
			response.headers.get("cache-control"),
			"private, no-store",
			query
		);
		assert.equal(
			((await response.json()) as { code: string }).code,
			"invalid_earning_review_query",
			query
		);
		assert.deepEqual(counts(), { logReads: 0, ledgerReadsOrWrites: 0 }, query);
	}
});

test("valid UTC timestamps and bounded limits are canonicalized without changing the read-only contract", async () => {
	for (const [since, normalized, limit] of [
		["2026-09-01T00:00:00Z", "2026-09-01T00:00:00.000Z", 1],
		["2026-09-01T00:00:00.1Z", "2026-09-01T00:00:00.100Z", 1000],
		["2026-09-01T00:00:00.123Z", "2026-09-01T00:00:00.123Z", 200],
	] as const) {
		const subject = appFor([
			{ id: "candidate", provider_key_id: "sharedkey:key-1" },
		]);
		const response = await subject.app.request(
			`/admin/earnings/rederive?since=${encodeURIComponent(
				since
			)}&limit=${limit}&apply=0`,
			{ method: "POST" }
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(subject.queries, [
			{ page: 1, pageSize: limit, startDate: normalized },
		]);
		assert.deepEqual(subject.counts(), { logReads: 1, ledgerReadsOrWrites: 0 });
	}
	const subject = appFor([]);
	const response = await subject.app.request("/admin/earnings/rederive", {
		method: "POST",
	});
	assert.equal(response.status, 200);
	assert.equal(subject.queries[0]?.pageSize, 200);
	const start = Date.parse(subject.queries[0]!.startDate);
	assert.ok(Math.abs(start - (Date.now() - 24 * 60 * 60 * 1000)) < 5000);
	assert.deepEqual(subject.counts(), { logReads: 1, ledgerReadsOrWrites: 0 });
});
