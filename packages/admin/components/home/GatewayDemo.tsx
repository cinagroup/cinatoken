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
	const [activeId, setActiveId] = useState<DemoId>('responses');
	const activeDemo = DEMOS.find((demo) => demo.id === activeId) ?? DEMOS[1];

	return (
		<div className="w-full overflow-hidden rounded-2xl border border-slate-700/80 bg-[#101923] shadow-[0_28px_70px_-36px_rgba(15,23,42,0.7)]">
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
							className={`relative shrink-0 px-3 py-4 text-xs font-semibold tracking-wide transition-colors sm:px-4 ${selected ? 'text-cyan-300' : 'text-slate-400 hover:text-slate-200'}`}
						>
							{t(demo.id)}
							{selected ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-cyan-400" /> : null}
						</button>
					);
				})}
				<div className="ml-auto hidden items-center gap-2 pl-4 sm:flex">
					<span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]" />
					<span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">200 OK</span>
				</div>
			</div>

			<div className="flex items-center gap-3 border-b border-white/10 px-5 py-3.5">
				<span className="rounded-md bg-cyan-400/10 px-2 py-1 font-mono text-[10px] font-bold tracking-wide text-cyan-300">POST</span>
				<code className="truncate font-mono text-xs text-slate-200 sm:text-sm">{activeDemo.endpoint}</code>
			</div>

			<div className="grid min-h-[430px] grid-rows-2 font-mono">
				<div className="px-5 py-5 sm:px-6">
					<p className="mb-3 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">{t('request')}</p>
					<div className="mb-2 text-[11px] text-slate-400 sm:text-xs">
						<span className="text-cyan-300">curl</span> -X POST {activeDemo.endpoint}
					</div>
					<CodeBlock lines={activeDemo.request} />
				</div>
				<div className="border-t border-white/10 bg-white/[0.025] px-5 py-5 sm:px-6">
					<div className="mb-3 flex items-center justify-between">
						<p className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">{t('response')}</p>
						<span className="font-mono text-[10px] text-emerald-300 sm:hidden">200 OK</span>
					</div>
					<CodeBlock lines={activeDemo.response} />
				</div>
			</div>
		</div>
	);
}
