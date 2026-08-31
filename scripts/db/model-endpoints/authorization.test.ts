import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
	ENDPOINT_BACKFILL_MANIFEST_VERSION,
	parseEndpointBackfillManifest,
	sha256EndpointBackfillValue,
} from "../../../packages/core/src/model-endpoint-backfill";
import { buildEndpointBackfillApplyRequestDigest } from "../../../packages/core/src/model-endpoint-backfill-apply";
import {
	ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
	ENDPOINT_BACKFILL_APPROVAL_VERSION,
	deriveEndpointBackfillApprovalKeyId,
	endpointBackfillApprovalSignaturePayload,
	parseEndpointBackfillApproval,
	parseEndpointBackfillApprovalKeyRegistry,
	sha256EndpointBackfillApprovalKeyRegistry,
	verifyEndpointBackfillApproval,
	type EndpointBackfillApproval,
	type EndpointBackfillApprovalHeader,
	type EndpointBackfillApprovalPurpose,
} from "./authorization";

const NOW = new Date("2026-08-31T01:00:00.000Z");
const EXECUTION = "e".repeat(64);

function manifest() {
	return parseEndpointBackfillManifest({
		version: ENDPOINT_BACKFILL_MANIFEST_VERSION,
		manifest_id: "CHG-auth-v2",
		created_at: "2026-08-31T00:00:00.000Z",
		actor_id: "cinaauth:actor",
		target: {
			driver: "postgres",
			database_fingerprint: `sha256:${"f".repeat(64)}`,
			required_migration: "0048_model_endpoint_audio_capabilities.sql",
		},
		policy: {
			allow_create: true,
			allow_material_update: false,
			allow_draft_promotion: false,
			allow_route_link_changes: false,
		},
		endpoints: [
			{
				id: "endpoint-1",
				expected_updated_at: null,
				model_id: "model-1",
				provider_id: "provider-1",
				provider_slug: "provider-one",
				tag: "provider-one",
				endpoint_class: null,
				region: null,
				context_length: 128000,
				max_prompt_tokens: 120000,
				max_completion_tokens: 8000,
				quantization: null,
				supported_parameters: ["temperature"],
				pricing: { currency: "USD", prompt: "0.000001", completion: "0.000002" },
				supports_implicit_caching: false,
				supports_voice_cloning: false,
				supports_tool_choice: { auto: true, function: true, none: true, required: true },
				image_capabilities: null,
				audio_capabilities: null,
				evidence: {
					url: "https://provider.example/pricing",
					observed_at: "2026-08-30T00:00:00.000Z",
					expires_at: "2026-09-30T00:00:00.000Z",
					sha256: "a".repeat(64),
					reviewed_by: "cinaauth:reviewer",
				},
				route_target_ids: ["route-1"],
			},
		],
	});
}

function signer(principal: string, role: EndpointBackfillApprovalPurpose) {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const public_key_pem = publicKey.export({ type: "spki", format: "pem" }).toString();
	return { principal, role, public_key_pem, privateKey };
}

async function fixture() {
	const selected = manifest();
	const fullManifestSha256 = await sha256EndpointBackfillValue(selected);
	const signers = [
		signer("cinaauth:actor", "manifest_actor"),
		signer("cinaauth:reviewer", "evidence_reviewer"),
		signer("cinaauth:approver", "apply_approver"),
	];
	const registry = parseEndpointBackfillApprovalKeyRegistry({
		version: ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
		keys: signers.map((entry) => ({
			principal: entry.principal,
			public_key_pem: entry.public_key_pem,
			roles: [entry.role],
		})),
	});
	const request = await buildEndpointBackfillApplyRequestDigest({
		full_manifest_sha256: fullManifestSha256,
		manifest: selected,
		execution_sha256: EXECUTION,
		trusted_signers_sha256: registry.trusted_signers_sha256,
	});
	const header: EndpointBackfillApprovalHeader = {
		version: ENDPOINT_BACKFILL_APPROVAL_VERSION,
		request_sha256: request.request_sha256,
		execution_sha256: EXECUTION,
		trusted_signers_sha256: registry.trusted_signers_sha256,
		validation_passed: true,
		approved_at: "2026-08-31T00:30:00.000Z",
		expires_at: "2026-08-31T02:00:00.000Z",
	};
	const approval: EndpointBackfillApproval = {
		...header,
		signatures: signers.map((entry) => {
			const key_id = deriveEndpointBackfillApprovalKeyId(entry.public_key_pem);
			return {
				purpose: entry.role,
				key_id,
				signature: sign(
					null,
					Buffer.from(endpointBackfillApprovalSignaturePayload(header, { purpose: entry.role, key_id })),
					entry.privateKey
				).toString("base64"),
			};
		}),
	};
	return { selected, fullManifestSha256, signers, registry, approval };
}

