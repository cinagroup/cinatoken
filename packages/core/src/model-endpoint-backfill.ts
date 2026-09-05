import type {
	ModelEndpointRouteLinkRow,
	ModelEndpointRow,
} from "./db/model-endpoints-types";
import { ROUTE_QUANTIZATIONS } from "./db/route-routing-metadata";
import {
	audioEndpointReferenceEvidenceMatchesVoiceCloning,
	normalizeAudioEndpointCapabilities,
	normalizeEndpointCapabilities,
	normalizeImageEndpointCapabilities,
	normalizeTextEndpointPricing,
	type AudioEndpointCapabilities,
	type EndpointToolChoiceSupport,
	type ImageEndpointCapabilities,
	type TextEndpointPricing,
} from "./model-endpoint-catalog";
import {
	modelEndpointSupportsOperation,
	modelEndpointTagIsValidForProvider,
	parseVerifiedModelEndpointSnapshot,
	verifiedEndpointMatchesLegacyRoutingMetadata,
	type VerifiedModelEndpointSnapshot,
} from "./model-endpoint-runtime";
import { providerSupportsUpstreamOperation } from "./provider-endpoints";
import { normalizeUpstreamProtocol } from "./upstream-protocol";
import { computeRouteDataPolicySubjectFingerprintFromRows } from "./route-data-policy";
import type { ModelRouteRow, ProviderRow } from "./types";

export const ENDPOINT_BACKFILL_MANIFEST_VERSION =
	"cinatoken.endpoint-backfill-manifest.v1" as const;
export const ENDPOINT_BACKFILL_REPORT_VERSION =
	"cinatoken.endpoint-backfill-report.v1" as const;
export const ENDPOINT_BACKFILL_EXECUTION_VERSION =
	"cinatoken.endpoint-backfill-execution.v1" as const;

const MAX_ENDPOINTS = 1_000;
const MAX_LINKS_PER_ENDPOINT = 100;
const MAX_SQL_INTEGER = 2_147_483_647;
const IDENTIFIER_MAX_LENGTH = 512;
const PROVIDER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REGION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PARAMETER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RFC3339_TIMESTAMP =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const DATABASE_TIMESTAMP =
	/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)?)$/u;
const QUANTIZATIONS = new Set<string>(ROUTE_QUANTIZATIONS);

const MANIFEST_KEYS = [
	"version",
	"manifest_id",
	"created_at",
	"actor_id",
	"target",
	"policy",
	"endpoints",
] as const;
const TARGET_KEYS = ["driver", "database_fingerprint", "required_migration"] as const;
const POLICY_KEYS = [
	"allow_create",
	"allow_material_update",
	"allow_draft_promotion",
	"allow_route_link_changes",
] as const;
const ENDPOINT_KEYS = [
	"id",
	"expected_updated_at",
	"model_id",
	"provider_id",
	"provider_slug",
	"tag",
	"endpoint_class",
	"region",
	"context_length",
	"max_prompt_tokens",
	"max_completion_tokens",
	"quantization",
	"supported_parameters",
	"pricing",
	"supports_implicit_caching",
	"supports_voice_cloning",
	"supports_tool_choice",
	"image_capabilities",
	"audio_capabilities",
	"evidence",
	"route_target_ids",
] as const;
const EVIDENCE_KEYS = [
	"url",
	"observed_at",
	"expires_at",
	"sha256",
	"reviewed_by",
] as const;

export const ENDPOINT_BACKFILL_REQUIRED_MIGRATIONS = {
	d1: "0049_model_endpoint_audio_capabilities.sql",
	postgres: "0048_model_endpoint_audio_capabilities.sql",
	mysql: "0045_model_endpoint_audio_capabilities.sql",
} as const;

export type EndpointBackfillDriver = keyof typeof ENDPOINT_BACKFILL_REQUIRED_MIGRATIONS;

export type EndpointBackfillPolicy = {
	allow_create: boolean;
	allow_material_update: boolean;
	allow_draft_promotion: boolean;
	allow_route_link_changes: boolean;
};

export type EndpointBackfillEvidence = {
	url: string;
	observed_at: string;
	expires_at: string;
	sha256: string;
	reviewed_by: string;
};

export type EndpointBackfillManifestEntry = {
	id: string;
	expected_updated_at: string | null;
	model_id: string;
	provider_id: string;
	provider_slug: string;
	tag: string;
	endpoint_class: "standard" | "service_tier" | null;
	region: string | null;
	context_length: number | null;
	max_prompt_tokens: number | null;
	max_completion_tokens: number | null;
	quantization: string | null;
	supported_parameters: string[];
	pricing: TextEndpointPricing | null;
	supports_implicit_caching: boolean | null;
	supports_voice_cloning: boolean | null;
	supports_tool_choice: EndpointToolChoiceSupport;
	image_capabilities: ImageEndpointCapabilities | null;
	audio_capabilities: AudioEndpointCapabilities | null;
	evidence: EndpointBackfillEvidence;
	route_target_ids: string[];
};

export type EndpointBackfillManifest = {
	version: typeof ENDPOINT_BACKFILL_MANIFEST_VERSION;
	manifest_id: string;
	created_at: string;
	actor_id: string;
	target: {
		driver: EndpointBackfillDriver;
		database_fingerprint: string;
		required_migration: string;
	};
	policy: EndpointBackfillPolicy;
	endpoints: EndpointBackfillManifestEntry[];
};

export type EndpointBackfillConsistencyRead = {
	rows_sha256: string;
	version_vector: {
		migration_head: string;
		models: number;
		providers: number;
		routes: number;
		endpoints: number;
		links: number;
		endpoint_revisions_sha256: string;
		link_revisions_sha256: string;
	};
};

export type EndpointBackfillInventoryConsistency = {
	semantics:
		| "repository-double-read"
		| "d1-non-snapshot-double-read"
		| "serializable-transaction";
	/** True only when every read and write shares one serializable transaction. */
	snapshot_consistent: boolean;
	before: EndpointBackfillConsistencyRead;
	after: EndpointBackfillConsistencyRead;
	drifted: boolean;
};

/**
 * A deliberately narrow, secret-bearing in-memory snapshot. Callers must load
 * every referenced identity and every current link for a referenced endpoint
 * or route. It must never be serialized as the report.
 */
export type EndpointBackfillInventory = {
	source: {
		driver: EndpointBackfillDriver;
		database_fingerprint: string;
		required_migration: string;
		migration_head: string;
		migration_present: boolean;
	};
	models: Array<{ id: string }>;
	providers: ProviderRow[];
	routes: ModelRouteRow[];
	endpoints: ModelEndpointRow[];
	links: ModelEndpointRouteLinkRow[];
	/** Required by the production CLI; optional only for staged snapshot assembly. */
	consistency?: EndpointBackfillInventoryConsistency;
	/**
	 * Trusted digests from a separately authenticated verification ledger. The
	 * database loaders intentionally leave this empty until that ledger exists.
	 */
	evidence_attestations?: Array<{
		endpoint_id: string;
		desired_sha256: string;
	}>;
};

export type EndpointBackfillIssue = {
	severity: "blocker" | "warning";
	code: string;
	message: string;
	endpoint_id?: string;
	route_target_id?: string;
	details_sha256?: string;
};

export type EndpointBackfillAction = {
	type:
		| "create_endpoint_draft"
		| "update_endpoint_draft"
		| "link_route"
		| "unlink_route"
		| "publish_verification";
	endpoint_id: string;
	route_target_id?: string;
	expected_updated_at?: string | null;
	subject_fingerprint?: string;
};

export type EndpointBackfillEndpointPlan = {
	endpoint_id: string;
	before_sha256: string | null;
	desired_sha256: string;
	verification_state_sha256: string;
	disposition:
		| "blocked"
		| "create_and_verify"
		| "update_and_reverify"
		| "promote_draft"
		| "reverify"
		| "noop";
	issues: EndpointBackfillIssue[];
	actions: EndpointBackfillAction[];
	route_subjects: Array<{
		route_target_id: string;
		current_fingerprint: string | null;
		proposed_fingerprint: string;
		state: "new" | "current" | "stale";
	}>;
};

