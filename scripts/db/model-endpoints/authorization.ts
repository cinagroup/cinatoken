import {
	createHash,
	createPublicKey,
	verify,
	type KeyObject,
} from "node:crypto";
import {
	stableEndpointBackfillJson,
	type EndpointBackfillManifest,
	type EndpointBackfillReport,
} from "../../../packages/core/src/model-endpoint-backfill";
import {
	buildEndpointBackfillApplyRequestDigest,
	type EndpointBackfillVerifiedAuthorization,
	type EndpointBackfillVerifiedEvidenceReviewer,
} from "../../../packages/core/src/model-endpoint-backfill-apply";
import {
	ENDPOINT_BACKFILL_EXIT,
	EndpointBackfillCliError,
} from "./contract";

export const ENDPOINT_BACKFILL_APPROVAL_VERSION =
	"cinatoken.endpoint-backfill-approval.v2" as const;
export const ENDPOINT_BACKFILL_APPROVAL_SIGNATURE_VERSION =
	"cinatoken.endpoint-backfill-approval-signature.v2" as const;
export const ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION =
	"cinatoken.endpoint-backfill-approval-key-registry.v1" as const;
export const ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV =
	"ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY" as const;

export const ENDPOINT_BACKFILL_APPROVAL_PURPOSES = [
	"manifest_actor",
	"evidence_reviewer",
	"apply_approver",
] as const;

export type EndpointBackfillApprovalPurpose =
	(typeof ENDPOINT_BACKFILL_APPROVAL_PURPOSES)[number];

export type EndpointBackfillApprovalSignature = {
	purpose: EndpointBackfillApprovalPurpose;
	/** Selects a trusted registry key. It is not itself a trust assertion. */
	key_id: string;
	signature: string;
};

export type EndpointBackfillApprovalHeader = {
	version: typeof ENDPOINT_BACKFILL_APPROVAL_VERSION;
	request_sha256: string;
	execution_sha256: string;
	trusted_signers_sha256: string;
	validation_passed: true;
	approved_at: string;
	expires_at: string;
};

export type EndpointBackfillApproval = EndpointBackfillApprovalHeader & {
	signatures: EndpointBackfillApprovalSignature[];
};

export type EndpointBackfillApprovalKeyRegistryEntry = {
	principal: string;
	public_key_pem: string;
	roles: EndpointBackfillApprovalPurpose[];
};

export type EndpointBackfillApprovalTrustedKey = {
	/** Derived from DER-encoded SPKI; never accepted from registry JSON. */
	key_id: string;
	principal: string;
	roles: ReadonlySet<EndpointBackfillApprovalPurpose>;
	public_key: KeyObject;
};

export type EndpointBackfillApprovalKeyRegistry = {
	version: typeof ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION;
	/** Canonical digest that must also be anchored immutably in the target DB. */
	trusted_signers_sha256: string;
	keys: ReadonlyMap<string, EndpointBackfillApprovalTrustedKey>;
};

const APPROVAL_KEYS = [
	"version",
	"request_sha256",
	"execution_sha256",
	"trusted_signers_sha256",
	"validation_passed",
	"approved_at",
	"expires_at",
	"signatures",
] as const;
const SIGNATURE_KEYS = ["purpose", "key_id", "signature"] as const;
const REGISTRY_KEYS = ["version", "keys"] as const;
const REGISTRY_ENTRY_KEYS = ["principal", "public_key_pem", "roles"] as const;
const MAX_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_SIGNATURES = 1024;
const MAX_REGISTRY_KEYS = 1024;
const MAX_REGISTRY_JSON_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^sha256:[0-9a-f]{64}$/u;
const RFC3339_UTC =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function inputError(message: string): never {
	throw new EndpointBackfillCliError(message, ENDPOINT_BACKFILL_EXIT.input);
}

