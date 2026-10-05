// Copyright (C) 2026 CinaGroup
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	blobId,
	collectProvenance,
	compareInventories,
	exclusion,
	inventoryTsv,
	parseArgs,
	parseBatch,
	parseTree,
	validatePath,
} from "./source-provenance.mjs";

const temp = fs.mkdtempSync(
	path.join(os.tmpdir(), "cinatoken-web-provenance-tests-")
);
const digest = (bytes) =>
	crypto.createHash("sha256").update(bytes).digest("hex");
const entry = (name, id, mode = "100644", type = "blob") =>
	Buffer.from(`${mode} ${type} ${id}\t${name}\0`);
const batch = (raw) =>
	Buffer.concat([
		Buffer.from(`${blobId(raw)} blob ${raw.length}\n`),
		raw,
		Buffer.from("\n"),
	]);
const row = (name, value) => ({
	path: name,
	bytes: Buffer.byteLength(value),
	sha256: digest(Buffer.from(value)),
});

function git(repo, args, input) {
	const p = spawnSync(
		"git",
		[
			"-C",
			repo,
			"-c",
			`core.hooksPath=${path.join(temp, "disabled-hooks")}`,
			"-c",
			"commit.gpgsign=false",
			"-c",
			"user.name=Local provenance test",
			"-c",
			"user.email=provenance-test@example.invalid",
			...args,
		],
		{ input, encoding: "buffer", windowsHide: true }
	);
	assert.equal(p.status, 0, p.stderr?.toString());
	return p.stdout.toString().trim();
}

function toy() {
	const repo = fs.mkdtempSync(path.join(temp, "repo-"));
	const web = path.join(repo, "packages/web");
	const write = (name, bytes) => {
		const p = path.join(web, name);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, bytes);
	};
	fs.mkdirSync(web, { recursive: true });
	git(repo, ["init", "--quiet"]);
	for (const [name, value] of Object.entries({
		"src/a.ts": "line\n",
		"src/b.ts": "line\n",
		"src/汉字 name.ts": "你好\n",
		"src/cinatoken/admin/keys/api-key-secret-reader.test.ts":
			"key management source\n",
		"src/cinatoken/account/credentials/manager.mjs":
			"credential management source\n",
		"delete.txt": "delete\n",
		".env": "synthetic-private-env",
		".env.example": "synthetic-private-example",
		".npmrc": "synthetic-credential-config",
		"secrets/data.json": "synthetic-secret",
		"src/id_rsa": "synthetic-key",
		"src/private-key.pem": "synthetic-key",
		"node_modules/pkg/index.js": "dependency",
		"dist/index.js": "build",
		"dist-server/node/index.mjs": "compiled build",
		".tmp/wrangler-dryrun/worker.js": "temporary compiled build",
		"tsconfig.tsbuildinfo": "build cache",
	}))
		write(name, value);
	git(repo, ["add", "--all"]);
	const linkBlob = git(
		repo,
		["hash-object", "-w", "--stdin"],
		Buffer.from("../outside-secret")
	);
	git(repo, [
		"update-index",
		"--add",
		"--cacheinfo",
		`120000,${linkBlob},packages/web/git-link`,
	]);
	git(repo, ["commit", "--quiet", "--no-verify", "-m", "Local byte baseline"]);
	const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
	return { repo, web, tree, write, linkBlob };
}

test("NUL tree parsing preserves Chinese, spaces, tabs/newlines and rejects ambiguous paths", () => {
	const id = blobId(Buffer.from("x"));
	const names = [
		"packages/web/src/汉字 name.ts",
		"packages/web/src/tab\tnewline\n.ts",
	];
	assert.deepEqual(
		parseTree(Buffer.concat(names.map((n) => entry(n, id)))).map((x) => x.path),
		names.slice().sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
	);
	assert.throws(
		() => parseTree(entry(names[0], id).subarray(0, -1)),
		/Truncated/
	);
	assert.throws(() => parseTree(Buffer.from("malformed\0")), /Malformed/);
	assert.throws(
		() => parseTree(Buffer.concat([entry(names[0], id), entry(names[0], id)])),
		/Duplicate/
	);
	assert.throws(
		() => parseTree(entry("packages/web/../outside", id)),
		/traversal/
	);
	assert.throws(() => parseTree(entry("/packages/web/a", id)), /absolute/);
	assert.throws(
		() => parseTree(entry("packages/web/x", id, "100644", "commit")),
		/Malformed/
	);
	const badHeader = entry(names[0], id);
	badHeader[0] |= 128;
	assert.throws(() => parseTree(badHeader), /encoded data/);
	assert.throws(
		() =>
			parseTree(
				Buffer.concat([
					Buffer.from(`100644 blob ${id}\tpackages/web/`),
					Buffer.from([255, 0]),
				])
			),
		/encoded data/
	);
	assert.throws(() => validatePath("packages/web/a\\..\\b"), /Invalid/);
});