export type EndpointBackfillReport = {
	version: typeof ENDPOINT_BACKFILL_REPORT_VERSION;
	mode: "dry-run";
	apply_supported: false;
	authorization_verified: false;
	legacy_evidence_used: false;
	generated_at: string;
	manifest_id: string;
	/** Digest of the complete manifest before any CLI selection is applied. */
	manifest_sha256: string;
	/** Digest of the selected manifest actually evaluated by this report. */
	selected_manifest_sha256: string;
	/** Digest of the deterministic selected Endpoint id list. */
	selection_sha256: string;
	/**
	 * Stable authorization target. Unlike plan_sha256, this excludes generated_at
	 * and binds only the database safety preconditions and executable endpoint plan.
	 */
	execution_sha256: string;
	plan_sha256: string;
	source: EndpointBackfillInventory["source"];
	database_fingerprint_source: "operator_asserted_environment";
	database_identity_verified: false;
	inventory_consistency: EndpointBackfillInventoryConsistency;
	/** Validation means the proposed facts are internally safe, not authorized. */
	validation_passed: boolean;
	/** Always false until an authenticated, transactional apply path exists. */
	ready_to_apply: false;
	summary: {
		endpoints: number;
		blocked: number;
		changes: number;
		noops: number;
		warnings: number;
		actions: number;
	};
	issues: EndpointBackfillIssue[];
	endpoints: EndpointBackfillEndpointPlan[];
};

export type EndpointBackfillExecution = {
	version: typeof ENDPOINT_BACKFILL_EXECUTION_VERSION;
	source: EndpointBackfillInventory["source"];
	/**
	 * Method-independent authoritative inventory read. Dry-run double-read and
	 * serializable apply produce the same value for the same final inventory.
	 */
	inventory_read: EndpointBackfillConsistencyRead;
	validation_passed: boolean;
	endpoints: Array<
		Pick<
			EndpointBackfillEndpointPlan,
			| "endpoint_id"
			| "before_sha256"
			| "desired_sha256"
			| "verification_state_sha256"
			| "disposition"
			| "actions"
			| "route_subjects"
		>
	>;
};

export type EndpointBackfillPlanProvenance = {
	/** Canonical digest captured before the CLI narrows endpoint selection. */
	full_manifest_sha256: string;
};

export class EndpointBackfillManifestError extends TypeError {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`Endpoint backfill manifest is invalid: ${issues.join("; ")}`);
		this.name = "EndpointBackfillManifestError";
		this.issues = issues;
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string
): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) {
			throw new TypeError(`${label} contains unsupported key: ${key}`);
		}
	}
	for (const key of allowed) {
		if (!(key in value)) throw new TypeError(`${label}.${key} is required`);
	}
}

function requiredString(
	value: unknown,
	label: string,
	maxLength = IDENTIFIER_MAX_LENGTH
): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > maxLength ||
		/[\u0000-\u001f\u007f]/u.test(normalized)
	) {
		throw new TypeError(`${label} is invalid`);
	}
	return normalized;
}

function nullableString(
	value: unknown,
	label: string,
	maxLength: number
): string | null {
	if (value === null) return null;
	return requiredString(value, label, maxLength);
}

function timestampFieldsAreValid(raw: string): boolean {
	const match =
		/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?/u.exec(
			raw
		);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (
		year < 1 ||
		month < 1 ||
		month > 12 ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return false;
	}
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function isoTimestamp(value: unknown, label: string): string {
	const raw = requiredString(value, label, 64);
	if (!RFC3339_TIMESTAMP.test(raw) || !timestampFieldsAreValid(raw)) {
		throw new TypeError(`${label} must be an RFC 3339 timestamp`);
	}
	const epoch = Date.parse(raw);
	if (!Number.isFinite(epoch)) {
		throw new TypeError(`${label} must be an RFC 3339 timestamp`);
	}
	return new Date(epoch).toISOString();
}

function expectedTimestamp(value: unknown, label: string): string | null {
	if (value === null) return null;
	const raw = requiredString(value, label, 128);
	if (
		!DATABASE_TIMESTAMP.test(raw) ||
		!timestampFieldsAreValid(raw) ||
		!Number.isFinite(Date.parse(raw))
	) {
		throw new TypeError(`${label} must be null or a database timestamp`);
	}
	return raw;
}

function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
	if (value === null) return null;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		value > MAX_SQL_INTEGER
	) {
		throw new TypeError(
			`${label} must be null or a positive integer no greater than ${MAX_SQL_INTEGER}`
		);
	}
	return value;
}

function evidenceBoolean(value: unknown, label: string): boolean | null {
	if (value !== null && typeof value !== "boolean") {
		throw new TypeError(`${label} must be true, false, or null`);
	}
	return value as boolean | null;
}

