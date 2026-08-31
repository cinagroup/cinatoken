/**
 * Runtime-only Provider API-key references.
 *
 * Database rows persist a non-secret `env:NAME` reference. The actual secret is
 * injected by the runtime binding and is never copied into provider storage.
 * Resolution is additionally bound to a deterministic Provider id and an
 * allowlist of upstream hosts so a writable database row cannot redirect a
 * referenced secret to an arbitrary endpoint.
 */
import { parseProviderEndpoints } from "../provider-endpoints";
import type { ProvidersRepository } from "../storage/gateway-repository-interfaces";
import type { ProviderRow } from "../types";

const PROVIDER_API_KEY_ENV_REFERENCE_RE = /^env:([A-Z][A-Z0-9_]*)$/u;
const PROVIDER_API_KEY_ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/u;

export type ProviderEnvironmentSecretPolicy = {
	providerId: string;
	envName: string;
	allowedEndpointHosts: readonly string[];
};

export const DEEPSEEK_OFFICIAL_PROVIDER_ID = "deepseek-official";
export const DEEPSEEK_API_KEY_ENV_NAME = "DEEPSEEK_API_KEY";
export const DEEPSEEK_OFFICIAL_ENVIRONMENT_SECRET_POLICY = {
	providerId: DEEPSEEK_OFFICIAL_PROVIDER_ID,
	envName: DEEPSEEK_API_KEY_ENV_NAME,
	allowedEndpointHosts: ["api.deepseek.com"],
} as const satisfies ProviderEnvironmentSecretPolicy;

export function formatProviderApiKeyEnvironmentReference(envName: string): string {
	const normalized = envName.trim();
	if (!PROVIDER_API_KEY_ENV_NAME_RE.test(normalized)) {
		throw new TypeError("Provider API key environment name is invalid");
	}
	return `env:${normalized}`;
}

export function parseProviderApiKeyEnvironmentReference(
	value: string | null | undefined
): string | null {
	if (typeof value !== "string") return null;
	return PROVIDER_API_KEY_ENV_REFERENCE_RE.exec(value.trim())?.[1] ?? null;
}

export function isProviderApiKeyEnvironmentReference(
	value: string | null | undefined
): boolean {
	return parseProviderApiKeyEnvironmentReference(value) !== null;
}

function endpointHostsAreAllowed(
	provider: Pick<ProviderRow, "endpoints">,
	allowedEndpointHosts: readonly string[]
): boolean {
	const allowed = new Set(
		allowedEndpointHosts.map((host) => host.trim().toLowerCase()).filter(Boolean)
	);
	if (allowed.size === 0) return false;

	try {
		const endpoints = parseProviderEndpoints(provider);
		const urls = Object.values(endpoints).flatMap((config) => [
			config?.base,
			...Object.values(config?.endpoints ?? {}),
		]).filter((value): value is string => Boolean(value));
		return urls.length > 0 && urls.every((raw) => {
			const url = new URL(raw);
			return (url.protocol === "https:" || url.protocol === "wss:")
				&& allowed.has(url.hostname.toLowerCase());
		});
	} catch {
		return false;
	}
}

function resolveRow<T extends ProviderRow>(
	row: T | null,
	policies: readonly ProviderEnvironmentSecretPolicy[],
	secrets: Readonly<Record<string, string | undefined>>
): T | null {
	if (!row) return null;
	const envName = parseProviderApiKeyEnvironmentReference(row.api_key);
	if (!envName) return row;

	const policy = policies.find(
		(candidate) => candidate.envName === envName && candidate.providerId === row.id
	);
	const secret = secrets[envName]?.trim();
	if (!policy || !secret || !endpointHostsAreAllowed(row, policy.allowedEndpointHosts)) {
		// Missing/misbound references fail closed and are filtered by the router as
		// an empty Provider key. Never return the reference as an upstream secret.
		return { ...row, api_key: "" };
	}
	return { ...row, api_key: secret };
}

/**
 * Resolve approved environment-backed keys only on runtime Provider reads.
 *
 * Admin list/reveal methods intentionally keep returning the non-secret
 * reference, so an environment secret cannot be copied back through the API.
 */
export function createEnvironmentProviderKeysRepository(
	repository: ProvidersRepository,
	options: {
		policies: readonly ProviderEnvironmentSecretPolicy[];
		secrets: Readonly<Record<string, string | undefined>>;
	}
): ProvidersRepository {
	return {
		...repository,
		async getProvidersByIds(ids) {
			return (await repository.getProvidersByIds(ids)).map(
				(row) => resolveRow(row, options.policies, options.secrets)!
			);
		},
		async getProviderById(id) {
			return resolveRow(
				await repository.getProviderById(id),
				options.policies,
				options.secrets
			);
		},
	};
}
