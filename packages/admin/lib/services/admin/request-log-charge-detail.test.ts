import assert from "node:assert/strict";
import test from "node:test";
import type { RequestLogRow } from "@octafuse/core";
import { projectAdminRequestLogDetail } from "./request-log-detail-service";

function row(charged_wallet_cost: unknown): RequestLogRow {
	return {
		id: "charge-detail",
		input_tokens: 1,
		output_tokens: 2,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		metered_cost: "0.100000",
		charged_cost: "0.300000",
		charged_wallet_cost,
		status: "success",
		created_at: "2026-10-18 02:05:06",
		request_body: "PRIVATE",
		pricing_audit: "PRIVATE",
		future_field: "PRIVATE",
	} as unknown as RequestLogRow;
}

test("safe request detail retains wallet allocation SQL decimals, zero, absent and null without adding raw fields", () => {
	for (const [value, expected] of [
		["0.100000", 0.1],
		["0.000001", 0.000001],
		[0, 0],
		[null, null],
		[undefined, undefined],
	] as const) {
		const actual = projectAdminRequestLogDetail(row(value), "charge-detail");
		assert.equal(actual.charged_wallet_cost, expected);
		assert.equal(
			Object.hasOwn(actual, "charged_wallet_cost"),
			value !== undefined,
		);
		assert.ok(!JSON.stringify(actual).includes("PRIVATE"));
	}
});

test("malformed wallet amounts cannot escape the safe request detail boundary", () => {
	for (const value of [
		"NaN",
		"1e-6",
		"0.0000001",
		"sk-private",
		NaN,
		Infinity,
		{},
	])
		assert.throws(() =>
			projectAdminRequestLogDetail(row(value), "charge-detail"),
		);
});