function nullableJsonFact<T>(
	value: unknown,
	label: string,
	normalize: (input: unknown) => T
): T | null {
	if (value === null) return null;
	try {
		return normalize(value);
	} catch (error) {
		throw new TypeError(
			`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

function parseStringArray(
	value: unknown,
	label: string,
	maxLength: number,
	itemPattern?: RegExp
): string[] {
	if (!Array.isArray(value) || value.length > maxLength) {
		throw new TypeError(`${label} must be an array of at most ${maxLength} strings`);
	}
	const output: string[] = [];
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		const normalized = requiredString(item, `${label}[${index}]`);
		if (itemPattern && !itemPattern.test(normalized)) {
			throw new TypeError(`${label}[${index}] has an invalid format`);
		}
		const identity = normalized.toLowerCase();
		if (seen.has(identity)) {
			throw new TypeError(`${label} contains a duplicate: ${normalized}`);
		}
		seen.add(identity);
		output.push(normalized);
	}
	return output;
}

function parseEvidence(value: unknown, label: string): EndpointBackfillEvidence {
	const input = record(value, label);
	assertKeys(input, EVIDENCE_KEYS, label);
	const rawUrl = requiredString(input.url, `${label}.url`, 2048);
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new TypeError(`${label}.url must be an absolute HTTPS URL`);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new TypeError(
			`${label}.url must be public HTTPS without credentials, query parameters, or fragments`
		);
	}
	const digest = requiredString(input.sha256, `${label}.sha256`, 64).toLowerCase();
	if (!SHA256.test(digest)) {
		throw new TypeError(`${label}.sha256 must be a lowercase SHA-256 digest`);
	}
	return {
		url: url.toString(),
		observed_at: isoTimestamp(input.observed_at, `${label}.observed_at`),
		expires_at: isoTimestamp(input.expires_at, `${label}.expires_at`),
		sha256: digest,
		reviewed_by: requiredString(
			input.reviewed_by,
			`${label}.reviewed_by`,
			191
		),
	};
}

function parseEndpoint(
	value: unknown,
	index: number
): EndpointBackfillManifestEntry {
	const label = `endpoints[${index}]`;
	const input = record(value, label);
	assertKeys(input, ENDPOINT_KEYS, label);
	const providerSlug = requiredString(
		input.provider_slug,
		`${label}.provider_slug`,
		128
	).toLowerCase();
	if (!PROVIDER_SLUG.test(providerSlug)) {
		throw new TypeError(`${label}.provider_slug is invalid`);
	}
	const tag = requiredString(input.tag, `${label}.tag`, 120).toLowerCase();
	if (!modelEndpointTagIsValidForProvider(tag, providerSlug)) {
		throw new TypeError(`${label}.tag is invalid for provider_slug`);
	}
	const rawEndpointClass = input.endpoint_class;
	if (
		rawEndpointClass !== null &&
		rawEndpointClass !== "standard" &&
		rawEndpointClass !== "service_tier"
	) {
		throw new TypeError(
			`${label}.endpoint_class must be standard, service_tier, or null`
		);
	}
	const endpointClass =
		rawEndpointClass as EndpointBackfillManifestEntry["endpoint_class"];
	if (endpointClass === "service_tier" && !tag.includes("/")) {
		throw new TypeError(`${label}.service_tier requires a slash-qualified tag`);
	}
	if (tag.includes("/") && endpointClass === null) {
		throw new TypeError(`${label}.slash-qualified tag requires endpoint_class`);
	}
	const region = nullableString(input.region, `${label}.region`, 64)?.toLowerCase() ?? null;
	if (region && !REGION.test(region)) throw new TypeError(`${label}.region is invalid`);
	const quantization =
		nullableString(input.quantization, `${label}.quantization`, 32)?.toLowerCase() ??
		null;
	if (quantization && !QUANTIZATIONS.has(quantization)) {
		throw new TypeError(`${label}.quantization is invalid`);
	}
	const supportsImplicitCaching = evidenceBoolean(
		input.supports_implicit_caching,
		`${label}.supports_implicit_caching`
	);
	const supportsVoiceCloning = evidenceBoolean(
		input.supports_voice_cloning,
		`${label}.supports_voice_cloning`
	);
	let supportsToolChoice: EndpointToolChoiceSupport;
	try {
		supportsToolChoice = normalizeEndpointCapabilities({
			implicit_caching: supportsImplicitCaching,
			voice_cloning: supportsVoiceCloning,
			tool_choice: input.supports_tool_choice,
		}).tool_choice;
	} catch (error) {
		throw new TypeError(
			`${label}.supports_tool_choice is invalid: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}
	const imageCapabilities = nullableJsonFact(
		input.image_capabilities,
		`${label}.image_capabilities`,
		normalizeImageEndpointCapabilities
	);
	if (imageCapabilities && imageCapabilities.provider_slug !== providerSlug) {
		throw new TypeError(
			`${label}.image_capabilities.provider_slug must match provider_slug`
		);
	}
	const audioCapabilities = nullableJsonFact(
		input.audio_capabilities,
		`${label}.audio_capabilities`,
		normalizeAudioEndpointCapabilities
	);
	if (
		audioCapabilities &&
		!audioEndpointReferenceEvidenceMatchesVoiceCloning(
			audioCapabilities,
			supportsVoiceCloning
		)
	) {
		throw new TypeError(
			`${label}.audio_capabilities reference-audio evidence requires supports_voice_cloning=true`
		);
	}
	const routeTargetIds = parseStringArray(
		input.route_target_ids,
		`${label}.route_target_ids`,
		MAX_LINKS_PER_ENDPOINT
	).sort(compareCodePoints);
	if (routeTargetIds.length === 0) {
		throw new TypeError(`${label}.route_target_ids must not be empty`);
	}

	return {
		id: requiredString(input.id, `${label}.id`, 191),
		expected_updated_at: expectedTimestamp(
			input.expected_updated_at,
			`${label}.expected_updated_at`
		),
		model_id: requiredString(input.model_id, `${label}.model_id`),
		provider_id: requiredString(input.provider_id, `${label}.provider_id`),
		provider_slug: providerSlug,
		tag,
		endpoint_class: endpointClass,
		region,
		context_length: nullablePositiveInteger(
			input.context_length,
			`${label}.context_length`
		),
		max_prompt_tokens: nullablePositiveInteger(
			input.max_prompt_tokens,
			`${label}.max_prompt_tokens`
		),
		max_completion_tokens: nullablePositiveInteger(
			input.max_completion_tokens,
			`${label}.max_completion_tokens`
		),
		quantization,
		supported_parameters: parseStringArray(
			input.supported_parameters,
			`${label}.supported_parameters`,
			128,
			PARAMETER
		).sort(compareCodePoints),
		pricing: nullableJsonFact(
			input.pricing,
			`${label}.pricing`,
			normalizeTextEndpointPricing
		),
		supports_implicit_caching: supportsImplicitCaching,
		supports_voice_cloning: supportsVoiceCloning,
		supports_tool_choice: supportsToolChoice,
		image_capabilities: imageCapabilities,
		audio_capabilities: audioCapabilities,
		evidence: parseEvidence(input.evidence, `${label}.evidence`),
		route_target_ids: routeTargetIds,
	};
}

export function parseEndpointBackfillManifest(
	value: unknown
): EndpointBackfillManifest {
	const issues: string[] = [];
	let parsed: EndpointBackfillManifest | null = null;
	try {
		const input = record(value, "manifest");
		assertKeys(input, MANIFEST_KEYS, "manifest");
		if (input.version !== ENDPOINT_BACKFILL_MANIFEST_VERSION) {
			throw new TypeError(
				`manifest.version must be ${ENDPOINT_BACKFILL_MANIFEST_VERSION}`
			);
		}
		const policyInput = record(input.policy, "manifest.policy");
		assertKeys(policyInput, POLICY_KEYS, "manifest.policy");
		const targetInput = record(input.target, "manifest.target");
		assertKeys(targetInput, TARGET_KEYS, "manifest.target");
		const driver = requiredString(
			targetInput.driver,
			"manifest.target.driver",
			16
		) as EndpointBackfillDriver;
		if (!(driver in ENDPOINT_BACKFILL_REQUIRED_MIGRATIONS)) {
			throw new TypeError(
				"manifest.target.driver must be d1, postgres, or mysql"
			);
		}
		const databaseFingerprint = requiredString(
			targetInput.database_fingerprint,
			"manifest.target.database_fingerprint",
			71
		).toLowerCase();
		if (!/^sha256:[0-9a-f]{64}$/u.test(databaseFingerprint)) {
			throw new TypeError(
				"manifest.target.database_fingerprint must be sha256:<64 lowercase hex>"
			);
		}
		const requiredMigration = requiredString(
			targetInput.required_migration,
			"manifest.target.required_migration",
			128
		);
		if (requiredMigration !== ENDPOINT_BACKFILL_REQUIRED_MIGRATIONS[driver]) {
			throw new TypeError(
				`manifest.target.required_migration must be ${ENDPOINT_BACKFILL_REQUIRED_MIGRATIONS[driver]} for ${driver}`
			);
		}
		const policy = Object.fromEntries(
			POLICY_KEYS.map((key) => {
				if (typeof policyInput[key] !== "boolean") {
					throw new TypeError(`manifest.policy.${key} must be boolean`);
				}
				return [key, policyInput[key]];
			})
		) as EndpointBackfillPolicy;
		if (
			!Array.isArray(input.endpoints) ||
			input.endpoints.length === 0 ||
			input.endpoints.length > MAX_ENDPOINTS
		) {
			throw new TypeError(
				`manifest.endpoints must contain between 1 and ${MAX_ENDPOINTS} entries`
			);
		}
		const endpoints = input.endpoints.map((entry, index) =>
			parseEndpoint(entry, index)
		);
		parsed = {
			version: ENDPOINT_BACKFILL_MANIFEST_VERSION,
			manifest_id: requiredString(input.manifest_id, "manifest.manifest_id", 191),
			created_at: isoTimestamp(input.created_at, "manifest.created_at"),
			actor_id: requiredString(input.actor_id, "manifest.actor_id", 191),
			target: {
				driver,
				database_fingerprint: databaseFingerprint,
				required_migration: requiredMigration,
			},
			policy,
			endpoints: endpoints.sort((left, right) =>
				compareCodePoints(left.id, right.id)
			),
		};
	} catch (error) {
		issues.push(error instanceof Error ? error.message : String(error));
	}
	if (!parsed) throw new EndpointBackfillManifestError(issues);

	const endpointIds = new Set<string>();
	const identities = new Set<string>();
	const routeIds = new Set<string>();
	for (const endpoint of parsed.endpoints) {
		if (endpointIds.has(endpoint.id)) issues.push(`duplicate endpoint id: ${endpoint.id}`);
		endpointIds.add(endpoint.id);
		const identity = `${endpoint.model_id}\u0000${endpoint.provider_id}\u0000${endpoint.tag}`;
		if (identities.has(identity)) {
			issues.push(
				`duplicate endpoint identity: ${endpoint.model_id}/${endpoint.provider_id}/${endpoint.tag}`
			);
		}
		identities.add(identity);
		for (const routeId of endpoint.route_target_ids) {
			if (routeIds.has(routeId)) {
				issues.push(`route target appears in multiple endpoints: ${routeId}`);
			}
			routeIds.add(routeId);
		}
	}
	if (issues.length > 0) throw new EndpointBackfillManifestError(issues);
	return parsed;
}

function canonicalize(value: unknown): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("cannot hash a non-finite number");
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object") {
		const output: Record<string, unknown> = Object.create(null) as Record<
			string,
			unknown
		>;
		for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodePoints)) {
			const child = (value as Record<string, unknown>)[key];
			if (child !== undefined) output[key] = canonicalize(child);
		}
		return output;
	}
	throw new TypeError(`cannot hash ${typeof value}`);
}

