import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { CatalogModel } from './catalog-contracts'
import { buildCatalogExample } from './code-examples'
import { usePublicText } from './use-public-catalog'

export function ApiExample(props: { model: CatalogModel; apiOrigin?: string }) {
	const { text } = usePublicText()
	const [chosen, setChosen] = useState(props.model.recommended_protocol)
	const [notice, setNotice] = useState<'copied' | 'copyFailed' | null>(null)
	const protocol = props.model.protocols.includes(chosen)
		? chosen
		: props.model.recommended_protocol
	const code = buildCatalogExample(
		props.model,
		protocol,
		props.apiOrigin,
		text('examplePrompt')
	)
	if (!code) return null
	async function copy() {
		setNotice(null)
		try {
			await navigator.clipboard.writeText(code!)
			setNotice('copied')
		} catch {
			setNotice('copyFailed')
		}
	}
	return (
		<section className='min-w-0 space-y-4 rounded-xl border p-5'>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<h2 className='text-lg font-semibold'>{text('example')}</h2>
				<Button variant='outline' onClick={() => void copy()}>
					{text('copy')}
				</Button>
			</div>
			<div className='flex flex-wrap gap-2'>
				{props.model.protocols.map((value) => (
					<Button
						key={value}
						variant={protocol === value ? 'secondary' : 'outline'}
						aria-pressed={protocol === value}
						onClick={() => {
							setChosen(value)
							setNotice(null)
						}}
					>
						{value}
					</Button>
				))}
			</div>
			<pre className='bg-muted max-w-full overflow-x-auto rounded-lg p-4 text-xs leading-6'>
				<code>{code}</code>
			</pre>
			{notice ? (
				<p role='status' className='text-muted-foreground text-xs'>
					{text(notice)}
				</p>
			) : null}
		</section>
	)
}
