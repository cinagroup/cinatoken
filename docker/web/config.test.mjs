import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
	SOURCE_ARCHIVE_PATTERN,
	assetCacheControl,
	isHashedAsset,
	isRetainableAsset,
	isSourceArchiveAsset,
} from "../../packages/web/scripts/asset-policy.mjs";
import { webProxyConnectSources } from "../../packages/web/scripts/proxy-origin-policy.mjs";
import { publicHttpRoute } from "../../packages/web/src/cinatoken/public-server/http-policy.ts";

const template = readFileSync(
	new URL("./nginx.conf.template", import.meta.url),
	"utf8",
);
const proxy = readFileSync(
	new URL("./admin-proxy.conf", import.meta.url),
	"utf8",
);
const entrypoint = readFileSync(
	new URL("./entrypoint.sh", import.meta.url),
	"utf8",
);
const dockerfile = readFileSync(
	new URL("../../Dockerfile.web", import.meta.url),
	"utf8",
);
const ssrDockerfile = readFileSync(
	new URL("../../Dockerfile.web-ssr", import.meta.url),
	"utf8",
);

const posixShell =
	process.platform === "win32" ? "C:/Program Files/Git/usr/bin/sh.exe" : "sh";
const proxyPolicyPrefix = entrypoint.split(
	'case "$CINATOKEN_WEB_ACCOUNT_ENABLED"',
)[0];

function runProxyPolicy(value) {
	return spawnSync(posixShell, ["-s"], {
		input: `${proxyPolicyPrefix}\nprintf '%s' "$CINATOKEN_WEB_PROXY_CONNECT_SRC"\n`,
		env: {
			...process.env,
			PATH: process.platform === "win32" ? "/usr/bin:/bin" : process.env.PATH,
			CINATOKEN_WEB_PROXY_ORIGINS: value,
			// Derived sources must overwrite even an injected preexisting variable.
			CINATOKEN_WEB_PROXY_CONNECT_SRC: '"; add_header Injected yes; #',
		},
		encoding: "utf8",
	});
}

test("actual POSIX entrypoint derives only trusted CSP sources with JavaScript parity", (t) => {
	const probe = runProxyPolicy("");
	if (probe.error?.code === "ENOENT") {
		t.skip("A POSIX shell is required for the runtime policy parity test");
		return;
	}
	assert.equal(probe.status, 0, probe.stderr);
	for (const value of [
		"",
		"   ",
		"https://proxy.example.com",
		"https://proxy.example.com:443",
		"https://192.0.2.10:65535",
		"http://localhost:8787,http://127.0.0.1:8787,http://[::1]:8787",
		"https://proxy.example.com, https://other.example.com:9443,https://proxy.example.com",
		`https://${"a".repeat(63)}.example:1`,
		"https://xn--bcher-kva.example",
		Array.from(
			{ length: 16 },
			(_, index) => `https://proxy${index}.example.com`,
		).join(","),
	]) {
		const result = runProxyPolicy(value);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, webProxyConnectSources(value));
		const rendered = template.replace(
			"${CINATOKEN_WEB_PROXY_CONNECT_SRC}",
			result.stdout,
		);
		assert.ok(rendered.includes(`connect-src ${result.stdout}; worker-src`));
		assert.doesNotMatch(rendered, /add_header Injected/);
		assert.ok(rendered.includes("$request_uri"));
	}
});

test("actual POSIX policy rejects malicious and ambiguous origins before substitution", (t) => {
	const probe = runProxyPolicy("");
	if (probe.error?.code === "ENOENT") {
		t.skip("A POSIX shell is required for malicious configuration tests");
		return;
	}
	for (const value of [
		"*",
		"wss://proxy.example.com",
		"http://proxy.example.com",
		"http://127.0.0.2",
		"https://*.example.com",
		"https://user:do-not-echo@proxy.example.com",
		"https://proxy.example.com/",
		"https://proxy.example.com/v1",
		"https://proxy.example.com?x=1",
		"https://proxy.example.com#x",
		'https://proxy.example.com"; add_header Injected yes; #',
		"https://proxy.example.com; connect-src *",
		"https://proxy.example.com\nhttps://other.example.com",
		"https://proxy.example.com\r",
		"https://proxy.example.com\t",
		"https://proxy.example.com\\evil",
		"https://proxy.example.com$host",
		"https://proxy.example.com%0a",
		"https://PROXY.example.com",
		"https://例子.com",
		"https://proxy.example.com.",
		"https://-proxy.example.com",
		"https://proxy-.example.com",
		"https://a_b.example.com",
		"https://proxy..example.com",
		"https://proxy.123",
		"https://0x7f000001",
		"https://2130706433",
		"https://127.1",
		"https://127.000.0.1",
		"https://256.0.0.1",
		"https://[2001:db8::1]",
		"https://proxy.example.com:0",
		"https://proxy.example.com:0443",
		"https://proxy.example.com:65536",
		"https://proxy.example.com:",
		",https://proxy.example.com",
		"https://proxy.example.com,",
		"https://proxy.example.com,,https://other.example.com",
		`https://${"a".repeat(64)}.example.com`,
		Array(17).fill("https://proxy.example.com").join(","),
		"a".repeat(4097),
	]) {
		assert.throws(() => webProxyConnectSources(value), undefined, value);
		const result = runProxyPolicy(value);
		assert.equal(result.status, 1, value);
		assert.equal(result.stdout, "");
		assert.equal(
			result.stderr.trim(),
			"CINATOKEN_WEB_PROXY_ORIGINS must contain at most 16 trusted HTTP(S) origins",
		);
	}
});

test("Docker substitutes derived CSP sources only and the shipped script passes POSIX syntax", (t) => {
	assert.match(dockerfile, /ENV CINATOKEN_WEB_PROXY_ORIGINS=""/);
	assert.match(template, /connect-src \$\{CINATOKEN_WEB_PROXY_CONNECT_SRC\};/);
	assert.doesNotMatch(template, /CINATOKEN_WEB_PROXY_ORIGINS/);
	const substitutions = entrypoint.match(/envsubst '([^']+)'/)?.[1];
	assert.ok(substitutions.includes("${CINATOKEN_WEB_PROXY_CONNECT_SRC}"));
	assert.ok(!substitutions.includes("${CINATOKEN_WEB_PROXY_ORIGINS}"));
	assert.doesNotMatch(entrypoint, /\r/);
	const result = spawnSync(posixShell, ["-n"], {
		input: entrypoint,
		encoding: "utf8",
	});
	if (result.error?.code === "ENOENT") {
		t.skip("A POSIX shell is required for syntax verification");
		return;
	}
	assert.equal(result.status, 0, result.stderr);
});

