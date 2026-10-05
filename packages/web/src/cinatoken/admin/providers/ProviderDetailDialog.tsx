import { useEffect, useRef, useState } from 'react'
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
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import type { AdminDomainRequestOptions } from '../domain-transport'
import type { ProvidersApi } from '../provider-api'
import type {
	AdminProvider,
	ProviderDashScopeResource,
	ProviderJsonObject,
} from '../provider-contracts'
import { normalizeProviderEndpoints } from '../provider-endpoints'
import type { ProviderDashScopeResult } from '../provider-resource'
import { ProviderResourceForm } from './ProviderResourceForm'
import { providerErrorKey } from './provider-errors'

const prefix = 'cinatoken.adminProviders.'
export function ProviderDetailDialog(props: {
	api: ProvidersApi
	row: AdminProvider
	queryPrefix: readonly unknown[]
	pending: boolean
	disabled: boolean
	error: unknown
	readOptions?: (signal?: AbortSignal) => AdminDomainRequestOptions
	writeOptions: (signal: AbortSignal) => AdminDomainRequestOptions
	queue: (task: {
		run: (signal: AbortSignal) => Promise<void>
		write?: boolean
	}) => void
	onEdit: (row: AdminProvider) => void
	onClone: (row: AdminProvider) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const query = useQuery({
		queryKey: [...props.queryPrefix, 'detail', props.row.id],
		queryFn: ({ signal }) =>
			props.api.provider(
				props.row.id,
				props.readOptions?.(signal) ?? { signal }
			),
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const [secret, setSecret] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const [copyFailed, setCopyFailed] = useState(false)
	const [response, setResponse] = useState<ProviderDashScopeResult | null>(null)
	const live = useRef(true)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])
	const row = query.data
	const disabled =
		props.disabled ||
		Boolean(query.error) ||
		query.isFetching ||
		props.error != null
	function reveal(): void {
		props.queue({
			run: async (signal) => {
				const options = props.readOptions?.(signal) ?? { signal }
				await props.api.verifyAdminDomainSubject(options)
				const value = await props.api.revealProviderKey(props.row.id, options)
				if (live.current && !signal.aborted) {
					setSecret(value)
					setCopied(false)
					setCopyFailed(false)
				}
			},
		})
	}
	async function copy(): Promise<void> {
		if (!secret) return
		try {
			await navigator.clipboard.writeText(secret)
			if (live.current) setCopied(true)
		} catch {
			if (live.current) setCopyFailed(true)
		}
	}
	function resource(
		resource: ProviderDashScopeResource,
		input: ProviderJsonObject
	): void {
		setResponse(null)
		props.queue({
			write: true,
			run: async (signal) => {
				try {
					const result = await props.api.manageProviderDashScope(
						props.row.id,
						resource,
						input,
						{
							...props.writeOptions(signal),
							knownSecrets: secret ? [secret] : [],
						}
					)
					if (live.current && !signal.aborted) setResponse(result)
				} finally {
					for (const key of Object.keys(input)) delete input[key]
				}
			},
		})
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(prefix + 'detail')}</DialogTitle>
					<DialogDescription>{props.row.name}</DialogDescription>
				</DialogHeader>
				{query.isPending && <p role='status'>{t(prefix + 'loading')}</p>}
				{query.error && (
					<div role='alert' className='text-destructive space-y-2'>
						<p>{t(providerErrorKey(query.error))}</p>
						<Button variant='outline' onClick={() => void query.refetch()}>
							{t(prefix + 'refresh')}
						</Button>
					</div>
				)}
				{row && (
					<div className='space-y-4'>
						<dl className='grid gap-3 text-sm sm:grid-cols-2'>
							<div>
								<dt className='text-muted-foreground'>{t(prefix + 'name')}</dt>
								<dd className='break-all'>{row.name}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>ID</dt>
								<dd className='font-mono break-all'>{row.id}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'status')}
								</dt>
								<dd>{t(prefix + row.status)}</dd>
							</div>
							<div>
								<dt className='text-muted-foreground'>
									{t(prefix + 'credentialPreview')}
								</dt>
								<dd className='font-mono break-all'>{row.api_key}</dd>
							</div>
						</dl>
						<p className='text-muted-foreground text-sm'>
							{t(prefix + 'routes', {
								active: row.active_routes_count,
								total: row.routes_count,
							})}
						</p>
						{row.endpointsState === 'available' && (
							<details>
								<summary className='cursor-pointer text-sm'>
									{t(prefix + 'endpoints')}
								</summary>
								<pre className='bg-muted mt-3 max-h-64 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap'>
									{JSON.stringify(
										normalizeProviderEndpoints(row.endpoints),
										null,
										2
									)}
								</pre>
							</details>
						)}
						{row.endpointsState !== 'available' && (
							<p className='text-muted-foreground text-sm'>
								{t(
									prefix +
										(row.endpointsState === 'redacted'
											? 'endpointRedacted'
											: 'endpointInvalid')
								)}
							</p>
						)}
						<div className='flex flex-wrap gap-2'>
							<Button
								variant='outline'
								disabled={disabled}
								onClick={() => props.onEdit(row)}
							>
								{t(prefix + 'edit')}
							</Button>
							<Button
								variant='outline'
								disabled={disabled}
								onClick={() => props.onClone(row)}
							>
								{t(prefix + 'clone')}
							</Button>
						</div>
						<section className='space-y-3 rounded-xl border p-4'>
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'revealNotice')}
							</p>
							{secret === null && (
								<Button variant='outline' disabled={disabled} onClick={reveal}>
									{t(prefix + 'reveal')}
								</Button>
							)}
							{secret !== null && (
								<div className='space-y-3'>
									<Label htmlFor='provider-plaintext'>
										{t(prefix + 'credentialValue')}
									</Label>
									<Textarea
										id='provider-plaintext'
										value={secret}
										readOnly
										rows={5}
										spellCheck={false}
										autoComplete='off'
										className='font-mono text-xs'
									/>
									<div className='flex flex-wrap gap-2'>
										<Button
											variant='outline'
											disabled={disabled || !secret}
											onClick={() => void copy()}
										>
											{t(prefix + (copied ? 'copied' : 'copy'))}
										</Button>
										<Button
											variant='outline'
											onClick={() => {
												setSecret(null)
												setCopied(false)
												setResponse(null)
											}}
										>
											{t(prefix + 'clearSecret')}
										</Button>
									</div>
									{copyFailed && (
										<p role='alert' className='text-destructive text-sm'>
											{t(prefix + 'copyFailed')}
										</p>
									)}
								</div>
							)}
						</section>
						{row.endpointsState === 'available' &&
							normalizeProviderEndpoints(row.endpoints).dashscope && (
								<ProviderResourceForm
									pending={props.pending}
									disabled={disabled}
									response={response}
									onSend={resource}
								/>
							)}
						{row.endpointsState !== 'available' && (
							<details>
								<summary className='cursor-pointer text-sm'>
									{t(prefix + 'diagnostics')}
								</summary>
								<p className='text-muted-foreground mt-3 text-sm'>
									{t(prefix + 'diagnosticsUnverified')}
								</p>
								<ProviderResourceForm
									pending={props.pending}
									disabled={disabled}
									response={response}
									onSend={resource}
								/>
							</details>
						)}
					</div>
				)}
				{props.error != null && (
					<div role='alert' className='text-destructive space-y-2 text-sm'>
						<p>{t(providerErrorKey(props.error))}</p>
						<p>{t(prefix + 'writeUnknown')}</p>
					</div>
				)}
				<div className='flex justify-end'>
					<Button
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
