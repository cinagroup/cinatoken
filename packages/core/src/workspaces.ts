/** Gateway Workspace domain types. CinaAuth remains authoritative for organizations. */

export const WORKSPACE_SCOPE_TYPES = ['personal', 'organization'] as const;
export type WorkspaceScopeType = (typeof WORKSPACE_SCOPE_TYPES)[number];

export const WORKSPACE_STATUSES = ['active', 'archived'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const WORKSPACE_ROLES = ['admin', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type WorkspaceAccessSource =
	| 'personal_owner'
	| 'organization_default'
	| 'workspace_membership';

export type WorkspaceAccessProjection = {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	scopeType: WorkspaceScopeType;
	organizationId: string | null;
	organizationName: string | null;
	organizationSlug: string | null;
	/** Authoritative CinaAuth roles for this organization membership. */
	organizationRoles?: string[];
	personalOwnerUserId: string | null;
	isDefault: boolean;
	status: WorkspaceStatus;
	role: 'owner' | WorkspaceRole;
	accessSource: WorkspaceAccessSource;
	createdAt: string;
	updatedAt: string;
};

export type WorkspaceContextProjection = {
	workspaces: WorkspaceAccessProjection[];
	currentWorkspace: WorkspaceAccessProjection;
	/** Whether a non-empty browser preference resolved to an authorized row. */
	preferredWorkspaceAvailable: boolean;
};

const MAX_WORKSPACE_ID_LENGTH = 600;

function defaultOwnerId(value: string, scope: WorkspaceScopeType): string {
	if (!value || value.length > (scope === 'personal' ? 512 : 255)) {
		throw new Error(`${scope} workspace owner id is invalid`);
	}
	return value;
}

/** Stable id used by migrations, lazy provisioning, and later resource backfills. */
export function defaultWorkspaceId(scope: WorkspaceScopeType, ownerId: string): string {
	const id = `${scope}:${defaultOwnerId(ownerId, scope)}`;
	if (id.length > MAX_WORKSPACE_ID_LENGTH) {
		throw new Error('default workspace id is too long');
	}
	return id;
}

export function isReservedDefaultWorkspaceId(value: string): boolean {
	return value.startsWith('personal:') || value.startsWith('organization:');
}

/** Stable, delimiter-safe membership uniqueness key for all three database engines. */
export async function workspaceMembershipKey(workspaceId: string, subject: string): Promise<string> {
	if (!workspaceId || workspaceId.length > MAX_WORKSPACE_ID_LENGTH) {
		throw new Error('workspace id is invalid');
	}
	if (!subject || subject.length > 255) {
		throw new Error('workspace member subject is invalid');
	}
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${workspaceId.length}:${workspaceId}${subject}`),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
