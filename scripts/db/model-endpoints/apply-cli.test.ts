import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import {
	ENDPOINT_BACKFILL_MANIFEST_VERSION,
	parseEndpointBackfillManifest,
	sha256EndpointBackfillValue,
} from "../../../packages/core/src/model-endpoint-backfill";
import {
	ENDPOINT_BACKFILL_APPLY_REPORT_VERSION,
	EndpointBackfillApplyError,
	buildEndpointBackfillApplyRequestDigest,
	type EndpointBackfillApplyReport,
} from "../../../packages/core/src/model-endpoint-backfill-apply";
import {
	ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV,
	ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
	ENDPOINT_BACKFILL_APPROVAL_VERSION,
	deriveEndpointBackfillApprovalKeyId,
	endpointBackfillApprovalSignaturePayload,
	parseEndpointBackfillApprovalKeyRegistry,
	type EndpointBackfillApproval,
	type EndpointBackfillApprovalHeader,
	type EndpointBackfillApprovalPurpose,
} from "./authorization";
import { executeEndpointBackfillApply } from "./cli";
import {
	ENDPOINT_BACKFILL_EXIT,
	EndpointBackfillDatabaseError,
} from "./contract";

const NOW = new Date("2026-08-31T01:00:00.000Z");
const FINGERPRINT = `sha256:${"f".repeat(64)}`;
const EXECUTION = "e".repeat(64);

function rawManifest(): unknown {
	return {
		version: ENDPOINT_BACKFILL_MANIFEST_VERSION,
		manifest_id: "CHG-apply-cli",
		created_at: "2026-08-31T00:00:00.000Z",
		actor_id: "cinaauth:actor",
		target: {
			driver: "postgres",
			database_fingerprint: FINGERPRINT,
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
				context_length: 128_000,
				max_prompt_tokens: 120_000,
				max_completion_tokens: 8_000,
				quantization: null,
				supported_parameters: ["temperature"],
				pricing: {
					currency: "USD",
					prompt: "0.000001",
					completion: "0.000002",
				},
				supports_implicit_caching: false,
				supports_voice_cloning: false,
				supports_tool_choice: {
					auto: true,
					function: true,
					none: true,
					required: true,
				},
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
	};
}

function signer(principal: string, role: EndpointBackfillApprovalPurpose) {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		principal,
		role,
		public_key_pem: publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		privateKey,
	};
}

async function fixture() {
	const manifest = parseEndpointBackfillManifest(rawManifest());
	const fullManifestSha256 = await sha256EndpointBackfillValue(manifest);
	const signers = [
		signer("cinaauth:actor", "manifest_actor"),
		signer("cinaauth:reviewer", "evidence_reviewer"),
		signer("cinaauth:approver", "apply_approver"),
	];
	const registryJson = {
		version: ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_VERSION,
		keys: signers.map((entry) => ({
			principal: entry.principal,
			public_key_pem: entry.public_key_pem,
			roles: [entry.role],
		})),
	};
	const registry = parseEndpointBackfillApprovalKeyRegistry(registryJson);
	const digests = await buildEndpointBackfillApplyRequestDigest({
		full_manifest_sha256: fullManifestSha256,
		manifest,
		execution_sha256: EXECUTION,
		trusted_signers_sha256: registry.trusted_signers_sha256,
	});
	const header: EndpointBackfillApprovalHeader = {
		version: ENDPOINT_BACKFILL_APPROVAL_VERSION,
		request_sha256: digests.request_sha256,
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
					Buffer.from(
						endpointBackfillApprovalSignaturePayload(header, {
							purpose: entry.role,
							key_id,
						})
					),
					entry.privateKey
				).toString("base64"),
			};
		}),
	};
	const report: EndpointBackfillApplyReport = {
		version: ENDPOINT_BACKFILL_APPLY_REPORT_VERSION,
		mode: "apply",
		status: "applied",
		apply_supported: true,
		authorization_verified: true,
		transactional: true,
		generated_at: NOW.toISOString(),
		applied_at: NOW.toISOString(),
		idempotency_key: "i".repeat(64),
		manifest_id: manifest.manifest_id,
		manifest_sha256: fullManifestSha256,
		selected_manifest_sha256: digests.selected_manifest_sha256,
		selection_sha256: digests.selection_sha256,
		request_sha256: digests.request_sha256,
		execution_sha256: EXECUTION,
		trusted_signers_sha256: registry.trusted_signers_sha256,
		authorization_sha256: "b".repeat(64),
		database_fingerprint: FINGERPRINT,
		manifest_actor_id: "cinaauth:actor",
		manifest_actor_key_id: deriveEndpointBackfillApprovalKeyId(
			signers[0]!.public_key_pem
		),
		evidence_reviewers: [
			{
				principal: "cinaauth:reviewer",
				key_id: deriveEndpointBackfillApprovalKeyId(signers[1]!.public_key_pem),
				endpoint_ids: ["endpoint-1"],
			},
		],
		approved_by: "cinaauth:approver",
		approval_key_id: deriveEndpointBackfillApprovalKeyId(
			signers[2]!.public_key_pem
		),
		approval_approved_at: header.approved_at,
		approval_expires_at: header.expires_at,
		actions: 1,
		endpoints: 1,
	};
	return { approval, manifest, registryJson, report };
}

