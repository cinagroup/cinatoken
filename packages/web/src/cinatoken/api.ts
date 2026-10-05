import { z } from 'zod'
import { createActivityApi } from './activity-api'
import { createByokApi } from './byok-api'
import {
	authCheckSchema,
	createdGatewayKeySchema,
	createdManagementKeySchema,
	createGatewayKeyInputSchema,
	createManagementKeyInputSchema,
	gatewayKeySchema,
	managementKeySchema,
	managementKeyAccountSchema,
	portalMeSchema,
	workspaceContextSchema,
	type CreateGatewayKeyInput,
	type CreateManagementKeyInput,
	type ManagementKeyAccount,
} from './contracts'
import { createEarningsApi } from './earnings-api'
import { createGuardrailsApi } from './guardrail-api'
import { createNftApi } from './nft-api'
import { createPresetsApi } from './preset-api'
import { createSharedKeyApi } from './shared-key-api'
import { createWalletApi } from './wallet-api'
import { createWithdrawalsApi } from './withdrawal-api'
import { createWorkspaceBudgetApi } from './workspace-budget-api'

export type RequestOptions = {
	signal?: AbortSignal
	timeoutMs?: number
	expectedWorkspaceId?: string
	expectedUserId?: string
	expectedManagementAccount?: ManagementKeyAccount
}

export const WORKSPACE_PRECONDITION_HEADER = 'X-CinaToken-Workspace'
export const USER_PRECONDITION_HEADER = 'X-CinaToken-Expected-User-Id'

type PublicServerErrorCode =
	| 'workspace_mismatch'
	| 'user_mismatch'
	| 'invalid_user_precondition'
	| 'invalid_workspace_precondition'
	| 'shared_key_earning_history_immutable'
	| 'withdrawal_quote_changed'
	| 'withdrawal_dispatch_unconfirmed'
	| 'model_route_policy_conflict'
	| 'model_route_policy_precondition_required'

function publicServerCode(value: unknown): PublicServerErrorCode | null {
	if (typeof value !== 'object' || value === null || !('code' in value))
		return null
	if (
		value.code === 'workspace_mismatch' ||
		value.code === 'user_mismatch' ||
		value.code === 'invalid_user_precondition' ||
		value.code === 'invalid_workspace_precondition' ||
		value.code === 'shared_key_earning_history_immutable' ||
		value.code === 'withdrawal_quote_changed' ||
		value.code === 'withdrawal_dispatch_unconfirmed' ||
		value.code === 'model_route_policy_conflict' ||
		value.code === 'model_route_policy_precondition_required'
	)
		return value.code
	return null
}

function expectedContextHeader(input: string, kind: string): string {
	const value = z.string().min(1).max(600).parse(input)
	if (
		value.trim() !== value ||
		Array.from(value).some((character) => {
			const code = character.charCodeAt(0)
			return (
				code < 32 ||
				code === 127 ||
				(kind === 'user' && code > 127 && code <= 159)
			)
		})
	) {
		throw new TypeError('Expected ' + kind + ' id is invalid')
	}
	return encodeURIComponent(value)
}

export class CinaTokenApiError extends Error {
	readonly status: number
	readonly serverCode: PublicServerErrorCode | null
	readonly code:
		| 'http'
		| 'business'
		| 'invalid-response'
		| 'network'
		| 'timeout'
		| 'cancelled'
		| 'workspace-mismatch'
		| 'user-mismatch'

	constructor(
		message: string,
		status: number,
		code: CinaTokenApiError['code'],
		serverCode: PublicServerErrorCode | null = null
	) {
		super(message)
		this.name = 'CinaTokenApiError'
		this.status = status
		this.code = code
		this.serverCode = serverCode
	}
}

function serverMessage(value: unknown): string | null {
	if (typeof value !== 'object' || value === null) return null
	if ('message' in value && typeof value.message === 'string')
		return value.message
	return null
}

export function accountQueryKey(
	userId: string,
	workspaceId: string,
	...parts: readonly unknown[]
): readonly unknown[] {
	return ['cinatoken', 'account', userId, workspaceId, ...parts] as const
}

