import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	applyEndpointBackfill,
	EndpointBackfillApplyError,
	type EndpointBackfillApplyReport,
} from "../../../packages/core/src/model-endpoint-backfill-apply";
import {
	EndpointBackfillManifestError,
	parseEndpointBackfillManifest,
	planEndpointBackfill,
	sha256EndpointBackfillValue,
	type EndpointBackfillInventory,
	type EndpointBackfillManifest,
	type EndpointBackfillReport,
} from "../../../packages/core/src/model-endpoint-backfill";
import {
	ENDPOINT_BACKFILL_EXIT,
	EndpointBackfillCliError,
	EndpointBackfillDatabaseError,
	parseEndpointBackfillApplyArgs,
	parseEndpointBackfillPlanArgs,
	resolveEndpointBackfillDatabaseFingerprint,
	selectEndpointBackfillManifest,
	serializeEndpointBackfillReport,
} from "./contract";
import {
	loadEndpointBackfillInventory,
	type EndpointBackfillInventoryRequest,
	type LoadedEndpointBackfillInventory,
} from "./inventory";
import {
	ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV,
	parseEndpointBackfillApproval,
	parseEndpointBackfillApprovalKeyRegistryEnv,
	verifyEndpointBackfillApproval,
} from "./authorization";
import { createEndpointBackfillApplyStore } from "./apply-store";
import {
	reserveEndpointBackfillReportFile,
	type EndpointBackfillReportReservation,
} from "./report-file";

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_APPROVAL_BYTES = 1024 * 1024;

export type EndpointBackfillCliResult = {
	exitCode: number;
	message: string;
	reportWritten: boolean;
};

export type EndpointBackfillCliDependencies = {
	readManifest(path: string): Promise<unknown>;
	writeReport(path: string, contents: string): Promise<void>;
	loadInventory(
		request: EndpointBackfillInventoryRequest
	): Promise<LoadedEndpointBackfillInventory>;
	plan(
		manifest: EndpointBackfillManifest,
		inventory: EndpointBackfillInventory,
		now: Date,
		provenance: { full_manifest_sha256: string }
	): Promise<EndpointBackfillReport>;
	now(): Date;
};

export type EndpointBackfillApplyCliDependencies = {
	readManifest(path: string): Promise<unknown>;
	readApproval(path: string): Promise<unknown>;
	reserveReport(path: string): Promise<EndpointBackfillReportReservation>;
	createStore: typeof createEndpointBackfillApplyStore;
	apply: typeof applyEndpointBackfill;
	now(): Date;
};

