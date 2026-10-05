#!/usr/bin/env node
/**
 * Generate wrangler.jsonc / wrangler.d1.jsonc from *.base.jsonc + environment variables.
 *
 * Build variables (Workers Builds) or cloudflare-worker/*.env — see docs/operators/deployment/cloudflare.md
 *
 * Local D1 identity (important):
 * - Without D1_DATABASE_ID in env → generated configs have no database_id → local dev uses D1 "(DB)".
 * - With D1_DATABASE_ID (remote deploy / db:migrate:remote) → local wrangler dev uses a *different*
 *   SQLite under .wrangler/state than npm run db:migrate (default local path).
 * After any remote deploy on this machine, run `npm run gen:wrangler` (no D1_DATABASE_ID in shell)
 * before dev:proxy / dev:admin. See docs/developers/local-development.md §1.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

const REMOTE = process.argv.includes('--remote');

function trimEnv(key) {
	const v = process.env[key];
	return typeof v === 'string' ? v.trim() : '';
}

function resolveWorkerDatabaseDriver() {
	const raw = trimEnv('DATABASE_DRIVER').toLowerCase();
	if (!raw) return '';
	if (raw === 'd1') return 'd1';
	if (raw === 'postgres' || raw === 'postgresql') return 'postgres';
	console.error(`gen-wrangler: unsupported Cloudflare DATABASE_DRIVER="${raw}". Expected d1 or postgres.`);
	process.exit(1);
}

function resolveMaintenanceMode() {
	const raw = trimEnv('CINATOKEN_MAINTENANCE_MODE').toLowerCase();
	if (!raw || raw === 'false') return false;
	if (raw === 'true') return true;
	console.error(`gen-wrangler: unsupported CINATOKEN_MAINTENANCE_MODE="${raw}". Expected true or false.`);
	process.exit(1);
}

function resolveStrictBoolean(key, defaultValue = false) {
	const raw = trimEnv(key).toLowerCase();
	if (!raw) return defaultValue;
	if (raw === 'false') return false;
	if (raw === 'true') return true;
	console.error(`gen-wrangler: unsupported ${key}="${raw}". Expected true or false.`);
	process.exit(1);
}

function resolveNames() {
	const d1DatabaseName = trimEnv('D1_DATABASE_NAME') || 'cinatoken';
	const chainWorkerName = trimEnv('CHAIN_WORKER_NAME') || 'cinatoken-chain-worker';
	const batchInfraEnabled = resolveStrictBoolean('BATCH_INFRA_ENABLED');
	const batchApiEnabled = resolveStrictBoolean('BATCH_API_ENABLED');
	if (batchApiEnabled) {
		console.error(
			'gen-wrangler: BATCH_API_ENABLED=true is not supported by the Phase 2 build. Stage infrastructure with BATCH_INFRA_ENABLED=true while the public API remains off.',
		);
		process.exit(1);
	}

	return {
		proxyWorkerName: trimEnv('PROXY_WORKER_NAME') || 'cinatoken-proxy',
		adminWorkerName: trimEnv('ADMIN_WORKER_NAME') || 'cinatoken-admin',
		chainWorkerName,
		chainJobQueueName: trimEnv('CHAIN_JOB_QUEUE_NAME') || `${d1DatabaseName}-chain-jobs`,
		chainJobDlqName: trimEnv('CHAIN_JOB_DLQ_NAME') || `${d1DatabaseName}-chain-jobs-dlq`,
		batchInfraEnabled,
		batchBucketName: trimEnv('BATCH_BUCKET_NAME') || `${d1DatabaseName}-batch-private`,
		batchQueueName: trimEnv('BATCH_QUEUE_NAME') || `${d1DatabaseName}-batch-jobs`,
		batchDlqName: trimEnv('BATCH_DLQ_NAME') || `${d1DatabaseName}-batch-jobs-dlq`,
		cinachainChainId: trimEnv('CINACHAIN_CHAIN_ID') || '84532',
		d1MigrationsWorkerName: trimEnv('D1_MIGRATIONS_WORKER_NAME') || 'cinatoken-d1-migrations',
		d1DatabaseName,
		d1DatabaseId: trimEnv('D1_DATABASE_ID'),
		hyperdriveId: trimEnv('HYPERDRIVE_ID'),
		reviewProducerHyperdriveBindingsEnabled: resolveStrictBoolean('REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED'),
		dispatchHyperdriveId: trimEnv('DISPATCH_HYPERDRIVE_ID'),
		factHyperdriveId: trimEnv('FACT_HYPERDRIVE_ID'),
		sharedKeyUsageRepairActivation: trimEnv('SHARED_KEY_USAGE_REPAIR_ENABLED'),
		repairHyperdriveId: trimEnv('REPAIR_HYPERDRIVE_ID'),
		sharedEarningScannerActivation: trimEnv('SHARED_EARNING_SCANNER_ENABLED'),
		earningDeliveryHyperdriveId: trimEnv('EARNING_DELIVERY_HYPERDRIVE_ID'),
		earningConsumerHyperdriveId: trimEnv('EARNING_CONSUMER_HYPERDRIVE_ID'),
		databaseDriver: resolveWorkerDatabaseDriver(),
		maintenanceMode: resolveMaintenanceMode(),
		proxyCustomDomain: trimEnv('PROXY_CUSTOM_DOMAIN'),
		adminCustomDomain: trimEnv('ADMIN_CUSTOM_DOMAIN'),
	};
}

/** Strip JSONC comments without treating `//` inside strings as comments. */
function parseJsonc(text) {
	let output = '';
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		const next = text[index + 1];
		if (inLineComment) {
			if (character === '\n' || character === '\r') {
				inLineComment = false;
				output += character;
			}
			continue;
		}
		if (inBlockComment) {
			if (character === '*' && next === '/') {
				inBlockComment = false;
				index += 1;
			} else if (character === '\n' || character === '\r') {
				output += character;
			}
			continue;
		}
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
			continue;
		}
		if (character === '/' && next === '/') {
			inLineComment = true;
			index += 1;
			continue;
		}
		if (character === '/' && next === '*') {
			inBlockComment = true;
			index += 1;
			continue;
		}
		output += character;
	}
	return JSON.parse(output);
}

