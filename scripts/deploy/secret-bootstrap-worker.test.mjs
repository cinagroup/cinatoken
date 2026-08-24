import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import worker from "./secret-bootstrap-worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("secret bootstrap Worker is an inactive no-route 503 shell", async () => {
	const response = await worker.fetch(new Request("https://invalid.example/"));
	assert.equal(response.status, 503);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(await response.text(), "Service is not deployed");

	const config = JSON.parse(
		readFileSync(join(here, "wrangler.secret-bootstrap.jsonc"), "utf8"),
	);
	assert.equal(config.workers_dev, false);
	assert.equal(config.preview_urls, false);
	assert.equal("routes" in config, false);
	assert.equal("vars" in config, false);
	assert.equal("d1_databases" in config, false);
});
