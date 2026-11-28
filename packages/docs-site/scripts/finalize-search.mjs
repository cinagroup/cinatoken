/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	readdirSync,
	mkdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function inventory(directory, prefix = "") {
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			if (entry.isSymbolicLink()) throw Error("Linked search output");
			const path = prefix + entry.name;
			return entry.isDirectory()
				? inventory(join(directory, entry.name), path + "/")
				: [path];
		})
		.sort();
}
export function searchBundleDigest(source) {
	const files = inventory(source);
	const hash = createHash("sha256");
	for (const path of files) {
		if (
			!/^[A-Za-z0-9_./-]+$/.test(path) ||
			path.split("/").some((part) => part === "." || part === "..")
		)
			throw Error("Unsafe search asset");
		const bytes = readFileSync(join(source, path));
		hash.update(`${path}\0${bytes.length}\0`).update(bytes);
	}
	return { digest: hash.digest("hex"), files };
}
export function finalizeSearch(dist) {
	const source = join(dist, "pagefind");
	if (!existsSync(join(source, "pagefind.js")))
		throw Error("Search bundle missing");
	const { digest, files } = searchBundleDigest(source);
	const target = join(dist, "docs-assets/search", digest);
	mkdirSync(dirname(target), { recursive: true });
	renameSync(source, target);
	for (const path of inventory(dist).filter((path) =>
		/^(en|zh)\/.+\.html$/.test(path),
	)) {
		const file = join(dist, path);
		writeFileSync(
			file,
			readFileSync(file, "utf8")
				.replaceAll("__SEARCH_VERSION__", digest)
				.replaceAll('href="/sitemap-index.xml"', 'href="/content-sitemap.xml"'),
		);
	}
	console.log(`Versioned search index ${digest}: ${files.length} files`);

	return { digest, files };
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	finalizeSearch(resolve(dirname(fileURLToPath(import.meta.url)), "../dist"));
