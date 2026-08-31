#!/usr/bin/env node
/**
 * Redeploy an existing Cloudflare instance (env file already present).
 *
 * Usage (repo root):
 *   npm run deploy:cloudflare -- <instance> [options]
 *   node scripts/deploy/deploy-instance.mjs <instance> [options]
 *
 * Options:
 *   --migrate, -m       Run db:migrate:remote before deploy
 *   --migrate-only      Only remote D1 migrate
 *   --proxy-only        Only deploy Proxy Worker
 *   --admin-only        Only deploy Admin Worker
 *   --preflight-only    Validate auth, config and required remote secret names; no writes
 *   --show-master-key   Print remote system_config.MASTER_KEY (no deploy)
 *   --help, -h
 *
 * Env file: cloudflare-worker/<instance>.env (gitignore)
 */
import { existsSync } from "node:fs";
import {
	assertWranglerLoggedIn,
	assertWorkerSecrets,
	ensureQueue,
	envPathForInstance,
	fetchRemoteMasterKey,
	log,
	logError,
	parseEnvFile,
	printLocalDevHint,
	runNpmWithEnv,
} from "./cf-deploy-lib.mjs";

function usage() {
	console.log(`Usage: npm run deploy:cloudflare -- <instance> [options]

Options:
  --migrate, -m       Run db:migrate:remote before deploy
  --migrate-only      Only remote D1 migrate
  --proxy-only        Only deploy Proxy Worker
  --admin-only        Only deploy Admin Worker
  --chain-only        Only deploy Chain Worker
  --preflight-only    Validate config and secret names without changing Cloudflare
  --show-master-key   Print remote MASTER_KEY (no deploy)
  --help, -h          Show this help

Example:
  npm run deploy:cloudflare -- mygw --migrate
`);
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		usage();
		process.exit(argv.length === 0 ? 1 : 0);
	}

	const instance = argv.find((a) => !a.startsWith("-"));
	if (!instance) {
		logError("instance name required");
		usage();
		process.exit(1);
	}

	let doMigrate = false;
	let doProxy = true;
	let doAdmin = true;
	let doChain = true;
	let showMasterKey = false;
	let preflightOnly = false;

	for (const arg of argv) {
		if (arg === instance) {
			continue;
		}
		switch (arg) {
			case "--migrate":
			case "-m":
				doMigrate = true;
				break;
			case "--migrate-only":
				doMigrate = true;
				doProxy = false;
				doAdmin = false;
				doChain = false;
				break;
			case "--proxy-only":
				doProxy = true;
				doAdmin = false;
				doChain = false;
				break;
			case "--admin-only":
				doProxy = false;
				doAdmin = true;
				doChain = false;
				break;
			case "--chain-only":
				doProxy = false;
				doAdmin = false;
				doChain = true;
				break;
			case "--preflight-only":
				preflightOnly = true;
				break;
			case "--show-master-key":
				showMasterKey = true;
				doProxy = false;
				doAdmin = false;
				doChain = false;
				doMigrate = false;
				break;
			case "--help":
			case "-h":
				usage();
				process.exit(0);
				break;
			default:
				logError(`unknown option: ${arg}`);
				usage();
				process.exit(1);
		}
	}

	const envPath = envPathForInstance(instance);
	if (!existsSync(envPath)) {
		logError(`env file not found: ${envPath}`);
		logError(
			`Copy cloudflare-worker/example.env or run: npm run bootstrap:cloudflare`,
		);
		process.exit(1);
	}

	const vars = parseEnvFile(envPath);
	if (!vars.D1_DATABASE_ID || !vars.D1_DATABASE_NAME) {
		logError("D1_DATABASE_ID and D1_DATABASE_NAME are required in the env file");
		process.exit(1);
	}
	const rawDatabaseDriver = (vars.DATABASE_DRIVER || "").trim().toLowerCase();
	const databaseDriver = rawDatabaseDriver === "postgresql" ? "postgres" : rawDatabaseDriver;
	if (databaseDriver && databaseDriver !== "d1" && databaseDriver !== "postgres") {
		logError("Cloudflare DATABASE_DRIVER must be d1 or postgres");
		process.exit(1);
	}
	if (databaseDriver === "postgres" && !vars.HYPERDRIVE_ID) {
		logError("HYPERDRIVE_ID is required when DATABASE_DRIVER=postgres");
		process.exit(1);
	}

	assertWranglerLoggedIn();

	log(`Instance: ${instance}`);
	log(`Config: cloudflare-worker/${instance}.env`);
	log(
		databaseDriver === "postgres"
			? `Database: Hyperdrive Postgres (${vars.HYPERDRIVE_ID}) with D1 retained for rollback`
			: vars.HYPERDRIVE_ID
				? `Database: D1 (Hyperdrive ${vars.HYPERDRIVE_ID} is staged but inactive)`
				: "Database: D1",
	);

	if (showMasterKey) {
		const key = fetchRemoteMasterKey(vars);
		if (!key) {
			logError("Could not read MASTER_KEY from remote D1");
			process.exit(1);
		}
		console.log(key);
		return;
	}

	// Fail closed before migrations or partial deployment. Secret values remain
	// opaque; only the required remote names are inspected.
	if (doProxy) {
		assertWorkerSecrets(vars.PROXY_WORKER_NAME || "cinatoken-proxy", [
			"SHARED_KEY_ENCRYPTION_SECRET",
			"DEEPSEEK_API_KEY",
		]);
	}
	if (doChain) {
		assertWorkerSecrets(vars.CHAIN_WORKER_NAME || "cinatoken-chain-worker", [
			"CINACHAIN_RPC_URL",
			"CINACHAIN_MINTER_PRIVATE_KEY",
			"CINABADGE_CONTRACT_ADDRESS",
			"CINACREDIT_CONTRACT_ADDRESS",
		]);
	}
	if (doAdmin) {
		assertWorkerSecrets(vars.ADMIN_WORKER_NAME || "cinatoken-admin", [
			"CINATOKEN_OIDC_CLIENT_SECRET",
			"CINATOKEN_OIDC_BRIDGE_SECRET",
			"CINATOKEN_OIDC_TRANSACTION_SECRET",
			"CINATOKEN_IDENTITY_EVENTS_SECRET",
			"SHARED_KEY_ENCRYPTION_SECRET",
			"DEEPSEEK_API_KEY",
		]);
	}
	if (preflightOnly) {
		log(`${instance} preflight passed; no resources were changed.`);
		return;
	}

	if (doMigrate) {
		if (databaseDriver === "postgres") {
			log("--migrate applies only the retained D1 rollback database; run db:migrate:pg separately before cutover.");
		}
		runNpmWithEnv(vars, ["db:migrate:remote"]);
	}
	if (doAdmin || doChain) {
		const resourcePrefix = vars.D1_DATABASE_NAME || "cinatoken";
		ensureQueue(vars.CHAIN_JOB_DLQ_NAME || `${resourcePrefix}-chain-jobs-dlq`);
		ensureQueue(vars.CHAIN_JOB_QUEUE_NAME || `${resourcePrefix}-chain-jobs`);
	}
	if (doProxy) {
		runNpmWithEnv(vars, ["deploy:proxy"]);
	}
	if (doChain) {
		runNpmWithEnv(vars, ["deploy:chain"]);
	}
	if (doAdmin) {
		runNpmWithEnv(vars, ["deploy:admin"]);
	}

	log(`${instance} done.`);
	if (doProxy || doAdmin || doChain) {
		printLocalDevHint();
	}
}

try {
	main();
} catch (err) {
	logError(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
