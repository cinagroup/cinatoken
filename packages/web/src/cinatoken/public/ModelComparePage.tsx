import { useMemo, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PricingDetails, PriceSummary } from './CatalogPricing'
import {
	CatalogGeneratedAt,
	EmptyCatalog,
	PublicPageHeading,
	PublishedTime,
	QueryStatus,
	RefreshCatalog,
	SearchField,
	TokenCount,
	ValuesList,
} from './PublicPageParts'
import type { PublicCatalogApi } from './catalog-api'
import type { CatalogModel } from './catalog-contracts'
import { validateCompareSearch, type CompareSearch } from './catalog-search'
import { modelHref, modelKey, modelName } from './catalog-view-model'
import type { PublicMessages } from './messages'
import { usePublicLocation } from './ssr/public-location'
import {
	publicCatalogApi,
	usePublicModels,
	usePublicText,
} from './use-public-catalog'

export type ModelComparePageProps = {
	api?: PublicCatalogApi
	search: CompareSearch
	onSearchChange: (search: CompareSearch) => void
}
export function ModelComparePage(props: ModelComparePageProps) {
	const { text } = usePublicText()
	const { href } = usePublicLocation()
	const query = usePublicModels(props.api ?? publicCatalogApi)
	const [picker, setPicker] = useState('')
	const data = !query.isError ? query.data : undefined
	const byKey = useMemo(
		() => new Map(data?.data.map((model) => [modelKey(model), model]) ?? []),
		[data]
	)
	const selected = props.search.models.flatMap((key) => {
		const model = byKey.get(key)
		return model ? [model] : []
	})
	const missing = props.search.models.filter((key) => !byKey.has(key))
	const choices = (data?.data ?? [])
		.filter(
			(model) =>
				!props.search.models.includes(modelKey(model)) &&
				(!props.search.q ||
					[modelName(model), model.id, model.vendor].some((value) =>
						value.toLowerCase().includes(props.search.q.toLowerCase())
					))
		)
		.slice(0, 100)
	const validPicker = choices.some((model) => modelKey(model) === picker)
	const update = (patch: Partial<CompareSearch>) =>
		props.onSearchChange(validateCompareSearch({ ...props.search, ...patch }))
	const rows: {
		label: keyof PublicMessages
		value: (model: CatalogModel) => ReactNode
	}[] = [
		{ label: 'vendor', value: (model) => model.vendor },
		{
			label: 'modelId',
			value: (model) => <span className='break-all'>{model.id}</span>,
		},
		{
			label: 'context',
			value: (model) => <TokenCount value={model.context_window} />,
		},
		{
			label: 'maxOutput',
			value: (model) => <TokenCount value={model.max_tokens} />,
		},
		{
			label: 'inputs',
			value: (model) => <ValuesList values={model.input_modalities} />,
		},
		{
			label: 'outputs',
			value: (model) => <ValuesList values={model.output_modalities} />,
		},
		{
			label: 'protocols',
			value: (model) => <ValuesList values={model.protocols} />,
		},
		{
			label: 'released',
			value: (model) => <PublishedTime value={model.released_at} />,
		},
		{
			label: 'regions',
			value: (model) => <ValuesList values={model.regions} />,
		},
		{
			label: 'endpointSlugs',
			value: (model) => <ValuesList values={model.endpoint_slugs} />,
		},
		{
			label: 'zdrAvailable',
			value: (model) =>
				text(
					model.data_policy_summary.zdr_available
						? 'zdrAvailable'
						: 'zdrUnavailable'
				),
		},
		{
			label: 'catalogPrices',
			value: (model) => (
				<div className='space-y-3'>
					<PriceSummary
						profile={model.pricing_profile}
						currency={data!.billing_currency}
					/>
					<details>
						<summary className='text-primary cursor-pointer text-xs'>
							{text('details')}
						</summary>
						<div className='mt-4'>
							<PricingDetails
								profile={model.pricing_profile}
								currency={data!.billing_currency}
							/>
						</div>
					</details>
				</div>
			),
		},
	]
	return (
		<section className='mx-auto w-full max-w-7xl space-y-7 px-4 py-8 sm:px-6'>
			<PublicPageHeading title='compareTitle' description='compareDescription'>
				<RefreshCatalog
					fetching={query.isFetching}
					onClick={() => void query.refetch()}
				/>
			</PublicPageHeading>
			<div className='grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]'>
				<SearchField value={props.search.q} onChange={(q) => update({ q })} />
				<div className='min-w-0'>
					<label
						htmlFor='public-compare-model'
						className='mb-1.5 block text-sm font-medium'
					>
						{text('selectModel')}
					</label>
					<select
						id='public-compare-model'
						value={validPicker ? picker : ''}
						onChange={(event) => setPicker(event.target.value)}
						className='border-input bg-background h-9 w-full min-w-0 rounded-lg border px-3 text-sm'
					>
						<option value=''>{text('selectModel')}</option>
						{choices.map((model) => (
							<option key={model.id} value={modelKey(model)}>
								{modelName(model)} · {model.vendor}
							</option>
						))}
					</select>
				</div>
				<Button
					className='sm:self-end'
					disabled={
						!validPicker ||
						props.search.models.includes(picker) ||
						props.search.models.length >= 4 ||
						!data
					}
					onClick={() => {
						update({ models: [...props.search.models, picker] })
						setPicker('')
					}}
				>
					{text('addModel')}
				</Button>
			</div>
			<p className='text-muted-foreground text-xs'>{text('compareLimit')}</p>
			<QueryStatus
				pending={query.isPending}
				fetching={query.isFetching}
				error={query.error}
				retry={() => void query.refetch()}
			/>
			{data ? (
				<>
					{missing.length ? (
						<div
							role='status'
							className='bg-muted space-y-2 rounded-lg border p-4'
						>
							<p className='text-sm'>
								{text('missingModels', { count: missing.length })}
							</p>
							{missing.map((key) => (
								<Button
									key={key}
									variant='outline'
									size='sm'
									onClick={() =>
										update({
											models: props.search.models.filter(
												(item) => item !== key
											),
										})
									}
								>
									{text('removeModel', { name: key })}
								</Button>
							))}
						</div>
					) : null}
					{data.data.length === 0 ? <EmptyCatalog /> : null}
					{data.data.length > 0 && selected.length === 0 ? (
						<p
							role='status'
							className='text-muted-foreground rounded-xl border p-8 text-center'
						>
							{text('compareEmpty')}
						</p>
					) : null}
					{selected.length > 0 ? (
						<div
							role='region'
							aria-label={text('compareTitle')}
							tabIndex={0}
							className='bg-card max-w-full overflow-x-auto rounded-xl border'
						>
							<table className='w-full text-left text-sm'>
								<thead>
									<tr className='border-b'>
										<th className='bg-card sticky left-0 z-10 min-w-36 p-4 align-top font-medium'>
											{text('attribute')}
										</th>
										{selected.map((model) => (
											<th
												key={model.id}
												className='max-w-80 min-w-64 p-4 align-top'
											>
												<div className='flex items-start justify-between gap-2'>
													<a
														href={href(modelHref(model))}
														className='font-semibold break-words hover:underline'
													>
														{modelName(model)}
													</a>
													<Button
														variant='ghost'
														size='icon-xs'
														aria-label={text('removeModel', {
															name: modelName(model),
														})}
														onClick={() =>
															update({
																models: props.search.models.filter(
																	(key) => key !== modelKey(model)
																),
															})
														}
													>
														<X aria-hidden='true' />
													</Button>
												</div>
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{rows.map((row) => (
										<tr key={row.label} className='border-b last:border-b-0'>
											<th className='bg-card text-muted-foreground sticky left-0 z-10 p-4 align-top text-xs font-medium'>
												{text(row.label)}
											</th>
											{selected.map((model) => (
												<td
													key={model.id}
													className='max-w-80 min-w-64 p-4 align-top'
												>
													{row.value(model)}
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}
					<p className='text-muted-foreground text-xs leading-5'>
						{text('privacyNote')}
					</p>
					<CatalogGeneratedAt value={data.generated_at} />
				</>
			) : null}
		</section>
	)
}
