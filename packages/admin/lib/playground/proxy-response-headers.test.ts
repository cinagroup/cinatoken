import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copyPlaygroundUpstreamHeaders } from "./proxy-response-headers";

describe("copyPlaygroundUpstreamHeaders", () => {
	it("drops hop-by-hop and decoded compression headers", () => {
		const source = new Headers({
			"Content-Type": "text/event-stream",
			"Transfer-Encoding": "chunked",
			"Content-Encoding": "gzip",
			"Content-Length": "12",
			Connection: "keep-alive",
			"X-Request-Id": "abc",
		});
		const copied = copyPlaygroundUpstreamHeaders(source);
		assert.equal(copied.get("content-type"), "text/event-stream");
		assert.equal(copied.get("x-request-id"), "abc");
		assert.equal(copied.has("transfer-encoding"), false);
		assert.equal(copied.has("content-encoding"), false);
		assert.equal(copied.has("content-length"), false);
		assert.equal(copied.has("connection"), false);
		assert.equal(
			copied.get("cache-control"),
			"private, no-store, no-transform"
		);
		assert.equal(copied.get("x-accel-buffering"), "no");
	});

	it("does not force SSE cache headers on JSON", () => {
		const copied = copyPlaygroundUpstreamHeaders(
			new Headers({ "Content-Type": "application/json" })
		);
		assert.equal(copied.get("cache-control"), "private, no-store");
	});

	it("drops provider cookies, auth, CORS and arbitrary headers, redacting known credentials in permitted metadata", () => {
		const copied = copyPlaygroundUpstreamHeaders(
			new Headers({
				"Content-Type": "audio/mpeg",
				"Content-Disposition": 'attachment; filename="synthetic-secret.mp3"',
				"Set-Cookie": "provider=secret",
				Authorization: "Bearer synthetic-secret",
				"X-Api-Key": "synthetic-secret",
				"Access-Control-Allow-Origin": "*",
				"X-Debug": "synthetic-secret",
				"Cache-Control": "public,max-age=3600",
			}),
			["synthetic-secret"]
		);
		for (const key of [
			"set-cookie",
			"authorization",
			"x-api-key",
			"access-control-allow-origin",
			"x-debug",
		])
			assert.equal(copied.has(key), false);
		assert.equal(copied.get("content-type"), "audio/mpeg");
		assert.doesNotMatch(
			copied.get("content-disposition") ?? "",
			/synthetic-secret/u
		);
		assert.equal(copied.get("cache-control"), "private, no-store");
	});
});
