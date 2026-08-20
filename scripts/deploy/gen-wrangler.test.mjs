import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("generated Wrangler configs preserve HTTPS values and Workers Routes", () => {
	const env = { ...process.env };
	delete env.D1_DATABASE_ID;
	delete env.PROXY_CUSTOM_DOMAIN;
	delete env.ADMIN_CUSTOM_DOMAIN;
	const result = spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
		cwd: root,
		env,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	const admin = JSON.parse(
		readFileSync(join(root, "packages/admin/wrangler.jsonc"), "utf8"),
	);
	const proxy = JSON.parse(
		readFileSync(join(root, "packages/proxy/wrangler.jsonc"), "utf8"),
	);
	assert.equal(admin.vars.CINAAUTH_ISSUER, "https://auth.cinaseek.ai");
	assert.deepEqual(admin.routes, [
		{ pattern: "cinatoken.com/*", zone_name: "cinatoken.com" },
	]);
	assert.deepEqual(proxy.routes, [
		{ pattern: "api.cinatoken.com/*", zone_name: "cinatoken.com" },
	]);
});
