import assert from "node:assert/strict";
import test from "node:test";
import {
	ENDPOINT_BACKFILL_MANIFEST_VERSION,
	EndpointBackfillManifestError,
	parseEndpointBackfillManifest,
	planEndpointBackfill,
	sha256EndpointBackfillValue,
	type EndpointBackfillInventory,
	type EndpointBackfillManifest,
} from "./model-endpoint-backfill";
import { computeRouteDataPolicySubjectFingerprintFromRows } from "./route-data-policy";
import type { ModelEndpointRow } from "./db/model-endpoints-types";
import type { ModelRouteRow, ProviderRow } from "./types";
import {
	EndpointBackfillApplyError,
	applyEndpointBackfill,
	buildEndpointBackfillApplyRequestDigest,
	serializeEndpointBackfillVerifiedEvidenceReviewers,
	type EndpointBackfillApplyRun,
	type EndpointBackfillApplyStore,
	type EndpointBackfillApplyTransaction,
	type EndpointBackfillVerifiedAuthorization,
} from "./model-endpoint-backfill-apply";

const NOW = new Date("2026-08-30T10:00:00.000Z");
const PROVIDER: ProviderRow = {
	id: "provider-1",
	name: "Provider One",
	endpoints: JSON.stringify({
		openai: { base: "https://provider.example/v1" },
	}),
	api_key: "sk-provider-secret",
	status: "active",
	description: null,
	shared_channel_type: null,
	created_at: "2026-01-01T00:00:00.000Z",
};
const ROUTE: ModelRouteRow = {
	id: "route-1",
	model_id: "model-1",
	provider_id: PROVIDER.id,
	provider_model_name: "upstream-model-1",
	priority: 10,
	status: "active",
	route_group: "default",
	weight: 1,
	price_override: null,
	custom_params: null,
	routing_metadata: null,
	upstream_protocol: "openai",
	route_pool_id: "pool-1",
	upstream_operation: "chat",
	adapter: "passthrough",
};

function rawManifest(overrides: Record<string, unknown> = {}): unknown {
	return {
		version: ENDPOINT_BACKFILL_MANIFEST_VERSION,
		manifest_id: "CHG-2026-0001",
		created_at: "2026-08-30T09:00:00.000Z",
		actor_id: "cinaauth:admin-1",
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
				provider_id: PROVIDER.id,
				provider_slug: "provider-one",
				tag: "provider-one",
				endpoint_class: null,
				region: null,
				context_length: 128_000,
				max_prompt_tokens: 120_000,
				max_completion_tokens: 8_000,
				quantization: null,
				supported_parameters: ["temperature", "tool_choice"],
				pricing: {
					currency: "USD",
					prompt: "0.00000100",
					completion: "0.00000200",
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
					observed_at: "2026-08-29T00:00:00.000Z",
					expires_at: "2026-11-30T00:00:00.000Z",
					sha256: "a".repeat(64),
					reviewed_by: "cinaauth:reviewer-1",
				},
				route_target_ids: [ROUTE.id],
			},
		],
		...overrides,
	};
}

function manifest(overrides: Record<string, unknown> = {}): EndpointBackfillManifest {
	return parseEndpointBackfillManifest(rawManifest(overrides));
}

function inventory(
	overrides: Partial<EndpointBackfillInventory> = {}
): EndpointBackfillInventory {
	const value: EndpointBackfillInventory = {
		source: {
			driver: "postgres",
			database_fingerprint: `sha256:${"f".repeat(64)}`,
			required_migration: "0048_model_endpoint_audio_capabilities.sql",
			migration_head: "0048_model_endpoint_audio_capabilities.sql",
			migration_present: true,
		},
		models: [{ id: "model-1" }],
		providers: [PROVIDER],
		routes: [ROUTE],
		endpoints: [],
		links: [],
		...overrides,
	};
	value.consistency ??= {
		semantics: "repository-double-read",
		snapshot_consistent: false,
		before: {
			rows_sha256: `sha256:${"1".repeat(64)}`,
			version_vector: {
				migration_head: value.source.migration_head,
				models: value.models.length,
				providers: value.providers.length,
				routes: value.routes.length,
				endpoints: value.endpoints.length,
				links: value.links.length,
				endpoint_revisions_sha256: `sha256:${"2".repeat(64)}`,
				link_revisions_sha256: `sha256:${"3".repeat(64)}`,
			},
		},
		after: {
			rows_sha256: `sha256:${"1".repeat(64)}`,
			version_vector: {
				migration_head: value.source.migration_head,
				models: value.models.length,
				providers: value.providers.length,
				routes: value.routes.length,
				endpoints: value.endpoints.length,
				links: value.links.length,
				endpoint_revisions_sha256: `sha256:${"2".repeat(64)}`,
				link_revisions_sha256: `sha256:${"3".repeat(64)}`,
			},
		},
		drifted: false,
	};
	return value;
}

