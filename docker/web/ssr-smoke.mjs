import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "../../packages/web/scripts/package-release.mjs";

const repositoryRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const canonicalOrigin = "https://web-ci.test";
const markerHeaders = {
	cookie: "ssr_smoke_cookie=controlled-marker",
	authorization: "Bearer controlled-marker",
	"X-CinaToken-Workspace": "controlled-workspace",
};

async function inside(expectedManifest) {
	const release = verifyRelease(repositoryRoot, "input", {
		directoryAlias: true,
	});
	assert.equal(release.manifestSha256, expectedManifest);
	const entry = "http://web-entry:8080";
	const sidecar = "http://web-ssr:8791";
	const fixture = "http://catalog-fixture:8789";
	const cases = [];
	let expectedCatalogReads = 0;
	async function request(origin, path, options = {}) {
		const response = await fetch(origin + path, {
			redirect: "manual",
			signal: AbortSignal.timeout(8_000),
			...options,
		});
		const body = await response.text();
		return { response, body };
	}
	async function ready(origin, path, options = {}) {
		let failure;
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				const result = await request(origin, path, {
					...options,
					signal: AbortSignal.timeout(1_000),
				});
				if (result.response.status === 200) return;
				failure = new Error(
					`Unexpected startup HTTP ${result.response.status}`,
				);
			} catch (error) {
				failure = error;
			}
			await new Promise((accept) => setTimeout(accept, 200));
		}
		throw failure ?? new Error("Runtime did not become ready");
	}
	await ready(fixture, "/__fixture/observations");
	await ready(sidecar, "/en", {
		headers: { "X-CinaToken-Web-Manifest": expectedManifest },
	});
	await ready(entry, "/en");
	const paths = [
		"",
		"/models?q=HTTP",
		"/models/Vendor/http-fixture",
		"/providers",
		"/compare?models=vendor%2Fhttp-fixture",
		"/chat?model=vendor%2Fhttp-fixture",
		"/rankings?range=30d",
		"/benchmarks?range=90d",
	];
	const assets = new Set(
		release.manifest.files.map((file) => `/web-assets/${file.path}`),
	);
	for (const locale of ["en", "zh", "ja", "ko"]) {
		for (const path of paths) {
			for (const method of ["GET", "HEAD"]) {
				const route = `/${locale}${path}`;
				const { response, body } = await request(entry, route, {
					method,
					headers: markerHeaders,
				});
				assert.equal(response.status, 200, `${method} ${route}`);
				assert.equal(response.headers.get("cache-control"), "no-store");
				assert.equal(response.headers.get("set-cookie"), null);
				assert.equal(
					response.headers.get("cross-origin-opener-policy"),
					"same-origin",
				);
				if (method === "HEAD") assert.equal(body, "");
				else {
					assert.match(body, new RegExp(`<html lang="${locale}"`));
					assert.match(
						/<main\b[^>]*>([\s\S]*?)<\/main>/.exec(body)?.[1] ?? "",
						/<h1\b/,
					);
					assert.doesNotMatch(body, /id="cinatoken-public-[BS]:/);
					assert.match(body, /rel="canonical" href="https:\/\/web-ci\.test\//);
					assert.equal((body.match(/rel="alternate"/g) ?? []).length, 5);
					assert.doesNotMatch(
						body,
						/controlled-marker|controlled-workspace|catalog-fixture|web-entry:8080|<\/script><script>unsafe-marker/,
					);
					const bootstrap = JSON.parse(
						/<script[^>]*id="cinatoken-public-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(
							body,
						)?.[1] ?? "null",
					);
					assert.equal(bootstrap.locale, locale);
					assert.equal(bootstrap.pathname, new URL(route, entry).pathname);
					assert.equal(bootstrap.status, 200);
					assert.equal(bootstrap.records.length, path ? 1 : 0);
					if (path) {
						assert.equal(bootstrap.records[0].result.status, "success");
						const data = bootstrap.records[0].result.data;
						assert.equal(data.data.length ?? 1, 1);
						assert.equal(
							Array.isArray(data.data) ? data.data[0].id : data.data.id,
							path === "/providers" ? "Vendor" : "vendor/http-fixture",
						);
					}
					const nonce = /'nonce-([^']+)'/.exec(
						response.headers.get("content-security-policy") ?? "",
					)?.[1];
					assert.ok(nonce);
					for (const script of body.matchAll(/<script\b([^>]*)>/g))
						assert.ok(script[1].includes(`nonce="${nonce}"`));
					const linkedAssets = [
						...body.matchAll(/(?:src|href)="(\/web-assets\/[^"?]+)"/g),
					];
					assert.ok(linkedAssets.length >= 2);
					for (const linked of linkedAssets)
						assert.ok(assets.has(linked[1]), `Unverified asset ${linked[1]}`);
				}
				if (path) expectedCatalogReads++;
				cases.push({ method, path: route, status: response.status });
			}
		}
	}
	for (const method of ["GET", "HEAD"]) {
		for (const path of ["/robots.txt", "/sitemap.xml"]) {
			const { response, body } = await request(entry, path, {
				method,
				headers: markerHeaders,
			});
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("cache-control"), "no-store");
			if (method === "HEAD") assert.equal(body, "");
			else if (path === "/robots.txt")
				assert.ok(body.includes(`Sitemap: ${canonicalOrigin}/sitemap.xml`));
			else {
				assert.ok(
					body.includes(`${canonicalOrigin}/en/models/vendor/http-fixture`),
				);
				for (const locale of ["en", "zh", "ja", "ko"])
					assert.ok(body.includes(`hreflang="${locale}"`));
				assert.doesNotMatch(
					body,
					/catalog-fixture|web-entry:8080|controlled-marker/,
				);
			}
			if (path === "/sitemap.xml") expectedCatalogReads++;
			cases.push({ method, path, status: response.status });
		}
		for (const [path, status] of [
			["/en/not-a-page", 404],
			["/fr/models", 404],
			["/en/models/Vendor/missing", 404],
			["/en/models/Vendor/unavailable", 503],
		]) {
			const { response, body } = await request(entry, path, {
				method,
				headers: markerHeaders,
			});
			assert.equal(response.status, status, `${method} ${path}`);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
			if (status === 503)
				assert.equal(response.headers.get("retry-after"), "30");
			if (method === "HEAD") assert.equal(body, "");
			else {
				assert.match(body, /<h1\b/);
				assert.doesNotMatch(
					body,
					/rel="canonical"|fixture-unavailable|controlled-marker/,
				);
			}
			if (path.includes("/models/Vendor/")) expectedCatalogReads++;
			cases.push({ method, path, status: response.status });
		}
		for (const manifest of [null, "0".repeat(64)]) {
			const { response, body } = await request(sidecar, "/en/models", {
				method,
				headers: manifest ? { "X-CinaToken-Web-Manifest": manifest } : {},
			});
			assert.equal(response.status, 503);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
			if (method === "HEAD") assert.equal(body, "");
			cases.push({
				method,
				path: "/en/models",
				contract: manifest ? "wrong-manifest" : "missing-manifest",
				status: response.status,
			});
		}
		const disabled = await request(
			"http://web-ssr-disabled:8791",
			"/en/models",
			{ method, headers: { "X-CinaToken-Web-Manifest": expectedManifest } },
		);
		assert.equal(disabled.response.status, 503);
		assert.equal(disabled.response.headers.get("cache-control"), "no-store");
		if (method === "HEAD") assert.equal(disabled.body, "");
		cases.push({
			method,
			path: "/en/models",
			contract: "disabled",
			status: disabled.response.status,
		});
		// This bypasses Nginx to independently prove the Node adapter strips credentials.
		const direct = await request(sidecar, "/en/models", {
			method,
			headers: {
				...markerHeaders,
				"X-CinaToken-Web-Manifest": expectedManifest,
			},
		});
		assert.equal(direct.response.status, 200);
		assert.equal(direct.response.headers.get("set-cookie"), null);
		if (method === "HEAD") assert.equal(direct.body, "");
		else
			assert.doesNotMatch(
				direct.body,
				/controlled-marker|controlled-workspace/,
			);
		expectedCatalogReads++;
		cases.push({
			method,
			path: "/en/models",
			contract: "direct-anonymous",
			status: direct.response.status,
		});
	}
	for (const [path, location] of [
		["/", "/en"],
		["/models?q=HTTP", "/en/models?q=HTTP"],
		["/en/models/", "/en/models"],
	]) {
		const { response } = await request(entry, path);
		assert.equal(response.status, 308);
		assert.equal(response.headers.get("location"), location);
		assert.equal(response.headers.get("cache-control"), "no-store");
		cases.push({ method: "GET", path, status: response.status });
	}
	const { response: auditResponse, body: auditBody } = await request(
		fixture,
		"/__fixture/observations",
	);
	assert.equal(auditResponse.status, 200);
	assert.equal(cases.length, 87, "The complete SSR HTTP matrix must run");
	const observations = JSON.parse(auditBody);
	assert.deepEqual(observations.violations, []);
	assert.equal(
		observations.requests.length,
		expectedCatalogReads,
		"Each catalog page has one authoritative HTTP read; rejected SSR requests have none",
	);
	for (const observation of observations.requests)
		assert.deepEqual(
			{
				method: observation.method,
				acceptIsJson: observation.acceptIsJson,
				hadCookie: observation.hadCookie,
				hadAuthorization: observation.hadAuthorization,
				hadWorkspace: observation.hadWorkspace,
				hadBody: observation.hadBody,
			},
			{
				method: "GET",
				acceptIsJson: true,
				hadCookie: false,
				hadAuthorization: false,
				hadWorkspace: false,
				hadBody: false,
			},
		);
	return {
		manifestSha256: expectedManifest,
		cases,
		catalogReads: expectedCatalogReads,
		observations,
	};
}

