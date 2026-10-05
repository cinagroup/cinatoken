import type { PortalMe, Workspace, WorkspaceContext } from './contracts'

export const testUser: PortalMe = {
	userId: 'user:alice',
	subject: 'cinaauth:alice',
	email: 'alice@example.test',
	isAdmin: false,
	capabilities: ['account.read', 'gateway_keys.manage'],
	organizations: [],
}

export function testWorkspace(id = 'personal:alice'): Workspace {
	return {
		id,
		name: id,
		slug: 'alice',
		description: null,
		scopeType: 'personal',
		organizationId: null,
		organizationName: null,
		organizationSlug: null,
		personalOwnerUserId: 'user:alice',
		isDefault: true,
		status: 'active',
		role: 'owner',
		accessSource: 'personal_owner',
		createdAt: '2026-09-27T00:00:00.000Z',
		updatedAt: '2026-09-27T00:00:00.000Z',
	}
}

export function testWorkspaceContext(
	current = 'personal:alice'
): WorkspaceContext {
	return {
		workspaces: [testWorkspace(), testWorkspace('workspace:team')],
		currentWorkspace: testWorkspace(current),
		preferredWorkspaceAvailable: true,
	}
}

export function deferred<T>(): {
	promise: Promise<T>
	resolve: (value: T) => void
	reject: (error: unknown) => void
} {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept
		reject = decline
	})
	return { promise, resolve, reject }
}
