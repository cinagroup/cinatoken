import { provisionPostgresRoles } from './provision-postgres-roles';
import { isDiagnosticRequestAuthorized } from './diagnostic-auth';

interface DryRunEnv {
	HYPERDRIVE: { readonly connectionString: string };
	PREFLIGHT_TOKEN?: string;
}

/** Runs the exact role/schema provisioning transaction and always rolls it back. */
export default {
	async fetch(request: Request, env: DryRunEnv): Promise<Response> {
		if (request.method !== 'POST' || new URL(request.url).pathname !== '/') {
			return new Response('Not found', { status: 404 });
		}
		if (!env.PREFLIGHT_TOKEN) {
			return Response.json({ ok: false, error: 'missing_preflight_token' }, { status: 503 });
		}
		if (!await isDiagnosticRequestAuthorized(request, env.PREFLIGHT_TOKEN)) {
			return new Response('Not found', { status: 404 });
		}
		try {
			const nonce = crypto.randomUUID().replaceAll('-', '');
			await provisionPostgresRoles({
				DATABASE_URL: env.HYPERDRIVE.connectionString,
				CINATOKEN_GATEWAY_MIGRATOR_PASSWORD: `dry-run-migrator-${nonce}`,
				CINATOKEN_GATEWAY_RUNTIME_PASSWORD: `dry-run-runtime-${nonce}`,
				CINATOKEN_GATEWAY_DRY_RUN: 'true',
			});
			return Response.json({ ok: true, rolled_back: true }, {
				headers: { 'Cache-Control': 'no-store' },
			});
		} catch (error) {
			console.error('cinatoken.role_provisioning_dry_run_failed', {
				error: error instanceof Error ? error.message : 'unknown',
			});
			return Response.json({ ok: false, error: 'role_provisioning_dry_run_failed' }, { status: 502 });
		}
	},
} satisfies {
	fetch(request: Request, env: DryRunEnv): Promise<Response>;
};