function endpointRow(
	parsed: EndpointBackfillManifest,
	overrides: Partial<ModelEndpointRow> = {}
): ModelEndpointRow {
	const endpoint = parsed.endpoints[0]!;
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
		supported_parameters: JSON.stringify(endpoint.supported_parameters),
		pricing: JSON.stringify(endpoint.pricing ?? {}),
		supports_implicit_caching: endpoint.supports_implicit_caching,
		supports_voice_cloning: endpoint.supports_voice_cloning,
		supports_tool_choice: JSON.stringify(endpoint.supports_tool_choice),
		image_capabilities: JSON.stringify(endpoint.image_capabilities ?? {}),
		audio_capabilities: JSON.stringify(endpoint.audio_capabilities ?? {}),
		evidence_url: endpoint.evidence.url,
		verified_by: parsed.actor_id,
		verified_at: NOW.toISOString(),
		expires_at: endpoint.evidence.expires_at,
		status: "verified",
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-30T08:00:00.000Z",
		...overrides,
	};
}

function withExpectedExisting(
	parsed: EndpointBackfillManifest,
	row: ModelEndpointRow,
	policy: Partial<EndpointBackfillManifest["policy"]> = {}
): EndpointBackfillManifest {
	return {
		...parsed,
		policy: { ...parsed.policy, allow_create: false, ...policy },
		endpoints: [
			{
				...parsed.endpoints[0]!,
				expected_updated_at: row.updated_at,
			},
		],
	};
}

test("strictly parses and canonicalizes an explicit manifest", () => {
	const parsed = manifest();
	assert.equal(parsed.endpoints[0]?.pricing?.prompt, "0.000001");
	assert.equal(parsed.endpoints[0]?.evidence.url, "https://provider.example/pricing");
	assert.deepEqual(parsed.endpoints[0]?.route_target_ids, ["route-1"]);

	assert.throws(
		() =>
			parseEndpointBackfillManifest({
				...(rawManifest() as Record<string, unknown>),
				legacy_pricing_profile: {},
			}),
		(error: unknown) =>
			error instanceof EndpointBackfillManifestError &&
			/unsupported key: legacy_pricing_profile/u.test(error.message)
	);
});

test("rejects contradictory voice-cloning evidence in a backfill manifest", () => {
	const input = rawManifest() as Record<string, unknown>;
	const endpoint = {
		...((input.endpoints as Array<Record<string, unknown>>)[0] ?? {}),
		supports_voice_cloning: false,
		audio_capabilities: {
			v: 1,
			pricing_by_operation: {
				"audio.speech": {
					currency: "USD",
					meter: {
						kind: "characters",
						unit: "unicode_code_point",
						price: "0.00002",
						minimum_units: 0,
						increment_units: 1,
					},
				},
			},
			speech_by_operation: {
				"audio.speech": {
					supports_default_voice: false,
					reference_audio_media_types: ["audio/wav"],
					reference_audio_default_media_type: "audio/wav",
				},
			},
		},
	};
	assert.throws(
		() => parseEndpointBackfillManifest({ ...input, endpoints: [endpoint] }),
		(error: unknown) =>
			error instanceof EndpointBackfillManifestError &&
			/reference-audio evidence requires supports_voice_cloning=true/u.test(
				error.message
			)
	);
});

