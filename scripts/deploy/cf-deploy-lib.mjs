/**
 * Shared helpers for Cloudflare bootstrap / instance deploy CLIs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import {
	platform,
	stdin as input,
	stdout as output,
} from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "../..");
export const CF_WORKER_DIR = join(REPO_ROOT, "cloudflare-worker");
const require = createRequire(import.meta.url);
const WRANGLER_CLI = require.resolve("wrangler");

/**
 * Run npm without directly spawning npm.cmd on Windows. npm_execpath is set
 * when these deploy scripts are launched through npm run. The cmd.exe fallback
 * keeps the documented direct `node scripts/deploy/*.mjs` entry points working.
 *
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} options
 */
function spawnNpm(args, options) {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath && existsSync(npmExecPath)) {
		return spawnSync(process.execPath, [npmExecPath, ...args], options);
	}
	if (platform === "win32") {
		return spawnSync(
			process.env.ComSpec || "cmd.exe",
			["/d", "/s", "/c", "npm.cmd", ...args],
			options,
		);
	}
	return spawnSync("npm", args, options);
}

/**
 * @param {ReturnType<typeof spawnSync>} result
 * @param {string} command
 */
function commandFailure(result, command) {
	const details = [];
	if (result.error) {
		const code =
			"code" in result.error && result.error.code
				? `${result.error.code}: `
				: "";
		details.push(`${code}${result.error.message}`);
	}
	const output = (result.stderr || result.stdout || "").toString().trim();
	if (output) {
		details.push(output);
	}
	const status =
		result.status === null ? "could not start" : `exit ${result.status}`;
	return new Error(
		`${command} failed (${status})${details.length ? `\n${details.join("\n")}` : ""}`,
	);
}

export function log(msg) {
	console.log(`[cf-deploy] ${msg}`);
}

export function logError(msg) {
	console.error(`[cf-deploy] ERROR: ${msg}`);
}

export function envPathForInstance(instance) {
	return join(CF_WORKER_DIR, `${instance}.env`);
}

/** Parse KEY=VALUE lines from a dotenv-style file (no expansion). */
export function parseEnvFile(filePath) {
	const text = readFileSync(filePath, "utf8");
	/** @type {Record<string, string>} */
	const env = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const eq = line.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		env[key] = value;
	}
	return env;
}

/**
 * @param {Record<string, string>} vars
 * @param {string[]} [extraArgs]
 */
export function runNpmWithEnv(vars, extraArgs) {
	const env = { ...process.env, ...vars };
	const args = ["npm", "run", ...extraArgs];
	log(`>>> ${args.join(" ")}`);
	const result = spawnNpm(args.slice(1), {
		cwd: REPO_ROOT,
		env,
		stdio: "inherit",
	});
	if ((result.status ?? 1) !== 0) {
		throw commandFailure(result, args.join(" "));
	}
}

/**
 * @param {string[]} wranglerArgs
 * @param {{ env?: Record<string, string>, input?: string, capture?: boolean, allowFailure?: boolean }} [opts]
 */
export function runWrangler(wranglerArgs, opts = {}) {
	const env = { ...process.env, ...(opts.env || {}) };
	const stdio = opts.capture
		? ["pipe", "pipe", "pipe"]
		: opts.input !== undefined
			? ["pipe", "inherit", "inherit"]
			: "inherit";
	log(`>>> npx wrangler ${wranglerArgs.join(" ")}`);
	const result = spawnSync(
		process.execPath,
		["--no-warnings", WRANGLER_CLI, ...wranglerArgs],
		{
			cwd: REPO_ROOT,
			env,
			stdio,
			input: opts.input,
			encoding: opts.capture ? "utf8" : undefined,
		},
	);
	if ((result.status ?? 1) !== 0 && !opts.allowFailure) {
		throw commandFailure(
			result,
			`npx wrangler ${wranglerArgs.join(" ")}`,
		);
	}
	return {
		stdout: opts.capture ? (result.stdout || "").toString() : "",
		stderr: opts.capture ? (result.stderr || "").toString() : "",
		status: result.status ?? 1,
	};
}

