'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

type DemoId = 'chat' | 'responses' | 'images' | 'tools';

type DemoLine = {
	text: string;
	tone?: 'accent' | 'key' | 'string' | 'muted';
};

type DemoConfig = {
	id: DemoId;
	endpoint: string;
	request: DemoLine[];
	response: DemoLine[];
};

const DEMOS: DemoConfig[] = [
	{
		id: 'chat',
		endpoint: '/v1/chat/completions',
		request: [
			{ text: '{', tone: 'muted' },
			{ text: '  "model": "your-model",', tone: 'key' },
			{ text: '  "messages": [', tone: 'key' },
			{ text: '    { "role": "user", "content": "Hello" }', tone: 'string' },
			{ text: '  ]', tone: 'muted' },
			{ text: '}', tone: 'muted' },
		],
		response: [
			{ text: '{ "object": "chat.completion",', tone: 'muted' },
			{ text: '  "choices": [{ "message": { "content": "..." } }]', tone: 'accent' },
			{ text: '}', tone: 'muted' },
		],
	},
	{
		id: 'responses',
		endpoint: '/v1/responses',
		request: [
			{ text: '{', tone: 'muted' },
			{ text: '  "model": "your-model",', tone: 'key' },
			{ text: '  "input": "Summarize this document"', tone: 'string' },
			{ text: '}', tone: 'muted' },
		],
		response: [
			{ text: '{ "object": "response",', tone: 'muted' },
			{ text: '  "output": [{ "type": "output_text", "text": "..." }]', tone: 'accent' },
			{ text: '}', tone: 'muted' },
		],
	},
	{
		id: 'images',
		endpoint: '/v1/images/generations',
		request: [
			{ text: '{', tone: 'muted' },
			{ text: '  "model": "your-image-model",', tone: 'key' },
			{ text: '  "prompt": "A calm cyan horizon"', tone: 'string' },
			{ text: '}', tone: 'muted' },
		],
		response: [
			{ text: '{', tone: 'muted' },
			{ text: '  "data": [{ "url": "https://..." }]', tone: 'accent' },
			{ text: '}', tone: 'muted' },
		],
	},
	{
		id: 'tools',
		endpoint: '/v1/tools/web-search',
		request: [
			{ text: '{', tone: 'muted' },
			{ text: '  "query": "latest AI gateway patterns",', tone: 'string' },
			{ text: '  "limit": 5', tone: 'key' },
			{ text: '}', tone: 'muted' },
		],
		response: [
			{ text: '{', tone: 'muted' },
			{ text: '  "results": [{ "title": "...", "url": "..." }]', tone: 'accent' },
			{ text: '}', tone: 'muted' },
		],
	},
];

const TONE_CLASS: Record<NonNullable<DemoLine['tone']>, string> = {
	accent: 'text-emerald-300',
	key: 'text-sky-300',
	string: 'text-amber-200',
	muted: 'text-slate-300',
};

function CodeBlock({ lines }: { lines: DemoLine[] }) {
	return (
		<pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-6 sm:text-xs">
			{lines.map((line, index) => (
				<span key={`${index}-${line.text}`} className={`block ${TONE_CLASS[line.tone ?? 'muted']}`}>
					{line.text}
				</span>
			))}
		</pre>
	);
}

export default function GatewayDemo() {
	const t = useTranslations('home.demo');
	const [activeId, setActiveId] = useState<DemoId>('chat');
	const activeDemo = DEMOS.find((demo) => demo.id === activeId) ?? DEMOS[0];

	return (
		<div className="w-full overflow-hidden rounded-2xl border border-zinc-700 bg-black shadow-[0_30px_100px_-55px_rgba(14,165,233,0.45)]">
			<div className="flex items-center gap-1 overflow-x-auto border-b border-white/10 px-3 sm:px-5" role="tablist" aria-label={t('tabsLabel')}>
				{DEMOS.map((demo) => {
					const selected = demo.id === activeId;
					return (
						<button
							key={demo.id}
							type="button"
							role="tab"
							aria-selected={selected}
							onClick={() => setActiveId(demo.id)}
							className={`relative shrink-0 px-3 py-4 text-xs font-medium transition-colors sm:px-4 ${selected ? 'text-white' : 'text-zinc-500 hover:text-zinc-200'}`}
						>
							{t(demo.id)}
							{selected ? <span className="absolute inset-x-2 bottom-0 h-px bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.9)]" /> : null}
						</button>
					);
				})}
				<div className="ml-auto hidden items-center gap-2 pl-5 sm:flex">
					<span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]" />
					<span className="font-mono text-[10px] tracking-[0.12em] text-zinc-500">200 OK</span>
				</div>
			</div>

			<div className="flex items-center gap-3 border-b border-white/10 px-5 py-3.5">
				<span className="font-mono text-[10px] font-medium tracking-[0.12em] text-sky-400">POST</span>
				<code className="truncate font-mono text-[11px] text-zinc-400 sm:text-xs">https://api.cinatoken.com{activeDemo.endpoint}</code>
			</div>

			<div className="grid min-h-[310px] font-mono md:grid-cols-2">
				<div className="border-b border-white/10 px-5 py-5 sm:px-6 md:border-b-0 md:border-r">
					<p className="mb-3 font-sans text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">{t('request')}</p>
					<div className="mb-2 text-[11px] text-zinc-500 sm:text-xs">
						<span className="text-cyan-300">curl</span> -X POST {activeDemo.endpoint}
					</div>
					<CodeBlock lines={activeDemo.request} />
				</div>
				<div className="bg-white/[0.018] px-5 py-5 sm:px-6">
					<div className="mb-3 flex items-center justify-between">
						<p className="font-sans text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">{t('response')}</p>
						<span className="font-mono text-[10px] text-emerald-300 sm:hidden">200 OK</span>
					</div>
					<CodeBlock lines={activeDemo.response} />
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-t border-white/10 px-5 py-3 font-mono text-[10px] text-zinc-600 sm:px-6">
				<span className="text-emerald-400">200 OK</span>
				<span>238 ms</span>
				<span>cinatoken · {t('routeStable')}</span>
			</div>
		</div>
	);
}
