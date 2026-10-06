import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	modelEndpointSupportsOperation,
	parseVerifiedModelEndpointSnapshot,
} from "../../../packages/core/src/model-endpoint-runtime.ts";
import { computeRouteDataPolicySubjectFingerprintFromRows } from "../../../packages/core/src/route-data-policy.ts";
import { parseProviderEndpoints } from "../../../packages/core/src/provider-endpoints.ts";
import { encryptSharedKeySecret } from "../../../packages/core/src/lib/shared-key-encryption.ts";
import { decryptProviderApiKeyReadOnly } from "../../../packages/core/src/lib/provider-key-encryption.ts";
import {
	hashLookupKey,
	matchesLookupKeyHash,
} from "../../../packages/core/src/lib/key-hash.ts";

// Read the SQL that the owned Linux seeder really executes, rather than a second fixture definition.
function fixtureRows() {
	const source = readFileSync(
		new URL("./database.mjs", import.meta.url),
		"utf8"
	);
	const blocks = [
		...source.matchAll(
			/await tx\s*\.unsafe\(\s*`([\s\S]*?)`\s*\)\s*\.simple\(\);/g
		),
	];
	assert.equal(blocks.length, 1);
	assert.ok(!blocks[0][1].includes("${"));
	const csv = (input) => {
		const result = [];
		let start = 0,
			quote = false,
			depth = 0;
		for (let index = 0; index < input.length; index++) {
			const char = input[index];
			if (char === "'") {
				if (quote && input[index + 1] === "'") {
					index++;
					continue;
				}
				quote = !quote;
			} else if (!quote) {
				if (char === "(") depth++;
				if (char === ")") depth--;
				if (char === "," && depth === 0) {
					result.push(input.slice(start, index).trim());
					start = index + 1;
				}
			}
		}
		assert.equal(quote, false);
		assert.equal(depth, 0);
		return [...result, input.slice(start).trim()];
	};
	const now = new Date();
	const literal = (value) => {
		if (value.startsWith("'") && value.endsWith("'"))
			return value.slice(1, -1).replaceAll("''", "'");
		if (value === "false") return false;
		if (value === "true") return true;
		if (value === "null") return null;
		if (/^\d+$/.test(value)) return Number(value);
		if (value === "now()") return now.toISOString();
		if (value === "now()+interval '1 day'")
			return new Date(now.getTime() + 86_400_000).toISOString();
		throw new Error(`Unsupported fixture SQL literal: ${value}`);
	};
	const rows = {};
	for (const match of blocks[0][1].matchAll(
		/INSERT INTO cinatoken_gateway\.([a-z_]+)\(([^)]+)\)\s+VALUES\s*\(([\s\S]*?)\);/g
	)) {
		const columns = csv(match[2]);
		const values = csv(match[3]);
		assert.equal(columns.length, values.length, match[1]);
		rows[match[1]] = Object.fromEntries(
			columns.map((name, index) => [name, literal(values[index])])
		);
	}
	assert.equal(Object.keys(rows).length, 6);
	rows.model_endpoints = {
		endpoint_class: null,
		region: null,
		quantization: null,
		image_capabilities: "{}",
		audio_capabilities: "{}",
		created_at: now.toISOString(),
		updated_at: now.toISOString(),
		...rows.model_endpoints,
	};
	return { rows, now };
}

test("the real SQL text fixture satisfies production endpoint and operation admission", () => {
	const { rows, now } = fixtureRows();
	const endpoint = rows.model_endpoints;
	const snapshot = parseVerifiedModelEndpointSnapshot(endpoint, now);
	assert.ok(snapshot);
	assert.equal(rows.model_surfaces.request_operation, "chat");
	assert.equal(rows.model_routes.upstream_operation, "chat");
	assert.equal(
		modelEndpointSupportsOperation(
			snapshot,
			rows.model_routes.upstream_operation
		),
		true
	);
	for (const operation of [
		"chat.completions",
		"images.generations",
		"audio.speech",
		"*",
	])
		assert.equal(modelEndpointSupportsOperation(snapshot, operation), false);
	assert.equal(
		parseVerifiedModelEndpointSnapshot(
			{ ...endpoint, expires_at: new Date(now.getTime() - 1).toISOString() },
			now
		),
		null
	);
	assert.equal(
		parseVerifiedModelEndpointSnapshot(
			{ ...endpoint, supports_voice_cloning: null },
			now
		),
		null
	);
});

test("provider encryption and real route fingerprint bind the seeded plaintext credential", async () => {
	const { rows } = fixtureRows();
	const provider = {
		...rows.providers,
		api_key: randomBytes(32).toString("hex"),
	};
	const secret = randomBytes(32).toString("hex");
	assert.equal(
		parseProviderEndpoints(provider).openai.base,
		"https://provider.test/v1"
	);
	const encrypted = await encryptSharedKeySecret(
		provider.api_key,
		secret,
		"cinatoken:provider-key:g7-provider"
	);
	assert.ok(encrypted.startsWith("enc:v2:"));
	assert.equal(
		await decryptProviderApiKeyReadOnly(provider.id, encrypted, secret),
		provider.api_key
	);
	const route = rows.model_routes;
	const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(
		route,
		provider
	);
	assert.match(fingerprint, /^[a-f0-9]{64}$/);
	assert.notEqual(
		await computeRouteDataPolicySubjectFingerprintFromRows(route, {
			...provider,
			api_key: encrypted,
		}),
		fingerprint
	);
	assert.notEqual(
		await computeRouteDataPolicySubjectFingerprintFromRows(
			{ ...route, provider_model_name: "other-owned-model" },
			provider
		),
		fingerprint
	);
	await assert.rejects(
		decryptProviderApiKeyReadOnly("different-owned-provider", encrypted, secret)
	);
});

test("the rotated owned Admin key uses the production lookup hash and rejects the migration's development key", async () => {
	const masterKey = randomBytes(32).toString("hex");
	const expected = `sha256:${createHash("sha256")
		.update(masterKey)
		.digest("hex")}`;
	const lookupHash = await hashLookupKey(masterKey);
	assert.equal(lookupHash, expected);
	assert.equal(await matchesLookupKeyHash(masterKey, lookupHash), true);
	assert.equal(
		await matchesLookupKeyHash("sk-dev-admin-key", lookupHash),
		false
	);
	assert.equal(
		await matchesLookupKeyHash(
			masterKey,
			await hashLookupKey("sk-dev-admin-key")
		),
		false
	);
});