test("plans a deterministic create without serializing provider credentials", async () => {
	const parsed = manifest();
	const first = await planEndpointBackfill(parsed, inventory(), NOW);
	const second = await planEndpointBackfill(parsed, inventory(), NOW);

	assert.equal(first.validation_passed, true);
	assert.equal(first.ready_to_apply, false);
	assert.equal(first.apply_supported, false);
	assert.equal(first.authorization_verified, false);
	assert.equal(first.legacy_evidence_used, false);
	assert.equal(first.endpoints[0]?.disposition, "create_and_verify");
	assert.deepEqual(
		first.endpoints[0]?.actions.map((action) => action.type),
		["create_endpoint_draft", "link_route", "publish_verification"]
	);
	assert.match(
		first.endpoints[0]?.route_subjects[0]?.proposed_fingerprint ?? "",
		/^[0-9a-f]{64}$/u
	);
	assert.equal(first.plan_sha256, second.plan_sha256);
	assert.equal(JSON.stringify(first).includes(PROVIDER.api_key ?? ""), false);
});

test("execution digest is consistency-method independent but inventory-drift sensitive", async () => {
	const parsed = manifest();
	const dryRunInventory = inventory();
	const authoritativeRead = dryRunInventory.consistency!.after;
	const serializableInventory = inventory({
		consistency: {
			semantics: "serializable-transaction",
			snapshot_consistent: true,
			before: authoritativeRead,
			after: authoritativeRead,
			drifted: false,
		},
	});
	const dryRun = await planEndpointBackfill(parsed, dryRunInventory, NOW);
	const serializable = await planEndpointBackfill(
		parsed,
		serializableInventory,
		NOW
	);
	assert.equal(dryRun.validation_passed, true);
	assert.equal(serializable.validation_passed, true);
	assert.equal(dryRun.execution_sha256, serializable.execution_sha256);
	assert.notEqual(dryRun.plan_sha256, serializable.plan_sha256);

	const changedRead = {
		...authoritativeRead,
		rows_sha256: `sha256:${"9".repeat(64)}`,
	};
	const changedInventory = inventory({
		consistency: {
			semantics: "serializable-transaction",
			snapshot_consistent: true,
			before: changedRead,
			after: changedRead,
			drifted: false,
		},
	});
	const changed = await planEndpointBackfill(parsed, changedInventory, NOW);
	assert.equal(changed.validation_passed, true);
	assert.notEqual(dryRun.execution_sha256, changed.execution_sha256);
});

test("returns noop only for a current verified row, exact links, and current subject", async () => {
	const initial = manifest();
	const row = endpointRow(initial, {
		supports_implicit_caching: 0,
		supports_voice_cloning: 0,
		expires_at: "2026-11-30 00:00:00+00",
	});
	const parsed = withExpectedExisting(initial, row);
	const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(
		ROUTE,
		PROVIDER
	);
	const currentInventory = inventory({
		endpoints: [row],
		links: [
			{
				endpoint_id: row.id,
				route_target_id: ROUTE.id,
				subject_fingerprint: fingerprint,
				created_at: "2026-08-01T00:00:00.000Z",
			},
		],
	});
	const unattested = await planEndpointBackfill(parsed, currentInventory, NOW);
	assert.equal(unattested.endpoints[0]?.disposition, "reverify");
	assert.ok(
		unattested.endpoints[0]?.issues.some(
			(issue) => issue.code === "evidence_attestation_not_persisted"
		)
	);

	const desiredSha256 = unattested.endpoints[0]?.desired_sha256;
	assert.ok(desiredSha256);
	const report = await planEndpointBackfill(
		parsed,
		{
			...currentInventory,
			evidence_attestations: [
				{ endpoint_id: row.id, desired_sha256: desiredSha256 },
			],
		},
		NOW
	);
	assert.equal(report.validation_passed, true);
	assert.equal(report.ready_to_apply, false);
	assert.equal(report.endpoints[0]?.disposition, "noop");
	assert.equal(report.summary.actions, 0);
});

