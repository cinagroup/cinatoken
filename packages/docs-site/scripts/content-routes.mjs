/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
	source = join(root, "src/content/docs");
function walk(directory, prefix = "") {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? walk(join(directory, entry.name), prefix + entry.name + "/")
			: [prefix + entry.name],
	);
}
const paths = walk(source)
	.filter((file) => /^(en|zh)\/(docs|updates|reference)\/.+\.mdx?$/.test(file))
	.map(
		(file) => "/" + file.replace(/\.mdx?$/, "").replace(/\/index$/, "") + "/",
	)
	.sort();
for (const path of paths) {
	const other = path.startsWith("/en/")
		? "/zh/" + path.slice(4)
		: "/en/" + path.slice(4);
	if (!paths.includes(other)) throw Error("Missing translation: " + path);
}
const file = join(root, "src/data/content-routes.json"),
	text = JSON.stringify({ paths }, null, 2) + "\n";
if (process.argv.includes("--write")) writeFileSync(file, text);
else if (readFileSync(file, "utf8") !== text)
	throw Error("Content routes drift: run sync:routes -- --write");
if (process.argv.includes("--feeds")) {
	const escape = (value) =>
		String(value)
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;");
	const pairs = [
		...new Set(paths.map((path) => path.replace(/^\/(en|zh)/, ""))),
	];
	const urls = pairs
		.flatMap((path) =>
			["en", "zh"].map(
				(locale) =>
					`<url><loc>https://cinatoken.com/${locale}${escape(path)}</loc><xhtml:link rel="alternate" hreflang="en" href="https://cinatoken.com/en${escape(path)}"/><xhtml:link rel="alternate" hreflang="zh-CN" href="https://cinatoken.com/zh${escape(path)}"/></url>`,
			),
		)
		.join("");
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(
		join(root, "dist/content-sitemap.xml"),
		`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`,
	);
	const updates = JSON.parse(
		readFileSync(join(root, "src/data/updates/cinatoken.json"), "utf8"),
	).items;
	const entries = updates
		.map(
			(row) =>
				`<item><title>${escape(row.title.en)}</title><link>https://cinatoken.com${escape(row.href.en)}</link><guid isPermaLink="true">https://cinatoken.com${escape(row.href.en)}</guid><pubDate>${new Date(row.date + "T00:00:00Z").toUTCString()}</pubDate></item>`,
		)
		.join("");
	writeFileSync(
		join(root, "dist/updates.xml"),
		`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>CinaToken updates</title><link>https://cinatoken.com/en/updates/</link><description>Updates to the CinaToken hosted platform</description>${entries}</channel></rss>`,
	);
}
console.log(`Verified ${paths.length} bilingual content routes`);
