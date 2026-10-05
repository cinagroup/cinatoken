/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const examples = [
	{
		id: 'chat',
		endpoint: '/v1/chat/completions',
		request: {
			model: 'your-model',
			messages: [{ role: 'user', content: 'Hello' }],
		},
		response: {
			object: 'chat.completion',
			choices: [{ message: { content: '...' } }],
		},
	},
	{
		id: 'responses',
		endpoint: '/v1/responses',
		request: { model: 'your-model', input: '...' },
		response: {
			object: 'response',
			output: [{ type: 'output_text', text: '...' }],
		},
	},
	{
		id: 'images',
		endpoint: '/v1/images/generations',
		request: { model: 'your-image-model', prompt: '...' },
		response: { data: [{ url: 'https://...' }] },
	},
	{
		id: 'tools',
		endpoint: '/v1/tools/web-search',
		request: { query: '...', limit: 5 },
		response: { results: [{ title: '...', url: 'https://...' }] },
	},
] as const

export function HomeGatewayDemo() {
	const { t } = useTranslation()
	const [active, setActive] = useState(0)
	const tabs = useRef<Array<HTMLButtonElement | null>>([])
	const id = useId()
	const example = examples[active]!
	const request =
		example.id === 'chat'
			? {
					...example.request,
					messages: [
						{ role: 'user', content: t('cinatoken.public.examplePrompt') },
					],
				}
			: example.request
	function select(index: number) {
		const next = (index + examples.length) % examples.length
		setActive(next)
		tabs.current[next]?.focus()
	}
	return (
		<section className='bg-card mt-10 min-w-0 overflow-hidden rounded-2xl border'>
			<div
				role='tablist'
				aria-label={t('cinatoken.home.demo.tabsLabel')}
				className='bg-muted/40 flex gap-1 overflow-x-auto border-b px-3'
			>
				{examples.map((item, index) => (
					<button
						key={item.id}
						ref={(element) => {
							tabs.current[index] = element
						}}
						type='button'
						role='tab'
						id={`${id}-tab-${item.id}`}
						aria-controls={`${id}-panel`}
						aria-selected={active === index}
						tabIndex={active === index ? 0 : -1}
						className='hover:bg-muted focus-visible:ring-ring rounded-sm px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 aria-selected:underline aria-selected:underline-offset-8'
						onClick={() => setActive(index)}
						onKeyDown={(event) => {
							if (event.key === 'ArrowRight') {
								event.preventDefault()
								select(index + 1)
							}
							if (event.key === 'ArrowLeft') {
								event.preventDefault()
								select(index - 1)
							}
							if (event.key === 'Home') {
								event.preventDefault()
								select(0)
							}
							if (event.key === 'End') {
								event.preventDefault()
								select(examples.length - 1)
							}
						}}
					>
						{t(`cinatoken.home.demo.${item.id}`)}
					</button>
				))}
			</div>
			<div
				id={`${id}-panel`}
				role='tabpanel'
				aria-labelledby={`${id}-tab-${example.id}`}
				tabIndex={0}
				className='min-w-0 outline-none'
			>
				<p className='min-w-0 overflow-x-auto border-b p-4 font-mono text-xs'>
					POST https://api.cinatoken.com{example.endpoint}
				</p>
				<div className='grid min-w-0 md:grid-cols-2'>
					<div className='min-w-0 space-y-3 border-b p-5 md:border-r md:border-b-0'>
						<h2 className='text-muted-foreground text-xs font-semibold uppercase'>
							{t('cinatoken.home.demo.request')}
						</h2>
						<pre className='max-w-full overflow-x-auto text-xs leading-6'>
							<code>{JSON.stringify(request, null, 2)}</code>
						</pre>
					</div>
					<div className='min-w-0 space-y-3 p-5'>
						<h2 className='text-muted-foreground text-xs font-semibold uppercase'>
							{t('cinatoken.home.demo.response')}
						</h2>
						<pre className='max-w-full overflow-x-auto text-xs leading-6'>
							<code>{JSON.stringify(example.response, null, 2)}</code>
						</pre>
					</div>
				</div>
			</div>
			<p className='text-muted-foreground border-t px-5 py-3 text-xs leading-5'>
				{t('cinatoken.home.demo.illustration')}
			</p>
		</section>
	)
}
