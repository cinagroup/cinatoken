'use client';

import { ArrowUpIcon, KeyIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { PublicCatalogResult } from '@/lib/public-catalog';
import { parsePublicChatResponseError, parsePublicChatResponseText } from '@/lib/public-chat';

type Message = { role: 'user' | 'assistant'; content: string };

export default function PublicChatPage({ catalog }: { catalog: PublicCatalogResult }) {
	const t = useTranslations('publicChat');
	const models = useMemo(() => catalog.models.filter((model) => model.protocols.includes('openai') && model.outputModalities.includes('text')), [catalog.models]);
	const [modelId, setModelId] = useState(models[0]?.id ?? '');
	const [apiKey, setApiKey] = useState('');
	const [prompt, setPrompt] = useState('');
	const [messages, setMessages] = useState<Message[]>([]);
	const [error, setError] = useState('');
	const [sending, setSending] = useState(false);

	const send = async () => {
		const content = prompt.trim();
		if (!content || !apiKey.trim() || !modelId || sending) return;
		const nextMessages = [...messages, { role: 'user' as const, content }];
		setMessages(nextMessages); setPrompt(''); setError(''); setSending(true);
		try {
			const response = await fetch('/api/public/chat', {
				method: 'POST',
				headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json' },
				body: JSON.stringify({ model: modelId, messages: nextMessages, stream: false }),
			});
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok) throw new Error(parsePublicChatResponseError(body) ?? t('requestFailed', { status: response.status }));
			const assistant = parsePublicChatResponseText(body);
			if (!assistant) throw new Error(t('invalidResponse'));
			setMessages([...nextMessages, { role: 'assistant', content: assistant }]);
		} catch (cause) { setError(cause instanceof Error ? cause.message : t('networkError')); }
		finally { setSending(false); }
	};

	return <main className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-[1440px] lg:grid-cols-[270px_minmax(0,1fr)]"><aside className="home-border border-b p-4 lg:border-b-0 lg:border-r lg:p-5"><div className="flex items-center justify-between"><h1 className="home-text text-lg font-semibold">{t('title')}</h1><button type="button" onClick={() => { setMessages([]); setError(''); }} className="home-muted home-hover-text rounded-md p-2" aria-label={t('newChat')}><PlusIcon className="h-4 w-4" /></button></div><p className="home-muted mt-2 text-xs leading-5">{t('description')}</p><label className="home-faint mt-6 block text-xs font-medium">{t('model')}</label><select value={modelId} onChange={(event) => setModelId(event.target.value)} className="home-catalog-control home-text mt-2 h-10 w-full rounded-lg border px-3 text-sm">{models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select><label className="home-faint mt-5 block text-xs font-medium">{t('apiKey')}</label><div className="relative mt-2"><KeyIcon className="home-faint pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" /><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" className="home-catalog-control home-text h-10 w-full rounded-lg border pl-9 pr-3 text-sm" /></div><p className="home-faint mt-2 text-[11px] leading-4">{t('keySafety')}</p><Link href="/account/settings" className="home-muted home-hover-text mt-3 inline-flex text-xs underline underline-offset-4">{t('getKey')}</Link>{messages.length ? <button type="button" onClick={() => setMessages([])} className="home-muted home-hover-text mt-8 flex items-center gap-2 text-xs"><TrashIcon className="h-4 w-4" />{t('clear')}</button> : null}</aside>
		<section className="flex min-h-[620px] min-w-0 flex-col"><div className="flex-1 overflow-y-auto px-4 py-8 sm:px-8"><div className="mx-auto max-w-3xl">{messages.length === 0 ? <div className="py-20 text-center"><h2 className="home-text text-2xl font-semibold tracking-[-0.03em]">{t('emptyTitle')}</h2><p className="home-muted mx-auto mt-3 max-w-lg text-sm leading-6">{catalog.status === 'unavailable' ? t('catalogUnavailable') : models.length === 0 ? t('noModels') : t('emptyDescription')}</p></div> : <div className="space-y-6">{messages.map((message, index) => <article key={`${message.role}-${index}`} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === 'user' ? 'bg-[var(--home-text)] text-[var(--home-bg)]' : 'home-catalog-card home-text border'}`}>{message.content}</div></article>)}{sending ? <p className="home-muted text-sm">{t('thinking')}</p> : null}</div>}{error ? <div role="alert" className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">{error}</div> : null}</div></div>
			<div className="home-border sticky bottom-0 border-t bg-[var(--home-bg)] px-4 py-4 sm:px-8"><div className="home-catalog-card mx-auto flex max-w-3xl items-end gap-2 rounded-xl border p-2"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} rows={2} placeholder={t('prompt')} aria-label={t('promptLabel')} className="home-text min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none" /><button type="button" onClick={send} disabled={!prompt.trim() || !apiKey.trim() || !modelId || sending} aria-label={t('send')} className="home-action home-action-primary inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg disabled:opacity-35"><ArrowUpIcon className="h-4 w-4" /></button></div><p className="home-faint mx-auto mt-2 max-w-3xl text-center text-[10px]">{t('disclaimer')}</p></div>
		</section></main>;
}
