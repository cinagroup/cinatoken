import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mode = process.argv[2];
assert.equal(process.platform, "linux");
assert.ok(["--seed", "--observe"].includes(mode) && process.argv.length === 3);
assert.equal(process.env.DATABASE_DRIVER, "postgres");
const db = new URL(process.env.DATABASE_URL);
assert.equal(db.protocol, "postgres:");
assert.equal(db.hostname, "pg");
assert.equal(db.port, "5432");
assert.equal(db.pathname, "/g7");
assert.equal(db.username, "postgres");
assert.match(db.password, /^[a-f0-9]{64}$/);
assert.equal(db.search, "");
const core = await import("/app/packages/core/dist/index.js");
const context = await core.createPostgresStorageContext(db.href, {
	max: 1,
	prepare: false,
	fetch_types: false,
	connect_timeout: 5,
});
const sql = context.client.raw;
let failure;
let report;
let stage = "migration-ledger";
let assertionObservation;
const checkScalar = (selector, actual, expected) => {
	assert.ok(
		[actual, expected].every(
			(value) => typeof value === "boolean" || Number.isSafeInteger(value)
		)
	);
	assertionObservation = { selector, actual, expected };
	assert.equal(actual, expected);
	assertionObservation = undefined;
};
try {
	const migrations = readdirSync("/app/packages/core/migrations-postgres")
		.filter((name) => name.endsWith(".sql"))
		.sort();
	const expected = migrations.map((name) => ({
		name,
		sha256: sha256(
			readFileSync(`/app/packages/core/migrations-postgres/${name}`)
		),
	}));
	const applied =
		await sql`SELECT version FROM cinatoken_gateway.schema_migrations ORDER BY version`;
	assert.deepEqual(
		applied.map((row) => row.version),
		migrations,
		"Full actual migration corpus must be applied"
	);
	let fixture;
	if (mode === "--seed") {
		stage = "fixture-secret-format";
		const secret = process.env.SHARED_KEY_ENCRYPTION_SECRET;
		const providerKey = process.env.G7_PROVIDER_KEY;
		const masterKey = process.env.G7_MASTER_KEY;
		for (const value of [secret, providerKey, masterKey])
			assert.match(value, /^[a-f0-9]{64}$/);
		const encrypted = await core.encryptSharedKeySecret(
			providerKey,
			secret,
			"cinatoken:provider-key:g7-provider"
		);
		await sql.begin(async (tx) => {
			stage = "legacy-admin-key-rotation";
			// 0023 migrates the development key to admin_api_keys; 0024 removes its old config row.
			const rotated = await tx.unsafe(
				`UPDATE cinatoken_gateway.admin_api_keys
         SET secret_key=$1, secret_key_hash=$2, key_prefix=$3, updated_at=CURRENT_TIMESTAMP
         WHERE id='legacy-master' AND name='legacy-master' AND status='active'
           AND permissions_json='["*"]' AND secret_key='sk-dev-admin-key'
         RETURNING id,name,permissions_json,status`,
				[masterKey, await core.hashLookupKey(masterKey), masterKey.slice(0, 12)]
			);
			checkScalar("legacy_master_rotated_row_count", rotated.length, 1);
			assert.deepEqual([...rotated], [
				{
					id: "legacy-master",
					name: "legacy-master",
					permissions_json: '["*"]',
					status: "active",
				},
			]);
			const obsoleteConfig =
				await tx`SELECT key FROM cinatoken_gateway.system_config WHERE key='MASTER_KEY'`;
			checkScalar("obsolete_master_config_row_count", obsoleteConfig.length, 0);
			stage = "catalog-fixture-write";
			await tx
				.unsafe(
					`
        INSERT INTO cinatoken_gateway.providers(id,name,api_key,endpoints,status)
          VALUES ('g7-provider','G7 Owned Provider','','{"openai":{"base":"https://provider.test/v1"}}','active');
        INSERT INTO cinatoken_gateway.models(id,display_name,vendor,context_window,max_tokens,input_modalities,output_modalities,route_policy)
          VALUES ('qa/g7-model','G7 PostgreSQL Model','qa',8192,1024,'["text"]','["text"]','{"strategy":"weight_priority"}');
        INSERT INTO cinatoken_gateway.route_pools(id,model_id,route_group,name,status)
          VALUES ('g7-pool','qa/g7-model','default','G7 Owned Pool','active');
        INSERT INTO cinatoken_gateway.model_surfaces(id,model_id,route_group,request_protocol,request_operation,route_pool_id,status)
          VALUES ('g7-surface','qa/g7-model','default','openai','chat','g7-pool','active');
        INSERT INTO cinatoken_gateway.model_routes(id,model_id,provider_id,provider_model_name,route_pool_id,upstream_protocol,upstream_operation,adapter,status)
          VALUES ('g7-route','qa/g7-model','g7-provider','g7-upstream-model','g7-pool','openai','chat','passthrough','active');
        INSERT INTO cinatoken_gateway.model_endpoints(id,model_id,provider_id,provider_slug,tag,context_length,max_prompt_tokens,max_completion_tokens,supported_parameters,pricing,supports_implicit_caching,supports_voice_cloning,supports_tool_choice,status,verified_by,verified_at,expires_at,evidence_url)
          VALUES ('g7-endpoint','qa/g7-model','g7-provider','qa','qa',8192,7168,1024,'["temperature"]',
            '{"currency":"USD","prompt":"0.000001","completion":"0.000002"}',false,false,
            '{"auto":false,"function":false,"none":true,"required":false}',
            'verified','owned-g7-test-fixture',now(),now()+interval '1 day','https://provider.test/evidence');
      `
				)
				.simple();
			await tx`UPDATE cinatoken_gateway.providers SET api_key=${encrypted} WHERE id='g7-provider'`;
		});
		stage = "legacy-admin-key-admission";
		const adminKey =
			await context.repositories.adminAccess.getActiveApiKeyBySecret(masterKey);
		assert.ok(adminKey);
		assert.equal(adminKey.id, "legacy-master");
		assert.equal(adminKey.name, "legacy-master");
		assert.equal(adminKey.status, "active");
		assert.equal(adminKey.permissionsJson, '["*"]');
		assert.equal(adminKey.keyPrefix, masterKey.slice(0, 12));
		assert.equal(
			await context.repositories.adminAccess.getActiveApiKeyBySecret(
				"sk-dev-admin-key"
			),
			null
		);
		stage = "provider-admission";
		const route = (
			await context.repositories.modelRouting.getModelRoutesByModelId(
				"qa/g7-model"
			)
		)[0];
		const storedProvider = (
			await context.repositories.providers.getProvidersByIds(["g7-provider"])
		)[0];
		assert.ok(route && storedProvider);
		assert.ok(storedProvider.api_key.startsWith("enc:v2:"));
		assert.equal(
			await core.decryptProviderApiKeyReadOnly(
				"g7-provider",
				storedProvider.api_key,
				secret
			),
			providerKey
		);
		const fingerprint =
			await core.computeRouteDataPolicySubjectFingerprintFromRows(route, {
				...storedProvider,
				api_key: providerKey,
			});
		await sql`INSERT INTO cinatoken_gateway.model_endpoint_routes(endpoint_id,route_target_id,subject_fingerprint)
      VALUES ('g7-endpoint','g7-route',${fingerprint})`;
		stage = "endpoint-admission";
		const bindings =
			await context.repositories.modelEndpoints.listRuntimeBindingsByRouteTargetIds(
				["g7-route"]
			);
		assert.equal(bindings.length, 1);
		assert.equal(bindings[0].subject_fingerprint, fingerprint);
		const snapshot = core.parseVerifiedModelEndpointSnapshot(bindings[0]);
		assert.ok(snapshot, "Actual core must accept the seeded verified endpoint");
		assert.equal(core.modelEndpointSupportsOperation(snapshot, "chat"), true);
		fixture = {
			modelId: "qa/g7-model",
			providerId: "g7-provider",
			endpointId: "g7-endpoint",
			fingerprint,
			storedProviderKeyEncrypted: true,
			legacyMasterKeyRotated: true,
			controlledCatalogEvidenceOnly: true,
		};
	}
	stage = "database-observation";
	const observation = await sql.begin("read only", async (tx) => {
		const [identity] = await tx`SELECT version() AS server_version,
      current_setting('server_version_num') AS server_version_num,
      current_user AS role, current_database() AS database, current_schema() AS schema,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`;
		const columns =
			await tx`SELECT table_name,column_name,ordinal_position,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='cinatoken_gateway' ORDER BY table_name,ordinal_position`;
		const constraints =
			await tx`SELECT c.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='cinatoken_gateway' ORDER BY c.relname,con.conname`;
		const [counts] = await tx`SELECT
      (SELECT count(*)::int FROM cinatoken_gateway.models) AS models,
      (SELECT count(*)::int FROM cinatoken_gateway.providers) AS providers,
      (SELECT count(*)::int FROM cinatoken_gateway.model_endpoints WHERE status='verified') AS verified_endpoints,
      (SELECT count(*)::int FROM cinatoken_gateway.admin_api_keys WHERE id='legacy-master' AND name='legacy-master' AND status='active' AND permissions_json='["*"]') AS legacy_master_api_keys,
      (SELECT count(*)::int FROM cinatoken_gateway.admin_api_keys WHERE secret_key='sk-dev-admin-key') AS legacy_development_keys,
      (SELECT count(*)::int FROM cinatoken_gateway.system_config WHERE key='MASTER_KEY') AS obsolete_master_config,
      (SELECT count(*)::int FROM cinatoken_gateway.admin_sessions) AS admin_sessions,
      (SELECT count(*)::int FROM cinatoken_gateway.portal_sessions) AS portal_sessions`;
		stage = "database-identity";
		assert.ok(
			Number(identity.server_version_num) >= 160000 &&
				Number(identity.server_version_num) < 170000
		);
		assert.equal(identity.role, "postgres");
		assert.equal(identity.superuser, true);
		assert.equal(identity.database, "g7");
		assert.equal(identity.schema, "cinatoken_gateway");
		stage = "database-counts";
		for (const [selector, expectedCount] of Object.entries({
			models: 1,
			providers: 1,
			verified_endpoints: 1,
			legacy_master_api_keys: 1,
			legacy_development_keys: 0,
			obsolete_master_config: 0,
			admin_sessions: 0,
			portal_sessions: 0,
		}))
			checkScalar(selector, counts[selector], expectedCount);
		return {
			...identity,
			schemaSha256: sha256(JSON.stringify({ columns, constraints })),
			schemaColumns: columns.length,
			counts,
		};
	});
	report = {
		schema: "web-platform-g7-database-v1",
		actualExit: 0,
		mode,
		observation,
		migrations: expected,
		migrationCorpusSha256: sha256(JSON.stringify(expected)),
		fixture,
		restrictedRuntimeACLVerified: false,
		nativePG18Verified: false,
	};
} catch (error) {
	failure = error;
} finally {
	await sql.end({ timeout: 5 });
}
if (failure) {
	// The parent command receipt retains failure status; do not print credentials or query parameters.
	console.error(
		JSON.stringify({
			schema: "web-platform-g7-database-v1",
			actualExit: 1,
			mode,
			stage,
			errorName: failure.name,
			assertionOperator:
				failure.name === "AssertionError" &&
				["strictEqual", "deepStrictEqual", "match", "=="].includes(
					failure.operator
				)
					? failure.operator
					: null,
			assertionObservation,
			message: "Database contract or fixture admission failed",
		})
	);
	process.exitCode = 1;
} else console.log(JSON.stringify(report));
