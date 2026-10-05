/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CinaTokenApiError } from '../../api'
import type { GatewayKeyRow } from '../gateway-keys/gateway-key-contracts'
import { validateAudioTranscriptionFile } from '../playground/browser-domain/audio-transcriptions'
import { isDashScopeRealtimeOperation } from '../playground/browser-domain/dashscope-realtime-client'
import { validateEditImageFiles } from '../playground/browser-domain/image-generations'
import { RunOwner } from '../playground/browser-domain/run-owner'
import {
	buildSimulatorRequest,
	buildSimulatorDashScopeRealtimeUrl,
	type BuildSimulatorRequestInput,
} from './endpoint'
import {
	isOriginalGatewaySecret,
	type SimulatorAdminApi,
} from './simulator-api'
import {
	initialSelection,
	isRealtimeSelection,
	parseSimulatorBody,
	readPreference,
	reconcileSelection,
	requestOperation,
	routingString,
	simulatorModelKind,
	savePreferences,
	selectionTemplate,
	selectionNeedsNewTemplate,
	type SimulatorSearch,
	type SimulatorSelection,
} from './simulator-selection'
import {
	executeSimulatorHttp,
	executeSimulatorRealtime,
	type SimulatorTransportResult,
} from './simulator-transport'
import {
	bodyTemplateForSelection,
	filterMatchingActiveRoutes,
	normalizeBodyWhitespace,
	redactHeaders,
	tryParseProxyBaseUrl,
	LS_PROXY,
	LS_KEY_ID,
} from './simulator-utils'
import type { SimulatorSession, WirePreview } from './types'