test("public SSR map agrees with the HTTP adapter and preserves disabled and private fallback", () => {
	const publicMap = template.match(
		/map "\$\{CINATOKEN_WEB_PUBLIC_ENABLED\}:[^"]+" \$web_public_ssr \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(publicMap);
	const patterns = [...publicMap.matchAll(/"(~\^true:[^"]+)" 1;/g)].map(
		(match) => new RegExp(match[1].slice(1)),
	);
	const matches = (enabled, method, path) =>
		patterns.some((pattern) => pattern.test(`${enabled}:${method}:${path}`));
	const paths = [
		"/",
		"/models",
		"/models/vendor/slug",
		"/providers",
		"/compare",
		"/chat",
		"/rankings",
		"/benchmarks",
		"/robots.txt",
		"/sitemap.xml",
		"/fr/models",
		"/en/missing",
		...["en", "zh", "ja", "ko"].flatMap((locale) =>
			[
				"",
				"/models",
				"/models/vendor/slug",
				"/providers",
				"/compare",
				"/chat",
				"/rankings",
				"/benchmarks",
			].map((path) => `/${locale}${path}`),
		),
	];
	for (const path of paths) {
		for (const method of ["GET", "HEAD"]) {
			assert.ok(
				publicHttpRoute(
					new URL(path + "?model=a%2Fb", "https://public.example"),
				),
				path,
			);
			assert.equal(matches("true", method, path + "?model=a%2Fb"), true, path);
			assert.equal(matches("false", method, path), false, path);
		}
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
			assert.equal(matches("true", method, path), false, path);
	}
	for (const path of [
		"/api/public/catalog/models",
		"/api/chat/completions",
		"/account",
		"/admin",
		"/admin/models",
		"/models-extra",
		"/_next/static/a.js",
		"/web-assets/index.html",
	]) {
		assert.equal(matches("true", "GET", path), false, path);
		assert.equal(
			publicHttpRoute(new URL(path, "https://public.example")),
			null,
			path,
		);
	}
	assert.match(dockerfile, /CINATOKEN_WEB_PUBLIC_ENABLED=false/);
	assert.match(entrypoint, /CINATOKEN_WEB_PUBLIC_ENABLED:=false/);
});

test("SSR proxy strips credentials, pairs releases and handles nginx transport failures safely", () => {
	const ssr = template.match(/location @public_ssr \{([\s\S]*?)\n    \}/)?.[1];
	const unavailable = template.match(
		/location @public_ssr_unavailable \{([\s\S]*?)\n    \}/,
	)?.[1];
	assert.ok(ssr && unavailable);
	assert.match(ssr, /proxy_set_header Cookie "";/);
	assert.match(ssr, /proxy_set_header Authorization "";/);
	assert.match(
		ssr,
		/X-CinaToken-Web-Manifest "\$\{CINATOKEN_WEB_MANIFEST_SHA\}";/,
	);
	assert.match(ssr, /proxy_intercept_errors off;/);
	assert.match(ssr, /error_page 502 504 =503 @public_ssr_unavailable;/);
	assert.match(ssr, /add_header Cache-Control no-store always;/);
	assert.match(unavailable, /return 503 /);
	assert.match(unavailable, /Cache-Control no-store always;/);
	assert.match(unavailable, /X-Robots-Tag "noindex, nofollow" always;/);
	assert.match(unavailable, /Retry-After 30 always;/);
});

test("Docker shell map exposes all twenty opt-in GET/HEAD account paths", () => {
	const accountMap = template.match(
		/map "\$\{CINATOKEN_WEB_ACCOUNT_ENABLED\}:[^"]+" \$web_account_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(accountMap);
	const expressions = [...accountMap.matchAll(/"(~\^true:[^"]+)" 1;/g)].map(
		(match) => match[1].slice(1),
	);
	assert.equal(expressions.length, 10);
	const allowed = expressions.map((expression) => new RegExp(expression));
	for (const path of [
		"/account",
		"/account/",
		"/account/keys",
		"/account/keys/",
		"/account/byok",
		"/account/byok/",
		"/account/activity",
		"/account/activity/",
		"/account/earnings",
		"/account/earnings/",
		"/account/nft",
		"/account/nft/",
		"/account/withdraw",
		"/account/withdraw/",
		"/account/presets",
		"/account/presets/",
		"/account/guardrails",
		"/account/guardrails/",
		"/account/settings",
		"/account/settings/",
	]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(
				allowed.some((pattern) => pattern.test(`true:${method}:${path}`)),
			);
		assert.ok(
			allowed.some((pattern) => pattern.test(`true:GET:${path}?tab=keys`)),
		);
		assert.equal(
			allowed.some((pattern) => pattern.test(`false:GET:${path}`)),
			false,
		);
		assert.equal(
			allowed.some((pattern) => pattern.test(`true:POST:${path}`)),
			false,
		);
	}
	for (const path of [
		"/account/withdraw/detail",
		"/account/presets/detail",
		"/account/guardrails/detail",
		"/account/settings/profile",
		"/account/%77ithdraw",
		"/account/guardrails//",
		"/account/keys/detail",
		"/account/byok/detail",
		"/account/activity/detail",
		"/account/earnings/detail",
		"/account/nft/detail",
		"/account/%65arnings",
		"/account/nft//",
		"/account/%61ctivity",
		"/account/byok//",
		"/account/%62yok",
		"/account%2fbyok",
		"/ACCOUNT",
		"/%61ccount",
		"/account%2fkeys",
		"/admin",
		"/",
		"/api/auth/cinaauth/callback",
	]) {
		assert.equal(
			allowed.some((pattern) => pattern.test(`true:GET:${path}`)),
			false,
		);
	}
});

test("Docker Providers rollout captures only the migrated page and is disabled by default", () => {
	const map = template.match(
		/map "\$\{CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED\}:[^"]+" \$web_admin_provider_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
	assert.ok(expression);
	const allowed = new RegExp(expression.slice(1));
	for (const path of [
		"/admin/providers",
		"/admin/providers/",
		"/admin/providers?q=alpha&filter=active",
	]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(allowed.test(`true:${method}:${path}`));
		for (const flag of ["false", "TRUE", "1", ""])
			assert.equal(allowed.test(`${flag}:GET:${path}`), false);
		for (const method of ["POST", "PATCH", "DELETE"])
			assert.equal(allowed.test(`true:${method}:${path}`), false);
	}
	for (const path of [
		"/admin",
		"/admin/models",
		"/admin/providers/detail",
		"/admin/providers//",
		"/admin/%70roviders",
		"/account",
		"/api/admin/providers",
	])
		assert.equal(allowed.test(`true:GET:${path}`), false);
	assert.match(
		template,
		/if \(\$web_admin_provider_shell = 1\) \{ return 418; \}/,
	);
	assert.match(entrypoint, /CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED:=false/);
	assert.match(dockerfile, /CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED=false/);
});

