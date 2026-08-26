import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const isWindows = process.platform === "win32";
const wranglerCli = createRequire(import.meta.url).resolve("wrangler");
const args = isWindows
	? [wranglerCli, "deploy", "--config", "wrangler.jsonc"]
	: [wranglerCli, "deploy", "worker.ts"];
const env = isWindows
	? { ...process.env, OPEN_NEXT_DEPLOY: "true" }
	: process.env;

if (isWindows) {
	console.log(
		"[admin deploy] Windows: uploading the built OpenNext Worker directly; incremental R2 cache is not enabled.",
	);
}

const result = spawnSync(process.execPath, args, {
	cwd: process.cwd(),
	env,
	stdio: "inherit",
	windowsHide: true,
});

if (result.error) {
	throw result.error;
}
process.exit(result.status ?? 1);
