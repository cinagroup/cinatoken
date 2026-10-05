/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	dashScopeRealtimeAudioContentType,
	disposeDashScopeRealtimeClient,
	isDashScopeRealtimeOperation,
	openDashScopeRealtimeClient,
} from './browser-domain/dashscope-realtime-client'
import { buildPlaygroundSubjectProtocols } from './browser-domain/playground-subject'
import { RunOwner, type OwnedRun } from './browser-domain/run-owner'
import { PlaygroundError, type PlaygroundApi } from './playground-api'
import type {
	PlaygroundEnvelope,
	PlaygroundPreview,
	PlaygroundResponseMeta,
	PlaygroundRoute,
	PlaygroundUploads,
} from './playground-contracts'
import { PlaygroundInputFailure } from './playground-domain'

export type PlaygroundSession = {
	scopeKey: string
	reconciliationKey: string
	subject: string
	enabled: boolean
	revalidate: () => Promise<void>
}
export type PlaygroundResult = {
	runId: number
	raw: string
	meta: PlaygroundResponseMeta | null
	audio: Blob | null
	requestBody: string
	protocol: 'openai' | 'anthropic' | 'gemini' | 'dashscope'
	kind: 'llm' | 'image' | 'audio' | 'rerank' | 'tool'
}
export function playgroundErrorKey(error: unknown): string {
	if (error instanceof PlaygroundInputFailure) return error.key
	if (error instanceof PlaygroundError) {
		if (error.code === 'access') return 'accessDenied'
		if (error.code === 'cancelled') return 'cancelled'
		if (error.code === 'timeout') return 'errorTimeout'
		if (error.code === 'invalid-response') return 'errorResponse'
		if (error.code === 'http') return 'errorHttp'
	}
	return 'errorNetwork'
}
export function usePlaygroundRun(
	api: PlaygroundApi,
	session: PlaygroundSession,
	selectionKey: string
) {
	const [owner] = useState(() => new RunOwner()),
		[busy, setBusy] = useState(false),
		[preview, setPreview] = useState<PlaygroundPreview | null>(null),
		[result, setResult] = useState<PlaygroundResult | null>(null),
		[error, setError] = useState<string | null>(null),
		[denied, setDenied] = useState(false)
	const mounted = useRef(false),
		partialAudio = useRef<{
			run: OwnedRun
			chunks: ArrayBuffer[]
			type: string
		} | null>(null),
		[runKey, setRunKey] = useState(selectionKey)
	useEffect(() => () => owner.cancel(), [owner, selectionKey])
	useEffect(() => {
		mounted.current = true
		const hide = () => {
				owner.cancel()
				setBusy(false)
				setResult(null)
				setPreview(null)
				setError('cancelled')
			},
			hidden = () => {
				if (document.visibilityState === 'hidden') hide()
			}
		window.addEventListener('pagehide', hide)
		document.addEventListener('visibilitychange', hidden)
		return () => {
			mounted.current = false
			owner.cancel()
			window.removeEventListener('pagehide', hide)
			document.removeEventListener('visibilitychange', hidden)
		}
	}, [owner])
	const clear = useCallback(() => {
		owner.cancel()
		partialAudio.current = null
		setBusy(false)
		setPreview(null)
		setResult(null)
		setError(null)
	}, [owner])
	const stop = useCallback(() => {
		const partial = partialAudio.current
		if (partial && owner.owns(partial.run) && partial.chunks.length) {
			const audio = new Blob(partial.chunks, { type: partial.type })
			setResult((previous) => (previous ? { ...previous, audio } : null))
		}
		owner.cancel()
		partialAudio.current = null
		setBusy(false)
		setError('cancelled')
	}, [owner])
	const fail = useCallback(
		(run: OwnedRun, cause: unknown) => {
			if (!mounted.current || !owner.owns(run)) return
			if (cause instanceof PlaygroundError && cause.code === 'access') {
				setDenied(true)
				setResult(null)
				setPreview(null)
				void session.revalidate().catch(() => undefined)
			} else if (
				partialAudio.current?.run === run &&
				partialAudio.current.chunks.length
			) {
				const audio = new Blob(partialAudio.current.chunks, {
					type: partialAudio.current.type,
				})
				setResult((previous) => (previous ? { ...previous, audio } : null))
			}
			setError(playgroundErrorKey(cause))
			setBusy(false)
			owner.finish(run)
			partialAudio.current = null
		},
		[owner, session]
	)
	async function runPreview(
		envelope: PlaygroundEnvelope,
		uploads: PlaygroundUploads
	) {
		const run = owner.start()
		setRunKey(selectionKey)
		setError(null)
		setPreview(null)
		setResult(null)
		setBusy(true)
		try {
			const value = await api.preview(envelope, uploads, run.controller.signal)
			if (owner.owns(run) && mounted.current) {
				setPreview(value)
				setBusy(false)
				owner.finish(run)
			}
		} catch (cause) {
			fail(run, cause)
		}
	}
	async function send(
		envelope: PlaygroundEnvelope,
		uploads: PlaygroundUploads,
		input: {
			route: PlaygroundRoute | null
			kind: PlaygroundResult['kind']
			audioInput: 'file' | 'microphone'
			body: string
		}
	) {
		if (!session.enabled || denied) return
		const run = owner.start()
		setRunKey(selectionKey)
		setBusy(true)
		setError(null)
		setResult(null)
		partialAudio.current = { run, chunks: [], type: 'application/octet-stream' }
		const deadline = setTimeout(
			() => fail(run, new PlaygroundError('timeout')),
			300_000
		)
		run.cleanups.add(() => clearTimeout(deadline))
		run.cleanups.add(() => {
			if (partialAudio.current?.run === run) partialAudio.current = null
		})
		const initial: PlaygroundResult = {
			runId: run.generation,
			raw: '',
			meta: null,
			audio: null,
			requestBody: input.body,
			protocol: input.route?.upstream_protocol ?? 'openai',
			kind: input.kind,
		}
		try {
			// Fresh permission/context read is abortable; the execute endpoint also checks the expected Console subject.
			const fresh = await api.context(run.controller.signal)
			if (!owner.owns(run) || !mounted.current) return
			if (
				'routeId' in envelope &&
				!fresh.routes.some((route) => route.id === envelope.routeId)
			)
				throw new PlaygroundError('access')
			setResult(initial)
			const operation = input.route?.upstream_operation ?? ''
			if (
				input.route?.upstream_protocol === 'dashscope' &&
				isDashScopeRealtimeOperation(operation)
			) {
				if (!fresh.realtime_supported)
					throw new PlaygroundInputFailure('realtimeUnavailable')
				const url = new URL(
					'/api/admin/playground/realtime',
					window.location.origin
				)
				url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
				url.searchParams.set('routeId', input.route.id)
				url.searchParams.set('operation', operation)
				let raw = '',
					audioBytes = 0
				const audioChunks: ArrayBuffer[] = []
				partialAudio.current = {
					run,
					chunks: audioChunks,
					type: dashScopeRealtimeAudioContentType(input.body),
				}
				const socket = openDashScopeRealtimeClient({
					url: url.toString(),
					protocols: buildPlaygroundSubjectProtocols(session.subject),
					operation,
					initialMessage: JSON.stringify(envelope.body),
					audioFile: uploads.audio,
					audioInput: input.audioInput,
					onOpen: () => {
						if (owner.owns(run))
							setResult({
								...initial,
								meta: {
									status: 101,
									latencyMs: null,
									upstreamUrl: null,
									contentType: 'application/x-ndjson',
									wireBody: null,
									truncated: false,
								},
							})
					},
					onMessage: (message) => {
						if (
							!owner.owns(run) ||
							!mounted.current ||
							typeof message !== 'string'
						)
							return
						raw += message + '\n'
						if (raw.length > 16 * 1024 * 1024) {
							fail(run, new PlaygroundError('invalid-response'))
							return
						}
						setResult((previous) => (previous ? { ...previous, raw } : null))
					},
					onAudioChunk: (chunk) => {
						if (!owner.owns(run)) return
						audioBytes += chunk.byteLength
						if (audioBytes > 64 * 1024 * 1024) {
							fail(run, new PlaygroundError('invalid-response'))
							return
						}
						audioChunks.push(chunk)
					},
					onError: () => fail(run, new PlaygroundError('network')),
					onClose: (event) => {
						if (!owner.owns(run) || !mounted.current) return
						if (event.code !== 1000) {
							fail(run, new PlaygroundError('network'))
							return
						}
						const audio = audioChunks.length
							? new Blob(audioChunks, {
									type: dashScopeRealtimeAudioContentType(input.body),
								})
							: null
						setResult((previous) => (previous ? { ...previous, audio } : null))
						setBusy(false)
						owner.finish(run)
					},
				})
				run.cleanups.add(() => disposeDashScopeRealtimeClient(socket))
				return
			}
			const value = await api.execute(envelope, uploads, {
				signal: run.controller.signal,
				onAudioChunk: (chunk, type) => {
					if (owner.owns(run) && partialAudio.current?.run === run) {
						partialAudio.current.type = type
						partialAudio.current.chunks.push(chunk)
					}
				},
				onMeta: (meta) => {
					if (owner.owns(run) && mounted.current)
						setResult((previous) => (previous ? { ...previous, meta } : null))
				},
				onRaw: (raw) => {
					if (owner.owns(run) && mounted.current)
						setResult((previous) => (previous ? { ...previous, raw } : null))
				},
			})
			if (owner.owns(run) && mounted.current) {
				setResult({ ...initial, ...value })
				setBusy(false)
				owner.finish(run)
			}
		} catch (cause) {
			fail(run, cause)
		}
	}
	const current = runKey === selectionKey
	return {
		busy: current && busy,
		preview: current ? preview : null,
		result: current ? result : null,
		error: current ? error : null,
		denied,
		clear,
		stop,
		runPreview,
		send,
		setError: (value: string) => {
			setRunKey(selectionKey)
			setError(value)
		},
	}
}
