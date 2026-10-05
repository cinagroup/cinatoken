/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { PlaygroundRequest } from './PlaygroundRequest'
import { PlaygroundResponse } from './PlaygroundResponse'
import { PlaygroundSetup } from './PlaygroundSetup'
import type { ImageOperation } from './browser-domain/image-generations'
import type { PlaygroundLlmSampleId } from './browser-domain/samples'
import {
	createPlaygroundApi,
	PlaygroundError,
	type PlaygroundApi,
} from './playground-api'
import type {
	PlaygroundContext,
	PlaygroundKind,
	PlaygroundSearch,
} from './playground-contracts'
import {
	bodyIsDirty,
	buildPlaygroundInput,
	llmSample,
	playgroundPrefix as prefix,
	routeKind,
	selectionTemplate,
} from './playground-domain'
import {
	playgroundErrorKey,
	usePlaygroundRun,
	type PlaygroundSession,
} from './use-playground-run'

export type PlaygroundScreenProps = {
	session: PlaygroundSession
	search: PlaygroundSearch
	onSearchChange: (search: PlaygroundSearch) => void
	api?: PlaygroundApi
}
/** Router-free screen shared by the Web route and the legacy Next bridge. */
export function PlaygroundScreen(props: PlaygroundScreenProps) {
	return (
		<PlaygroundSessionScreen
			key={JSON.stringify([
				props.session.scopeKey,
				props.session.reconciliationKey,
				props.session.subject,
				props.session.enabled,
			])}
			{...props}
		/>
	)
}
function PlaygroundSessionScreen(props: PlaygroundScreenProps) {
	const { t } = useTranslation(),
		api = useMemo(
			() => props.api ?? createPlaygroundApi(fetch, props.session.subject),
			[props.api, props.session.subject]
		)
	const query = useQuery({
		queryKey: ['cinatoken', 'admin', props.session.scopeKey, 'playground'],
		queryFn: ({ signal }) => api.context(signal),
		enabled: props.session.enabled,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
		staleTime: 0,
	})
	const accessLost =
		query.error instanceof PlaygroundError && query.error.code === 'access'
	// Revalidation changes the host session generation and remounts this query.
	// Keep a denied context stable until an explicit refresh; otherwise a persistent
	// permission failure creates an endless auth/context request loop.
	return (
		<main className='min-w-0 space-y-5 pb-10'>
			<header className='space-y-1'>
				<h1 className='text-2xl font-semibold'>{t(prefix + 'title')}</h1>
				<p className='text-muted-foreground text-sm'>
					{t(
						prefix +
							(props.search.mode === 'tools' ? 'toolsSubtitle' : 'subtitle'),
						{ product: 'cinatoken' }
					)}
				</p>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'usageNote')}
				</p>
			</header>
			{!props.session.enabled ? (
				<p role='alert'>{t(prefix + 'accessDenied')}</p>
			) : null}
			{query.error ? (
				<div role='alert' className='space-y-2 rounded-xl border p-4'>
					<p>{t(prefix + playgroundErrorKey(query.error))}</p>
					<Button
						variant='outline'
						onClick={() => {
							void props.session.revalidate().catch(() => undefined)
							void query.refetch()
						}}
					>
						{t(prefix + 'refresh')}
					</Button>
				</div>
			) : null}
			{query.isPending && props.session.enabled ? (
				<p role='status'>{t(prefix + 'loading')}</p>
			) : null}
			{query.data && props.session.enabled && !accessLost ? (
				<PlaygroundContent
					{...props}
					api={api}
					context={query.data}
					fetching={query.isFetching}
					refresh={() => void query.refetch()}
				/>
			) : null}
		</main>
	)
}
function PlaygroundContent(
	props: PlaygroundScreenProps & {
		api: PlaygroundApi
		context: PlaygroundContext
		fetching: boolean
		refresh: () => void
	}
) {
	const { t } = useTranslation(),
		[kind, setKind] = useState<PlaygroundKind>(() => {
			const selected = props.context.routes.find(
				(route) => route.id === props.search.routeId
			)
			return selected ? routeKind(props.context, selected) : 'llm'
		}),
		[imageOperation, setImageOperation] =
			useState<ImageOperation>('generations'),
		[geminiAction, setGeminiAction] = useState<
			'generateContent' | 'streamGenerateContent'
		>('streamGenerateContent'),
		[audioInput, setAudioInput] = useState<'file' | 'microphone'>('file')
	const route =
		props.context.routes.find((row) => row.id === props.search.routeId) ?? null
	const tool = props.context.tools.find(
		(row) => row.toolId === props.search.tool
	)
	const search = {
		...props.search,
		provider: props.search.provider || (tool?.providers[0]?.provider ?? ''),
	}
	const selectedKind = route ? routeKind(props.context, route) : kind
	const key = JSON.stringify([
		search.mode,
		search.routeId,
		search.tool,
		search.provider,
		imageOperation,
		geminiAction,
		audioInput,
	])
	const template = useMemo(
		() =>
			selectionTemplate(
				props.context,
				{
					mode: props.search.mode,
					routeId: props.search.routeId,
					tool: props.search.tool,
					provider: props.search.provider,
				},
				imageOperation
			),
		[
			props.context,
			props.search.mode,
			props.search.routeId,
			props.search.tool,
			props.search.provider,
			imageOperation,
		]
	)
	const [editor, setEditor] = useState(() => ({
		key,
		body: template,
		template,
		retained: false,
		images: [] as File[],
		audio: null as File | null,
	}))
	if (editor.key !== key) {
		const retained = bodyIsDirty(editor.body, editor.template)
		setEditor({
			key,
			body: retained ? editor.body : template,
			template,
			retained,
			images: [],
			audio: null,
		})
	}
	const run = usePlaygroundRun(props.api, props.session, key)
	const uploads = { images: editor.images, audio: editor.audio }
	function select(next: PlaygroundSearch) {
		run.clear()
		props.onSearchChange(next)
	}
	function changeKind(value: PlaygroundKind) {
		setKind(value)
		const first = props.context.routes.find(
			(row) => routeKind(props.context, row) === value
		)
		select({ ...search, routeId: first?.id ?? '' })
	}
	function updateBody(value: string) {
		setEditor((previous) => ({ ...previous, body: value, retained: false }))
		run.clear()
	}
	function sample(id: PlaygroundLlmSampleId) {
		if (route) updateBody(llmSample(route, id))
	}
	function action(preview: boolean) {
		try {
			const envelope = buildPlaygroundInput(
				props.context,
				search,
				editor.body,
				imageOperation,
				geminiAction,
				uploads,
				audioInput,
				preview
			)
			if (preview) void run.runPreview(envelope, uploads)
			else
				void run.send(envelope, uploads, {
					route,
					kind: search.mode === 'tools' ? 'tool' : selectedKind,
					audioInput,
					body: editor.body,
				})
		} catch (error) {
			run.setError(playgroundErrorKey(error))
		}
	}
	function updateUploads(images: File[], audio: File | null) {
		run.clear()
		setEditor((previous) => ({ ...previous, images, audio }))
	}
	return (
		<div className='space-y-5'>
			<div className='flex flex-wrap items-center justify-between gap-2'>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'memoryOnly')}
				</p>
				<Button
					variant='outline'
					size='sm'
					disabled={props.fetching}
					onClick={() => {
						run.clear()
						updateUploads([], null)
						props.refresh()
					}}
				>
					{t(prefix + 'refresh')}
				</Button>
			</div>
			{run.error ? (
				<p
					role='alert'
					className='text-destructive rounded-xl border p-4 text-sm'
				>
					{t(prefix + run.error)}
				</p>
			) : null}
			{run.denied ? (
				<p role='alert'>{t(prefix + 'accessDenied')}</p>
			) : (
				<>
					<PlaygroundSetup
						context={props.context}
						search={search}
						route={route}
						kind={selectedKind}
						onKind={changeKind}
						onSearch={select}
					/>
					<div className='grid min-w-0 gap-5 2xl:grid-cols-2 2xl:items-start'>
						<PlaygroundRequest
							context={props.context}
							route={route}
							kind={search.mode === 'tools' ? 'tool' : selectedKind}
							body={editor.body}
							busy={run.busy}
							dirty={editor.retained}
							imageOperation={imageOperation}
							geminiAction={geminiAction}
							audioInput={audioInput}
							uploads={uploads}
							preview={run.preview}
							result={run.result}
							onBody={updateBody}
							onTemplate={() => updateBody(template)}
							onSample={sample}
							onImages={(files) => updateUploads(files, null)}
							onAudio={(file) => updateUploads([], file)}
							onImageOperation={(value) => {
								run.clear()
								setImageOperation(value)
							}}
							onGeminiAction={(value) => {
								run.clear()
								setGeminiAction(value)
							}}
							onAudioInput={(value) => {
								run.clear()
								setAudioInput(value)
							}}
							onSend={() => action(false)}
							onPreview={() => action(true)}
							onStop={run.stop}
						/>
						<PlaygroundResponse
							key={run.result?.runId ?? 'empty'}
							result={run.result}
							busy={run.busy}
							onClear={run.clear}
						/>
					</div>
				</>
			)}
		</div>
	)
}
