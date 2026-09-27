import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedWorkerConfigs = [
	"packages/proxy/wrangler.jsonc",
	"packages/admin/wrangler.jsonc",
	"packages/chain-worker/wrangler.jsonc",
];
const reviewProducerEnvKeys = [
	"REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED",
	"DISPATCH_HYPERDRIVE_ID",
	"FACT_HYPERDRIVE_ID",
];
const repairEnvKeys = ["SHARED_KEY_USAGE_REPAIR_ENABLED", "REPAIR_HYPERDRIVE_ID"];
const earningEnvKeys = ["SHARED_EARNING_SCANNER_ENABLED",
	"EARNING_DELIVERY_HYPERDRIVE_ID", "EARNING_CONSUMER_HYPERDRIVE_ID"];

function reviewGeneratorEnv(overrides = {}) {
	const env = { ...process.env };
	for (const key of ["D1_DATABASE_ID", "HYPERDRIVE_ID", "DATABASE_DRIVER", ...reviewProducerEnvKeys, ...repairEnvKeys, ...earningEnvKeys]) {
		delete env[key];
	}
	return { ...env, ...overrides };
}

function runGenerator(env) {
	return spawnSync(process.execPath, ["scripts/deploy/gen-wrangler.mjs"], {
		cwd: root,
		env,
		encoding: "utf8",
	});
}