test("Docker Dashboard rollout serves only exact GET/HEAD /admin and defaults off", () => {
	const map = template.match(
		/map "\$\{CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED\}:[^"]+" \$web_admin_dashboard_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
	assert.ok(expression);
	const allowed = new RegExp(expression.slice(1));
	for (const path of ["/admin", "/admin/", "/admin?range=7d"]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(allowed.test(`true:${method}:${path}`));
		for (const method of ["POST", "PATCH", "DELETE"])
			assert.equal(allowed.test(`true:${method}:${path}`), false);
		for (const flag of ["false", "TRUE", "1", ""])
			assert.equal(allowed.test(`${flag}:GET:${path}`), false);
	}
	for (const path of [
		"/dashboard",
		"/admin/providers",
		"/admin/config",
		"/admin/detail",
		"/admin//",
		"/ad%6din",
		"/api/admin/stats",
		"/account",
	])
		assert.equal(allowed.test(`true:GET:${path}`), false);
	assert.match(
		template,
		/if \(\$web_admin_dashboard_shell = 1\) \{ return 418; \}/,
	);
	assert.match(entrypoint, /CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED:=false/);
	assert.match(dockerfile, /CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED=false/);
});

test("Docker Users rollout serves only exact GET/HEAD list paths and defaults off", () => {
	const map = template.match(
		/map "\$\{CINATOKEN_WEB_ADMIN_USERS_ENABLED\}:[^"]+" \$web_admin_users_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
	assert.ok(expression);
	const allowed = new RegExp(expression.slice(1));
	for (const path of ["/admin/users", "/admin/users/", "/admin/users?page=2"]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(allowed.test(`true:${method}:${path}`));
		for (const method of ["POST", "PATCH", "DELETE"])
			assert.equal(allowed.test(`true:${method}:${path}`), false);
		for (const flag of ["false", "TRUE", "1", ""])
			assert.equal(allowed.test(`${flag}:GET:${path}`), false);
	}
	for (const path of [
		"/admin",
		"/admin/users/123",
		"/admin/users//",
		"/admin/%75sers",
		"/api/admin/users",
		"/account",
	])
		assert.equal(allowed.test(`true:GET:${path}`), false);
	assert.match(
		template,
		/if \(\$web_admin_users_shell = 1\) \{ return 418; \}/,
	);
	assert.match(entrypoint, /CINATOKEN_WEB_ADMIN_USERS_ENABLED:=false/);
	assert.match(dockerfile, /CINATOKEN_WEB_ADMIN_USERS_ENABLED=false/);
});

test("Docker User Detail rollout admits only UUID and simple canonical ext paths", () => {
	const map = template.match(
		/map "\$\{CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED\}:[^"]+" \$web_admin_user_detail_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
	assert.ok(expression);
	const allowed = new RegExp(expression.slice(1));
	const id = "f2b74bc0-32f3-4613-aea7-96f723d08e12";
	for (const path of [
		`/admin/users/${id}`,
		`/admin/users/${id}/`,
		`/admin/users/${id}?keep=1`,
		"/admin/users/ext%3Aerp%2F42",
		"/admin/users/ext%3Aerp%2F42/",
		"/admin/users/ext%3Aerp%2F42?keep=1",
	]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(allowed.test(`true:${method}:${path}`), `${method} ${path}`);
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
			assert.equal(allowed.test(`true:${method}:${path}`), false);
		for (const flag of ["false", "TRUE", "1", ""])
			assert.equal(allowed.test(`${flag}:GET:${path}`), false);
	}
	for (const path of [
		"/admin/users",
		"/admin/users/",
		"/admin/users/123",
		`/admin/users/${id}/keys`,
		`/admin/users/${id}//`,
		`/admin/users/${id}%2Fkeys`,
		`/admin/users/${id}%252Fkeys`,
		"/admin/users/ext%3Aerp%2Fabc%252F42",
		"/admin/users/ext%3Aerp%2Fabc%2F42",
		"/admin/users/ext%3Aerp%2Fa%0Ab",
		"/admin/users/ext%3Aerp%1F42",
		"/admin/users/ext%3Aerp%2F",
		"/admin/users/ext%3A%2F42",
		"/admin/users/ext%3Aerp%2F42/keys",
		"/admin/users/ext:erp/42",
		"/admin/users/ext%3aerp%2f42",
		`/admin/%75sers/${id}`,
		`/ADMIN/users/${id}`,
		`/api/admin/users/${id}`,
	])
		assert.equal(allowed.test(`true:GET:${path}`), false, path);
	assert.match(
		template,
		/if \(\$web_admin_user_detail_shell = 1\) \{ return 418; \}/,
	);
	assert.match(entrypoint, /CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED:=false/);
	assert.match(dockerfile, /CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED=false/);
});

test("Docker Models rollout serves only its GET/HEAD paths and defaults off", () => {
	const map = template.match(
		/map "\$\{CINATOKEN_WEB_ADMIN_MODELS_ENABLED\}:[^"]+" \$web_admin_model_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
	assert.ok(expression);
	const allowed = new RegExp(expression.slice(1));
	for (const path of [
		"/admin/models",
		"/admin/models/",
		"/admin/models?q=test",
	]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(allowed.test(`true:${method}:${path}`));
		for (const method of ["POST", "PATCH", "DELETE"])
			assert.equal(allowed.test(`true:${method}:${path}`), false);
		for (const flag of ["false", "TRUE", "1", ""])
			assert.equal(allowed.test(`${flag}:GET:${path}`), false);
	}
	for (const path of [
		"/admin",
		"/admin/providers",
		"/account",
		"/models",
		"/admin/models/detail",
		"/admin/models//",
		"/admin/%6dodels",
		"/api/admin/models",
	])
		assert.equal(allowed.test(`true:GET:${path}`), false);
	assert.match(
		template,
		/if \(\$web_admin_model_shell = 1\) \{ return 418; \}/,
	);
	assert.match(entrypoint, /CINATOKEN_WEB_ADMIN_MODELS_ENABLED:=false/);
	assert.match(dockerfile, /CINATOKEN_WEB_ADMIN_MODELS_ENABLED=false/);
});