/** Only server-declared context conflicts invalidate account scope. */
function responseErrorCode(
	status: number,
	serverCode: PublicServerErrorCode | null
): CinaTokenApiError['code'] {
	if (status === 409 && serverCode === 'workspace_mismatch')
		return 'workspace-mismatch'
	if (status === 409 && serverCode === 'user_mismatch') return 'user-mismatch'
	return 'http'
}

/** Shared Cookie transport; callers choose their own domain response and context checks. */
export function createCinaTokenCookieTransport(request: typeof fetch = fetch) {
	async function send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit = {},
		options: RequestOptions = {},
		reader?: (response: Response) => Promise<unknown>,
		acceptedBusinessConflict?: (response: Response, body: unknown) => boolean
	): Promise<T> {
		const headers = new Headers(init.headers)
		if (!headers.has('Accept')) headers.set('Accept', 'application/json')
		// Caller headers never choose the reserved user precondition. Admin and
		// public requests share this transport but must not carry account identity.
		headers.delete(USER_PRECONDITION_HEADER)
		if (path.startsWith('/api/user/') && options.expectedUserId !== undefined)
			headers.set(
				USER_PRECONDITION_HEADER,
				expectedContextHeader(options.expectedUserId, 'user')
			)
		if (options.expectedWorkspaceId !== undefined)
			headers.set(
				WORKSPACE_PRECONDITION_HEADER,
				expectedContextHeader(options.expectedWorkspaceId, 'workspace')
			)
		const controller = new AbortController()
		const externalAbort = () => controller.abort(options.signal?.reason)
		if (options.signal?.aborted) externalAbort()
		options.signal?.addEventListener('abort', externalAbort, { once: true })
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, options.timeoutMs ?? 15_000)
		try {
			if (controller.signal.aborted)
				throw new CinaTokenApiError('Request cancelled', 0, 'cancelled')
			const response = await request(path, {
				...init,
				credentials: 'same-origin',
				cache: 'no-store',
				redirect: 'error',
				headers,
				signal: controller.signal,
			})
			let body: unknown
			try {
				body =
					reader && response.ok ? await reader(response) : await response.json()
			} catch (error) {
				if (error instanceof CinaTokenApiError) throw error
				if (!response.ok)
					throw new CinaTokenApiError(
						`Request failed (${response.status})`,
						response.status,
						'http'
					)
				throw new CinaTokenApiError(
					reader
						? 'Server returned invalid export data'
						: 'Server returned invalid JSON',
					response.status,
					'invalid-response'
				)
			}
			const businessConflict =
				acceptedBusinessConflict?.(response, body) === true
			if (!response.ok && !businessConflict) {
				const serverCode = publicServerCode(body)
				throw new CinaTokenApiError(
					serverMessage(body) ?? `Request failed (${response.status})`,
					response.status,
					responseErrorCode(response.status, serverCode),
					serverCode
				)
			}
			if (
				typeof body === 'object' &&
				body !== null &&
				'success' in body &&
				body.success === false &&
				!businessConflict
			) {
				throw new CinaTokenApiError(
					serverMessage(body) ?? 'Request was rejected',
					response.status,
					'business',
					publicServerCode(body)
				)
			}
			const parsed = schema.safeParse(body)
			if (!parsed.success)
				throw new CinaTokenApiError(
					'Server response does not match the API contract',
					response.status,
					'invalid-response'
				)
			// Abort remains authoritative even if an injected transport ignores AbortSignal.
			if (controller.signal.aborted)
				throw new CinaTokenApiError(
					timedOut ? 'Request timed out' : 'Request cancelled',
					0,
					timedOut ? 'timeout' : 'cancelled'
				)
			return parsed.data
		} catch (error) {
			if (controller.signal.aborted)
				throw new CinaTokenApiError(
					timedOut ? 'Request timed out' : 'Request cancelled',
					0,
					timedOut ? 'timeout' : 'cancelled'
				)
			if (error instanceof CinaTokenApiError) throw error
			throw new CinaTokenApiError('Unable to reach the server', 0, 'network')
		} finally {
			clearTimeout(timer)
			options.signal?.removeEventListener('abort', externalAbort)
		}
	}

	return { send }
}