test("v2 verifies independent registry-derived actor, reviewer, and approver signatures", async () => {
	const value = await fixture();
	assert.equal(
		parseEndpointBackfillApproval({
			...value.approval,
			approved_at: "2026-08-31T00:30:00.1Z",
		}).approved_at,
		"2026-08-31T00:30:00.100Z"
	);
	const authorization = await verifyEndpointBackfillApproval({
		approval: parseEndpointBackfillApproval(value.approval),
		manifest: value.selected,
		full_manifest_sha256: value.fullManifestSha256,
		registry: value.registry,
		now: NOW,
	});
	assert.equal(authorization.validation_passed, true);
	assert.equal(authorization.trusted_signers_sha256, value.registry.trusted_signers_sha256);
	assert.equal(authorization.manifest_actor.principal, "cinaauth:actor");
	assert.deepEqual(authorization.evidence_reviewers[0]?.endpoint_ids, ["endpoint-1"]);
	assert.equal(authorization.apply_approver.principal, "cinaauth:approver");
	assert.equal(
		value.registry.trusted_signers_sha256,
		sha256EndpointBackfillApprovalKeyRegistry(value.registry)
	);
	const reordered = parseEndpointBackfillApprovalKeyRegistry({
		version: ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
		keys: [...value.signers].reverse().map((entry) => ({
			principal: entry.principal,
			public_key_pem: entry.public_key_pem,
			roles: [entry.role],
		})),
	});
	assert.equal(reordered.trusted_signers_sha256, value.registry.trusted_signers_sha256);
});

test("v2 rejects execution replay, omitted reviewer, and a mutable trust root", async () => {
	const value = await fixture();
	await assert.rejects(
		verifyEndpointBackfillApproval({
			approval: { ...value.approval, execution_sha256: "d".repeat(64) },
			manifest: value.selected,
			full_manifest_sha256: value.fullManifestSha256,
			registry: value.registry,
			now: NOW,
		}),
		/does not bind this manifest selection, execution, and database/u
	);
	await assert.rejects(
		verifyEndpointBackfillApproval({
			approval: {
				...value.approval,
				signatures: value.approval.signatures.filter(
					(signature) => signature.purpose !== "evidence_reviewer"
				),
			},
			manifest: value.selected,
			full_manifest_sha256: value.fullManifestSha256,
			registry: value.registry,
			now: NOW,
		}),
		/signatures must contain between 3/u
	);

	const rogue = [
		signer("cinaauth:actor", "manifest_actor"),
		signer("cinaauth:reviewer", "evidence_reviewer"),
		signer("cinaauth:approver", "apply_approver"),
	];
	const rogueRegistry = parseEndpointBackfillApprovalKeyRegistry({
		version: ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
		keys: rogue.map((entry) => ({
			principal: entry.principal,
			public_key_pem: entry.public_key_pem,
			roles: [entry.role],
		})),
	});
	assert.notEqual(rogueRegistry.trusted_signers_sha256, value.registry.trusted_signers_sha256);
	await assert.rejects(
		verifyEndpointBackfillApproval({
			approval: value.approval,
			manifest: value.selected,
			full_manifest_sha256: value.fullManifestSha256,
			registry: rogueRegistry,
			now: NOW,
		}),
		/does not bind the canonical trusted signer registry/u
	);

	const samePrincipalRegistry = parseEndpointBackfillApprovalKeyRegistry({
		version: ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
		keys: value.signers.map((entry, index) => ({
			principal: index === 2 ? "cinaauth:actor" : entry.principal,
			public_key_pem: entry.public_key_pem,
			roles: [entry.role],
		})),
	});
	assert.notEqual(
		samePrincipalRegistry.trusted_signers_sha256,
		value.registry.trusted_signers_sha256
	);
});

test("registry accepts only Ed25519 SPKI public PEM and never derives from private PEM", async () => {
	const value = await fixture();
	const privatePem = value.signers[0]!.privateKey
		.export({ type: "pkcs8", format: "pem" })
		.toString();
	assert.throws(
		() => deriveEndpointBackfillApprovalKeyId(privatePem),
		/SPKI PEM public key/u
	);
	assert.throws(
		() => parseEndpointBackfillApprovalKeyRegistry({
			version: ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
			keys: value.signers.map((entry, index) => ({
				principal: entry.principal,
				public_key_pem: index === 0 ? privatePem : entry.public_key_pem,
				roles: [entry.role],
			})),
		}),
		/SPKI PEM public key/u
	);
	assert.match(
		deriveEndpointBackfillApprovalKeyId(value.signers[0]!.public_key_pem),
		/^sha256:[0-9a-f]{64}$/u
	);
});

test("signature verification remains usable for ledger recovery after evidence expiry", async () => {
	const value = await fixture();
	const header: EndpointBackfillApprovalHeader = {
		version: ENDPOINT_BACKFILL_APPROVAL_VERSION,
		request_sha256: value.approval.request_sha256,
		execution_sha256: value.approval.execution_sha256,
		trusted_signers_sha256: value.approval.trusted_signers_sha256,
		validation_passed: true,
		approved_at: "2026-10-01T00:30:00.000Z",
		expires_at: "2026-10-01T02:00:00.000Z",
	};
	const approval: EndpointBackfillApproval = {
		...header,
		signatures: value.signers.map((entry) => {
			const key_id = deriveEndpointBackfillApprovalKeyId(entry.public_key_pem);
			return {
				purpose: entry.role,
				key_id,
				signature: sign(
					null,
					Buffer.from(endpointBackfillApprovalSignaturePayload(header, {
						purpose: entry.role,
						key_id,
					})),
					entry.privateKey
				).toString("base64"),
			};
		}),
	};
	const authorization = await verifyEndpointBackfillApproval({
		approval,
		manifest: value.selected,
		full_manifest_sha256: value.fullManifestSha256,
		registry: value.registry,
		now: new Date("2026-10-01T01:00:00.000Z"),
	});
	assert.equal(authorization.validation_passed, true);
});
