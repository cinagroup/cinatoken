#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const staging = join(root, ".wrangler", "staging");
mkdirSync(staging, { recursive: true });
// A fresh directory prevents concurrent runs from replacing a producer under test.
// Retain the bundle and metadata after the run for failure inspection.
const artifacts = mkdtempSync(join(staging, "deploy-unit-tests-"));
const producer = join(artifacts, "preflight-evidence.mjs");
const metadata = join(artifacts, "preflight-evidence.meta.json");
const result = await build({
	absWorkingDir: root,
	entryPoints: ["scripts/deploy/byok-d1-preflight-evidence.mjs"],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "es2022",
	outfile: relative(root, producer).replaceAll("\\", "/"),
	metafile: true,
	logLevel: "warning",
});
writeFileSync(metadata, JSON.stringify(result.metafile, null, 2) + "\n");

const tests = readdirSync(join(root, "scripts", "deploy"))
	.filter((name) => name.endsWith(".test.mjs"))
	.sort()
	.map((name) => join(root, "scripts", "deploy", name));
if (tests.length === 0) throw new Error("Deployment unit tests were not found");

console.log(`[deploy tests] Fresh preflight bundle: ${relative(root, producer)}`);
const child = spawn(process.execPath, [
	"--import", "tsx", "--test", "--test-concurrency=4", ...tests,
], {
	cwd: root,
	env: {
		...process.env,
		BYOK_PREFLIGHT_EVIDENCE_MODULE: producer,
		BYOK_PREFLIGHT_EVIDENCE_META: metadata,
	},
	stdio: "inherit",
	windowsHide: true,
});

await new Promise((resolve, reject) => {
	child.once("error", reject);
	child.once("close", (code, signal) => {
		if (signal) console.error(`[deploy tests] Test process ended with ${signal}`);
		process.exitCode = code ?? 1;
		resolve();
	});
});