test("Docker Endpoints rollout serves only its GET/HEAD paths and defaults off", () => {
	const map = template.match(
		/map "\$\{CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED\}:[^"]+" \$web_admin_endpoint_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
	assert.ok(expression);
	const allowed = new RegExp(expression.slice(1));
	for (const path of [
		"/admin/endpoints",
		"/admin/endpoints/",
		"/admin/endpoints?q=test",
	]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(allowed.test(`true:${method}:${path}`));
		for (const method of ["POST", "PATCH", "DELETE"])
			assert.equal(allowed.test(`true:${method}:${path}`), false);
		for (const flag of ["false", "TRUE", "1", ""])
			assert.equal(allowed.test(`${flag}:GET:${path}`), false);
	}
	for (const path of [
		"/admin",
		"/admin/providers",
		"/admin/models",
		"/account",
		"/admin/endpoints/detail",
		"/admin/endpoints//",
		"/admin/%65ndpoints",
		"/api/admin/endpoints",
	])
		assert.equal(allowed.test(`true:GET:${path}`), false);
	assert.match(
		template,
		/if \(\$web_admin_endpoint_shell = 1\) \{ return 418; \}/,
	);
	assert.match(entrypoint, /CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED:=false/);
	assert.match(dockerfile, /CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED=false/);
});

test("Docker Routes rollout serves only its GET/HEAD paths and defaults off", () => {
	const map = template.match(
		/map "\$\{CINATOKEN_WEB_ADMIN_ROUTES_ENABLED\}:[^"]+" \$web_admin_route_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
	assert.ok(expression);
	const allowed = new RegExp(expression.slice(1));
	for (const path of [
		"/admin/routes",
		"/admin/routes/",
		"/admin/routes?q=alpha",
	]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(allowed.test(`true:${method}:${path}`));
		for (const method of ["POST", "PATCH", "DELETE"])
			assert.equal(allowed.test(`true:${method}:${path}`), false);
		for (const flag of ["false", "TRUE", "1", ""])
			assert.equal(allowed.test(`${flag}:GET:${path}`), false);
	}
	for (const path of [
		"/admin",
		"/admin/providers",
		"/admin/models",
		"/admin/endpoints",
		"/account",
		"/admin/routes/detail",
		"/admin/routes//",
		"/admin/%72outes",
		"/api/admin/routes",
	])
		assert.equal(allowed.test(`true:GET:${path}`), false);
	assert.match(
		template,
		/if \(\$web_admin_route_shell = 1\) \{ return 418; \}/,
	);
	assert.match(entrypoint, /CINATOKEN_WEB_ADMIN_ROUTES_ENABLED:=false/);
	assert.match(dockerfile, /CINATOKEN_WEB_ADMIN_ROUTES_ENABLED=false/);
});

test("Docker Data Policies rollout serves only its GET/HEAD paths and defaults off", () => {
	const map = template.match(
		/map "\$\{CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED\}:[^"]+" \$web_admin_data_policy_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
	assert.ok(expression);
	const allowed = new RegExp(expression.slice(1));
	for (const path of [
		"/admin/data-policies",
		"/admin/data-policies/",
		"/admin/data-policies?q=alpha",
	]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(allowed.test(`true:${method}:${path}`));
		for (const method of ["POST", "PATCH", "DELETE"])
			assert.equal(allowed.test(`true:${method}:${path}`), false);
		for (const flag of ["false", "TRUE", "1", ""])
			assert.equal(allowed.test(`${flag}:GET:${path}`), false);
	}
	for (const path of [
		"/admin",
		"/admin/routes",
		"/account",
		"/admin/data-policies/detail",
		"/admin/data-policies//",
		"/admin/%64ata-policies",
		"/api/admin/data-policies",
	])
		assert.equal(allowed.test(`true:GET:${path}`), false);
	assert.match(
		template,
		/if \(\$web_admin_data_policy_shell = 1\) \{ return 418; \}/,
	);
	assert.match(entrypoint, /CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED:=false/);
	assert.match(dockerfile, /CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED=false/);
});

test("Docker Presets rollout serves only its GET/HEAD paths and defaults off", () => {
	const map = template.match(
		/map "\$\{CINATOKEN_WEB_ADMIN_PRESETS_ENABLED\}:[^"]+" \$web_admin_presets_shell \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
	assert.ok(expression);
	const allowed = new RegExp(expression.slice(1));
	for (const path of [
		"/admin/presets",
		"/admin/presets/",
		"/admin/presets?q=alpha",
	]) {
		for (const method of ["GET", "HEAD"])
			assert.ok(allowed.test(`true:${method}:${path}`));
		for (const method of ["POST", "PATCH", "DELETE"])
			assert.equal(allowed.test(`true:${method}:${path}`), false);
		for (const flag of ["false", "TRUE", "1", ""])
			assert.equal(allowed.test(`${flag}:GET:${path}`), false);
	}
	for (const path of [
		"/admin",
		"/admin/data-policies",
		"/account/presets",
		"/admin/presets/detail",
		"/admin/presets//",
		"/admin/%70resets",
		"/api/admin/presets",
	])
		assert.equal(allowed.test(`true:GET:${path}`), false);
	assert.match(
		template,
		/if \(\$web_admin_presets_shell = 1\) \{ return 418; \}/,
	);
	assert.match(entrypoint, /CINATOKEN_WEB_ADMIN_PRESETS_ENABLED:=false/);
	assert.match(dockerfile, /CINATOKEN_WEB_ADMIN_PRESETS_ENABLED=false/);
});