test("Git batch parser obeys declared raw byte size, newline bytes and SHA1 identity", () => {
	const raw = Buffer.from([0, 10, 13, 255, 9, 65]);
	const id = blobId(raw);
	assert.deepEqual(parseBatch(batch(raw), [id]).get(id), {
		bytes: raw.length,
		sha256: digest(raw),
		gitBlobId: id,
	});
	assert.throws(
		() => parseBatch(batch(raw).subarray(0, -2), [id]),
		/Truncated/
	);
	assert.throws(
		() => parseBatch(Buffer.from(`${id} missing\n`), [id]),
		/Malformed/
	);
	assert.throws(
		() => parseBatch(Buffer.concat([batch(raw), Buffer.from("extra")]), [id]),
		/trailing/
	);
	assert.throws(() => parseBatch(batch(raw), [id, id]), /Duplicate/);
	assert.throws(() => parseBatch(batch(raw), ["f".repeat(40)]), /unexpected/);
	const bad = Buffer.from(batch(raw));
	bad[bad.length - 2] ^= 1;
	assert.throws(() => parseBatch(bad, [id]), /identity/);
	assert.throws(
		() => parseBatch(Buffer.from(`${id} blob 99999999999999999999\n`), [id]),
		/limit/
	);
	assert.throws(
		() => parseBatch(Buffer.from(`${id} blob 03\nabc\n`), [id]),
		/Malformed/
	);
	assert.throws(
		() => parseBatch(Buffer.from(`${id} blob 0\nx`), [id]),
		/terminator/
	);
	assert.notEqual(digest(Buffer.from("x\n")), digest(Buffer.from("x\r\n")));
});

test("stable TSV uses JSON path strings and UTF-8 byte sorting; duplicate inventories fail", () => {
	const rows = [
		row("packages/web/汉字 name.ts", "你好"),
		row("packages/web/a\tline\n.ts", "x\r\n"),
		row("packages/web/z.ts", ""),
	];
	const tsv = inventoryTsv(rows);
	assert.equal(tsv, inventoryTsv([...rows].reverse()));
	assert.equal(tsv.split("\n").length, 5);
	const parsed = tsv
		.trimEnd()
		.split("\n")
		.slice(1)
		.map((s) => {
			const [name, size, hash] = s.split("\t");
			return { path: JSON.parse(name), bytes: Number(size), sha256: hash };
		});
	assert.deepEqual(
		parsed,
		[...rows].sort((a, b) =>
			Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
		)
	);
	assert.throws(() => inventoryTsv([rows[0], rows[0]]), /Duplicate/);
	assert.throws(
		() => compareInventories([rows[0]], [rows[0], rows[0]]),
		/Duplicate/
	);
});

test("conservative exclusions cover env, secrets, keys, credentials, dependencies and build paths", () => {
	for (const name of [
		".env",
		".env.example",
		".envrc",
		".dev.vars.local",
		".npmrc",
		".git-credentials",
		"src/id_rsa",
		"src/private-key.pem",
		"src/cert.pem.bak",
		"secrets/data",
		"src/secrets/token.json",
		"keys/key",
		"node_modules/pkg/a",
		"dist/index.js",
		"dist-server/node/index.mjs",
		".tmp/wrangler-dryrun/worker.js",
		"config.tsbuildinfo",
		".wrangler/state/db",
	])
		assert.ok(exclusion("packages/web/" + name), name);
	for (const name of [
		"src/cinatoken/admin/keys/api-key-secret-reader.test.ts",
		"src/cinatoken/account/access-keys/use-secret-reader.tsx",
		"src/cinatoken/account/credentials/manager.mjs",
	])
		assert.equal(exclusion("packages/web/" + name), null, name);
	assert.equal(
		exclusion("packages/web/src/cinatoken/admin/keys", { directory: true }),
		null
	);
	assert.equal(exclusion("packages/web/src/token.ts"), null);
	assert.equal(exclusion("packages/web/public/logo.png"), null);
});