function readBase(relativePath) {
	const path = join(ROOT, relativePath);
	return parseJsonc(readFileSync(path, 'utf8'));
}

function writeJson(relativePath, data) {
	const path = join(ROOT, relativePath);
	writeFileSync(path, `${JSON.stringify(data, null, '\t')}\n`, 'utf8');
	console.log(`gen-wrangler: wrote ${relativePath}`);
}

function applyD1Binding(binding, databaseName, databaseId) {
	const next = { ...binding, database_name: databaseName };
	if (databaseId) {
		next.database_id = databaseId;
	} else {
		delete next.database_id;
	}
	return next;
}

function customDomainRoutes(domain) {
	if (!domain) {
		return undefined;
	}
	return [{ pattern: domain, custom_domain: true }];
}

function applyWorkerDatabaseRuntime(config, names) {
	const next = { ...config };
	if (names.databaseDriver === 'postgres' && names.hyperdriveId) {
		next.hyperdrive = [{ binding: 'HYPERDRIVE', id: names.hyperdriveId }];
	} else {
		delete next.hyperdrive;
	}

	const vars = { ...(config.vars ?? {}) };
	if (names.databaseDriver) {
		vars.DATABASE_DRIVER = names.databaseDriver;
	} else {
		delete vars.DATABASE_DRIVER;
	}
	if (Object.keys(vars).length > 0) next.vars = vars;
	else delete next.vars;
	return next;
}

function applyReviewProducerHyperdriveBindings(config, names) {
	if (!names.reviewProducerHyperdriveBindingsEnabled) return config;
	// Review artifact only: application runtime wiring remains a separate gate.
	return {
		...config,
		hyperdrive: [
			...config.hyperdrive,
			{ binding: 'DISPATCH_HYPERDRIVE', id: names.dispatchHyperdriveId },
			{ binding: 'FACT_HYPERDRIVE', id: names.factHyperdriveId },
		],
	};
}

function applySharedKeyUsageRepairHyperdriveBinding(config, names) {
	if (names.sharedKeyUsageRepairActivation !== 'reviewed-v3') return config;
	return {
		...config,
		hyperdrive: [...config.hyperdrive, { binding: 'REPAIR_HYPERDRIVE', id: names.repairHyperdriveId }],
		vars: {
			...config.vars,
			SHARED_KEY_USAGE_REPAIR_ENABLED: 'reviewed-v3',
		},
	};
}