export function stableEndpointBackfillJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

async function sha256(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(stableEndpointBackfillJson(value))
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Canonical digest helper used by the CLI to bind pre-selection provenance. */
export function sha256EndpointBackfillValue(value: unknown): Promise<string> {
	return sha256(value);
}

export function sha256EndpointBackfillExecution(
	input: {
		source: EndpointBackfillInventory["source"];
		inventory_read: EndpointBackfillConsistencyRead;
		validation_passed: boolean;
		endpoints: EndpointBackfillEndpointPlan[];
	}
): Promise<string> {
	return sha256({
		version: ENDPOINT_BACKFILL_EXECUTION_VERSION,
		source: input.source,
		inventory_read: input.inventory_read,
		validation_passed: input.validation_passed,
		endpoints: input.endpoints.map((endpoint) => ({
			endpoint_id: endpoint.endpoint_id,
			before_sha256: endpoint.before_sha256,
			desired_sha256: endpoint.desired_sha256,
			verification_state_sha256: endpoint.verification_state_sha256,
			disposition: endpoint.disposition,
			actions: endpoint.actions,
			route_subjects: endpoint.route_subjects,
		})),
	});
}

export function buildEndpointBackfillDesiredRow(
	endpoint: EndpointBackfillManifestEntry,
	actorId: string,
	now: Date
): ModelEndpointRow {
	const nowIso = now.toISOString();
	return {
		id: endpoint.id,
		model_id: endpoint.model_id,
		provider_id: endpoint.provider_id,
		provider_slug: endpoint.provider_slug,
		tag: endpoint.tag,
		endpoint_class: endpoint.endpoint_class,
		region: endpoint.region,
		context_length: endpoint.context_length,
		max_prompt_tokens: endpoint.max_prompt_tokens,
		max_completion_tokens: endpoint.max_completion_tokens,
		quantization: endpoint.quantization,
		supported_parameters: stableEndpointBackfillJson(endpoint.supported_parameters),
		pricing: stableEndpointBackfillJson(endpoint.pricing ?? {}),
		supports_implicit_caching: endpoint.supports_implicit_caching,
		supports_voice_cloning: endpoint.supports_voice_cloning,
		supports_tool_choice: stableEndpointBackfillJson(endpoint.supports_tool_choice),
		image_capabilities: stableEndpointBackfillJson(endpoint.image_capabilities ?? {}),
		audio_capabilities: stableEndpointBackfillJson(endpoint.audio_capabilities ?? {}),
		evidence_url: endpoint.evidence.url,
		verified_by: actorId,
		verified_at: nowIso,
		expires_at: endpoint.evidence.expires_at,
		status: "verified",
		created_at: nowIso,
		updated_at: nowIso,
	};
}

const MATERIAL_FIELDS = [
	"model_id",
	"provider_id",
	"provider_slug",
	"tag",
	"endpoint_class",
	"region",
	"context_length",
	"max_prompt_tokens",
	"max_completion_tokens",
	"quantization",
	"supported_parameters",
	"pricing",
	"supports_implicit_caching",
	"supports_voice_cloning",
	"supports_tool_choice",
	"image_capabilities",
	"audio_capabilities",
	"evidence_url",
	"expires_at",
] as const satisfies readonly (keyof ModelEndpointRow)[];

const JSON_FIELDS = new Set<keyof ModelEndpointRow>([
	"supported_parameters",
	"pricing",
	"supports_tool_choice",
	"image_capabilities",
	"audio_capabilities",
]);

const BOOLEAN_FIELDS = new Set<keyof ModelEndpointRow>([
	"supports_implicit_caching",
	"supports_voice_cloning",
]);

function comparableField(row: ModelEndpointRow, field: keyof ModelEndpointRow): unknown {
	const value = row[field];
	if (BOOLEAN_FIELDS.has(field)) return value == null ? null : Boolean(value);
	if (field === "expires_at") {
		const raw = value == null ? "" : String(value);
		const epoch =
			DATABASE_TIMESTAMP.test(raw) && timestampFieldsAreValid(raw)
				? Date.parse(raw)
				: Number.NaN;
		return Number.isFinite(epoch) ? new Date(epoch).toISOString() : value ?? null;
	}
	if (field === "evidence_url" && typeof value === "string") {
		try {
			return new URL(value).toString();
		} catch {
			return value;
		}
	}
	if (!JSON_FIELDS.has(field)) return value ?? null;
	try {
		const parsed = JSON.parse(String(value ?? "{}")) as unknown;
		if (field === "supported_parameters") {
			if (!Array.isArray(parsed)) throw new TypeError("not an array");
			return [...parsed].sort((left, right) =>
				compareCodePoints(String(left), String(right))
			);
		}
		if (field === "pricing") {
			return typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed) &&
				Object.keys(parsed).length === 0
				? null
				: normalizeTextEndpointPricing(parsed);
		}
		if (field === "supports_tool_choice") {
			return normalizeEndpointCapabilities({
				implicit_caching: false,
				voice_cloning: false,
				tool_choice: parsed,
			}).tool_choice;
		}
		if (field === "image_capabilities") {
			return typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed) &&
				Object.keys(parsed).length === 0
				? null
				: normalizeImageEndpointCapabilities(parsed);
		}
		if (field === "audio_capabilities") {
			return typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed) &&
				Object.keys(parsed).length === 0
				? null
				: normalizeAudioEndpointCapabilities(parsed);
		}
		return canonicalize(parsed);
	} catch {
		return { invalid_json: true, raw: String(value ?? "") };
	}
}

function materialMatches(current: ModelEndpointRow, desired: ModelEndpointRow): boolean {
	return MATERIAL_FIELDS.every(
		(field) =>
			stableEndpointBackfillJson(comparableField(current, field)) ===
			stableEndpointBackfillJson(comparableField(desired, field))
	);
}

function issueSort(left: EndpointBackfillIssue, right: EndpointBackfillIssue): number {
	return (
		compareCodePoints(left.severity, right.severity) ||
		compareCodePoints(left.code, right.code) ||
		compareCodePoints(left.endpoint_id ?? "", right.endpoint_id ?? "") ||
		compareCodePoints(left.route_target_id ?? "", right.route_target_id ?? "") ||
		compareCodePoints(left.message, right.message)
	);
}

function actionSort(left: EndpointBackfillAction, right: EndpointBackfillAction): number {
	const order: Record<EndpointBackfillAction["type"], number> = {
		create_endpoint_draft: 0,
		update_endpoint_draft: 1,
		unlink_route: 2,
		link_route: 3,
		publish_verification: 4,
	};
	return (
		order[left.type] - order[right.type] ||
		compareCodePoints(left.route_target_id ?? "", right.route_target_id ?? "")
	);
}

