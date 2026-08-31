import type { ModelEndpointRow } from "./db/model-endpoints-types";
import {
	buildEndpointBackfillDesiredRow,
	planEndpointBackfill,
	sha256EndpointBackfillValue,
	stableEndpointBackfillJson,
	type EndpointBackfillEndpointPlan,
	type EndpointBackfillInventory,
	type EndpointBackfillManifest,
} from "./model-endpoint-backfill";

export const ENDPOINT_BACKFILL_APPLY_REPORT_VERSION =
	"cinatoken.endpoint-backfill-apply-report.v1" as const;

export type EndpointBackfillVerifiedPrincipal = {
	principal: string;
	/** SHA-256 of the signer public key's DER-encoded SPKI, prefixed with sha256:. */
	key_id: string;
};

export type EndpointBackfillVerifiedEvidenceReviewer =
	EndpointBackfillVerifiedPrincipal & {
		/** Exact selected endpoint set whose evidence names this reviewer. */
		endpoint_ids: string[];
	};

export type EndpointBackfillVerifiedAuthorization = {
	request_sha256: string;
	execution_sha256: string;
	trusted_signers_sha256: string;
	validation_passed: true;
	approved_at: string;
	expires_at: string;
	manifest_actor: EndpointBackfillVerifiedPrincipal;
	evidence_reviewers: EndpointBackfillVerifiedEvidenceReviewer[];
	apply_approver: EndpointBackfillVerifiedPrincipal;
};

export type EndpointBackfillApplyRun = {
	idempotency_key: string;
	manifest_id: string;
	manifest_sha256: string;
	selected_manifest_sha256: string;
	selection_sha256: string;
	database_fingerprint: string;
	request_sha256: string;
	execution_sha256: string;
	trusted_signers_sha256: string;
	authorization_sha256: string;
	manifest_actor_id: string;
	manifest_actor_key_id: string;
	evidence_reviewers_json: string;
	approved_by: string;
	approval_key_id: string;
	approval_approved_at: string;
	approval_expires_at: string;
	applied_at: string;
	actions_count: number;
	endpoints_count: number;
};

export type EndpointBackfillEvidenceAttestationWrite = {
	idempotency_key: string;
	endpoint_id: string;
	desired_sha256: string;
	before_sha256: string | null;
	verification_state_sha256: string;
	evidence_sha256: string;
	evidence_url: string;
	evidence_observed_at: string;
	evidence_expires_at: string;
	evidence_reviewed_by: string;
	evidence_reviewer_key_id: string;
	manifest_actor_id: string;
	approved_by: string;
	applied_at: string;
};

/**
 * The transaction implementation is the security boundary. `loadInventory`
 * must read from the same serializable transaction used by every mutation;
 * `acquireLock` must serialize this writer for the selected database.
 */
export interface EndpointBackfillApplyTransaction {
	acquireLock(): Promise<void>;
	/**
	 * Verify a database-owned, persistent identity after acquiring the writer
	 * lock. Comparing two operator-supplied strings is not sufficient.
	 */
	verifyDatabaseIdentity(
		expectedFingerprint: string,
		expectedTrustedSignersSha256: string
	): Promise<void>;
	/** Return the target database clock from the active transaction. */
	databaseNow(): Promise<Date>;
	findCompletedRun(idempotencyKey: string): Promise<EndpointBackfillApplyRun | null>;
	loadInventory(): Promise<EndpointBackfillInventory>;
	assertEndpointRevision(endpointId: string, expectedUpdatedAt: string | null): Promise<void>;
	writeDraft(
		desired: ModelEndpointRow,
		mode: "create" | "update" | "preserve",
		expectedUpdatedAt: string | null
	): Promise<void>;
	syncRouteBindings(
		endpointId: string,
		bindings: ReadonlyArray<{ route_target_id: string; subject_fingerprint: string }>,
		appliedAt: string
	): Promise<void>;
	publish(desired: ModelEndpointRow): Promise<void>;
	insertRun(run: EndpointBackfillApplyRun): Promise<void>;
	insertAttestation(attestation: EndpointBackfillEvidenceAttestationWrite): Promise<void>;
}

export interface EndpointBackfillApplyStore {
	serializableTransaction<T>(
		work: (transaction: EndpointBackfillApplyTransaction) => Promise<T>
	): Promise<T>;
}

