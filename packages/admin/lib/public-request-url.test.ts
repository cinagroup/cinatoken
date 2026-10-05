import assert from "node:assert/strict";
import test from "node:test";
import { getPublicRequestUrl } from "./public-request-url";

test("restores public Host while retaining protocol, path and query", () => {
	const request = new Request(
		"http://localhost:8789/api/auth/cinaauth/callback?state=fixture&code=a%2Bb",
		{
			headers: { host: "127.0.0.1:8791" },
		}
	);
	assert.equal(
		getPublicRequestUrl(request).href,
		"http://127.0.0.1:8791/api/auth/cinaauth/callback?state=fixture&code=a%2Bb"
	);
	assert.equal(
		request.url,
		"http://localhost:8789/api/auth/cinaauth/callback?state=fixture&code=a%2Bb"
	);
});

test("keeps authoritative URL when Fetch has no Host header", () => {
	assert.equal(
		getPublicRequestUrl(new Request("https://cinatoken.com/account")).href,
		"https://cinatoken.com/account"
	);
});

test("normalizes uppercase, default ports and IPv6 authorities", () => {
	for (const [host, expected] of [
		["CINATOKEN.COM:443", "https://cinatoken.com/account"],
		["[::1]:8791", "https://[::1]:8791/account"],
	]) {
		assert.equal(
			getPublicRequestUrl(
				new Request("https://localhost:8789/account", { headers: { host } })
			).href,
			expected
		);
	}
});

test("never uses Origin or forwarding headers to choose the public authority or protocol", () => {
	const request = new Request("http://localhost:8789/account", {
		headers: {
			host: "127.0.0.1:8791",
			origin: "https://attacker.example",
			"x-forwarded-host": "attacker.example",
			"x-forwarded-proto": "https",
		},
	});
	assert.equal(getPublicRequestUrl(request).origin, "http://127.0.0.1:8791");
});

test("rejects malformed, ambiguous or credential-bearing Host authorities", () => {
	for (const host of [
		"",
		"app.example,other.example",
		"app.example/path",
		"user@app.example",
		"app.example?x=1",
		"app.example#x",
		"app.example\\path",
		"app.example:70000",
		"app.example:abc",
		"app.example%2fother",
		"app example",
		"app.example;evil",
	]) {
		assert.throws(
			() =>
				getPublicRequestUrl(
					new Request("https://localhost/account", { headers: { host } })
				),
			TypeError,
			host
		);
	}
});

test("rejects protocols outside browser HTTP transport", () => {
	assert.throws(
		() => getPublicRequestUrl(new Request("ftp://cinatoken.com/account")),
		TypeError
	);
});