function applyHttpMaintenanceMode(config, names) {
	const next = { ...config };
	const vars = { ...(config.vars ?? {}) };
	if (names.maintenanceMode) vars.CINATOKEN_MAINTENANCE_MODE = 'true';
	else delete vars.CINATOKEN_MAINTENANCE_MODE;
	if (Object.keys(vars).length > 0) next.vars = vars;
	else delete next.vars;
	return next;
}

function applyBatchInfrastructure(config, names) {
	const next = { ...config };
	const vars = { ...(config.vars ?? {}), BATCH_API_ENABLED: 'false' };
	if (!names.batchInfraEnabled) {
		delete next.r2_buckets;
		delete next.queues;
		delete vars.BATCH_QUEUE_DLQ;
		next.vars = vars;
		return next;
	}

	next.r2_buckets = (config.r2_buckets ?? []).map((bucket) =>
		bucket.binding === 'BATCH_BUCKET' ? { ...bucket, bucket_name: names.batchBucketName } : bucket,
	);
	next.queues = {
		...(config.queues ?? {}),
		producers: (config.queues?.producers ?? []).map((producer) =>
			producer.binding === 'BATCH_QUEUE' ? { ...producer, queue: names.batchQueueName } : producer,
		),
		consumers: (config.queues?.consumers ?? []).map((consumer) =>
			consumer.queue === 'cinatoken-batch-jobs-dlq'
				? { ...consumer, queue: names.batchDlqName }
				: {
						...consumer,
						queue: names.batchQueueName,
						dead_letter_queue: names.batchDlqName,
					},
		),
	};
	vars.BATCH_QUEUE_DLQ = names.batchDlqName;
	next.vars = vars;
	return next;
}

function generateProxy(names) {
	const base = readBase('packages/proxy/wrangler.base.jsonc');
	const organizationAdminRoles = trimEnv('CINAAUTH_ORGANIZATION_ADMIN_ROLES');
	const runtimeConfig = applyWorkerDatabaseRuntime(
		{
			...base,
			name: names.proxyWorkerName,
			vars: {
				...base.vars,
				...(organizationAdminRoles ? { CINAAUTH_ORGANIZATION_ADMIN_ROLES: organizationAdminRoles } : {}),
			},
			d1_databases: [applyD1Binding(base.d1_databases[0], names.d1DatabaseName, names.d1DatabaseId)],
		},
		names,
	);
	const config = applySharedKeyUsageRepairHyperdriveBinding(
		applyReviewProducerHyperdriveBindings(applyBatchInfrastructure(applyHttpMaintenanceMode(runtimeConfig, names), names), names),
		names,
	);
	const routes = customDomainRoutes(names.proxyCustomDomain);
	if (routes) {
		config.routes = routes;
	} else if (!Array.isArray(base.routes) || base.routes.length === 0) {
		delete config.routes;
	}

	writeJson('packages/proxy/wrangler.jsonc', config);
}

function generateAdmin(names) {
	const base = readBase('packages/admin/wrangler.base.jsonc');
	const organizationAdminRoles = trimEnv('CINAAUTH_ORGANIZATION_ADMIN_ROLES');
	const adminVars = {
		...base.vars,
		CINATOKEN_ADMIN_CONFIG_REQUIRE_REVISION: trimEnv('CINATOKEN_ADMIN_CONFIG_REQUIRE_REVISION') === 'true' ? 'true' : 'false',
		CINATOKEN_ADMIN_KEYS_REQUIRE_REVISION: trimEnv('CINATOKEN_ADMIN_KEYS_REQUIRE_REVISION') === 'true' ? 'true' : 'false',
		CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION: trimEnv('CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION') === 'true' ? 'true' : 'false',
		CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION: trimEnv('CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION') === 'true' ? 'true' : 'false',
		CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION:
			trimEnv('CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION') === 'true' ? 'true' : 'false',
		CINATOKEN_ADMIN_DATA_POLICIES_REQUIRE_PRECONDITION:
			trimEnv('CINATOKEN_ADMIN_DATA_POLICIES_REQUIRE_PRECONDITION') === 'true' ? 'true' : 'false',
		CINACHAIN_CHAIN_ID: names.cinachainChainId,
		...(organizationAdminRoles ? { CINAAUTH_ORGANIZATION_ADMIN_ROLES: organizationAdminRoles } : {}),
	};
	const config = applyHttpMaintenanceMode(
		applyWorkerDatabaseRuntime(
			{
				...base,
				name: names.adminWorkerName,
				d1_databases: [applyD1Binding(base.d1_databases[0], names.d1DatabaseName, names.d1DatabaseId)],
				queues: {
					...base.queues,
					producers: base.queues.producers.map((producer) => ({
						...producer,
						queue: names.chainJobQueueName,
					})),
				},
				vars: adminVars,
				services: base.services.map((service) =>
					service.binding === 'CINATOKEN_PROXY_SERVICE' ? { ...service, service: names.proxyWorkerName } : service,
				),
			},
			names,
		),
		names,
	);

	const routes = customDomainRoutes(names.adminCustomDomain);
	if (routes) {
		config.routes = routes;
	} else if (!Array.isArray(base.routes) || base.routes.length === 0) {
		delete config.routes;
	}

	writeJson('packages/admin/wrangler.jsonc', config);
}