async function readBoundedJsonFile(path: string, label: "manifest" | "approval"): Promise<unknown> {
	const maxBytes = label === "approval" ? MAX_APPROVAL_BYTES : MAX_MANIFEST_BYTES;
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(path, "r");
		const metadata = await handle.stat();
		if (!metadata.isFile()) throw new TypeError(`${label} is not a regular file`);
		if (metadata.size > maxBytes) throw new TypeError(`${label} is too large`);
		const bytes = Buffer.allocUnsafe(maxBytes + 1);
		let total = 0;
		while (total < bytes.length) {
			const result = await handle.read(bytes, total, bytes.length - total, null);
			if (result.bytesRead === 0) break;
			total += result.bytesRead;
		}
		if (total > maxBytes) throw new TypeError(`${label} is too large`);
		return JSON.parse(bytes.subarray(0, total).toString("utf8")) as unknown;
	} catch {
		throw new EndpointBackfillCliError(
			`Could not read a valid JSON ${label} from --${label}`,
			ENDPOINT_BACKFILL_EXIT.input
		);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function readEndpointBackfillManifestFile(
	path: string
): Promise<unknown> {
	return readBoundedJsonFile(path, "manifest");
}

export async function readEndpointBackfillApprovalFile(path: string): Promise<unknown> {
	return readBoundedJsonFile(path, "approval");
}

export async function writeEndpointBackfillReportFile(
	path: string,
	contents: string
): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	let temporaryPath: string | null = null;
	try {
		// Write and fsync an unpredictable file in the destination directory first.
		// Publishing with a hard link is atomic and fails if the final path exists.
		temporaryPath = join(
			dirname(path),
			`.cinatoken-endpoint-backfill-${randomUUID()}.tmp`
		);
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(contents, { encoding: "utf8" });
		await handle.sync();
		await handle.close();
		handle = null;
		await link(temporaryPath, path);
		await unlink(temporaryPath);
		temporaryPath = null;
	} catch {
		await handle?.close().catch(() => undefined);
		handle = null;
		if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
		throw new EndpointBackfillCliError(
			"Could not create --report; choose a new absolute path in an existing directory",
			ENDPOINT_BACKFILL_EXIT.input
		);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

const DEFAULT_DEPENDENCIES: EndpointBackfillCliDependencies = {
	readManifest: readEndpointBackfillManifestFile,
	writeReport: writeEndpointBackfillReportFile,
	loadInventory: loadEndpointBackfillInventory,
	plan: planEndpointBackfill,
	now: () => new Date(),
};

const DEFAULT_APPLY_DEPENDENCIES: EndpointBackfillApplyCliDependencies = {
	readManifest: readEndpointBackfillManifestFile,
	readApproval: readEndpointBackfillApprovalFile,
	reserveReport: reserveEndpointBackfillReportFile,
	createStore: createEndpointBackfillApplyStore,
	apply: applyEndpointBackfill,
	now: () => new Date(),
};

function projectSafeConsistencyRead(
	read: LoadedEndpointBackfillInventory["consistency"]["before"]
): LoadedEndpointBackfillInventory["consistency"]["before"] {
	return {
		rows_sha256: read.rows_sha256,
		version_vector: {
			migration_head: read.version_vector.migration_head,
			models: read.version_vector.models,
			providers: read.version_vector.providers,
			routes: read.version_vector.routes,
			endpoints: read.version_vector.endpoints,
			links: read.version_vector.links,
			endpoint_revisions_sha256:
				read.version_vector.endpoint_revisions_sha256,
			link_revisions_sha256: read.version_vector.link_revisions_sha256,
		},
	};
}

async function safeDriftReport(
	manifest: EndpointBackfillManifest,
	loaded: LoadedEndpointBackfillInventory,
	generatedAt: Date,
	fullManifestSha256: string
): Promise<Record<string, unknown>> {
	const source = {
		driver: loaded.inventory.source.driver,
		database_fingerprint: loaded.inventory.source.database_fingerprint,
		required_migration: loaded.inventory.source.required_migration,
		migration_head: loaded.inventory.source.migration_head,
		migration_present: loaded.inventory.source.migration_present === true,
	};
	const inventoryConsistency = {
		semantics: loaded.consistency.semantics,
		snapshot_consistent: false as const,
		before: projectSafeConsistencyRead(loaded.consistency.before),
		after: projectSafeConsistencyRead(loaded.consistency.after),
		drifted: loaded.consistency.drifted,
	};
	return {
		version: "cinatoken.endpoint-backfill-cli-failure.v1",
		mode: "dry-run",
		apply_supported: false,
		authorization_verified: false,
		status: "concurrent_inventory_drift",
		generated_at: generatedAt.toISOString(),
		manifest_id: manifest.manifest_id,
		manifest_sha256: fullManifestSha256,
		selected_manifest_sha256: await sha256EndpointBackfillValue(manifest),
		selection_sha256: await sha256EndpointBackfillValue(
			manifest.endpoints.map((endpoint) => endpoint.id)
		),
		source,
		database_fingerprint_source: "operator_asserted_environment",
		database_identity_verified: false,
		inventory_consistency: inventoryConsistency,
	};
}

function safeResultForError(error: unknown): EndpointBackfillCliResult {
	if (error instanceof EndpointBackfillCliError) {
		return {
			exitCode: error.exitCode,
			message: error.message,
			reportWritten: false,
		};
	}
	if (error instanceof EndpointBackfillManifestError) {
		return {
			exitCode: ENDPOINT_BACKFILL_EXIT.input,
			message: error.message,
			reportWritten: false,
		};
	}
	if (error instanceof EndpointBackfillApplyError) {
		const exitCode =
			error.code === "authorization_mismatch" ||
			error.code === "authorization_expired"
				? ENDPOINT_BACKFILL_EXIT.input
				: error.code === "validation_blocked"
					? ENDPOINT_BACKFILL_EXIT.blocked
					: error.code === "execution_mismatch" ||
							error.code === "revision_conflict"
						? ENDPOINT_BACKFILL_EXIT.drift
						: ENDPOINT_BACKFILL_EXIT.database;
		return { exitCode, message: error.message, reportWritten: false };
	}
	return {
		exitCode: ENDPOINT_BACKFILL_EXIT.database,
		message:
			"Endpoint backfill planning failed without exposing database or credential diagnostics",
		reportWritten: false,
	};
}

export async function executeEndpointBackfillPlan(
	rawArgs: readonly string[],
	env: Readonly<Record<string, string | undefined>> = process.env,
	dependencies: EndpointBackfillCliDependencies = DEFAULT_DEPENDENCIES
): Promise<EndpointBackfillCliResult> {
	try {
		const options = parseEndpointBackfillPlanArgs(rawArgs);
		const parsed = parseEndpointBackfillManifest(
			await dependencies.readManifest(options.manifestPath)
		);
		const fullManifestSha256 = await sha256EndpointBackfillValue(parsed);
		const manifest = selectEndpointBackfillManifest(parsed, options);
		const databaseFingerprint = resolveEndpointBackfillDatabaseFingerprint(
			env,
			manifest,
			options.driver
		);
		const loaded = await dependencies.loadInventory({
			driver: options.driver,
			manifest,
			databaseFingerprint,
			env,
			d1Source: options.d1Source,
			...(options.d1PersistTo ? { d1PersistTo: options.d1PersistTo } : {}),
		});
		const now = dependencies.now();
		if (!Number.isFinite(now.getTime())) {
			throw new EndpointBackfillCliError(
				"Planner clock is invalid",
				ENDPOINT_BACKFILL_EXIT.input
			);
		}
		if (loaded.consistency.drifted) {
			await dependencies.writeReport(
				options.reportPath,
				serializeEndpointBackfillReport(
					await safeDriftReport(manifest, loaded, now, fullManifestSha256)
				)
			);
			return {
				exitCode: ENDPOINT_BACKFILL_EXIT.drift,
				message:
					"Referenced rows changed between the bounded reads; no plan was produced",
				reportWritten: true,
			};
		}
		const report = await dependencies.plan(manifest, loaded.inventory, now, {
			full_manifest_sha256: fullManifestSha256,
		});
		const serialized = serializeEndpointBackfillReport(report);
		// Defense in depth: the only JSON emitted is the planner's typed report.
		// Re-parse before writing so accidental non-JSON logging cannot enter it.
		JSON.parse(serialized);
		await dependencies.writeReport(options.reportPath, serialized);
		return {
			exitCode: report.validation_passed
				? ENDPOINT_BACKFILL_EXIT.ok
				: ENDPOINT_BACKFILL_EXIT.blocked,
			message: report.validation_passed
				? `Endpoint backfill validation passed (${report.summary.actions} proposed action(s), ${report.summary.noops} noop(s)); authorization is unverified and apply is unsupported`
				: `Endpoint backfill validation is blocked (${report.summary.blocked} endpoint(s))`,
			reportWritten: true,
		};
	} catch (error) {
		return safeResultForError(error);
	}
}

export async function executeEndpointBackfillApply(
	rawArgs: readonly string[],
	env: Readonly<Record<string, string | undefined>> = process.env,
	dependencies: EndpointBackfillApplyCliDependencies = DEFAULT_APPLY_DEPENDENCIES
): Promise<EndpointBackfillCliResult> {
	let reservation: EndpointBackfillReportReservation | null = null;
	let databaseCommitted = false;
	try {
		const options = parseEndpointBackfillApplyArgs(rawArgs);
		const parsed = parseEndpointBackfillManifest(
			await dependencies.readManifest(options.manifestPath)
		);
		const fullManifestSha256 = await sha256EndpointBackfillValue(parsed);
		const manifest = selectEndpointBackfillManifest(parsed, options);
		const databaseFingerprint = resolveEndpointBackfillDatabaseFingerprint(
			env,
			manifest,
			options.driver
		);
		const registry = parseEndpointBackfillApprovalKeyRegistryEnv(env);
		const now = dependencies.now();
		if (!Number.isFinite(now.getTime())) {
			throw new EndpointBackfillCliError(
				"Approval verifier clock is invalid",
				ENDPOINT_BACKFILL_EXIT.input
			);
		}
		const approval = parseEndpointBackfillApproval(
			await dependencies.readApproval(options.approvalPath)
		);
		const authorization = await verifyEndpointBackfillApproval({
			approval,
			manifest,
			full_manifest_sha256: fullManifestSha256,
			registry,
			now,
		});
		// Reserve the exact destination only after every local input and signature
		// check, but before the first mutating database call.
		reservation = await dependencies.reserveReport(options.reportPath);
		const report: EndpointBackfillApplyReport = await dependencies.apply({
			manifest,
			full_manifest_sha256: fullManifestSha256,
			authorization,
			store: dependencies.createStore({
				driver: options.driver,
				manifest,
				databaseFingerprint,
				env,
			}),
			now,
		});
		databaseCommitted = true;
		try {
			const serialized = serializeEndpointBackfillReport(report);
			JSON.parse(serialized);
			await reservation.publish(serialized);
		} catch {
			await reservation.preserve().catch(() => undefined);
			return {
				exitCode: ENDPOINT_BACKFILL_EXIT.committedReportPending,
				message:
					`committed_report_pending: endpoint backfill is durable ` +
					`(idempotency_key=${report.idempotency_key}); keep the reserved marker and ` +
					"recover with a new report path and a fresh valid approval",
				reportWritten: false,
			};
		}
		return {
			exitCode: ENDPOINT_BACKFILL_EXIT.ok,
			message:
				report.status === "already_applied"
					? "Endpoint backfill was already committed; immutable ledger provenance matched"
					: `Endpoint backfill committed atomically (${report.actions} action(s), ${report.endpoints} endpoint(s))`,
			reportWritten: true,
		};
	} catch (error) {
		if (reservation && !databaseCommitted) {
			if (error instanceof EndpointBackfillDatabaseError) {
				await reservation.preserve().catch(() => undefined);
				const result = safeResultForError(error);
				return {
					...result,
					message:
						`database_outcome_requires_reconciliation: ${result.message}; ` +
						"keep the reserved marker and retry the same immutable request with a new report path",
				};
			}
			await reservation.abandon().catch(() => undefined);
		}
		return safeResultForError(error);
	}
}

export async function executeEndpointBackfill(
	rawArgs: readonly string[],
	env: Readonly<Record<string, string | undefined>> = process.env
): Promise<EndpointBackfillCliResult> {
	return rawArgs.filter((arg) => arg !== "--")[0] === "apply"
		? executeEndpointBackfillApply(rawArgs, env)
		: executeEndpointBackfillPlan(rawArgs, env);
}

export function endpointBackfillUsage(): string {
	return `Usage:
  npm run db:endpoint-backfill:plan -- --driver=d1|postgres|mysql \\
    --manifest=<absolute-json-path> --report=<new-absolute-json-path> \\
    (--all-manifest | --endpoint-id=<id> [--endpoint-id=<id> ...])

  npm run db:endpoint-backfill:apply -- --apply --driver=postgres|mysql \\
	--manifest=<absolute-json-path> --approval=<absolute-json-path> \\
	--report=<new-absolute-json-path> \\
	(--all-manifest | --endpoint-id=<id> [--endpoint-id=<id> ...])

D1-only options:
  --d1-source=remote|local
  --d1-persist-to=<path>

Required environment:
  ENDPOINT_BACKFILL_DATABASE_FINGERPRINT=sha256:<64 lowercase hex>
	${ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV}=<strict trusted-key registry JSON> (apply only)
  DATABASE_URL=<postgres-or-mysql-url>       (PostgreSQL/MySQL only)
  SHARED_KEY_ENCRYPTION_SECRET=<secret>      (when provider keys are encrypted)
  D1_DATABASE_NAME=<name>                    (D1 optional; defaults to configured name)

Plan is the default and is always read-only. Apply requires both the apply
subcommand and --apply, a fresh signed approval, the immutable ledger migration,
and a serializable PostgreSQL/MySQL transaction. D1 apply remains fail-closed
until a Worker-bound D1Database.batch writer is deployed. Reports are created
exclusively and never overwrite an existing file.`;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const helpRequested =
		(args.length === 1 && (args[0] === "--help" || args[0] === "-h")) ||
		(args.length === 2 &&
			args[0] === "plan" &&
			(args[1] === "--help" || args[1] === "-h"));
	if (helpRequested) {
		console.log(endpointBackfillUsage());
		return;
	}
	const result = await executeEndpointBackfill(args);
	const stream = result.exitCode === ENDPOINT_BACKFILL_EXIT.ok ? console.log : console.error;
	stream(result.message);
	if (result.reportWritten) {
		stream("A secret-free canonical JSON report was created at --report.");
	}
	process.exitCode = result.exitCode;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	void main();
}
