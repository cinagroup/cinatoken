/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import type {
	PlaygroundContext,
	PlaygroundKind,
	PlaygroundRoute,
	PlaygroundSearch,
} from './playground-contracts'
import {
	playgroundKinds,
	playgroundPrefix as prefix,
	routeKind,
	routeMatches,
} from './playground-domain'

export const playgroundControl =
	'bg-background w-full min-w-0 rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring'
export const playgroundCode =
	'bg-muted/40 max-h-80 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap break-words'
const kindLabels = {
	llm: 'kindLlm',
	image: 'kindImage',
	audio: 'kindAudio',
	rerank: 'kindRerank',
}
const toolLabels = {
	'web-search': 'webSearch',
	'web-fetch': 'webFetch',
	'web-deep-search': 'webDeepSearch',
	'ai-detection': 'aiDetection',
}
export function PlaygroundSetup(props: {
	context: PlaygroundContext
	search: PlaygroundSearch
	route: PlaygroundRoute | null
	kind: PlaygroundKind
	onKind: (kind: PlaygroundKind) => void
	onSearch: (search: PlaygroundSearch) => void
}) {
	const { t } = useTranslation(),
		[query, setQuery] = useState(''),
		[model, setModel] = useState(''),
		[provider, setProvider] = useState(''),
		[protocol, setProtocol] = useState(''),
		[group, setGroup] = useState('')
	const rows = props.context.routes.filter(
		(route) =>
			routeKind(props.context, route) === props.kind &&
			routeMatches(route, query) &&
			(!model || route.model_id === model) &&
			(!provider || route.provider_id === provider) &&
			(!protocol || route.upstream_protocol === protocol) &&
			(!group || route.route_group === group)
	)
	const tool = props.context.tools.find(
		(row) => row.toolId === props.search.tool
	)
	return (
		<section className='space-y-4 rounded-xl border p-4'>
			<div
				className='flex flex-wrap gap-2'
				role='group'
				aria-label={t(prefix + 'mode')}
			>
				{(['routes', 'tools'] as const).map((mode) => (
					<Button
						key={mode}
						variant={props.search.mode === mode ? 'default' : 'outline'}
						aria-pressed={props.search.mode === mode}
						onClick={() => props.onSearch({ ...props.search, mode })}
					>
						{t(prefix + (mode === 'routes' ? 'modeRoutes' : 'modeTools'))}
					</Button>
				))}
			</div>
			{props.search.mode === 'routes' ? (
				<>
					<div
						className='flex flex-wrap gap-2'
						role='group'
						aria-label={t(prefix + 'kind')}
					>
						{playgroundKinds.map((kind) => (
							<Button
								key={kind}
								size='sm'
								variant={props.kind === kind ? 'default' : 'outline'}
								aria-pressed={props.kind === kind}
								onClick={() => {
									setModel('')
									setProvider('')
									setProtocol('')
									setGroup('')
									props.onKind(kind)
								}}
							>
								{t(prefix + kindLabels[kind])} (
								{
									props.context.routes.filter(
										(route) => routeKind(props.context, route) === kind
									).length
								}
								)
							</Button>
						))}
					</div>
					<label className='block space-y-1 text-sm'>
						<span>{t(prefix + 'searchRoutes')}</span>
						<input
							className={playgroundControl}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t(prefix + 'searchRoutesPlaceholder')}
						/>
					</label>
					<details>
						<summary className='cursor-pointer text-sm'>
							{t(prefix + 'moreFilters')}
						</summary>
						<div className='mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
							<label className='space-y-1 text-sm'>
								<span>{t(prefix + 'modelId')}</span>
								<select
									className={playgroundControl}
									value={model}
									onChange={(event) => setModel(event.target.value)}
								>
									<option value=''>
										{t(prefix + 'placeholders.allModels')}
									</option>
									{props.context.models
										.filter((row) => row.kind === props.kind)
										.map((row) => (
											<option key={row.id} value={row.id}>
												{row.id} · {row.display_name}
											</option>
										))}
								</select>
							</label>
							<label className='space-y-1 text-sm'>
								<span>{t(prefix + 'provider')}</span>
								<select
									className={playgroundControl}
									value={provider}
									onChange={(event) => setProvider(event.target.value)}
								>
									<option value=''>
										{t(prefix + 'placeholders.allProviders')}
									</option>
									{props.context.providers.map((row) => (
										<option key={row.id} value={row.id}>
											{row.name}
										</option>
									))}
								</select>
							</label>
							<label className='space-y-1 text-sm'>
								<span>{t(prefix + 'protocol')}</span>
								<select
									className={playgroundControl}
									value={protocol}
									onChange={(event) => setProtocol(event.target.value)}
								>
									<option value=''>
										{t(prefix + 'placeholders.allProtocols')}
									</option>
									{['openai', 'anthropic', 'gemini', 'dashscope'].map(
										(value) => (
											<option key={value}>{value}</option>
										)
									)}
								</select>
							</label>
							<label className='space-y-1 text-sm'>
								<span>{t(prefix + 'routeGroup')}</span>
								<select
									className={playgroundControl}
									value={group}
									onChange={(event) => setGroup(event.target.value)}
								>
									<option value=''>
										{t(prefix + 'placeholders.allRouteGroups')}
									</option>
									{Array.from(
										new Set(props.context.routes.map((row) => row.route_group))
									)
										.filter(Boolean)
										.map((value) => (
											<option key={value}>{value}</option>
										))}
								</select>
							</label>
						</div>
					</details>
					<label className='block space-y-1 text-sm'>
						<span>{t(prefix + 'selectRoute')}</span>
						<select
							className={playgroundControl}
							value={props.route?.id ?? ''}
							onChange={(event) =>
								props.onSearch({ ...props.search, routeId: event.target.value })
							}
						>
							<option value=''>{t(prefix + 'selectRouteOption')}</option>
							{props.route &&
							!rows.some((row) => row.id === props.route?.id) ? (
								<option value={props.route.id}>
									{props.route.model_id} · {props.route.provider_name} ·{' '}
									{props.route.upstream_protocol}.
									{props.route.upstream_operation}
								</option>
							) : null}
							{rows.map((row) => (
								<option key={row.id} value={row.id}>
									{row.model_name || row.model_id} ·{' '}
									{row.provider_name || row.provider_id} ·{' '}
									{row.upstream_protocol}.{row.upstream_operation} ·{' '}
									{row.route_group} · {row.status} · {row.id}
								</option>
							))}
						</select>
					</label>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'routeCount', {
							total: props.context.routes.length,
							filtered: rows.length,
						})}
					</p>
					{!rows.length ? (
						<p role='status'>{t(prefix + 'noMatchingRoutes')}</p>
					) : null}
					{props.route ? (
						<RouteDetails route={props.route} />
					) : (
						<p>{t(prefix + 'chooseRouteHint')}</p>
					)}
				</>
			) : (
				<>
					<h2 className='font-semibold'>{t(prefix + 'toolsSection')}</h2>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'toolsHint')}
					</p>
					<div className='grid gap-3 sm:grid-cols-2'>
						<label className='space-y-1 text-sm'>
							<span>{t(prefix + 'tool')}</span>
							<select
								className={playgroundControl}
								value={props.search.tool}
								onChange={(event) =>
									props.onSearch({
										...props.search,
										tool: event.target.value as PlaygroundSearch['tool'],
										provider: '',
									})
								}
							>
								{props.context.tools.map((row) => (
									<option key={row.toolId} value={row.toolId}>
										{t(prefix + toolLabels[row.toolId])}
									</option>
								))}
							</select>
						</label>
						<label className='space-y-1 text-sm'>
							<span>{t(prefix + 'engineProvider')}</span>
							<select
								className={playgroundControl}
								value={props.search.provider}
								onChange={(event) =>
									props.onSearch({
										...props.search,
										provider: event.target.value,
									})
								}
							>
								<option value=''>{t(prefix + 'toolsNeedProvider')}</option>
								{tool?.providers.map((row) => (
									<option key={row.provider} value={row.provider}>
										{row.provider} ·{' '}
										{t(
											prefix + (row.configured ? 'configured' : 'unconfigured')
										)}
										{row.active ? ' · ' + t(prefix + 'active') : ''}
									</option>
								))}
							</select>
						</label>
					</div>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'engineProviderHint')}
					</p>
					{!tool || tool.catalog_state === 'unavailable' ? (
						<p role='alert'>{t(prefix + 'catalogUnavailable')}</p>
					) : null}
				</>
			)}
		</section>
	)
}
function RouteDetails(props: { route: PlaygroundRoute }) {
	const { t } = useTranslation(),
		route = props.route
	const fields = [
		['modelName', route.model_name || route.model_id],
		['providerName', route.provider_name || route.provider_id],
		['providerModel', route.provider_model_name],
		['upstreamProtocol', route.upstream_protocol],
		['upstreamOperation', route.upstream_operation],
		['routeGroup', route.route_group],
		['priorityStatus', `${route.priority} / ${route.status}`],
		['routingPool', route.pool_name || route.route_pool_id || '—'],
	]
	return (
		<div className='space-y-3'>
			{route.status.toLowerCase() !== 'active' ? (
				<p
					role='status'
					className='rounded-md border border-amber-500/50 p-3 text-sm'
				>
					{t(prefix + 'inactiveRouteHint')}
				</p>
			) : null}
			<dl className='grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4'>
				{fields.map(([key, value]) => (
					<div key={key} className='min-w-0'>
						<dt className='text-muted-foreground text-xs'>{t(prefix + key)}</dt>
						<dd className='break-all'>{value}</dd>
					</div>
				))}
			</dl>
			<details>
				<summary className='cursor-pointer text-sm'>
					{t(prefix + 'selectedDetails')}
				</summary>
				<div className='mt-3 space-y-3'>
					<dl className='grid gap-2 text-xs sm:grid-cols-3'>
						{[
							['selectedRoute', route.id],
							['modelId', route.model_id],
							['providerId', route.provider_id],
						].map(([key, value]) => (
							<div key={key}>
								<dt>{t(prefix + key)}</dt>
								<dd className='break-all'>{value}</dd>
							</div>
						))}
					</dl>
					{[
						['publicSurfaces', JSON.stringify(route.surfaces, null, 2)],
						['customParams', route.custom_params_preview ?? '—'],
						['priceOverride', route.price_override_preview ?? '—'],
					].map(([key, value]) => (
						<div key={key}>
							<h3 className='mb-1 text-xs font-medium'>{t(prefix + key)}</h3>
							<pre className={playgroundCode}>{value}</pre>
						</div>
					))}
					{route.adapter ? (
						<p className='text-xs'>adapter: {route.adapter}</p>
					) : null}
				</div>
			</details>
		</div>
	)
}
