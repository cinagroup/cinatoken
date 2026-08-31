import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ENDPOINT_BACKFILL_EXIT, EndpointBackfillCliError } from "./contract";
import { reserveEndpointBackfillReportFile } from "./report-file";

test("apply report paths are reserved before mutation and never overwrite", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cinatoken-report-reservation-"));
	try {
		const path = join(directory, "apply.json");
		await writeFile(path, "original", { encoding: "utf8" });
		await assert.rejects(
			reserveEndpointBackfillReportFile(path),
			(error: unknown) =>
				error instanceof EndpointBackfillCliError &&
				error.exitCode === ENDPOINT_BACKFILL_EXIT.input
		);
		assert.equal(await readFile(path, "utf8"), "original");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a reserved report is finalized at the exact path", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cinatoken-report-reservation-"));
	try {
		const path = join(directory, "apply.json");
		const reservation = await reserveEndpointBackfillReportFile(path);
		await reservation.publish('{"status":"applied"}\n');
		assert.equal(await readFile(path, "utf8"), '{"status":"applied"}\n');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an uncommitted apply may abandon its empty reservation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cinatoken-report-reservation-"));
	try {
		const path = join(directory, "apply.json");
		const reservation = await reserveEndpointBackfillReportFile(path);
		await reservation.abandon();
		await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a committed apply may preserve a closed recovery marker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cinatoken-report-reservation-"));
	try {
		const path = join(directory, "apply.json");
		const reservation = await reserveEndpointBackfillReportFile(path);
		await reservation.preserve();
		assert.equal(await readFile(path, "utf8"), "");
		await reservation.abandon();
		assert.equal(await readFile(path, "utf8"), "");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
