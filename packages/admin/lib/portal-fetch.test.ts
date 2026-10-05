import assert from "node:assert/strict";
import { test } from "node:test";
import { readRequiredPortalData } from "./portal-fetch";

test("real zero balances and successfully empty lists remain valid data", async () => {
	assert.deepEqual(
		await readRequiredPortalData(
			Response.json({ success: true, data: { balance: 0 } })
		),
		{ balance: 0 }
	);
	assert.deepEqual(
		await readRequiredPortalData(Response.json({ success: true, data: [] })),
		[]
	);
});

test("missing, rejected and non-JSON responses must not become zero balances", async () => {
	for (const response of [
		Response.json({ success: true, data: { balance: 0 } }, { status: 500 }),
		Response.json({ success: false }),
		Response.json({ success: true, data: null }),
		Response.json({ success: true }),
		new Response("Internal Server Error", { status: 500 }),
		Response.json({ success: false }, { status: 401 }),
		Response.json({ success: false }, { status: 503 }),
	])
		await assert.rejects(
			readRequiredPortalData(response),
			/Portal data unavailable/
		);
});