test("local toy Git tree comparison is byte accurate, deduplicates blobs and leaves upstream unresolved", () => {
	const t = toy();
	t.write("src/a.ts", "line\r\n");
	t.write("src/new.ts", "new\n");
	fs.unlinkSync(path.join(t.web, "delete.txt"));
	const output = path.join(temp, "comparison-output");
	const originalOpen = fs.openSync;
	fs.openSync = (name, ...args) => {
		if (
			typeof name === "string" &&
			name.startsWith(t.web) &&
			exclusion(path.relative(t.repo, name).split(path.sep).join("/"))
		)
			throw new Error("Excluded file was opened");
		return originalOpen(name, ...args);
	};
	try {
		collectProvenance({
			repoRoot: t.repo,
			outputDir: output,
			baselineTree: t.tree,
		});
	} finally {
		fs.openSync = originalOpen;
	}
	const report = JSON.parse(
		fs.readFileSync(path.join(output, "inventory.json"))
	);
	assert.deepEqual(report.comparison.counts, {
		same: 4,
		changed: 1,
		new: 1,
		deleted: 1,
	});
	assert.equal(report.current.count, 6);
	assert.equal(report.baseline.count, 6);
	assert.ok(
		report.current.inventory.some((x) =>
			x.path.endsWith("keys/api-key-secret-reader.test.ts")
		)
	);
	assert.ok(
		report.current.inventory.some((x) =>
			x.path.endsWith("credentials/manager.mjs")
		)
	);
	assert.equal(report.metadata.baselineKind, "local-git-tree");
	for (const key of [
		"upstreamRepository",
		"upstreamRef",
		"upstreamCommit",
		"importDate",
	])
		assert.equal(report.metadata[key], null);
	assert.equal(report.metadata.sourceRequirementComplete, false);
	assert.ok(
		report.baseline.excluded.some(
			(x) => x.path.endsWith("git-link") && x.reason === "symlink-blob-not-read"
		)
	);
	assert.equal(
		report.current.inventory.find((x) => x.path.endsWith("a.ts")).sha256,
		digest(Buffer.from("line\r\n"))
	);
	assert.equal(
		report.baseline.inventory.find((x) => x.path.endsWith("a.ts")).sha256,
		digest(Buffer.from("line\n"))
	);
	assert.equal(
		report.baseline.inventory.find((x) => x.path.endsWith("a.ts")).gitBlobId,
		report.baseline.inventory.find((x) => x.path.endsWith("b.ts")).gitBlobId
	);
	assert.equal(
		report.current.aggregateSha256,
		digest(fs.readFileSync(path.join(output, "current.tsv")))
	);
	assert.equal(
		report.baseline.aggregateSha256,
		digest(fs.readFileSync(path.join(output, "baseline.tsv")))
	);
	assert.equal(
		report.current.inventory.some((x) => exclusion(x.path)),
		false
	);
	const summary = JSON.parse(
		fs.readFileSync(path.join(output, "summary.json"))
	);
	for (const item of summary.files)
		assert.equal(
			item.sha256,
			digest(fs.readFileSync(path.join(output, item.path)))
		);
});

