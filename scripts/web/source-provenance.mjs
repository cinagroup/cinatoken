#!/usr/bin/env node
// Copyright (C) 2026 CinaGroup
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB = "packages/web";
const MAX_BLOB = 64 * 1024 * 1024;
const MAX_BATCH = 512 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const fail = (message) => {
	throw new Error(message);
};

export const POLICY = Object.freeze({
	schemaVersion: 1,
	scope: WEB,
	directories: [
		"node_modules",
		".git",
		"dist",
		"dist-server",
		"dist-ssr",
		"dist-edge",
		"build",
		"coverage",
		"vendor",
		".cache",
		".tmp",
		".rsbuild",
		".wrangler",
		".vite",
		".turbo",
		".next",
		".output",
		".ssh",
		".aws",
	],
	rootPrivateDataDirectories: ["keys", "secret", "secrets", "credentials"],
	filePatterns: [
		"^\\.env(?:[.-]|rc(?:[.-]|$)|$)",
		"^\\.dev\\.vars(?:[.-]|$)",
		"^\\.(?:npmrc|netrc|pypirc|authinfo|gitconfig|git-credentials)$",
		"\\.(?:pem|key|p8|p12|pfx|jks|keystore)(?:[.-]|$)",
		"^id_(?:rsa|dsa|ecdsa|ed25519)(?:\\.|$)",
		"\\.tsbuildinfo$",
	],
	sourceExtensionsInPrivateNamedDirectories: [
		".ts",
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs",
		".css",
		".scss",
		".html",
	],
	privateDataNames:
		"Data files inside directories named keys/secret/secrets/credentials are excluded except declared source-code extensions. Those directory names never prune nested source code. Web-root private-data directories are excluded by location; suspicious extensionless secret/credential/private-key data names are excluded.",
	symlinks:
		"Never follow working-tree symlinks or junctions; exclude Git mode 120000 without reading its blob; reject symlink/junction ancestors of source and output paths.",
	paths:
		"Repository-relative POSIX UTF-8 paths; reject absolute, dot/empty segments, backslash and colon. Tab/newline and other valid UTF-8 names remain data, never shell arguments or output filenames.",
	sort: "Ascending UTF-8 byte order (Buffer.compare), independent of locale.",
	tsv: "UTF-8, LF; path column is a JSON string, then decimal byte count and lowercase SHA256. Aggregate is SHA256 of complete TSV including header.",
	byteContract:
		"Raw file/blob bytes, without newline or encoding normalization; Git SHA1 verified from blob <size> NUL + raw bytes.",
	observation:
		"Per-file identity and size/time checked around reads. This is not an atomic repository snapshot; no concurrently hostile renaming of source/output ancestors is supported. Repeated matching inventories establish an unchanged observed boundary.",
	limits: { maxBlobBytes: MAX_BLOB, maxGitOutputBytes: MAX_BATCH },
	interpretation:
		"Local tree comparison only. No upstream import identity, import date, license compliance or copyright ownership inferred.",
});
const secretPatterns = POLICY.filePatterns.map((x) => new RegExp(x, "i"));

export function validatePath(value) {
	if (typeof value !== "string" || !value || /[\\:\0]/.test(value))
		fail("Invalid repository-relative POSIX path");
	const parts = value.split("/");
	if (parts.some((x) => !x || x === "." || x === ".."))
		fail("Path traversal or absolute path rejected");
	if (!value.startsWith(WEB + "/")) fail("Path is outside Web source scope");
	return value;
}

export function exclusion(value, { directory = false } = {}) {
	validatePath(value);
	const parts = value.slice(WEB.length + 1).split("/");
	if (parts.some((x) => POLICY.directories.includes(x.toLowerCase())))
		return "excluded-directory";
	if (POLICY.rootPrivateDataDirectories.includes(parts[0].toLowerCase()))
		return "excluded-root-private-data-location";
	if (secretPatterns.some((re) => re.test(parts.at(-1))))
		return "excluded-env-secret-key-credential-or-build-file";
	if (!directory) {
		const name = parts.at(-1);
		const sourceCode =
			POLICY.sourceExtensionsInPrivateNamedDirectories.includes(
				path.posix.extname(name).toLowerCase()
			);
		if (
			!sourceCode &&
			parts
				.slice(0, -1)
				.some((x) =>
					POLICY.rootPrivateDataDirectories.includes(x.toLowerCase())
				)
		)
			return "excluded-private-data-file";
		if (
			!path.posix.extname(name) &&
			/(?:^|[-_.])(?:secrets?|credentials?|private[-_]?keys?)(?:[-_.]|$)/i.test(
				name
			)
		)
			return "excluded-extensionless-private-data";
	}
	return null;
}

