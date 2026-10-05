import { useMemo } from 'react'
import { PriceSummary } from './CatalogPricing'
import {
	CatalogGeneratedAt,
	CatalogPagination,
	CatalogSelect,
	EmptyCatalog,
	FacetFilters,
	PublicPageHeading,
	PublishedTime,
	QueryStatus,
	RefreshCatalog,
	SearchField,
	TokenCount,
	ValuesList,
} from './PublicPageParts'
import type { PublicCatalogApi } from './catalog-api'
import {
	validateModelCatalogSearch,
	type ModelCatalogSearch,
} from './catalog-search'
import {
	facets,
	filterModels,
	modelHref,
	modelKey,
	modelName,
	paginate,
	toggleFilter,
} from './catalog-view-model'
import { usePublicLocation } from './ssr/public-location'
import {
	publicCatalogApi,
	usePublicModels,
	usePublicText,
} from './use-public-catalog'

export type ModelCatalogPageProps = {
	api?: PublicCatalogApi
	search: ModelCatalogSearch
	onSearchChange: (search: ModelCatalogSearch) => void
}
export function ModelCatalogPage(props: ModelCatalogPageProps) {
	const { text } = usePublicText()
	const { href } = usePublicLocation()
	const query = usePublicModels(props.api ?? publicCatalogApi)
	const data = !query.isError ? query.data : undefined
	const models = useMemo(
		() => filterModels(data?.data ?? [], props.search),
		[data, props.search]
	)
	const page = paginate(models, props.search.page)
	const update = (patch: Partial<ModelCatalogSearch>) =>
		props.onSearchChange(
			validateModelCatalogSearch({ ...props.search, page: 1, ...patch })
		)
	const source = data?.data ?? []
	const groups = [
		{
			label: 'vendor' as const,
			values: facets(source.map((model) => [model.vendor])),
			selected: props.search.vendors,
			onChange: (value: string) =>
				update({ vendors: toggleFilter(props.search.vendors, value) }),
		},
		{
			label: 'inputs' as const,
			values: facets(source.map((model) => model.input_modalities)),
			selected: props.search.inputs,
			onChange: (value: string) =>
				update({ inputs: toggleFilter(props.search.inputs, value) }),
		},
		{
			label: 'outputs' as const,
			values: facets(source.map((model) => model.output_modalities)),
			selected: props.search.outputs,
			onChange: (value: string) =>
				update({ outputs: toggleFilter(props.search.outputs, value) }),
		},
		{
			label: 'protocols' as const,
			values: facets(source.map((model) => model.protocols)),
			selected: props.search.protocols,
			onChange: (value: string) =>
				update({ protocols: toggleFilter(props.search.protocols, value) }),
		},
	]
	return (
		<section className='mx-auto w-full max-w-7xl space-y-7 px-4 py-8 sm:px-6'>
			<PublicPageHeading title='modelsTitle' description='modelsDescription'>
				<RefreshCatalog
					fetching={query.isFetching}
					onClick={() => void query.refetch()}
				/>
			</PublicPageHeading>
			<div className='grid min-w-0 gap-6 lg:grid-cols-[230px_minmax(0,1fr)]'>
				<FacetFilters
					groups={groups}
					onClear={() => props.onSearchChange(validateModelCatalogSearch({}))}
				/>
				<div className='min-w-0 space-y-5'>
					<div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(180px,1fr)_180px_200px_120px]'>
						<SearchField
							value={props.search.q}
							onChange={(q) => update({ q })}
						/>
						<CatalogSelect
							label='context'
							value={props.search.context}
							options={[
								{ value: 'all', label: 'anyContext' },
								{ value: '128k', label: 'context128' },
								{ value: '1m', label: 'context1m' },
							]}
							onChange={(context) =>
								update({
									context: validateModelCatalogSearch({ context }).context,
								})
							}
						/>
						<CatalogSelect
							label='sort'
							value={props.search.sort}
							options={[
								{ value: 'newest', label: 'newest' },
								{ value: 'context', label: 'byContext' },
								{ value: 'price', label: 'byPrice' },
								{ value: 'name', label: 'byName' },
							]}
							onChange={(sort) =>
								update({ sort: validateModelCatalogSearch({ sort }).sort })
							}
						/>
						<CatalogSelect
							label='list'
							value={props.search.view}
							options={[
								{ value: 'list', label: 'list' },
								{ value: 'table', label: 'table' },
							]}
							onChange={(view) =>
								update({ view: validateModelCatalogSearch({ view }).view })
							}
						/>
					</div>
					<QueryStatus
						pending={query.isPending}
						fetching={query.isFetching}
						error={query.error}
						retry={() => void query.refetch()}
					/>
					{data ? (
						<>
							<div className='text-muted-foreground flex flex-wrap justify-between gap-2 text-xs'>
								<p>{text('results', { count: models.length })}</p>
								<CatalogGeneratedAt value={data.generated_at} />
							</div>
							{props.search.sort === 'price' ? (
								<p className='text-muted-foreground text-xs'>
									{text('priceSortNote')}
								</p>
							) : null}
							{models.length === 0 ? (
								<EmptyCatalog filtered={source.length > 0} />
							) : null}
							{models.length > 0 && props.search.view === 'table' ? (
								<div
									role='region'
									aria-label={text('modelsTitle')}
									tabIndex={0}
									className='bg-card max-w-full overflow-x-auto rounded-xl border'
								>
									<table className='w-full min-w-[800px] text-left text-sm'>
										<thead className='bg-muted/50 text-muted-foreground border-b text-xs'>
											<tr>
												{(
													[
														'modelsTitle',
														'context',
														'maxOutput',
														'protocols',
														'catalogPrices',
														'released',
													] as const
												).map((key) => (
													<th key={key} className='p-4 font-medium'>
														{text(key)}
													</th>
												))}
											</tr>
										</thead>
										<tbody>
											{page.rows.map((model) => (
												<tr key={model.id} className='border-b last:border-b-0'>
													<td className='max-w-72 p-4'>
														<a
															className='font-semibold hover:underline'
															href={href(modelHref(model))}
														>
															{modelName(model)}
														</a>
														<p className='text-muted-foreground mt-1 text-xs break-all'>
															{model.id}
														</p>
													</td>
													<td className='p-4'>
														<TokenCount value={model.context_window} />
													</td>
													<td className='p-4'>
														<TokenCount value={model.max_tokens} />
													</td>
													<td className='p-4'>
														<ValuesList values={model.protocols} />
													</td>
													<td className='min-w-52 p-4'>
														<PriceSummary
															profile={model.pricing_profile}
															currency={data.billing_currency}
														/>
													</td>
													<td className='p-4'>
														<PublishedTime value={model.released_at} />
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							) : null}
							{models.length > 0 && props.search.view === 'list' ? (
								<div className='grid min-w-0 gap-4 xl:grid-cols-2'>
									{page.rows.map((model) => (
										<article
											key={model.id}
											className='bg-card min-w-0 space-y-4 rounded-xl border p-5'
										>
											<div>
												<p className='text-muted-foreground mb-2 text-xs break-words'>
													{model.vendor}
												</p>
												<h2 className='text-lg font-semibold break-words'>
													<a
														className='hover:underline'
														href={href(modelHref(model))}
													>
														{modelName(model)}
													</a>
												</h2>
												<p className='text-muted-foreground mt-1 text-xs break-all'>
													{model.id}
												</p>
												<p className='text-muted-foreground mt-3 line-clamp-2 text-sm leading-6'>
													{model.description || text('descriptionUnknown')}
												</p>
											</div>
											<dl className='grid grid-cols-2 gap-x-5 gap-y-3 text-sm'>
												{[
													[
														text('context'),
														<TokenCount value={model.context_window} />,
													],
													[
														text('maxOutput'),
														<TokenCount value={model.max_tokens} />,
													],
													[
														text('inputs'),
														<ValuesList values={model.input_modalities} />,
													],
													[
														text('outputs'),
														<ValuesList values={model.output_modalities} />,
													],
												].map(([label, value]) => (
													<div key={String(label)} className='min-w-0'>
														<dt className='text-muted-foreground mb-1 text-xs'>
															{label}
														</dt>
														<dd>{value}</dd>
													</div>
												))}
											</dl>
											<div className='space-y-2 border-t pt-3'>
												<p className='text-muted-foreground text-xs'>
													{text('catalogPrices')}
												</p>
												<PriceSummary
													profile={model.pricing_profile}
													currency={data.billing_currency}
												/>
											</div>
											<div className='flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs'>
												<ValuesList values={model.protocols} />
												<a
													className='text-primary font-medium hover:underline'
													href={href(
														`/compare?models=${encodeURIComponent(modelKey(model))}`
													)}
												>
													{text('compareTitle')}
												</a>
											</div>
										</article>
									))}
								</div>
							) : null}
							<CatalogPagination
								page={page.page}
								pages={page.pages}
								onChange={(next) => update({ page: next })}
							/>
							<p className='text-muted-foreground text-xs leading-5'>
								{text('priceNote', { currency: data.billing_currency })}
							</p>
						</>
					) : null}
				</div>
			</div>
		</section>
	)
}
