import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	admit,
	assertOwned,
	boundedCommandTimeout,
	OWNER_LABEL,
} from "./admission.mjs";

// Independent always-step recovery also runs after outer timeout or a killed runner.
// It proves only cleanup; it cannot turn a failed or missing runtime report into a pass.
const input = admit(process.argv.slice(2), process.env, process.platform);
const registry = JSON.parse(
	readFileSync(join(input.out, "ownership.json"), "utf8")
);
assert.equal(registry.schema, "web-platform-g7-owned-resources-v1");
assert.equal(registry.sourceSHA, input.sha);
assert.match(registry.owner, /^g7-[a-f0-9]{32}$/);
const roles = [
	"pg",
	"migrate",
	"seed",
	"proxy",
	"admin",
	"ssr",
	"web",
	"ingress",
	"qa",
];
assert.deepEqual(Object.keys(registry.names).sort(), [...roles].sort());
for (const role of roles)
	assert.equal(registry.names[role], `${registry.owner}-${role}`);
assert.deepEqual(Object.keys(registry.networks).sort(), [
	"app",
	"client",
	"db",
]);
for (const role of ["client", "app", "db"])
	assert.equal(registry.networks[role], `${registry.owner}-${role}`);
assert.equal(registry.volume, `${registry.owner}-pgdata`);
const startedAt = new Date().toISOString();
const deadline = Date.now() + 180_000;
const rows = [];
const errors = [];
let counter = 0;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function command(args) {
	const timeoutMs = boundedCommandTimeout(deadline, 15_000);
	const id = `fallback-${String(++counter).padStart(3, "0")}-docker`;
	const begin = new Date().toISOString();
	const result = spawnSync(
		"docker",
		["--host", "unix:///var/run/docker.sock", ...args],
		{
			encoding: null,
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			maxBuffer: 1024 * 1024,
			env: {
				...process.env,
				DOCKER_HOST: undefined,
				DOCKER_CONTEXT: undefined,
			},
		}
	);
	const logs = {};
	for (const [stream, data] of [
		["stdout", result.stdout],
		["stderr", result.stderr],
	]) {
		const bytes = Buffer.from(data ?? []);
		const file = `${id}.${stream}.log`;
		writeFileSync(join(input.out, file), bytes, { flag: "wx" });
		logs[stream] = { file, bytes: bytes.length, sha256: sha256(bytes) };
	}
	writeFileSync(
		join(input.out, `${id}.result.json`),
		`${JSON.stringify(
			{
				schema: "web-platform-g7-child-command-closed-v1",
				program: "docker",
				args: ["--host", "unix:///var/run/docker.sock", ...args],
				begin,
				endedAt: new Date().toISOString(),
				closed: true,
				actualExit: result.status,
				signal: result.signal,
				errorCode: result.error?.code ?? null,
				timeoutMs,
				...logs,
			},
			null,
			2
		)}\n`,
		{ flag: "wx" }
	);
	assert.ok(
		result.status === 0 && result.signal === null && !result.error,
		`${id} failed: exit=${result.status} signal=${result.signal} error=${result.error?.code}`
	);
	return Buffer.from(result.stdout ?? [])
		.toString()
		.trim();
}
const attempt = (work) => {
	try {
		work();
	} catch (error) {
		errors.push({ name: error.name, message: error.message.slice(0, 2_000) });
	}
};
for (const name of Object.values(registry.names).reverse())
	attempt(() => {
		if (command(["container", "ls", "-aq", "--filter", `name=^/${name}$`])) {
			const labels = JSON.parse(
				command(["inspect", "--format", "{{json .Config.Labels}}", name])
			);
			assertOwned(labels, registry.owner);
			command(["rm", "--force", "--volumes", name]);
		}
		assert.equal(
			command(["container", "ls", "-aq", "--filter", `name=^/${name}$`]),
			""
		);
		rows.push({ type: "container", name, verifiedAbsent: true });
	});
for (const name of Object.values(registry.networks).reverse())
	attempt(() => {
		if (command(["network", "ls", "-q", "--filter", `name=^${name}$`])) {
			assertOwned(
				JSON.parse(
					command(["network", "inspect", "--format", "{{json .Labels}}", name])
				),
				registry.owner
			);
			command(["network", "rm", name]);
		}
		assert.equal(
			command(["network", "ls", "-q", "--filter", `name=^${name}$`]),
			""
		);
		rows.push({ type: "network", name, verifiedAbsent: true });
	});
attempt(() => {
	if (
		command(["volume", "ls", "-q", "--filter", `name=^${registry.volume}$`])
	) {
		assertOwned(
			JSON.parse(
				command([
					"volume",
					"inspect",
					"--format",
					"{{json .Labels}}",
					registry.volume,
				])
			),
			registry.owner
		);
		command(["volume", "rm", registry.volume]);
	}
	assert.equal(
		command(["volume", "ls", "-q", "--filter", `name=^${registry.volume}$`]),
		""
	);
	rows.push({ type: "volume", name: registry.volume, verifiedAbsent: true });
});
attempt(() => {
	for (const type of ["container", "network", "volume"])
		assert.equal(
			command([
				type,
				"ls",
				type === "container" ? "-aq" : "-q",
				"--filter",
				`label=${OWNER_LABEL}=${registry.owner}`,
			]),
			""
		);
});
const result = {
	schema: "web-platform-g7-independent-cleanup-closed-v1",
	startedAt,
	endedAt: new Date().toISOString(),
	sourceSHA: input.sha,
	owner: registry.owner,
	actualExit: errors.length ? 1 : 0,
	verifiedAbsent: errors.length === 0 && rows.length === 13,
	rows,
	errors,
	runtimePassedClaim: false,
	doesNotOverrideOriginalRuntimeExit: true,
};
writeFileSync(
	join(input.out, "fallback-cleanup-result.json"),
	`${JSON.stringify(result, null, 2)}\n`,
	{ flag: "wx" }
);
console.log(JSON.stringify(result));
process.exitCode = result.actualExit;