export function parseTree(bytes) {
	if (bytes.length && bytes.at(-1) !== 0)
		fail("Truncated NUL-delimited Git tree");
	const result = [];
	const seen = new Set();
	let start = 0;
	for (let end = bytes.indexOf(0); end >= 0; end = bytes.indexOf(0, start)) {
		const raw = bytes.subarray(start, end);
		start = end + 1;
		const tab = raw.indexOf(9);
		if (tab < 0) fail("Malformed Git tree entry");
		const header = utf8.decode(raw.subarray(0, tab));
		const match =
			/^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})$/.exec(
				header
			);
		if (!match || (match[1] === "160000") !== (match[2] === "commit"))
			fail("Malformed Git tree mode/type/object");
		const name = validatePath(utf8.decode(raw.subarray(tab + 1)));
		if (seen.has(name)) fail("Duplicate Git tree path");
		seen.add(name);
		result.push({
			path: name,
			mode: match[1],
			type: match[2],
			gitBlobId: match[3],
		});
	}
	return result.sort((a, b) => order(a.path, b.path));
}

export function blobId(bytes) {
	return crypto
		.createHash("sha1")
		.update(Buffer.from(`blob ${bytes.length}\0`))
		.update(bytes)
		.digest("hex");
}

export function parseBatch(bytes, requestedIds) {
	if (new Set(requestedIds).size !== requestedIds.length)
		fail("Duplicate requested batch object");
	const result = new Map();
	let cursor = 0;
	for (const expected of requestedIds) {
		if (!/^[a-f0-9]{40}$/.test(expected)) fail("Invalid requested Git object");
		const end = bytes.indexOf(10, cursor);
		if (end < 0) fail("Truncated Git batch header");
		const match = /^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/.exec(
			utf8.decode(bytes.subarray(cursor, end))
		);
		if (!match || match[1] !== expected)
			fail("Malformed, missing or unexpected Git batch object");
		const size = Number(match[2]);
		if (!Number.isSafeInteger(size) || size > MAX_BLOB)
			fail("Git blob exceeds declared size limit");
		cursor = end + 1;
		if (size > bytes.length - cursor - 1) fail("Truncated Git blob bytes");
		const raw = bytes.subarray(cursor, cursor + size);
		cursor += size;
		if (bytes[cursor++] !== 10) fail("Missing Git blob record terminator");
		if (blobId(raw) !== expected)
			fail("Git blob identity does not match raw bytes");
		result.set(expected, {
			bytes: size,
			sha256: sha(raw),
			gitBlobId: expected,
		});
	}
	if (cursor !== bytes.length) fail("Unexpected trailing Git batch bytes");
	return result;
}

export function inventoryTsv(rows) {
	const seen = new Set();
	const lines = [...rows]
		.sort((a, b) => order(a.path, b.path))
		.map((row) => {
			validatePath(row.path);
			if (seen.has(row.path)) fail("Duplicate inventory path");
			seen.add(row.path);
			if (
				!Number.isSafeInteger(row.bytes) ||
				row.bytes < 0 ||
				!/^[a-f0-9]{64}$/.test(row.sha256)
			)
				fail("Malformed inventory row");
			return `${JSON.stringify(row.path)}\t${row.bytes}\t${row.sha256}\n`;
		});
	return "path_json\tbytes\tsha256\n" + lines.join("");
}

