import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	appendFileSync,
	mkdirSync,
	existsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { request as httpRequest } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { processCensus } from "../v364-owned-linux-boundary/proc-census.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const legacy = join(here, "..", "v364-owned-linux");
const boundary = join(here, "..", "v364-owned-linux-boundary");
const arg = (name) => {
	const i = process.argv.indexOf(name);
	return i < 0 ? undefined : process.argv[i + 1];
};
const repo = resolve(arg("--repo") ?? process.cwd());
const output = resolve(arg("--out") ?? join(here, "prepared"));
const execute = process.argv.includes("--execute-linux");
const prepareOnly = process.argv.includes("--prepare-only");
assert.notEqual(execute, prepareOnly, "choose exactly one explicit mode");
assert.ok(arg("--out"), "explicit unique --out is required");
let executorReceipt;
if (execute) {
	assert.equal(process.platform, "linux", "owned Linux only");
	assert.equal(
		Number(process.versions.node.split(".")[0]),
		22,
		"use repository .nvmrc major 22"
	);
	assert.equal(
		arg("--executor-receipt"),
		join(output, "executor-start.json"),
		"Python executor must own fresh output"
	);
	executorReceipt = JSON.parse(readFileSync(arg("--executor-receipt"), "utf8"));
	assert.equal(executorReceipt.schema, "v364-direct-socket-executor-start-v1");
	assert.equal(executorReceipt.repo, repo);
	assert.equal(executorReceipt.output, output);
	assert.equal(executorReceipt.freshOutputCreated, true);
} else {
	assert.equal(existsSync(output), false, "prepare output must not exist");
	mkdirSync(output);
}
const source = join(repo, "packages/proxy/scripts/staging");
const require = createRequire(join(repo, "package.json"));
const { build } = require("esbuild");
const {
	Miniflare,
	convertV4MiniflareOptions,
	Log,
	LogLevel,
} = require("miniflare");
const expected = {
	workerd: "1.20260828.1",
	miniflare: "5.20260828.0-alpha",
	wrangler: "4.127.1",
};
const versions = Object.fromEntries(
	Object.keys(expected).map((name) => [
		name,
		require(`${name}/package.json`).version,
	])
);
assert.deepEqual(versions, expected);
assert.equal(
	process.env.MINIFLARE_WORKERD_PATH,
	undefined,
	"no runtime override"
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sealedInputs = JSON.parse(
	readFileSync(join(here, "source-inputs.json"), "utf8")
);
assert.equal(sealedInputs.schema, "v364-direct-socket-source-inputs-v1");
const files = sealedInputs.files.map((v) => v.path);
const snapshot = () =>
	files.map((path) => {
		const b = readFileSync(join(repo, path));
		return { path, bytes: b.length, sha256: sha(b) };
	});
const inputsBefore = snapshot();
assert.deepEqual(
	inputsBefore,
	sealedInputs.files,
	"exact frozen source/config/lock/legacy package and real prior evidence bytes"
);
const installedSnapshot = () =>
	sealedInputs.installedFiles.map((item) => {
		const bytes = readFileSync(join(repo, item.path));
		return { path: item.path, bytes: bytes.length, sha256: sha(bytes) };
	});
const installedBefore = installedSnapshot();
assert.deepEqual(
	installedBefore,
	sealedInputs.installedFiles,
	"exact pinned Miniflare direct socket implementation"
);
const checkoutSHA = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: repo,
	encoding: "utf8",
}).trim();
for (const item of inputsBefore) {
	const blob = execFileSync("git", ["show", "HEAD:" + item.path], {
		cwd: repo,
	});
	assert.equal(blob.length, item.bytes);
	assert.equal(
		sha(blob),
		item.sha256,
		"working tree must match checkout Git bytes"
	);
}
if (execute) assert.equal(executorReceipt.checkoutSHA, checkoutSHA);
const priorExecutor = JSON.parse(
	readFileSync(
		join(repo, sealedInputs.priorArtifactRoot, "executor.closed.json"),
		"utf8"
	)
);
const priorNode = JSON.parse(
	readFileSync(
		join(repo, sealedInputs.priorArtifactRoot, "closed-result.json"),
		"utf8"
	)
);
assert.equal(
	priorExecutor.schema,
	"v364-owned-linux-boundary-executor-closed-v1"
);
assert.equal(priorNode.schema, "v364-owned-linux-boundary-closed-v1");
assert.equal(priorExecutor.actualExit, 1);
assert.equal(priorExecutor.actualProcessExit, 1);
assert.equal(priorExecutor.runnerOutcomeCode, 1);
assert.equal(priorNode.actualExit, 1);
assert.equal(priorNode.baseline.code, 1);
assert.equal(priorExecutor.run.GITHUB_RUN_ID, "37402302570");
assert.equal(priorExecutor.closure.groupGone, true);
assert.equal(priorExecutor.closure.directChildReaped, true);
assert.equal(priorNode.results.length, 8);
assert.equal(
	priorNode.results.filter(
		(v) => v.originalWindow?.actual === null && v.tail?.actual === null
	).length,
	6
);
const priorEvents = gunzipSync(
	readFileSync(join(repo, sealedInputs.priorArtifactRoot, "events.json.gz"))
);
assert.equal(sha(priorEvents), priorNode.events.sha256);
assert.equal(priorEvents.length, priorNode.events.bytes);
const priorRun = {
	runId: "37402302570",
	checkoutSHA: priorExecutor.run.GITHUB_SHA,
	actualExit: priorExecutor.actualExit,
	actualProcessExit: priorExecutor.actualProcessExit,
	runnerOutcomeCode: priorExecutor.runnerOutcomeCode,
	originalStrictActualExit: priorNode.baseline.code,
	outerUnforcedGroupClose: priorExecutor.closure.outerUnforcedGroupClose,
	gracefulWorkerdExitProven: false,
	causeProven: false,
	unchangedHistoricalFailure: true,
};
const gatewayConfig = JSON.parse(
	readFileSync(join(source, "wrangler.chat-holder-gateway-v364.jsonc"), "utf8")
);
const holderConfig = JSON.parse(
	readFileSync(join(source, "wrangler.chat-holder-private-v364.jsonc"), "utf8")
);
for (const config of [gatewayConfig, holderConfig]) {
	assert.deepEqual(config.compatibility_flags, [
		"nodejs_compat",
		"enable_request_signal",
	]);
	assert.equal(config.compatibility_date, "2026-09-25");
	assert.equal(config.workers_dev, false);
	assert.equal(config.preview_urls, false);
	assert.deepEqual(config.routes, []);
	assert.deepEqual(config.triggers, { crons: [] });
}
assert.deepEqual(gatewayConfig.services, [
	{ binding: "TEXT_HOLDER", service: holderConfig.name, remote: false },
]);
assert.deepEqual(
	holderConfig.kv_namespaces.map((v) => v.binding),
	["OBSERVATIONS"]
);
assert.equal(holderConfig.services, undefined);
async function bundle(path, wrapper) {
	const opts = {
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		write: false,
	};
	if (wrapper) {
		const text = readFileSync(join(legacy, wrapper), "utf8").replace(
			"__ORIGINAL__",
			join(source, path).replaceAll("\\", "/")
		);
		opts.stdin = {
			contents: text,
			resolveDir: source,
			sourcefile: wrapper,
			loader: "js",
		};
	} else opts.entryPoints = [join(source, path)];
	const result = await build(opts);
	assert.equal(result.outputFiles.length, 1);
	return result.outputFiles[0].text;
}
async function nativeReaderBundle() {
	const result = await build({
		entryPoints: [join(here, "native-reader-calibration.mjs")],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		write: false,
		external: ["node:assert/strict"],
		plugins: [
			{
				name: "frozen-holder-observer",
				setup(plugin) {
					plugin.onResolve({ filter: /^__HOLDER_OBSERVER__$/ }, () => ({
						path: join(legacy, "holder-observer.mjs"),
					}));
					plugin.onResolve({ filter: /^__ORIGINAL__$/ }, () => ({
						path: join(source, holderConfig.main),
					}));
				},
			},
		],
	});
	assert.equal(result.outputFiles.length, 1);
	return result.outputFiles[0].text;
}
async function observedBareBundle() {
	const contents = readFileSync(
		join(legacy, "holder-observer.mjs"),
		"utf8"
	).replace(
		"__ORIGINAL__",
		join(boundary, "bare-async-source.mjs").replaceAll("\\", "/")
	);
	const result = await build({
		stdin: {
			contents,
			resolveDir: here,
			sourcefile: "bare-observer.mjs",
			loader: "js",
		},
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		write: false,
	});
	assert.equal(result.outputFiles.length, 1);
	return result.outputFiles[0].text;
}
const bundles = {
	gateway: await bundle(gatewayConfig.main),
	holder: await bundle(holderConfig.main),
	observedGateway: await bundle(gatewayConfig.main, "gateway-observer.mjs"),
	observedHolder: await bundle(holderConfig.main, "holder-observer.mjs"),
	bare: await observedBareBundle(),
	nativeReader: await nativeReaderBundle(),
};
const syntheticBuilt = await build({
	entryPoints: [join(source, "chat-holder-synthetic-v364.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	write: false,
});
const synthetic = await import(
	"data:text/javascript;base64," +
		Buffer.from(syntheticBuilt.outputFiles[0].text).toString("base64")
);
const {
	SYNTHETIC_CREDENTIAL_V364,
	SYNTHETIC_PROVIDER_URL_V364,
	SYNTHETIC_PUBLIC_BODY_V364,
	SYNTHETIC_QUOTE_V364,
	SYNTHETIC_ROUTE_V364,
} = synthetic;
for (const name of ["gateway", "observedGateway"]) {
	assert.equal(bundles[name].includes(SYNTHETIC_CREDENTIAL_V364), false);
	assert.equal(bundles[name].includes(SYNTHETIC_PROVIDER_URL_V364), false);
}
for (const name of ["holder", "observedHolder"]) {
	assert.equal(bundles[name].includes(SYNTHETIC_CREDENTIAL_V364), true);
	assert.equal(bundles[name].includes(SYNTHETIC_PROVIDER_URL_V364), true);
}
const envelope = () => ({
	requestId: SYNTHETIC_QUOTE_V364.requestId,
	quoteId: SYNTHETIC_QUOTE_V364.quoteId,
	attemptNonce: randomUUID(),
	candidateIndex: SYNTHETIC_ROUTE_V364.candidateIndex,
	routeTargetId: SYNTHETIC_ROUTE_V364.targetId,
	finalBodyUtf8: SYNTHETIC_PUBLIC_BODY_V364,
});
const bundleHashes = Object.entries(bundles).map(([name, text]) => ({
	name,
	bytes: Buffer.byteLength(text),
	sha256: sha(text),
}));
if (!execute) {
	assert.deepEqual(snapshot(), inputsBefore);
	assert.deepEqual(installedSnapshot(), installedBefore);
	writeFileSync(
		join(output, "prepare-only.json"),
		JSON.stringify(
			{
				schema: "v364-direct-socket-prepare-v1",
				actualExit: 0,
				runtimeExecuted: false,
				versions,
				runtimeCompatibilityDate: "2026-09-04",
				frozenConfigDate: "2026-09-25",
				sourceUnchanged: true,
				reviewBaseHEAD: sealedInputs.reviewBaseHEAD,
				checkoutSHA,
				priorRun,
				inputsBefore,
				installedBefore,
				bundleHashes,
				productionRequests: 0,
				ciInvocations: 0,
			},
			null,
			2
		) + "\n"
	);
	console.log(
		JSON.stringify({ actualExit: 0, runtimeExecuted: false, output })
	);
	process.exit(0);
}
const startedAt = new Date().toISOString();
const start = performance.now();
const events = [];
const results = [];
const active = new Map();
const observationFailures = [];
const errorSafe = (error) => ({
	name: error?.name,
	code: error?.code,
	message: String(error?.message ?? error)
		.replaceAll(SYNTHETIC_CREDENTIAL_V364, "[synthetic-redacted]")
		.replaceAll(SYNTHETIC_PROVIDER_URL_V364, "[synthetic-redacted]"),
});
const event = (caseId, kind, fields = {}) => {
	try {
		if (events.length >= 20000)
			throw new Error("diagnostic event cap exceeded");
		const row = {
			caseId,
			kind,
			hostMs: performance.now() - start,
			wallMs: Date.now(),
			...fields,
		};
		events.push(row);
		appendFileSync(join(output, "events.ndjson"), JSON.stringify(row) + "\n");
	} catch (error) {
		if (observationFailures.length < 100)
			observationFailures.push({ caseId, kind, error: errorSafe(error) });
	}
};
const phases = new Map();
const phase = (caseId, value) => {
	phases.set(caseId, value);
	event(caseId, "phase", { phase: value });
};
const census = (caseId, label) => {
	try {
		const sample = processCensus();
		event(caseId, "proc-census", {
			phase: phases.get(caseId),
			label,
			census: sample,
		});
		if (!sample.complete)
			observationFailures.push({ caseId, label, incompleteProcCensus: true });
		return sample.complete;
	} catch (error) {
		const failure = { caseId, label, error: errorSafe(error) };
		observationFailures.push(failure);
		event(caseId, "proc-census-error", failure);
		return false;
	}
};
const delay = (ms) =>
	new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function bounded(task, ms, label) {
	let timer;
	try {
		return await Promise.race([
			task,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} deadline ${ms}ms`)),
					ms
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
class CaptureLog extends Log {
	constructor(caseId) {
		super(LogLevel.DEBUG);
		this.caseId = caseId;
	}
	log(message) {
		event(this.caseId, "miniflare-log", {
			phase: phases.get(this.caseId),
			message: String(message),
		});
	}
}
function createFixture(caseId, kind) {
	phase(caseId, "fixture-create");
	const kv = { OBSERVATIONS: holderConfig.kv_namespaces[0].id };
	const common = {
		modules: true,
		compatibilityDate: "2026-09-04",
		compatibilityFlags: holderConfig.compatibility_flags,
	};
	const single = {
		...common,
		name: "v364-direct-" + kind,
		script: kind === "bare" ? bundles.bare : bundles.nativeReader,
		kvNamespaces: kv,
	};
	const workers =
		kind === "binding"
			? [
					{
						...common,
						name: gatewayConfig.name,
						script: bundles.observedGateway,
						serviceBindings: { TEXT_HOLDER: holderConfig.name },
					},
					{
						...common,
						name: holderConfig.name,
						script: bundles.observedHolder,
						kvNamespaces: kv,
					},
			  ]
			: [single];
	workers[0].unsafeDirectSockets = [{ host: "127.0.0.1", port: 0 }];
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			cf: false,
			host: "127.0.0.1",
			port: 0,
			log: new CaptureLog(caseId),
			handleStructuredLogs(log) {
				event(caseId, "workerd-log", {
					phase: phases.get(caseId),
					timestamp: log.timestamp,
					level: log.level,
					message: String(log.message)
						.replaceAll(SYNTHETIC_CREDENTIAL_V364, "[synthetic-redacted]")
						.replaceAll(SYNTHETIC_PROVIDER_URL_V364, "[synthetic-redacted]"),
				});
			},
			workers,
		})
	);
	const f = {
		caseId,
		kind,
		mf,
		owner: kind === "binding" ? holderConfig.name : single.name,
		entryWorkerName: workers[0].name,
		observations: null,
		url: null,
		entryURL: null,
		directURL: null,
	};
	active.set(mf, f);
	return f; // register immediately before every readiness/binding await
}
async function readyFixture(f) {
	phase(f.caseId, "fixture-ready");
	if (f.kind === "binding")
		assert.deepEqual(Object.keys(await f.mf.getBindings(gatewayConfig.name)), [
			"TEXT_HOLDER",
		]);
	const bindings = await f.mf.getBindings(f.owner);
	assert.deepEqual(Object.keys(bindings), ["OBSERVATIONS"]);
	f.observations = bindings.OBSERVATIONS;
	f.entryURL = await f.mf.ready;
	f.directURL = await f.mf.unsafeGetDirectURL(f.entryWorkerName);
	for (const url of [f.entryURL, f.directURL]) {
		assert.equal(url.hostname, "127.0.0.1");
		assert.equal(url.protocol, "http:");
	}
	assert.notEqual(
		f.directURL.origin,
		f.entryURL.origin,
		"diagnostic must bypass Miniflare core ENTRY_WORKER"
	);
	f.url = new URL(
		f.kind === "native-reader"
			? "/fixture/native-reader-cancel"
			: "/fixture/complete-text",
		f.directURL
	);
	event(f.caseId, "direct-socket-ready", {
		entryWorkerName: f.entryWorkerName,
		directURL: f.directURL.origin,
		coreEntryURL: f.entryURL.origin,
		coreEntryBypassed: true,
	});
	census(f.caseId, "ready");
}
async function disposeFixture(f, reason) {
	phase(f.caseId, "dispose-start");
	census(f.caseId, "pre-dispose");
	event(f.caseId, "dispose-invoke", {
		reason,
		nativeRuntimeDisposeMaySendSIGKILL: true,
	});
	try {
		await bounded(f.mf.dispose(), 10000, "Miniflare dispose");
		active.delete(f.mf);
		phase(f.caseId, "dispose-settled");
		event(f.caseId, "dispose-fulfilled", {
			reason,
			gracefulRuntimeExitProven: false,
		});
		census(f.caseId, "post-dispose");
		return true;
	} catch (error) {
		event(f.caseId, "dispose-error", { reason, ...errorSafe(error) });
		return false;
	}
}
function httpClient(caseId, url, body, mode) {
	assert.equal(url.hostname, "127.0.0.1");
	return new Promise((resolveClient, reject) => {
		let response;
		let socket;
		let socketCloseResolve;
		const socketClosed = new Promise((resolveSocketClose) => {
			socketCloseResolve = resolveSocketClose;
		});
		const request = httpRequest(url, {
			method: "POST",
			agent: false,
			headers: {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
			},
		});
		request.on("error", (error) => {
			event(caseId, "request-error", errorSafe(error));
			reject(error);
		});
		request.once("close", () =>
			event(caseId, "request-close", { destroyed: request.destroyed })
		);
		request.once("socket", (value) => {
			socket = value;
			socket.once("close", () => socketCloseResolve());
			for (const type of ["connect", "end", "close", "error", "timeout"])
				socket.on(type, (data) =>
					event(
						caseId,
						"socket-" + type,
						type === "error"
							? errorSafe(data)
							: {
									hadError: typeof data === "boolean" ? data : undefined,
									destroyed: socket.destroyed,
									bytesRead: socket.bytesRead,
									bytesWritten: socket.bytesWritten,
							  }
					)
				);
		});
		request.setTimeout(10000, () =>
			request.destroy(new Error("fixture HTTP socket timed out"))
		);
		request.once("response", (value) => {
			response = value;
			for (const type of ["aborted", "close", "end", "error"])
				response.on(type, (data) =>
					event(
						caseId,
						"response-" + type,
						type === "error"
							? errorSafe(data)
							: { complete: response.complete, destroyed: response.destroyed }
					)
				);
			response.on("error", reject);
			let first = Buffer.alloc(0);
			const onData = (chunk) => {
				first = Buffer.concat([first, chunk]);
				if (first.length > 128) {
					request.destroy();
					response.destroy();
					reject(new Error("first SSE frame exceeded bound"));
					return;
				}
				if (!first.includes("\n\n")) return;
				response.pause();
				response.removeListener("data", onData);
				event(caseId, "first-frame", { bytes: first.length });
				resolveClient({
					status: response.statusCode,
					contentType: response.headers["content-type"],
					first,
					async cancel() {
						assert.equal(
							response.closed,
							false,
							"response must still be open before explicit client cancellation"
						);
						assert.equal(
							socket.destroyed,
							false,
							"socket must still be open before explicit client cancellation"
						);
						event(caseId, "client-cancel-invoke", { mode });
						if (!response.closed) {
							const closed = new Promise((resolveClosed) =>
								response.once("close", resolveClosed)
							);
							if (mode === "rst") {
								assert.equal(typeof socket.resetAndDestroy, "function");
								assert.equal(socket.remoteAddress, "127.0.0.1");
								event(caseId, "client-rst-api-invoke");
								socket.resetAndDestroy();
							}
							request.destroy();
							response.destroy();
							await bounded(
								Promise.all([closed, socketClosed]),
								10000,
								"client response and socket close"
							);
						}
						await bounded(socketClosed, 10000, "client socket close");
						const result = {
							requestDestroyed: request.destroyed,
							responseDestroyed: response.destroyed,
							responseComplete: response.complete,
							socketDestroyed: socket.destroyed,
						};
						event(caseId, "client-cancel-settled", result);
						return result;
					},
					cleanup() {
						request.destroy();
						response?.destroy();
					},
				});
			};
			response.on("data", onData);
			response.once("end", () =>
				reject(new Error("response ended before first frame"))
			);
		});
		request.end(body);
	});
}
async function observedGet(caseId, observations, key, n, phase) {
	event(caseId, "observer-kv-get-invoke", {
		category: key.split(":", 1)[0],
		poll: n,
		phase,
	});
	const value = await observations.get(key);
	event(caseId, "observer-kv-get-settled", {
		category: key.split(":", 1)[0],
		poll: n,
		phase,
		value,
	});
	return value;
}
async function cancellationCase(caseId, kind, mode) {
	let f;
	let client;
	let e;
	const result = {
		caseId,
		kind,
		mode,
		baselineEligible: false,
		diagnosticVariant: true,
		directSocket: true,
		coreEntryBypassed: true,
		originalWindow: null,
		tail: null,
		finalPreDisposeSnapshot: null,
		actualExit: 1,
		closed: false,
	};
	try {
		f = createFixture(caseId, kind);
		await bounded(readyFixture(f), 10000, "fixture readiness");
		e = envelope();
		const body = JSON.stringify(e);
		phase(caseId, "streaming");
		client = await bounded(
			httpClient(caseId, f.url, body, mode),
			10000,
			"first frame"
		);
		assert.equal(client.status, 200);
		assert.equal(client.contentType, "text/event-stream");
		assert.equal(
			await observedGet(
				caseId,
				f.observations,
				"accepted:" + e.attemptNonce,
				0,
				"before"
			),
			"one"
		);
		assert.equal(client.first.toString(), ": holder-ready\n\n");
		phase(caseId, "client-cancel");
		const cancelled = await bounded(client.cancel(), 10000, "cancel");
		assert.deepEqual(cancelled, {
			requestDestroyed: true,
			responseDestroyed: true,
			responseComplete: false,
			socketDestroyed: true,
		});
		phase(caseId, "original-poll");
		const pollStart = performance.now();
		let value = null;
		let count = 0;
		for (let n = 0; n < 100 && value === null; n++) {
			value = await observedGet(
				caseId,
				f.observations,
				"cancel:" + e.attemptNonce,
				n,
				"original"
			);
			count++;
			if (value === null) await delay(10);
		}
		result.originalWindow = {
			pollCount: count,
			sleepMs: 10,
			elapsedMs: performance.now() - pollStart,
			actual: value,
			expected: "observed",
			actualExit: value === "observed" ? 0 : 1,
		};
		try {
			assert.equal(value, "observed");
		} catch (error) {
			result.strictFailure = errorSafe(error);
		}
		assert.equal(
			await observedGet(
				caseId,
				f.observations,
				"release:" + e.attemptNonce,
				0,
				"after"
			),
			null
		);
		assert.equal(
			await observedGet(
				caseId,
				f.observations,
				"accepted:" + e.attemptNonce,
				0,
				"after"
			),
			"one"
		);
		phase(caseId, "diagnostic-tail");
		const tailStart = performance.now();
		let tailCount = 0;
		while (value === null && performance.now() - tailStart < 4000) {
			value = await observedGet(
				caseId,
				f.observations,
				"cancel:" + e.attemptNonce,
				tailCount++,
				"diagnostic-tail"
			);
			if (value === null) await delay(50);
		}
		result.tail = {
			elapsedMs: performance.now() - tailStart,
			reads: tailCount,
			actual: value,
			usedForPass: false,
		};
		result.actualExit = result.originalWindow.actualExit;
	} catch (error) {
		result.error = errorSafe(error);
	} finally {
		client?.cleanup();
		if (f && e && f.observations) {
			phase(caseId, "pre-dispose-observation");
			try {
				const values = {};
				for (const category of ["cancel", "release", "accepted"])
					values[category] = await bounded(
						observedGet(
							caseId,
							f.observations,
							category + ":" + e.attemptNonce,
							0,
							"pre-dispose"
						),
						2000,
						"final KV observation"
					);
				result.finalPreDisposeSnapshot = { ...values, usedForPass: false };
				event(
					caseId,
					"pre-dispose-kv-snapshot",
					result.finalPreDisposeSnapshot
				);
			} catch (error) {
				result.preDisposeError = errorSafe(error);
				result.actualExit = 1;
			}
		}
		if (f) result.closed = await disposeFixture(f, "case-finally");
		event(caseId, "case-closed", {
			actualExit: result.actualExit,
			closed: result.closed,
			baselineEligible: false,
		});
		results.push(result);
	}
}
async function nativeReaderCalibration() {
	const caseId = "native-worker-reader-cancel";
	const result = {
		caseId,
		calibrationOnly: true,
		baselineEligible: false,
		nativeWorkerExecuted: false,
		actualExit: 1,
		closed: false,
	};
	let f;
	let request;
	try {
		f = createFixture(caseId, "native-reader");
		await bounded(readyFixture(f), 10000, "native calibration readiness");
		const e = envelope();
		const body = JSON.stringify(e);
		f.url.searchParams.set("attemptNonce", e.attemptNonce);
		phase(caseId, "native-reader-calibration");
		const response = await bounded(
			new Promise((resolveResponse, reject) => {
				request = httpRequest(f.url, {
					method: "POST",
					agent: false,
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(body),
					},
				});
				request.on("error", reject);
				request.setTimeout(10000, () =>
					request.destroy(new Error("native calibration HTTP timeout"))
				);
				request.once("response", (incoming) => {
					const chunks = [];
					let bytes = 0;
					incoming.on("error", reject);
					incoming.on("data", (chunk) => {
						bytes += chunk.length;
						if (bytes > 2048) {
							incoming.destroy();
							request.destroy();
							reject(new Error("native calibration JSON bound exceeded"));
						} else chunks.push(chunk);
					});
					incoming.once("end", () =>
						resolveResponse({
							status: incoming.statusCode,
							contentType: incoming.headers["content-type"],
							complete: incoming.complete,
							body: Buffer.concat(chunks).toString("utf8"),
						})
					);
				});
				request.end(body);
			}),
			15000,
			"native calibration result"
		);
		assert.equal(response.status, 200);
		assert.equal(response.contentType, "application/json");
		assert.equal(response.complete, true);
		const received = JSON.parse(response.body);
		assert.deepEqual(received, {
			nativeReaderCancel: true,
			firstFrame: ": holder-ready\n\n",
			pendingReadSettledBeforeCancel: false,
			pendingReadAfterCancelDone: true,
			cancel: "observed",
			release: null,
			accepted: "one",
		});
		assert.equal(
			await observedGet(
				caseId,
				f.observations,
				"cancel:" + e.attemptNonce,
				0,
				"native-calibration"
			),
			"observed"
		);
		assert.equal(
			await observedGet(
				caseId,
				f.observations,
				"release:" + e.attemptNonce,
				0,
				"native-calibration"
			),
			null
		);
		assert.equal(
			await observedGet(
				caseId,
				f.observations,
				"accepted:" + e.attemptNonce,
				0,
				"native-calibration"
			),
			"one"
		);
		result.nativeWorkerExecuted = true;
		result.received = received;
		result.actualExit = 0;
	} catch (error) {
		result.error = errorSafe(error);
	} finally {
		request?.destroy();
		if (f) result.closed = await disposeFixture(f, "native-reader-finally");
		event(caseId, "case-closed", {
			actualExit: result.actualExit,
			closed: result.closed,
			calibrationOnly: true,
			baselineEligible: false,
		});
		results.push(result);
	}
}
async function strictBaseline() {
	const startedAt = new Date().toISOString();
	const env = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		CI: "true",
		NO_COLOR: "1",
	};
	const args = [
		"--import",
		require.resolve("tsx"),
		"--test",
		"scripts/staging/chat-holder-binding-v364.node.test.mjs",
		"scripts/staging/chat-holder-binding-v364-http-cancel-successor.test.mjs",
	];
	const stdoutFile = "original-strict.stdout.txt",
		stderrFile = "original-strict.stderr.txt";
	for (const file of [stdoutFile, stderrFile])
		writeFileSync(join(output, file), Buffer.alloc(0), { flag: "wx" });
	// Share the supervisor's isolated process group. Capture original byte chunks without decoding or truncation.
	const child = spawn(process.execPath, args, {
		cwd: join(repo, "packages/proxy"),
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let timedOut = false,
		outputLimitExceeded = false,
		observedBytes = 0;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, 90000);
	for (const [stream, file] of [
		["stdout", stdoutFile],
		["stderr", stderrFile],
	])
		child[stream].on("data", (bytes) => {
			appendFileSync(join(output, file), bytes);
			observedBytes += bytes.length;
			if (observedBytes > 8 * 1024 * 1024) {
				outputLimitExceeded = true;
				child.kill("SIGKILL");
			}
		});
	let spawnError;
	child.on("error", (error) => {
		spawnError = errorSafe(error);
	});
	const [code, signal] = await new Promise((resolveClose) =>
		child.once("close", (...args) => resolveClose(args))
	);
	clearTimeout(timer);
	const descriptor = (file) => {
		const bytes = readFileSync(join(output, file));
		return { file, bytes: bytes.length, sha256: sha(bytes) };
	};
	return {
		closed: true,
		startedAt,
		endedAt: new Date().toISOString(),
		program: process.execPath,
		args,
		cwd: join(repo, "packages/proxy"),
		actualExit: code,
		code,
		signal,
		timedOut,
		outputLimitExceeded,
		spawnError,
		stdout: descriptor(stdoutFile),
		stderr: descriptor(stderrFile),
	};
}
function verifyNativeCalibrationObservations() {
	const result = results.find(
		(row) => row.caseId === "native-worker-reader-cancel"
	);
	if (!result || result.actualExit !== 0) return;
	try {
		const rows = events
			.filter(
				(row) =>
					row.caseId === result.caseId &&
					row.kind === "workerd-log" &&
					row.message.includes("V364_DIAG ")
			)
			.map((row) =>
				JSON.parse(
					row.message.slice(
						row.message.indexOf("V364_DIAG ") + "V364_DIAG ".length
					)
				)
			);
		const count = (boundary, event, category, method) =>
			rows.filter(
				(row) =>
					row.boundary === boundary &&
					row.event === event &&
					(category === undefined || row.category === category) &&
					(method === undefined || row.method === method)
			).length;
		const observed = {
			cancelPutInvoke: count("holder", "kv-invoke", "cancel", "put"),
			cancelPutFulfilled: count("holder", "kv-fulfilled", "cancel", "put"),
			waitUntilRegister: count("holder", "waitUntil-register"),
			waitUntilFulfilled: count("holder", "waitUntil-fulfilled"),
			waitUntilRejected: count("holder", "waitUntil-rejected"),
			readerCancelInvoke: count(
				"native-reader-calibration",
				"reader-cancel-invoke"
			),
			readerCancelFulfilled: count(
				"native-reader-calibration",
				"reader-cancel-fulfilled"
			),
		};
		assert.deepEqual(observed, {
			cancelPutInvoke: 1,
			cancelPutFulfilled: 1,
			waitUntilRegister: 1,
			waitUntilFulfilled: 1,
			waitUntilRejected: 0,
			readerCancelInvoke: 1,
			readerCancelFulfilled: 1,
		});
		const releaseIndex = rows.findIndex(
			(row) =>
				row.boundary === "holder" &&
				row.event === "kv-invoke" &&
				row.category === "release" &&
				row.method === "get"
		);
		const cancelIndex = rows.findIndex(
			(row) =>
				row.boundary === "native-reader-calibration" &&
				row.event === "reader-cancel-invoke"
		);
		assert.ok(
			releaseIndex >= 0 && releaseIndex < cancelIndex,
			"original async pull must be observed before explicit native reader cancel"
		);
		result.nativeObserverEvidence = {
			...observed,
			originalPullObservedBeforeCancel: true,
			addsLifetimeTask: false,
		};
	} catch (error) {
		result.actualExit = 1;
		result.nativeObservationFailure = errorSafe(error);
	}
}
let baseline;
let fatal;
let sourceUnchanged = false;
try {
	baseline = await strictBaseline();
	if (
		baseline.timedOut ||
		baseline.outputLimitExceeded ||
		baseline.spawnError ||
		baseline.signal ||
		!Number.isSafeInteger(baseline.code)
	)
		throw new Error(
			"strict baseline did not close normally; outer executor owns process-group cleanup"
		);
	await bounded(
		nativeReaderCalibration(),
		30000,
		"native worker reader-cancel calibration"
	);
	for (const kind of ["bare", "binding"])
		for (const mode of ["destroy", "rst"]) {
			await bounded(
				cancellationCase("direct-socket-" + kind + "-" + mode, kind, mode),
				30000,
				"direct socket cancellation case"
			);
		}
} catch (error) {
	fatal = errorSafe(error);
} finally {
	for (const f of active.values()) await disposeFixture(f, "outer-finally");
	await new Promise((resolve) => setImmediate(resolve));
	verifyNativeCalibrationObservations();
	const inputsAfter = snapshot();
	const installedAfter = installedSnapshot();
	sourceUnchanged =
		JSON.stringify(inputsBefore) === JSON.stringify(inputsAfter) &&
		JSON.stringify(installedBefore) === JSON.stringify(installedAfter);
	const eventsText = JSON.stringify(events, null, 2) + "\n";
	writeFileSync(join(output, "events.json"), eventsText);
	const actualExit =
		!fatal &&
		observationFailures.length === 0 &&
		baseline?.code === 0 &&
		results.length === 5 &&
		results.every((v) => v.actualExit === 0 && v.closed) &&
		active.size === 0 &&
		sourceUnchanged
			? 0
			: 1;
	const report = {
		schema: "v364-direct-socket-closed-v1",
		startedAt,
		endedAt: new Date().toISOString(),
		elapsedMs: performance.now() - start,
		actualExit,
		outcome:
			actualExit === 0
				? "STRICT_SYNTHETIC_DIRECT_SOCKET_COMPARISON_ONLY"
				: "STRICT_FAILURE_PRESERVED",
		baseline,
		results,
		fatal,
		versions,
		executorReceipt,
		checkoutSHA,
		reviewBaseHEAD: sealedInputs.reviewBaseHEAD,
		priorRun,
		allComparisonsBaselineEligible: false,
		closureAuthority:
			"executor.closed.json; bounded Promise does not cancel underlying task",
		runtimeCompatibilityDate: "2026-09-04",
		frozenConfigDate: "2026-09-25",
		sourceUnchanged,
		inputsBefore,
		inputsAfter,
		installedBefore,
		installedAfter,
		bundleHashes,
		activeMiniflare: active.size,
		observationFailures,
		events: {
			bytes: Buffer.byteLength(eventsText),
			sha256: sha(eventsText),
			count: events.length,
		},
		productionRequests: 0,
		realIdentity: false,
		defaultOffHolderChanged: false,
		dependencyChanged: false,
		causeProven: false,
		lateObservationUpgradesPass: false,
		upstreamPatchApplied: false,
		flagsChanged: false,
		limitations: [
			"Bare stream simplifies envelope validation and has no gateway/holder import; timing perturbation remains possible.",
			"Direct sockets change transport entry topology only and cannot pass the unchanged original mf.ready baseline.",
			"Native reader-cancel calibration runs within an active worker fetch; it cannot prove transport cancellation or original pending pull quiescence.",
			"Miniflare runtime dispose sends SIGKILL internally; API disposal fulfilled is not graceful workerd exit.",
			"Host receipt phase is arrival-time attribution; preserve worker timestamps and do not assume all logs arrived before dispose.",
			"Same runtime failure differences localize a boundary, not an upstream regression cause proof.",
		],
	};
	writeFileSync(
		join(output, "closed-result.json"),
		JSON.stringify(report, null, 2) + "\n"
	);
	console.log(
		JSON.stringify({
			actualExit,
			outcome: report.outcome,
			output,
			sourceUnchanged,
			activeMiniflare: active.size,
		})
	);
	process.exitCode = actualExit;
}
