import { useQuery } from '@tanstack/react-query'
import { cinatokenApi, accountQueryKey } from '../api'

export function useGatewayKeys(
	userId: string,
	workspaceId: string,
	enabled = true
) {
	return useQuery({
		queryKey: accountQueryKey(userId, workspaceId, 'gateway-keys'),
		queryFn: async ({ signal }) => {
			const context = await cinatokenApi.gatewayKeyContext({
				signal,
				expectedUserId: userId,
				expectedWorkspaceId: workspaceId,
			})
			if (context.keys.some((key) => key.workspaceId !== workspaceId))
				throw new Error('Workspace data changed; refresh your session.')
			return context
		},
		enabled: enabled && Boolean(userId && workspaceId),
		retry: false,
		staleTime: 15_000,
	})
}