export function assertWranglerLoggedIn() {
	try {
		runWrangler(["whoami"], { capture: true });
	} catch (err) {
		logError("Cloudflare authentication check failed.");
		logError(err instanceof Error ? err.message : String(err));
		logError("If Wrangler is not logged in, run: npx wrangler login");
		process.exit(1);
	}
	log("Cloudflare auth OK (wrangler whoami)");
}

/**
 * @returns {Array<{ name: string, uuid: string }>}
 */
export function listD1Databases() {
	const { stdout } = runWrangler(["d1", "list", "--json"], { capture: true });
	const trimmed = stdout.trim();
	if (!trimmed) {
		return [];
	}
	try {
		const parsed = JSON.parse(trimmed);
		if (Array.isArray(parsed)) {
			return parsed.map((row) => ({
				name: String(row.name || row.database_name || ""),
				uuid: String(row.uuid || row.database_id || ""),
			}));
		}
		if (Array.isArray(parsed?.result)) {
			return parsed.result.map((row) => ({
				name: String(row.name || row.database_name || ""),
				uuid: String(row.uuid || row.database_id || ""),
			}));
		}
	} catch {
		// fall through to line parse
	}
	/** @type {Array<{ name: string, uuid: string }>} */
	const rows = [];
	const uuidRe =
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
	for (const line of trimmed.split("\n")) {
		const m = line.match(uuidRe);
		if (!m) {
			continue;
		}
		const uuid = m[0];
		const name = line.replace(uuid, "").replace(/[│|]/g, " ").trim().split(/\s+/)[0];
		if (name) {
			rows.push({ name, uuid });
		}
	}
	return rows;
}

/**
 * @param {string} databaseName
 * @returns {string} database_id
 */
export function createD1Database(databaseName) {
	const { stdout, stderr } = runWrangler(["d1", "create", databaseName], {
		capture: true,
	});
	const combined = `${stdout}\n${stderr}`;
	const uuidRe =
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
	const idMatch = combined.match(/database_id\s*=\s*"?([^"\s]+)"?/i);
	if (idMatch?.[1] && uuidRe.test(idMatch[1])) {
		return idMatch[1];
	}
	const any = combined.match(uuidRe);
	if (any) {
		return any[0];
	}
	throw new Error(
		`Could not parse database_id from wrangler d1 create output.\n${combined}`,
	);
}

/**
 * Resolve D1 id: reuse existing by name, or create.
 * @param {string} databaseName
 * @param {{ reuse?: boolean }} [opts]
 */
export function ensureD1Database(databaseName, opts = {}) {
	const existing = listD1Databases().find((d) => d.name === databaseName);
	if (existing?.uuid) {
		log(`Reusing existing D1 "${databaseName}" (${existing.uuid})`);
		return existing.uuid;
	}
	if (opts.reuse) {
		throw new Error(
			`D1 "${databaseName}" not found. Create it or omit --reuse-d1.`,
		);
	}
	log(`Creating D1 database "${databaseName}"…`);
	const id = createD1Database(databaseName);
	log(`Created D1 "${databaseName}" id=${id}`);
	return id;
}

/** @returns {Array<{ name: string }>} */
export function listQueues() {
	const { stdout } = runWrangler(["queues", "list", "--json"], { capture: true });
	const parsed = JSON.parse(stdout.trim() || "[]");
	const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.result) ? parsed.result : [];
	return rows.map((row) => ({ name: String(row.name || row.queue_name || "") }));
}

/** Create a Queue once; existing resources are reused without mutation. */
export function ensureQueue(queueName) {
	if (listQueues().some((queue) => queue.name === queueName)) {
		log(`Reusing existing Queue "${queueName}"`);
		return;
	}
	log(`Creating Queue "${queueName}"…`);
	runWrangler(["queues", "create", queueName]);
}

/**
 * @param {string} instance
 * @param {{
 *   proxyWorkerName: string,
 *   adminWorkerName: string,
 *   chainWorkerName: string,
 *   chainJobQueueName: string,
 *   chainJobDlqName: string,
 *   d1DatabaseName: string,
 *   d1DatabaseId: string,
 *   d1MigrationsWorkerName: string,
 *   proxyCustomDomain?: string,
 *   adminCustomDomain?: string,
 * }} names
 */