for (const rollout of [
	{
		name: "Withdrawals",
		flag: "CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED",
		shell: "web_admin_withdrawals_shell",
		path: "/admin/withdrawals",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED\}:[^"]+" \$web_admin_withdrawals_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "NFT Mints",
		flag: "CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED",
		shell: "web_admin_nft_mints_shell",
		path: "/admin/nft-mints",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED\}:[^"]+" \$web_admin_nft_mints_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Playground",
		flag: "CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED",
		shell: "web_admin_playground_shell",
		path: "/admin/playground",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED\}:[^"]+" \$web_admin_playground_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Simulator",
		flag: "CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED",
		shell: "web_admin_simulator_shell",
		path: "/admin/simulator",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED\}:[^"]+" \$web_admin_simulator_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Tools Configuration",
		flag: "CINATOKEN_WEB_ADMIN_TOOLS_ENABLED",
		shell: "web_admin_tools_shell",
		path: "/admin/tools",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_TOOLS_ENABLED\}:[^"]+" \$web_admin_tools_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Tool Invocations",
		flag: "CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED",
		shell: "web_admin_tool_invocations_shell",
		path: "/admin/tools/invocations",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED\}:[^"]+" \$web_admin_tool_invocations_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Budget Audit",
		flag: "CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED",
		shell: "web_admin_budget_audit_shell",
		path: "/admin/audit-logs",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED\}:[^"]+" \$web_admin_budget_audit_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Request Logs",
		flag: "CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED",
		shell: "web_admin_request_logs_shell",
		path: "/admin/request-logs",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED\}:[^"]+" \$web_admin_request_logs_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Users analytics",
		flag: "CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED",
		shell: "web_admin_user_analytics_shell",
		path: "/admin/analytics/users",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED\}:[^"]+" \$web_admin_user_analytics_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Providers analytics",
		flag: "CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED",
		shell: "web_admin_provider_analytics_shell",
		path: "/admin/analytics/providers",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED\}:[^"]+" \$web_admin_provider_analytics_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Models analytics",
		flag: "CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED",
		shell: "web_admin_model_analytics_shell",
		path: "/admin/analytics/models",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED\}:[^"]+" \$web_admin_model_analytics_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Reliability",
		flag: "CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED",
		shell: "web_admin_reliability_shell",
		path: "/admin/analytics/reliability",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED\}:[^"]+" \$web_admin_reliability_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Guardrails",
		flag: "CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED",
		shell: "web_admin_guardrails_shell",
		path: "/admin/guardrails",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED\}:[^"]+" \$web_admin_guardrails_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Config timezone",
		flag: "CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED",
		shell: "web_admin_config_timezone_shell",
		path: "/admin/config/timezone",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED\}:[^"]+" \$web_admin_config_timezone_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Full config",
		flag: "CINATOKEN_WEB_ADMIN_CONFIG_ENABLED",
		shell: "web_admin_config_shell",
		path: "/admin/config",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_CONFIG_ENABLED\}:[^"]+" \$web_admin_config_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Integration Keys",
		flag: "CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED",
		shell: "web_admin_access_keys_shell",
		path: "/admin/admin-api-keys",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED\}:[^"]+" \$web_admin_access_keys_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Gateway Keys",
		flag: "CINATOKEN_WEB_ADMIN_KEYS_ENABLED",
		shell: "web_admin_keys_shell",
		path: "/admin/keys",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_KEYS_ENABLED\}:[^"]+" \$web_admin_keys_shell \{([\s\S]*?)\n\}/,
	},
	{
		name: "Shared Keys",
		flag: "CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED",
		shell: "web_admin_shared_keys_shell",
		path: "/admin/shared-keys",
		map: /map "\$\{CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED\}:[^"]+" \$web_admin_shared_keys_shell \{([\s\S]*?)\n\}/,
	},
]) {
	test(`Docker ${rollout.name} rollout serves only its GET/HEAD paths and defaults off`, () => {
		const map = template.match(rollout.map)?.[1];
		assert.ok(map);
		const expression = map.match(/"(~\^true:[^"]+)" 1;/)?.[1];
		assert.ok(expression);
		const allowed = new RegExp(expression.slice(1));
		for (const path of [
			rollout.path,
			`${rollout.path}/`,
			`${rollout.path}?q=alpha`,
		]) {
			for (const method of ["GET", "HEAD"])
				assert.ok(allowed.test(`true:${method}:${path}`));
			for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
				assert.equal(allowed.test(`true:${method}:${path}`), false);
			for (const flag of ["false", "TRUE", "1", ""])
				assert.equal(allowed.test(`${flag}:GET:${path}`), false);
		}
		for (const path of [
			"/admin",
			...(rollout.path === "/admin/config"
				? ["/admin/config/timezone"]
				: ["/admin/config"]),
			...(rollout.path === "/admin/analytics/reliability"
				? [
						"/admin/analytics/models",
						"/admin/analytics/providers",
						"/admin/analytics/users",
						"/admin/analytics/reliability//",
						"/admin/analytics/%72eliability",
					]
				: ["/admin/analytics/reliability"]),
			...(rollout.path === "/admin/analytics/models"
				? [
						"/admin/analytics/providers",
						"/admin/analytics/users",
						"/admin/analytics/%6dodels",
					]
				: []),
			...(rollout.path === "/admin/analytics/providers"
				? [
						"/admin/analytics/models",
						"/admin/analytics/users",
						"/admin/analytics/%70roviders",
						"/admin/providers",
					]
				: []),
			...(rollout.path === "/admin/analytics/users"
				? [
						"/admin/analytics/models",
						"/admin/analytics/providers",
						"/admin/analytics/%75sers",
						"/admin/users",
					]
				: []),
			...(rollout.path === "/admin/request-logs"
				? [
						"/admin/request-logs-extra",
						"/admin/%72equest-logs",
						"/admin/analytics/users",
						"/admin/users",
					]
				: []),
			...(rollout.path === "/admin/audit-logs"
				? [
						"/admin/audit-logs-extra",
						"/admin/%61udit-logs",
						"/admin/audit-logs%2f",
						"/admin/request-logs",
						"/api/admin/budget-audit-logs",
						"/api/admin/budget-audit-logs/filters",
					]
				: []),
			...(rollout.path === "/admin/tools"
				? [
						"/gateway/tools",
						"/admin/tools/invocations",
						"/admin/tools/invocations/",
						"/admin/%74ools",
						"/admin/tools%2F",
						"/admin//tools",
						"/admin/tools-extra",
						"/api/admin/config/tools/overview",
						"/api/admin/config/tools/web-search/audit",
					]
				: []),
			...(rollout.path === "/admin/tools/invocations"
				? [
						"/admin/tools",
						"/admin/tools/invocations-extra",
						"/admin/tools/%69nvocations",
						"/admin/tools/invocations%2f",
						"/api/admin/request-logs",
						"/api/admin/tools/invocations",
						"/admin/request-logs",
					]
				: []),
			...(rollout.path === "/admin/admin-api-keys"
				? [
						"/admin/access-keys",
						"/admin/admin-api-keys-extra",
						"/admin/%61dmin-api-keys",
						"/admin/admin-api-keys%2F",
						"/api/admin/access-keys",
						"/api/admin/access-keys/key-1/secret",
						"/admin/shared-keys",
					]
				: []),
			...(rollout.path === "/admin/keys"
				? [
						"/gateway/keys",
						"/admin/keys-extra",
						"/admin/%6beys",
						"/admin/keys%2F",
						"/admin//keys",
						"/api/admin/keys/key-1",
						"/api/admin/keys/key-1/secret",
						"/admin/admin-api-keys",
						"/account/keys",
					]
				: []),
			"/account",
			...(rollout.path === "/admin/shared-keys"
				? [
						"/gateway/shared-keys",
						"/admin/shared-keys-extra",
						"/admin/%73hared-keys",
						"/admin/shared-keys%2F",
						"/admin//shared-keys",
						"/api/admin/shared-keys/overview",
						"/api/admin/shared-keys/key-1/audit",
						"/api/admin/earnings/rederive",
						"/admin/earnings",
						"/account/earnings",
					]
				: []),
			`${rollout.path}/detail`,
			`${rollout.path}//`,
			`/api${rollout.path}`,
		])
			assert.equal(allowed.test(`true:GET:${path}`), false);
		assert.match(
			template,
			new RegExp(`if \\(\\$${rollout.shell} = 1\\) \\{ return 418; \\}`),
		);
		assert.match(entrypoint, new RegExp(`${rollout.flag}:=false`));
		assert.match(dockerfile, new RegExp(`${rollout.flag}=false`));
	});
}