let dockerDeadline = Infinity;
function dockerResult(args, timeout = 15_000) {
	const remaining = dockerDeadline - Date.now();
	if (remaining <= 0) throw new Error("Docker smoke phase deadline exceeded");
	const result = spawnSync("docker", args, {
		encoding: "utf8",
		timeout: Math.min(timeout, remaining),
		maxBuffer: 4 * 1024 * 1024,
	});
	return result;
}
function docker(args, timeout = 15_000) {
	const result = dockerResult(args, timeout);
	if (result.error || result.status !== 0)
		throw new Error(result.error?.message ?? result.stderr);
	return result.stdout.trim();
}

async function outside(id) {
	assert.ok(id, "An explicit frozen release ID is required");
	const release = verifyRelease(repositoryRoot, id);
	assert.ok(release.server, "A verified Node SSR release is required");
	const owner = randomUUID();
	const networkName = `cinatoken-web-ssr-smoke-${owner}`;
	const containers = [];
	let network;
	let proof;
	let failure;
	const cleanup = [];
	dockerDeadline = Date.now() + 180_000;
	const mounts = [
		["docker/web/ssr-smoke.mjs", "/app/docker/web/ssr-smoke.mjs"],
		[
			"docker/web/fixtures/catalog-server.mjs",
			"/app/docker/web/fixtures/catalog-server.mjs",
		],
	].flatMap(([source, target]) => [
		"--mount",
		`type=bind,src=${resolve(repositoryRoot, source)},dst=${target},readonly`,
	]);
	function start(alias, image, environment = [], command = []) {
		const container = docker([
			"run",
			"--detach",
			"--rm",
			"--network",
			networkName,
			"--network-alias",
			alias,
			"--label",
			`cinatoken.web.ssr-smoke=${owner}`,
			...environment.flatMap((value) => ["--env", value]),
			...mounts,
			...(command.length ? ["--entrypoint", "node"] : []),
			image,
			...command,
		]);
		assert.match(container, /^[a-f0-9]{64}$/);
		containers.push(container);
		const inspected = JSON.parse(docker(["inspect", container]))[0];
		assert.equal(inspected.Config.Labels["cinatoken.web.ssr-smoke"], owner);
		assert.deepEqual(inspected.HostConfig.PortBindings ?? {}, {});
		assert.equal(Object.keys(inspected.NetworkSettings.Networks).length, 1);
		assert.equal(
			inspected.NetworkSettings.Networks[networkName].NetworkID,
			network,
		);
		assert.ok(inspected.Mounts.every((mount) => mount.RW === false));
		return container;
	}
	try {
		network = docker([
			"network",
			"create",
			"--internal",
			"--label",
			`cinatoken.web.ssr-smoke=${owner}`,
			networkName,
		]);
		assert.match(network, /^[a-f0-9]{64}$/);
		const inspected = JSON.parse(docker(["network", "inspect", network]))[0];
		assert.equal(inspected.Id, network);
		assert.equal(inspected.Internal, true);
		assert.equal(inspected.Labels["cinatoken.web.ssr-smoke"], owner);
		start(
			"catalog-fixture",
			"cinatoken-web-ssr:check",
			[],
			["docker/web/fixtures/catalog-server.mjs"],
		);
		const common = [
			"CINATOKEN_ADMIN_UPSTREAM=http://catalog-fixture:8789",
			`CINATOKEN_WEB_PUBLIC_ORIGIN=${canonicalOrigin}`,
		];
		const sidecar = start("web-ssr", "cinatoken-web-ssr:check", [
			...common,
			"CINATOKEN_WEB_PUBLIC_ENABLED=true",
		]);
		start("web-ssr-disabled", "cinatoken-web-ssr:check", [
			...common,
			"CINATOKEN_WEB_PUBLIC_ENABLED=false",
		]);
		const entry = start("web-entry", "cinatoken-web:check", [
			"CINATOKEN_ADMIN_UPSTREAM=http://catalog-fixture:8789",
			"CINATOKEN_WEB_PUBLIC_ENABLED=true",
			"CINATOKEN_WEB_SSR_UPSTREAM=http://web-ssr:8791",
		]);
		assert.equal(
			docker(["exec", entry, "cat", "/usr/share/web-release/manifest.sha256"]),
			release.manifestSha256,
		);
		proof = JSON.parse(
			docker(
				[
					"exec",
					sidecar,
					"node",
					"docker/web/ssr-smoke.mjs",
					"--inside",
					release.manifestSha256,
				],
				180_000,
			),
		);
		assert.equal(proof.manifestSha256, release.manifestSha256);
	} catch (error) {
		failure = error;
	} finally {
		// Reserve a separate bounded cleanup phase inside the five-minute CI step.
		dockerDeadline = Date.now() + 90_000;
		for (const container of [...containers].reverse()) {
			try {
				const before = dockerResult(["inspect", container], 10_000);
				if (before.status === 0) {
					assert.equal(
						JSON.parse(before.stdout)[0].Config.Labels[
							"cinatoken.web.ssr-smoke"
						],
						owner,
					);
					docker(["rm", "--force", container]);
				} else assert.match(before.stderr, /No such (?:object|container)/i);
				const absent = dockerResult(["inspect", container], 10_000);
				assert.equal(absent.status, 1);
				assert.match(absent.stderr, /No such (?:object|container)/i);
				cleanup.push({ container, absent: true });
			} catch (error) {
				cleanup.push({ container, error: error.message });
			}
		}
		if (network) {
			try {
				const before = JSON.parse(docker(["network", "inspect", network]))[0];
				assert.equal(before.Labels["cinatoken.web.ssr-smoke"], owner);
				assert.equal(Object.keys(before.Containers ?? {}).length, 0);
				docker(["network", "rm", network]);
				const absent = dockerResult(["network", "inspect", network], 10_000);
				assert.equal(absent.status, 1);
				assert.match(
					absent.stderr,
					/(?:No such network|network .* not found)/i,
				);
				cleanup.push({ network, absent: true });
			} catch (error) {
				cleanup.push({ network, error: error.message });
			}
		}
	}
	if (failure || cleanup.some((item) => item.error)) {
		process.stderr.write(
			`${JSON.stringify({ failure: failure?.message ?? null, cleanup })}\n`,
		);
		throw new Error("Docker SSR runtime smoke or owned cleanup failed");
	}
	return {
		releaseId: release.manifest.releaseId,
		...proof,
		isolation: {
			internalNetwork: true,
			hostPorts: false,
			controlledCatalogOnly: true,
		},
		budgets: { runtimeMs: 180_000, cleanupMs: 90_000, ciStepMinutes: 5 },
		cleanup,
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const result =
			process.argv[2] === "--inside"
				? await inside(process.argv[3])
				: await outside(process.argv[2]);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(`${error.stack ?? error.message}\n`);
		process.exitCode = 1;
	}
}
