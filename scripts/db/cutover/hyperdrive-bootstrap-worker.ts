import {
	GATEWAY_MIGRATOR_ROLE,
	GATEWAY_RUNTIME_ROLE,
	GATEWAY_SCHEMA,
	provisionPostgresRoles,
} from './provision-postgres-roles';
import { isDiagnosticRequestAuthorized } from './diagnostic-auth';

interface BootstrapEnv {
	ADMIN_HYPERDRIVE: { readonly connectionString: string };
	PREFLIGHT_TOKEN?: string;
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID: string;
	POSTGRES_ORIGIN_HOST: string;
	POSTGRES_ORIGIN_DATABASE: string;
	POSTGRES_ORIGIN_PORT: string;
	POSTGRES_BRANCH_ID: string;
	MIGRATOR_HYPERDRIVE_NAME: string;
	RUNTIME_HYPERDRIVE_NAME: string;
}

type HyperdriveConfig = {
	id: string;
	name: string;
	origin?: { user?: string };
};

type CloudflareEnvelope<T> = {
	success?: boolean;
	result?: T;
	errors?: Array<{ code?: number; message?: string; source?: { pointer?: string } }>;
};

export function generateBootstrapPassword(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function planetScaleConnectionUser(role: string, branchId: string): string {
	if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) throw new Error('invalid_postgres_role');
	if (!/^[a-z0-9]{6,32}$/u.test(branchId)) throw new Error('invalid_planetscale_branch_id');
	return `${role}.${branchId}`;
}

function cloudflareErrorCode(body: CloudflareEnvelope<unknown>): string {
	const code = body.errors?.[0]?.code;
	return typeof code === 'number' ? String(code) : 'unknown';
}

function cloudflareErrorPointer(body: CloudflareEnvelope<unknown>): string {
	const pointer = body.errors?.[0]?.source?.pointer;
	return typeof pointer === 'string' && /^\/[A-Za-z0-9_./~-]{1,100}$/u.test(pointer)
		? pointer.replaceAll('/', '_')
		: 'unknown';
}

async function cloudflareRequest<T>(
	env: BootstrapEnv,
	path: string,
	init?: RequestInit,
): Promise<CloudflareEnvelope<T>> {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}${path}`,
		{
			...init,
			headers: {
				Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json',
				...(init?.headers ?? {}),
			},
		},
	);
	const body = await response.json().catch(() => ({})) as CloudflareEnvelope<T>;
	if (!response.ok || body.success !== true) {
		throw new Error(
			`cloudflare_api_${response.status}_${cloudflareErrorCode(body)}_${cloudflareErrorPointer(body)}`,
		);
	}
	return body;
}

async function listHyperdrives(env: BootstrapEnv): Promise<HyperdriveConfig[]> {
	const body = await cloudflareRequest<HyperdriveConfig[]>(env, '/hyperdrive/configs?per_page=100');
	return Array.isArray(body.result) ? body.result : [];
}

async function createHyperdrive(
	env: BootstrapEnv,
	name: string,
	role: string,
	password: string,
	originConnectionLimit: number,
): Promise<HyperdriveConfig> {
	const port = Number(env.POSTGRES_ORIGIN_PORT);
	if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
		throw new Error('invalid_postgres_origin_port');
	}
	const body = await cloudflareRequest<HyperdriveConfig>(env, '/hyperdrive/configs', {
		method: 'POST',
		body: JSON.stringify({
			name,
			origin: {
				host: env.POSTGRES_ORIGIN_HOST,
				port,
				database: env.POSTGRES_ORIGIN_DATABASE,
				scheme: 'postgres',
				user: planetScaleConnectionUser(role, env.POSTGRES_BRANCH_ID),
				password,
			},
			origin_connection_limit: originConnectionLimit,
			caching: { disabled: true },
		}),
	});
	if (!body.result?.id || body.result.name !== name) {
		throw new Error('cloudflare_api_invalid_hyperdrive_result');
	}
	return body.result;
}

async function deleteHyperdrive(env: BootstrapEnv, id: string): Promise<void> {
	await cloudflareRequest<unknown>(env, `/hyperdrive/configs/${encodeURIComponent(id)}`, {
		method: 'DELETE',
	});
}

export default {
	async fetch(request: Request, env: BootstrapEnv): Promise<Response> {
		if (request.method !== 'POST' || new URL(request.url).pathname !== '/bootstrap') {
			return new Response('Not found', { status: 404 });
		}
		if (!env.PREFLIGHT_TOKEN || !env.CLOUDFLARE_API_TOKEN) {
			return Response.json({ ok: false, error: 'missing_bootstrap_secret' }, { status: 503 });
		}
		if (!await isDiagnosticRequestAuthorized(request, env.PREFLIGHT_TOKEN)) {
			return new Response('Not found', { status: 404 });
		}
		if (!env.ADMIN_HYPERDRIVE?.connectionString) {
			return Response.json({ ok: false, error: 'missing_admin_hyperdrive' }, { status: 503 });
		}

		let migratorHyperdrive: HyperdriveConfig | undefined;
		let runtimeHyperdrive: HyperdriveConfig | undefined;
		try {
			const existing = await listHyperdrives(env);
			const conflicting = existing.filter((config) =>
				config.name === env.MIGRATOR_HYPERDRIVE_NAME || config.name === env.RUNTIME_HYPERDRIVE_NAME
			);
			if (conflicting.length > 0) {
				return Response.json({
					ok: false,
					error: 'hyperdrive_name_already_exists',
					ids: conflicting.map((config) => config.id),
				}, { status: 409 });
			}

			const migratorPassword = generateBootstrapPassword();
			const runtimePassword = generateBootstrapPassword();
			await provisionPostgresRoles({
				DATABASE_URL: env.ADMIN_HYPERDRIVE.connectionString,
				CINATOKEN_GATEWAY_MIGRATOR_PASSWORD: migratorPassword,
				CINATOKEN_GATEWAY_RUNTIME_PASSWORD: runtimePassword,
				CINATOKEN_GATEWAY_ROTATE_PASSWORDS: 'true',
			});

			migratorHyperdrive = await createHyperdrive(
				env,
				env.MIGRATOR_HYPERDRIVE_NAME,
				GATEWAY_MIGRATOR_ROLE,
				migratorPassword,
				5,
			);
			runtimeHyperdrive = await createHyperdrive(
				env,
				env.RUNTIME_HYPERDRIVE_NAME,
				GATEWAY_RUNTIME_ROLE,
				runtimePassword,
				15,
			);

			return Response.json({
				ok: true,
				schema: GATEWAY_SCHEMA,
				migrator: { role: GATEWAY_MIGRATOR_ROLE, hyperdrive_id: migratorHyperdrive.id },
				runtime: { role: GATEWAY_RUNTIME_ROLE, hyperdrive_id: runtimeHyperdrive.id },
			}, { headers: { 'Cache-Control': 'no-store' } });
		} catch (error) {
			for (const config of [runtimeHyperdrive, migratorHyperdrive]) {
				if (config?.id) await deleteHyperdrive(env, config.id).catch(() => undefined);
			}
			console.error('cinatoken.hyperdrive_bootstrap_failed', {
				error: error instanceof Error ? error.message : 'unknown',
			});
			return Response.json({ ok: false, error: 'hyperdrive_bootstrap_failed' }, { status: 502 });
		}
	},
} satisfies {
	fetch(request: Request, env: BootstrapEnv): Promise<Response>;
};
