import type { ManagementKeyAccount, PortalMe, Workspace } from '../contracts'

export function managementAccount(workspace: Workspace): ManagementKeyAccount {
	if (workspace.scopeType === 'personal') {
		if (!workspace.personalOwnerUserId)
			throw new Error('Personal account owner is unavailable')
		return {
			account_type: 'personal',
			personal_owner_user_id: workspace.personalOwnerUserId,
			organization_id: null,
		}
	}
	if (!workspace.organizationId)
		throw new Error('Organization account is unavailable')
	return {
		account_type: 'organization',
		personal_owner_user_id: null,
		organization_id: workspace.organizationId,
	}
}

/** Organization authority uses deployment-defined CinaAuth role mappings and must be checked by the API. */
export function managementAccessRestriction(
	user: PortalMe,
	workspace: Workspace
): 'capability' | 'owner' | 'organization' | null {
	if (!user.capabilities.includes('management_keys.manage')) return 'capability'
	if (workspace.scopeType === 'personal') {
		if (
			workspace.personalOwnerUserId !== user.userId ||
			workspace.role !== 'owner'
		)
			return 'owner'
		return null
	}
	if (!workspace.organizationId) return 'organization'
	return null
}