function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	label: string
): void {
	const keys = Object.keys(value).sort(compareCodePoints);
	const sortedExpected = [...expected].sort(compareCodePoints);
	if (
		keys.length !== sortedExpected.length ||
		keys.some((key, index) => key !== sortedExpected[index])
	) {
		inputError(`${label} contains missing or unsupported fields`);
	}
}

function boundedString(
	value: unknown,
	label: string,
	max = 512
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > max ||
		value !== value.trim() ||
		/[\u0000-\u001f\u007f]/u.test(value)
	) {
		return inputError(
			`${label} must be a non-empty, trimmed string of at most ${max} characters`
		);
	}
	return value;
}

function pemString(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > 8192 ||
		/[\u0000\u007f]/u.test(value)
	) {
		return inputError(`${label} must be a bounded PEM public key`);
	}
	return value;
}

function sha256String(value: unknown, label: string): string {
	const digest = boundedString(value, label, 64);
	if (!SHA256.test(digest)) {
		return inputError(`${label} must be 64 lowercase hexadecimal characters`);
	}
	return digest;
}

function keyId(value: unknown, label: string): string {
	const id = boundedString(value, label, 71);
	if (!KEY_ID.test(id)) {
		return inputError(`${label} must be a derived sha256: SPKI fingerprint`);
	}
	return id;
}

function timestamp(value: unknown, label: string): string {
	const instant = boundedString(value, label, 40);
	const parsed = Date.parse(instant);
	if (!RFC3339_UTC.test(instant) || !Number.isFinite(parsed)) {
		return inputError(`${label} must be a valid UTC RFC 3339 instant`);
	}
	// Signatures and immutable ledger digests bind one lexical representation.
	return new Date(parsed).toISOString();
}

function purpose(value: unknown, label: string): EndpointBackfillApprovalPurpose {
	if (
		typeof value !== "string" ||
		!ENDPOINT_BACKFILL_APPROVAL_PURPOSES.includes(
			value as EndpointBackfillApprovalPurpose
		)
	) {
		return inputError(`${label} is not a supported approval role`);
	}
	return value as EndpointBackfillApprovalPurpose;
}

function canonicalSignature(value: unknown, label: string): string {
	const encoded = boundedString(value, label, 128);
	if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
		return inputError(`${label} must be canonical base64`);
	}
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length !== 64 || bytes.toString("base64") !== encoded) {
		return inputError(`${label} must be a canonical Ed25519 signature`);
	}
	return encoded;
}

function parseApprovalSignature(
	value: unknown,
	index: number
): EndpointBackfillApprovalSignature {
	if (!isRecord(value)) {
		return inputError(`approval.signatures[${index}] must be an object`);
	}
	assertExactKeys(value, SIGNATURE_KEYS, `approval.signatures[${index}]`);
	return {
		purpose: purpose(value.purpose, `approval.signatures[${index}].purpose`),
		key_id: keyId(value.key_id, `approval.signatures[${index}].key_id`),
		signature: canonicalSignature(
			value.signature,
			`approval.signatures[${index}].signature`
		),
	};
}

export function parseEndpointBackfillApproval(value: unknown): EndpointBackfillApproval {
	if (!isRecord(value)) return inputError("Approval must be a JSON object");
	assertExactKeys(value, APPROVAL_KEYS, "Approval");
	if (value.version !== ENDPOINT_BACKFILL_APPROVAL_VERSION) {
		return inputError(`Approval version must be ${ENDPOINT_BACKFILL_APPROVAL_VERSION}`);
	}
	if (value.validation_passed !== true) {
		return inputError("approval.validation_passed must be true");
	}
	if (
		!Array.isArray(value.signatures) ||
		value.signatures.length < 3 ||
		value.signatures.length > MAX_SIGNATURES
	) {
		return inputError(
			`approval.signatures must contain between 3 and ${MAX_SIGNATURES} signatures`
		);
	}
	const signatures = value.signatures.map(parseApprovalSignature);
	const signingKeys = new Set<string>();
	for (const signature of signatures) {
		if (signingKeys.has(signature.key_id)) {
			return inputError("Approval contains a duplicate signing key");
		}
		signingKeys.add(signature.key_id);
	}
	return {
		version: ENDPOINT_BACKFILL_APPROVAL_VERSION,
		request_sha256: sha256String(
			value.request_sha256,
			"approval.request_sha256"
		),
		execution_sha256: sha256String(
			value.execution_sha256,
			"approval.execution_sha256"
		),
		trusted_signers_sha256: sha256String(
			value.trusted_signers_sha256,
			"approval.trusted_signers_sha256"
		),
		validation_passed: true,
		approved_at: timestamp(value.approved_at, "approval.approved_at"),
		expires_at: timestamp(value.expires_at, "approval.expires_at"),
		signatures,
	};
}

