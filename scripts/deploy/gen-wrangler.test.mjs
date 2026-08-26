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
	delete env.HYPERDRIVE_ID;
	delete env.DATABASE_DRIVER;
	delete env.CINATOKEN_MAINTENANCE_MODE;
	delete env.PROXY_CUSTOM_DOMAIN;
	delete env.ADMIN_CUSTOM_DOMAIN;
	delete env.CHAIN_JOB_QUEUE_NAME;
	delete env.CHAIN_JOB_DLQ_NAME;
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
	const chain = JSON.parse(
		readFileSync(join(root, "packages/chain-worker/wrangler.jsonc"), "utf8"),
	);
	assert.equal(admin.vars.CINAAUTH_ISSUER, "https://auth.cinaseek.ai");
	assert.equal(admin.main, "worker.ts");
	assert.deepEqual(admin.routes, [
		{ pattern: "cinatoken.com/*", zone_name: "cinatoken.com" },
	]);
	assert.deepEqual(proxy.routes, [
		{ pattern: "api.cinatoken.com/*", zone_name: "cinatoken.com" },
	]);
	assert.equal(admin.queues.producers[0].queue, "cinatoken-chain-jobs");
	assert.equal(chain.queues.consumers[0].queue, "cinatoken-chain-jobs");
	assert.equal(chain.queues.consumers[0].dead_letter_queue, "cinatoken-chain-jobs-dlq");
	assert.equal(chain.queues.consumers[0].max_concurrency, 1);
	assert.equal(proxy.hyperdrive, undefined);
	assert.equal(proxy.vars?.DATABASE_DRIVER, undefined);
});

test("generated Worker configs stage one shared Hyperdrive binding and explicit Postgres selection", (t) => {
	const env = {
		...process.env,
		HYPERDRIVE_ID: "11111111-2222-4333-8444-555555555555",
		DATABASE_DRIVER: "postgres",
	};
	delete env.D1_DATABASE_ID;
	t.after(() => {
		const restoreEnv = { ...process.env };
		delete restoreEnv.D1_DATABASE_ID;
		delete restoreEnv.HYPERDRIVE_ID;
		delete restoreEnv.DATABASE_DRIVER;
		delete restoreEnv.CINATOKEN_MAINTENANCE_MODE;
		spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
			cwd: root,
			env: restoreEnv,
			encoding: "utf8",
		});
	});
	const result = spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
		cwd: root,
		env,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	for (const relativePath of [
		"packages/proxy/wrangler.jsonc",
		"packages/admin/wrangler.jsonc",
		"packages/chain-worker/wrangler.jsonc",
	]) {
		const config = JSON.parse(readFileSync(join(root, relativePath), "utf8"));
		assert.deepEqual(config.hyperdrive, [
			{ binding: "HYPERDRIVE", id: env.HYPERDRIVE_ID },
		]);
		assert.equal(config.vars.DATABASE_DRIVER, "postgres");
		assert.equal(config.d1_databases[0].binding, "DB");
	}
});

test("staged Hyperdrive ID stays unbound until Postgres is selected", (t) => {
	const env = {
		...process.env,
		HYPERDRIVE_ID: "11111111-2222-4333-8444-555555555555",
	};
	delete env.D1_DATABASE_ID;
	delete env.DATABASE_DRIVER;
	t.after(() => {
		const restoreEnv = { ...process.env };
		delete restoreEnv.D1_DATABASE_ID;
		delete restoreEnv.HYPERDRIVE_ID;
		delete restoreEnv.DATABASE_DRIVER;
		delete restoreEnv.CINATOKEN_MAINTENANCE_MODE;
		spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
			cwd: root,
			env: restoreEnv,
			encoding: "utf8",
		});
	});
	const result = spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
		cwd: root,
		env,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	for (const relativePath of [
		"packages/proxy/wrangler.jsonc",
		"packages/admin/wrangler.jsonc",
		"packages/chain-worker/wrangler.jsonc",
	]) {
		const config = JSON.parse(readFileSync(join(root, relativePath), "utf8"));
		assert.equal(config.hyperdrive, undefined);
		assert.equal(config.vars?.DATABASE_DRIVER, undefined);
	}
});

test("maintenance mode gates HTTP Workers without changing the Queue consumer", (t) => {
	const env = { ...process.env, CINATOKEN_MAINTENANCE_MODE: "true" };
	delete env.D1_DATABASE_ID;
	t.after(() => {
		const restoreEnv = { ...process.env };
		delete restoreEnv.D1_DATABASE_ID;
		delete restoreEnv.CINATOKEN_MAINTENANCE_MODE;
		spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
			cwd: root,
			env: restoreEnv,
			encoding: "utf8",
		});
	});
	const result = spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
		cwd: root,
		env,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	const proxy = JSON.parse(readFileSync(join(root, "packages/proxy/wrangler.jsonc"), "utf8"));
	const admin = JSON.parse(readFileSync(join(root, "packages/admin/wrangler.jsonc"), "utf8"));
	const chain = JSON.parse(readFileSync(join(root, "packages/chain-worker/wrangler.jsonc"), "utf8"));
	assert.equal(proxy.vars.CINATOKEN_MAINTENANCE_MODE, "true");
	assert.equal(admin.vars.CINATOKEN_MAINTENANCE_MODE, "true");
	assert.equal(chain.vars?.CINATOKEN_MAINTENANCE_MODE, undefined);
});

test("Postgres Worker generation fails closed without HYPERDRIVE_ID", () => {
	const env = { ...process.env, DATABASE_DRIVER: "postgres" };
	delete env.HYPERDRIVE_ID;
	const result = spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
		cwd: root,
		env,
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /HYPERDRIVE_ID is required/);
});
