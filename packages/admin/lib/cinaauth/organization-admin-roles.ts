import type { WorkspaceAccessProjection } from '@octafuse/core';

const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/**
 * CinaAuth role names are tenant-defined and therefore require an explicit
 * deployment mapping. An absent or invalid mapping deliberately grants no
 * organization-wide authority.
 */
export function parseOrganizationAdminRoles(value: string | undefined): ReadonlySet<string> {
	if (!value?.trim()) return new Set<string>();
	const roles = value.split(',').map((role) => role.trim());
	if (
		roles.length > 32
		|| roles.some((role) => !role || role.length > 128 || !ROLE_PATTERN.test(role))
	) {
		return new Set<string>();
	}
	return new Set(roles);
}

export function hasAuthoritativeOrganizationAdminRole(
	workspace: WorkspaceAccessProjection,
	configuredRoles: string | undefined,
): boolean {
	if (workspace.scopeType !== 'organization' || !workspace.organizationId) return false;
	const allowed = parseOrganizationAdminRoles(configuredRoles);
	if (allowed.size === 0) return false;
	return (workspace.organizationRoles ?? []).some((role) => allowed.has(role));
}