function generateChain(names) {
	const base = readBase('packages/chain-worker/wrangler.base.jsonc');
	const config = applyWorkerDatabaseRuntime(
		{
			...base,
			name: names.chainWorkerName,
			d1_databases: [applyD1Binding(base.d1_databases[0], names.d1DatabaseName, names.d1DatabaseId)],
			queues: {
				...base.queues,
				// The primary consumer is renamed to the deployment queue name and
				// always carries the DLQ; the DLQ's own consumer (terminal triage,
				// max_retries: 0) is renamed to the DLQ name and must NOT receive a
				// dead_letter_queue of its own.
				consumers: base.queues.consumers.map((consumer) =>
					consumer.queue === 'cinatoken-chain-jobs-dlq'
						? { ...consumer, queue: names.chainJobDlqName }
						: {
								...consumer,
								queue: names.chainJobQueueName,
								dead_letter_queue: names.chainJobDlqName,
							},
				),
				producers: (base.queues.producers ?? []).map((producer) => ({
					...producer,
					queue: names.chainJobQueueName,
				})),
			},
			vars: {
				...base.vars,
				CINACHAIN_CHAIN_ID: names.cinachainChainId,
			},
		},
		names,
	);
	writeJson('packages/chain-worker/wrangler.jsonc', config);
}

function generateD1(names) {
	const base = readBase('packages/core/wrangler.d1.base.jsonc');
	const config = {
		...base,
		name: names.d1MigrationsWorkerName,
		d1_databases: [applyD1Binding(base.d1_databases[0], names.d1DatabaseName, names.d1DatabaseId)],
	};

	writeJson('packages/core/wrangler.d1.jsonc', config);
}

function validateRemote(names) {
	if (names.d1DatabaseId) {
		return;
	}
	console.error(
		'gen-wrangler: D1_DATABASE_ID is required for remote deploy/migrate.\n' +
			'  Set it in Workers Builds › Build variables, or:\n' +
			'  npx dotenv -e ./cloudflare-worker/<instance>.env -- npm run gen:wrangler -- --remote',
	);
	process.exit(1);
}

function validateWorkerDatabaseRuntime(names) {
	if (names.databaseDriver === 'postgres' && !names.hyperdriveId) {
		console.error(
			'gen-wrangler: HYPERDRIVE_ID is required when DATABASE_DRIVER=postgres. ' +
				'The Worker connection string must come from the HYPERDRIVE binding.',
		);
		process.exit(1);
	}
}

function validateReviewProducerHyperdriveBindings(names) {
	const { reviewProducerHyperdriveBindingsEnabled: enabled, dispatchHyperdriveId, factHyperdriveId } = names;
	if (!enabled) {
		if (dispatchHyperdriveId || factHyperdriveId) {
			console.error(
				'gen-wrangler: DISPATCH_HYPERDRIVE_ID and FACT_HYPERDRIVE_ID require REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED=true.',
			);
			process.exit(1);
		}
		return;
	}
	if (names.databaseDriver !== 'postgres' || !names.hyperdriveId) {
		console.error('gen-wrangler: review producer Hyperdrive bindings require DATABASE_DRIVER=postgres and runtime HYPERDRIVE_ID.');
		process.exit(1);
	}
	const ids = [
		['HYPERDRIVE_ID', names.hyperdriveId],
		['DISPATCH_HYPERDRIVE_ID', dispatchHyperdriveId],
		['FACT_HYPERDRIVE_ID', factHyperdriveId],
	];
	const canonicalId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	for (const [key, id] of ids) {
		if (!canonicalId.test(id)) {
			console.error(`gen-wrangler: ${key} must be a canonical Hyperdrive UUID for review producer bindings.`);
			process.exit(1);
		}
	}
	if (new Set(ids.map(([, id]) => id.toLowerCase())).size !== ids.length) {
		console.error('gen-wrangler: runtime, dispatch, and fact Hyperdrive IDs must be distinct.');
		process.exit(1);
	}
}