function parseRegistryEntry(
	value: unknown,
	index: number
): EndpointBackfillApprovalKeyRegistryEntry {
	if (!isRecord(value)) {
		return inputError(`approval key registry keys[${index}] must be an object`);
	}
	assertExactKeys(value, REGISTRY_ENTRY_KEYS, `approval key registry keys[${index}]`);
	if (
		!Array.isArray(value.roles) ||
		value.roles.length === 0 ||
		value.roles.length > ENDPOINT_BACKFILL_APPROVAL_PURPOSES.length
	) {
		return inputError(`approval key registry keys[${index}].roles is invalid`);
	}
	const roles = value.roles.map((role, roleIndex) =>
		purpose(role, `approval key registry keys[${index}].roles[${roleIndex}]`)
	);
	if (new Set(roles).size !== roles.length) {
		return inputError(`approval key registry keys[${index}].roles contains duplicates`);
	}
	return {
		principal: boundedString(
			value.principal,
			`approval key registry keys[${index}].principal`,
			191
		),
		public_key_pem: pemString(
			value.public_key_pem,
			`approval key registry keys[${index}].public_key_pem`
		),
		roles,
	};
}

function publicEd25519Key(value: string, label: string): KeyObject {
	const normalized = value.replaceAll("\r\n", "\n").trim();
	const lines = normalized.split("\n");
	const body = lines.slice(1, -1);
	if (
		lines[0] !== "-----BEGIN PUBLIC KEY-----" ||
		lines.at(-1) !== "-----END PUBLIC KEY-----" ||
		body.length === 0 ||
		body.some((line, index) =>
			line.length === 0 ||
			line.length > 64 ||
			!/^[A-Za-z0-9+/]+={0,2}$/u.test(line) ||
			(index < body.length - 1 && line.includes("="))
		)
	) {
		return inputError(`${label} must be an SPKI PEM public key`);
	}
	let publicKey: KeyObject;
	try {
		publicKey = createPublicKey(normalized);
	} catch {
		return inputError(`${label} is not a valid public key`);
	}
	if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
		return inputError(`${label} must be an Ed25519 public key`);
	}
	return publicKey;
}

function derivedKeyId(publicKey: KeyObject): string {
	const spki = publicKey.export({ type: "spki", format: "der" });
	return `sha256:${createHash("sha256").update(spki).digest("hex")}`;
}

export function deriveEndpointBackfillApprovalKeyId(
	publicKeyPem: string
): string {
	return derivedKeyId(
		publicEd25519Key(publicKeyPem, "approval registry public key")
	);
}

function trustedRegistryProjection(
	trustedKeys: Iterable<EndpointBackfillApprovalTrustedKey>
): unknown {
	return {
		version: ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
		keys: [...trustedKeys]
			.map((trusted) => ({
				key_id: trusted.key_id,
				principal: trusted.principal,
				roles: [...trusted.roles].sort(compareCodePoints),
			}))
			.sort((left, right) => compareCodePoints(left.key_id, right.key_id)),
	};
}

export function sha256EndpointBackfillApprovalKeyRegistry(
	registry: Pick<EndpointBackfillApprovalKeyRegistry, "keys">
): string {
	return createHash("sha256")
		.update(stableEndpointBackfillJson(trustedRegistryProjection(registry.keys.values())))
		.digest("hex");
}