test("output cannot overwrite existing directories or enter source, and absent/non-tree baselines create no output", () => {
	const t = toy();
	const existing = path.join(temp, "existing");
	fs.mkdirSync(existing);
	fs.writeFileSync(path.join(existing, "sentinel"), "keep");
	assert.throws(
		() =>
			collectProvenance({
				repoRoot: t.repo,
				outputDir: existing,
				baselineTree: t.tree,
			}),
		/already exists/
	);
	assert.equal(
		fs.readFileSync(path.join(existing, "sentinel"), "utf8"),
		"keep"
	);
	assert.throws(
		() =>
			collectProvenance({
				repoRoot: t.repo,
				outputDir: path.join(t.web, "source-output"),
				baselineTree: t.tree,
			}),
		/separate/
	);
	const missingOutput = path.join(temp, "missing-baseline");
	assert.throws(
		() =>
			collectProvenance({
				repoRoot: t.repo,
				outputDir: missingOutput,
				baselineTree: "0".repeat(40),
			}),
		/Git command failed/
	);
	assert.equal(fs.existsSync(missingOutput), false);
	assert.throws(
		() =>
			collectProvenance({
				repoRoot: t.repo,
				outputDir: missingOutput,
				baselineTree: git(t.repo, ["rev-parse", "HEAD"]),
			}),
		/not a commit/
	);
	assert.throws(
		() =>
			collectProvenance({
				repoRoot: t.repo,
				outputDir: missingOutput,
				baselineTree: t.tree.slice(0, 8),
			}),
		/complete/
	);
	const empty = git(t.repo, ["mktree"], Buffer.alloc(0));
	assert.throws(
		() =>
			collectProvenance({
				repoRoot: t.repo,
				outputDir: missingOutput,
				baselineTree: empty,
			}),
		/no Web paths/
	);
});

test("source junctions/symlinks are excluded and aliased source/output ancestors are rejected", () => {
	const t = toy();
	const outside = fs.mkdtempSync(path.join(temp, "outside-"));
	fs.writeFileSync(path.join(outside, "canary.txt"), "must not be read");
	const link = path.join(t.web, "linked");
	fs.symlinkSync(
		outside,
		link,
		process.platform === "win32" ? "junction" : "dir"
	);
	const output = path.join(temp, "links-output");
	collectProvenance({
		repoRoot: t.repo,
		outputDir: output,
		baselineTree: t.tree,
	});
	const report = JSON.parse(
		fs.readFileSync(path.join(output, "inventory.json"))
	);
	assert.ok(
		report.current.excluded.some(
			(x) => x.path.endsWith("linked") && x.reason === "symlink-or-junction"
		)
	);
	assert.equal(
		report.current.inventory.some((x) => x.path.includes("canary")),
		false
	);
	const alias = path.join(temp, "output-alias");
	fs.symlinkSync(
		outside,
		alias,
		process.platform === "win32" ? "junction" : "dir"
	);
	assert.throws(
		() =>
			collectProvenance({
				repoRoot: t.repo,
				outputDir: path.join(alias, "new-output"),
				baselineTree: t.tree,
			}),
		/ancestor rejected/
	);
	const repoAlias = path.join(temp, "repo-alias");
	fs.symlinkSync(
		t.repo,
		repoAlias,
		process.platform === "win32" ? "junction" : "dir"
	);
	assert.throws(
		() =>
			collectProvenance({
				repoRoot: repoAlias,
				outputDir: path.join(temp, "alias-source-output"),
				baselineTree: t.tree,
			}),
		/ancestor rejected/
	);
	assert.equal(fs.existsSync(path.join(outside, "new-output")), false);
});

test("CLI requires explicit arguments, prints usage and fails safely without exposing Git stderr", () => {
	assert.throws(() => parseArgs(["--repo-root", "x"]), /All three/);
	assert.throws(
		() => parseArgs(["--repo-root", "x", "--repo-root", "y"]),
		/duplicate/
	);
	const tool = fileURLToPath(
		new URL("./source-provenance.mjs", import.meta.url)
	);
	const help = spawnSync(process.execPath, [tool, "--help"], {
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(help.status, 0);
	assert.match(help.stdout, /--repo-root.*--output-dir.*--baseline-tree/);
	const bad = spawnSync(process.execPath, [tool], {
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /All three explicit/);
	assert.ok(
		path.relative(os.tmpdir(), temp) &&
			!path.relative(os.tmpdir(), temp).startsWith("..")
	);
	assert.ok(fs.readdirSync(temp).some((name) => name.startsWith("repo-")));
	process.stdout.write(`Provenance safety fixtures retained: ${temp}\n`);
});
