/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const site = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
	root = resolve(site, "../.."),
	output = join(site, "src/data/catalog");
const write = process.argv.includes("--write");
const refArgument = process.argv.indexOf("--ref");
if (write && refArgument < 0)
	throw Error("--write requires an explicit reviewed --ref");
const previous = () =>
	JSON.parse(readFileSync(join(output, "sync-manifest.json"), "utf8"));
const ref =
	refArgument >= 0 ? process.argv[refArgument + 1] : previous().source.ref;
if (!/^[a-f0-9]{40}$/.test(ref))
	throw Error("A reviewed source commit is required");
const source = {
	repo: "cinagroup/cinatoken",
	ref,
	license: "AGPL-3.0-or-later",
};
const paths = [
	...readdirSync(join(root, "packages/admin/lib/model-presets"))
		.filter((p) => p.endsWith(".json"))
		.sort()
		.map((p) => "packages/admin/lib/model-presets/" + p),
	"packages/admin/lib/provider-import-presets.json",
];
if (write)
	for (const path of paths) {
		const committed = execFileSync("git", ["show", `${ref}:${path}`], {
			cwd: root,
			maxBuffer: 10 * 1024 * 1024,
		});
		if (!committed.equals(readFileSync(join(root, path))))
			throw Error("Source commit does not match " + path);
	}
const kindByModelId = {};
for (const path of paths.filter((p) => p.includes("/model-presets/")))
	for (const row of JSON.parse(readFileSync(join(root, path), "utf8"))) {
		const output = row.modalities?.output || [];
		kindByModelId[row.id] = path.endsWith("-audio-asr.json")
			? "asr"
			: path.endsWith("-audio-tts.json")
				? "tts"
				: output.includes("embedding")
					? "embedding"
					: output.includes("image")
						? "image"
						: output.includes("rerank")
							? "rerank"
							: output.includes("audio")
								? "audio"
								: "llm";
	}
const inputs = paths.map((path) => ({
	path,
	sha256: createHash("sha256")
		.update(readFileSync(join(root, path)))
		.digest("hex"),
}));
const models = paths
	.filter((p) => p.includes("/model-presets/"))
	.flatMap((path) => JSON.parse(readFileSync(join(root, path), "utf8")));
const rawProviders = JSON.parse(
	readFileSync(
		join(root, "packages/admin/lib/provider-import-presets.json"),
		"utf8",
	),
);
const providers = rawProviders.map((row) => ({
	name: row.name,
	vendor_key: row.vendor_key,
	...(row.icon_key ? { icon_key: row.icon_key } : {}),
	description: row.catalog?.i18n?.en?.description || row.description,
	endpoints: row.endpoints,
	...(row.catalog ? { catalog: row.catalog } : {}),
}));
for (const [name, rows, key] of [
	["models", models, "id"],
	["providers", providers, "name"],
]) {
	if (!rows.length || new Set(rows.map((row) => row[key])).size !== rows.length)
		throw Error("Empty or duplicate " + name);
}
const outputs = {
	"presentation.json": { kindByModelId },
	"models.json": {
		schema_version: 2,
		catalog: "models",
		source,
		source_path: "packages/admin/lib/model-presets",
		count: models.length,
		items: models,
	},
	"providers.json": {
		schema_version: 2,
		catalog: "providers",
		source,
		source_path: "packages/admin/lib/provider-import-presets.json",
		count: providers.length,
		items: providers,
	},
	"sync-manifest.json": {
		schema_version: 1,
		source,
		inputs,
		outputs: { models: models.length, providers: providers.length },
	},
};
mkdirSync(output, { recursive: true });
for (const [name, data] of Object.entries(outputs)) {
	const text = JSON.stringify(data, null, 2) + "\n",
		file = join(output, name);
	if (write) writeFileSync(file, text);
	else if (readFileSync(file, "utf8") !== text)
		throw Error(
			"Catalog snapshot drift: " +
				name +
				". Review source changes and run sync:catalog -- --write --ref <reviewed-sha>.",
		);
}
console.log(
	`${write ? "Wrote" : "Verified"} reviewed catalog: ${models.length} models, ${providers.length} providers; source ${ref}`,
);