type SecretBinding = {
	secret: string
	id: string
	userId: string
	workspaceId: string
	proxy: string
	scope: string
}
export type SimulatorSnapshot = {
	keyId: string
	ownerId: string
	workspaceId: string
	proxy: string
	selection: SimulatorSelection
	wire: WirePreview
	requestBody: Record<string, unknown>
}
export type SimulatorResponse = SimulatorTransportResult & {
	snapshot: SimulatorSnapshot
}
export function useSimulator(props: {
	api: SimulatorAdminApi
	session: SimulatorSession
	search?: SimulatorSearch
}) {
	const { t } = useTranslation()
	const [selection, setSelection] = useState(() =>
		initialSelection(props.search)
	)
	const [proxyBaseUrl, setProxy] = useState(() => readPreference(LS_PROXY))
	const [page, setPage] = useState(1)
	const [email, setEmail] = useState('')
	const [modelSearch, setModelSearch] = useState('')
	const [selectedKey, setSelectedKey] = useState<GatewayKeyRow | null>(null)
	const [initialKeyId] = useState(
		() => props.search?.key_id ?? readPreference(LS_KEY_ID)
	)
	const [secretDraft, setSecretDraftState] = useState('')
	const [verified, setVerified] = useState(false)
	const [verifying, setVerifying] = useState(false)
	const [secretError, setSecretError] = useState(false)
	const [template, setTemplate] = useState(() =>
		bodyTemplateForSelection(
			selection.protocol,
			false,
			'generations',
			null,
			selection.kind === 'tool' ? selection.toolId : undefined,
			undefined,
			undefined,
			selection.llmOperation
		)
	)
	const [bodyText, setBodyText] = useState(template)
	const [editFiles, setEditFiles] = useState<File[]>([])
	const [audioFile, setAudioFile] = useState<File | null>(null)
	const [audioInput, setAudioInput] = useState<'file' | 'microphone'>('file')
	const [sending, setSending] = useState(false)
	const [response, setResponse] = useState<SimulatorResponse | null>(null)
	const [bodyError, setBodyError] = useState(false)
	const [owner] = useState(() => new RunOwner())
	const binding = useRef<SecretBinding | null>(null)
	const verification = useRef<{
		controller: AbortController
		scope: string
	} | null>(null)
	const liveScope =
		props.session.reconciliationKey +
		'\n' +
		props.session.scopeKey +
		'\n' +
		props.session.subject
	const scope = useRef(liveScope)
	const permission = useRef(props.session.enabled)
	useLayoutEffect(() => {
		scope.current = liveScope
		permission.current = props.session.enabled
	}, [liveScope, props.session.enabled])
	const enabled = props.session.enabled && !!props.session.scopeKey
	const contextQuery = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.session.scopeKey,
			'simulator',
			'context',
			props.session.reconciliationKey,
		],
		queryFn: ({ signal }) => props.api.context({ signal }),
		enabled,
		retry: false,
		gcTime: 0,
		refetchOnWindowFocus: false,
	})
	const context = contextQuery.data
	const keyEnabled =
		enabled &&
		!!context?.capabilities.can_read_keys &&
		props.session.canReadKeys !== false
	const keysQuery = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.session.scopeKey,
			'simulator',
			'keys',
			props.session.reconciliationKey,
			page,
			email,
		],
		queryFn: ({ signal }) => props.api.listKeys({ page, email }, { signal }),
		enabled: keyEnabled,
		retry: false,
		gcTime: 0,
		refetchOnWindowFocus: false,
	})
	function clearSecret(): void {
		verification.current?.controller.abort()
		verification.current = null
		binding.current = null
		setSecretDraftState('')
		setVerified(false)
		setVerifying(false)
		setSecretError(false)
	}
	useEffect(() => {
		return () => {
			owner.cancel()
			verification.current?.controller.abort()
			verification.current = null
			binding.current = null
		}
	}, [owner])
	useEffect(() => {
		owner.cancel()
		verification.current?.controller.abort()
		verification.current = null
		binding.current = null
		// eslint-disable-next-line react-hooks/set-state-in-effect -- A committed identity/access change must synchronously erase credential and result UI.
		setSecretDraftState('')
		setVerified(false)
		setVerifying(false)
		setSecretError(false)
		setSelectedKey(null)
		setSending(false)
		setResponse(null)
		setEditFiles([])
		setAudioFile(null)
	}, [liveScope, enabled, owner])
	const contextInitialized = useRef(false)
	useEffect(() => {
		if (!context) return
		let requested = selection
		if (
			!contextInitialized.current &&
			props.search?.model_id &&
			!props.search.kind
		) {
			const targetModel = context.models.find(
				(model) => model.id === props.search?.model_id
			)
			if (targetModel)
				requested = { ...requested, kind: simulatorModelKind(targetModel) }
		}
		const next = reconcileSelection(requested, context)
		if (
			!contextInitialized.current ||
			JSON.stringify(next) !== JSON.stringify(selection)
		) {
			contextInitialized.current = true
			setSelection(next)
			const nextTemplate = selectionTemplate(next, context)
			setTemplate(nextTemplate)
			setBodyText(nextTemplate)
			setBodyError(false)
		}
	}, [context, selection, props.search?.model_id, props.search?.kind])
	useEffect(() => {
		savePreferences(selection, proxyBaseUrl, selectedKey?.id ?? '')
	}, [selection, proxyBaseUrl, selectedKey?.id])
	const restoredKey = useRef(false)
	useEffect(() => {
		const rows = keysQuery.data?.data
		if (!rows) return
		const selected = selectedKey
		const desiredId = initialKeyId
		if (!selected && !restoredKey.current) {
			restoredKey.current = true
			const restored = rows.find((row) => row.id === desiredId)
			// eslint-disable-next-line react-hooks/set-state-in-effect -- Restore a nonsecret selection only after the independently fetched safe directory confirms its immutable ID.
			if (restored) setSelectedKey(restored)
		}
		const fresh = selected && rows.find((row) => row.id === selected.id)
		if (
			fresh &&
			(fresh.user_id !== selected.user_id ||
				fresh.workspace_id !== selected.workspace_id ||
				fresh.status !== 'active')
		) {
			verification.current?.controller.abort()
			binding.current = null
			setSecretDraftState('')
			setVerified(false)
			setVerifying(false)
			setSelectedKey(fresh)
		}
	}, [keysQuery.data, selectedKey, initialKeyId])
	useEffect(() => {
		if (!keyEnabled && context) {
			owner.cancel()
			verification.current?.controller.abort()
			verification.current = null
			binding.current = null
			// eslint-disable-next-line react-hooks/set-state-in-effect -- External context permission loss must immediately erase the in-memory credential UI.
			setSecretDraftState('')
			setVerified(false)
			setVerifying(false)
			setSending(false)
			setResponse(null)
		}
	}, [keyEnabled, context, owner])
	function selectKey(id: string): void {
		clearSecret()
		setSelectedKey(keysQuery.data?.data.find((row) => row.id === id) ?? null)
	}
	function changeProxy(value: string): void {
		clearSecret()
		owner.cancel()
		setSending(false)
		setResponse(null)
		setProxy(value)
	}
	function setSecretDraft(value: string): void {
		clearSecret()
		setSecretDraftState(value)
	}
	async function verifySecret(): Promise<void> {
		const parsed = tryParseProxyBaseUrl(proxyBaseUrl)
		const key = selectedKey
		const secret = secretDraft
		if (
			!keyEnabled ||
			!key ||
			!parsed.ok ||
			!isOriginalGatewaySecret(secret) ||
			verifying
		) {
			setSecretError(true)
			return
		}
		const check = { controller: new AbortController(), scope: liveScope }
		verification.current?.controller.abort()
		verification.current = check
		setVerifying(true)
		setSecretError(false)
		try {
			await props.api.verifySecret(key, secret, props.session.subject, {
				signal: check.controller.signal,
			})
			if (
				verification.current !== check ||
				check.controller.signal.aborted ||
				scope.current !== check.scope ||
				!permission.current
			)
				return
			binding.current = {
				secret,
				id: key.id,
				userId: key.user_id,
				workspaceId: key.workspace_id,
				proxy: parsed.base,
				scope: check.scope,
			}
			setVerified(true)
			setSecretDraftState('')
		} catch (error) {
			if (verification.current === check && !check.controller.signal.aborted) {
				binding.current = null
				setVerified(false)
				setSecretDraftState('')
				setSecretError(true)
				if (
					error instanceof CinaTokenApiError &&
					(error.status === 401 || error.status === 403)
				)
					void props.session.revalidate?.()
			}
		} finally {
			if (verification.current === check) {
				verification.current = null
				setVerifying(false)
			}
		}
	}
	const dirty =
		normalizeBodyWhitespace(bodyText) !== normalizeBodyWhitespace(template)
	function changeSelection(patch: Partial<SimulatorSelection>): void {
		if (sending) return
		let next = { ...selection, ...patch }
		if (patch.kind && patch.kind !== selection.kind) {
			next = { ...next, modelId: '', routeGroup: '' }
			setModelSearch('')
		}
		if (patch.modelId && patch.modelId !== selection.modelId)
			next.routeGroup = ''
		next = reconcileSelection(next, context)
		if (JSON.stringify(next) === JSON.stringify(selection)) return
		if (
			dirty &&
			((patch.protocol && next.protocol !== selection.protocol) ||
				(patch.llmOperation && next.llmOperation !== selection.llmOperation))
		) {
			const messageKey = patch.llmOperation
				? 'openaiOperationSwitchConfirm'
				: 'protocolSwitchConfirm'
			if (!window.confirm(t('cinatoken.adminSimulator.' + messageKey))) return
		}
		setSelection(next)
		if (selectionNeedsNewTemplate(selection, next)) {
			const nextTemplate = selectionTemplate(next, context)
			setTemplate(nextTemplate)
			setBodyText(nextTemplate)
			setBodyError(false)
			setEditFiles([])
			setAudioFile(null)
			setAudioInput('file')
		}
	}
	function resetTemplate(): void {
		setBodyText(template)
		setBodyError(false)
	}
	const parsedBody = useMemo(() => parseSimulatorBody(bodyText), [bodyText])
	const routes = filterMatchingActiveRoutes(
		context?.routes ?? [],
		selection.modelId,
		selection.routeGroup,
		selection.protocol,
		requestOperation(selection) ?? undefined
	)
	const realtime = isRealtimeSelection(selection)
	const usesMicrophone =
		realtime &&
		selection.audioOperation === 'transcriptions' &&
		audioInput === 'microphone'
	let imageValidation = validateEditImageFiles(editFiles)
	let audioValidation = validateAudioTranscriptionFile(audioFile)
	if (
		context &&
		(editFiles.length > context.limits.image_count ||
			editFiles.some((file) => file.size > context.limits.image_file_bytes))
	)
		imageValidation = { ok: false, error: 'runtime-limit' }
	if (context && audioFile && audioFile.size > context.limits.audio_file_bytes)
		audioValidation = { ok: false, error: 'runtime-limit' }
	let blockReason: string | null = null
	const parsedProxy = tryParseProxyBaseUrl(proxyBaseUrl)
	if (!enabled) blockReason = 'accessDenied'
	else if (contextQuery.isPending) blockReason = 'loading'
	else if (contextQuery.isError) blockReason = 'contextError'
	else if (!keyEnabled) blockReason = 'keysForbidden'
	else if (!parsedProxy.ok) blockReason = 'readyNeedProxyUrl'
	else if (!selectedKey || !verified) blockReason = 'secretRequired'
	else if (selection.kind !== 'tool' && !selection.modelId)
		blockReason = 'readyNeedModel'
	else if (selection.kind !== 'tool' && routes.length === 0)
		blockReason = 'supportedSurfacesEmpty'
	else if (selection.kind === 'image' && selection.protocol !== 'openai')
		blockReason = 'readyNeedOpenaiForImage'
	else if (
		selection.kind === 'image' &&
		selection.imageOperation === 'edits' &&
		!imageValidation.ok
	)
		blockReason = 'referenceImagesRequired'
	else if (
		realtime &&
		(!context?.realtime_supported ||
			!isDashScopeRealtimeOperation(selection.dashscopeOperation))
	)
		blockReason = 'realtimeUnavailable'
	else if (
		selection.kind === 'audio' &&
		selection.protocol !== 'openai' &&
		selection.protocol !== 'dashscope'
	)
		blockReason = 'protocolLockedAudio'
	else if (
		selection.kind === 'audio' &&
		selection.audioOperation === 'transcriptions' &&
		!usesMicrophone &&
		!(
			selection.protocol === 'dashscope' &&
			selection.dashscopeOperation === 'audio.transcriptions.multimodal'
		) &&
		!(
			selection.protocol === 'openai' &&
			typeof parsedBody?.file_url === 'string' &&
			parsedBody.file_url.trim()
		) &&
		!audioValidation.ok
	)
		blockReason = 'audioFileRequired'
	else if (!parsedBody) blockReason = 'errBodyMustBeObject'
	function requestInput(
		secret: string,
		body: Record<string, unknown>
	): BuildSimulatorRequestInput | null {
		if (!parsedProxy.ok) return null
		return {
			baseUrl: parsedProxy.base,
			kind: selection.kind,
			toolId: selection.toolId,
			protocol: selection.protocol,
			modelForRouting: routingString(selection),
			geminiAction: selection.geminiAction,
			body,
			apiKey: secret,
			imageOperation: selection.imageOperation,
			editImages: editFiles,
			llmOperation: selection.llmOperation,
			audioOperation:
				selection.kind === 'audio' ? selection.audioOperation : undefined,
			audioFile,
			dashscopeRequestOperation: selection.dashscopeOperation,
		}
	}
	const wirePreview: WirePreview | null = (() => {
		if (!parsedBody) return null
		const input = requestInput('***', parsedBody)
		if (!input) return null
		try {
			if (realtime)
				return {
					method: 'WebSocket',
					url: buildSimulatorDashScopeRealtimeUrl({
						baseUrl: input.baseUrl,
						modelForRouting: input.modelForRouting,
						operation: selection.dashscopeOperation,
					}),
					headers: { 'Sec-WebSocket-Protocol': '[redacted]' },
					bodyText: bodyText,
				}
			const built = buildSimulatorRequest(input)
			return {
				method: 'POST',
				url: built.url,
				headers: redactHeaders(built.headers),
				bodyText:
					built.multipartSummary ??
					JSON.stringify(JSON.parse(built.bodyText), null, 2),
				isMultipart: !!built.formData,
			}
		} catch {
			return null
		}
	})()
	function stop(): void {
		owner.cancel()
		setSending(false)
		setResponse((current) =>
			current
				? { ...current, meta: { ...current.meta, outcome: 'cancelled' } }
				: null
		)
	}
	async function send(): Promise<void> {
		if (
			sending ||
			blockReason ||
			!parsedBody ||
			!selectedKey ||
			!wirePreview ||
			!parsedProxy.ok
		) {
			setBodyError(!parsedBody)
			return
		}
		const verifiedBinding = binding.current
		if (
			!verifiedBinding ||
			verifiedBinding.id !== selectedKey.id ||
			verifiedBinding.userId !== selectedKey.user_id ||
			verifiedBinding.workspaceId !== selectedKey.workspace_id ||
			verifiedBinding.proxy !== parsedProxy.base ||
			verifiedBinding.scope !== scope.current ||
			!permission.current
		) {
			clearSecret()
			return
		}
		const input = requestInput(verifiedBinding.secret, parsedBody)
		if (!input) return
		const run = owner.start()
		const snapshot: SimulatorSnapshot = {
			keyId: selectedKey.id,
			ownerId: selectedKey.user_id,
			workspaceId: selectedKey.workspace_id,
			proxy: parsedProxy.base,
			selection: { ...selection },
			wire: { ...wirePreview },
			requestBody: structuredClone(parsedBody),
		}
		const currentScope = liveScope
		const update = (result: SimulatorTransportResult) => {
			if (
				owner.owns(run) &&
				scope.current === currentScope &&
				permission.current
			)
				setResponse({ ...result, snapshot })
		}
		setSending(true)
		setBodyError(false)
		setResponse({
			raw: '',
			audio: null,
			snapshot,
			meta: {
				status: null,
				latencyMs: null,
				requestUrl: wirePreview.url,
				contentType: null,
				generationId: null,
				outcome: 'running',
			},
		})
		try {
			// Recheck the mounted Console and current Key binding before disclosing
			// its in-memory secret to the independent Proxy transport.
			try {
				await props.api.verifySecret(
					selectedKey,
					verifiedBinding.secret,
					props.session.subject,
					{ signal: run.controller.signal }
				)
			} catch {
				if (owner.owns(run)) {
					clearSecret()
					setSending(false)
					setResponse(null)
					setSecretError(true)
					if (!run.controller.signal.aborted)
						void props.session.revalidate?.().catch(() => undefined)
					owner.finish(run)
				}
				return
			}
			if (
				!owner.owns(run) ||
				scope.current !== currentScope ||
				!permission.current ||
				binding.current !== verifiedBinding
			)
				return
			let result: SimulatorTransportResult
			if (
				realtime &&
				isDashScopeRealtimeOperation(selection.dashscopeOperation)
			) {
				result = await executeSimulatorRealtime({
					url: wirePreview.url,
					operation: selection.dashscopeOperation,
					secret: verifiedBinding.secret,
					initialMessage: bodyText,
					audioFile,
					audioInput,
					signal: run.controller.signal,
					onProgress: update,
				})
			} else {
				result = await executeSimulatorHttp({
					request: buildSimulatorRequest(input),
					secret: verifiedBinding.secret,
					signal: run.controller.signal,
					onProgress: update,
				})
			}
			if (
				owner.owns(run) &&
				scope.current === currentScope &&
				permission.current
			) {
				setResponse({ ...result, snapshot })
				setSending(false)
				owner.finish(run)
			}
		} catch {
			if (owner.owns(run)) {
				setResponse((current) =>
					current
						? { ...current, meta: { ...current.meta, outcome: 'failed' } }
						: null
				)
				setSending(false)
				owner.finish(run)
			}
		}
	}
	return {
		selection,
		changeSelection,
		proxyBaseUrl,
		changeProxy,
		page,
		setPage,
		email,
		setEmail: (value: string) => {
			setPage(1)
			setEmail(value)
		},
		modelSearch,
		setModelSearch,
		contextQuery,
		context,
		keysQuery,
		selectedKey,
		selectKey,
		secretDraft,
		setSecretDraft,
		verified,
		verifying,
		secretError,
		verifySecret,
		refreshKeys: () => {
			clearSecret()
			void keysQuery.refetch()
		},
		refreshContext: () => {
			stop()
			clearSecret()
			void contextQuery.refetch()
		},
		keyEnabled,
		bodyText,
		setBodyText,
		dirty,
		resetTemplate,
		bodyError,
		editFiles,
		setEditFiles,
		imageValidation,
		audioFile,
		setAudioFile,
		audioValidation,
		audioInput,
		setAudioInput,
		sending,
		response,
		send,
		stop,
		blockReason,
		wirePreview,
		routes,
		realtime,
		usesMicrophone,
		routingString: routingString(selection),
	}
}
export type SimulatorState = ReturnType<typeof useSimulator>
