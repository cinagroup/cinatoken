import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import {
	CatalogGeneratedAt,
	CatalogPagination,
	CatalogSelect,
	EmptyCatalog,
	PublicPageHeading,
	QueryStatus,
	RefreshCatalog,
	SearchField,
} from './PublicPageParts'
import type { PublicCatalogApi } from './catalog-api'
import { validateStatsSearch, type StatsSearch } from './catalog-search'
import {
	modelHref,
	paginate,
	PAGE_SIZE,
	sortStats,
	validateBenchmarkSearch,
} from './catalog-view-model'
import { usePublicLocation } from './ssr/public-location'
import {
	publicCatalogApi,
	usePublicStats,
	usePublicText,
} from './use-public-catalog'

export type PublicStatsPageProps = {
	api?: PublicCatalogApi
	search: StatsSearch
	onSearchChange: (search: StatsSearch) => void
}
export function PublicStatsPage(
	props: PublicStatsPageProps & { mode: 'rankings' | 'benchmarks' }
) {
	const { text, locale } = usePublicText()
	const { href } = usePublicLocation()
	const query = usePublicStats(
		props.api ?? publicCatalogApi,
		props.search.range
	)
	const data = !query.isError ? query.data : undefined
	const rows = useMemo(
		() => sortStats(data?.data ?? [], props.search),
		[data, props.search]
	)
	const page = paginate(rows, props.search.page)
	const validateSearch =
		props.mode === 'benchmarks' ? validateBenchmarkSearch : validateStatsSearch
	const update = (patch: Partial<StatsSearch>) =>
		props.onSearchChange(validateSearch({ ...props.search, page: 1, ...patch }))
	const number = (value: number) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)
	const title = props.mode === 'rankings' ? 'rankingsTitle' : 'benchmarksTitle'
	return (
		<section className='mx-auto w-full max-w-7xl space-y-7 px-4 py-8 sm:px-6'>
			<PublicPageHeading
				title={title}
				description={
					props.mode === 'rankings'
						? 'rankingsDescription'
						: 'benchmarksDescription'
				}
			>
				<RefreshCatalog
					fetching={query.isFetching}
					onClick={() => void query.refetch()}
				/>
			</PublicPageHeading>
			<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_160px_200px_auto]'>
				<SearchField value={props.search.q} onChange={(q) => update({ q })} />
				<CatalogSelect
					label='range'
					value={props.search.range}
					options={[
						{ value: '7d', label: 'range7' },
						{ value: '30d', label: 'range30' },
						{ value: '90d', label: 'range90' },
					]}
					onChange={(range) =>
						update({ range: validateStatsSearch({ range }).range })
					}
				/>
				<CatalogSelect
					label='sort'
					value={props.search.metric}
					options={[
						{ value: 'popular', label: 'popular' },
						{ value: 'reliable', label: 'reliable' },
						{ value: 'latency', label: 'latency' },
					]}
					onChange={(metric) =>
						update({ metric: validateStatsSearch({ metric }).metric })
					}
				/>
				<Button
					variant='outline'
					className='lg:self-end'
					onClick={() =>
						props.onSearchChange(validateSearch({ range: props.search.range }))
					}
				>
					{text('clear')}
				</Button>
			</div>
			<QueryStatus
				pending={query.isPending}
				fetching={query.isFetching}
				error={query.error}
				retry={() => void query.refetch()}
			/>
			{data ? (
				<>
					<div className='bg-muted/40 space-y-2 rounded-xl border p-4 text-xs leading-5'>
						<p>{text('sampleNote', { count: data.minimum_sample_size })}</p>
						<p className='text-muted-foreground break-words'>
							{text('window', {
								start: data.window_start,
								end: data.window_end,
							})}
						</p>
						<p className='text-muted-foreground'>{text('observedNote')}</p>
					</div>
					{rows.length === 0 ? (
						<EmptyCatalog
							stats={data.data.length === 0}
							filtered={data.data.length > 0}
						/>
					) : (
						<>
							<div
								role='region'
								aria-label={text(title)}
								tabIndex={0}
								className='bg-card hidden max-w-full overflow-x-auto rounded-xl border sm:block'
							>
								<table className='w-full min-w-[900px] text-left text-sm'>
									<thead className='bg-muted/50 text-muted-foreground border-b text-xs'>
										<tr>
											{[
												'#',
												text('modelsTitle'),
												text('requests'),
												text('successRate'),
												text('averageLatency'),
												text('outputTokens'),
												text('totalTokens'),
											].map((label) => (
												<th key={label} className='p-4 font-medium'>
													{label}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{page.rows.map((row, index) => (
											<tr key={row.id} className='border-b last:border-b-0'>
												<td className='text-muted-foreground p-4'>
													{(page.page - 1) * PAGE_SIZE + index + 1}
												</td>
												<td className='max-w-72 p-4'>
													<a
														href={href(modelHref(row))}
														className='font-semibold break-words hover:underline'
													>
														{row.display_name}
													</a>
													<p className='text-muted-foreground mt-1 text-xs break-all'>
														{row.vendor}
													</p>
												</td>
												<td className='p-4 tabular-nums'>
													{number(row.request_count)}
												</td>
												<td className='p-4 tabular-nums'>
													{number(row.success_rate)}%
												</td>
												<td className='p-4 tabular-nums'>
													{row.avg_latency_ms === null
														? text('unknown')
														: `${number(row.avg_latency_ms)} ms`}
												</td>
												<td className='p-4 tabular-nums'>
													{number(row.output_tokens)}
												</td>
												<td className='p-4 tabular-nums'>
													{number(row.total_tokens)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<div className='space-y-4 sm:hidden'>
								{page.rows.map((row, index) => (
									<article
										key={row.id}
										className='bg-card min-w-0 space-y-4 rounded-xl border p-4'
									>
										<h2 className='font-semibold break-words'>
											<span className='text-muted-foreground mr-2'>
												{(page.page - 1) * PAGE_SIZE + index + 1}.
											</span>
											<a
												href={href(modelHref(row))}
												className='hover:underline'
											>
												{row.display_name}
											</a>
										</h2>
										<p className='text-muted-foreground text-xs break-all'>
											{row.vendor}
										</p>
										<dl className='grid grid-cols-2 gap-4 text-sm'>
											{[
												[text('requests'), number(row.request_count)],
												[text('successRate'), `${number(row.success_rate)}%`],
												[
													text('averageLatency'),
													row.avg_latency_ms === null
														? text('unknown')
														: `${number(row.avg_latency_ms)} ms`,
												],
												[text('outputTokens'), number(row.output_tokens)],
												[text('totalTokens'), number(row.total_tokens)],
											].map(([label, value]) => (
												<div key={label} className='min-w-0'>
													<dt className='text-muted-foreground mb-1 text-xs'>
														{label}
													</dt>
													<dd className='font-medium break-words tabular-nums'>
														{value}
													</dd>
												</div>
											))}
										</dl>
									</article>
								))}
							</div>
						</>
					)}
					<CatalogPagination
						page={page.page}
						pages={page.pages}
						onChange={(next) => update({ page: next })}
					/>
					<CatalogGeneratedAt value={data.generated_at} />
				</>
			) : null}
		</section>
	)
}
