import { createHash } from "node:crypto";
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
const docsHash = release.manifest.files.find(
	(file) =>
		file.path.startsWith("docs-assets/static/") && file.path.endsWith(".css"),
)?.path;
assert.ok(docsHash, "A documentation CSS asset is required");
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
	"CINATOKEN_WEB_DOCS_ENABLED=true",
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
	"CINATOKEN_WEB_ADMIN_MCP_ENABLED=true",
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
		"/admin/mcp",
		"/admin/withdrawals",
		"/admin/nft-mints",
	].flatMap((path) => [path, `${path}/`]);
	for (const method of ["GET", "HEAD"]) {
		for (const [path, status, cache] of [
			...accountPagePaths.map((path) => [path, 200, "no-store"]),
			...[
				"/en/docs",
				"/en/docs/",
				"/zh/docs/quickstart",
				"/zh/docs/quickstart/",
			].map((path) => [path, 200, "no-cache, no-transform"]),
			["/en/docs/missing/", 404, "no-cache, no-transform"],
			[`/${docsHash}`, 200, IMMUTABLE_CACHE],
			["/docs-assets/static/missing.12345678.css", 404, "no-store"],
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
			if (path.includes("/docs") && !path.startsWith("/docs-assets/"))
				assert.match(
					response.headers.get("content-security-policy"),
					/frame-ancestors 'none'/,
				);
			if (method === "HEAD") assert.equal(await response.text(), "");
		}
	}

	const searchMembers = release.manifest.files.filter((file) =>
		file.path.startsWith("docs-assets/search/"),
	);
	assert.ok(searchMembers.some((file) => file.path.endsWith("/pagefind.js")));
	assert.ok(searchMembers.some((file) => file.path.includes("/wasm.")));
	for (const file of searchMembers) {
		const response = await fetch(`${origin}/${file.path}`, {
			signal: AbortSignal.timeout(3000),
		});
		assert.equal(response.status, 200, file.path);
		assert.equal(response.headers.get("cache-control"), IMMUTABLE_CACHE);
		assert.equal(
			createHash("sha256")
				.update(Buffer.from(await response.arrayBuffer()))
				.digest("hex"),
			file.sha256,
			file.path,
		);
	}
	for (const prefix of ["/reference/api/catalog", "/reference/catalog"])
		for (const [name, count] of [
			["models", 206],
			["providers", 69],
			["models-by-vendor/deepseek", 4],
		])
			for (const suffix of ["", ".json"]) {
				const path = `${prefix}/${name}${suffix}`;
				const response = await fetch(origin + path);
				assert.equal(response.status, 200, path);
				assert.match(response.headers.get("content-type"), /application\/json/);
				assert.equal(response.headers.get("access-control-allow-origin"), "*");
				assert.equal(
					response.headers.get("access-control-expose-headers"),
					"ETag",
				);
				assert.match(response.headers.get("cache-control"), /max-age=300/);
				const body = await response.json();
				assert.equal(body.count, count, path);
				assert.equal(body.items.length, count);
				if (name === "providers")
					assert.ok(!JSON.stringify(body).includes("managed_environment_key"));
				const etag = response.headers.get("etag");
				assert.ok(etag);
				const cached = await fetch(origin + path, {
					headers: { "if-none-match": etag },
				});
				assert.equal(cached.status, 304, path);
				assert.equal(await cached.text(), "");
				for (const method of ["HEAD", "OPTIONS"]) {
					const read = await fetch(origin + path, { method });
					assert.equal(read.status, method === "OPTIONS" ? 204 : 200, path);
					assert.equal(await read.text(), "");
					assert.equal(read.headers.get("access-control-allow-origin"), "*");
				}
			}
	for (const path of [
		"/reference/api/catalog/missing",
		"/reference/catalog/models-by-vendor/missing.json",
	])
		for (const method of ["GET", "HEAD"]) {
			const response = await fetch(origin + path, { method });
			assert.equal(response.status, 404, path);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.match(response.headers.get("content-type"), /application\/json/);
			if (method === "GET")
				assert.deepEqual(await response.json(), {
					error: "reference_not_found",
				});
			else assert.equal(await response.text(), "");
		}
	for (const [oldPath, target] of [
		["quick-start", "quickstart"],
		["guides/api-keys", "keys"],
		["guides/models", "models"],
	]) {
		const response = await fetch(`${origin}/zh/docs/${oldPath}?from=bookmark`, {
			redirect: "manual",
		});
		assert.equal(response.status, 307);
		assert.equal(
			new URL(response.headers.get("location"), origin).pathname,
			`/zh/docs/${target}/`,
		);
		assert.equal(
			new URL(response.headers.get("location"), origin).search,
			"?from=bookmark",
		);
	}
	for (const path of ["/content-sitemap.xml", "/updates.xml"]) {
		const response = await fetch(origin + path);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type"), /application\/xml/);
		assert.match(response.headers.get("cache-control"), /max-age=300/);
		const body = await response.text();
		assert.ok(body.startsWith("<?xml"));
		if (path.includes("sitemap"))
			assert.equal([...body.matchAll(/<loc>/g)].length, 82);
		else {
			assert.equal([...body.matchAll(/<item>/g)].length, 3);
			assert.ok(!body.includes("octafuse.dev"));
		}
	}

	const disabled = docker([
		"run",
		"--detach",
		"--rm",
		"--publish",
		"127.0.0.1::8080",
		"--env",
		"CINATOKEN_WEB_DOCS_ENABLED=false",
		"--env",
		"CINATOKEN_ADMIN_UPSTREAM=http://127.0.0.1:1",
		"cinatoken-web:check",
	]);
	try {
		const disabledPort = docker(["port", disabled, "8080/tcp"]).match(
			/^127\.0\.0\.1:(\d+)$/,
		)?.[1];
		assert.ok(disabledPort);
		const base = `http://127.0.0.1:${disabledPort}`;
		let response;
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				response = await fetch(base + "/en/docs/");
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
		assert.equal(response?.status, 503);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("x-robots-tag"), "noindex");
		for (const path of [
			"/reference/api/catalog/models",
			"/content-sitemap.xml",
			`/${searchMembers[0].path}`,
		])
			assert.equal((await fetch(base + path)).status, 200, path);
	} finally {
		docker(["stop", "--time", "2", disabled]);
	}
	process.stdout.write(
		"Docker Web account routes, HTTP GET/HEAD, cache, missing-asset and private-manifest checks passed\n",
	);
} finally {
	docker(["stop", "--time", "2", container]);
}