export function parseEndpointBackfillApprovalKeyRegistry(
	value: unknown
): EndpointBackfillApprovalKeyRegistry {
	if (!isRecord(value)) return inputError("Approval key registry must be a JSON object");
	assertExactKeys(value, REGISTRY_KEYS, "Approval key registry");
	if (value.version !== ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION) {
		return inputError(
			`Approval key registry version must be ${ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION}`
		);
	}
	if (
		!Array.isArray(value.keys) ||
		value.keys.length < 3 ||
		value.keys.length > MAX_REGISTRY_KEYS
	) {
		return inputError(
			`Approval key registry must contain between 3 and ${MAX_REGISTRY_KEYS} keys`
		);
	}
	const trustedKeys = new Map<string, EndpointBackfillApprovalTrustedKey>();
	for (const [index, raw] of value.keys.entries()) {
		const entry = parseRegistryEntry(raw, index);
		const publicKey = publicEd25519Key(
			entry.public_key_pem,
			`approval key registry keys[${index}].public_key_pem`
		);
		const key_id = derivedKeyId(publicKey);
		if (trustedKeys.has(key_id)) {
			return inputError("Approval key registry contains a duplicate public key");
		}
		trustedKeys.set(key_id, {
			key_id,
			principal: entry.principal,
			roles: new Set(entry.roles),
			public_key: publicKey,
		});
	}
	const registry = {
		version: ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
		trusted_signers_sha256: "",
		keys: trustedKeys,
	} satisfies EndpointBackfillApprovalKeyRegistry;
	return {
		...registry,
		trusted_signers_sha256: sha256EndpointBackfillApprovalKeyRegistry(registry),
	};
}

export function parseEndpointBackfillApprovalKeyRegistryEnv(
	env: Readonly<Record<string, string | undefined>>,
	variableName: string = ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV
): EndpointBackfillApprovalKeyRegistry {
	const serialized = env[variableName]?.trim();
	if (!serialized) return inputError(`${variableName} is required for apply`);
	if (Buffer.byteLength(serialized, "utf8") > MAX_REGISTRY_JSON_BYTES) {
		return inputError(`${variableName} exceeds the ${MAX_REGISTRY_JSON_BYTES} byte limit`);
	}
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		return inputError(`${variableName} must be valid JSON`);
	}
	return parseEndpointBackfillApprovalKeyRegistry(value);
}

export function endpointBackfillApprovalSignaturePayload(
	header: EndpointBackfillApprovalHeader,
	signer: Pick<EndpointBackfillApprovalSignature, "purpose" | "key_id">
): string {
	return stableEndpointBackfillJson({
		version: ENDPOINT_BACKFILL_APPROVAL_SIGNATURE_VERSION,
		request_sha256: header.request_sha256,
		execution_sha256: header.execution_sha256,
		trusted_signers_sha256: header.trusted_signers_sha256,
		validation_passed: header.validation_passed,
		approved_at: header.approved_at,
		expires_at: header.expires_at,
		purpose: signer.purpose,
		key_id: signer.key_id,
	});
}

/**
 * Creates the only header eligible for signatures. Consuming the complete dry
 * run report prevents signing a blocked execution or a digest copied from an
 * unrelated report.
 */