export function writeInstanceEnvFile(instance, names) {
	if (!existsSync(CF_WORKER_DIR)) {
		mkdirSync(CF_WORKER_DIR, { recursive: true });
	}
	const path = envPathForInstance(instance);
	const lines = [
		`# Generated by npm run bootstrap:cloudflare — do not commit`,
		`# Instance: ${instance}`,
		`# Docs: docs/operators/deployment/cloudflare-quickstart.md`,
		``,
		`PROXY_WORKER_NAME=${names.proxyWorkerName}`,
		`ADMIN_WORKER_NAME=${names.adminWorkerName}`,
		`CHAIN_WORKER_NAME=${names.chainWorkerName}`,
		`CHAIN_JOB_QUEUE_NAME=${names.chainJobQueueName}`,
		`CHAIN_JOB_DLQ_NAME=${names.chainJobDlqName}`,
		`CINACHAIN_CHAIN_ID=84532`,
		``,
		`D1_DATABASE_NAME=${names.d1DatabaseName}`,
		`D1_DATABASE_ID=${names.d1DatabaseId}`,
		`D1_MIGRATIONS_WORKER_NAME=${names.d1MigrationsWorkerName}`,
		``,
	];
	if (names.proxyCustomDomain) {
		lines.push(`PROXY_CUSTOM_DOMAIN=${names.proxyCustomDomain}`);
	} else {
		lines.push(`# PROXY_CUSTOM_DOMAIN=`);
	}
	if (names.adminCustomDomain) {
		lines.push(`ADMIN_CUSTOM_DOMAIN=${names.adminCustomDomain}`);
	} else {
		lines.push(`# ADMIN_CUSTOM_DOMAIN=`);
	}
	lines.push("");
	writeFileSync(path, lines.join("\n"), "utf8");
	log(`Wrote ${path}`);
	return path;
}

/**
 * @param {string} adminWorkerName
 * @param {string | undefined} password  if omitted, wrangler prompts interactively
 */
export function putWorkerSecret(workerName, secretName, value) {
	const args = ["secret", "put", secretName, "--name", workerName];
	if (value !== undefined && value !== "") {
		runWrangler(args, { input: `${value}\n` });
	} else {
		log(`Enter ${secretName} for ${workerName} when Wrangler prompts (not stored)…`);
		runWrangler(args);
	}
}

/** Return whether a Worker already has at least one deployed version. */
export function workerExists(workerName) {
	const args = ["deployments", "list", "--name", workerName, "--json"];
	const result = runWrangler(args, { capture: true, allowFailure: true });
	if (result.status === 0) {
		return true;
	}
	const combined = `${result.stdout}\n${result.stderr}`;
	if (/not found|does not exist/i.test(combined)) {
		return false;
	}
	throw new Error(
		`Unable to determine whether Worker ${workerName} exists.\n${combined.trim()}`,
	);
}

/**
 * Wrangler can only write a secret after the target Worker exists. Create an
 * inactive, no-route 503 Worker for first-time bootstrap; the real deploy
 * replaces it only after all required secrets are present.
 */
export function ensureWorkerSecretTarget(workerName) {
	if (workerExists(workerName)) {
		log(`Reusing existing Worker secret target "${workerName}"`);
		return;
	}
	log(`Creating inactive secret bootstrap Worker "${workerName}"…`);
	runWrangler([
		"deploy",
		"--config",
		"./scripts/deploy/wrangler.secret-bootstrap.jsonc",
		"--name",
		workerName,
	]);
}

export function listWorkerSecretNames(workerName) {
	const { stdout } = runWrangler(["secret", "list", "--name", workerName, "--format", "json"], {
		capture: true,
	});
	const parsed = JSON.parse(stdout.trim() || "[]");
	const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.result) ? parsed.result : [];
	return rows.map((row) => String(row.name || row.key || "")).filter(Boolean);
}

export function assertWorkerSecrets(workerName, requiredNames) {
	const existing = new Set(listWorkerSecretNames(workerName));
	const missing = requiredNames.filter((name) => !existing.has(name));
	if (missing.length > 0) {
		throw new Error(
			`Worker ${workerName} is missing required secrets: ${missing.join(", ")}. ` +
			`Provision them with Wrangler before deployment; values must never be stored in the instance env file.`,
		);
	}
}

