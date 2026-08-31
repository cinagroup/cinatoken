import { open, unlink } from "node:fs/promises";

import {
	ENDPOINT_BACKFILL_EXIT,
	EndpointBackfillCliError,
} from "./contract";

const MAX_REPORT_BYTES = 20 * 1024 * 1024;

export interface EndpointBackfillReportReservation {
	/**
	 * Finalize the already-reserved path. A publish failure deliberately leaves
	 * the path in place: after a database commit it is a recovery marker and must
	 * never be mistaken for an apply that did not run.
	 */
	publish(contents: string): Promise<void>;
	/** Close the durable empty/partial recovery marker without removing it. */
	preserve(): Promise<void>;
	/** Remove the empty reservation only while the database is known unmodified. */
	abandon(): Promise<void>;
}

/**
 * Reserve the exact final path before any mutating database call. This closes
 * the dangerous "commit succeeded, report path was invalid" ordering. The
 * final file is mode 0600 and is never allowed to replace an existing path.
 */
export async function reserveEndpointBackfillReportFile(
	path: string
): Promise<EndpointBackfillReportReservation> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(path, "wx", 0o600);
		const metadata = await handle.stat();
		if (!metadata.isFile()) throw new TypeError("report is not a regular file");
	} catch {
		await handle?.close().catch(() => undefined);
		if (handle) await unlink(path).catch(() => undefined);
		throw new EndpointBackfillCliError(
			"Could not reserve --report; choose a new absolute path in an existing writable directory",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}

	let state: "reserved" | "published" | "preserved" | "abandoned" = "reserved";
	if (!handle) {
		throw new EndpointBackfillCliError(
			"Could not reserve --report",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const reservedHandle = handle;
	return {
		async publish(contents) {
			if (state !== "reserved") {
				throw new EndpointBackfillCliError(
					"The report reservation is no longer writable",
					ENDPOINT_BACKFILL_EXIT.input
				);
			}
			const bytes = Buffer.byteLength(contents, "utf8");
			if (bytes === 0 || bytes > MAX_REPORT_BYTES) {
				throw new EndpointBackfillCliError(
					"The canonical apply report exceeds its safe size bound",
					ENDPOINT_BACKFILL_EXIT.input
				);
			}
			try {
				await reservedHandle.truncate(0);
				await reservedHandle.writeFile(contents, { encoding: "utf8" });
				await reservedHandle.sync();
				await reservedHandle.close();
				state = "published";
			} catch {
				state = "preserved";
				await reservedHandle.close().catch(() => undefined);
				throw new EndpointBackfillCliError(
					"The database result is durable but the reserved apply report could not be finalized",
					ENDPOINT_BACKFILL_EXIT.committedReportPending
				);
			}
		},
		async preserve() {
			if (state !== "reserved") return;
			state = "preserved";
			await reservedHandle.close().catch(() => undefined);
		},
		async abandon() {
			if (state !== "reserved") return;
			state = "abandoned";
			await reservedHandle.close().catch(() => undefined);
			await unlink(path).catch(() => undefined);
		},
	};
}