export async function buildEndpointBackfillApprovalHeader(input: {
	manifest: EndpointBackfillManifest;
	full_manifest_sha256: string;
	report: EndpointBackfillReport;
	trusted_signers_sha256: string;
	approved_at: string;
	expires_at: string;
}): Promise<EndpointBackfillApprovalHeader> {
	if (input.report.validation_passed !== true) {
		return inputError("Only a validation-passed execution may be approved");
	}
	const trustedSignersSha256 = sha256String(
		input.trusted_signers_sha256,
		"trusted_signers_sha256"
	);
	const digests = await buildEndpointBackfillApplyRequestDigest({
		full_manifest_sha256: input.full_manifest_sha256,
		manifest: input.manifest,
		execution_sha256: input.report.execution_sha256,
		trusted_signers_sha256: trustedSignersSha256,
	});
	if (
		input.report.manifest_sha256 !== input.full_manifest_sha256 ||
		input.report.selected_manifest_sha256 !== digests.selected_manifest_sha256 ||
		input.report.selection_sha256 !== digests.selection_sha256 ||
		input.report.source.database_fingerprint !==
			input.manifest.target.database_fingerprint
	) {
		return inputError("Dry-run report provenance does not match the selected manifest");
	}
	return {
		version: ENDPOINT_BACKFILL_APPROVAL_VERSION,
		request_sha256: digests.request_sha256,
		execution_sha256: input.report.execution_sha256,
		trusted_signers_sha256: trustedSignersSha256,
		validation_passed: true,
		approved_at: timestamp(input.approved_at, "approval.approved_at"),
		expires_at: timestamp(input.expires_at, "approval.expires_at"),
	};
}

function assertApprovalValidity(
	approval: EndpointBackfillApprovalHeader,
	now: Date
): void {
	if (!Number.isFinite(now.getTime())) return inputError("Approval verifier clock is invalid");
	const approvedAt = Date.parse(approval.approved_at);
	const expiresAt = Date.parse(approval.expires_at);
	if (
		!Number.isFinite(approvedAt) ||
		!Number.isFinite(expiresAt) ||
		expiresAt <= approvedAt ||
		expiresAt - approvedAt > MAX_APPROVAL_LIFETIME_MS
	) {
		return inputError("Approval validity must be positive and at most 24 hours");
	}
	if (approvedAt > now.getTime() + MAX_CLOCK_SKEW_MS || expiresAt <= now.getTime()) {
		return inputError("Approval is not currently valid");
	}
}

function expectedReviewerCoverage(
	manifest: EndpointBackfillManifest
): Map<string, string[]> {
	const reviewers = new Map<string, string[]>();
	for (const endpoint of manifest.endpoints) {
		const endpointIds = reviewers.get(endpoint.evidence.reviewed_by);
		if (endpointIds) endpointIds.push(endpoint.id);
		else reviewers.set(endpoint.evidence.reviewed_by, [endpoint.id]);
	}
	for (const endpointIds of reviewers.values()) {
		endpointIds.sort(compareCodePoints);
	}
	return reviewers;
}

function trustedKeyForSignature(
	registry: EndpointBackfillApprovalKeyRegistry,
	signature: EndpointBackfillApprovalSignature
): EndpointBackfillApprovalTrustedKey {
	const trusted = registry.keys.get(signature.key_id);
	if (!trusted) return inputError("Approval signature references an untrusted key");
	const fingerprint = derivedKeyId(trusted.public_key);
	if (trusted.key_id !== fingerprint || signature.key_id !== fingerprint) {
		return inputError("Approval registry key identity does not match its SPKI fingerprint");
	}
	if (!trusted.roles.has(signature.purpose)) {
		return inputError("Approval signer is not trusted for the declared role");
	}
	return trusted;
}

