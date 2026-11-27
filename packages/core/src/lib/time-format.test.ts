import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeApiTimeFields, normalizeApiTimeString } from "./time-format";

test("API timestamps normalize native PostgreSQL hour-only offsets and SQLite UTC", () => {
	for (const [input, expected] of [
		["2026-11-27 12:34:56+00", "2026-11-27T12:34:56.000Z"],
		["2026-11-27 12:34:56.123+00", "2026-11-27T12:34:56.123Z"],
		["2026-11-27 12:34:56.123456+00", "2026-11-27T12:34:56.123Z"],
		["2026-11-27 12:34:56-05", "2026-11-27T17:34:56.000Z"],
		["2026-11-27 12:34:56+08", "2026-11-27T04:34:56.000Z"],
		["2026-11-27 12:34:56+05:30", "2026-11-27T07:04:56.000Z"],
		["2026-11-27 12:34:56", "2026-11-27T12:34:56.000Z"],
		["2026-11-27T12:34:56.123Z", "2026-11-27T12:34:56.123Z"],
	])
		assert.equal(normalizeApiTimeString(input), expected, input);
});
test("nested API user rows normalize timestamps without changing unrelated values or mutating input", () => {
	const row = {
		created_at: "2026-11-27 12:34:56+00",
		updated_at: "2026-11-27 12:34:56.321+00",
		budget_reset_at: null,
		metadata: "2026-11-27 12:34:56+00",
	};
	const result = normalizeApiTimeFields({ success: true, data: [row] });
	assert.deepEqual(result.data[0], {
		...row,
		created_at: "2026-11-27T12:34:56.000Z",
		updated_at: "2026-11-27T12:34:56.321Z",
	});
	assert.equal(row.created_at, "2026-11-27 12:34:56+00");
	assert.equal(
		normalizeApiTimeString("invalid timestamp"),
		"invalid timestamp",
	);
	assert.equal(normalizeApiTimeString(""), "");
});
