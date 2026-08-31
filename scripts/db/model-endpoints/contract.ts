import { isAbsolute } from "node:path";
import type {
	EndpointBackfillDriver,
	EndpointBackfillManifest,
	EndpointBackfillReport,
} from "../../../packages/core/src/model-endpoint-backfill";
import { stableEndpointBackfillJson } from "../../../packages/core/src/model-endpoint-backfill";

export const ENDPOINT_BACKFILL_EXIT = {
	ok: 0,
	input: 2,
	schema: 3,
	blocked: 4,
	drift: 5,
	database: 6,
	/** The transaction committed, but the reserved local report needs recovery. */
	committedReportPending: 7,
} as const;

export class EndpointBackfillCliError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "EndpointBackfillCliError";
		this.exitCode = exitCode;
	}
}

export class EndpointBackfillSchemaError extends EndpointBackfillCliError {
	constructor(message: string) {
		super(message, ENDPOINT_BACKFILL_EXIT.schema);
		this.name = "EndpointBackfillSchemaError";
	}
}

export class EndpointBackfillDatabaseError extends EndpointBackfillCliError {
	constructor(message: string) {
		super(message, ENDPOINT_BACKFILL_EXIT.database);
		this.name = "EndpointBackfillDatabaseError";
	}
}

export class EndpointBackfillRevisionError extends EndpointBackfillCliError {
	constructor(message: string) {
		super(message, ENDPOINT_BACKFILL_EXIT.drift);
		this.name = "EndpointBackfillRevisionError";
	}
}

export type EndpointBackfillPlanOptions = {
	command: "plan";
	driver: EndpointBackfillDriver;
	manifestPath: string;
	reportPath: string;
	allManifest: boolean;
	endpointIds: string[];
	d1Source: "remote" | "local";
	d1PersistTo?: string;
};

export type EndpointBackfillApplyOptions = Omit<
	EndpointBackfillPlanOptions,
	"command" | "driver"
> & {
	command: "apply";
	driver: Exclude<EndpointBackfillDriver, "d1">;
	approvalPath: string;
};

const MAX_SELECTED_ENDPOINTS = 100;
const MAX_SELECTED_ROUTES = 1_000;