export async function verifyEndpointBackfillApproval(input: {
	approval: EndpointBackfillApproval;
	manifest: EndpointBackfillManifest;
	full_manifest_sha256: string;
	registry?: EndpointBackfillApprovalKeyRegistry;
	/** @deprecated v1 single-key authorization is fail-closed and unsupported. */
	public_key_pem?: string;
	now: Date;
}): Promise<EndpointBackfillVerifiedAuthorization> {
	const approval = parseEndpointBackfillApproval(input.approval);
	if (!input.registry) {
		return inputError(
			`${ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV} v1 registry is required; legacy single-key approvals are unsupported`
		);
	}
	const registryDigest = sha256EndpointBackfillApprovalKeyRegistry(input.registry);
	if (
		input.registry.trusted_signers_sha256 !== registryDigest ||
		approval.trusted_signers_sha256 !== registryDigest
	) {
		return inputError("Approval does not bind the canonical trusted signer registry");
	}
	assertApprovalValidity(approval, input.now);
	const expected = await buildEndpointBackfillApplyRequestDigest({
		full_manifest_sha256: input.full_manifest_sha256,
		manifest: input.manifest,
		execution_sha256: approval.execution_sha256,
		trusted_signers_sha256: approval.trusted_signers_sha256,
	});
	if (approval.request_sha256 !== expected.request_sha256) {
		return inputError("Approval does not bind this manifest selection, execution, and database");
	}

	const verified = approval.signatures.map((signature) => {
		const trusted = trustedKeyForSignature(input.registry!, signature);
		if (
			!verify(
				null,
				Buffer.from(
					endpointBackfillApprovalSignaturePayload(approval, signature),
					"utf8"
				),
				trusted.public_key,
				Buffer.from(signature.signature, "base64")
			)
		) {
			return inputError("Endpoint backfill approval signature is invalid");
		}
		return {
			purpose: signature.purpose,
			principal: trusted.principal,
			key_id: trusted.key_id,
		};
	});

	const actorSigners = verified.filter((signer) => signer.purpose === "manifest_actor");
	const approverSigners = verified.filter((signer) => signer.purpose === "apply_approver");
	const reviewerSigners = verified.filter(
		(signer) => signer.purpose === "evidence_reviewer"
	);
	if (
		actorSigners.length !== 1 ||
		actorSigners[0]?.principal !== input.manifest.actor_id
	) {
		return inputError("Approval requires exactly one trusted manifest actor signature");
	}
	if (approverSigners.length !== 1) {
		return inputError("Approval requires exactly one trusted apply approver signature");
	}

	const expectedReviewers = expectedReviewerCoverage(input.manifest);
	const reviewerPrincipals = new Set<string>();
	const evidenceReviewers: EndpointBackfillVerifiedEvidenceReviewer[] = [];
	for (const signer of reviewerSigners) {
		const endpointIds = expectedReviewers.get(signer.principal);
		if (!endpointIds || reviewerPrincipals.has(signer.principal)) {
			return inputError(
				"Evidence reviewer signatures do not exactly cover the selected manifest"
			);
		}
		reviewerPrincipals.add(signer.principal);
		evidenceReviewers.push({
			principal: signer.principal,
			key_id: signer.key_id,
			endpoint_ids: [...endpointIds],
		});
	}
	if (
		reviewerPrincipals.size !== expectedReviewers.size ||
		[...expectedReviewers.keys()].some(
			(principal) => !reviewerPrincipals.has(principal)
		)
	) {
		return inputError(
			"Every selected manifest evidence reviewer requires one trusted signature"
		);
	}

	const signers = [actorSigners[0]!, ...evidenceReviewers, approverSigners[0]!];
	if (
		new Set(signers.map((signer) => signer.principal)).size !== signers.length ||
		new Set(signers.map((signer) => signer.key_id)).size !== signers.length
	) {
		return inputError(
			"Manifest actor, evidence reviewers, and apply approver require distinct principals and keys"
		);
	}
	evidenceReviewers.sort(
		(left, right) =>
			compareCodePoints(left.principal, right.principal) ||
			compareCodePoints(left.key_id, right.key_id)
	);
	return {
		request_sha256: approval.request_sha256,
		execution_sha256: approval.execution_sha256,
		trusted_signers_sha256: approval.trusted_signers_sha256,
		validation_passed: true,
		approved_at: approval.approved_at,
		expires_at: approval.expires_at,
		manifest_actor: {
			principal: actorSigners[0]!.principal,
			key_id: actorSigners[0]!.key_id,
		},
		evidence_reviewers: evidenceReviewers,
		apply_approver: {
			principal: approverSigners[0]!.principal,
			key_id: approverSigners[0]!.key_id,
		},
	};
}