const inside = (parent, child) => {
	const relative = path.relative(parent, child);
	return (
		relative === "" ||
		(!relative.startsWith(".." + path.sep) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
};

function assertPlainAncestors(value) {
	const absolute = path.resolve(value);
	let at = path.parse(absolute).root;
	for (const part of absolute
		.slice(at.length)
		.split(path.sep)
		.filter(Boolean)) {
		at = path.join(at, part);
		const stat = fs.lstatSync(at);
		if (stat.isSymbolicLink()) fail("Symlink or junction ancestor rejected");
		// Windows junctions/reparse aliases must also retain their resolved location.
		if (
			path.resolve(fs.realpathSync(at)).toLowerCase() !==
			path.resolve(at).toLowerCase()
		)
			fail("Resolved ancestor differs from requested path");
	}
	return absolute;
}

function git(repo, args, input) {
	const result = spawnSync(
		"git",
		["--no-optional-locks", "-C", repo, ...args],
		{ input, encoding: "buffer", maxBuffer: MAX_BATCH, windowsHide: true }
	);
	if (result.error || result.status !== 0)
		fail(`Read-only Git command failed: ${args[0]}`);
	return result.stdout;
}

function currentInventory(repo, source) {
	const rows = [];
	const excluded = [];
	function visit(directory) {
		assertPlainAncestors(directory);
		for (const entry of fs
			.readdirSync(directory, { withFileTypes: true })
			.sort((a, b) => order(a.name, b.name))) {
			const absolute = path.join(directory, entry.name);
			const name = validatePath(
				path.relative(repo, absolute).split(path.sep).join("/")
			);
			const reason = exclusion(name, { directory: entry.isDirectory() });
			// No excluded file or directory contents are opened, even for type inspection.
			if (reason) {
				excluded.push({ path: name, reason });
				continue;
			}
			const stat = fs.lstatSync(absolute);
			if (stat.isSymbolicLink()) {
				excluded.push({ path: name, reason: "symlink-or-junction" });
				continue;
			}
			if (stat.isDirectory()) {
				visit(absolute);
				continue;
			}
			if (!stat.isFile()) {
				excluded.push({ path: name, reason: "non-regular-file" });
				continue;
			}
			assertPlainAncestors(absolute);
			if (!inside(source, fs.realpathSync(absolute)))
				fail("File escaped source directory");
			const fd = fs.openSync(
				absolute,
				fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
			);
			try {
				const opened = fs.fstatSync(fd);
				if (
					!opened.isFile() ||
					opened.size > MAX_BLOB ||
					opened.ino !== stat.ino ||
					opened.dev !== stat.dev
				)
					fail("File changed identity or exceeds limit");
				const raw = fs.readFileSync(fd);
				const after = fs.fstatSync(fd);
				assertPlainAncestors(absolute);
				if (
					opened.size !== raw.length ||
					after.size !== opened.size ||
					after.mtimeMs !== opened.mtimeMs ||
					after.ctimeMs !== opened.ctimeMs
				)
					fail("Source changed while reading");
				rows.push({
					path: name,
					bytes: raw.length,
					sha256: sha(raw),
					gitBlobId: blobId(raw),
				});
			} finally {
				fs.closeSync(fd);
			}
		}
	}
	visit(source);
	return { rows: rows.sort((a, b) => order(a.path, b.path)), excluded };
}

export function compareInventories(current, baseline) {
	// TSV validation detects duplicates and malformed rows before mapping.
	inventoryTsv(current);
	inventoryTsv(baseline);
	const now = new Map(current.map((x) => [x.path, x]));
	const before = new Map(baseline.map((x) => [x.path, x]));
	const diff = { same: [], changed: [], new: [], deleted: [] };
	for (const name of [...new Set([...now.keys(), ...before.keys()])].sort(
		order
	)) {
		const a = now.get(name);
		const b = before.get(name);
		if (!b) diff.new.push(name);
		else if (!a) diff.deleted.push(name);
		else if (a.bytes === b.bytes && a.sha256 === b.sha256) diff.same.push(name);
		else diff.changed.push({ path: name, baseline: b, current: a });
	}
	return diff;
}

export function collectProvenance({ repoRoot, outputDir, baselineTree }) {
	if (!/^[a-f0-9]{40}$/.test(baselineTree ?? ""))
		fail(
			"--baseline-tree must be a complete lowercase 40-hex local tree object ID"
		);
	const repo = assertPlainAncestors(repoRoot);
	const source = assertPlainAncestors(path.join(repo, WEB));
	if (!fs.statSync(source).isDirectory())
		fail("Web source directory is missing");
	const output = path.resolve(outputDir);
	if (inside(source, output) || inside(output, source))
		fail("Output must be separate from Web source directory");
	if (
		fs.existsSync(output) ||
		(() => {
			try {
				fs.lstatSync(output);
				return true;
			} catch (e) {
				if (e.code === "ENOENT") return false;
				throw e;
			}
		})()
	)
		fail("Output directory already exists; nothing will be overwritten");
	assertPlainAncestors(path.dirname(output));
	if (
		git(repo, ["rev-parse", "--show-object-format"]).toString().trim() !==
		"sha1"
	)
		fail("Only SHA1 Git object format is supported");
	if (git(repo, ["cat-file", "-t", baselineTree]).toString().trim() !== "tree")
		fail("Baseline object must be a local Git tree, not a commit/ref");
	const observedAt = new Date().toISOString();
	const head = git(repo, ["rev-parse", "--verify", "HEAD"]).toString().trim();
	const trackedRaw = git(repo, ["ls-files", "-z", "--", WEB]);
	if (trackedRaw.length && trackedRaw.at(-1) !== 0)
		fail("Truncated tracked-path metadata");
	const trackedWeb = utf8
		.decode(trackedRaw)
		.split("\0")
		.filter(Boolean)
		.map(validatePath)
		.sort(order);
	const entries = parseTree(
		git(repo, ["ls-tree", "-r", "-z", baselineTree, "--", WEB])
	);
	if (!entries.length) fail("Baseline tree contains no Web paths");
	const baselineExcluded = [];
	const allowed = entries.filter((entry) => {
		const reason =
			exclusion(entry.path) ??
			(entry.mode === "120000"
				? "symlink-blob-not-read"
				: entry.type !== "blob"
				? "non-regular-git-entry"
				: null);
		if (reason) baselineExcluded.push({ path: entry.path, reason });
		return !reason;
	});
	const ids = [...new Set(allowed.map((x) => x.gitBlobId))];
	const blobs = parseBatch(
		ids.length
			? git(repo, ["cat-file", "--batch"], Buffer.from(ids.join("\n") + "\n"))
			: Buffer.alloc(0),
		ids
	);
	const baseline = allowed.map((x) => ({
		path: x.path,
		...blobs.get(x.gitBlobId),
	}));
	const current = currentInventory(repo, source);
	const diff = compareInventories(current.rows, baseline);
	const currentTsv = inventoryTsv(current.rows);
	const baselineTsv = inventoryTsv(baseline);
	const policySha256 = sha(Buffer.from(JSON.stringify(POLICY)));
	const toolSha256 = sha(fs.readFileSync(fileURLToPath(import.meta.url)));
	const report = {
		schemaVersion: 1,
		observedAt,
		repoRoot: repo,
		scope: WEB,
		toolSha256,
		policySha256,
		policy: POLICY,
		metadata: {
			head,
			trackedWeb,
			baselineTree,
			baselineKind: "local-git-tree",
			upstreamRepository: null,
			upstreamRef: null,
			upstreamCommit: null,
			importDate: null,
			upstreamStatus: "unresolved",
			copyrightOwnership: "not-inferred",
			sourceRequirementComplete: false,
		},
		current: {
			count: current.rows.length,
			aggregateSha256: sha(Buffer.from(currentTsv)),
			inventory: current.rows,
			excluded: current.excluded,
		},
		baseline: {
			count: baseline.length,
			aggregateSha256: sha(Buffer.from(baselineTsv)),
			inventory: baseline,
			excluded: baselineExcluded,
		},
		comparison: {
			counts: Object.fromEntries(
				Object.entries(diff).map(([k, v]) => [k, v.length])
			),
			...diff,
		},
	};
	const documents = {
		"inventory.json": JSON.stringify(report, null, 2) + "\n",
		"current.tsv": currentTsv,
		"baseline.tsv": baselineTsv,
	};
	// Create only after all input validation; mkdir and exclusive opens reject collisions.
	assertPlainAncestors(path.dirname(output));
	fs.mkdirSync(output);
	assertPlainAncestors(output);
	for (const [name, text] of Object.entries(documents)) {
		assertPlainAncestors(output);
		fs.writeFileSync(path.join(output, name), text, { flag: "wx" });
	}
	const summary = {
		schemaVersion: 1,
		observedAt,
		toolSha256,
		policySha256,
		current: report.current.count,
		baseline: report.baseline.count,
		comparison: report.comparison.counts,
		upstreamStatus: "unresolved",
		sourceRequirementComplete: false,
		files: Object.entries(documents).map(([name, text]) => ({
			path: name,
			bytes: Buffer.byteLength(text),
			sha256: sha(Buffer.from(text)),
		})),
	};
	fs.writeFileSync(
		path.join(output, "summary.json"),
		JSON.stringify(summary, null, 2) + "\n",
		{ flag: "wx" }
	);
	return summary;
}

const USAGE =
	"Usage: node scripts/web/source-provenance.mjs --repo-root C:/cinagroup/cinatoken --output-dir C:/Users/cina/AppData/Local/Temp/unique-new-directory --baseline-tree c4c6c4bcde6c0b67c21b6ae6132cb3dda8da2b13\nRead-only local Web byte inventory; no upstream or ownership claim. Output parent must exist; output directory must not exist.";

export function parseArgs(args) {
	const options = {};
	const names = {
		"--repo-root": "repoRoot",
		"--output-dir": "outputDir",
		"--baseline-tree": "baselineTree",
	};
	for (let i = 0; i < args.length; i += 2) {
		const key = names[args[i]];
		if (!key || options[key] || !args[i + 1] || args[i + 1].startsWith("--"))
			fail("Unknown, duplicate or missing CLI argument");
		options[key] = args[i + 1];
	}
	if (Object.keys(options).length !== 3)
		fail("All three explicit CLI arguments are required");
	return options;
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		if (process.argv.slice(2).join(" ") === "--help")
			process.stdout.write(USAGE + "\n");
		else
			process.stdout.write(
				JSON.stringify(
					collectProvenance(parseArgs(process.argv.slice(2))),
					null,
					2
				) + "\n"
			);
	} catch (error) {
		process.stderr.write(
			`Source provenance failed: ${error.message}\n${USAGE}\n`
		);
		process.exitCode = 1;
	}
}
