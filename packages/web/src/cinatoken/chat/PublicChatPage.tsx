/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	parsePublicChatStoredSession,
	PUBLIC_CHAT_MAX_ATTACHMENT_BYTES,
	PUBLIC_CHAT_MAX_ATTACHMENTS,
	PUBLIC_CHAT_MAX_TOTAL_ATTACHMENT_BYTES,
	PUBLIC_CHAT_STORAGE_KEY,
} from '../../../../core/src/lib/public-chat'
import { createPublicCatalogApi } from '../public/catalog-api'
import { publicModelsQueryOptions } from '../public/ssr/public-query-options'
import {
	chatRetryDelaySeconds,
	createPublicChatApi,
	PublicChatError,
	type PublicChatApi,
} from './chat-api'
import {
	isValidAttachment,
	toChatApiMessages,
	toStoredChatSession,
	validateAttachmentFiles,
	type ChatAttachment,
	type ChatMessage,
} from './chat-model'

const catalogApi = createPublicCatalogApi()
const chatApi = createPublicChatApi()
const markdownPlugins = [remarkGfm]
const markdownComponents: Components = {
	a: (props) => (
		<a
			href={props.href}
			target='_blank'
			rel='noopener noreferrer'
			className='text-primary underline'
		>
			{props.children}
		</a>
	),
	pre: (props) => (
		<pre className='bg-muted my-3 max-w-full overflow-x-auto rounded-lg p-3'>
			{props.children}
		</pre>
	),
	table: (props) => (
		<div className='max-w-full overflow-x-auto'>
			<table className='my-3 border-collapse [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2'>
				{props.children}
			</table>
		</div>
	),
}
const id = () => crypto.randomUUID()
function storedConversation() {
	try {
		const raw = localStorage.getItem(PUBLIC_CHAT_STORAGE_KEY)
		return raw ? parsePublicChatStoredSession(raw) : null
	} catch {
		return null
	}
}
function readImage(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () =>
			typeof reader.result === 'string'
				? resolve(reader.result)
				: reject(new Error('invalid_image'))
		reader.onerror = () => reject(new Error('image_read_failed'))
		reader.readAsDataURL(file)
	})
}