function generatedConfig(relativePath) {
	return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

test("generated Wrangler configs preserve HTTPS values and Workers Routes", () => {
	const env = { ...process.env };
	delete env.D1_DATABASE_ID;
	delete env.HYPERDRIVE_ID;
	delete env.DATABASE_DRIVER;
	for (const key of reviewProducerEnvKeys) delete env[key];
	for (const key of repairEnvKeys) delete env[key];
	for (const key of earningEnvKeys) delete env[key];
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
	assert.equal(proxy.vars?.SHARED_KEY_USAGE_REPAIR_ENABLED, undefined);
	assert.equal(proxy.vars?.SHARED_EARNING_SCANNER_ENABLED, undefined);
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

test("review producer Hyperdrive bindings are opt-in, distinct, and proxy-only", (t) => {
	const runtimeId = "11111111-2222-4333-8444-555555555555";
	const dispatchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	const factId = "99999999-8888-4777-8666-555555555555";
	t.after(() => {
		assert.equal(runGenerator(reviewGeneratorEnv()).status, 0);
	});
	const postgresEnv = reviewGeneratorEnv({
		DATABASE_DRIVER: "postgres",
		HYPERDRIVE_ID: runtimeId,
	});
	assert.equal(runGenerator(postgresEnv).status, 0);
	for (const relativePath of generatedWorkerConfigs) {
		assert.deepEqual(generatedConfig(relativePath).hyperdrive, [
			{ binding: "HYPERDRIVE", id: runtimeId },
		]);
	}
	const reviewEnv = {
		...postgresEnv,
		REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED: "true",
		DISPATCH_HYPERDRIVE_ID: dispatchId,
		FACT_HYPERDRIVE_ID: factId,
	};
	assert.equal(runGenerator(reviewEnv).status, 0);
	const proxy = generatedConfig("packages/proxy/wrangler.jsonc");
	assert.deepEqual(proxy.hyperdrive, [
		{ binding: "HYPERDRIVE", id: runtimeId },
		{ binding: "DISPATCH_HYPERDRIVE", id: dispatchId },
		{ binding: "FACT_HYPERDRIVE", id: factId },
	]);
	for (const relativePath of generatedWorkerConfigs.slice(1)) {
		assert.deepEqual(generatedConfig(relativePath).hyperdrive, [
			{ binding: "HYPERDRIVE", id: runtimeId },
		]);
	}
	for (const key of reviewProducerEnvKeys) assert.equal(proxy.vars?.[key], undefined);
	assert.equal(proxy.vars.DATABASE_DRIVER, "postgres");
});

test("review producer Hyperdrive input errors stop generation before writing any config", (t) => {
	t.after(() => {
		assert.equal(runGenerator(reviewGeneratorEnv()).status, 0);
	});
	const runtimeId = "11111111-2222-4333-8444-555555555555";
	const dispatchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	const factId = "99999999-8888-4777-8666-555555555555";
	const valid = {
		DATABASE_DRIVER: "postgres",
		HYPERDRIVE_ID: runtimeId,
		REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED: "true",
		DISPATCH_HYPERDRIVE_ID: dispatchId,
		FACT_HYPERDRIVE_ID: factId,
	};
	assert.equal(runGenerator(reviewGeneratorEnv(valid)).status, 0);
	const before = generatedWorkerConfigs.map((path) => readFileSync(join(root, path), "utf8"));
	for (const [name, overrides, error] of [
		["invalid opt-in flag", { REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED: "yes" }, /Expected true or false/],
		["IDs supplied with opt-in off", { REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED: "false" }, /require REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED=true/],
		["D1 selected", { DATABASE_DRIVER: "d1" }, /require DATABASE_DRIVER=postgres/],
		["no driver selected", { DATABASE_DRIVER: "" }, /require DATABASE_DRIVER=postgres/],
		["runtime ID missing", { HYPERDRIVE_ID: "" }, /HYPERDRIVE_ID is required/],
		["dispatch ID missing", { DISPATCH_HYPERDRIVE_ID: "" }, /DISPATCH_HYPERDRIVE_ID must be a canonical/],
		["fact ID missing", { FACT_HYPERDRIVE_ID: "" }, /FACT_HYPERDRIVE_ID must be a canonical/],
		["runtime ID malformed", { HYPERDRIVE_ID: "placeholder" }, /HYPERDRIVE_ID must be a canonical/],
		["dispatch ID malformed", { DISPATCH_HYPERDRIVE_ID: "bad-id" }, /DISPATCH_HYPERDRIVE_ID must be a canonical/],
		["fact ID malformed", { FACT_HYPERDRIVE_ID: "bad-id" }, /FACT_HYPERDRIVE_ID must be a canonical/],
		["dispatch uses runtime ID", { DISPATCH_HYPERDRIVE_ID: runtimeId }, /must be distinct/],
		["fact uses runtime ID", { FACT_HYPERDRIVE_ID: runtimeId }, /must be distinct/],
		["fact uses dispatch ID", { FACT_HYPERDRIVE_ID: dispatchId.toUpperCase() }, /must be distinct/],
	]) {
		const result = runGenerator(reviewGeneratorEnv({ ...valid, ...overrides }));
		assert.notEqual(result.status, 0, name);
		assert.match(result.stderr, error, name);
		assert.deepEqual(generatedWorkerConfigs.map((path) => readFileSync(join(root, path), "utf8")), before, name);
	}
});

test("shared-key usage repair Hyperdrive is explicit, proxy-only and distinct", (t) => {
	t.after(() => { assert.equal(runGenerator(reviewGeneratorEnv()).status, 0); });
	const runtimeId = "11111111-2222-4333-8444-555555555555";
	const dispatchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	const factId = "99999999-8888-4777-8666-555555555555";
	const repairId = "77777777-6666-4555-8444-333333333333";
	const postgresEnv = reviewGeneratorEnv({ DATABASE_DRIVER: "postgres", HYPERDRIVE_ID: runtimeId });
	assert.equal(runGenerator(postgresEnv).status, 0);
	assert.deepEqual(generatedConfig(generatedWorkerConfigs[0]).hyperdrive,
		[{ binding: "HYPERDRIVE", id: runtimeId }]);
	assert.equal(generatedConfig(generatedWorkerConfigs[0]).vars.SHARED_KEY_USAGE_REPAIR_ENABLED, undefined);
	assert.equal(runGenerator({ ...postgresEnv, SHARED_KEY_USAGE_REPAIR_ENABLED: "false" }).status, 0);
	assert.equal(generatedConfig(generatedWorkerConfigs[0]).vars.SHARED_KEY_USAGE_REPAIR_ENABLED, undefined);
	const enabled = { ...postgresEnv, SHARED_KEY_USAGE_REPAIR_ENABLED: "reviewed-v3",
		REPAIR_HYPERDRIVE_ID: repairId };
	assert.equal(runGenerator(enabled).status, 0);
	let proxy = generatedConfig(generatedWorkerConfigs[0]);
	assert.deepEqual(proxy.hyperdrive, [
		{ binding: "HYPERDRIVE", id: runtimeId },
		{ binding: "REPAIR_HYPERDRIVE", id: repairId },
	]);
	assert.equal(proxy.vars.SHARED_KEY_USAGE_REPAIR_ENABLED, "reviewed-v3");
	for (const path of generatedWorkerConfigs.slice(1)) {
		const other = generatedConfig(path);
		assert.deepEqual(other.hyperdrive, [{ binding: "HYPERDRIVE", id: runtimeId }]);
		assert.equal(other.vars?.SHARED_KEY_USAGE_REPAIR_ENABLED, undefined);
	}
	assert.equal(runGenerator({ ...enabled,
		REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED: "true",
		DISPATCH_HYPERDRIVE_ID: dispatchId,
		FACT_HYPERDRIVE_ID: factId }).status, 0);
	proxy = generatedConfig(generatedWorkerConfigs[0]);
	assert.deepEqual(proxy.hyperdrive, [
		{ binding: "HYPERDRIVE", id: runtimeId },
		{ binding: "DISPATCH_HYPERDRIVE", id: dispatchId },
		{ binding: "FACT_HYPERDRIVE", id: factId },
		{ binding: "REPAIR_HYPERDRIVE", id: repairId },
	]);
	assert.equal(proxy.vars.SHARED_KEY_USAGE_REPAIR_ENABLED, "reviewed-v3");
});

test("repair Hyperdrive invalid activation and shared IDs fail before any generated write", (t) => {
	t.after(() => { assert.equal(runGenerator(reviewGeneratorEnv()).status, 0); });
	const runtimeId = "11111111-2222-4333-8444-555555555555";
	const dispatchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	const factId = "99999999-8888-4777-8666-555555555555";
	const repairId = "77777777-6666-4555-8444-333333333333";
	const valid = { DATABASE_DRIVER: "postgres", HYPERDRIVE_ID: runtimeId,
		REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED: "true",
		DISPATCH_HYPERDRIVE_ID: dispatchId, FACT_HYPERDRIVE_ID: factId,
		SHARED_KEY_USAGE_REPAIR_ENABLED: "reviewed-v3", REPAIR_HYPERDRIVE_ID: repairId };
	assert.equal(runGenerator(reviewGeneratorEnv(valid)).status, 0);
	const before = generatedWorkerConfigs.map(path => readFileSync(join(root, path), "utf8"));
	for (const [name, overrides, error] of [
		["invalid activation", { SHARED_KEY_USAGE_REPAIR_ENABLED: "true" }, /must be reviewed-v3 or false/],
		["previous activation", { SHARED_KEY_USAGE_REPAIR_ENABLED: "reviewed-v2" }, /must be reviewed-v3 or false/],
		["ID with disabled switch", { SHARED_KEY_USAGE_REPAIR_ENABLED: "false" }, /requires SHARED_KEY_USAGE_REPAIR_ENABLED=reviewed-v3/],
		["missing repair ID", { REPAIR_HYPERDRIVE_ID: "" }, /REPAIR_HYPERDRIVE_ID must be a canonical/],
		["invalid repair ID", { REPAIR_HYPERDRIVE_ID: "placeholder" }, /REPAIR_HYPERDRIVE_ID must be a canonical/],
		["D1 selected", { DATABASE_DRIVER: "d1",
			REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED: "false",
			DISPATCH_HYPERDRIVE_ID: "", FACT_HYPERDRIVE_ID: "" }, /requires DATABASE_DRIVER=postgres/],
		["runtime ID reused", { REPAIR_HYPERDRIVE_ID: runtimeId }, /must differ/],
		["dispatch ID reused", { REPAIR_HYPERDRIVE_ID: dispatchId.toUpperCase() }, /must differ/],
		["fact ID reused", { REPAIR_HYPERDRIVE_ID: factId }, /must differ/],
	]) {
		const result = runGenerator(reviewGeneratorEnv({ ...valid, ...overrides }));
		assert.notEqual(result.status, 0, name);
		assert.match(result.stderr, error, name);
		assert.deepEqual(generatedWorkerConfigs.map(path => readFileSync(join(root, path), "utf8")), before, name);
	}
});

test("HTTP Worker generator refuses shared earning scanner credentials", (t) => {
	t.after(() => { assert.equal(runGenerator(reviewGeneratorEnv()).status, 0); });
	const runtimeId = "11111111-2222-4333-8444-555555555555";
	const deliveryId = "22222222-3333-4444-8555-666666666666";
	const consumerId = "33333333-4444-4555-8666-777777777777";
	const basic = reviewGeneratorEnv({ DATABASE_DRIVER: "postgres", HYPERDRIVE_ID: runtimeId });
	assert.equal(runGenerator(basic).status, 0);
	assert.equal(generatedConfig(generatedWorkerConfigs[0]).vars.SHARED_EARNING_SCANNER_ENABLED,
		undefined);
	const before = generatedWorkerConfigs.map(path => readFileSync(join(root,path),"utf8"));
	const enabled = { ...basic, SHARED_EARNING_SCANNER_ENABLED: "reviewed-v1",
		EARNING_DELIVERY_HYPERDRIVE_ID: deliveryId,
		EARNING_CONSUMER_HYPERDRIVE_ID: consumerId };
	const result = runGenerator(enabled);
	assert.notEqual(result.status,0);
	assert.match(result.stderr,/dedicated scheduled Worker/);
	assert.deepEqual(generatedWorkerConfigs.map(path => readFileSync(join(root,path),"utf8")),before);
});

test("HTTP Worker generator refuses every scanner binding shape before write", (t) => {
	t.after(() => { assert.equal(runGenerator(reviewGeneratorEnv()).status, 0); });
	const runtimeId = "11111111-2222-4333-8444-555555555555";
	const deliveryId = "22222222-3333-4444-8555-666666666666";
	const consumerId = "33333333-4444-4555-8666-777777777777";
	const valid = { DATABASE_DRIVER: "postgres", HYPERDRIVE_ID: runtimeId };
	assert.equal(runGenerator(reviewGeneratorEnv(valid)).status, 0);
	const before = generatedWorkerConfigs.map(path => readFileSync(join(root, path), "utf8"));
	for (const [name, overrides, error] of [
		["bad activation", { SHARED_EARNING_SCANNER_ENABLED: "true" }, /dedicated scheduled Worker/],
		["old opt-in", { SHARED_EARNING_SCANNER_ENABLED: "reviewed-v1" }, /dedicated scheduled Worker/],
		["new opt-in", { SHARED_EARNING_SCANNER_ENABLED: "dedicated-v1" }, /dedicated scheduled Worker/],
		["delivery ID", { EARNING_DELIVERY_HYPERDRIVE_ID: deliveryId }, /dedicated scheduled Worker/],
		["consumer ID", { EARNING_CONSUMER_HYPERDRIVE_ID: consumerId }, /dedicated scheduled Worker/],
		["both IDs", { EARNING_DELIVERY_HYPERDRIVE_ID: deliveryId,
			EARNING_CONSUMER_HYPERDRIVE_ID: consumerId }, /dedicated scheduled Worker/],
	]) {
		const result = runGenerator(reviewGeneratorEnv({ ...valid, ...overrides }));
		assert.notEqual(result.status, 0, name);
		assert.match(result.stderr, error, name);
		assert.deepEqual(generatedWorkerConfigs.map(path => readFileSync(join(root, path), "utf8")), before, name);
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
