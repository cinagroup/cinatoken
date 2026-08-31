#!/usr/bin/env node
/**
 * First-time Cloudflare bootstrap for external self-hosters:
 * login check → create/reuse D1 → write instance env → migrate → deploy
 * Queue resources + proxy + admin + isolated Chain Worker → print hints.
 *
 * Usage (repo root):
 *   npm run bootstrap:cloudflare
 *   node scripts/deploy/bootstrap-cloudflare.mjs [options]
 *
 * Options:
 *   --instance <name>           Env file basename (default: interactive / "default")
 *   --prefix <prefix>           Worker/D1 name prefix (default: cinatoken)
 *   --proxy-domain <host>       Optional custom domain for Proxy
 *   --admin-domain <host>       Optional custom domain for Admin
 *   --reuse-d1                  Fail if D1 name missing (do not create)
 *   --d1-id <uuid>              Use this D1 id (skip create/list match by name)
 *   --skip-secret               Stop after resources/migrations; provision secrets later
 *   --yes, -y                   Accept bootstrap defaults (migration still confirms on a TTY)
 *   --help, -h
 */
import { existsSync } from "node:fs";
import {
	assertWranglerLoggedIn,
	ensureD1Database,
	ensureQueue,
	ensureWorkerSecretTarget,
	envPathForInstance,
	log,
	logError,
	namesFromPrefix,
	printDownstreamHints,
	printLocalDevHint,
	promptLine,
	promptYesNo,
	putWorkerSecret,
	runNpmWithEnv,
	writeInstanceEnvFile,
} from "./cf-deploy-lib.mjs";