export type EndpointBackfillApplyRequest = {
	manifest: EndpointBackfillManifest;
	full_manifest_sha256: string;
	authorization: EndpointBackfillVerifiedAuthorization;
	store: EndpointBackfillApplyStore;
	/** @deprecated Authorization and evidence freshness use transaction databaseNow(). */
	now?: Date;
};

export async function buildEndpointBackfillApplyRequestDigest(input: {
	full_manifest_sha256: string;
	manifest: EndpointBackfillManifest;
	execution_sha256: string;
	trusted_signers_sha256: string;
}): Promise<{
	request_sha256: string;
	selected_manifest_sha256: string;
	selection_sha256: string;
	execution_sha256: string;
	trusted_signers_sha256: string;
}> {
	if (!/^[0-9a-f]{64}$/u.test(input.execution_sha256)) {
		throw new TypeError("execution_sha256 must be 64 lowercase hexadecimal characters");
	}
	if (!/^[0-9a-f]{64}$/u.test(input.trusted_signers_sha256)) {
		throw new TypeError(
			"trusted_signers_sha256 must be 64 lowercase hexadecimal characters"
		);
	}
	const selectedManifestSha256 = await sha256EndpointBackfillValue(input.manifest);
	const selectionSha256 = await sha256EndpointBackfillValue(
		input.manifest.endpoints.map((endpoint) => endpoint.id)
	);
	const request_sha256 = await sha256EndpointBackfillValue({
		version: "cinatoken.endpoint-backfill-apply-request.v2",
		manifest_sha256: input.full_manifest_sha256,
		selected_manifest_sha256: selectedManifestSha256,
		selection_sha256: selectionSha256,
		database_fingerprint: input.manifest.target.database_fingerprint,
		execution_sha256: input.execution_sha256,
		trusted_signers_sha256: input.trusted_signers_sha256,
	});
	return {
		request_sha256,
		selected_manifest_sha256: selectedManifestSha256,
		selection_sha256: selectionSha256,
		execution_sha256: input.execution_sha256,
		trusted_signers_sha256: input.trusted_signers_sha256,
	};
}

export type EndpointBackfillApplyReport = {
	version: typeof ENDPOINT_BACKFILL_APPLY_REPORT_VERSION;
	mode: "apply";
	status: "applied" | "already_applied";
	apply_supported: true;
	authorization_verified: true;
	transactional: true;
	generated_at: string;
	applied_at: string;
	idempotency_key: string;
	manifest_id: string;
	manifest_sha256: string;
	selected_manifest_sha256: string;
	selection_sha256: string;
	request_sha256: string;
	execution_sha256: string;
	trusted_signers_sha256: string;
	authorization_sha256: string;
	database_fingerprint: string;
	manifest_actor_id: string;
	manifest_actor_key_id: string;
	evidence_reviewers: EndpointBackfillVerifiedEvidenceReviewer[];
	approved_by: string;
	approval_key_id: string;
	approval_approved_at: string;
	approval_expires_at: string;
	actions: number;
	endpoints: number;
};

export class EndpointBackfillApplyError extends Error {
	readonly code:
		| "authorization_mismatch"
		| "authorization_expired"
		| "execution_mismatch"
		| "validation_blocked"
		| "revision_conflict"
		| "ledger_conflict";

	constructor(code: EndpointBackfillApplyError["code"], message: string) {
		super(message);
		this.name = "EndpointBackfillApplyError";
		this.code = code;
	}
}

const MAX_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^sha256:[0-9a-f]{64}$/u;

function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedAuthorizationProvenance(
	authorization: EndpointBackfillVerifiedAuthorization
): Omit<EndpointBackfillVerifiedAuthorization, "evidence_reviewers"> & {
	evidence_reviewers: EndpointBackfillVerifiedEvidenceReviewer[];
} {
	return {
		request_sha256: authorization.request_sha256,
		execution_sha256: authorization.execution_sha256,
		trusted_signers_sha256: authorization.trusted_signers_sha256,
		validation_passed: authorization.validation_passed,
		approved_at: authorization.approved_at,
		expires_at: authorization.expires_at,
		manifest_actor: { ...authorization.manifest_actor },
		evidence_reviewers: authorization.evidence_reviewers
			.map((reviewer) => ({
				principal: reviewer.principal,
				key_id: reviewer.key_id,
				endpoint_ids: [...reviewer.endpoint_ids].sort(compareCodePoints),
			}))
			.sort(
				(left, right) =>
					compareCodePoints(left.principal, right.principal) ||
					compareCodePoints(left.key_id, right.key_id)
			),
		apply_approver: { ...authorization.apply_approver },
	};
}