function args(): string[] {
	return [
		"apply",
		"--apply",
		"--driver=postgres",
		`--manifest=${resolve("manifest.json")}`,
		`--approval=${resolve("approval.json")}`,
		`--report=${resolve("apply-report.json")}`,
		"--all-manifest",
	];
}

function unusableStore() {
	return {
		serializableTransaction: async () => {
			throw new Error("stub apply must not invoke the store");
		},
	};
}

test("apply reserves the final report before mutation and publishes after commit", async () => {
	const value = await fixture();
	const events: string[] = [];
	const result = await executeEndpointBackfillApply(
		args(),
		{
			ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT,
			[ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV]: JSON.stringify(
				value.registryJson
			),
		},
		{
			readManifest: async () => value.manifest,
			readApproval: async () => value.approval,
			reserveReport: async () => {
				events.push("reserve");
				return {
					publish: async () => {
						events.push("publish");
					},
					preserve: async () => {
						events.push("preserve");
					},
					abandon: async () => {
						events.push("abandon");
					},
				};
			},
			createStore: () => {
				events.push("create-store");
				return unusableStore();
			},
			apply: async () => {
				events.push("apply");
				return value.report;
			},
			now: () => NOW,
		}
	);
	assert.equal(result.exitCode, ENDPOINT_BACKFILL_EXIT.ok);
	assert.equal(result.reportWritten, true);
	assert.deepEqual(events, ["reserve", "create-store", "apply", "publish"]);
});

test("pre-commit apply failures abandon the reservation and preserve drift exit 5", async () => {
	const value = await fixture();
	let abandoned = false;
	const result = await executeEndpointBackfillApply(
		args(),
		{
			ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT,
			[ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV]: JSON.stringify(
				value.registryJson
			),
		},
		{
			readManifest: async () => value.manifest,
			readApproval: async () => value.approval,
			reserveReport: async () => ({
				publish: async () => undefined,
				preserve: async () => undefined,
				abandon: async () => {
					abandoned = true;
				},
			}),
			createStore: () => unusableStore(),
			apply: async () => {
				throw new EndpointBackfillApplyError(
					"execution_mismatch",
					"approved execution changed"
				);
			},
			now: () => NOW,
		}
	);
	assert.equal(result.exitCode, ENDPOINT_BACKFILL_EXIT.drift);
	assert.equal(abandoned, true);
});

test("post-commit report failure leaves the marker and returns recovery exit 7", async () => {
	const value = await fixture();
	let abandoned = false;
	let preserved = false;
	const result = await executeEndpointBackfillApply(
		args(),
		{
			ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT,
			[ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV]: JSON.stringify(
				value.registryJson
			),
		},
		{
			readManifest: async () => value.manifest,
			readApproval: async () => value.approval,
			reserveReport: async () => ({
				publish: async () => {
					throw new Error("disk full");
				},
				preserve: async () => {
					preserved = true;
				},
				abandon: async () => {
					abandoned = true;
				},
			}),
			createStore: () => unusableStore(),
			apply: async () => value.report,
			now: () => NOW,
		}
	);
	assert.equal(result.exitCode, ENDPOINT_BACKFILL_EXIT.committedReportPending);
	assert.equal(result.reportWritten, false);
	assert.equal(abandoned, false);
	assert.equal(preserved, true);
	assert.match(result.message, /committed_report_pending/u);
	assert.match(result.message, new RegExp(value.report.idempotency_key, "u"));
});

test("an uncertain database outcome preserves the marker for idempotent reconciliation", async () => {
	const value = await fixture();
	let abandoned = false;
	let preserved = false;
	const result = await executeEndpointBackfillApply(
		args(),
		{
			ENDPOINT_BACKFILL_DATABASE_FINGERPRINT: FINGERPRINT,
			[ENDPOINT_BACKFILL_APPROVAL_KEY_REGISTRY_ENV]: JSON.stringify(
				value.registryJson
			),
		},
		{
			readManifest: async () => value.manifest,
			readApproval: async () => value.approval,
			reserveReport: async () => ({
				publish: async () => undefined,
				preserve: async () => {
					preserved = true;
				},
				abandon: async () => {
					abandoned = true;
				},
			}),
			createStore: () => unusableStore(),
			apply: async () => {
				throw new EndpointBackfillDatabaseError(
					"database transaction completion is unknown"
				);
			},
			now: () => NOW,
		}
	);
	assert.equal(result.exitCode, ENDPOINT_BACKFILL_EXIT.database);
	assert.equal(preserved, true);
	assert.equal(abandoned, false);
	assert.match(result.message, /database_outcome_requires_reconciliation/u);
});