test("plans reverify for a stale subject and blocks a concurrent revision", async () => {
	const initial = manifest();
	const row = endpointRow(initial);
	const parsed = withExpectedExisting(initial, row);
	const stale = await planEndpointBackfill(
		parsed,
		inventory({
			endpoints: [row],
			links: [
				{
					endpoint_id: row.id,
					route_target_id: ROUTE.id,
					subject_fingerprint: "0".repeat(64),
					created_at: "2026-08-01T00:00:00.000Z",
				},
			],
		}),
		NOW
	);
	assert.equal(stale.endpoints[0]?.disposition, "reverify");
	assert.equal(stale.endpoints[0]?.route_subjects[0]?.state, "stale");

	const conflict = await planEndpointBackfill(
		parsed,
		inventory({
			endpoints: [{ ...row, updated_at: "2026-08-30T08:01:00.000Z" }],
			links: [],
		}),
		NOW
	);
	assert.equal(conflict.validation_passed, false);
	assert.equal(conflict.ready_to_apply, false);
	assert.ok(
		conflict.endpoints[0]?.issues.some(
			(issue) => issue.code === "endpoint_revision_conflict"
		)
	);
});

test("blocks legacy metadata drift that Admin verification currently misses", async () => {
	const report = await planEndpointBackfill(
		manifest(),
		inventory({
			routes: [
				{
					...ROUTE,
					routing_metadata: JSON.stringify({ context_length: 64_000 }),
				},
			],
		}),
		NOW
	);
	assert.equal(report.validation_passed, false);
	assert.equal(report.ready_to_apply, false);
	assert.equal(report.endpoints[0]?.disposition, "blocked");
	assert.deepEqual(report.endpoints[0]?.actions, []);
	assert.ok(
		report.endpoints[0]?.issues.some(
			(issue) => issue.code === "legacy_routing_metadata_drift"
		)
	);
	assert.deepEqual(report.endpoints[0]?.actions, []);
});

test("fails closed for missing migration, shared channel, and exact operation mismatch", async () => {
	const report = await planEndpointBackfill(
		manifest(),
		inventory({
			source: {
				driver: "d1",
				database_fingerprint: `sha256:${"f".repeat(64)}`,
				required_migration: "0049_model_endpoint_audio_capabilities.sql",
				migration_head: "0048_model_endpoint_route_subject_fingerprint.sql",
				migration_present: false,
			},
			providers: [{ ...PROVIDER, shared_channel_type: "openai" }],
			routes: [{ ...ROUTE, upstream_operation: "images.generations" }],
		}),
		NOW
	);
	assert.equal(report.validation_passed, false);
	assert.equal(report.ready_to_apply, false);
	assert.equal(report.endpoints[0]?.disposition, "blocked");
	assert.deepEqual(report.endpoints[0]?.actions, []);
	assert.ok(report.issues.some((issue) => issue.code === "required_migration_missing"));
	assert.ok(
		report.endpoints[0]?.issues.some(
			(issue) => issue.code === "shared_channel_not_credential_scoped"
		)
	);
	assert.ok(
		report.endpoints[0]?.issues.some(
			(issue) => issue.code === "route_operation_not_supported"
		)
	);
});

test("fails closed when Provider protocol exists but the selected operation is absent", async () => {
	const report = await planEndpointBackfill(
		manifest(),
		inventory({
			providers: [
				{
					...PROVIDER,
					endpoints: JSON.stringify({
						openai: {
							endpoints: {
								embeddings: "https://provider.example/v1/embeddings",
							},
						},
					}),
				},
			],
		}),
		NOW
	);
	assert.equal(report.validation_passed, false);
	assert.ok(
		report.endpoints[0]?.issues.some(
			(issue) => issue.code === "provider_operation_not_callable"
		)
	);
});

