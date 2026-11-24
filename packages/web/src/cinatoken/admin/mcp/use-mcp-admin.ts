/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import { CinaTokenApiError } from '../../api'
import type { AdminDomainRequestOptions } from '../domain-transport'
import { AdminDomainWriteError } from '../domain-write-recovery'
import { useDomainWriteRecovery } from '../use-domain-write-recovery'
import { markListDisplayUnauthorized } from '../users/list-display-recovery'
import type { UserDisplay } from '../users/users-display'
import type { AdminMcpApi } from './mcp-api'
import type {
	McpSecrets,
	McpServerDetail,
	McpServerSummary,
} from './mcp-contracts'
import type { McpSearch } from './mcp-domain'
import { McpReviewChangedError } from './mcp-review'

export type McpSession = {
	scopeKey: string
	reconciliationKey: string
	subject: string
	userId: string
	enabled: boolean
	revalidate: () => Promise<unknown>
}
export type McpAdminProps = {
	api: AdminMcpApi
	session: McpSession
	search: McpSearch
	onSearch: (search: McpSearch) => void
}
type ReadState<T> = { key: string; value: T } | { key: string; error: unknown }
export function useMcpAdmin(props: McpAdminProps) {
	const [version, setVersion] = useState(0)
	const [listState, setList] = useState<ReadState<McpServerSummary[]> | null>(
		null
	)
	const [detailState, setDetail] = useState<ReadState<McpServerDetail> | null>(
		null
	)
	const [displayState, setDisplay] = useState<ReadState<UserDisplay> | null>(
		null
	)
	const [message, setMessage] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [revealed, setRevealed] = useState<{
		key: string
		value: McpSecrets
	} | null>(null)
	const [revealing, setRevealing] = useState(false)
	const live = useRef(true)
	const writing = useRef<AbortController | null>(null)
	const revealingRef = useRef<AbortController | null>(null)
	const key = JSON.stringify([props.session.scopeKey, version])
	const detailKey = JSON.stringify([key, props.search.server])
	const readOptions = useCallback(
		(signal?: AbortSignal): AdminDomainRequestOptions => ({
			signal,
			expectedConsoleSubject: props.session.subject,
			expectedUserId: props.session.userId,
		}),
		[props.session.subject, props.session.userId]
	)
	const refresh = useCallback(() => {
		setRevealed(null)
		revealingRef.current?.abort()
		setVersion((value) => value + 1)
	}, [])
	useLayoutEffect(() => {
		live.current = true
		return () => {
			live.current = false
			writing.current?.abort()
			revealingRef.current?.abort()
		}
	}, [])
	useEffect(() => {
		if (!props.session.enabled) return
		const controller = new AbortController()
		let current = true
		void props.api.listMcpServers(readOptions(controller.signal)).then(
			(value) => {
				if (current) setList({ key, value })
			},
			(error) => {
				if (current) setList({ key, error })
			}
		)
		void props.api.mcpDisplay(readOptions(controller.signal)).then(
			(value) => {
				if (current) setDisplay({ key, value })
			},
			(error) => {
				if (current) setDisplay({ key, error })
			}
		)
		return () => {
			current = false
			controller.abort()
		}
	}, [props.api, props.session.enabled, key, readOptions])
	const display =
		props.session.enabled &&
		displayState?.key === key &&
		'value' in displayState
			? displayState.value
			: null
	const displayError =
		displayState?.key === key && 'error' in displayState
			? displayState.error
			: null
	useEffect(() => {
		if (
			props.session.enabled &&
			displayError instanceof CinaTokenApiError &&
			displayError.status === 401 &&
			markListDisplayUnauthorized(props.api, props.session.reconciliationKey)
		)
			void props.session.revalidate().catch(() => undefined)
	}, [
		props.api,
		props.session.enabled,
		props.session.reconciliationKey,
		props.session.revalidate,
		displayError,
	])
	useEffect(() => {
		if (
			!props.session.enabled ||
			!props.search.server ||
			props.search.invalidTarget
		)
			return
		const id = props.search.server,
			controller = new AbortController()
		let current = true
		void props.api.getMcpServer(id, readOptions(controller.signal)).then(
			(value) => {
				if (current) setDetail({ key: detailKey, value })
			},
			(error) => {
				if (current) setDetail({ key: detailKey, error })
			}
		)
		return () => {
			current = false
			controller.abort()
			revealingRef.current?.abort()
		}
	}, [
		props.api,
		props.session.enabled,
		props.search.server,
		props.search.invalidTarget,
		detailKey,
		readOptions,
	])
	useEffect(() => {
		if (!revealed) return
		const timer = setTimeout(() => setRevealed(null), 60_000)
		return () => clearTimeout(timer)
	}, [revealed])
	const recovery = useDomainWriteRecovery({
		domain: 'mcp',
		enabled: props.session.enabled,
		reconciliationKey: props.session.reconciliationKey,
		subject: props.session.subject,
		userId: props.session.userId,
		verify: props.api.verifyMcpSubject,
		observe: async (options) => {
			const list = await props.api.listMcpServers(options)
			if (
				props.search.server &&
				list.some((server) => server.id === props.search.server)
			)
				await props.api.getMcpServer(props.search.server, options)
			return list
		},
		onRecovered: refresh,
		onFailure: () => setMessage('accessDenied'),
		isWriting: () => writing.current !== null,
	})
	async function write<T>(
		perform: (options: AdminDomainRequestOptions) => Promise<T>,
		settings?: { refresh?: boolean; refreshOnFailure?: boolean }
	): Promise<{ ok: true; value: T } | { ok: false }> {
		if (
			!props.session.enabled ||
			writing.current ||
			recovery.status !== 'ready'
		)
			return { ok: false }
		const controller = new AbortController()
		writing.current = controller
		setBusy(true)
		setMessage(null)
		setRevealed(null)
		revealingRef.current?.abort()
		recovery.resetDispatch()
		try {
			const value = await perform(recovery.writeOptions(controller.signal))
			if (
				!live.current ||
				controller.signal.aborted ||
				writing.current !== controller
			)
				return { ok: false }
			recovery.settleKnown('confirmed-2xx')
			setMessage('saved')
			if (settings?.refresh !== false) refresh()
			return { ok: true, value }
		} catch (error) {
			if (!live.current || writing.current !== controller) return { ok: false }
			if (error instanceof AdminDomainWriteError && error.code === 'rejected')
				recovery.settleKnown('definitive-rejection')
			const pending =
				recovery.recovery.status(props.session.reconciliationKey, 'mcp') !==
				'ready'
			if (error instanceof McpReviewChangedError) {
				refresh()
				setMessage('refreshRequired')
			} else {
				if (settings?.refreshOnFailure) refresh()
				setMessage(pending ? 'unknown' : 'writeFailed')
			}
			if (error instanceof AdminDomainWriteError && error.code === 'subject')
				void props.session.revalidate().catch(() => undefined)
			return { ok: false }
		} finally {
			if (writing.current === controller) {
				writing.current = null
				recovery.resetDispatch()
				if (live.current) setBusy(false)
			}
		}
	}
	async function reveal(): Promise<void> {
		if (revealed?.key === detailKey) {
			setRevealed(null)
			return
		}
		if (!props.search.server || writing.current || revealingRef.current) return
		const controller = new AbortController()
		revealingRef.current = controller
		setRevealing(true)
		setMessage(null)
		try {
			const value = await props.api.revealMcpServer(
				props.search.server,
				readOptions(controller.signal)
			)
			if (
				live.current &&
				revealingRef.current === controller &&
				!controller.signal.aborted
			)
				setRevealed({ key: detailKey, value })
		} catch {
			if (live.current && !controller.signal.aborted) setMessage('accessDenied')
		} finally {
			if (revealingRef.current === controller) {
				revealingRef.current = null
				if (live.current) setRevealing(false)
			}
		}
	}
	const list =
		listState?.key === key && 'value' in listState ? listState.value : null
	const detail =
		detailState?.key === detailKey && 'value' in detailState
			? detailState.value
			: null
	const listError =
		listState?.key === key && 'error' in listState ? listState.error : null
	const detailError =
		detailState?.key === detailKey && 'error' in detailState
			? detailState.error
			: null
	const error = detailError || listError
	const denied =
		error instanceof CinaTokenApiError &&
		(error.status === 401 || error.status === 403)
	return {
		list,
		detail,
		display,
		currency: display?.currency ?? null,
		error: error ? (denied ? 'accessDenied' : 'readFailed') : null,
		message,
		setMessage,
		refresh,
		busy: busy || revealing,
		writeAllowed:
			recovery.status === 'ready' &&
			!busy &&
			!revealing &&
			props.session.enabled,
		secrets: revealed?.key === detailKey ? revealed.value : null,
		reveal,
		write,
		recovery: recovery.manualRecovery,
	}
}