function usage() {
	console.log(`Usage: npm run bootstrap:cloudflare -- [options]

First-time Cloudflare deploy (Proxy + unified console + Chain Worker + shared D1).

Options:
  --instance <name>           cloudflare-worker/<name>.env (default: default)
  --prefix <prefix>           Names: <prefix>-proxy / -admin / D1 <prefix>
                              (default: cinatoken)
  --proxy-domain <host>       Optional Proxy custom domain
  --admin-domain <host>       Optional Admin custom domain
  --reuse-d1                  Require existing D1 with that name
  --d1-id <uuid>              Use existing D1 id directly
  --skip-secret               Stop after resources/migrations; provision secrets later
  --yes, -y                   Accept bootstrap defaults; migration still confirms on a TTY
  --help, -h

Example:
  npm run bootstrap:cloudflare -- --instance mygw --prefix my-gateway -y
`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
	/** @type {Record<string, string | boolean>} */
	const out = {
		yes: false,
		reuseD1: false,
		skipSecret: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (!v || v.startsWith("-")) {
				throw new Error(`missing value for ${a}`);
			}
			return v;
		};
		switch (a) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--yes":
			case "-y":
				out.yes = true;
				break;
			case "--reuse-d1":
				out.reuseD1 = true;
				break;
			case "--skip-secret":
				out.skipSecret = true;
				break;
			case "--instance":
				out.instance = next();
				break;
			case "--prefix":
				out.prefix = next();
				break;
			case "--proxy-domain":
				out.proxyDomain = next();
				break;
			case "--admin-domain":
				out.adminDomain = next();
				break;
			case "--d1-id":
				out.d1Id = next();
				break;
			default:
				throw new Error(`unknown option: ${a}`);
		}
	}
	return out;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		usage();
		return;
	}

	const interactive = process.stdin.isTTY && !args.yes;

	let instance =
		typeof args.instance === "string" ? args.instance : "";
	if (!instance) {
		instance = interactive
			? await promptLine("Instance name (env file basename)", "default")
			: "default";
	}

	let prefix = typeof args.prefix === "string" ? args.prefix : "";
	if (!prefix) {
		prefix = interactive
			? await promptLine(
					"Resource name prefix (Workers + D1)",
					"cinatoken",
				)
			: "cinatoken";
	}

	const baseNames = namesFromPrefix(prefix);
	const requiredSecretNames = [
		"SHARED_KEY_ENCRYPTION_SECRET",
		"CINATOKEN_OIDC_CLIENT_SECRET",
		"CINATOKEN_OIDC_BRIDGE_SECRET",
		"CINATOKEN_OIDC_TRANSACTION_SECRET",
		"CINATOKEN_IDENTITY_EVENTS_SECRET",
		"CINACHAIN_RPC_URL",
		"CINACHAIN_MINTER_PRIVATE_KEY",
		"CINABADGE_CONTRACT_ADDRESS",
		"CINACREDIT_CONTRACT_ADDRESS",
	];
	if (!args.skipSecret && !interactive) {
		const missing = requiredSecretNames.filter((name) => !process.env[name]);
		if (missing.length > 0) {
			throw new Error(
				`Non-interactive bootstrap requires secret values in process environment: ${missing.join(", ")}`,
			);
		}
	}
	assertWranglerLoggedIn();
	let proxyDomain =
		typeof args.proxyDomain === "string" ? args.proxyDomain : "";
	let adminDomain =
		typeof args.adminDomain === "string" ? args.adminDomain : "";

	if (interactive && !proxyDomain && !adminDomain) {
		const wantDomain = await promptYesNo(
			"Bind custom domains now? (usually skip; use workers.dev first)",
			false,
		);
		if (wantDomain) {
			proxyDomain = await promptLine("Proxy custom domain (empty to skip)", "");
			adminDomain = await promptLine("Admin custom domain (empty to skip)", "");
		}
	}

	const envPath = envPathForInstance(instance);
	if (existsSync(envPath)) {
		if (interactive) {
			const overwrite = await promptYesNo(
				`Env file already exists (${envPath}). Overwrite?`,
				false,
			);
			if (!overwrite) {
				logError("Aborted. Use npm run deploy:cloudflare -- " + instance);
				process.exit(1);
			}
		} else if (!args.yes) {
			logError(
				`Env file already exists: ${envPath}. Pass --yes to overwrite, or pick another --instance.`,
			);
			process.exit(1);
		} else {
			log(`Overwriting existing env: ${envPath}`);
		}
	}

	let d1DatabaseId =
		typeof args.d1Id === "string" ? args.d1Id : "";
	if (!d1DatabaseId) {
		d1DatabaseId = ensureD1Database(baseNames.d1DatabaseName, {
			reuse: Boolean(args.reuseD1),
		});
	} else {
		log(`Using provided D1 id=${d1DatabaseId}`);
	}

	const names = {
		...baseNames,
		d1DatabaseId,
		proxyCustomDomain: proxyDomain || undefined,
		adminCustomDomain: adminDomain || undefined,
	};

	writeInstanceEnvFile(instance, names);
	ensureQueue(names.chainJobDlqName);
	ensureQueue(names.chainJobQueueName);

	/** @type {Record<string, string>} */
	const vars = {
		PROXY_WORKER_NAME: names.proxyWorkerName,
		ADMIN_WORKER_NAME: names.adminWorkerName,
		CHAIN_WORKER_NAME: names.chainWorkerName,
		CHAIN_JOB_QUEUE_NAME: names.chainJobQueueName,
		CHAIN_JOB_DLQ_NAME: names.chainJobDlqName,
		CINACHAIN_CHAIN_ID: process.env.CINACHAIN_CHAIN_ID || "84532",
		D1_DATABASE_NAME: names.d1DatabaseName,
		D1_DATABASE_ID: names.d1DatabaseId,
		D1_MIGRATIONS_WORKER_NAME: names.d1MigrationsWorkerName,
	};
	if (names.proxyCustomDomain) {
		vars.PROXY_CUSTOM_DOMAIN = names.proxyCustomDomain;
	}
	if (names.adminCustomDomain) {
		vars.ADMIN_CUSTOM_DOMAIN = names.adminCustomDomain;
	}

	const secretTargets = [
		[names.proxyWorkerName, ["SHARED_KEY_ENCRYPTION_SECRET"]],
		[names.adminWorkerName, [
			"CINATOKEN_OIDC_CLIENT_SECRET",
			"CINATOKEN_OIDC_BRIDGE_SECRET",
			"CINATOKEN_OIDC_TRANSACTION_SECRET",
			"CINATOKEN_IDENTITY_EVENTS_SECRET",
			"SHARED_KEY_ENCRYPTION_SECRET",
		]],
		[names.chainWorkerName, [
			"CINACHAIN_RPC_URL",
			"CINACHAIN_MINTER_PRIVATE_KEY",
			"CINABADGE_CONTRACT_ADDRESS",
			"CINACREDIT_CONTRACT_ADDRESS",
		]],
	];
	if (args.skipSecret) {
		log("Resources are ready; deployment stopped before secret provisioning and migrations.");
		log("Set the required Worker secrets, then run: npm run deploy:cloudflare -- " + instance);
		return;
	}
	for (const [workerName, namesForWorker] of secretTargets) {
		ensureWorkerSecretTarget(workerName);
		for (const secretName of namesForWorker) {
			putWorkerSecret(workerName, secretName, process.env[secretName]);
		}
	}

	log("Applying remote D1 migrations after all required Worker secrets are present…");
	runNpmWithEnv(vars, ["db:migrate:remote"]);

	log("Deploying Proxy Worker (usually under a minute)…");
	runNpmWithEnv(vars, ["deploy:proxy"]);
	log("Deploying isolated Chain Worker…");
	runNpmWithEnv(vars, ["deploy:chain"]);
	log("Deploying unified console Worker (OpenNext build)…");
	runNpmWithEnv(vars, ["deploy:admin"]);

	const proxyUrl = names.proxyCustomDomain
		? `https://${names.proxyCustomDomain}`
		: undefined;
	const adminUrl = names.adminCustomDomain
		? `https://${names.adminCustomDomain}`
		: undefined;

	printDownstreamHints({
		proxyUrl,
		adminUrl,
		proxyWorkerName: names.proxyWorkerName,
		adminWorkerName: names.adminWorkerName,
	});

	log(`Bootstrap complete. Instance env: cloudflare-worker/${instance}.env`);
	log(`Later deploys: npm run deploy:cloudflare -- ${instance} --migrate`);
	printLocalDevHint();
}

try {
	await main();
} catch (err) {
	logError(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