export function sha256EndpointBackfillVerifiedAuthorization(
	authorization: EndpointBackfillVerifiedAuthorization
): Promise<string> {
	return sha256EndpointBackfillValue({
		version: "cinatoken.endpoint-backfill-verified-authorization.v2",
		...normalizedAuthorizationProvenance(authorization),
	});
}

export function serializeEndpointBackfillVerifiedEvidenceReviewers(
	authorization: Pick<EndpointBackfillVerifiedAuthorization, "evidence_reviewers">
): string {
	const serialized = stableEndpointBackfillJson(
		authorization.evidence_reviewers
			.map((reviewer) => ({
				principal: reviewer.principal,
				key_id: reviewer.key_id,
				endpoint_ids: [...reviewer.endpoint_ids].sort(compareCodePoints),
			}))
			.sort(
				(left, right) =>
					compareCodePoints(left.principal, right.principal) ||
					compareCodePoints(left.key_id, right.key_id)
			)
	);
	if (new TextEncoder().encode(serialized).byteLength > MAX_REVIEWER_PROVENANCE_BYTES) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			"Verified evidence reviewer provenance exceeds the storage contract"
		);
	}
	return serialized;
}

function assertPrincipal(
	principal: EndpointBackfillVerifiedPrincipal,
	label: string
): void {
	if (
		typeof principal?.principal !== "string" ||
		principal.principal.length === 0 ||
		typeof principal.key_id !== "string" ||
		!KEY_ID.test(principal.key_id)
	) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			`${label} is not a registry-derived verified principal`
		);
	}
}

function assertAuthorizationBindings(
	manifest: EndpointBackfillManifest,
	authorization: EndpointBackfillVerifiedAuthorization
): void {
	if (
		!SHA256.test(authorization.request_sha256) ||
		!SHA256.test(authorization.execution_sha256) ||
		!SHA256.test(authorization.trusted_signers_sha256) ||
		authorization.validation_passed !== true
	) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			"Verified authorization digests are invalid"
		);
	}
	assertPrincipal(authorization.manifest_actor, "manifest_actor");
	assertPrincipal(authorization.apply_approver, "apply_approver");
	if (authorization.manifest_actor.principal !== manifest.actor_id) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			"Verified manifest actor does not match the manifest"
		);
	}

	const expectedReviewers = new Map<string, string[]>();
	for (const endpoint of manifest.endpoints) {
		const endpointIds = expectedReviewers.get(endpoint.evidence.reviewed_by);
		if (endpointIds) endpointIds.push(endpoint.id);
		else expectedReviewers.set(endpoint.evidence.reviewed_by, [endpoint.id]);
	}
	const seenReviewers = new Set<string>();
	for (const reviewer of authorization.evidence_reviewers) {
		assertPrincipal(reviewer, "evidence_reviewer");
		if (seenReviewers.has(reviewer.principal)) {
			throw new EndpointBackfillApplyError(
				"authorization_mismatch",
				"Verified evidence reviewer appears more than once"
			);
		}
		seenReviewers.add(reviewer.principal);
		const expected = expectedReviewers.get(reviewer.principal);
		const actual = [...reviewer.endpoint_ids].sort(compareCodePoints);
		if (
			!expected ||
			new Set(actual).size !== actual.length ||
			actual.length !== expected.length ||
			actual.some(
				(endpointId, index) =>
					endpointId !== [...expected].sort(compareCodePoints)[index]
			)
		) {
			throw new EndpointBackfillApplyError(
				"authorization_mismatch",
				"Verified evidence reviewer coverage does not match the manifest"
			);
		}
	}
	if (
		seenReviewers.size !== expectedReviewers.size ||
		[...expectedReviewers.keys()].some((principal) => !seenReviewers.has(principal))
	) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			"Every manifest evidence reviewer requires an independent signature"
		);
	}

	const signers: EndpointBackfillVerifiedPrincipal[] = [
		authorization.manifest_actor,
		...authorization.evidence_reviewers,
		authorization.apply_approver,
	];
	if (
		new Set(signers.map((signer) => signer.principal)).size !== signers.length ||
		new Set(signers.map((signer) => signer.key_id)).size !== signers.length
	) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			"Manifest actor, evidence reviewers, and apply approver require distinct principals and keys"
		);
	}
}

