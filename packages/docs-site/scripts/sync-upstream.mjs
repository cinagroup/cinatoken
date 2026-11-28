/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "src/data/updates/upstream-index.json");
const repository = "OctaFuse/octafuse-website";
export function titleForSlug(id) {
	const version = id.match(/^v(\d+-\d+-\d+)(?:-[a-z0-9-]+)?$/)?.[1];
	if (version)
		return {
			en: "OctaFuse Gateway " + version.replaceAll("-", "."),
			zh: "OctaFuse Gateway " + version.replaceAll("-", "."),
		};
	const titles = {
		"cloudflare-deployment": {
			en: "OctaFuse Cloudflare deployment",
			zh: "OctaFuse Cloudflare 部署",
		},
		"introducing-octafuse": {
			en: "Introducing OctaFuse",
			zh: "OctaFuse 项目介绍",
		},
	};
	assert.ok(
		titles[id],
		"A new non-version update needs an original, reviewed index label: " + id,
	);
	return titles[id];
}
export function checkIndex(index) {
	assert.equal(index.source.repo, repository);
	assert.match(index.source.ref, /^[a-f0-9]{40}$/);
	assert.deepEqual(index.source.fields, ["slug", "publishDate"]);
	assert.ok(index.items.length > 0);
	assert.equal(
		new Set(index.items.map((row) => row.id)).size,
		index.items.length,
	);
	for (const row of index.items) {
		assert.match(row.id, /^[a-z0-9-]+$/);
		assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(
			new Date(row.date + "T00:00:00Z").toISOString().slice(0, 10),
			row.date,
		);
		assert.equal(row.source, "octafuse");
		assert.deepEqual(row.title, titleForSlug(row.id));
		for (const locale of ["en", "zh"])
			assert.equal(
				row.href[locale],
				`https://octafuse.dev/${locale}/updates/${row.id}/`,
			);
		assert.equal(
			row.evidence,
			`https://github.com/${repository}/blob/${index.source.ref}/src/content/docs/en/updates/${row.id}.mdx`,
		);
	}
	assert.equal(index.inputs?.length, index.items.length);
	for (const input of index.inputs) {
		assert.match(
			input.path,
			/^src\/content\/docs\/en\/updates\/[a-z0-9-]+\.mdx$/,
		);
		assert.match(input.sha256, /^[a-f0-9]{64}$/);
	}
	assert.deepEqual(
		index.inputs.map((input) => input.path),
		index.items.map((row) => `src/content/docs/en/updates/${row.id}.mdx`),
	);
	return index;
}
export function readUpstream(repositoryPath, ref) {
	assert.match(ref, /^[a-f0-9]{40}$/);
	const git = (args) =>
		execFileSync("git", ["-C", repositoryPath, ...args], {
			maxBuffer: 4 * 1024 * 1024,
		});
	const files = git([
		"ls-tree",
		"-r",
		"--name-only",
		ref,
		"--",
		"src/content/docs/en/updates",
	])
		.toString()
		.trim()
		.split("\n")
		.filter((path) => /\/updates\/(?!index\.)[a-z0-9-]+\.mdx$/.test(path))
		.sort();
	const inputs = [],
		items = [];
	for (const path of files) {
		const bytes = git(["show", `${ref}:${path}`]),
			id = path
				.split("/")
				.at(-1)
				.replace(/\.mdx$/, "");
		// Only a date and path-derived version enter the output. No article text is copied.
		const frontmatter = bytes.toString().match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const date = frontmatter?.[1].match(
			/^publishDate:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m,
		)?.[1];
		assert.ok(date, "Missing factual publication date: " + path);
		inputs.push({
			path,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
		items.push({
			id,
			date,
			source: "octafuse",
			title: titleForSlug(id),
			href: {
				en: `https://octafuse.dev/en/updates/${id}/`,
				zh: `https://octafuse.dev/zh/updates/${id}/`,
			},
			evidence: `https://github.com/${repository}/blob/${ref}/${path}`,
		});
	}
	return checkIndex({
		source: {
			repo: repository,
			ref,
			fields: ["slug", "publishDate"],
			scope:
				"Factual version/date index and links only; no article prose or website code.",
		},
		inputs,
		items,
	});
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const argument = (name) => {
		const index = process.argv.indexOf(name);
		return index < 0 ? undefined : process.argv[index + 1];
	};
	const write = process.argv.includes("--write"),
		repo = argument("--upstream-repo"),
		stored = JSON.parse(readFileSync(file, "utf8")),
		ref = argument("--ref") || stored.source.ref;
	if (write && (!repo || !argument("--ref")))
		throw Error("--write requires --upstream-repo and a reviewed --ref");
	const next = repo ? readUpstream(resolve(repo), ref) : checkIndex(stored);
	const text = JSON.stringify(next, null, 2) + "\n";
	if (write) writeFileSync(file, text);
	else
		assert.equal(
			readFileSync(file, "utf8"),
			text,
			"Upstream factual index drift: review and explicitly regenerate the snapshot",
		);
	console.log(
		`${write ? "Wrote" : "Verified"} ${next.items.length} attributed upstream records at ${next.source.ref}`,
	);
}