test("strictly rejects locale timestamps", () => {
	assert.throws(
		() => manifest({ created_at: "08/30/2026 09:00:00" }),
		(error: unknown) =>
			error instanceof EndpointBackfillManifestError &&
			/RFC 3339 timestamp/u.test(error.message)
	);
	assert.throws(
		() => manifest({ created_at: "2026-02-30T09:00:00Z" }),
		(error: unknown) =>
			error instanceof EndpointBackfillManifestError &&
			/RFC 3339 timestamp/u.test(error.message)
	);

	const input = rawManifest() as Record<string, unknown>;
	const endpoint = {
		...((input.endpoints as Array<Record<string, unknown>>)[0] ?? {}),
		expected_updated_at: "August 30, 2026",
	};
	assert.throws(
		() => parseEndpointBackfillManifest({ ...input, endpoints: [endpoint] }),
		(error: unknown) =>
			error instanceof EndpointBackfillManifestError &&
			/database timestamp/u.test(error.message)
	);

	const evidenceEndpoint = {
		...((input.endpoints as Array<Record<string, unknown>>)[0] ?? {}),
		evidence: {
			...(((input.endpoints as Array<Record<string, unknown>>)[0]?.evidence as Record<
				string,
				unknown
			>) ?? {}),
			url: "https://provider.example/pricing?token=must-not-persist",
		},
	};
	assert.throws(
		() => parseEndpointBackfillManifest({ ...input, endpoints: [evidenceEndpoint] }),
		(error: unknown) =>
			error instanceof EndpointBackfillManifestError &&
			/public HTTPS/u.test(error.message)
	);
});

test("blocks evidence that post-dates the frozen manifest", async () => {
	const input = rawManifest() as Record<string, unknown>;
	const originalEndpoint = (input.endpoints as Array<Record<string, unknown>>)[0]!;
	const parsed = parseEndpointBackfillManifest({
		...input,
		endpoints: [
			{
				...originalEndpoint,
				evidence: {
					...(originalEndpoint.evidence as Record<string, unknown>),
					observed_at: "2026-08-30T09:30:00.000Z",
				},
			},
		],
	});
	const report = await planEndpointBackfill(parsed, inventory(), NOW);
	assert.equal(report.validation_passed, false);
	assert.ok(
		report.endpoints[0]?.issues.some(
			(issue) => issue.code === "evidence_observed_after_manifest_creation"
		)
	);
});

test("redacts untrusted inventory extras and invalid subject fingerprints", async () => {
	const initial = manifest();
	const row = endpointRow(initial);
	const parsed = withExpectedExisting(initial, row);
	const unsafeInventory = inventory({
		endpoints: [row],
		links: [
			{
				endpoint_id: row.id,
				route_target_id: ROUTE.id,
				subject_fingerprint: "sk-secret-fingerprint",
				created_at: "2026-08-01T00:00:00.000Z",
			},
		],
	});
	(
		unsafeInventory.source as EndpointBackfillInventory["source"] & {
			database_url: string;
		}
	).database_url = "postgres://operator-secret@db.example/cinatoken";
	(
		unsafeInventory.consistency as NonNullable<
			EndpointBackfillInventory["consistency"]
		> & {
			connection_diagnostics: string;
		}
	).connection_diagnostics = "mysql://consistency-secret@db.example/cinatoken";
	(
		unsafeInventory.consistency?.before as NonNullable<
			EndpointBackfillInventory["consistency"]
		>["before"] & {
			raw_provider_key: string;
		}
	).raw_provider_key = "sk-consistency-secret";

	const report = await planEndpointBackfill(parsed, unsafeInventory, NOW);
	const serialized = JSON.stringify(report);
	assert.equal(serialized.includes("operator-secret"), false);
	assert.equal(serialized.includes("consistency-secret"), false);
	assert.equal(serialized.includes("sk-secret-fingerprint"), false);
	assert.equal(report.endpoints[0]?.route_subjects[0]?.current_fingerprint, null);
	assert.ok(
		report.endpoints[0]?.issues.some(
			(issue) => issue.code === "invalid_current_subject_fingerprint_redacted"
		)
	);
});

test("a global source blocker invalidates every otherwise valid action", async () => {
	const report = await planEndpointBackfill(
		manifest(),
		inventory({
			source: {
				driver: "postgres",
				database_fingerprint: `sha256:${"0".repeat(64)}`,
				required_migration: "0048_model_endpoint_audio_capabilities.sql",
				migration_head: "0048_model_endpoint_audio_capabilities.sql",
				migration_present: true,
			},
		}),
		NOW
	);
	assert.equal(report.validation_passed, false);
	assert.equal(report.endpoints[0]?.disposition, "blocked");
	assert.deepEqual(report.endpoints[0]?.actions, []);
	assert.equal(report.summary.actions, 0);
});

