import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { IMMUTABLE_CACHE } from "../../packages/web/scripts/asset-policy.mjs";
import { verifyRelease } from "../../packages/web/scripts/package-release.mjs";

function docker(args) {
	const result = spawnSync("docker", args, {
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.error || result.status !== 0)
		throw new Error(result.error?.message ?? result.stderr);
	return result.stdout.trim();
}

// CI starts and removes only this newly created container. No deploy or auth fixture.
const id = process.argv[2];
const release = verifyRelease(process.cwd(), id);
const hash = release.manifest.files.find(
	(file) => file.path.endsWith(".js") && file.path.startsWith("static/"),
)?.path;
assert.ok(hash, "A JavaScript hash asset is required for the HTTP cache check");
const container = docker([
	"run",
	"--detach",
	"--rm",
	"--publish",
	"127.0.0.1::8080",
	"--env",
	"CINATOKEN_WEB_ACCOUNT_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_USERS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_MODELS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_ROUTES_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_PRESETS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_CONFIG_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_KEYS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_TOOLS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED=true",
	"--env",
	"CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED=true",
	"--env",
	"CINATOKEN_ADMIN_UPSTREAM=http://127.0.0.1:1",
	"cinatoken-web:check",
]);
assert.match(container, /^[a-f0-9]{64}$/);
try {
	const port = docker(["port", container, "8080/tcp"]).match(
		/^127\.0\.0\.1:(\d+)$/,
	)?.[1];
	assert.ok(port);
	const origin = `http://127.0.0.1:${port}`;
	let ready = false;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			ready =
				(
					await fetch(`${origin}/account`, {
						signal: AbortSignal.timeout(1000),
					})
				).status === 200;
		} catch {
			/* startup */
		}
		if (ready) break;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	assert.ok(ready, "Nginx entry did not become ready");
	const accountPagePaths = [
		"/account",
		"/account/keys",
		"/account/byok",
		"/account/activity",
		"/account/earnings",
		"/account/nft",
		"/account/withdraw",
		"/account/presets",
		"/account/guardrails",
		"/account/settings",
		"/admin",
		"/admin/users",
		"/admin/users/f2b74bc0-32f3-4613-aea7-96f723d08e12",
		"/admin/users/ext%3Aerp%2F42",
		"/admin/providers",
		"/admin/models",
		"/admin/endpoints",
		"/admin/routes",
		"/admin/data-policies",
		"/admin/presets",
		"/admin/guardrails",
		"/admin/analytics/reliability",
		"/admin/analytics/models",
		"/admin/analytics/providers",
		"/admin/analytics/users",
		"/admin/request-logs",
		"/admin/audit-logs",
		"/admin/tools/invocations",
		"/admin/config/timezone",
		"/admin/config",
		"/admin/admin-api-keys",
		"/admin/keys",
		"/admin/shared-keys",
		"/admin/tools",
		"/admin/playground",
		"/admin/simulator",
		"/admin/withdrawals",
		"/admin/nft-mints",
	].flatMap((path) => [path, `${path}/`]);
	for (const method of ["GET", "HEAD"]) {
		for (const [path, status, cache] of [
			...accountPagePaths.map((path) => [path, 200, "no-store"]),
			[`/web-assets/${hash}?v=1`, 200, IMMUTABLE_CACHE],
			["/web-assets/index.html", 200, "no-store"],
			["/web-assets/manifest.json", 404, "no-store"],
			["/web-assets/static/js/missing.12345678.js", 404, "no-store"],
		]) {
			const response = await fetch(`${origin}${path}`, {
				method,
				signal: AbortSignal.timeout(3000),
			});
			assert.equal(response.status, status, `${method} ${path}`);
			assert.equal(
				response.headers.get("cache-control"),
				cache,
				`${method} ${path}`,
			);
			if (method === "HEAD") assert.equal(await response.text(), "");
		}
	}
	process.stdout.write(
		"Docker Web account routes, HTTP GET/HEAD, cache, missing-asset and private-manifest checks passed\n",
	);
} finally {
	docker(["stop", "--time", "2", container]);
}
