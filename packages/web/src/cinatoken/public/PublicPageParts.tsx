import { useId, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { PublicMessages } from './messages'
import { usePublicLocation } from './ssr/public-location'
import { catalogErrorKey, usePublicText } from './use-public-catalog'

const publicLinks = [
	['/models', 'modelsTitle'],
	['/providers', 'providersTitle'],
	['/compare', 'compareTitle'],
	['/rankings', 'rankingsTitle'],
	['/benchmarks', 'benchmarksTitle'],
] as const
export function PublicPageHeading(props: {
	title: keyof PublicMessages
	description: keyof PublicMessages
	heading?: string
	children?: ReactNode
}) {
	const { text } = usePublicText()
	const { href } = usePublicLocation()
	return (
		<header className='space-y-4'>
			<nav
				aria-label={text('publicNavigation')}
				className='text-muted-foreground flex flex-wrap gap-x-5 gap-y-2 text-sm'
			>
				{publicLinks.map(([path, label]) => (
					<a
						key={path}
						href={href(path)}
						className='hover:text-foreground focus-visible:outline-ring rounded-sm underline-offset-4 hover:underline'
					>
						{text(label)}
					</a>
				))}
			</nav>
			<div className='flex flex-wrap items-start justify-between gap-4'>
				<div className='max-w-3xl min-w-0'>
					<h1 className='text-3xl font-semibold tracking-tight sm:text-4xl'>
						{props.heading ?? text(props.title)}
					</h1>
					<p className='text-muted-foreground mt-3 text-sm leading-6'>
						{text(props.description)}
					</p>
				</div>
				{props.children}
			</div>
		</header>
	)
}
export function QueryStatus(props: {
	pending: boolean
	fetching: boolean
	error: unknown
	retry: () => void
}) {
	const { text } = usePublicText()
	if (props.pending)
		return (
			<div role='status' className='space-y-3'>
				<p className='text-muted-foreground text-sm'>{text('loading')}</p>
				<Skeleton className='h-28' />
				<Skeleton className='h-48' />
			</div>
		)
	if (!props.error) return null
	return (
		<Alert variant='destructive'>
			<AlertDescription className='flex flex-wrap items-center justify-between gap-3'>
				<span>{text(catalogErrorKey(props.error))}</span>
				<Button
					variant='outline'
					disabled={props.fetching}
					onClick={props.retry}
				>
					{text('retry')}
				</Button>
			</AlertDescription>
		</Alert>
	)
}
export function RefreshCatalog(props: {
	fetching: boolean
	onClick: () => void
}) {
	const { text } = usePublicText()
	return (
		<Button variant='outline' disabled={props.fetching} onClick={props.onClick}>
			<RefreshCw
				aria-hidden='true'
				className={props.fetching ? 'animate-spin' : ''}
			/>
			{text('refresh')}
		</Button>
	)
}
export function SearchField(props: {
	value: string
	onChange: (value: string) => void
}) {
	const { text } = usePublicText()
	const id = useId()
	return (
		<div className='min-w-0 flex-1'>
			<label htmlFor={id} className='mb-1.5 block text-sm font-medium'>
				{text('search')}
			</label>
			<Input
				id={id}
				type='search'
				value={props.value}
				maxLength={500}
				onChange={(event) => props.onChange(event.target.value)}
			/>
		</div>
	)
}
export function CatalogSelect(props: {
	label: keyof PublicMessages
	value: string
	options: readonly { value: string; label: keyof PublicMessages }[]
	onChange: (value: string) => void
}) {
	const { text } = usePublicText()
	const id = useId()
	return (
		<div className='min-w-0'>
			<label htmlFor={id} className='mb-1.5 block text-sm font-medium'>
				{text(props.label)}
			</label>
			<select
				id={id}
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
				className='border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full min-w-0 rounded-lg border px-3 text-sm outline-none focus-visible:ring-3'
			>
				{props.options.map((option) => (
					<option key={option.value} value={option.value}>
						{text(option.label)}
					</option>
				))}
			</select>
		</div>
	)
}
const translatedValues = new Set([
	'text',
	'image',
	'audio',
	'video',
	'file',
	'embeddings',
	'speech',
	'transcription',
	'rerank',
])
export function ValuesList(props: { values: readonly string[] | null }) {
	const { text } = usePublicText()
	if (!props.values?.length)
		return <span className='text-muted-foreground'>{text('unknown')}</span>
	return (
		<span className='break-words'>
			{props.values
				.map((value) =>
					translatedValues.has(value)
						? text(value as keyof PublicMessages)
						: value
				)
				.join(', ')}
		</span>
	)
}
export function FacetFilters(props: {
	groups: readonly {
		label: keyof PublicMessages
		values: readonly string[]
		selected: readonly string[]
		onChange: (value: string) => void
	}[]
	onClear: () => void
}) {
	const { text } = usePublicText()
	return (
		<aside className='bg-card h-fit space-y-4 rounded-xl border p-4'>
			<div className='flex flex-wrap items-center justify-between gap-2'>
				<h2 className='text-sm font-semibold'>{text('filters')}</h2>
				<Button size='xs' variant='ghost' onClick={props.onClear}>
					{text('clear')}
				</Button>
			</div>
			{props.groups.map((group) => (
				<details key={group.label} className='group border-t pt-3'>
					<summary className='cursor-pointer text-sm font-medium'>
						{text(group.label)}
						{group.selected.length > 0 ? ` (${group.selected.length})` : ''}
					</summary>
					<fieldset className='mt-3 max-h-48 space-y-2 overflow-y-auto'>
						<legend className='sr-only'>{text(group.label)}</legend>
						{[...new Set([...group.selected, ...group.values])].map((value) => (
							<label
								key={value}
								className='flex min-w-0 items-start gap-2 text-sm'
							>
								<input
									type='checkbox'
									checked={group.selected.includes(value)}
									onChange={() => group.onChange(value)}
									className='accent-primary mt-0.5 size-4 shrink-0'
								/>
								<span className='min-w-0 break-words'>
									<ValuesList values={[value]} />
								</span>
							</label>
						))}
					</fieldset>
				</details>
			))}
		</aside>
	)
}
export function EmptyCatalog(props: { filtered?: boolean; stats?: boolean }) {
	const { text } = usePublicText()
	let key: keyof PublicMessages = 'empty'
	if (props.filtered) key = 'noMatches'
	if (props.stats) key = 'statsEmpty'
	return (
		<p
			role='status'
			className='text-muted-foreground bg-card rounded-xl border p-8 text-center text-sm'
		>
			{text(key)}
		</p>
	)
}
export function CatalogPagination(props: {
	page: number
	pages: number
	onChange: (page: number) => void
}) {
	const { text } = usePublicText()
	return (
		<nav
			aria-label={text('page', { page: props.page, pages: props.pages })}
			className='flex flex-wrap items-center justify-between gap-3'
		>
			<span className='text-muted-foreground text-sm'>
				{text('page', { page: props.page, pages: props.pages })}
			</span>
			<div className='flex gap-2'>
				<Button
					variant='outline'
					disabled={props.page <= 1}
					onClick={() => props.onChange(props.page - 1)}
				>
					{text('previous')}
				</Button>
				<Button
					variant='outline'
					disabled={props.page >= props.pages}
					onClick={() => props.onChange(props.page + 1)}
				>
					{text('next')}
				</Button>
			</div>
		</nav>
	)
}
export function TokenCount(props: { value: number | null }) {
	const { text, locale } = usePublicText()
	return (
		<span className='tabular-nums'>
			{props.value === null
				? text('unknown')
				: new Intl.NumberFormat(locale, {
						notation: 'compact',
						maximumFractionDigits: 1,
					}).format(props.value)}
		</span>
	)
}
export function PublishedTime(props: { value: string | null }) {
	const { text, locale } = usePublicText()
	if (!props.value || !Number.isFinite(Date.parse(props.value)))
		return <span>{text('unknown')}</span>
	return (
		<time dateTime={props.value}>
			{new Intl.DateTimeFormat(locale, {
				dateStyle: 'medium',
				timeZone: 'UTC',
			}).format(new Date(props.value))}
		</time>
	)
}
export function CatalogGeneratedAt(props: { value: string }) {
	const { text } = usePublicText()
	return (
		<p className='text-muted-foreground text-xs'>
			{text('updated', { time: props.value })}
		</p>
	)
}