function authorizationValidityWindow(
	authorization: EndpointBackfillVerifiedAuthorization
): { approvedAt: number; expiresAt: number } {
	const approvedAt = Date.parse(authorization.approved_at);
	const expiresAt = Date.parse(authorization.expires_at);
	if (
		!Number.isFinite(approvedAt) ||
		!Number.isFinite(expiresAt) ||
		expiresAt <= approvedAt ||
		expiresAt - approvedAt > MAX_APPROVAL_LIFETIME_MS
	) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			"Verified authorization validity is invalid"
		);
	}
	return { approvedAt, expiresAt };
}

const MAX_REVIEWER_PROVENANCE_BYTES = 256 * 1024;

function assertFreshAuthorization(
	authorization: EndpointBackfillVerifiedAuthorization,
	now: Date
): void {
	if (!Number.isFinite(now.getTime())) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			"Target database clock is invalid"
		);
	}
	const { approvedAt, expiresAt } = authorizationValidityWindow(authorization);
	if (approvedAt > now.getTime() + MAX_CLOCK_SKEW_MS || expiresAt <= now.getTime()) {
		throw new EndpointBackfillApplyError(
			"authorization_expired",
			"Endpoint backfill approval is not valid at the target database time"
		);
	}
}

function assertFreshEvidence(
	manifest: EndpointBackfillManifest,
	now: Date
): void {
	if (!Number.isFinite(now.getTime())) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			"Target database clock is invalid"
		);
	}
	if (manifest.endpoints.some((endpoint) => {
		const expires = Date.parse(endpoint.evidence.expires_at);
		return !Number.isFinite(expires) || expires <= now.getTime();
	})) {
		throw new EndpointBackfillApplyError(
			"validation_blocked",
			"Endpoint evidence expired before the transaction authorization boundary"
		);
	}
}

function parseLedgerEvidenceReviewers(
	serialized: string
): EndpointBackfillVerifiedEvidenceReviewer[] {
	if (
		typeof serialized !== "string" ||
		new TextEncoder().encode(serialized).byteLength > MAX_REVIEWER_PROVENANCE_BYTES
	) {
		throw new EndpointBackfillApplyError(
			"ledger_conflict",
			"The idempotency ledger contains invalid reviewer provenance"
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new EndpointBackfillApplyError(
			"ledger_conflict",
			"The idempotency ledger contains invalid reviewer provenance"
		);
	}
	if (!Array.isArray(value) || value.length > 1024) {
		throw new EndpointBackfillApplyError(
			"ledger_conflict",
			"The idempotency ledger contains invalid reviewer provenance"
		);
	}
	const reviewers = value.map((raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new EndpointBackfillApplyError(
				"ledger_conflict",
				"The idempotency ledger contains invalid reviewer provenance"
			);
		}
		const record = raw as Record<string, unknown>;
		const keys = Object.keys(record).sort(compareCodePoints);
		if (
			keys.length !== 3 ||
			keys[0] !== "endpoint_ids" ||
			keys[1] !== "key_id" ||
			keys[2] !== "principal" ||
			typeof record.principal !== "string" ||
			typeof record.key_id !== "string" ||
			!Array.isArray(record.endpoint_ids) ||
			record.endpoint_ids.some(
				(endpointId) =>
					typeof endpointId !== "string" ||
					endpointId.length === 0 ||
					endpointId.length > 191
			)
		) {
			throw new EndpointBackfillApplyError(
				"ledger_conflict",
				"The idempotency ledger contains invalid reviewer provenance"
			);
		}
		return {
			principal: record.principal,
			key_id: record.key_id,
			endpoint_ids: record.endpoint_ids as string[],
		};
	});
	const canonical = serializeEndpointBackfillVerifiedEvidenceReviewers({
		evidence_reviewers: reviewers,
	});
	if (canonical !== serialized) {
		throw new EndpointBackfillApplyError(
			"ledger_conflict",
			"The idempotency ledger reviewer provenance is not canonical"
		);
	}
	return reviewers;
}