function pushIssue(
	target: EndpointBackfillIssue[],
	issue: EndpointBackfillIssue
): void {
	if (
		!target.some(
			(existing) =>
				existing.severity === issue.severity &&
				existing.code === issue.code &&
				existing.endpoint_id === issue.endpoint_id &&
				existing.route_target_id === issue.route_target_id &&
				existing.message === issue.message
		)
	) {
		target.push(issue);
	}
}

function mapUnique<T extends { id: string }>(
	rows: T[],
	label: string,
	issues: EndpointBackfillIssue[]
): Map<string, T> {
	const result = new Map<string, T>();
	for (const row of rows) {
		if (result.has(row.id)) {
			pushIssue(issues, {
				severity: "blocker",
				code: `duplicate_inventory_${label}`,
				message: `Inventory contains duplicate ${label} id ${row.id}`,
			});
		}
		result.set(row.id, row);
	}
	return result;
}

function consistencyDigest(value: unknown, label: string): string {
	const digest = requiredString(value, label, 71).toLowerCase();
	if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
		throw new TypeError(`${label} must be sha256:<64 lowercase hex>`);
	}
	return digest;
}

function consistencyCount(value: unknown, label: string): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > 1_000_000
	) {
		throw new TypeError(`${label} must be a bounded non-negative integer`);
	}
	return value;
}

function projectConsistencyRead(
	value: unknown,
	label: string
): EndpointBackfillConsistencyRead {
	const input = record(value, label);
	const vector = record(input.version_vector, `${label}.version_vector`);
	return {
		rows_sha256: consistencyDigest(input.rows_sha256, `${label}.rows_sha256`),
		version_vector: {
			migration_head: requiredString(
				vector.migration_head,
				`${label}.version_vector.migration_head`,
				128
			),
			models: consistencyCount(vector.models, `${label}.version_vector.models`),
			providers: consistencyCount(
				vector.providers,
				`${label}.version_vector.providers`
			),
			routes: consistencyCount(vector.routes, `${label}.version_vector.routes`),
			endpoints: consistencyCount(
				vector.endpoints,
				`${label}.version_vector.endpoints`
			),
			links: consistencyCount(vector.links, `${label}.version_vector.links`),
			endpoint_revisions_sha256: consistencyDigest(
				vector.endpoint_revisions_sha256,
				`${label}.version_vector.endpoint_revisions_sha256`
			),
			link_revisions_sha256: consistencyDigest(
				vector.link_revisions_sha256,
				`${label}.version_vector.link_revisions_sha256`
			),
		},
	};
}

function projectInventoryConsistency(
	value: unknown
): EndpointBackfillInventoryConsistency {
	const input = record(value, "inventory.consistency");
	if (
		input.semantics !== "repository-double-read" &&
		input.semantics !== "d1-non-snapshot-double-read" &&
		input.semantics !== "serializable-transaction"
	) {
		throw new TypeError("inventory.consistency.semantics is invalid");
	}
	const expectedSnapshotConsistency =
		input.semantics === "serializable-transaction";
	if (
		input.snapshot_consistent !== expectedSnapshotConsistency ||
		typeof input.drifted !== "boolean"
	) {
		throw new TypeError("inventory.consistency flags are invalid");
	}
	return {
		semantics: input.semantics,
		snapshot_consistent: expectedSnapshotConsistency,
		before: projectConsistencyRead(input.before, "inventory.consistency.before"),
		after: projectConsistencyRead(input.after, "inventory.consistency.after"),
		drifted: input.drifted,
	};
}

function identityKey(row: {
	model_id: string;
	provider_id: string;
	tag: string;
}): string {
	return `${row.model_id}\u0000${row.provider_id}\u0000${row.tag}`;
}

function fingerprintState(
	current: string | null,
	proposed: string,
	linked: boolean
): "new" | "current" | "stale" {
	return !linked ? "new" : current === proposed ? "current" : "stale";
}

function endpointBlocker(
	code: string,
	message: string,
	endpointId: string,
	routeTargetId?: string
): EndpointBackfillIssue {
	return {
		severity: "blocker",
		code,
		message,
		endpoint_id: endpointId,
		...(routeTargetId ? { route_target_id: routeTargetId } : {}),
	};
}