for (const flag of [
	"CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED",
	"CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED",
	"CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED",
	"CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED",
	"CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED",
	"CINATOKEN_WEB_ADMIN_KEYS_ENABLED",
	"CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED",
	"CINATOKEN_WEB_ADMIN_TOOLS_ENABLED",
	"CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED",
	"CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED",
	"CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED",
	"CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED",
]) {
	test(`Docker ${flag} rejects invalid values before nginx starts`, () => {
		const validation = entrypoint.match(
			new RegExp(`case "\\$${flag}" in([\\s\\S]*?)esac`),
		)?.[1];
		assert.ok(validation);
		assert.match(validation, /true\|false\) ;;/);
		assert.match(validation, new RegExp(`${flag} must be true or false`));
	});
}

test("Docker forwards public host with port, scheme, full URI and streams without origin/cookie rewriting", () => {
	assert.match(proxy, /proxy_set_header Host \$http_host;/);
	assert.match(proxy, /proxy_set_header X-Forwarded-Host \$http_host;/);
	assert.match(proxy, /proxy_set_header X-Forwarded-Proto \$web_public_proto;/);
	assert.match(template, /map \$http_x_forwarded_proto \$web_public_proto/);
	assert.match(proxy, /proxy_pass \$web_admin_origin\$request_uri;/);
	assert.match(proxy, /proxy_buffering off;/);
	assert.match(proxy, /proxy_request_buffering off;/);
	assert.match(proxy, /proxy_redirect off;/);
	assert.doesNotMatch(
		proxy,
		/proxy_(?:hide_header|cookie_domain|cookie_path|set_header\s+(?:Origin|Cookie))/i,
	);
});