test("fails closed when double-read proofs disagree even if drifted is falsely clear", async () => {
	const unstableInventory = inventory();
	assert.ok(unstableInventory.consistency);
	unstableInventory.consistency.after.rows_sha256 = `sha256:${"9".repeat(64)}`;
	unstableInventory.consistency.drifted = false;

	const report = await planEndpointBackfill(manifest(), unstableInventory, NOW);
	assert.equal(report.validation_passed, false);
	assert.equal(report.endpoints[0]?.disposition, "blocked");
	assert.deepEqual(report.endpoints[0]?.actions, []);
	assert.ok(
		report.issues.some((issue) => issue.code === "inventory_consistency_drift")
	);
});

test("requires a bounded inventory consistency proof", async () => {
	const missingProof = inventory();
	delete missingProof.consistency;
	await assert.rejects(
		planEndpointBackfill(manifest(), missingProof, NOW),
		/inventory\.consistency must be an object/u
	);
});

test("allows a later migration head but makes the review requirement explicit", async () => {
	const report = await planEndpointBackfill(
		manifest(),
		inventory({
			source: {
				driver: "postgres",
				database_fingerprint: `sha256:${"f".repeat(64)}`,
				required_migration: "0048_model_endpoint_audio_capabilities.sql",
				migration_head: "0049_future_backward_compatible.sql",
				migration_present: true,
			},
		}),
		NOW
	);
	assert.equal(report.validation_passed, true);
	assert.ok(
		report.issues.some(
			(issue) => issue.code === "migration_head_differs_from_required"
		)
	);
});

function transactionalInventory(): EndpointBackfillInventory {
	const value = inventory();
	const read = value.consistency!.after;
	value.consistency = {
		semantics: "serializable-transaction",
		snapshot_consistent: true,
		before: read,
		after: read,
		drifted: false,
	};
	return value;
}

async function applyAuthorization(
	parsed: EndpointBackfillManifest,
	currentInventory: EndpointBackfillInventory,
	overrides: Partial<EndpointBackfillVerifiedAuthorization> = {}
): Promise<{ authorization: EndpointBackfillVerifiedAuthorization; manifestSha256: string }> {
	const manifestSha256 = await sha256EndpointBackfillValue(parsed);
	const plan = await planEndpointBackfill(parsed, currentInventory, NOW, {
		full_manifest_sha256: manifestSha256,
	});
	const base = {
		execution_sha256: plan.execution_sha256,
		trusted_signers_sha256: "b".repeat(64),
		validation_passed: true as const,
		approved_at: "2026-08-30T09:30:00.000Z",
		expires_at: "2026-08-30T12:00:00.000Z",
		manifest_actor: {
			principal: parsed.actor_id,
			key_id: `sha256:${"1".repeat(64)}`,
		},
		evidence_reviewers: [
			{
				principal: "cinaauth:reviewer-1",
				key_id: `sha256:${"2".repeat(64)}`,
				endpoint_ids: ["endpoint-1"],
			},
		],
		apply_approver: {
			principal: "cinaauth:approver-1",
			key_id: `sha256:${"3".repeat(64)}`,
		},
		...overrides,
	};
	const request = await buildEndpointBackfillApplyRequestDigest({
		full_manifest_sha256: manifestSha256,
		manifest: parsed,
		execution_sha256: base.execution_sha256,
		trusted_signers_sha256: base.trusted_signers_sha256,
	});
	return {
		manifestSha256,
		authorization: { ...base, request_sha256: request.request_sha256 },
	};
}

class MemoryApplyStore implements EndpointBackfillApplyStore {
	completed: EndpointBackfillApplyRun | null = null;
	readonly events: string[] = [];
	constructor(
		readonly currentInventory: EndpointBackfillInventory,
		readonly clocks: Date[]
	) {}

