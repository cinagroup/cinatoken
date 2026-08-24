import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueList, runNpmWithEnv, runWrangler } from "./cf-deploy-lib.mjs";

test("runWrangler starts the local CLI and captures its version", () => {
	const { stdout } = runWrangler(["--version"], {
		capture: true,
		env: {
			WRANGLER_SEND_METRICS: "false",
		},
	});

	assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("runNpmWithEnv starts npm without a platform-specific shim", () => {
	assert.doesNotThrow(() => runNpmWithEnv({}, ["--version"]));
});

test("parseQueueList reads current Wrangler table output", () => {
	const output = `
┌──────────────────────────────────┬──────────────────────┬───────────┐
│ id                               │ name                 │ producers │
├──────────────────────────────────┼──────────────────────┼───────────┤
│ 1c134ae8a491490ea5ca8d0de8865308 │ cinatoken-chain-jobs │ 0         │
└──────────────────────────────────┴──────────────────────┴───────────┘`;
	assert.deepEqual(parseQueueList(output), [{ name: "cinatoken-chain-jobs" }]);
});
