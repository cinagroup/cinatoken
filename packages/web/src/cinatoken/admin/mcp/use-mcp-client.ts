/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { GatewayKeyRow } from '../gateway-keys/gateway-key-contracts'
import { simulatorAdminApi } from '../simulator/simulator-api'
import type { AdminMcpApi } from './mcp-api'
import {
	buildMcpClientRequest,
	executeMcpClient,
	mcpClientBase,
	McpClientError,
	normalizeMcpClientSecret,
	type McpClientMethod,
	type McpClientDiagnostic,
} from './mcp-client'
import {
	mcpClientFailureMessage,
	mcpClientResultMessage,
} from './mcp-client-feedback'
import type { McpSession } from './use-mcp-admin'

export function useMcpClient(props: {
	api: AdminMcpApi
	session: McpSession
	initialSlug: string
}) {
	const [proxy, setProxy] = useState('')
	const [slug, setSlug] = useState(props.initialSlug)
	const [method, setMethod] = useState<McpClientMethod>('tools/list')
	const [version, setVersion] = useState('2025-06-18')
	const [secret, setSecret] = useState('')
	const [email, setEmail] = useState('')
	const [page, setPage] = useState(1)
	const [keys, setKeys] = useState<GatewayKeyRow[]>([])
	const [total, setTotal] = useState(0)
	const [key, setKey] = useState<GatewayKeyRow | null>(null)
	const [loadingKeys, setLoadingKeys] = useState(false)
	const [pending, setPending] = useState(false)
	const [diagnostic, setDiagnostic] = useState<McpClientDiagnostic | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [previewId, setPreviewId] = useState(1)
	const [response, setResponse] = useState<Awaited<
		ReturnType<typeof executeMcpClient>
	> | null>(null)
	const live = useRef(true),
		generation = useRef(0),
		rpcId = useRef(0)
	const active = useRef<AbortController | null>(null),
		keyRequest = useRef<AbortController | null>(null)
	const sessionKey = JSON.stringify([
		props.session.scopeKey,
		props.session.reconciliationKey,
		props.session.subject,
		props.session.userId,
		props.session.enabled,
	])
	const [previousSession, setPreviousSession] = useState(sessionKey)
	if (previousSession !== sessionKey) {
		setPreviousSession(sessionKey)
		setProxy('')
		setSlug(props.initialSlug)
		setSecret('')
		setKey(null)
		setKeys([])
		setTotal(0)
		setResponse(null)
		setDiagnostic(null)
		setError(null)
		setPending(false)
		setLoadingKeys(false)
	}
	const dispose = useCallback(() => {
		live.current = false
		generation.current++
		active.current?.abort()
		active.current = null
		keyRequest.current?.abort()
		keyRequest.current = null
	}, [])
	useLayoutEffect(() => {
		live.current = true
		return dispose
	}, [sessionKey, dispose])

	function invalidate(clearSecret = false): void {
		generation.current++
		active.current?.abort()
		setResponse(null)
		setDiagnostic(null)
		setError(null)
		if (clearSecret) setSecret('')
	}
	async function loadKeys(nextPage = 1): Promise<void> {
		if (!props.session.enabled) return
		keyRequest.current?.abort()
		const controller = new AbortController()
		keyRequest.current = controller
		invalidate(true)
		setKey(null)
		setLoadingKeys(true)
		setKeys([])
		try {
			await props.api.verifyMcpSubject({
				signal: controller.signal,
				expectedConsoleSubject: props.session.subject,
				expectedUserId: props.session.userId,
			})
			const result = await simulatorAdminApi.listKeys(
				{ page: nextPage, email },
				{ signal: controller.signal }
			)
			if (
				live.current &&
				!controller.signal.aborted &&
				keyRequest.current === controller
			) {
				setKeys(result.data)
				setTotal(result.total)
				setPage(nextPage)
			}
		} catch {
			if (live.current && !controller.signal.aborted) setError('accessDenied')
		} finally {
			if (keyRequest.current === controller) {
				keyRequest.current = null
				if (live.current) setLoadingKeys(false)
			}
		}
	}
	async function send(): Promise<void> {
		if (!key || active.current || loadingKeys || !props.session.enabled) return
		let original: string, request: ReturnType<typeof buildMcpClientRequest>
		try {
			original = normalizeMcpClientSecret(secret)
			request = buildMcpClientRequest({
				base: proxy,
				slug,
				method,
				version,
				id: ++rpcId.current,
			})
		} catch {
			setError('invalidInput')
			return
		}
		setPreviewId(rpcId.current + 1)
		const controller = new AbortController()
		active.current = controller
		const owner = ++generation.current
		setPending(true)
		setError(null)
		setResponse(null)
		setDiagnostic(null)
		let authorized = false
		const options = {
			signal: controller.signal,
			expectedConsoleSubject: props.session.subject,
			expectedUserId: props.session.userId,
		}
		try {
			await props.api.verifyMcpSubject(options)
			await simulatorAdminApi.verifySecret(
				key,
				original,
				props.session.subject,
				{ signal: controller.signal }
			)
			await props.api.verifyMcpSubject(options)
			if (
				!live.current ||
				owner !== generation.current ||
				controller.signal.aborted
			)
				return
			authorized = true
			const result = await executeMcpClient(request, original, {
				signal: controller.signal,
			})
			if (
				live.current &&
				owner === generation.current &&
				!controller.signal.aborted
			) {
				setResponse(result)
				setDiagnostic(result.diagnostic)
				setError(mcpClientResultMessage(result))
			}
		} catch (failure) {
			if (live.current && owner === generation.current) {
				setError(mcpClientFailureMessage(failure, controller.signal.aborted))
				if (authorized && failure instanceof McpClientError)
					setDiagnostic(failure.diagnostic ?? null)
				if (!authorized) setSecret('')
			}
		} finally {
			if (active.current === controller) {
				active.current = null
				if (live.current) setPending(false)
			}
		}
	}
	let request: ReturnType<typeof buildMcpClientRequest> | null = null
	try {
		request = buildMcpClientRequest({
			base: proxy,
			slug,
			method,
			version,
			id: previewId,
		})
	} catch {
		/* An incomplete draft has no executable preview. */
	}
	let validSecret = false
	try {
		normalizeMcpClientSecret(secret)
		validSecret = true
	} catch {
		/* Masked or incomplete secrets cannot be used. */
	}
	return {
		proxy,
		slug,
		method,
		version,
		secret,
		email,
		page,
		keys,
		total,
		key,
		loadingKeys,
		pending,
		error,
		response,
		diagnostic,
		request,
		canSend: Boolean(
			key &&
			validSecret &&
			mcpClientBase(proxy) &&
			request &&
			!pending &&
			!loadingKeys &&
			props.session.enabled
		),
		setProxy: (value: string) => {
			invalidate(true)
			setProxy(value)
		},
		setSlug: (value: string) => {
			invalidate()
			setSlug(value)
		},
		setMethod: (value: McpClientMethod) => {
			invalidate()
			setMethod(value)
		},
		setVersion: (value: string) => {
			invalidate()
			setVersion(value)
		},
		setSecret: (value: string) => {
			invalidate()
			setSecret(value)
		},
		setEmail,
		selectKey: (id: string) => {
			invalidate(true)
			setKey(keys.find((row) => row.id === id) ?? null)
		},
		loadKeys,
		send,
		stop: () => active.current?.abort('cancelled'),
	}
}