	async serializableTransaction<T>(
		work: (transaction: EndpointBackfillApplyTransaction) => Promise<T>
	): Promise<T> {
		let pending: EndpointBackfillApplyRun | null = null;
		const transaction: EndpointBackfillApplyTransaction = {
			acquireLock: async () => { this.events.push("lock"); },
			verifyDatabaseIdentity: async (fingerprint, trustedSigners) => {
				this.events.push(`identity:${fingerprint}:${trustedSigners}`);
			},
			databaseNow: async () => {
				this.events.push("clock");
				const value = this.clocks.shift();
				if (!value) throw new Error("test clock exhausted");
				return value;
			},
			findCompletedRun: async () => {
				this.events.push("find");
				return this.completed;
			},
			loadInventory: async () => {
				this.events.push("load");
				return this.currentInventory;
			},
			assertEndpointRevision: async () => { this.events.push("cas"); },
			writeDraft: async () => { this.events.push("draft"); },
			syncRouteBindings: async () => { this.events.push("routes"); },
			publish: async () => { this.events.push("publish"); },
			insertRun: async (run) => {
				this.events.push("run");
				pending = run;
			},
			insertAttestation: async () => { this.events.push("attestation"); },
		};
		const result = await work(transaction);
		if (pending) this.completed = pending;
		return result;
	}
}

test("apply anchors DB identity, persists authorization provenance, and fresh re-sign is idempotent", async () => {
	const parsed = manifest();
	const currentInventory = transactionalInventory();
	const first = await applyAuthorization(parsed, currentInventory);
	const store = new MemoryApplyStore(currentInventory, [
		NOW,
		new Date(NOW.getTime() + 1000),
	]);
	const applied = await applyEndpointBackfill({
		manifest: parsed,
		full_manifest_sha256: first.manifestSha256,
		authorization: first.authorization,
		store,
	});
	assert.equal(applied.status, "applied");
	assert.equal(store.completed?.authorization_sha256, applied.authorization_sha256);
	assert.equal(store.completed?.manifest_actor_key_id, first.authorization.manifest_actor.key_id);
	assert.match(store.completed?.evidence_reviewers_json ?? "", /reviewer-1/u);
	assert.deepEqual(store.events.slice(0, 4).map((event) => event.split(":")[0]), [
		"lock",
		"identity",
		"clock",
		"find",
	]);
	// PostgreSQL/MySQL may render the commit timestamp differently on reload;
	// reports still expose the original instant in canonical UTC form.
	store.completed = {
		...store.completed!,
		applied_at: "2026-08-30 10:00:00+00",
		approval_approved_at: "2026-08-30 09:30:00+00",
		approval_expires_at: "2026-08-30 12:00:00+00",
	};

	const resigned = await applyAuthorization(parsed, currentInventory, {
		approved_at: "2026-08-30T09:40:00.000Z",
		expires_at: "2026-08-30T12:30:00.000Z",
	});
	store.clocks.push(
		new Date("2026-08-30T10:05:00.000Z"),
		new Date("2026-08-30T10:05:01.000Z")
	);
	const retried = await applyEndpointBackfill({
		manifest: parsed,
		full_manifest_sha256: resigned.manifestSha256,
		authorization: resigned.authorization,
		store,
	});
	assert.equal(retried.status, "already_applied");
	assert.equal(retried.idempotency_key, applied.idempotency_key);
	assert.equal(retried.authorization_sha256, applied.authorization_sha256);
	assert.equal(retried.approval_approved_at, first.authorization.approved_at);
	assert.equal(retried.applied_at, applied.applied_at);
	assert.notEqual(retried.generated_at, retried.applied_at);
});

test("already-applied recovery tolerates expired evidence but a new write does not", async () => {
	const parsed = manifest();
	const currentInventory = transactionalInventory();
	const first = await applyAuthorization(parsed, currentInventory);
	const store = new MemoryApplyStore(currentInventory, [
		NOW,
		new Date(NOW.getTime() + 1_000),
	]);
	const applied = await applyEndpointBackfill({
		manifest: parsed,
		full_manifest_sha256: first.manifestSha256,
		authorization: first.authorization,
		store,
	});

	const recoveredAuthorization = await applyAuthorization(parsed, currentInventory, {
		approved_at: "2026-12-01T09:30:00.000Z",
		expires_at: "2026-12-01T12:00:00.000Z",
	});
	store.clocks.push(
		new Date("2026-12-01T10:00:00.000Z"),
		new Date("2026-12-01T10:00:01.000Z")
	);
	const recovered = await applyEndpointBackfill({
		manifest: parsed,
		full_manifest_sha256: recoveredAuthorization.manifestSha256,
		authorization: recoveredAuthorization.authorization,
		store,
	});
	assert.equal(recovered.status, "already_applied");
	assert.equal(recovered.idempotency_key, applied.idempotency_key);

	const emptyStore = new MemoryApplyStore(currentInventory, [
		new Date("2026-12-01T10:00:00.000Z"),
	]);
	await assert.rejects(
		applyEndpointBackfill({
			manifest: parsed,
			full_manifest_sha256: recoveredAuthorization.manifestSha256,
			authorization: recoveredAuthorization.authorization,
			store: emptyStore,
		}),
		(error: unknown) =>
			error instanceof EndpointBackfillApplyError && error.code === "validation_blocked"
	);
	assert.equal(emptyStore.events.includes("load"), false);
	assert.equal(emptyStore.events.includes("run"), false);
});