export function PublicChatPage(props: {
	api?: PublicChatApi
	modelId?: string
	onModelChange?: (modelId: string) => void
}) {
	const { t } = useTranslation()
	const [modelId, setModelId] = useState('')
	const [key, setKey] = useState('')
	const [prompt, setPrompt] = useState('')
	const [messages, setMessages] = useState<ChatMessage[]>([])
	const [attachments, setAttachments] = useState<ChatAttachment[]>([])
	const [saveLocally, setSaveLocally] = useState(false)
	const [storageHydrated, setStorageHydrated] = useState(false)
	const [error, setError] = useState('')
	const [storageError, setStorageError] = useState(false)
	const [sending, setSending] = useState(false)
	const [readingImages, setReadingImages] = useState(false)
	const requestRef = useRef<{
		controller: AbortController
		assistantId: string
	} | null>(null)
	const filesVersion = useRef(0)
	const filesBusy = useRef(false)
	const inputRef = useRef<HTMLInputElement>(null)
	const transcriptRef = useRef<HTMLDivElement>(null)
	const followingStream = useRef(true)
	const catalog = useQuery(
		publicModelsQueryOptions(catalogApi, undefined, true)
	)
	const models = useMemo(
		() =>
			catalog.data?.data.filter(
				(model) =>
					model.id.length <= 180 &&
					model.protocols.includes('openai') &&
					model.output_modalities?.includes('text')
			) ?? [],
		[catalog.data]
	)
	const selected =
		models.find((model) => model.id === (props.modelId || modelId)) ?? models[0]
	const effectiveModelId = selected?.id ?? ''
	const supportsImages = selected?.input_modalities?.includes('image') ?? false
	const existingImages = useMemo(
		() => messages.flatMap((message) => message.attachments ?? []),
		[messages]
	)
	const busy = sending || readingImages
	const label = (name: string, values?: Record<string, string | number>) =>
		t(`cinatoken.chat.${name}`, values)
	useEffect(() => {
		let active = true
		// Read browser-only history after hydration commits; a cancelled mount
		// must not restore state into a replacement conversation.
		queueMicrotask(() => {
			if (!active) return
			const stored = storedConversation()
			if (stored) {
				setModelId(stored.modelId)
				setMessages(
					stored.messages.map((message) => ({ ...message, id: id() }))
				)
				setSaveLocally(true)
			}
			setStorageHydrated(true)
		})
		return () => {
			active = false
		}
	}, [])
	useEffect(() => {
		if (followingStream.current && transcriptRef.current)
			transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
	}, [messages, sending])

	useEffect(
		() => () => {
			requestRef.current?.controller.abort()
			requestRef.current = null
			filesVersion.current++
		},
		[]
	)
	useEffect(() => {
		// The anonymous HTML and hydration frame share an empty transcript. Do not
		// remove an existing opt-in conversation before the restore effect runs.
		if (!storageHydrated) return
		const timer = setTimeout(() => {
			try {
				if (saveLocally) {
					if (!effectiveModelId) return
					const session = toStoredChatSession(
						effectiveModelId,
						messages,
						(count) => t('cinatoken.chat.localAttachmentPlaceholder', { count })
					)
					// Respect the same bounded transcript contract when persisting a long completion.
					if (!parsePublicChatStoredSession(JSON.stringify(session)))
						throw new Error('history_limit')
					localStorage.setItem(PUBLIC_CHAT_STORAGE_KEY, JSON.stringify(session))
				} else localStorage.removeItem(PUBLIC_CHAT_STORAGE_KEY)
				setStorageError(false)
			} catch {
				setStorageError(true)
			}
		}, 250)
		return () => clearTimeout(timer)
	}, [effectiveModelId, messages, saveLocally, storageHydrated, t])

	function reset() {
		followingStream.current = true
		requestRef.current?.controller.abort()
		requestRef.current = null
		filesVersion.current++
		filesBusy.current = false
		setReadingImages(false)
		setSending(false)
		setMessages([])
		setAttachments([])
		setPrompt('')
		setError('')
		try {
			localStorage.removeItem(PUBLIC_CHAT_STORAGE_KEY)
			setStorageError(false)
		} catch {
			setStorageError(true)
		}
	}
	async function addImages(files: FileList | null) {
		if (!files?.length || filesBusy.current || requestRef.current) return
		const candidates = Array.from(files)
		const validation = validateAttachmentFiles(
			candidates,
			[...existingImages, ...attachments],
			supportsImages
		)
		if (validation) {
			setError(
				label(validation, {
					count: PUBLIC_CHAT_MAX_ATTACHMENTS,
					size:
						validation === 'attachmentsTooLarge'
							? PUBLIC_CHAT_MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024
							: PUBLIC_CHAT_MAX_ATTACHMENT_BYTES / 1024 / 1024,
				})
			)
			return
		}
		const version = ++filesVersion.current
		filesBusy.current = true
		setReadingImages(true)
		try {
			const images = await Promise.all(
				candidates.map(async (file) => ({
					id: id(),
					name: file.name,
					size: file.size,
					dataUrl: await readImage(file),
				}))
			)
			if (version !== filesVersion.current) return
			if (images.some((image) => !isValidAttachment(image)))
				throw new Error('invalid_image')
			setAttachments((current) => [...current, ...images])
			setError('')
		} catch {
			if (version === filesVersion.current)
				setError(label('attachmentReadFailed'))
		} finally {
			if (version === filesVersion.current) {
				filesBusy.current = false
				setReadingImages(false)
			}
		}
	}
	async function send() {
		if (
			catalog.isError ||
			requestRef.current ||
			filesBusy.current ||
			!effectiveModelId ||
			!key.trim() ||
			(!prompt.trim() && !attachments.length)
		)
			return
		if (!supportsImages && (existingImages.length || attachments.length)) {
			setError(label('imagesUnsupported'))
			return
		}
		const next = [
			...messages,
			{
				id: id(),
				role: 'user' as const,
				content: prompt.trim(),
				attachments: attachments.length ? attachments : undefined,
			},
		]
		const assistantId = id()
		const pending = { controller: new AbortController(), assistantId }
		requestRef.current = pending
		followingStream.current = true
		setMessages([...next, { id: assistantId, role: 'assistant', content: '' }])
		setPrompt('')
		setAttachments([])
		setError('')
		setSending(true)
		try {
			await (props.api ?? chatApi).send(
				key,
				{ model: effectiveModelId, messages: toChatApiMessages(next) },
				{
					signal: pending.controller.signal,
					onText: (text) => {
						if (requestRef.current === pending)
							setMessages((current) =>
								current.map((message) =>
									message.id === assistantId
										? { ...message, content: text }
										: message
								)
							)
					},
				}
			)
		} catch (cause) {
			if (requestRef.current !== pending) return
			if (!(cause instanceof PublicChatError && cause.code === 'cancelled')) {
				if (cause instanceof PublicChatError && cause.code === 'http') {
					const seconds = chatRetryDelaySeconds(cause.retryAfter)
					setError(
						label('requestFailed', { status: cause.status }) +
							(seconds === null ? '' : ' ' + label('retryAfter', { seconds }))
					)
				} else if (cause instanceof PublicChatError && cause.code === 'input')
					setError(label('invalidInput'))
				else if (
					cause instanceof PublicChatError &&
					cause.code === 'interrupted'
				)
					setError(label('interrupted'))
				else if (cause instanceof PublicChatError && cause.code === 'timeout')
					setError(label('timeout'))
				else if (
					cause instanceof PublicChatError &&
					cause.code === 'invalid-response'
				)
					setError(label('invalidResponse'))
				else setError(label('networkError'))
			}
			setMessages((current) =>
				current.filter(
					(message) => message.id !== assistantId || message.content.trim()
				)
			)
		} finally {
			if (requestRef.current === pending) {
				requestRef.current = null
				setSending(false)
			}
		}
	}

	return (
		<section className='grid min-w-0 gap-6 py-8 lg:grid-cols-[280px_minmax(0,1fr)]'>
			<aside className='min-w-0 space-y-5 rounded-2xl border p-5'>
				<div className='flex items-center justify-between gap-3'>
					<h1 className='text-2xl font-semibold'>{label('title')}</h1>
					<Button variant='outline' size='sm' onClick={reset}>
						{label('newChat')}
					</Button>
				</div>
				<p className='text-muted-foreground text-sm leading-6'>
					{label('description')}
				</p>
				<label className='block space-y-2'>
					<span className='text-sm font-medium'>{label('model')}</span>
					<select
						className='bg-background w-full rounded-lg border p-2'
						value={effectiveModelId}
						disabled={busy || !models.length}
						onChange={(event) => {
							setModelId(event.target.value)
							props.onModelChange?.(event.target.value)
						}}
					>
						<option value='' disabled>
							{label('model')}
						</option>
						{models.map((model) => (
							<option key={model.id} value={model.id}>
								{model.display_name ?? model.id}
							</option>
						))}
					</select>
				</label>
				{selected ? (
					<p className='text-muted-foreground text-xs'>
						{label(supportsImages ? 'textAndImages' : 'textOnly')}
					</p>
				) : null}
				<label className='block space-y-2'>
					<span className='text-sm font-medium'>{label('apiKey')}</span>
					<Input
						type='password'
						autoComplete='off'
						spellCheck={false}
						value={key}
						disabled={sending}
						onChange={(event) => setKey(event.target.value)}
						placeholder='sk-…'
					/>
				</label>
				<p className='text-muted-foreground text-xs leading-5'>
					{label('keySafety')}
				</p>
				<a
					href='/account/keys'
					className='text-sm underline underline-offset-4'
				>
					{label('getKey')}
				</a>
				<label className='flex gap-3 rounded-lg border p-3'>
					<input
						className='mt-1'
						type='checkbox'
						checked={saveLocally}
						onChange={(event) => setSaveLocally(event.target.checked)}
					/>
					<span>
						<span className='block text-sm font-medium'>
							{label('saveLocally')}
						</span>
						<span className='text-muted-foreground mt-1 block text-xs leading-5'>
							{label('saveLocallyHelp')}
						</span>
					</span>
				</label>
				{storageError ? (
					<p role='alert' className='text-destructive text-sm'>
						{label('localSaveFailed')}
					</p>
				) : null}
				<Button variant='outline' onClick={reset}>
					{label('clear')}
				</Button>
			</aside>
			<div className='flex min-w-0 flex-col rounded-2xl border'>
				<div
					ref={transcriptRef}
					className='max-h-[65vh] min-h-96 flex-1 space-y-5 overflow-y-auto p-4 sm:p-6'
					onScroll={(event) => {
						const node = event.currentTarget
						followingStream.current =
							node.scrollHeight - node.scrollTop - node.clientHeight < 80
					}}
					aria-live='polite'
					aria-busy={sending}
				>
					{!messages.length ? (
						<div className='py-16 text-center'>
							<h2 className='text-2xl font-semibold'>{label('emptyTitle')}</h2>
							<p className='text-muted-foreground mx-auto mt-3 max-w-lg text-sm leading-6'>
								{label('emptyDescription')}
							</p>
						</div>
					) : null}
					{catalog.isPending ? <p role='status'>{label('thinking')}</p> : null}
					{catalog.isError ? (
						<div role='alert'>
							<p>{label('catalogUnavailable')}</p>
							<Button
								variant='outline'
								className='mt-3'
								onClick={() => void catalog.refetch()}
							>
								{t('cinatoken.shell.retry')}
							</Button>
						</div>
					) : null}
					{catalog.isSuccess && !models.length ? (
						<p role='status'>{label('noModels')}</p>
					) : null}
					{messages.map((message) => (
						<article
							key={message.id}
							className={`flex min-w-0 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
						>
							<div
								className={`max-w-[95%] min-w-0 space-y-3 rounded-2xl p-4 text-sm leading-6 sm:max-w-[90%] ${message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
							>
								{message.attachments?.length ? (
									<div className='grid grid-cols-2 gap-2'>
										{message.attachments.map((image) => (
											<img
												key={image.id}
												src={image.dataUrl}
												alt={image.name}
												className='h-28 w-full rounded-lg object-cover'
											/>
										))}
									</div>
								) : null}
								{message.role === 'assistant' && message.content ? (
									<div className='min-w-0 break-words [&_p]:my-2'>
										<ReactMarkdown
											remarkPlugins={markdownPlugins}
											components={markdownComponents}
											skipHtml
											disallowedElements={['img']}
										>
											{message.content}
										</ReactMarkdown>
									</div>
								) : (
									<p className='break-words whitespace-pre-wrap'>
										{message.content || label('thinking')}
									</p>
								)}
							</div>
						</article>
					))}
					{error ? (
						<p role='alert' className='text-destructive rounded-lg border p-3'>
							{error}
						</p>
					) : null}
				</div>
				<form
					className='space-y-3 border-t p-4'
					onSubmit={(event) => {
						event.preventDefault()
						void send()
					}}
				>
					{attachments.length ? (
						<div className='flex flex-wrap gap-3'>
							{attachments.map((image) => (
								<div className='relative' key={image.id}>
									<img
										src={image.dataUrl}
										alt={image.name}
										className='h-16 w-16 rounded-lg object-cover'
									/>
									<button
										className='bg-background absolute -top-2 -right-2 rounded-full border px-2'
										type='button'
										aria-label={label('removeAttachment', { name: image.name })}
										onClick={() =>
											setAttachments((current) =>
												current.filter((item) => item.id !== image.id)
											)
										}
									>
										×
									</button>
								</div>
							))}
						</div>
					) : null}
					<label className='block'>
						<span className='sr-only'>{label('promptLabel')}</span>
						<textarea
							className='bg-background min-h-24 w-full resize-y rounded-xl border p-3 text-sm'
							value={prompt}
							disabled={sending}
							placeholder={label('prompt')}
							onChange={(event) => setPrompt(event.target.value)}
							onKeyDown={(event) => {
								if (
									event.key === 'Enter' &&
									!event.shiftKey &&
									!event.nativeEvent.isComposing
								) {
									event.preventDefault()
									void send()
								}
							}}
						/>
					</label>
					<div className='flex flex-wrap items-center justify-between gap-3'>
						<input
							aria-label={label('attachImages')}
							className='sr-only'
							ref={inputRef}
							type='file'
							multiple
							accept='image/png,image/jpeg,image/webp,image/gif'
							disabled={busy || !supportsImages}
							onChange={(event) => {
								void addImages(event.target.files)
								event.target.value = ''
							}}
						/>
						<Button
							type='button'
							variant='outline'
							disabled={
								busy ||
								!supportsImages ||
								existingImages.length + attachments.length >=
									PUBLIC_CHAT_MAX_ATTACHMENTS
							}
							onClick={() => inputRef.current?.click()}
						>
							{label('attachImages')}
						</Button>
						{sending ? (
							<Button
								type='button'
								variant='outline'
								onClick={() => requestRef.current?.controller.abort()}
							>
								{label('stop')}
							</Button>
						) : (
							<Button
								type='submit'
								disabled={
									busy ||
									catalog.isError ||
									!effectiveModelId ||
									!key.trim() ||
									(!prompt.trim() && !attachments.length) ||
									(!supportsImages && existingImages.length > 0)
								}
							>
								{label('send')}
							</Button>
						)}
					</div>
					<p className='text-muted-foreground text-center text-xs'>
						{label('disclaimer')}
					</p>
				</form>
			</div>
		</section>
	)
}
