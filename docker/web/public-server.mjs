import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyRelease } from "../../packages/web/scripts/package-release.mjs";
import { publicSiteOrigin } from "../../packages/web/scripts/public-origin-policy.mjs";

function upstreamOrigin(raw) {
	const url = new URL(raw);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new TypeError("An Admin upstream origin is required");
	return url.origin;
}

/** Internal SSR sidecar. APIs, private pages and WebSocket forwarding stay in nginx. */
export async function createPublicNodeServer(options) {
	const release = verifyRelease(options.root, options.releaseId, {
		directoryAlias: options.directoryAlias === true,
	});
	if (!release.server)
		throw new Error("Public SSR requires a verified version 2 release");
	const enabled = options.enabled === true;
	const publicOrigin = enabled ? publicSiteOrigin(options.publicOrigin) : "";
	const adminOrigin = upstreamOrigin(
		options.adminUpstream || "http://gateway-admin:8789",
	);
	const module = await import(
		pathToFileURL(join(release.server, "node/index.mjs")).href
	);
	if (
		typeof module.renderPublicResponse !== "function" ||
		typeof module.anonymousCatalogFetch !== "function"
	)
		throw new Error(
			"The verified Node release does not export the public response contract",
		);
	const browserShell = readFileSync(join(release.assets, "index.html"));
	const binding = {
		fetch(request) {
			const url = new URL(request.url);
			const target = new URL(url.pathname + url.search, adminOrigin);
			return fetch(target, {
				method: "GET",
				credentials: "omit",
				redirect: "error",
				headers: { accept: "application/json" },
				signal: request.signal,
			});
		},
	};
	const server = createServer(async (incoming, outgoing) => {
		const controller = new AbortController();
		const abort = () => controller.abort();
		incoming.once("aborted", abort);
		outgoing.once("close", () => {
			if (!outgoing.writableFinished) abort();
		});
		let reader;
		try {
			if (incoming.method !== "GET" && incoming.method !== "HEAD") {
				outgoing.writeHead(405, {
					allow: "GET, HEAD",
					"cache-control": "no-store",
				});
				outgoing.end();
				return;
			}
			if (
				!enabled ||
				incoming.headers["x-cinatoken-web-manifest"] !== release.manifestSha256
			) {
				outgoing.writeHead(503, {
					"cache-control": "no-store",
					"x-robots-tag": "noindex, nofollow",
				});
				outgoing.end(
					incoming.method === "HEAD"
						? undefined
						: "Public pages are unavailable",
				);
				return;
			}
			const request = new Request(
				new URL(incoming.url || "/", "http://public-ssr.internal"),
				{ method: incoming.method, signal: controller.signal },
			);
			const response = await module.renderPublicResponse(request, {
				publicOrigin,
				proxyOrigins: options.proxyOrigins,
				anonymousFetch: module.anonymousCatalogFetch(request.url, binding),
				readBrowserShell: async () =>
					new Response(browserShell, {
						headers: { "content-type": "text/html; charset=utf-8" },
					}),
			});
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			if (!response.body || incoming.method === "HEAD") {
				outgoing.end();
				return;
			}
			reader = response.body.getReader();
			while (!controller.signal.aborted) {
				const item = await reader.read();
				if (item.done) break;
				if (!outgoing.write(item.value)) {
					await new Promise((accept, reject) => {
						const finish = () => {
							outgoing.off("drain", drained);
							outgoing.off("close", closed);
						};
						const drained = () => {
							finish();
							accept();
						};
						const closed = () => {
							finish();
							reject(new Error("Public response cancelled"));
						};
						outgoing.once("drain", drained);
						outgoing.once("close", closed);
					});
				}
			}
			if (controller.signal.aborted)
				await reader.cancel().catch(() => undefined);
			else outgoing.end();
		} catch {
			if (reader) await reader.cancel().catch(() => undefined);
			if (outgoing.headersSent) outgoing.destroy();
			else {
				outgoing.writeHead(503, {
					"cache-control": "no-store",
					"x-robots-tag": "noindex, nofollow",
				});
				outgoing.end(
					incoming.method === "HEAD"
						? undefined
						: "Public pages are unavailable",
				);
			}
		} finally {
			incoming.off("aborted", abort);
		}
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	return {
		server,
		releaseId: release.manifest.releaseId,
		manifestSha256: release.manifestSha256,
	};
}

// Keep runtime imports self-contained; assets are served by the verified nginx image.
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const rawEnabled = process.env.CINATOKEN_WEB_PUBLIC_ENABLED || "false";
	if (!["true", "false"].includes(rawEnabled))
		throw new Error("CINATOKEN_WEB_PUBLIC_ENABLED must be true or false");
	const port = Number(process.env.CINATOKEN_WEB_SSR_PORT || "8791");
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("Invalid SSR port");
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const runtime = await createPublicNodeServer({
		root,
		releaseId: process.env.CINATOKEN_WEB_RELEASE_ID || "input",
		directoryAlias: true,
		enabled: rawEnabled === "true",
		publicOrigin: process.env.CINATOKEN_WEB_PUBLIC_ORIGIN,
		proxyOrigins: process.env.CINATOKEN_WEB_PROXY_ORIGINS,
		adminUpstream: process.env.CINATOKEN_ADMIN_UPSTREAM,
	});
	runtime.server.listen(port, process.env.CINATOKEN_WEB_SSR_HOST || "0.0.0.0");
	const close = () => {
		runtime.server.close();
		runtime.server.closeIdleConnections();
	};
	process.once("SIGTERM", close);
	process.once("SIGINT", close);
}