function authorizationFromRun(
	run: EndpointBackfillApplyRun
): EndpointBackfillVerifiedAuthorization {
	return {
		request_sha256: run.request_sha256,
		execution_sha256: run.execution_sha256,
		trusted_signers_sha256: run.trusted_signers_sha256,
		validation_passed: true,
		approved_at: canonicalLedgerInstant(
			run.approval_approved_at,
			"approval_approved_at"
		),
		expires_at: canonicalLedgerInstant(
			run.approval_expires_at,
			"approval_expires_at"
		),
		manifest_actor: {
			principal: run.manifest_actor_id,
			key_id: run.manifest_actor_key_id,
		},
		evidence_reviewers: parseLedgerEvidenceReviewers(
			run.evidence_reviewers_json
		),
		apply_approver: {
			principal: run.approved_by,
			key_id: run.approval_key_id,
		},
	};
}

function canonicalLedgerInstant(value: string, label: string): string {
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(parsed)) {
		throw new EndpointBackfillApplyError(
			"ledger_conflict",
			`The idempotency ledger contains an invalid ${label}`
		);
	}
	return new Date(parsed).toISOString();
}

async function validateRunAuthorizationProvenance(
	run: EndpointBackfillApplyRun,
	manifest: EndpointBackfillManifest
): Promise<EndpointBackfillVerifiedAuthorization> {
	if (!SHA256.test(run.authorization_sha256)) {
		throw new EndpointBackfillApplyError(
			"ledger_conflict",
			"The idempotency ledger contains an invalid authorization digest"
		);
	}
	const authorization = authorizationFromRun(run);
	try {
		assertAuthorizationBindings(manifest, authorization);
		authorizationValidityWindow(authorization);
	} catch (error) {
		if (error instanceof EndpointBackfillApplyError) {
			throw new EndpointBackfillApplyError(
				"ledger_conflict",
				"The idempotency ledger contains invalid authorization provenance"
			);
		}
		throw error;
	}
	if (
		(await sha256EndpointBackfillVerifiedAuthorization(authorization)) !==
		run.authorization_sha256
	) {
		throw new EndpointBackfillApplyError(
			"ledger_conflict",
			"The idempotency ledger authorization provenance digest does not match"
		);
	}
	return authorization;
}

function modeForPlan(plan: EndpointBackfillEndpointPlan): "create" | "update" | "preserve" {
	if (plan.actions.some((action) => action.type === "create_endpoint_draft")) return "create";
	if (plan.actions.some((action) => action.type === "update_endpoint_draft")) return "update";
	return "preserve";
}

function reportFromRun(
	run: EndpointBackfillApplyRun,
	status: EndpointBackfillApplyReport["status"],
	generatedAt: string,
	authorization: EndpointBackfillVerifiedAuthorization
): EndpointBackfillApplyReport {
	return {
		version: ENDPOINT_BACKFILL_APPLY_REPORT_VERSION,
		mode: "apply",
		status,
		apply_supported: true,
		authorization_verified: true,
		transactional: true,
		generated_at: generatedAt,
		applied_at: canonicalLedgerInstant(run.applied_at, "applied_at"),
		idempotency_key: run.idempotency_key,
		manifest_id: run.manifest_id,
		manifest_sha256: run.manifest_sha256,
		selected_manifest_sha256: run.selected_manifest_sha256,
		selection_sha256: run.selection_sha256,
		request_sha256: run.request_sha256,
		execution_sha256: run.execution_sha256,
		trusted_signers_sha256: run.trusted_signers_sha256,
		authorization_sha256: run.authorization_sha256,
		database_fingerprint: run.database_fingerprint,
		manifest_actor_id: run.manifest_actor_id,
		manifest_actor_key_id: run.manifest_actor_key_id,
		evidence_reviewers: normalizedAuthorizationProvenance(authorization)
			.evidence_reviewers,
		approved_by: run.approved_by,
		approval_key_id: run.approval_key_id,
		approval_approved_at: authorization.approved_at,
		approval_expires_at: authorization.expires_at,
		actions: run.actions_count,
		endpoints: run.endpoints_count,
	};
}