async function planEndpoint(
	manifest: EndpointBackfillManifest,
	entry: EndpointBackfillManifestEntry,
	context: {
		now: Date;
		models: Map<string, { id: string }>;
		providers: Map<string, ProviderRow>;
		routes: Map<string, ModelRouteRow>;
		endpoints: Map<string, ModelEndpointRow>;
		identityOwners: Map<string, ModelEndpointRow>;
		linksByEndpoint: Map<string, ModelEndpointRouteLinkRow[]>;
		linksByRoute: Map<string, ModelEndpointRouteLinkRow>;
		evidenceAttestations: Map<string, string>;
	}
): Promise<EndpointBackfillEndpointPlan> {
	const issues: EndpointBackfillIssue[] = [];
	const actions: EndpointBackfillAction[] = [];
	const routeSubjects: EndpointBackfillEndpointPlan["route_subjects"] = [];
	const existing = context.endpoints.get(entry.id) ?? null;
	const desired = buildEndpointBackfillDesiredRow(entry, manifest.actor_id, context.now);
	const snapshot = parseVerifiedModelEndpointSnapshot(desired, context.now);
	const beforeSha256 = existing
		? await sha256({
				material: Object.fromEntries(
					MATERIAL_FIELDS.map((field) => [
						field,
						comparableField(existing, field),
					])
				),
				status: existing.status,
				verified_by: existing.verified_by,
				verified_at: existing.verified_at,
				updated_at: existing.updated_at,
			})
		: null;
	const desiredSha256 = await sha256({
		actor_id: manifest.actor_id,
		endpoint: entry,
	});
	const attestedDesiredSha256 = context.evidenceAttestations.get(entry.id) ?? null;

	const manifestCreatedAt = Date.parse(manifest.created_at);
	if (manifestCreatedAt > context.now.getTime()) {
		pushIssue(
			issues,
			endpointBlocker(
				"manifest_created_in_future",
				"Manifest created_at is in the future",
				entry.id
			)
		);
	}
	const observedAt = Date.parse(entry.evidence.observed_at);
	const expiresAt = Date.parse(entry.evidence.expires_at);
	if (observedAt > context.now.getTime()) {
		pushIssue(
			issues,
			endpointBlocker(
				"evidence_observed_in_future",
				"Endpoint evidence observed_at is in the future",
				entry.id
			)
		);
	}
	if (observedAt > manifestCreatedAt) {
		pushIssue(
			issues,
			endpointBlocker(
				"evidence_observed_after_manifest_creation",
				"Endpoint evidence observed_at must not be later than manifest created_at",
				entry.id
			)
		);
	}
	if (expiresAt <= context.now.getTime() || expiresAt <= observedAt) {
		pushIssue(
			issues,
			endpointBlocker(
				"evidence_not_current",
				"Endpoint evidence must expire after both observed_at and the dry-run time",
				entry.id
			)
		);
	}
	if (!snapshot) {
		pushIssue(
			issues,
			endpointBlocker(
				"endpoint_facts_invalid_or_incomplete",
				"Endpoint facts do not satisfy the verified runtime contract",
				entry.id
			)
		);
	}

	if (!context.models.has(entry.model_id)) {
		pushIssue(
			issues,
			endpointBlocker(
				"model_not_found",
				`Model ${entry.model_id} was not found`,
				entry.id
			)
		);
	}
	const provider = context.providers.get(entry.provider_id) ?? null;
	if (!provider) {
		pushIssue(
			issues,
			endpointBlocker(
				"provider_not_found",
				`Provider ${entry.provider_id} was not found`,
				entry.id
			)
		);
	} else {
		if (provider.status !== "active") {
			pushIssue(
				issues,
				endpointBlocker(
					"provider_not_active",
					"Verified endpoints require an active provider",
					entry.id
				)
			);
		}
		if (provider.shared_channel_type?.trim()) {
			pushIssue(
				issues,
				endpointBlocker(
					"shared_channel_not_credential_scoped",
					"Shared-channel providers require credential-scoped evidence and are not eligible for this manifest",
					entry.id
				)
			);
		}
		if (!provider.api_key?.trim()) {
			pushIssue(
				issues,
				endpointBlocker(
					"provider_credential_missing",
					"Verified endpoints require a provider credential",
					entry.id
				)
			);
		}
	}

	const identityOwner = context.identityOwners.get(identityKey(entry));
	if (identityOwner && identityOwner.id !== entry.id) {
		pushIssue(
			issues,
			endpointBlocker(
				"endpoint_identity_owned_by_another_id",
				`Endpoint identity already belongs to ${identityOwner.id}`,
				entry.id
			)
		);
	}
	if (entry.expected_updated_at === null) {
		if (existing) {
			pushIssue(
				issues,
				endpointBlocker(
					"expected_endpoint_absent",
					"Manifest expected a new endpoint but the id already exists",
					entry.id
				)
			);
		}
	} else if (!existing) {
		pushIssue(
			issues,
			endpointBlocker(
				"expected_endpoint_missing",
				"Manifest expected an existing endpoint but it was not found",
				entry.id
			)
		);
	} else if (existing.updated_at !== entry.expected_updated_at) {
		pushIssue(
			issues,
			endpointBlocker(
				"endpoint_revision_conflict",
				"Endpoint updated_at no longer matches the frozen manifest",
				entry.id
			)
		);
	}

	let materialChanged = false;
	if (!existing) {
		if (!manifest.policy.allow_create) {
			pushIssue(
				issues,
				endpointBlocker(
					"create_not_permitted_by_manifest",
					"Manifest policy does not permit endpoint creation",
					entry.id
				)
			);
		}
	} else {
		if (
			existing.model_id !== entry.model_id ||
			existing.provider_id !== entry.provider_id ||
			existing.tag !== entry.tag
		) {
			pushIssue(
				issues,
				endpointBlocker(
					"immutable_endpoint_identity_mismatch",
					"Existing endpoint id has a different immutable identity",
					entry.id
				)
			);
		}
		if (existing.status === "disabled") {
			pushIssue(
				issues,
				endpointBlocker(
					"disabled_endpoint_requires_manual_enable",
					"Disabled endpoints are never implicitly re-enabled",
					entry.id
				)
			);
		}
		if (
			existing.status === "draft" &&
			!manifest.policy.allow_draft_promotion
		) {
			pushIssue(
				issues,
				endpointBlocker(
					"draft_promotion_not_permitted_by_manifest",
					"Manifest policy does not permit promoting existing drafts",
					entry.id
				)
			);
		}
		materialChanged = !materialMatches(existing, desired);
		if (materialChanged && !manifest.policy.allow_material_update) {
			pushIssue(
				issues,
				endpointBlocker(
					"material_update_not_permitted_by_manifest",
					"Manifest policy does not permit changing endpoint facts",
					entry.id
				)
			);
		}
	}

	const desiredRouteIds = new Set(entry.route_target_ids);
	const currentLinks = context.linksByEndpoint.get(entry.id) ?? [];
	const currentRouteIds = new Set(
		currentLinks.map((link) => link.route_target_id)
	);
	const addedLinks = entry.route_target_ids.filter(
		(routeId) => !currentRouteIds.has(routeId)
	);
	const removedLinks = currentLinks
		.map((link) => link.route_target_id)
		.filter((routeId) => !desiredRouteIds.has(routeId))
			.sort(compareCodePoints);
	if (
		(addedLinks.length > 0 || removedLinks.length > 0) &&
		existing &&
		!manifest.policy.allow_route_link_changes
	) {
		pushIssue(
			issues,
			endpointBlocker(
				"route_link_changes_not_permitted_by_manifest",
				"Manifest policy does not permit changing existing route links",
				entry.id
			)
		);
	}

	for (const routeId of entry.route_target_ids) {
		const route = context.routes.get(routeId) ?? null;
		const owner = context.linksByRoute.get(routeId);
		if (owner && owner.endpoint_id !== entry.id) {
			pushIssue(
				issues,
				endpointBlocker(
					"route_link_owned_by_another_endpoint",
					`Route is already linked to endpoint ${owner.endpoint_id}`,
					entry.id,
					routeId
				)
			);
		}
		if (!route) {
			pushIssue(
				issues,
				endpointBlocker(
					"route_not_found",
					`Route ${routeId} was not found`,
					entry.id,
					routeId
				)
			);
			continue;
		}
		if (route.status !== "active") {
			pushIssue(
				issues,
				endpointBlocker(
					"route_not_active",
					"Linked route must be active",
					entry.id,
					routeId
				)
			);
		}
		if (
			route.model_id !== entry.model_id ||
			route.provider_id !== entry.provider_id
		) {
			pushIssue(
				issues,
				endpointBlocker(
					"route_identity_mismatch",
					"Linked route model/provider does not match the endpoint",
					entry.id,
					routeId
				)
			);
		}
		let protocol: ReturnType<typeof normalizeUpstreamProtocol> | null = null;
		try {
			protocol = normalizeUpstreamProtocol(route.upstream_protocol);
		} catch {
			pushIssue(
				issues,
				endpointBlocker(
					"route_protocol_invalid",
					"Linked route has an invalid upstream protocol",
					entry.id,
					routeId
				)
			);
		}
		if (
			provider &&
			protocol &&
			!providerSupportsUpstreamOperation(
				protocol,
				route.upstream_operation?.trim() || "*",
				provider
			)
		) {
			pushIssue(
				issues,
				endpointBlocker(
					"provider_operation_not_callable",
					`Provider has no callable endpoint for ${protocol}/${
						route.upstream_operation?.trim() || "*"
					}`,
					entry.id,
					routeId
				)
			);
		}
		if (
			snapshot &&
			!modelEndpointSupportsOperation(snapshot, route.upstream_operation)
		) {
			pushIssue(
				issues,
				endpointBlocker(
					"route_operation_not_supported",
					`Endpoint facts do not support operation ${
						route.upstream_operation?.trim() || "*"
					}`,
					entry.id,
					routeId
				)
			);
		}
		if (
			snapshot &&
			!verifiedEndpointMatchesLegacyRoutingMetadata(
				snapshot,
				route.routing_metadata
			)
		) {
			pushIssue(
				issues,
				endpointBlocker(
					"legacy_routing_metadata_drift",
					"Legacy routing_metadata conflicts with the manifest and would make runtime fail closed",
					entry.id,
					routeId
				)
			);
		}
		if (route.price_override?.trim()) {
			pushIssue(issues, {
				severity: "warning",
				code: "legacy_price_override_present",
				message:
					"Route price_override remains an explicit charged/metered factor and must be reviewed separately; it was not used to derive Endpoint facts",
				endpoint_id: entry.id,
				route_target_id: routeId,
				details_sha256: await sha256(route.price_override),
			});
		}
		if (route.custom_params?.trim()) {
			try {
				const parsed = JSON.parse(route.custom_params) as unknown;
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					Array.isArray(parsed)
				) {
					throw new TypeError("not an object");
				}
			} catch {
				pushIssue(
					issues,
					endpointBlocker(
						"route_custom_params_invalid",
						"Linked route custom_params is invalid and would be ignored by the runtime subject",
						entry.id,
						routeId
					)
				);
			}
		}
		if (provider && provider.api_key?.trim()) {
			try {
				const proposed = await computeRouteDataPolicySubjectFingerprintFromRows(
					route,
					provider
				);
				const currentLink = owner?.endpoint_id === entry.id ? owner : null;
				const rawCurrentFingerprint = currentLink?.subject_fingerprint ?? null;
				const safeCurrentFingerprint =
					typeof rawCurrentFingerprint === "string" &&
					SHA256.test(rawCurrentFingerprint)
						? rawCurrentFingerprint
						: null;
				if (rawCurrentFingerprint !== null && safeCurrentFingerprint === null) {
					pushIssue(issues, {
						severity: "warning",
						code: "invalid_current_subject_fingerprint_redacted",
						message:
							"The stored Route+Provider subject fingerprint is invalid and was redacted from this report",
						endpoint_id: entry.id,
						route_target_id: routeId,
						details_sha256: await sha256(rawCurrentFingerprint),
					});
				}
				routeSubjects.push({
					route_target_id: routeId,
					current_fingerprint: safeCurrentFingerprint,
					proposed_fingerprint: proposed,
					state: fingerprintState(
						safeCurrentFingerprint,
						proposed,
						Boolean(currentLink)
					),
				});
			} catch {
				pushIssue(
					issues,
					endpointBlocker(
						"route_subject_fingerprint_failed",
						"Could not compute the Route+Provider subject fingerprint",
						entry.id,
						routeId
					)
				);
			}
		}
	}

	issues.sort(issueSort);
	const verificationStateSha256 = await sha256({
		endpoint: existing
			? {
					id: existing.id,
					updated_at: existing.updated_at,
					status: existing.status,
				}
			: null,
		links: currentLinks.map((link) => ({
			endpoint_id: link.endpoint_id,
			route_target_id: link.route_target_id,
			subject_fingerprint: link.subject_fingerprint,
			created_at: link.created_at,
		})),
		routes: entry.route_target_ids.map((routeId) => {
			const route = context.routes.get(routeId);
			return route
				? {
						id: route.id,
						model_id: route.model_id,
						provider_id: route.provider_id,
						provider_model_name: route.provider_model_name,
						status: route.status,
						upstream_protocol: route.upstream_protocol,
						upstream_operation: route.upstream_operation ?? "*",
						adapter: route.adapter ?? "passthrough",
						custom_params: route.custom_params,
						price_override: route.price_override,
						routing_metadata: route.routing_metadata,
					}
				: null;
		}),
		provider: provider
			? {
					id: provider.id,
					status: provider.status,
					shared_channel_type: provider.shared_channel_type ?? null,
					credential_present: Boolean(provider.api_key?.trim()),
					endpoints: provider.endpoints ?? null,
				}
			: null,
		route_subjects: routeSubjects,
	});
	if (issues.some((issue) => issue.severity === "blocker")) {
		return {
			endpoint_id: entry.id,
			before_sha256: beforeSha256,
			desired_sha256: desiredSha256,
			verification_state_sha256: verificationStateSha256,
			disposition: "blocked",
			issues,
			actions: [],
			route_subjects: routeSubjects.sort((left, right) =>
				compareCodePoints(left.route_target_id, right.route_target_id)
			),
		};
	}

	const linksChanged = addedLinks.length > 0 || removedLinks.length > 0;
	const subjectsCurrent =
		routeSubjects.length === entry.route_target_ids.length &&
		routeSubjects.every((subject) => subject.state === "current");
	const existingRuntimeSnapshot = existing
		? parseVerifiedModelEndpointSnapshot(existing, context.now)
		: null;
	const alreadyCurrent = Boolean(
		existing &&
		!materialChanged &&
		!linksChanged &&
		subjectsCurrent &&
		existingRuntimeSnapshot &&
		attestedDesiredSha256 === desiredSha256
	);
	if (
		existing &&
		!materialChanged &&
		!linksChanged &&
		subjectsCurrent &&
		existingRuntimeSnapshot &&
		attestedDesiredSha256 !== desiredSha256
	) {
		pushIssue(issues, {
			severity: "warning",
			code:
				attestedDesiredSha256 === null
					? "evidence_attestation_not_persisted"
					: "evidence_attestation_mismatch",
			message:
				"Current endpoint facts require reverification because the reviewed evidence is not proven by a trusted attestation ledger",
			endpoint_id: entry.id,
		});
		issues.sort(issueSort);
	}
	if (alreadyCurrent) {
		return {
			endpoint_id: entry.id,
			before_sha256: beforeSha256,
			desired_sha256: desiredSha256,
			verification_state_sha256: verificationStateSha256,
			disposition: "noop",
			issues,
			actions: [],
			route_subjects: routeSubjects.sort((left, right) =>
				compareCodePoints(left.route_target_id, right.route_target_id)
			),
		};
	}

	if (!existing) {
		actions.push({
			type: "create_endpoint_draft",
			endpoint_id: entry.id,
			expected_updated_at: null,
		});
	} else if (materialChanged) {
		actions.push({
			type: "update_endpoint_draft",
			endpoint_id: entry.id,
			expected_updated_at: entry.expected_updated_at,
		});
	}
	for (const routeId of removedLinks) {
		actions.push({
			type: "unlink_route",
			endpoint_id: entry.id,
			route_target_id: routeId,
		});
	}
	for (const routeId of addedLinks) {
		actions.push({
			type: "link_route",
			endpoint_id: entry.id,
			route_target_id: routeId,
		});
	}
	for (const subject of routeSubjects) {
		if (subject.state !== "current" || !alreadyCurrent) {
			actions.push({
				type: "publish_verification",
				endpoint_id: entry.id,
				route_target_id: subject.route_target_id,
				subject_fingerprint: subject.proposed_fingerprint,
			});
		}
	}

	const disposition: EndpointBackfillEndpointPlan["disposition"] = !existing
		? "create_and_verify"
		: materialChanged || linksChanged
			? "update_and_reverify"
			: existing.status === "draft"
				? "promote_draft"
				: "reverify";
	return {
		endpoint_id: entry.id,
		before_sha256: beforeSha256,
		desired_sha256: desiredSha256,
		verification_state_sha256: verificationStateSha256,
		disposition,
		issues,
		actions: actions.sort(actionSort),
		route_subjects: routeSubjects.sort((left, right) =>
			compareCodePoints(left.route_target_id, right.route_target_id)
		),
	};
}

