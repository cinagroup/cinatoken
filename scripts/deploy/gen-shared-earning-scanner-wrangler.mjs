// Review-only local config generator for the scheduled financial Worker.
// It never calls Cloudflare or deploys. The default invocation writes nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scannerBase = resolve(root,'packages/proxy/wrangler.shared-earning-scanner.base.jsonc');
const scannerOutput = resolve(root,'packages/proxy/wrangler.shared-earning-scanner.jsonc');
const proxyOutput = resolve(root,'packages/proxy/wrangler.jsonc');
const adminOutput = resolve(root,'packages/admin/wrangler.jsonc');
const chainOutput = resolve(root,'packages/chain-worker/wrangler.jsonc');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NAME = /^[a-z][a-z0-9-]{0,62}$/u;

function readJson(path) {
	return JSON.parse(readFileSync(path,'utf8'));
}

function checkedId(value, name) {
	if (typeof value !== 'string' || !UUID.test(value) || value !== value.trim())
		throw new TypeError(`${name} must be a canonical Hyperdrive UUID`);
	return value.toLowerCase();
}

function noFinancialAuthorityInHttp(config, name) {
	if (!config || typeof config !== 'object')
		throw new TypeError(`Missing generated ${name} HTTP Worker configuration`);
	if (config.vars?.SHARED_EARNING_SCANNER_ENABLED !== undefined ||
		(config.hyperdrive ?? []).some(item =>
			item?.binding === 'EARNING_DELIVERY_HYPERDRIVE' ||
			item?.binding === 'EARNING_CONSUMER_HYPERDRIVE'))
		throw new TypeError(`${name} HTTP Worker already has earning scanner authority`);
}

export function buildSharedEarningScannerConfig(environment, httpConfigs, base) {
	if (environment.SHARED_EARNING_SCANNER_ENABLED !== 'dedicated-v1')
		throw new TypeError('Dedicated scanner activation must be dedicated-v1');
	if (!Array.isArray(httpConfigs) || httpConfigs.length !== 3)
		throw new TypeError('Proxy, admin and chain Worker configurations are required');
	const allowedBaseKeys = new Set(['$schema','name','main','compatibility_date',
		'compatibility_flags','workers_dev','triggers','vars','observability']);
	if (base?.main !== 'src/runtime/shared-earning-scanner-worker.ts' ||
		base.workers_dev !== false || base.routes !== undefined ||
		base.d1_databases !== undefined || base.services !== undefined ||
		base.queues !== undefined || base.secrets !== undefined ||
		base.r2_buckets !== undefined || base.hyperdrive !== undefined ||
		Object.keys(base).some(key=>!allowedBaseKeys.has(key)) ||
		Object.keys(base.triggers ?? {}).some(key=>key!=='crons') ||
		Object.keys(base.vars ?? {}).length!==0 ||
		!Array.isArray(base.triggers?.crons) || base.triggers.crons.length !== 1 ||
		base.triggers.crons[0] !== '17 * * * *')
		throw new TypeError('Dedicated scanner base configuration differs');
	const deliveryId = checkedId(environment.EARNING_DELIVERY_HYPERDRIVE_ID,
		'EARNING_DELIVERY_HYPERDRIVE_ID');
	const consumerId = checkedId(environment.EARNING_CONSUMER_HYPERDRIVE_ID,
		'EARNING_CONSUMER_HYPERDRIVE_ID');
	if (deliveryId === consumerId)
		throw new TypeError('Dedicated delivery and consumer Hyperdrive IDs must differ');
	const boundIds = [];
	for (const [index, config] of httpConfigs.entries()) {
		noFinancialAuthorityInHttp(config, ['proxy','admin','chain'][index]);
		for (const binding of config.hyperdrive ?? [])
			boundIds.push(checkedId(binding?.id,'HTTP Worker Hyperdrive ID'));
	}
	if (boundIds.includes(deliveryId) || boundIds.includes(consumerId))
		throw new TypeError('Dedicated earning Hyperdrive ID is already bound to an HTTP Worker');
	const name = environment.SHARED_EARNING_SCANNER_WORKER_NAME ||
		'cinatoken-shared-earning-scanner-review';
	if (!NAME.test(name) || httpConfigs.some(config => config.name === name))
		throw new TypeError('Dedicated scanner Worker name is invalid or reused');
	return {
		...base,
		name,
		vars: { SHARED_EARNING_SCANNER_ENABLED: 'dedicated-v1' },
		hyperdrive: [
			{ binding:'EARNING_DELIVERY_HYPERDRIVE', id:deliveryId },
			{ binding:'EARNING_CONSUMER_HYPERDRIVE', id:consumerId },
		],
	};
}

function main() {
	const args = process.argv.slice(2);
	if (args.length !== 1 || (args[0] !== '--print' && args[0] !== '--write'))
		throw new TypeError('Use --print or --write; this generator never deploys');
	const config = buildSharedEarningScannerConfig(process.env,
		[readJson(proxyOutput),readJson(adminOutput),readJson(chainOutput)],readJson(scannerBase));
	const serialized = JSON.stringify(config,null,'\t')+'\n';
	if (args[0] === '--print') process.stdout.write(serialized);
	else {
		writeFileSync(scannerOutput,serialized,{flag:'w'});
		process.stdout.write('Wrote packages/proxy/wrangler.shared-earning-scanner.jsonc\n');
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(); }
	catch (error) {
		console.error(`gen-shared-earning-scanner-wrangler: ${error instanceof Error ?
			error.message : String(error)}`);
		process.exitCode=1;
	}
}
