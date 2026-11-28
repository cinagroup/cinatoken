/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { searchBundleDigest } from "./finalize-search.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryWebBuildInputs } from "../../web/scripts/build-inputs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const files = [];
function walk(directory, prefix = "") {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		assert.ok(!entry.isSymbolicLink(), "Docs output must not contain links");
		const name = prefix + entry.name;
		if (entry.isDirectory()) walk(join(directory, entry.name), name + "/");
		else files.push(name);
	}
}
walk(dist);
const pages = files.filter((file) =>
	/^(en|zh)\/(?:docs|updates|reference)\/(?:[a-z0-9-]+\/)*index\.html$/.test(
		file,
	),
);
assert.ok(pages.length >= 18, "Missing content pages");
for (const file of pages)
	assert.ok(
		pages.includes(
			file.startsWith("en/") ? "zh/" + file.slice(3) : "en/" + file.slice(3),
		),
		"Missing locale counterpart: " + file,
	);
for (const file of pages) {
	const html = readFileSync(join(dist, file), "utf8");
	assert.ok(html.includes("CinaToken") && html.includes("<h1"), file);
	assert.ok(
		html.includes(`https://cinatoken.com/${file.replace(/index\.html$/, "")}`),
		"Canonical URL missing",
	);
	assert.doesNotMatch(
		html,
		/hm\.baidu\.com|fonts\.googleapis\.com/,
		"Unexpected analytics or remote font service",
	);
	assert.doesNotMatch(
		html,
		/<(?:script|link|img)[^>]+(?:src|href)="https?:\/\/octafuse\.dev/i,
		"Upstream assets must not load automatically",
	);
	for (const match of html.matchAll(
		/(?:href|src)="(\/(?:en|zh)\/(?:docs|updates|reference)\/[^"?#]*|\/docs-assets\/[^"?#]+)"/g,
	)) {
		const target = match[1].slice(1);
		assert.ok(
			files.includes(target.endsWith("/") ? target + "index.html" : target),
			`Broken docs link: ${match[1]} in ${file}`,
		);
	}
}
// Only approved namespaces are copied into the Web build. Astro's default root
// locale redirect and sitemap must never replace the existing product routes.
const search = files.filter((file) =>
	/^docs-assets\/search\/[a-f0-9]{64}\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(
		file,
	),
);
assert.ok(
	search.some((file) => file.endsWith("/pagefind.js")),
	"Versioned search bundle missing",
);
const versions = [...new Set(search.map((file) => file.split("/")[2]))];
assert.equal(versions.length, 1, "Expected one current search version");
assert.equal(
	searchBundleDigest(join(dist, "docs-assets/search", versions[0])).digest,
	versions[0],
	"Search version must bind every raw index member",
);
for (const path of pages)
	assert.ok(
		!readFileSync(join(dist, path), "utf8").includes("__SEARCH_VERSION__"),
		"Unresolved search version",
	);
assert.ok(
	search.some((file) => /\/wasm\..+\.pagefind$/.test(file)),
	"Search engine missing",
);
const assets = files.filter((file) =>
	/^docs-assets\/static\/[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{5,64}\.(?:js|css|svg|png|woff2?)$/.test(
		file,
	),
);
assert.ok(assets.length > 0, "No hashed docs assets");
assert.ok(
	files
		.filter((file) => file.startsWith("docs-assets/"))
		.every((file) => assets.includes(file) || search.includes(file)),
	"Unversioned docs asset",
);
const reference = files.filter((file) =>
	/^reference\/catalog\/(?:models|providers|models-by-vendor\/[a-z0-9_-]+)\.json$/.test(
		file,
	),
);
assert.ok(
	reference.includes("reference/catalog/models.json") &&
		reference.includes("reference/catalog/providers.json"),
	"Reference feeds missing",
);
const source = inventoryWebBuildInputs(resolve(root, "../web")).sourceSha256;
writeFileSync(
	join(dist, "docs-build.json"),
	JSON.stringify(
		{
			version: 1,
			sourceSha256: source,
			files: [
				...pages,
				...assets,
				...search,
				...reference,
				"content-sitemap.xml",
				"updates.xml",
			].sort(),
		},
		null,
		2,
	) + "\n",
);
console.log(
	`Verified ${pages.length} documentation pages and ${assets.length} hashed assets`,
);