/**
 * Replans and writes inside one serializable transaction. A successful ledger
 * row and all endpoint mutations commit together; an exception leaves neither.
 */
export async function applyEndpointBackfill(
	request: EndpointBackfillApplyRequest
): Promise<EndpointBackfillApplyReport> {
	assertAuthorizationBindings(request.manifest, request.authorization);
	const digests = await buildEndpointBackfillApplyRequestDigest({
		full_manifest_sha256: request.full_manifest_sha256,
		manifest: request.manifest,
		execution_sha256: request.authorization.execution_sha256,
		trusted_signers_sha256: request.authorization.trusted_signers_sha256,
	});
	const selectedManifestSha256 = digests.selected_manifest_sha256;
	const selectionSha256 = digests.selection_sha256;
	const authorizationSha256 =
		await sha256EndpointBackfillVerifiedAuthorization(request.authorization);
	const requestSha256 = digests.request_sha256;
	if (request.authorization.request_sha256 !== requestSha256) {
		throw new EndpointBackfillApplyError(
			"authorization_mismatch",
			"The verified authorization does not bind this manifest selection and database"
		);
	}
	const idempotencyKey = await sha256EndpointBackfillValue({
		version: "cinatoken.endpoint-backfill-apply-idempotency.v1",
		request_sha256: requestSha256,
	});

	return request.store.serializableTransaction(async (transaction) => {
		await transaction.acquireLock();
		await transaction.verifyDatabaseIdentity(
			request.manifest.target.database_fingerprint,
			request.authorization.trusted_signers_sha256
		);
		const transactionNow = await transaction.databaseNow();
		assertFreshAuthorization(request.authorization, transactionNow);
		const appliedAt = transactionNow.toISOString();
		const completed = await transaction.findCompletedRun(idempotencyKey);
		if (completed) {
			if (
				completed.idempotency_key !== idempotencyKey ||
				completed.manifest_id !== request.manifest.manifest_id ||
				completed.request_sha256 !== requestSha256 ||
				completed.manifest_sha256 !== request.full_manifest_sha256 ||
				completed.selected_manifest_sha256 !== selectedManifestSha256 ||
				completed.selection_sha256 !== selectionSha256 ||
				completed.database_fingerprint !==
					request.manifest.target.database_fingerprint ||
				completed.execution_sha256 !== request.authorization.execution_sha256 ||
				completed.trusted_signers_sha256 !==
					request.authorization.trusted_signers_sha256 ||
				completed.manifest_actor_id !== request.manifest.actor_id ||
				completed.endpoints_count !== request.manifest.endpoints.length
			) {
				throw new EndpointBackfillApplyError(
					"ledger_conflict",
					"The idempotency ledger contains conflicting immutable provenance"
				);
			}
			const ledgerAuthorization = await validateRunAuthorizationProvenance(
				completed,
				request.manifest
			);
			const completedBoundaryNow = await transaction.databaseNow();
			if (completedBoundaryNow.getTime() < transactionNow.getTime()) {
				throw new EndpointBackfillApplyError(
					"authorization_mismatch",
					"Target database clock moved backwards during apply"
				);
			}
			assertFreshAuthorization(request.authorization, completedBoundaryNow);
			return reportFromRun(
				completed,
				"already_applied",
				completedBoundaryNow.toISOString(),
				ledgerAuthorization
			);
		}

		assertFreshEvidence(request.manifest, transactionNow);

		const inventory = await transaction.loadInventory();
		const plan = await planEndpointBackfill(
			request.manifest,
			inventory,
			transactionNow,
			{
			full_manifest_sha256: request.full_manifest_sha256,
			}
		);
		if (!plan.validation_passed) {
			throw new EndpointBackfillApplyError(
				"validation_blocked",
				"Fresh transactional validation blocked the endpoint backfill"
			);
		}
		if (plan.execution_sha256 !== request.authorization.execution_sha256) {
			throw new EndpointBackfillApplyError(
				"execution_mismatch",
				"Fresh transactional execution plan does not match the approved digest"
			);
		}

		const run: EndpointBackfillApplyRun = {
			idempotency_key: idempotencyKey,
			manifest_id: request.manifest.manifest_id,
			manifest_sha256: request.full_manifest_sha256,
			selected_manifest_sha256: selectedManifestSha256,
			selection_sha256: selectionSha256,
			database_fingerprint: request.manifest.target.database_fingerprint,
			request_sha256: requestSha256,
			execution_sha256: request.authorization.execution_sha256,
			trusted_signers_sha256: request.authorization.trusted_signers_sha256,
			authorization_sha256: authorizationSha256,
			manifest_actor_id: request.authorization.manifest_actor.principal,
			manifest_actor_key_id: request.authorization.manifest_actor.key_id,
			evidence_reviewers_json:
				serializeEndpointBackfillVerifiedEvidenceReviewers(request.authorization),
			approved_by: request.authorization.apply_approver.principal,
			approval_key_id: request.authorization.apply_approver.key_id,
			approval_approved_at: request.authorization.approved_at,
			approval_expires_at: request.authorization.expires_at,
			applied_at: appliedAt,
			actions_count: plan.summary.actions,
			endpoints_count: plan.summary.endpoints,
		};
		// Claim the idempotency key before mutations. The transaction makes the
		// claim invisible on rollback and the unique key closes concurrent races.
		await transaction.insertRun(run);

		const entries = new Map(
			request.manifest.endpoints.map((endpoint) => [endpoint.id, endpoint])
		);
		for (const endpointPlan of plan.endpoints) {
			const entry = entries.get(endpointPlan.endpoint_id);
			if (!entry) throw new TypeError("Planner returned an unknown endpoint");
			const evidenceReviewer = request.authorization.evidence_reviewers.find(
				(reviewer) =>
					reviewer.principal === entry.evidence.reviewed_by &&
					reviewer.endpoint_ids.includes(entry.id)
			);
			if (!evidenceReviewer) {
				throw new EndpointBackfillApplyError(
					"authorization_mismatch",
					"Verified evidence reviewer coverage changed during apply"
				);
			}
			const desired = buildEndpointBackfillDesiredRow(
				entry,
				request.authorization.manifest_actor.principal,
				transactionNow
			);
			if (endpointPlan.disposition !== "noop") {
				await transaction.assertEndpointRevision(entry.id, entry.expected_updated_at);
				await transaction.writeDraft(
					desired,
					modeForPlan(endpointPlan),
					entry.expected_updated_at
				);
				await transaction.syncRouteBindings(
					entry.id,
					endpointPlan.route_subjects.map((subject) => ({
						route_target_id: subject.route_target_id,
						subject_fingerprint: subject.proposed_fingerprint,
					})),
					appliedAt
				);
				await transaction.publish(desired);
			}
			await transaction.insertAttestation({
				idempotency_key: idempotencyKey,
				endpoint_id: entry.id,
				desired_sha256: endpointPlan.desired_sha256,
				before_sha256: endpointPlan.before_sha256,
				verification_state_sha256: endpointPlan.verification_state_sha256,
				evidence_sha256: entry.evidence.sha256,
				evidence_url: entry.evidence.url,
				evidence_observed_at: entry.evidence.observed_at,
				evidence_expires_at: entry.evidence.expires_at,
				evidence_reviewed_by: entry.evidence.reviewed_by,
				evidence_reviewer_key_id: evidenceReviewer.key_id,
				manifest_actor_id: request.authorization.manifest_actor.principal,
				approved_by: request.authorization.apply_approver.principal,
				applied_at: appliedAt,
			});
		}
		const commitBoundaryNow = await transaction.databaseNow();
		if (commitBoundaryNow.getTime() < transactionNow.getTime()) {
			throw new EndpointBackfillApplyError(
				"authorization_mismatch",
				"Target database clock moved backwards during apply"
			);
		}
		assertFreshAuthorization(request.authorization, commitBoundaryNow);
		assertFreshEvidence(request.manifest, commitBoundaryNow);
		const ledgerAuthorization = await validateRunAuthorizationProvenance(
			run,
			request.manifest
		);
		return reportFromRun(
			run,
			"applied",
			commitBoundaryNow.toISOString(),
			ledgerAuthorization
		);
	});
}
