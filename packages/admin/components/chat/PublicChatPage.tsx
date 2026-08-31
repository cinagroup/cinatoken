'use client';

import {
	ArrowUpIcon,
	KeyIcon,
	PaperClipIcon,
	PlusIcon,
	StopIcon,
	TrashIcon,
	XMarkIcon,
} from '@heroicons/react/24/outline';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PublicCatalogResult } from '@/lib/public-catalog';
import {
	parsePublicChatResponseError,
	parsePublicChatResponseText,
	parsePublicChatStoredSession,
	PUBLIC_CHAT_MAX_ATTACHMENT_BYTES,
	PUBLIC_CHAT_MAX_ATTACHMENTS,
	PUBLIC_CHAT_MAX_TOTAL_ATTACHMENT_BYTES,
	PUBLIC_CHAT_STORAGE_KEY,
	PublicChatSseDecoder,
	type PublicChatMessage,
	type PublicChatStreamEvent,
} from '@/lib/public-chat';

type Attachment = {
	id: string;
	name: string;
	type: string;
	size: number;
	dataUrl: string;
};

type Message = {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	attachments?: Attachment[];
};

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS: Components = {
	a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

function createId(): string {
	return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('invalid_file'));
		reader.onerror = () => reject(reader.error ?? new Error('file_read_failed'));
		reader.readAsDataURL(file);
	});
}

function toApiMessages(messages: Message[]): PublicChatMessage[] {
	return messages.map((message) => {
		if (message.role === 'assistant' || !message.attachments?.length) {
			return { role: message.role, content: message.content };
		}
		return {
			role: 'user',
			content: [
				...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
				...message.attachments.map((attachment) => ({
					type: 'image_url' as const,
					image_url: { url: attachment.dataUrl, detail: 'auto' as const },
				})),
			],
		};
	});
}

function AssistantMarkdown({ content }: { content: string }) {
	return (
		<div className="public-chat-markdown">
			<ReactMarkdown
				remarkPlugins={REMARK_PLUGINS}
				components={MARKDOWN_COMPONENTS}
				skipHtml
				disallowedElements={['img']}
			>
				{content}
			</ReactMarkdown>
		</div>
	);
}