test("reviewer provenance uses a cross-driver UTF-8 byte contract", () => {
	const evidence_reviewers = Array.from({ length: 100 }, (_, index) => {
		const suffix = String(index).padStart(3, "0");
		return {
			principal: `${"审".repeat(188)}${suffix}`,
			key_id: `sha256:${index.toString(16).padStart(64, "0")}`,
			endpoint_ids: [`${"端".repeat(188)}${suffix}`],
		};
	});
	const serialized = serializeEndpointBackfillVerifiedEvidenceReviewers({
		evidence_reviewers,
	});
	const bytes = new TextEncoder().encode(serialized).byteLength;
	assert.ok(bytes > 65_535);
	assert.ok(bytes <= 256 * 1024);

	assert.throws(
		() => serializeEndpointBackfillVerifiedEvidenceReviewers({
			evidence_reviewers: [{
				principal: "cinaauth:reviewer",
				key_id: `sha256:${"a".repeat(64)}`,
				endpoint_ids: Array.from({ length: 1_000 }, (_, index) =>
					`${"端".repeat(188)}${String(index).padStart(3, "0")}`
				),
			}],
		}),
		(error: unknown) =>
			error instanceof EndpointBackfillApplyError &&
			error.code === "authorization_mismatch"
	);
});

test("apply rolls back on execution drift and approval expiry at the commit boundary", async () => {
	const parsed = manifest();
	const currentInventory = transactionalInventory();
	const samePrincipal = await applyAuthorization(parsed, currentInventory, {
		apply_approver: {
			principal: parsed.actor_id,
			key_id: `sha256:${"3".repeat(64)}`,
		},
	});
	const separationStore = new MemoryApplyStore(currentInventory, []);
	await assert.rejects(
		applyEndpointBackfill({
			manifest: parsed,
			full_manifest_sha256: samePrincipal.manifestSha256,
			authorization: samePrincipal.authorization,
			store: separationStore,
		}),
		/distinct principals and keys/u
	);
	assert.deepEqual(separationStore.events, []);

	const drifted = await applyAuthorization(parsed, currentInventory, {
		execution_sha256: "d".repeat(64),
	});
	const driftStore = new MemoryApplyStore(currentInventory, [NOW]);
	await assert.rejects(
		applyEndpointBackfill({
			manifest: parsed,
			full_manifest_sha256: drifted.manifestSha256,
			authorization: drifted.authorization,
			store: driftStore,
		}),
		(error: unknown) =>
			error instanceof EndpointBackfillApplyError && error.code === "execution_mismatch"
	);
	assert.equal(driftStore.completed, null);
	assert.equal(driftStore.events.includes("draft"), false);

	const expiring = await applyAuthorization(parsed, currentInventory, {
		expires_at: "2026-08-30T10:00:00.500Z",
	});
	const expiryStore = new MemoryApplyStore(currentInventory, [
		NOW,
		new Date("2026-08-30T10:00:01.000Z"),
	]);
	await assert.rejects(
		applyEndpointBackfill({
			manifest: parsed,
			full_manifest_sha256: expiring.manifestSha256,
			authorization: expiring.authorization,
			store: expiryStore,
		}),
		(error: unknown) =>
			error instanceof EndpointBackfillApplyError && error.code === "authorization_expired"
	);
	assert.equal(expiryStore.completed, null);
	assert.equal(expiryStore.events.includes("run"), true);
});