/**
 * Explicit MASTER_KEY read for deploy-instance --show-master-key.
 * @param {Record<string, string>} vars
 */
export function fetchRemoteMasterKey(vars) {
	try {
		runNpmWithEnv(vars, ["gen:wrangler", "--", "--remote"]);
	} catch {
		return null;
	}
	try {
		const { stdout } = runWrangler(
			[
				"d1",
				"execute",
				vars.D1_DATABASE_NAME,
				"--remote",
				"--config",
				"./packages/core/wrangler.d1.jsonc",
				"--json",
				"--command",
				"SELECT value FROM system_config WHERE key = 'MASTER_KEY' LIMIT 1",
			],
			{ env: vars, capture: true },
		);
		const out = stdout.trim();
		try {
			const parsed = JSON.parse(out);
			const results = Array.isArray(parsed) ? parsed : [parsed];
			for (const block of results) {
				const rows = block?.results || block?.result?.[0]?.results;
				if (Array.isArray(rows) && rows[0]?.value) {
					return String(rows[0].value);
				}
			}
		} catch {
			const m = out.match(/sk-[^\s"']+/);
			if (m) {
				return m[0];
			}
		}
	} catch {
		return null;
	}
	return null;
}

export function printLocalDevHint() {
	log("Remote deploy wrote D1 database_id into generated wrangler.jsonc.");
	log("Before local dev:proxy / dev:admin, run:");
	log("  npm run gen:wrangler");
	log(
		"See docs/developers/local-development.md §1 (database_id).",
	);
}

/**
 * @param {string} question
 * @param {string} [defaultValue]
 */
export async function promptLine(question, defaultValue) {
	const rl = readline.createInterface({ input, output });
	try {
		const suffix =
			defaultValue !== undefined && defaultValue !== ""
				? ` [${defaultValue}]`
				: "";
		const answer = (await rl.question(`${question}${suffix}: `)).trim();
		return answer || defaultValue || "";
	} finally {
		rl.close();
	}
}

/**
 * @param {string} question
 * @param {boolean} [defaultYes]
 */
export async function promptYesNo(question, defaultYes = true) {
	const hint = defaultYes ? "Y/n" : "y/N";
	const answer = (await promptLine(`${question} (${hint})`, "")).toLowerCase();
	if (!answer) {
		return defaultYes;
	}
	return answer === "y" || answer === "yes";
}

/**
 * Build default Worker / D1 names from a prefix.
 * @param {string} prefix e.g. cinatoken
 */
export function namesFromPrefix(prefix) {
	const p = prefix.replace(/\/+$/, "").trim();
	return {
		proxyWorkerName: `${p}-proxy`,
		adminWorkerName: `${p}-admin`,
		chainWorkerName: `${p}-chain-worker`,
		chainJobQueueName: `${p}-chain-jobs`,
		chainJobDlqName: `${p}-chain-jobs-dlq`,
		d1DatabaseName: p,
		d1MigrationsWorkerName: `${p}-d1-migrations`,
	};
}

export function printDownstreamHints({
	proxyUrl,
	adminUrl,
	proxyWorkerName,
	adminWorkerName,
}) {
	console.log("");
	log("=== Downstream env (portal / clients) ===");
	if (proxyUrl) {
		console.log(`GATEWAY_URL=${proxyUrl}`);
	} else {
		console.log(
			`GATEWAY_URL=https://${proxyWorkerName}.<account-subdomain>.workers.dev`,
		);
		console.log(
			`# Or open Dashboard → Workers → ${proxyWorkerName} for the workers.dev URL`,
		);
	}
	if (adminUrl) {
		console.log(`GATEWAY_MASTER_URL=${adminUrl}`);
	} else {
		console.log(
			`GATEWAY_MASTER_URL=https://${adminWorkerName}.<account-subdomain>.workers.dev`,
		);
	}
	console.log(
		`GATEWAY_MASTER_KEY=<from D1 system_config.MASTER_KEY — rotate it in Admin Config; explicit recovery: npm run deploy:cloudflare -- <instance> --show-master-key>`,
	);
	console.log("");
	log("Verify: GET $GATEWAY_URL/health · open $GATEWAY_MASTER_URL and sign in through CinaAuth");
}