export default function PublicChatPage({ catalog }: { catalog: PublicCatalogResult }) {
	const t = useTranslations('publicChat');
	const models = useMemo(
		() => catalog.models.filter((model) => model.protocols.includes('openai') && model.outputModalities.includes('text')),
		[catalog.models],
	);
	const [modelId, setModelId] = useState(models[0]?.id ?? '');
	const [apiKey, setApiKey] = useState('');
	const [prompt, setPrompt] = useState('');
	const [messages, setMessages] = useState<Message[]>([]);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [error, setError] = useState('');
	const [storageError, setStorageError] = useState('');
	const [sending, setSending] = useState(false);
	const [saveLocally, setSaveLocally] = useState(false);
	const [storageHydrated, setStorageHydrated] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const endRef = useRef<HTMLDivElement | null>(null);

	const selectedModel = models.find((model) => model.id === modelId) ?? null;
	const supportsImages = selectedModel?.inputModalities.some((value) => value.toLowerCase() === 'image') ?? false;
	const conversationAttachmentCount = messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0);
	const conversationAttachmentBytes = messages.reduce(
		(sum, message) => sum + (message.attachments?.reduce((partSum, attachment) => partSum + attachment.size, 0) ?? 0),
		0,
	);

	useEffect(() => {
		try {
			const raw = window.localStorage.getItem(PUBLIC_CHAT_STORAGE_KEY);
			if (raw) {
				const stored = parsePublicChatStoredSession(raw);
				if (stored) {
					setSaveLocally(true);
					if (models.some((model) => model.id === stored.modelId)) setModelId(stored.modelId);
					setMessages(stored.messages.map((message) => ({ ...message, id: createId() })));
				} else {
					window.localStorage.removeItem(PUBLIC_CHAT_STORAGE_KEY);
				}
			}
		} catch {
			setStorageError(t('localSaveFailed'));
		} finally {
			setStorageHydrated(true);
		}
	}, [models, t]);

	useEffect(() => {
		if (!storageHydrated) return;
		const timer = window.setTimeout(() => {
			try {
				if (!saveLocally) {
					window.localStorage.removeItem(PUBLIC_CHAT_STORAGE_KEY);
					setStorageError('');
					return;
				}
				window.localStorage.setItem(PUBLIC_CHAT_STORAGE_KEY, JSON.stringify({
					version: 1,
					modelId,
					messages: messages
						.map(({ role, content, attachments: messageAttachments }) => ({
							role,
							content: content.trim() || (role === 'user' && messageAttachments?.length
								? t('localAttachmentPlaceholder', { count: messageAttachments.length })
								: ''),
						}))
						.filter((message) => message.content),
				}));
				setStorageError('');
			} catch {
				setStorageError(t('localSaveFailed'));
			}
		}, 250);
		return () => window.clearTimeout(timer);
	}, [messages, modelId, saveLocally, storageHydrated, t]);

	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: sending ? 'auto' : 'smooth', block: 'end' });
	}, [messages, sending]);

	useEffect(() => () => abortRef.current?.abort(), []);

	const resetConversation = () => {
		abortRef.current?.abort();
		setMessages([]);
		setAttachments([]);
		setPrompt('');
		setError('');
	};

	const addAttachments = async (files: FileList | null) => {
		if (!files?.length) return;
		if (!supportsImages) {
			setError(t('imagesUnsupported'));
			return;
		}
		const candidates = Array.from(files);
		if (conversationAttachmentCount + attachments.length + candidates.length > PUBLIC_CHAT_MAX_ATTACHMENTS) {
			setError(t('tooManyAttachments', { count: PUBLIC_CHAT_MAX_ATTACHMENTS }));
			return;
		}
		if (candidates.some((file) => !ALLOWED_IMAGE_TYPES.has(file.type))) {
			setError(t('unsupportedAttachment'));
			return;
		}
		if (candidates.some((file) => file.size < 1 || file.size > PUBLIC_CHAT_MAX_ATTACHMENT_BYTES)) {
			setError(t('attachmentTooLarge', { size: PUBLIC_CHAT_MAX_ATTACHMENT_BYTES / 1024 / 1024 }));
			return;
		}
		const candidateBytes = candidates.reduce((sum, file) => sum + file.size, 0);
		const pendingBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
		if (conversationAttachmentBytes + pendingBytes + candidateBytes > PUBLIC_CHAT_MAX_TOTAL_ATTACHMENT_BYTES) {
			setError(t('attachmentsTooLarge', { size: PUBLIC_CHAT_MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024 }));
			return;
		}
		try {
			const next = await Promise.all(candidates.map(async (file): Promise<Attachment> => ({
				id: createId(),
				name: file.name,
				type: file.type,
				size: file.size,
				dataUrl: await readFileAsDataUrl(file),
			})));
			setAttachments((current) => [...current, ...next]);
			setError('');
		} catch {
			setError(t('attachmentReadFailed'));
		}
	};

	const applyStreamEvents = (
		events: PublicChatStreamEvent[],
		assistantId: string,
		currentText: string,
	): { text: string; done: boolean } => {
		let text = currentText;
		let done = false;
		for (const event of events) {
			if (event.type === 'error') throw new Error(event.message);
			if (event.type === 'done') {
				done = true;
				continue;
			}
			text += event.text;
		}
		if (text !== currentText) {
			setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: text } : message));
		}
		return { text, done };
	};

	const send = async () => {
		const content = prompt.trim();
		if ((!content && attachments.length === 0) || !apiKey.trim() || !modelId || sending) return;
		if ((attachments.length || conversationAttachmentCount) && !supportsImages) {
			setError(t('imagesUnsupported'));
			return;
		}
		const userMessage: Message = {
			id: createId(),
			role: 'user',
			content,
			attachments: attachments.length ? attachments : undefined,
		};
		const assistantId = createId();
		const nextMessages = [...messages, userMessage];
		setMessages([...nextMessages, { id: assistantId, role: 'assistant', content: '' }]);
		setPrompt('');
		setAttachments([]);
		setError('');
		setSending(true);
		const controller = new AbortController();
		abortRef.current = controller;

		try {
			const response = await fetch('/api/public/chat', {
				method: 'POST',
				headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json' },
				body: JSON.stringify({ model: modelId, messages: toApiMessages(nextMessages), stream: true }),
				signal: controller.signal,
			});
			if (!response.ok) {
				const body: unknown = await response.json().catch(() => null);
				throw new Error(parsePublicChatResponseError(body) ?? t('requestFailed', { status: response.status }));
			}

			const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
			if (!contentType.includes('text/event-stream') || !response.body) {
				const body: unknown = await response.json().catch(() => null);
				const assistant = parsePublicChatResponseText(body);
				if (!assistant) throw new Error(t('invalidResponse'));
				setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: assistant } : message));
				return;
			}

			const reader = response.body.getReader();
			const textDecoder = new TextDecoder();
			const sseDecoder = new PublicChatSseDecoder();
			let assistantText = '';
			let done = false;
			while (!done) {
				const chunk = await reader.read();
				if (chunk.done) {
					const tail = textDecoder.decode();
					if (tail) {
						const flushed = applyStreamEvents(sseDecoder.push(tail), assistantId, assistantText);
						assistantText = flushed.text;
						done ||= flushed.done;
					}
					const finished = applyStreamEvents(sseDecoder.finish(), assistantId, assistantText);
					assistantText = finished.text;
					done ||= finished.done;
					break;
				}
				({ text: assistantText, done } = applyStreamEvents(
					sseDecoder.push(textDecoder.decode(chunk.value, { stream: true })),
					assistantId,
					assistantText,
				));
			}
			if (done) await reader.cancel().catch(() => undefined);
			if (!assistantText.trim()) throw new Error(t('invalidResponse'));
		} catch (cause) {
			if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
				setError(cause instanceof Error ? cause.message : t('networkError'));
			}
			setMessages((current) => current.filter((message) => message.id !== assistantId || message.content.trim()));
		} finally {
			if (abortRef.current === controller) abortRef.current = null;
			setSending(false);
		}
	};

	return (
		<main className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-[1440px] lg:grid-cols-[280px_minmax(0,1fr)]">
			<aside className="home-border border-b p-4 lg:border-b-0 lg:border-r lg:p-5">
				<div className="flex items-center justify-between">
					<h1 className="home-text text-lg font-semibold">{t('title')}</h1>
					<button type="button" onClick={resetConversation} className="home-muted home-hover-text rounded-md p-2" aria-label={t('newChat')}>
						<PlusIcon className="h-4 w-4" />
					</button>
				</div>
				<p className="home-muted mt-2 text-xs leading-5">{t('description')}</p>
				<label className="home-faint mt-6 block text-xs font-medium" htmlFor="public-chat-model">{t('model')}</label>
				<select id="public-chat-model" value={modelId} onChange={(event) => setModelId(event.target.value)} className="home-catalog-control home-text mt-2 h-10 w-full rounded-lg border px-3 text-sm">
					{models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
				</select>
				{selectedModel ? <p className="home-faint mt-2 text-[11px]">{supportsImages ? t('textAndImages') : t('textOnly')}</p> : null}
				<label className="home-faint mt-5 block text-xs font-medium" htmlFor="public-chat-api-key">{t('apiKey')}</label>
				<div className="relative mt-2">
					<KeyIcon className="home-faint pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
					<input id="public-chat-api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" className="home-catalog-control home-text h-10 w-full rounded-lg border pl-9 pr-3 text-sm" />
				</div>
				<p className="home-faint mt-2 text-[11px] leading-4">{t('keySafety')}</p>
				<Link href="/account/settings" className="home-muted home-hover-text mt-3 inline-flex text-xs underline underline-offset-4">{t('getKey')}</Link>
				<label className="home-catalog-card mt-6 flex cursor-pointer items-start gap-3 rounded-lg border p-3">
					<input type="checkbox" checked={saveLocally} onChange={(event) => setSaveLocally(event.target.checked)} className="mt-0.5 h-4 w-4 accent-sky-500" />
					<span><span className="home-text block text-xs font-medium">{t('saveLocally')}</span><span className="home-faint mt-1 block text-[11px] leading-4">{t('saveLocallyHelp')}</span></span>
				</label>
				{storageError ? <p role="alert" className="mt-2 text-[11px] text-red-500">{storageError}</p> : null}
				{messages.length ? <button type="button" onClick={resetConversation} className="home-muted home-hover-text mt-6 flex items-center gap-2 text-xs"><TrashIcon className="h-4 w-4" />{t('clear')}</button> : null}
			</aside>

			<section className="flex min-h-[620px] min-w-0 flex-col">
				<div className="flex-1 overflow-y-auto px-4 py-8 sm:px-8">
					<div className="mx-auto max-w-3xl" aria-live="polite" aria-busy={sending}>
						{messages.length === 0 ? (
							<div className="py-20 text-center">
								<h2 className="home-text text-2xl font-semibold tracking-[-0.03em]">{t('emptyTitle')}</h2>
								<p className="home-muted mx-auto mt-3 max-w-lg text-sm leading-6">{catalog.status === 'unavailable' ? t('catalogUnavailable') : models.length === 0 ? t('noModels') : t('emptyDescription')}</p>
							</div>
						) : (
							<div className="space-y-6">
								{messages.map((message) => (
									<article key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
										<div className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-6 sm:max-w-[88%] ${message.role === 'user' ? 'bg-[var(--home-text)] text-[var(--home-bg)]' : 'home-catalog-card home-text min-w-0 border'}`}>
											{message.attachments?.length ? <div className="mb-3 grid grid-cols-2 gap-2">{message.attachments.map((attachment) => <Image key={attachment.id} src={attachment.dataUrl} alt={attachment.name} width={240} height={160} unoptimized className="h-28 w-full rounded-lg object-cover" />)}</div> : null}
											{message.role === 'assistant' ? (message.content ? <AssistantMarkdown content={message.content} /> : <span className="public-chat-cursor" aria-label={t('thinking')} />) : <p className="whitespace-pre-wrap">{message.content}</p>}
										</div>
									</article>
								))}
							</div>
						)}
						{error ? <div role="alert" className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">{error}</div> : null}
						<div ref={endRef} />
					</div>
				</div>

				<div className="home-border sticky bottom-0 border-t bg-[var(--home-bg)] px-4 py-4 sm:px-8">
					<div className="mx-auto max-w-3xl">
						{attachments.length ? <div className="mb-2 flex flex-wrap gap-2">{attachments.map((attachment) => <div key={attachment.id} className="home-catalog-card relative h-16 w-16 overflow-hidden rounded-lg border"><Image src={attachment.dataUrl} alt={attachment.name} fill unoptimized sizes="64px" className="object-cover" /><button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label={t('removeAttachment', { name: attachment.name })} className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white"><XMarkIcon className="h-3.5 w-3.5" /></button></div>)}</div> : null}
						<div className="home-catalog-card flex items-end gap-1 rounded-xl border p-2">
							<input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" onChange={(event) => { void addAttachments(event.target.files); event.target.value = ''; }} />
							<button type="button" onClick={() => fileInputRef.current?.click()} disabled={!supportsImages || sending || conversationAttachmentCount + attachments.length >= PUBLIC_CHAT_MAX_ATTACHMENTS} aria-label={t('attachImages')} title={supportsImages ? t('attachImages') : t('imagesUnsupported')} className="home-muted home-hover-text inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg disabled:opacity-30"><PaperClipIcon className="h-4 w-4" /></button>
							<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={2} placeholder={t('prompt')} aria-label={t('promptLabel')} className="home-text min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none" />
							{sending ? <button type="button" onClick={() => abortRef.current?.abort()} aria-label={t('stop')} className="home-action home-action-secondary inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"><StopIcon className="h-4 w-4" /></button> : <button type="button" onClick={() => void send()} disabled={(!prompt.trim() && attachments.length === 0) || !apiKey.trim() || !modelId || (!supportsImages && conversationAttachmentCount > 0)} aria-label={t('send')} className="home-action home-action-primary inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg disabled:opacity-35"><ArrowUpIcon className="h-4 w-4" /></button>}
						</div>
						<p className="home-faint mt-2 text-center text-[10px]">{t('disclaimer')}</p>
					</div>
				</div>
			</section>
		</main>
	);
}
