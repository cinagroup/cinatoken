#!/usr/bin/env node
/**
 * Generate wrangler.jsonc / wrangler.d1.jsonc from *.base.jsonc + environment variables.
 *
 * Build variables (Workers Builds) or cloudflare-worker/*.env — see docs/operators/deployment/cloudflare.md
 *
 * Local D1 identity (important):
 * - Without D1_DATABASE_ID in env → generated configs have no database_id → local dev uses D1 "(DB)".
 * - With D1_DATABASE_ID (remote deploy / db:migrate:remote) → local wrangler dev uses a *different*
 *   SQLite under .wrangler/state than npm run db:migrate (default local path).
 * After any remote deploy on this machine, run `npm run gen:wrangler` (no D1_DATABASE_ID in shell)
 * before dev:proxy / dev:admin. See docs/developers/local-development.md §1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

const REMOTE = process.argv.includes("--remote");

function trimEnv(key) {
	const v = process.env[key];
	return typeof v === "string" ? v.trim() : "";
}

function resolveWorkerDatabaseDriver() {
	const raw = trimEnv("DATABASE_DRIVER").toLowerCase();
	if (!raw) return "";
	if (raw === "d1") return "d1";
	if (raw === "postgres" || raw === "postgresql") return "postgres";
	console.error(
		`gen-wrangler: unsupported Cloudflare DATABASE_DRIVER="${raw}". Expected d1 or postgres.`,
	);
	process.exit(1);
}

function resolveMaintenanceMode() {
	const raw = trimEnv("CINATOKEN_MAINTENANCE_MODE").toLowerCase();
	if (!raw || raw === "false") return false;
	if (raw === "true") return true;
	console.error(
		`gen-wrangler: unsupported CINATOKEN_MAINTENANCE_MODE="${raw}". Expected true or false.`,
	);
	process.exit(1);
}

function resolveNames() {
	const d1DatabaseName =
		trimEnv("D1_DATABASE_NAME") || "cinatoken";
	const chainWorkerName =
		trimEnv("CHAIN_WORKER_NAME") || "cinatoken-chain-worker";

	return {
		proxyWorkerName:
			trimEnv("PROXY_WORKER_NAME") || "cinatoken-proxy",
		adminWorkerName:
			trimEnv("ADMIN_WORKER_NAME") || "cinatoken-admin",
		chainWorkerName,
		chainJobQueueName:
			trimEnv("CHAIN_JOB_QUEUE_NAME") || `${d1DatabaseName}-chain-jobs`,
		chainJobDlqName:
			trimEnv("CHAIN_JOB_DLQ_NAME") || `${d1DatabaseName}-chain-jobs-dlq`,
		cinachainChainId: trimEnv("CINACHAIN_CHAIN_ID") || "84532",
		d1MigrationsWorkerName:
			trimEnv("D1_MIGRATIONS_WORKER_NAME") ||
			"cinatoken-d1-migrations",
		d1DatabaseName,
		d1DatabaseId: trimEnv("D1_DATABASE_ID"),
		hyperdriveId: trimEnv("HYPERDRIVE_ID"),
		databaseDriver: resolveWorkerDatabaseDriver(),
		maintenanceMode: resolveMaintenanceMode(),
		proxyCustomDomain: trimEnv("PROXY_CUSTOM_DOMAIN"),
		adminCustomDomain: trimEnv("ADMIN_CUSTOM_DOMAIN"),
	};
}

/** Strip JSONC comments without treating `//` inside strings as comments. */
function parseJsonc(text) {
	let output = "";
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		const next = text[index + 1];
		if (inLineComment) {
			if (character === "\n" || character === "\r") {
				inLineComment = false;
				output += character;
			}
			continue;
		}
		if (inBlockComment) {
			if (character === "*" && next === "/") {
				inBlockComment = false;
				index += 1;
			} else if (character === "\n" || character === "\r") {
				output += character;
			}
			continue;
		}
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
			continue;
		}
		if (character === "/" && next === "/") {
			inLineComment = true;
			index += 1;
			continue;
		}
		if (character === "/" && next === "*") {
			inBlockComment = true;
			index += 1;
			continue;
		}
		output += character;
	}
	return JSON.parse(output);
}

function readBase(relativePath) {
	const path = join(ROOT, relativePath);
	return parseJsonc(readFileSync(path, "utf8"));
}

function writeJson(relativePath, data) {
	const path = join(ROOT, relativePath);
	writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
	console.log(`gen-wrangler: wrote ${relativePath}`);
}

function applyD1Binding(binding, databaseName, databaseId) {
	const next = { ...binding, database_name: databaseName };
	if (databaseId) {
		next.database_id = databaseId;
	} else {
		delete next.database_id;
	}
	return next;
}

function customDomainRoutes(domain) {
	if (!domain) {
		return undefined;
	}
	return [{ pattern: domain, custom_domain: true }];
}

function applyWorkerDatabaseRuntime(config, names) {
	const next = { ...config };
	if (names.databaseDriver === "postgres" && names.hyperdriveId) {
		next.hyperdrive = [{ binding: "HYPERDRIVE", id: names.hyperdriveId }];
	} else {
		delete next.hyperdrive;
	}

	const vars = { ...(config.vars ?? {}) };
	if (names.databaseDriver) {
		vars.DATABASE_DRIVER = names.databaseDriver;
	} else {
		delete vars.DATABASE_DRIVER;
	}
	if (Object.keys(vars).length > 0) next.vars = vars;
	else delete next.vars;
	return next;
}

