import { ApiExample } from './ApiExample'
import { PricingDetails } from './CatalogPricing'
import {
	CatalogGeneratedAt,
	PublicPageHeading,
	PublishedTime,
	QueryStatus,
	RefreshCatalog,
	TokenCount,
	ValuesList,
} from './PublicPageParts'
import type { PublicCatalogApi } from './catalog-api'
import { modelKey, modelName } from './catalog-view-model'
import { usePublicLocation } from './ssr/public-location'
import {
	publicCatalogApi,
	usePublicModel,
	usePublicText,
} from './use-public-catalog'

export type ModelDetailPageProps = {
	api?: PublicCatalogApi
	vendor: string
	slug: string
	apiOrigin?: string
}
export function ModelDetailPage(props: ModelDetailPageProps) {
	const { text } = usePublicText()
	const { href } = usePublicLocation()
	const query = usePublicModel(
		props.api ?? publicCatalogApi,
		props.vendor,
		props.slug
	)
	const data = !query.isError ? query.data : undefined
	const model = data?.data
	return (
		<section className='mx-auto w-full max-w-7xl space-y-7 px-4 py-8 sm:px-6'>
			<PublicPageHeading
				title='modelsTitle'
				description='modelsDescription'
				heading={model ? modelName(model) : undefined}
			>
				<RefreshCatalog
					fetching={query.isFetching}
					onClick={() => void query.refetch()}
				/>
			</PublicPageHeading>
			<QueryStatus
				pending={query.isPending}
				fetching={query.isFetching}
				error={query.error}
				retry={() => void query.refetch()}
			/>
			{model && data ? (
				<>
					<header className='space-y-3'>
						<p className='text-muted-foreground text-sm break-words'>
							{model.vendor}
						</p>
						<p className='text-muted-foreground text-sm break-all'>
							{model.id}
						</p>
						<p className='max-w-4xl text-sm leading-7 break-words whitespace-pre-line'>
							{model.description || text('descriptionUnknown')}
						</p>
						<a
							className='text-primary inline-block text-sm font-medium hover:underline'
							href={href(
								`/compare?models=${encodeURIComponent(modelKey(model))}`
							)}
						>
							{text('compareTitle')}
						</a>
					</header>
					<div className='grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,400px)]'>
						<div className='min-w-0 space-y-6'>
							<section className='bg-card space-y-5 rounded-xl border p-5'>
								<h3 className='text-lg font-semibold'>{text('metadata')}</h3>
								<dl className='grid gap-x-8 gap-y-5 sm:grid-cols-2'>
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
										[text('recommended'), model.recommended_protocol],
										[
											text('released'),
											<PublishedTime value={model.released_at} />,
										],
										[text('tags'), <ValuesList values={model.tags} />],
										[text('regions'), <ValuesList values={model.regions} />],
										[
											text('endpointSlugs'),
											<ValuesList values={model.endpoint_slugs} />,
										],
									].map(([label, value]) => (
										<div key={String(label)} className='min-w-0'>
											<dt className='text-muted-foreground mb-1 text-xs'>
												{label}
											</dt>
											<dd className='text-sm break-words'>{value}</dd>
										</div>
									))}
								</dl>
								<div className='space-y-3 border-t pt-4'>
									<h4 className='text-sm font-semibold'>
										{text('routeGroups')}
									</h4>
									{Object.entries(model.protocols_by_group).map(
										([group, protocols]) => (
											<div
												key={group}
												className='flex flex-wrap justify-between gap-3 text-sm'
											>
												<span className='break-all'>{group}</span>
												<ValuesList values={protocols} />
											</div>
										)
									)}
								</div>
							</section>
							<section className='bg-card space-y-3 rounded-xl border p-5'>
								<p className='text-sm font-medium'>
									{text(
										model.data_policy_summary.zdr_available
											? 'zdrAvailable'
											: 'zdrUnavailable'
									)}
								</p>
								<p className='text-muted-foreground text-xs'>
									{text('verifiedRoutes', {
										count: model.data_policy_summary.verified_route_count,
									})}
								</p>
								<p className='text-muted-foreground text-xs'>
									{text('verifiedAt')}:{' '}
									<PublishedTime
										value={model.data_policy_summary.latest_verified_at}
									/>
								</p>
								<p className='text-muted-foreground text-xs leading-6'>
									{text('privacyNote')}
								</p>
							</section>
							<ApiExample
								key={model.id}
								model={model}
								apiOrigin={props.apiOrigin}
							/>
						</div>
						<section className='bg-card min-w-0 space-y-5 self-start rounded-xl border p-5'>
							<h2 className='text-xl font-semibold'>{text('catalogPrices')}</h2>
							<PricingDetails
								profile={model.pricing_profile}
								currency={data.billing_currency}
							/>
						</section>
					</div>
					<CatalogGeneratedAt value={data.generated_at} />
				</>
			) : null}
		</section>
	)
}
