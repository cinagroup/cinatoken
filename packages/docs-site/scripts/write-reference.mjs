/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const site = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
	output = join(site, "dist/reference/catalog");
mkdirSync(output, { recursive: true });
for (const name of ["models", "providers"]) {
	const body = readFileSync(
		join(site, "src/data/catalog", name + ".json"),
		"utf8",
	);
	writeFileSync(join(output, name + ".json"), body);
	if (name === "models") {
		const catalog = JSON.parse(body);
		for (const vendor of [
			...new Set(catalog.items.map((row) => row.vendor.toLowerCase())),
		]) {
			if (!/^[a-z0-9_-]+$/.test(vendor)) throw Error("Unsafe vendor ID");
			const items = catalog.items.filter(
				(row) => row.vendor.toLowerCase() === vendor,
			);
			mkdirSync(join(output, "models-by-vendor"), { recursive: true });
			writeFileSync(
				join(output, "models-by-vendor", vendor + ".json"),
				JSON.stringify({ ...catalog, count: items.length, items }, null, 2) +
					"\n",
			);
		}
	}
}
