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
	delete env.BATCH_INFRA_ENABLED;
	delete env.BATCH_API_ENABLED;
	delete env.BATCH_BUCKET_NAME;
	delete env.BATCH_QUEUE_NAME;
	delete env.BATCH_DLQ_NAME;
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
	assert.deepEqual(
		admin.services.find((service) => service.binding === "CINATOKEN_PROXY_SERVICE"),
		{ binding: "CINATOKEN_PROXY_SERVICE", service: "cinatoken-proxy" },
	);
	assert.deepEqual(admin.routes, [
		{ pattern: "cinatoken.com/*", zone_name: "cinatoken.com" },
	]);
	assert.deepEqual(proxy.routes, [
		{ pattern: "api.cinatoken.com/*", zone_name: "cinatoken.com" },
	]);
	assert.deepEqual(proxy.triggers, { crons: ["17 * * * *"] });
	assert.equal(proxy.vars.PROVIDER_ATTEMPT_RETENTION_DAYS, "7");
	assert.equal(proxy.vars.PROVIDER_ATTEMPT_RETENTION_BATCH_SIZE, "5000");
	assert.equal(proxy.vars.PROVIDER_ATTEMPT_RETENTION_MAX_BATCHES, "10");
	assert.equal(proxy.vars.BATCH_API_ENABLED, "false");
	assert.equal(proxy.r2_buckets, undefined);
	assert.equal(proxy.queues, undefined);
	assert.equal(admin.queues.producers[0].queue, "cinatoken-chain-jobs");
	assert.equal(chain.queues.consumers[0].queue, "cinatoken-chain-jobs");
	assert.equal(chain.queues.consumers[0].dead_letter_queue, "cinatoken-chain-jobs-dlq");
	assert.equal(chain.queues.consumers[0].max_concurrency, 1);
	assert.equal(proxy.hyperdrive, undefined);
	assert.equal(proxy.vars?.DATABASE_DRIVER, undefined);
});

test("Batch infrastructure is explicit, private, renamed, and API-disabled", (t) => {
	const env = {
		...process.env,
		BATCH_INFRA_ENABLED: "true",
		BATCH_BUCKET_NAME: "tenant-private-batches",
		BATCH_QUEUE_NAME: "tenant-batch-jobs",
		BATCH_DLQ_NAME: "tenant-batch-jobs-dlq",
	};
	delete env.D1_DATABASE_ID;
	delete env.BATCH_API_ENABLED;
	t.after(() => {
		const restoreEnv = { ...process.env };
		delete restoreEnv.D1_DATABASE_ID;
		delete restoreEnv.BATCH_INFRA_ENABLED;
		delete restoreEnv.BATCH_API_ENABLED;
		delete restoreEnv.BATCH_BUCKET_NAME;
		delete restoreEnv.BATCH_QUEUE_NAME;
		delete restoreEnv.BATCH_DLQ_NAME;
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
	assert.deepEqual(proxy.r2_buckets, [
		{ binding: "BATCH_BUCKET", bucket_name: "tenant-private-batches" },
	]);
	assert.deepEqual(proxy.queues.producers, [
		{ binding: "BATCH_QUEUE", queue: "tenant-batch-jobs" },
	]);
	assert.equal(proxy.queues.consumers[0].queue, "tenant-batch-jobs");
	assert.equal(proxy.queues.consumers[0].dead_letter_queue, "tenant-batch-jobs-dlq");
	assert.equal(proxy.queues.consumers[0].max_batch_size, 1);
	assert.equal(proxy.queues.consumers[0].max_concurrency, 5);
	assert.equal(proxy.queues.consumers[1].queue, "tenant-batch-jobs-dlq");
	assert.equal(proxy.queues.consumers[1].max_retries, 0);
	assert.equal(proxy.queues.consumers[1].max_concurrency, 1);
	assert.equal(proxy.vars.BATCH_QUEUE_DLQ, "tenant-batch-jobs-dlq");
	assert.equal(proxy.vars.BATCH_API_ENABLED, "false");
});

test("Phase 2 generation rejects public Batch API activation and malformed flags", () => {
	for (const overrides of [
		{ BATCH_API_ENABLED: "true", BATCH_INFRA_ENABLED: "true" },
		{ BATCH_INFRA_ENABLED: "yes" },
	]) {
		const env = { ...process.env, ...overrides };
		delete env.D1_DATABASE_ID;
		const result = spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
			cwd: root,
			env,
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
	}
});

test("admin service binding follows a custom proxy Worker name", (t) => {
	const env = { ...process.env, PROXY_WORKER_NAME: "tenant-proxy" };
	delete env.D1_DATABASE_ID;
	t.after(() => {
		const restoreEnv = { ...process.env };
		delete restoreEnv.D1_DATABASE_ID;
		delete restoreEnv.PROXY_WORKER_NAME;
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
	const admin = JSON.parse(readFileSync(join(root, "packages/admin/wrangler.jsonc"), "utf8"));
	assert.equal(
		admin.services.find((service) => service.binding === "CINATOKEN_PROXY_SERVICE")?.service,
		"tenant-proxy",
	);
});

test("CinaAuth organization admin roles reach both HTTP Workers", (t) => {
	const env = {
		...process.env,
		CINAAUTH_ORGANIZATION_ADMIN_ROLES: "owner,workspace-admin",
	};
	delete env.D1_DATABASE_ID;
	t.after(() => {
		const restoreEnv = { ...process.env };
		delete restoreEnv.D1_DATABASE_ID;
		delete restoreEnv.CINAAUTH_ORGANIZATION_ADMIN_ROLES;
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
	]) {
		const config = JSON.parse(readFileSync(join(root, relativePath), "utf8"));
		assert.equal(
			config.vars.CINAAUTH_ORGANIZATION_ADMIN_ROLES,
			"owner,workspace-admin",
		);
	}
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
