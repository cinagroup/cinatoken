/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import type { EndpointRequestOptions, EndpointsApi } from '../endpoint-api'
import type { AdminEndpoint, EndpointChoices } from '../endpoint-contracts'
import { EndpointEvidenceView } from './EndpointEvidenceView'
import { endpointErrorKey } from './endpoint-errors'
import { endpointIsExpired } from './endpoint-form'

const prefix = 'cinatoken.adminEndpoints.'

function safeEvidenceUrl(value: string | null): string | null {
	if (!value) return null
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && !url.username && !url.password
			? url.href
			: null
	} catch {
		return null
	}
}

export function EndpointDetailDialog(props: {
	api: EndpointsApi
	id: string
	choices: EndpointChoices
	queryPrefix: readonly unknown[]
	readOptions: (signal?: AbortSignal) => EndpointRequestOptions
	disabled: boolean
	pending: boolean
	error: unknown
	onEdit: (row: AdminEndpoint) => void
	onChange: (
		row: AdminEndpoint,
		action: 'delete' | 'publish' | 'draft' | 'disable'
	) => void
	onToggleRoute: (row: AdminEndpoint, routeId: string, linked: boolean) => void
	onClose: () => void
}) {
	const { t, i18n } = useTranslation()
	const query = useQuery({
		queryKey: [...props.queryPrefix, 'detail', props.id],
		queryFn: ({ signal }) =>
			props.api.endpoint(props.id, props.readOptions(signal)),
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const row = query.error ? null : query.data
	const blocked =
		props.disabled ||
		props.pending ||
		query.isFetching ||
		Boolean(query.error) ||
		props.error != null
	const eligible = row
		? props.choices.routes.filter(
				(route) =>
					route.model_id === row.model_id &&
					route.provider_id === row.provider_id
			)
		: []
	const linked = new Set(row?.route_target_ids ?? [])
	const otherLinked =
		row?.route_target_ids.filter(
			(id) => !eligible.some((route) => route.id === id)
		) ?? []
	const evidenceUrl = safeEvidenceUrl(row?.evidence_url ?? null)
	const date = (value: string | null) =>
		value
			? new Intl.DateTimeFormat(i18n.language, {
					dateStyle: 'medium',
					timeStyle: 'short',
				}).format(new Date(value))
			: '—'
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(prefix + 'detailTitle')}</DialogTitle>
					<DialogDescription className='font-mono break-all'>
						{props.id}
					</DialogDescription>
				</DialogHeader>
				{query.isPending && <p role='status'>{t(prefix + 'loading')}</p>}
				{query.error != null && (
					<div
						role='alert'
						className='text-destructive space-y-3 rounded-xl border p-4 text-sm'
					>
						<p>{t(endpointErrorKey(query.error))}</p>
						<Button
							type='button'
							variant='outline'
							onClick={() => void query.refetch()}
						>
							{t(prefix + 'refresh')}
						</Button>
					</div>
				)}
				{row && (
					<div className='space-y-5'>
						<dl className='grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3'>
							<div>
								<dt className='text-muted-foreground'>{t(prefix + 'model')}</dt>
								<dd className='break-all'>{row.model_id}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'provider')}
								</dt>
								<dd className='break-all'>{row.provider_id}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>{t(prefix + 'tag')}</dt>
								<dd className='break-all'>{row.tag}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'status')}
								</dt>
								<dd>
									{t(
										prefix + (endpointIsExpired(row) ? 'expired' : row.status)
									)}
								</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'endpointClass')}
								</dt>
								<dd>{row.endpoint_class || '—'}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'region')}
								</dt>
								<dd>{row.region || '—'}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'context_length')}
								</dt>
								<dd>{row.context_length ?? '—'}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'max_prompt_tokens')}
								</dt>
								<dd>{row.max_prompt_tokens ?? '—'}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'max_completion_tokens')}
								</dt>
								<dd>{row.max_completion_tokens ?? '—'}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'quantization')}
								</dt>
								<dd>{row.quantization || '—'}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'expiresAt')}
								</dt>
								<dd>{date(row.expires_at)}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'verifiedAt')}
								</dt>
								<dd>{date(row.verified_at)}</dd>
							</div>
						</dl>
						<p className='text-sm break-all'>
							{t(prefix + 'supportedParameters')}:{' '}
							{row.supported_parameters.join(', ') || '—'}
						</p>
						<p className='text-sm break-all'>
							{t(prefix + 'evidenceUrl')}:{' '}
							{evidenceUrl ? (
								<a
									href={evidenceUrl}
									target='_blank'
									rel='noopener noreferrer'
									className='text-primary underline underline-offset-2'
								>
									{evidenceUrl}
								</a>
							) : (
								row.evidence_url || '—'
							)}
						</p>
						<EndpointEvidenceView row={row} />
						<section className='space-y-3 rounded-xl border p-4'>
							<h3 className='font-semibold'>{t(prefix + 'routes')}</h3>
							<p className='text-muted-foreground text-xs'>
								{t(prefix + 'routeHint')}
							</p>
							{eligible.length === 0 && otherLinked.length === 0 && (
								<p className='text-muted-foreground text-sm'>
									{t(prefix + 'noEligibleRoutes')}
								</p>
							)}
							{eligible.map((route) => (
								<div
									key={route.id}
									className='flex flex-wrap items-center justify-between gap-2 border-t py-2 text-sm'
								>
									<div className='min-w-0'>
										<p className='break-all'>
											{route.provider_model_name || route.id}
										</p>
										<p className='text-muted-foreground font-mono text-xs break-all'>
											{route.id} · {route.status || '—'}
										</p>
									</div>
									<Button
										type='button'
										variant='outline'
										size='sm'
										disabled={blocked}
										onClick={() =>
											props.onToggleRoute(row, route.id, !linked.has(route.id))
										}
									>
										{t(
											prefix +
												(linked.has(route.id) ? 'unlinkRoute' : 'linkRoute')
										)}
									</Button>
								</div>
							))}
							{otherLinked.map((id) => (
								<div
									key={id}
									className='flex flex-wrap items-center justify-between gap-2 border-t py-2 text-sm'
								>
									<span className='font-mono break-all'>{id}</span>
									<Button
										type='button'
										variant='outline'
										size='sm'
										disabled={blocked}
										onClick={() => props.onToggleRoute(row, id, false)}
									>
										{t(prefix + 'unlinkRoute')}
									</Button>
								</div>
							))}
						</section>
						<div className='flex flex-wrap gap-2'>
							<Button
								type='button'
								variant='outline'
								disabled={blocked}
								onClick={() => props.onEdit(row)}
							>
								{t(prefix + 'edit')}
							</Button>
							{row.status !== 'verified' && (
								<Button
									type='button'
									disabled={blocked}
									onClick={() => props.onChange(row, 'publish')}
								>
									{t(prefix + 'publish')}
								</Button>
							)}
							{row.status !== 'draft' && (
								<Button
									type='button'
									variant='outline'
									disabled={blocked}
									onClick={() => props.onChange(row, 'draft')}
								>
									{t(prefix + 'makeDraft')}
								</Button>
							)}
							{row.status !== 'disabled' && (
								<Button
									type='button'
									variant='outline'
									disabled={blocked}
									onClick={() => props.onChange(row, 'disable')}
								>
									{t(prefix + 'disable')}
								</Button>
							)}
							<Button
								type='button'
								variant='destructive'
								disabled={blocked}
								onClick={() => props.onChange(row, 'delete')}
							>
								{t(prefix + 'delete')}
							</Button>
						</div>
					</div>
				)}
				{props.error != null && (
					<div role='alert' className='text-destructive space-y-2 text-sm'>
						<p>{t(endpointErrorKey(props.error))}</p>
						<p>{t(prefix + 'writeUnknown')}</p>
					</div>
				)}
				<div className='flex justify-end'>
					<Button
						type='button'
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'close')}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