/** Cookie-backed browser requests use same-origin paths and never attach legacy user headers. */
export function createCinaTokenApi(request: typeof fetch = fetch) {
	const { send } = createCinaTokenCookieTransport(request)

	async function data<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: RequestOptions
	): Promise<T> {
		const result = await send(
			path,
			z.object({ success: z.literal(true), data: schema }),
			init,
			options
		)
		return result.data
	}

	function checkWorkspace(actual: string, options: RequestOptions): void {
		if (options.expectedWorkspaceId && options.expectedWorkspaceId !== actual) {
			throw new CinaTokenApiError(
				'Workspace changed while the request was running',
				0,
				'workspace-mismatch'
			)
		}
	}

	function checkManagementAccount(
		actual: ManagementKeyAccount,
		options: RequestOptions
	): void {
		if (!options.expectedManagementAccount) return
		const expected = managementKeyAccountSchema.parse(
			options.expectedManagementAccount
		)
		if (
			actual.account_type !== expected.account_type ||
			actual.personal_owner_user_id !== expected.personal_owner_user_id ||
			actual.organization_id !== expected.organization_id
		) {
			throw new CinaTokenApiError(
				'Management key account changed while the request was running',
				0,
				'workspace-mismatch'
			)
		}
	}

	return {
		...createPresetsApi({
			send,
			checkWorkspace,
			invalidResponse(message) {
				throw new CinaTokenApiError(message, 200, 'invalid-response')
			},
			sanitizeError(error) {
				if (error instanceof CinaTokenApiError)
					return new CinaTokenApiError(
						'Preset operation could not be confirmed',
						error.status,
						error.code,
						error.serverCode
					)
				return new Error('Preset operation could not be confirmed')
			},
		}),
		...createGuardrailsApi({
			send,
			sendEffective(path, schema, init, options) {
				if (
					(init.method ?? 'GET').toUpperCase() !== 'GET' ||
					(path !== '/api/user/guardrails/effective' &&
						!path.startsWith('/api/user/guardrails/effective?'))
				) {
					throw new TypeError('Invalid effective Guardrail request')
				}
				return send(
					path,
					schema,
					init,
					options,
					undefined,
					(response, body) =>
						response.status === 409 &&
						typeof body === 'object' &&
						body !== null &&
						'success' in body &&
						body.success === false &&
						'code' in body &&
						body.code === 'guardrail_effective_conflict'
				)
			},
			checkWorkspace,
			invalidResponse(message) {
				throw new CinaTokenApiError(message, 200, 'invalid-response')
			},
		}),
		...createSharedKeyApi({
			send,
			invalidResponse() {
				throw new CinaTokenApiError(
					'Shared-key response is invalid',
					200,
					'invalid-response'
				)
			},
			sanitizeError(error) {
				if (error instanceof CinaTokenApiError)
					return new CinaTokenApiError(
						'Shared key operation could not be confirmed',
						error.status,
						error.code,
						error.serverCode
					)
				return new Error('Shared key operation could not be confirmed')
			},
		}),
		...createEarningsApi({
			send,
			checkWorkspace,
			invalidResponse(message) {
				throw new CinaTokenApiError(message, 200, 'invalid-response')
			},
		}),
		...createNftApi({
			send,
			checkWorkspace,
			invalidResponse(message) {
				throw new CinaTokenApiError(message, 200, 'invalid-response')
			},
		}),
		...createWalletApi({
			send,
			checkWorkspace,
			invalidResponse(message) {
				throw new CinaTokenApiError(message, 200, 'invalid-response')
			},
			sanitizeError(error) {
				if (error instanceof CinaTokenApiError)
					return new CinaTokenApiError(
						'Wallet operation could not be confirmed',
						error.status,
						error.code,
						error.serverCode
					)
				return new Error('Wallet operation could not be confirmed')
			},
		}),
		...createWithdrawalsApi({
			send,
			checkWorkspace,
			invalidResponse(message) {
				throw new CinaTokenApiError(message, 200, 'invalid-response')
			},
		}),
		...createWorkspaceBudgetApi({
			send,
			checkWorkspace,
			invalidResponse(message) {
				throw new CinaTokenApiError(message, 200, 'invalid-response')
			},
		}),
		...createActivityApi({
			send,
			checkWorkspace,
			invalidResponse(message) {
				throw new CinaTokenApiError(message, 200, 'invalid-response')
			},
		}),
		...createByokApi({
			send,
			checkWorkspace,
			invalidResponse(message) {
				throw new CinaTokenApiError(message, 200, 'invalid-response')
			},
		}),
		me: (options: RequestOptions = {}) =>
			data('/api/user/me', portalMeSchema, {}, options),
		authCheck: (options: RequestOptions = {}) =>
			send('/api/auth/check', authCheckSchema, {}, options),
		workspaces: (options: RequestOptions = {}) =>
			data('/api/user/workspaces', workspaceContextSchema, {}, options),
		switchWorkspace: async (
			workspaceId: string,
			options: RequestOptions = {}
		) => {
			const id = z.string().trim().min(1).max(600).parse(workspaceId)
			const result = await data(
				'/api/user/workspaces/current',
				workspaceContextSchema,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ workspace_id: id }),
				},
				options
			)
			checkWorkspace(result.currentWorkspace.id, { expectedWorkspaceId: id })
			return result
		},
		gatewayKeys: async (options: RequestOptions = {}) => {
			const result = await send(
				'/api/user/gateway-keys',
				z.object({
					success: z.literal(true),
					data: z.array(gatewayKeySchema),
					workspaceId: z.string().min(1).optional(),
				}),
				{},
				options
			)
			if (options.expectedWorkspaceId !== undefined && !result.workspaceId)
				throw new CinaTokenApiError(
					'Server omitted the current workspace identity',
					200,
					'invalid-response'
				)
			if (result.workspaceId) checkWorkspace(result.workspaceId, options)
			result.data.forEach((key) => checkWorkspace(key.workspaceId, options))
			return result.data
		},
		gatewayKeyContext: async (options: RequestOptions = {}) => {
			const result = await send(
				'/api/user/gateway-keys',
				z.object({
					success: z.literal(true),
					data: z.array(gatewayKeySchema),
					billingCurrency: z.string().regex(/^[A-Z]{3}$/u),
					workspaceId: z.string().min(1),
				}),
				{},
				options
			)
			checkWorkspace(result.workspaceId, options)
			result.data.forEach((key) => checkWorkspace(key.workspaceId, options))
			return {
				keys: result.data,
				billingCurrency: result.billingCurrency,
				workspaceId: result.workspaceId,
			}
		},
		// Call directly from a scoped component; the once-only secret must not enter Query caches.
		createGatewayKey: async (
			input: CreateGatewayKeyInput,
			options: RequestOptions = {}
		) => {
			const body = createGatewayKeyInputSchema.parse(input)
			const result = await data(
				'/api/user/gateway-keys',
				createdGatewayKeySchema,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				},
				options
			)
			checkWorkspace(result.workspace_id, options)
			return result
		},
		revokeGatewayKey: async (
			id: string,
			options: RequestOptions = {}
		): Promise<void> => {
			z.string().min(1).parse(id)
			await send(
				`/api/user/gateway-keys/${encodeURIComponent(id)}`,
				z.object({ success: z.literal(true) }),
				{ method: 'DELETE' },
				options
			)
		},
		managementKeys: async (
			options: RequestOptions & { includeRevoked?: boolean } = {}
		) => {
			const includeRevoked = options.includeRevoked ?? true
			const result = await data(
				`/api/user/management-keys?include_revoked=${includeRevoked ? 'true' : 'false'}`,
				z.array(managementKeySchema),
				{},
				options
			)
			result.forEach((key) => checkManagementAccount(key, options))
			return result
		},
		createManagementKey: async (
			input: CreateManagementKeyInput,
			options: RequestOptions = {}
		) => {
			const body = createManagementKeyInputSchema.parse(input)
			const result = await send(
				'/api/user/management-keys',
				createdManagementKeySchema,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				},
				options
			)
			checkManagementAccount(result.data, options)
			return { data: result.data, key: result.key }
		},
		revokeManagementKey: async (
			id: string,
			options: RequestOptions = {}
		): Promise<void> => {
			z.string().min(1).max(64).parse(id)
			await send(
				`/api/user/management-keys/${encodeURIComponent(id)}`,
				z.object({ success: z.literal(true) }),
				{ method: 'DELETE' },
				options
			)
		},
		logout: async (options: RequestOptions = {}): Promise<void> => {
			await send(
				'/api/auth/logout',
				z.object({ success: z.literal(true) }),
				{ method: 'POST' },
				options
			)
		},
	}
}

export const cinatokenApi = createCinaTokenApi()
export type CinaTokenApi = ReturnType<typeof createCinaTokenApi>
