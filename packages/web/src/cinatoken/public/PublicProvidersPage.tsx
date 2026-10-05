import { useMemo } from 'react'
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
	ValuesList,
} from './PublicPageParts'
import type { PublicCatalogApi } from './catalog-api'
import { validateProvidersSearch, type ProvidersSearch } from './catalog-search'
import {
	facets,
	filterProviders,
	paginate,
	toggleFilter,
} from './catalog-view-model'
import { usePublicLocation } from './ssr/public-location'
import {
	publicCatalogApi,
	usePublicProviders,
	usePublicText,
} from './use-public-catalog'

export type PublicProvidersPageProps = {
	api?: PublicCatalogApi
	search: ProvidersSearch
	onSearchChange: (search: ProvidersSearch) => void
}
export function PublicProvidersPage(props: PublicProvidersPageProps) {
	const { text } = usePublicText()
	const { href } = usePublicLocation()
	const query = usePublicProviders(props.api ?? publicCatalogApi)
	const data = !query.isError ? query.data : undefined
	const providers = useMemo(
		() => filterProviders(data?.data ?? [], props.search),
		[data, props.search]
	)
	const page = paginate(providers, props.search.page)
	const update = (patch: Partial<ProvidersSearch>) =>
		props.onSearchChange(
			validateProvidersSearch({ ...props.search, page: 1, ...patch })
		)
	const source = data?.data ?? []
	const groups = [
		{
			label: 'protocols' as const,
			values: facets(source.map((provider) => provider.protocols)),
			selected: props.search.protocols,
			onChange: (value: string) =>
				update({ protocols: toggleFilter(props.search.protocols, value) }),
		},
		{
			label: 'inputs' as const,
			values: facets(source.map((provider) => provider.input_modalities)),
			selected: props.search.inputs,
			onChange: (value: string) =>
				update({ inputs: toggleFilter(props.search.inputs, value) }),
		},
		{
			label: 'outputs' as const,
			values: facets(source.map((provider) => provider.output_modalities)),
			selected: props.search.outputs,
			onChange: (value: string) =>
				update({ outputs: toggleFilter(props.search.outputs, value) }),
		},
	]
	return (
		<section className='mx-auto w-full max-w-7xl space-y-7 px-4 py-8 sm:px-6'>
			<PublicPageHeading
				title='providersTitle'
				description='providersDescription'
			>
				<RefreshCatalog
					fetching={query.isFetching}
					onClick={() => void query.refetch()}
				/>
			</PublicPageHeading>
			<div className='grid min-w-0 gap-6 lg:grid-cols-[230px_minmax(0,1fr)]'>
				<FacetFilters
					groups={groups}
					onClear={() => props.onSearchChange(validateProvidersSearch({}))}
				/>
				<div className='min-w-0 space-y-5'>
					<div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]'>
						<SearchField
							value={props.search.q}
							onChange={(q) => update({ q })}
						/>
						<CatalogSelect
							label='sort'
							value={props.search.sort}
							options={[
								{ value: 'models', label: 'byModels' },
								{ value: 'newest', label: 'newest' },
								{ value: 'name', label: 'byName' },
							]}
							onChange={(sort) =>
								update({ sort: validateProvidersSearch({ sort }).sort })
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
								<p>{text('results', { count: providers.length })}</p>
								<CatalogGeneratedAt value={data.generated_at} />
							</div>
							{providers.length === 0 ? (
								<EmptyCatalog filtered={source.length > 0} />
							) : (
								<div className='grid gap-4 xl:grid-cols-2'>
									{page.rows.map((provider) => (
										<article
											key={provider.id}
											className='bg-card min-w-0 space-y-4 rounded-xl border p-5'
										>
											<div className='flex flex-wrap items-start justify-between gap-3'>
												<h2 className='text-xl font-semibold break-words'>
													{provider.display_name}
												</h2>
												<span className='text-muted-foreground text-xs'>
													{text('modelCount', { count: provider.model_count })}
												</span>
											</div>
											<dl className='space-y-3 text-sm'>
												{[
													['protocols', provider.protocols],
													['inputs', provider.input_modalities],
													['outputs', provider.output_modalities],
													['routeGroups', provider.route_groups],
												].map(([label, values]) => (
													<div key={String(label)}>
														<dt className='text-muted-foreground mb-1 text-xs'>
															{text(label as 'protocols')}
														</dt>
														<dd>
															<ValuesList values={values as string[]} />
														</dd>
													</div>
												))}
												<div>
													<dt className='text-muted-foreground mb-1 text-xs'>
														{text('released')}
													</dt>
													<dd>
														<PublishedTime
															value={provider.latest_released_at}
														/>
													</dd>
												</div>
											</dl>
											<a
												className='text-primary inline-block text-sm font-medium hover:underline'
												href={href(
													`/models?vendors=${encodeURIComponent(JSON.stringify([provider.display_name]))}`
												)}
											>
												{text('browseProvider')}
											</a>
										</article>
									))}
								</div>
							)}
							<CatalogPagination
								page={page.page}
								pages={page.pages}
								onChange={(next) => update({ page: next })}
							/>
						</>
					) : null}
				</div>
			</div>
		</section>
	)
}