function validateSharedKeyUsageRepairHyperdriveBinding(names) {
	const { sharedKeyUsageRepairActivation: activation, repairHyperdriveId } = names;
	if (activation !== '' && activation !== 'false' && activation !== 'reviewed-v3') {
		console.error('gen-wrangler: SHARED_KEY_USAGE_REPAIR_ENABLED must be reviewed-v3 or false.');
		process.exit(1);
	}
	if (activation !== 'reviewed-v3') {
		if (repairHyperdriveId) {
			console.error('gen-wrangler: REPAIR_HYPERDRIVE_ID requires SHARED_KEY_USAGE_REPAIR_ENABLED=reviewed-v3.');
			process.exit(1);
		}
		return;
	}
	if (names.databaseDriver !== 'postgres' || !names.hyperdriveId) {
		console.error('gen-wrangler: shared-key usage repair requires DATABASE_DRIVER=postgres and HYPERDRIVE_ID.');
		process.exit(1);
	}
	const ids = [
		['HYPERDRIVE_ID', names.hyperdriveId],
		['REPAIR_HYPERDRIVE_ID', repairHyperdriveId],
		...(names.reviewProducerHyperdriveBindingsEnabled
			? [
					['DISPATCH_HYPERDRIVE_ID', names.dispatchHyperdriveId],
					['FACT_HYPERDRIVE_ID', names.factHyperdriveId],
				]
			: []),
	];
	const canonicalId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	for (const [key, id] of ids) {
		if (!canonicalId.test(id)) {
			console.error(`gen-wrangler: ${key} must be a canonical Hyperdrive UUID for shared-key usage repair.`);
			process.exit(1);
		}
	}
	if (new Set(ids.map(([, id]) => id.toLowerCase())).size !== ids.length) {
		console.error('gen-wrangler: repair Hyperdrive ID must differ from runtime, dispatch and fact Hyperdrive IDs.');
		process.exit(1);
	}
}

function validateSharedEarningScannerHyperdriveBindings(names) {
	const {
		sharedEarningScannerActivation: activation,
		earningDeliveryHyperdriveId: deliveryId,
		earningConsumerHyperdriveId: consumerId,
	} = names;
	if ((activation !== '' && activation !== 'false') || deliveryId || consumerId) {
		console.error('gen-wrangler: earning credentials require the dedicated scheduled Worker generator.');
		process.exit(1);
	}
}

function main() {
	const names = resolveNames();
	validateWorkerDatabaseRuntime(names);
	validateReviewProducerHyperdriveBindings(names);
	validateSharedKeyUsageRepairHyperdriveBinding(names);
	validateSharedEarningScannerHyperdriveBindings(names);

	if (REMOTE) {
		validateRemote(names);
	}

	generateProxy(names);
	generateAdmin(names);
	generateChain(names);
	generateD1(names);

	console.log(
		`gen-wrangler: proxy=${names.proxyWorkerName} admin=${names.adminWorkerName} chain=${names.chainWorkerName} queue=${names.chainJobQueueName} d1=${names.d1DatabaseName}` +
			(names.d1DatabaseId ? ` id=${names.d1DatabaseId}` : ' (local, no database_id)') +
			(names.hyperdriveId ? ` hyperdrive=${names.hyperdriveId} driver=${names.databaseDriver || 'd1 (staged target, unbound)'}` : '') +
			(names.maintenanceMode ? ' maintenance=true' : '') +
			(names.reviewProducerHyperdriveBindingsEnabled ? ' review-producer-hyperdrive-bindings=true' : '') +
			(names.sharedKeyUsageRepairActivation === 'reviewed-v3' ? ' shared-key-usage-repair=reviewed-v3' : '') +
			(names.batchInfraEnabled
				? ` batch-infra=true batch-bucket=${names.batchBucketName} batch-queue=${names.batchQueueName}`
				: ' batch-infra=false'),
	);

	if (REMOTE && names.d1DatabaseId) {
		console.warn(
			'gen-wrangler: remote config written (includes database_id). ' +
				'Before local dev:proxy/dev:admin, run `npm run gen:wrangler` without D1_DATABASE_ID in the shell.',
		);
	}
}

main();