test("Docker assets have no SPA fallback and environment substitution preserves nginx variables", () => {
	assert.match(template, /location \^~ \/web-assets\/\s*\{/);
	assert.match(template, /alias \/usr\/share\/nginx\/html\//);
	assert.match(template, /try_files \/index\.html =503/);
	assert.doesNotMatch(template, /try_files.*\$uri.*index\.html/);
	assert.match(
		entrypoint,
		/envsubst '\$\{CINATOKEN_WEB_PUBLIC_ENABLED\} \$\{CINATOKEN_WEB_SSR_UPSTREAM\} \$\{CINATOKEN_WEB_MANIFEST_SHA\} \$\{CINATOKEN_ADMIN_UPSTREAM\} \$\{CINATOKEN_WEB_ACCOUNT_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_USERS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_MODELS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_ROUTES_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_PRESETS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_CONFIG_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_KEYS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_TOOLS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED\} \$\{CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED\} \$\{CINATOKEN_WEB_DNS_RESOLVER\} \$\{CINATOKEN_WEB_PROXY_CONNECT_SRC\}'/,
	);
	assert.match(entrypoint, /nginx -t/);
	assert.match(dockerfile, /CINATOKEN_WEB_ACCOUNT_ENABLED=false/);
});

test("Source retention and caching recognize only the exact digest archive path", () => {
	const archive = `sources/web.${"a".repeat(64)}.tar.gz`;
	assert.equal(SOURCE_ARCHIVE_PATTERN, "sources/web[.][a-f0-9]{64}[.]tar[.]gz");
	assert.ok(isSourceArchiveAsset(archive));
	assert.ok(isRetainableAsset(archive));
	assert.equal(isHashedAsset(archive), false);
	assert.ok(isRetainableAsset("static/js/app.12345678.js"));
	assert.equal(isSourceArchiveAsset("static/js/app.12345678.js"), false);
	for (const path of [
		"sources/index.html",
		"sources/index.HTML",
		"sources/manifest.json",
		"sources/archive.tar.gz",
		`sources/web.${"a".repeat(63)}.tar.gz`,
		`sources/web.${"a".repeat(65)}.tar.gz`,
		`sources/web.${"A".repeat(64)}.tar.gz`,
		`sources/web.${"a".repeat(64)}.tgz`,
		`sources/web.${"a".repeat(64)}.tar.gz.LICENSE.txt`,
		`sources/nested/web.${"a".repeat(64)}.tar.gz`,
		`/sources/web.${"a".repeat(64)}.tar.gz`,
		`${archive}?download=1`,
		`${archive}/extra`,
	]) {
		assert.equal(isSourceArchiveAsset(path), false, path);
		assert.equal(isRetainableAsset(path), false, path);
	}
	for (const status of [200, 206, 304]) {
		assert.equal(
			assetCacheControl(archive, status),
			"public, max-age=31536000, immutable",
		);
		assert.equal(assetCacheControl("sources/index.html", status), "no-store");
		assert.equal(
			assetCacheControl("sources/archive.tar.gz", status),
			"no-cache",
		);
	}
	for (const status of [301, 302, 400, 403, 404, 416, 500]) {
		assert.equal(assetCacheControl(archive, status), "no-store");
		assert.equal(assetCacheControl("sources/index.html", status), "no-store");
	}
});

test("Docker and Worker use the same status/path cache contract for GET and HEAD assets", () => {
	const map = template.match(
		/map "\$status:\$request_uri" \$web_asset_cache_control \{([\s\S]*?)\n\}/,
	)?.[1];
	assert.ok(map);
	const rules = [
		...map.matchAll(/"(~\*?[^"\n]+)"\s+(?:"([^"]+)"|([^;\s]+));/g),
	].map((m) => ({
		regex: new RegExp(
			m[1].replace(/^~\*?/, ""),
			m[1].startsWith("~*") ? "i" : "",
		),
		value: m[2] ?? m[3],
	}));
	assert.equal(rules.length, 4);
	for (const path of [
		"static/js/async/account.12345678.js",
		"static/js/app.12345678.js.LICENSE.txt",
		"static/css/app.87654321.css",
		"static/font/text.12345678.woff2",
		"index.html",
		"index.HTML",
		"logo.png",
		"static/app.123.js",
		"static/data.12345678.json",
		`sources/web.${"a".repeat(64)}.tar.gz`,
		`sources/web.${"0".repeat(64)}.tar.gz`,
		"sources/index.html",
		"sources/index.HTML",
		"sources/manifest.json",
		"sources/archive.tar.gz",
		`sources/web.${"a".repeat(63)}.tar.gz`,
		`sources/web.${"a".repeat(65)}.tar.gz`,
		`sources/web.${"A".repeat(64)}.tar.gz`,
		`sources/web.${"a".repeat(64)}.tgz`,
		`sources/nested/web.${"a".repeat(64)}.tar.gz`,
		`sources/web.${"a".repeat(64)}.tar.gz/extra`,
	]) {
		for (const status of [200, 206, 304, 301, 302, 400, 403, 404, 416, 500]) {
			for (const query of ["", "?v=1"]) {
				const expected =
					rules.find((rule) =>
						rule.regex.test(`${status}:/web-assets/${path}${query}`),
					)?.value ?? "no-store";
				assert.equal(
					expected,
					assetCacheControl(path, status),
					`${status} ${path}${query}`,
				);
			}
		}
	}
	assert.match(
		template,
		/add_header Cache-Control \$web_asset_cache_control always;/,
	);
});

test("Docker consumes the verified release artifact and keeps manifests outside the public root", () => {
	assert.match(
		dockerfile,
		/ARG WEB_RELEASE_PATH=\.release\/web\/__required_explicit_id__/,
	);
	assert.match(
		dockerfile,
		/COPY \$\{WEB_RELEASE_PATH\}\/ \.\/\.release\/web\/input\//,
	);
	assert.match(dockerfile, /package-release\.mjs --verify-artifact input/);
	assert.match(
		dockerfile,
		/COPY --from=verifier \/app\/\.release\/web\/input\/assets \/usr\/share\/nginx\/html/,
	);
	assert.match(dockerfile, /manifest\.sha256 \/usr\/share\/web-release\//);
	assert.doesNotMatch(dockerfile, /npm (?:ci|run build)|\/packages\/web\/dist/);
	assert.match(entrypoint, /--check\) exit 0/);
	assert.match(ssrDockerfile, /package-release\.mjs --verify-artifact input/);
	assert.match(
		ssrDockerfile,
		/COPY \$\{WEB_RELEASE_PATH\}\/ \.\/\.release\/web\/input\//,
	);
	assert.doesNotMatch(ssrDockerfile, /\/usr\/share\/nginx\/html/);
});

for (const [image, contents] of [
	["Dockerfile.web", dockerfile],
	["Dockerfile.web-ssr", ssrDockerfile],
]) {
	for (const [schemaVersion, contractVersion, retainedSource = false] of [
		[1, 1],
		[2, 1],
		[2, 2],
		[3, 2],
		[3, 2, true],
	]) {
		const contractLabel =
			schemaVersion >= 2 ? ` build contract v${contractVersion}` : "";
		const retentionLabel = retainedSource
			? " with retained source and unresolved asset"
			: "";
		test(`${image} COPY verifier runs without source inputs for schema ${schemaVersion}${contractLabel}${retentionLabel}`, async (t) => {
			const root = mkdtempSync(join(tmpdir(), "cinatoken-web-verifier-"));
			t.after(() => {
				assert.equal(dirname(root), resolve(tmpdir()));
				assert.ok(basename(root).startsWith("cinatoken-web-verifier-"));
				rmSync(root, { recursive: true, force: true });
			});
			const copy = contents.match(/^COPY (.+) \.\/packages\/web\/scripts\/$/m);
			assert.ok(copy, "Docker must copy a self-contained verifier module set");
			const sources = copy[1].trim().split(/\s+/);
			assert.ok(sources.includes("packages/web/scripts/build-inputs.mjs"));
			assert.ok(sources.includes("packages/web/scripts/source-archive.mjs"));
			assert.ok(sources.includes("packages/web/scripts/source-delivery.mjs"));
			assert.ok(sources.includes("packages/web/scripts/historical-source.mjs"));
			for (const source of sources) {
				const target = join(root, source);
				mkdirSync(dirname(target), { recursive: true });
				copyFileSync(new URL(`../../${source}`, import.meta.url), target);
			}
			const contract = {
				version: contractVersion,
				buildId: "12345678-1234-1234-1234-123456789abc",
				sourceSha256: "a".repeat(64),
			};
			let archive;
			let historicalArchive;
			if (schemaVersion === 3) {
				const { WEB_BUILD_INPUT_POLICY, inventoryWebBuildInputs } =
					await import("../../packages/web/scripts/build-inputs.mjs");
				const { createSourceArchive } =
					await import("../../packages/web/scripts/source-archive.mjs");
				const inputs = mkdtempSync(
					join(tmpdir(), "cinatoken-web-source-inputs-"),
				);
				const cleanInputs = () => {
					assert.equal(dirname(inputs), resolve(tmpdir()));
					assert.ok(
						basename(inputs).startsWith("cinatoken-web-source-inputs-"),
					);
					rmSync(inputs, { recursive: true, force: true });
				};
				t.after(cleanInputs);
				for (const required of WEB_BUILD_INPUT_POLICY.requiredRoots) {
					const file =
						required.kind === "directory"
							? join(inputs, required.path, "fixture.mjs")
							: join(inputs, required.path);
					mkdirSync(dirname(file), { recursive: true });
					writeFileSync(
						file,
						file.endsWith(".json")
							? '{"fixture":true}\n'
							: "Synthetic declared source fixture\n",
					);
				}
				const packageRoot = join(inputs, "packages/web");
				contract.sourceSha256 =
					inventoryWebBuildInputs(packageRoot).sourceSha256;
				archive = createSourceArchive(packageRoot, contract);
				if (retainedSource) {
					writeFileSync(
						join(packageRoot, "src/fixture.mjs"),
						"Synthetic retained build source fixture\n",
					);
					historicalArchive = createSourceArchive(packageRoot, {
						version: 2,
						buildId: "87654321-4321-4321-4321-cba987654321",
						sourceSha256: inventoryWebBuildInputs(packageRoot).sourceSha256,
					});
					assert.notDeepEqual(
						historicalArchive.descriptor.buildContract,
						contract,
					);
				}
				cleanInputs();
				assert.ok(!existsSync(inputs));
			}
			const contractBytes = `${JSON.stringify(contract)}\n`;
			const assets = new Map([
				["LICENSE", "Synthetic license fixture\n"],
				["NOTICE.frontend", "Synthetic attribution fixture\n"],
				["index.html", "<!doctype html><title>Fixture</title>\n"],
			]);
			const server = new Map();
			if (schemaVersion >= 2) {
				assets.set("build-contract.json", contractBytes);
				for (const target of ["node", "worker"]) {
					server.set(`${target}/build-contract.json`, contractBytes);
					server.set(`${target}/index.mjs`, "export const fixture = true;\n");
				}
			}
			const release = join(root, ".release/web/input");
			const createdAt = "2026-09-27T00:00:00.000Z";
			const retainedAt = "2026-09-25T00:00:00.000Z";
			const retainedPaths = new Set();
			let sourceDelivery;
			if (archive) {
				const { sourceIndexBytes, sourceCatalogBytes } =
					await import("../../packages/web/scripts/source-delivery.mjs");
				const asset = "static/js/app.12345678.js";
				assets.set(asset, "export const fixture = true;\n");
				sourceDelivery = {
					version: 1,
					currentArchive: archive.descriptor.path,
					archives: [
						{
							...archive.descriptor,
							source: "current",
							lastCurrentAt: createdAt,
						},
					],
					assetSources: [
						{
							path: asset,
							archives: [archive.descriptor.path],
							unresolved: false,
						},
					],
					coverageComplete: true,
				};
				assets.set(archive.descriptor.path, archive.bytes);
				if (historicalArchive) {
					const retainedAsset = "static/js/retained.23456789.js";
					const unknownAsset = "static/js/unknown.3456789a.js";
					assets.set(retainedAsset, "export const retainedFixture = true;\n");
					assets.set(unknownAsset, "export const unresolvedFixture = true;\n");
					assets.set(
						historicalArchive.descriptor.path,
						historicalArchive.bytes,
					);
					for (const path of [
						retainedAsset,
						unknownAsset,
						historicalArchive.descriptor.path,
					]) {
						retainedPaths.add(path);
					}
					sourceDelivery.archives.push({
						...historicalArchive.descriptor,
						source: "retained",
						lastCurrentAt: retainedAt,
					});
					sourceDelivery.archives.sort((a, b) => {
						if (a.path < b.path) return -1;
						return a.path > b.path ? 1 : 0;
					});
					sourceDelivery.assetSources.push(
						{
							path: retainedAsset,
							archives: [historicalArchive.descriptor.path],
							unresolved: false,
						},
						{ path: unknownAsset, archives: [], unresolved: true },
					);
					sourceDelivery.coverageComplete = false;
					for (const sourceArchive of sourceDelivery.archives) {
						assert.equal(
							assetCacheControl(sourceArchive.path, 200),
							"public, max-age=31536000, immutable",
						);
					}
					assert.equal(
						assetCacheControl("sources/index.html", 200),
						"no-store",
					);
					assert.equal(
						assetCacheControl("sources/index.json", 200),
						"no-cache",
					);
				}
				assets.set("sources/index.html", sourceIndexBytes(sourceDelivery));
				assets.set("sources/index.json", sourceCatalogBytes(sourceDelivery));
			}
			function writeInventory(directory, files) {
				return [...files].sort().map(([path, contents]) => {
					const bytes = Buffer.from(contents);
					const target = join(directory, path);
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, bytes);
					return {
						path,
						bytes: bytes.length,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					};
				});
			}
			const manifest = {
				schemaVersion,
				releaseId: "fixture",
				createdAt,
				retentionDays: 14,
				previousReleaseId: null,
				currentReleaseId: null,
				files: writeInventory(join(release, "assets"), assets).map((file) => ({
					...file,
					source: retainedPaths.has(file.path) ? "retained" : "current",
					lastCurrentAt: retainedPaths.has(file.path) ? retainedAt : createdAt,
				})),
				...(schemaVersion >= 2
					? {
							serverFiles: writeInventory(join(release, "server"), server),
							buildContract: contract,
						}
					: {}),
				...(sourceDelivery ? { sourceDelivery } : {}),
			};
			const manifestBytes = `${JSON.stringify(manifest)}\n`;
			writeFileSync(join(release, "manifest.json"), manifestBytes);
			writeFileSync(
				join(release, "manifest.sha256"),
				`${createHash("sha256").update(manifestBytes).digest("hex")}\n`,
			);
			assert.ok(!existsSync(join(root, "packages/web/src")));
			assert.ok(!existsSync(join(root, "packages/core")));
			assert.ok(!existsSync(join(root, "packages/admin")));
			assert.ok(!existsSync(join(root, "node_modules")));
			assert.ok(!existsSync(join(release, "source")));
			assert.ok(!existsSync(join(release, "assets/manifest.json")));
			const env = { NODE_ENV: "test" };
			for (const name of ["SystemRoot", "WINDIR", "PATH", "Path", "PATHEXT"]) {
				if (process.env[name] !== undefined) env[name] = process.env[name];
			}
			const verify = () =>
				spawnSync(
					process.execPath,
					[
						join(root, "packages/web/scripts/package-release.mjs"),
						"--verify-artifact",
						"input",
					],
					{ cwd: root, env, encoding: "utf8" },
				);
			const verified = verify();
			assert.equal(verified.status, 0, verified.stderr);
			assert.equal(JSON.parse(verified.stdout).releaseId, "fixture");
			assert.equal(JSON.parse(verified.stdout).files, assets.size);
			if (sourceDelivery) {
				const changed = structuredClone(manifest);
				changed.sourceDelivery.archives[0].fileCount += 1;
				const changedBytes = `${JSON.stringify(changed)}\n`;
				writeFileSync(join(release, "manifest.json"), changedBytes);
				writeFileSync(
					join(release, "manifest.sha256"),
					`${createHash("sha256").update(changedBytes).digest("hex")}\n`,
				);
				const changedDescriptor = verify();
				assert.notEqual(changedDescriptor.status, 0);
				assert.match(
					changedDescriptor.stderr,
					/Source archive descriptor mismatch/,
				);
				writeFileSync(join(release, "manifest.json"), manifestBytes);
				writeFileSync(
					join(release, "manifest.sha256"),
					`${createHash("sha256").update(manifestBytes).digest("hex")}\n`,
				);
			}
			for (const helper of [
				"build-inputs.mjs",
				"source-archive.mjs",
				"source-delivery.mjs",
				"historical-source.mjs",
			]) {
				const target = join(root, "packages/web/scripts", helper);
				const bytes = readFileSync(target);
				rmSync(target);
				const missingHelper = verify();
				assert.notEqual(missingHelper.status, 0, helper);
				assert.match(missingHelper.stderr, /ERR_MODULE_NOT_FOUND/, helper);
				writeFileSync(target, bytes);
			}
		});
	}
}