function applyHttpMaintenanceMode(config, names) {
	const next = { ...config };
	const vars = { ...(config.vars ?? {}) };
	if (names.maintenanceMode) vars.CINATOKEN_MAINTENANCE_MODE = "true";
	else delete vars.CINATOKEN_MAINTENANCE_MODE;
	if (Object.keys(vars).length > 0) next.vars = vars;
	else delete next.vars;
	return next;
}

function generateProxy(names) {
	const base = readBase("packages/proxy/wrangler.base.jsonc");
	const config = applyHttpMaintenanceMode(applyWorkerDatabaseRuntime({
		...base,
		name: names.proxyWorkerName,
		d1_databases: [
			applyD1Binding(
				base.d1_databases[0],
				names.d1DatabaseName,
				names.d1DatabaseId,
			),
		],
	}, names), names);
	const routes = customDomainRoutes(names.proxyCustomDomain);
	if (routes) {
		config.routes = routes;
	} else if (!Array.isArray(base.routes) || base.routes.length === 0) {
		delete config.routes;
	}

	writeJson("packages/proxy/wrangler.jsonc", config);
}

function generateAdmin(names) {
	const base = readBase("packages/admin/wrangler.base.jsonc");
	const config = applyHttpMaintenanceMode(applyWorkerDatabaseRuntime({
		...base,
		name: names.adminWorkerName,
		d1_databases: [
			applyD1Binding(
				base.d1_databases[0],
				names.d1DatabaseName,
				names.d1DatabaseId,
			),
		],
		queues: {
			...base.queues,
			producers: base.queues.producers.map((producer) => ({
				...producer,
				queue: names.chainJobQueueName,
			})),
		},
		vars: {
			...base.vars,
			CINACHAIN_CHAIN_ID: names.cinachainChainId,
		},
	}, names), names);

	const routes = customDomainRoutes(names.adminCustomDomain);
	if (routes) {
		config.routes = routes;
	} else if (!Array.isArray(base.routes) || base.routes.length === 0) {
		delete config.routes;
	}

	writeJson("packages/admin/wrangler.jsonc", config);
}

function generateChain(names) {
	const base = readBase("packages/chain-worker/wrangler.base.jsonc");
	const config = applyWorkerDatabaseRuntime({
		...base,
		name: names.chainWorkerName,
		d1_databases: [
			applyD1Binding(
				base.d1_databases[0],
				names.d1DatabaseName,
				names.d1DatabaseId,
			),
		],
		queues: {
			...base.queues,
			// The primary consumer is renamed to the deployment queue name and
			// always carries the DLQ; the DLQ's own consumer (terminal triage,
			// max_retries: 0) is renamed to the DLQ name and must NOT receive a
			// dead_letter_queue of its own.
			consumers: base.queues.consumers.map((consumer) =>
				consumer.queue === 'cinatoken-chain-jobs-dlq'
					? { ...consumer, queue: names.chainJobDlqName }
					: {
							...consumer,
							queue: names.chainJobQueueName,
							dead_letter_queue: names.chainJobDlqName,
						},
			),
			producers: (base.queues.producers ?? []).map((producer) => ({
				...producer,
				queue: names.chainJobQueueName,
			})),
		},
		vars: {
			...base.vars,
			CINACHAIN_CHAIN_ID: names.cinachainChainId,
		},
	}, names);
	writeJson("packages/chain-worker/wrangler.jsonc", config);
}

function generateD1(names) {
	const base = readBase("packages/core/wrangler.d1.base.jsonc");
	const config = {
		...base,
		name: names.d1MigrationsWorkerName,
		d1_databases: [
			applyD1Binding(
				base.d1_databases[0],
				names.d1DatabaseName,
				names.d1DatabaseId,
			),
		],
	};

	writeJson("packages/core/wrangler.d1.jsonc", config);
}

function validateRemote(names) {
	if (names.d1DatabaseId) {
		return;
	}
	console.error(
		"gen-wrangler: D1_DATABASE_ID is required for remote deploy/migrate.\n" +
			"  Set it in Workers Builds › Build variables, or:\n" +
			"  npx dotenv -e ./cloudflare-worker/<instance>.env -- npm run gen:wrangler -- --remote",
	);
	process.exit(1);
}

function validateWorkerDatabaseRuntime(names) {
	if (names.databaseDriver === "postgres" && !names.hyperdriveId) {
		console.error(
			"gen-wrangler: HYPERDRIVE_ID is required when DATABASE_DRIVER=postgres. " +
				"The Worker connection string must come from the HYPERDRIVE binding.",
		);
		process.exit(1);
	}
}

function main() {
	const names = resolveNames();
	validateWorkerDatabaseRuntime(names);

	if (REMOTE) {
		validateRemote(names);
	}

	generateProxy(names);
	generateAdmin(names);
	generateChain(names);
	generateD1(names);

	console.log(
		`gen-wrangler: proxy=${names.proxyWorkerName} admin=${names.adminWorkerName} chain=${names.chainWorkerName} queue=${names.chainJobQueueName} d1=${names.d1DatabaseName}` +
			(names.d1DatabaseId ? ` id=${names.d1DatabaseId}` : " (local, no database_id)") +
			(names.hyperdriveId
				? ` hyperdrive=${names.hyperdriveId} driver=${names.databaseDriver || "d1 (staged target, unbound)"}`
				: "") +
			(names.maintenanceMode ? " maintenance=true" : ""),
	);

	if (REMOTE && names.d1DatabaseId) {
		console.warn(
			"gen-wrangler: remote config written (includes database_id). " +
				"Before local dev:proxy/dev:admin, run `npm run gen:wrangler` without D1_DATABASE_ID in the shell.",
		);
	}
}

main();
