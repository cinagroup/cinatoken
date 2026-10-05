/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { GATEWAY_TOOLS } from '../playground/browser-domain/gateway-tools'
import {
	INVOKE_KINDS,
	parseGatewayToolId,
	proxyToolPath,
} from '../playground/browser-domain/invoke-kind'
import { routedModels, simulatorModelKind } from './simulator-selection'
import {
	listDashScopeAudioClientOperations,
	labelClass,
	inputClass,
	panelClass,
} from './simulator-utils'
import type { SimulatorState } from './use-simulator'

const kindKeys = {
	llm: 'kindLlm',
	image: 'kindImage',
	audio: 'kindAudio',
	tool: 'kindTool',
} as const
export function SimulatorRouting(props: { state: SimulatorState }) {
	const { t } = useTranslation()
	const state = props.state
	const all = routedModels(state.context)
	const models = all.filter(
		(model) => simulatorModelKind(model) === state.selection.kind
	)
	const search = state.modelSearch.trim().toLocaleLowerCase()
	const visible = models.filter((model) =>
		[model.id, model.display_name ?? '', model.vendor].some((text) =>
			text.toLocaleLowerCase().includes(search)
		)
	)
	const groups = [
		...new Set(
			(state.context?.routes ?? [])
				.filter(
					(route) =>
						route.model_id === state.selection.modelId &&
						route.status.toLowerCase() === 'active'
				)
				.map((route) => route.route_group)
				.filter((group) => group && group !== 'default')
		),
	].sort()
	const operations = listDashScopeAudioClientOperations(
		state.context?.routes ?? [],
		state.selection.modelId,
		state.selection.routeGroup,
		state.selection.audioOperation
	)
	return (
		<section className={panelClass} aria-labelledby='simulator-routing'>
			<h2 id='simulator-routing' className='font-semibold'>
				{t('cinatoken.adminSimulator.routingTarget')}
			</h2>
			<p className='text-muted-foreground text-xs'>
				{t('cinatoken.adminSimulator.routingTargetHint')}
			</p>
			<div
				role='group'
				aria-label={t('cinatoken.adminSimulator.kind')}
				className='flex flex-wrap gap-2'
			>
				{INVOKE_KINDS.map((kind) => (
					<button
						type='button'
						key={kind}
						aria-pressed={state.selection.kind === kind}
						disabled={state.sending}
						className={
							'rounded-md border px-3 py-2 text-sm disabled:opacity-50 ' +
							(kind === state.selection.kind
								? 'border-primary bg-primary/10'
								: '')
						}
						onClick={() => state.changeSelection({ kind })}
					>
						{t('cinatoken.adminSimulator.' + kindKeys[kind])} (
						{kind === 'tool'
							? GATEWAY_TOOLS.length
							: all.filter((model) => simulatorModelKind(model) === kind)
									.length}
						)
					</button>
				))}
			</div>
			{state.selection.kind === 'tool' ? (
				<>
					<label className={labelClass} htmlFor='simulator-tool'>
						{t('cinatoken.adminSimulator.tool')}
					</label>
					<select
						id='simulator-tool'
						className={inputClass}
						disabled={state.sending}
						value={state.selection.toolId}
						onChange={(event) => {
							const toolId = parseGatewayToolId(event.target.value)
							if (toolId) state.changeSelection({ toolId })
						}}
					>
						{GATEWAY_TOOLS.map((tool) => (
							<option key={tool.id} value={tool.id}>
								{t('cinatoken.adminSimulator.toolNames.' + tool.nameKey)} ·{' '}
								{proxyToolPath(tool.id)}
							</option>
						))}
					</select>
					<p className='text-muted-foreground text-xs'>
						{t('cinatoken.adminSimulator.toolHint', {
							id: state.selection.toolId,
						})}
					</p>
					<p className='text-muted-foreground text-xs'>
						{t('cinatoken.adminSimulator.toolNoRoutes')}
					</p>
				</>
			) : (
				<>
					<label className={labelClass} htmlFor='simulator-model-search'>
						{t('cinatoken.adminSimulator.filter')}
					</label>
					<input
						id='simulator-model-search'
						className={inputClass}
						value={state.modelSearch}
						placeholder={t('cinatoken.adminSimulator.modelFilterPlaceholder')}
						onChange={(event) => state.setModelSearch(event.target.value)}
						disabled={state.sending}
					/>
					<p className='text-muted-foreground text-xs'>
						{t('cinatoken.adminSimulator.modelCount', {
							total: models.length,
							filtered: visible.length,
						})}
					</p>
					<div
						role='group'
						aria-label={t('cinatoken.adminSimulator.model')}
						className='max-h-64 space-y-1 overflow-auto rounded-md border p-1'
					>
						{visible.map((model) => (
							<button
								type='button'
								key={model.id}
								aria-pressed={state.selection.modelId === model.id}
								disabled={state.sending}
								className={
									'w-full rounded-md border px-3 py-2 text-left text-sm disabled:opacity-50 ' +
									(state.selection.modelId === model.id
										? 'border-primary bg-primary/10'
										: 'hover:bg-muted border-transparent')
								}
								onClick={() => state.changeSelection({ modelId: model.id })}
							>
								<span className='block font-medium'>
									{model.display_name || model.id}
								</span>
								<span className='text-muted-foreground block text-xs break-all'>
									{model.id} · {model.vendor}
								</span>
							</button>
						))}
						{visible.length === 0 && (
							<p className='text-muted-foreground p-3 text-sm'>
								{t(
									models.length
										? 'cinatoken.adminSimulator.noMatchingModels'
										: 'cinatoken.adminSimulator.noRoutedModels'
								)}
							</p>
						)}
					</div>
					<label className={labelClass} htmlFor='simulator-group'>
						{t('cinatoken.adminSimulator.routeGroupOptional')}
					</label>
					<select
						id='simulator-group'
						className={inputClass}
						value={state.selection.routeGroup}
						disabled={state.sending || !state.selection.modelId}
						onChange={(event) =>
							state.changeSelection({ routeGroup: event.target.value })
						}
					>
						<option value=''>
							{t('cinatoken.adminSimulator.defaultRouteGroup')}
						</option>
						{groups.map((group) => (
							<option key={group} value={group}>
								{group}
							</option>
						))}
					</select>
					<p className='text-muted-foreground text-xs'>
						{t('cinatoken.adminSimulator.routeGroupHint')}
					</p>
					<p className='text-sm break-all'>
						{t('cinatoken.adminSimulator.routingModelString')}:{' '}
						<code>{state.routingString || '—'}</code>
					</p>
					{state.selection.kind === 'audio' &&
						state.selection.protocol === 'dashscope' && (
							<>
								<label
									className={labelClass}
									htmlFor='simulator-dashscope-operation'
								>
									{t('cinatoken.adminSimulator.realtimeOperation')}
								</label>
								<select
									id='simulator-dashscope-operation'
									className={inputClass}
									value={state.selection.dashscopeOperation}
									disabled={state.sending}
									onChange={(event) =>
										state.changeSelection({
											dashscopeOperation: event.target.value,
										})
									}
								>
									{operations.map((operation) => (
										<option key={operation} value={operation}>
											{operation}
										</option>
									))}
								</select>
							</>
						)}
					<details className='rounded-md border p-3'>
						<summary className='cursor-pointer text-sm'>
							{t('cinatoken.adminSimulator.matchingRoutesSummary', {
								count: state.routes.length,
							})}
						</summary>
						<p className='text-muted-foreground my-2 text-xs'>
							{t('cinatoken.adminSimulator.matchingRoutesHint')}
						</p>
						<ul className='space-y-2 text-xs'>
							{state.routes.map((route) => (
								<li key={route.id} className='rounded border p-2 break-all'>
									{route.provider_name || route.provider_id} ·{' '}
									{route.provider_model_name} ·{' '}
									{t('cinatoken.adminSimulator.priority', {
										priority: route.priority,
									})}{' '}
									· {route.route_group || 'default'}
									<span className='text-muted-foreground block'>
										{route.id} · {route.upstream_protocol} /{' '}
										{route.upstream_operation}
									</span>
								</li>
							))}
						</ul>
						{state.routes.length === 0 && (
							<p className='text-muted-foreground text-xs'>
								{t('cinatoken.adminSimulator.matchingRoutesEmpty')}
							</p>
						)}
					</details>
				</>
			)}
		</section>
	)
}