/**
 * Produce a deterministic, zero-write plan. This function intentionally has
 * no repository and no apply branch. A later audited transaction writer must
 * re-check every revision, link and subject before consuming the plan.
 */
export async function planEndpointBackfill(
	manifest: EndpointBackfillManifest,
	inventory: EndpointBackfillInventory,
	now = new Date(),
	provenance?: EndpointBackfillPlanProvenance
): Promise<EndpointBackfillReport> {
	if (!Number.isFinite(now.getTime())) throw new TypeError("now must be valid");
	const inventoryConsistency = projectInventoryConsistency(inventory.consistency);
	const selectedManifestSha256 = await sha256(manifest);
	const selectionSha256 = await sha256(
		manifest.endpoints.map((endpoint) => endpoint.id)
	);
	const fullManifestSha256 =
		provenance?.full_manifest_sha256 ?? selectedManifestSha256;
	if (!SHA256.test(fullManifestSha256)) {
		throw new TypeError("full manifest provenance digest is invalid");
	}
	// Never serialize the caller-owned object: database clients sometimes attach
	// connection strings or driver handles to otherwise source-like metadata.
	const source: EndpointBackfillInventory["source"] = {
		driver: inventory.source.driver,
		database_fingerprint: inventory.source.database_fingerprint,
		required_migration: inventory.source.required_migration,
		migration_head: inventory.source.migration_head,
		migration_present: inventory.source.migration_present === true,
	};
	const globalIssues: EndpointBackfillIssue[] = [];
	if (
		inventoryConsistency.drifted ||
		stableEndpointBackfillJson(inventoryConsistency.before) !==
			stableEndpointBackfillJson(inventoryConsistency.after)
	) {
		pushIssue(globalIssues, {
			severity: "blocker",
			code: "inventory_consistency_drift",
			message:
				"Referenced rows changed between bounded inventory reads; no endpoint actions are valid",
		});
	}
	if (!inventoryConsistency.snapshot_consistent) {
		pushIssue(globalIssues, {
			severity: "warning",
			code: "inventory_not_snapshot_consistent",
			message:
				"Inventory uses bounded double-read detection rather than a database-wide consistent snapshot",
		});
	}
	if (source.driver !== manifest.target.driver) {
		pushIssue(globalIssues, {
			severity: "blocker",
			code: "target_driver_mismatch",
			message: `Manifest targets ${manifest.target.driver} but inventory is ${source.driver}`,
		});
	}
	if (
		source.database_fingerprint !== manifest.target.database_fingerprint
	) {
		pushIssue(globalIssues, {
			severity: "blocker",
			code: "target_database_fingerprint_mismatch",
			message: "Manifest database fingerprint does not match the selected target",
		});
	}
	if (
		source.required_migration !== manifest.target.required_migration
	) {
		pushIssue(globalIssues, {
			severity: "blocker",
			code: "target_migration_contract_mismatch",
			message: "Manifest required migration does not match the target contract",
		});
	}
	if (!source.migration_present) {
		pushIssue(globalIssues, {
			severity: "blocker",
			code: "required_migration_missing",
			message: `Required ${source.driver} migration is missing: ${source.required_migration}`,
		});
	} else if (compareCodePoints(source.migration_head, source.required_migration) < 0) {
		pushIssue(globalIssues, {
			severity: "blocker",
			code: "migration_ledger_order_invalid",
			message:
				"Migration ledger reports the required migration but its current head sorts earlier",
		});
	} else if (source.migration_head !== source.required_migration) {
		pushIssue(globalIssues, {
			severity: "warning",
			code: "migration_head_differs_from_required",
			message:
				"Target includes later migrations; review their backward compatibility with this planner",
		});
	}
	const models = mapUnique(inventory.models, "model", globalIssues);
	const providers = mapUnique(inventory.providers, "provider", globalIssues);
	const routes = mapUnique(inventory.routes, "route", globalIssues);
	const endpoints = mapUnique(inventory.endpoints, "endpoint", globalIssues);
	const evidenceAttestations = new Map<string, string>();
	for (const attestation of inventory.evidence_attestations ?? []) {
		if (
			typeof attestation?.endpoint_id !== "string" ||
			!attestation.endpoint_id ||
			typeof attestation.desired_sha256 !== "string" ||
			!SHA256.test(attestation.desired_sha256)
		) {
			pushIssue(globalIssues, {
				severity: "blocker",
				code: "invalid_inventory_evidence_attestation",
				message: "Inventory contains an invalid evidence attestation",
			});
			continue;
		}
		if (evidenceAttestations.has(attestation.endpoint_id)) {
			pushIssue(globalIssues, {
				severity: "blocker",
				code: "duplicate_inventory_evidence_attestation",
				message: `Inventory contains duplicate evidence attestations for ${attestation.endpoint_id}`,
			});
			continue;
		}
		evidenceAttestations.set(
			attestation.endpoint_id,
			attestation.desired_sha256
		);
	}
	const identityOwners = new Map<string, ModelEndpointRow>();
	for (const endpoint of inventory.endpoints) {
		const key = identityKey(endpoint);
		const owner = identityOwners.get(key);
		if (owner && owner.id !== endpoint.id) {
			pushIssue(globalIssues, {
				severity: "blocker",
				code: "duplicate_inventory_endpoint_identity",
				message: `Inventory contains duplicate endpoint identity owned by ${owner.id} and ${endpoint.id}`,
			});
		}
		identityOwners.set(key, endpoint);
	}
	const linksByEndpoint = new Map<string, ModelEndpointRouteLinkRow[]>();
	const linksByRoute = new Map<string, ModelEndpointRouteLinkRow>();
	const linkPairs = new Set<string>();
	for (const link of inventory.links) {
		const pair = `${link.endpoint_id}\u0000${link.route_target_id}`;
		if (linkPairs.has(pair)) {
			pushIssue(globalIssues, {
				severity: "blocker",
				code: "duplicate_inventory_endpoint_route_link",
				message: `Inventory contains duplicate endpoint/route link ${link.endpoint_id}/${link.route_target_id}`,
			});
		}
		linkPairs.add(pair);
		const routeOwner = linksByRoute.get(link.route_target_id);
		if (routeOwner && routeOwner.endpoint_id !== link.endpoint_id) {
			pushIssue(globalIssues, {
				severity: "blocker",
				code: "duplicate_inventory_route_owner",
				message: `Inventory assigns route ${link.route_target_id} to multiple endpoints`,
			});
		}
		linksByRoute.set(link.route_target_id, link);
		const current = linksByEndpoint.get(link.endpoint_id);
		if (current) current.push(link);
		else linksByEndpoint.set(link.endpoint_id, [link]);
	}
	for (const links of linksByEndpoint.values()) {
		links.sort((left, right) =>
			compareCodePoints(left.route_target_id, right.route_target_id)
		);
	}

	const endpointPlans = await Promise.all(
		manifest.endpoints.map((entry) =>
			planEndpoint(manifest, entry, {
				now,
				models,
				providers,
				routes,
				endpoints,
				identityOwners,
				linksByEndpoint,
				linksByRoute,
				evidenceAttestations,
			})
		)
	);
	endpointPlans.sort((left, right) =>
		compareCodePoints(left.endpoint_id, right.endpoint_id)
	);
	globalIssues.sort(issueSort);
	if (globalIssues.some((issue) => issue.severity === "blocker")) {
		for (const endpoint of endpointPlans) {
			if (endpoint.disposition !== "blocked") {
				endpoint.disposition = "blocked";
				endpoint.actions = [];
				pushIssue(endpoint.issues, {
					severity: "blocker",
					code: "source_precondition_failed",
					message:
						"No endpoint actions are valid until the report-level source preconditions pass",
					endpoint_id: endpoint.endpoint_id,
				});
				endpoint.issues.sort(issueSort);
			}
		}
	}
	const allIssues = [
		...globalIssues,
		...endpointPlans.flatMap((endpoint) => endpoint.issues),
	];
	const blocked =
		globalIssues.some((issue) => issue.severity === "blocker") ||
		endpointPlans.filter((endpoint) => endpoint.disposition === "blocked").length > 0;
	const executionSha256 = await sha256EndpointBackfillExecution({
		source,
		inventory_read: inventoryConsistency.after,
		validation_passed: !blocked,
		endpoints: endpointPlans,
	});
	const reportWithoutDigest = {
		version: ENDPOINT_BACKFILL_REPORT_VERSION,
		mode: "dry-run" as const,
		apply_supported: false as const,
		authorization_verified: false as const,
		legacy_evidence_used: false as const,
		generated_at: now.toISOString(),
		manifest_id: manifest.manifest_id,
		manifest_sha256: fullManifestSha256,
		selected_manifest_sha256: selectedManifestSha256,
		selection_sha256: selectionSha256,
		execution_sha256: executionSha256,
		source,
		database_fingerprint_source: "operator_asserted_environment" as const,
		database_identity_verified: false as const,
		inventory_consistency: inventoryConsistency,
		validation_passed: !blocked,
		ready_to_apply: false as const,
		summary: {
			endpoints: endpointPlans.length,
			blocked: endpointPlans.filter(
				(endpoint) => endpoint.disposition === "blocked"
			).length,
			changes: endpointPlans.filter(
				(endpoint) =>
					endpoint.disposition !== "blocked" &&
					endpoint.disposition !== "noop"
			).length,
			noops: endpointPlans.filter(
				(endpoint) => endpoint.disposition === "noop"
			).length,
			warnings: allIssues.filter((issue) => issue.severity === "warning").length,
			actions: endpointPlans.reduce(
				(total, endpoint) => total + endpoint.actions.length,
				0
			),
		},
		issues: globalIssues,
		endpoints: endpointPlans,
	};
	return {
		...reportWithoutDigest,
		plan_sha256: await sha256(reportWithoutDigest),
	};
}