function optionValue(
	args: string[],
	name: string,
	required: boolean
): string | undefined {
	const prefix = `${name}=`;
	const matches = args.filter((arg) => arg.startsWith(prefix));
	if (matches.length > 1) {
		throw new EndpointBackfillCliError(
			`${name} may be supplied only once`,
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const value = matches[0]?.slice(prefix.length).trim();
	if (required && !value) {
		throw new EndpointBackfillCliError(
			`${name}=<value> is required`,
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (matches.length === 1 && !value) {
		throw new EndpointBackfillCliError(
			`${name} must not be empty`,
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	return value;
}

export function parseEndpointBackfillPlanArgs(
	rawArgs: readonly string[]
): EndpointBackfillPlanOptions {
	const args = rawArgs.filter((arg) => arg !== "--");
	if (args.some((arg) => arg === "--apply" || arg.startsWith("--apply="))) {
		throw new EndpointBackfillCliError(
			"--apply is forbidden: this command only produces a read-only plan",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (args[0] !== "plan") {
		throw new EndpointBackfillCliError(
			"The only supported command is plan",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const options = args.slice(1);
	const allowed = options.filter(
		(arg) =>
			arg === "--all-manifest" ||
			arg.startsWith("--driver=") ||
			arg.startsWith("--manifest=") ||
			arg.startsWith("--report=") ||
			arg.startsWith("--endpoint-id=") ||
			arg.startsWith("--d1-source=") ||
			arg.startsWith("--d1-persist-to=")
	);
	if (allowed.length !== options.length) {
		const unknown = options
			.filter((arg) => !allowed.includes(arg))
			.map((arg) => arg.split("=", 1)[0] || "<empty>");
		throw new EndpointBackfillCliError(
			`Unknown option(s): ${unknown.join(", ")}`,
			ENDPOINT_BACKFILL_EXIT.input
		);
	}

	const driver = optionValue(options, "--driver", true);
	if (driver !== "d1" && driver !== "postgres" && driver !== "mysql") {
		throw new EndpointBackfillCliError(
			"--driver must be d1, postgres, or mysql",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const manifestPath = optionValue(options, "--manifest", true)!;
	const reportPath = optionValue(options, "--report", true)!;
	if (!isAbsolute(manifestPath)) {
		throw new EndpointBackfillCliError(
			"--manifest must be an absolute path",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (!isAbsolute(reportPath)) {
		throw new EndpointBackfillCliError(
			"--report must be an absolute path",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (manifestPath === reportPath) {
		throw new EndpointBackfillCliError(
			"--report must not overwrite --manifest",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}

	const allManifest = options.includes("--all-manifest");
	if (options.filter((arg) => arg === "--all-manifest").length > 1) {
		throw new EndpointBackfillCliError(
			"--all-manifest may be supplied only once",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const endpointIds = options
		.filter((arg) => arg.startsWith("--endpoint-id="))
		.map((arg) => arg.slice("--endpoint-id=".length).trim());
	if (endpointIds.some((id) => id.length === 0)) {
		throw new EndpointBackfillCliError(
			"--endpoint-id must not be empty",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (new Set(endpointIds).size !== endpointIds.length) {
		throw new EndpointBackfillCliError(
			"--endpoint-id values must be unique",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (allManifest === endpointIds.length > 0) {
		throw new EndpointBackfillCliError(
			"Choose exactly one selection mode: --all-manifest or repeated --endpoint-id",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}

	const d1Source = optionValue(options, "--d1-source", false) ?? "remote";
	if (d1Source !== "remote" && d1Source !== "local") {
		throw new EndpointBackfillCliError(
			"--d1-source must be remote or local",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const d1PersistTo = optionValue(options, "--d1-persist-to", false);
	if (
		driver !== "d1" &&
		(options.some((arg) => arg.startsWith("--d1-source=")) || d1PersistTo)
	) {
		throw new EndpointBackfillCliError(
			"D1 options are valid only with --driver=d1",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}

	return {
		command: "plan",
		driver,
		manifestPath,
		reportPath,
		allManifest,
		endpointIds,
		d1Source,
		...(d1PersistTo ? { d1PersistTo } : {}),
	};
}

/** Apply deliberately requires both a mutating subcommand and an explicit flag. */
export function parseEndpointBackfillApplyArgs(
	rawArgs: readonly string[]
): EndpointBackfillApplyOptions {
	const args = rawArgs.filter((arg) => arg !== "--");
	if (args[0] !== "apply") {
		throw new EndpointBackfillCliError(
			"The apply parser requires the apply command",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const options = args.slice(1);
	if (options.filter((arg) => arg === "--apply").length !== 1) {
		throw new EndpointBackfillCliError(
			"apply requires exactly one explicit --apply flag",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (options.some((arg) => arg.startsWith("--apply="))) {
		throw new EndpointBackfillCliError(
			"--apply is a flag and does not accept a value",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const approvalPath = optionValue(options, "--approval", true)!;
	if (!isAbsolute(approvalPath)) {
		throw new EndpointBackfillCliError(
			"--approval must be an absolute path",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const planArgs = [
		"plan",
		...options.filter(
			(arg) => arg !== "--apply" && !arg.startsWith("--approval=")
		),
	];
	const plan = parseEndpointBackfillPlanArgs(planArgs);
	const driver = plan.driver;
	if (driver === "d1") {
		throw new EndpointBackfillCliError(
			"D1 apply is fail-closed: use plan until a Worker-bound D1Database.batch writer is deployed",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (approvalPath === plan.manifestPath || approvalPath === plan.reportPath) {
		throw new EndpointBackfillCliError(
			"--approval must be distinct from --manifest and --report",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	return {
		...plan,
		driver,
		command: "apply",
		approvalPath,
	};
}

export function selectEndpointBackfillManifest(
	manifest: EndpointBackfillManifest,
	options: Pick<EndpointBackfillPlanOptions, "allManifest" | "endpointIds">
): EndpointBackfillManifest {
	let endpoints = manifest.endpoints;
	if (!options.allManifest) {
		const selected = new Set(options.endpointIds);
		const available = new Set(
			manifest.endpoints.map((endpoint) => endpoint.id)
		);
		const missing = [...selected].filter((id) => !available.has(id)).sort();
		if (missing.length > 0) {
			throw new EndpointBackfillCliError(
				`Selected endpoint id(s) are absent from the manifest: ${missing.join(
					", "
				)}`,
				ENDPOINT_BACKFILL_EXIT.input
			);
		}
		endpoints = manifest.endpoints.filter((endpoint) =>
			selected.has(endpoint.id)
		);
	}
	if (endpoints.length === 0 || endpoints.length > MAX_SELECTED_ENDPOINTS) {
		throw new EndpointBackfillCliError(
			`The selected manifest must contain between 1 and ${MAX_SELECTED_ENDPOINTS} endpoints`,
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	const routeCount = endpoints.reduce(
		(total, endpoint) => total + endpoint.route_target_ids.length,
		0
	);
	if (routeCount > MAX_SELECTED_ROUTES) {
		throw new EndpointBackfillCliError(
			`The selected manifest references ${routeCount} routes; the limit is ${MAX_SELECTED_ROUTES}`,
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	return { ...manifest, endpoints };
}

export function resolveEndpointBackfillDatabaseFingerprint(
	env: Readonly<Record<string, string | undefined>>,
	manifest: EndpointBackfillManifest,
	driver: EndpointBackfillDriver
): string {
	const fingerprint =
		env.ENDPOINT_BACKFILL_DATABASE_FINGERPRINT?.trim().toLowerCase();
	if (!fingerprint || !/^sha256:[0-9a-f]{64}$/u.test(fingerprint)) {
		throw new EndpointBackfillCliError(
			"ENDPOINT_BACKFILL_DATABASE_FINGERPRINT must be sha256:<64 lowercase hex>",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (manifest.target.driver !== driver) {
		throw new EndpointBackfillCliError(
			`Manifest target driver ${manifest.target.driver} does not match --driver=${driver}`,
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	if (manifest.target.database_fingerprint !== fingerprint) {
		throw new EndpointBackfillCliError(
			"Manifest target database fingerprint does not match ENDPOINT_BACKFILL_DATABASE_FINGERPRINT",
			ENDPOINT_BACKFILL_EXIT.input
		);
	}
	return fingerprint;
}

export function serializeEndpointBackfillReport(
	report: EndpointBackfillReport | Record<string, unknown>
): string {
	return `${stableEndpointBackfillJson(report)}\n`;
}
