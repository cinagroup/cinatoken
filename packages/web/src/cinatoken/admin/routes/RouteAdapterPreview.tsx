/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import {
	DASHSCOPE_TASKS_PATH,
	matchAdapterUpstreamModel,
	requestSurfacePath,
} from '@octafuse/core/adapters/registry'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '../../../components/ui/alert'
import { Button } from '../../../components/ui/button'
import type { AdminModel } from '../model-contracts'
import { routeAdapterDescriptor } from './route-adapter-catalog'
import type { RouteDraft } from './route-domain'

const prefix = 'cinatoken.adminRoutes.'
export function RouteAdapterPreview(props: {
	draft: RouteDraft
	model: AdminModel | undefined
}) {
	const { t } = useTranslation()
	const descriptor = routeAdapterDescriptor(props.draft, props.model)
	const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(
		null
	)
	if (!descriptor) return null
	const example = descriptor.extraBodyExample
		? JSON.stringify(descriptor.extraBodyExample, null, 2)
		: null
	async function copy(): Promise<void> {
		if (!example || !descriptor) return
		try {
			await navigator.clipboard.writeText(example)
			setCopied({ key: descriptor.optionKey, ok: true })
		} catch {
			setCopied({ key: descriptor.optionKey, ok: false })
		}
	}
	return (
		<section
			className='bg-muted/30 flex min-w-0 flex-col gap-3 rounded-lg border p-4'
			aria-label={t(prefix + 'adapterGuide')}
		>
			<h4 className='text-sm font-medium'>{t(prefix + 'adapterGuide')}</h4>
			{matchAdapterUpstreamModel(descriptor, props.draft.providerModelName) ===
				'mismatch' && (
				<Alert>
					<AlertDescription>
						{t(prefix + 'adapterGuideModelMismatch')}
					</AlertDescription>
				</Alert>
			)}
			<dl className='grid min-w-0 gap-3 text-sm sm:grid-cols-2'>
				<div className='min-w-0'>
					<dt className='text-muted-foreground'>
						{t(prefix + 'adapterGuidePath')}
					</dt>
					<dd className='mt-1 font-mono text-xs break-all'>
						{requestSurfacePath(
							descriptor.request.protocol,
							descriptor.request.operation,
							props.draft.modelId
						)}
					</dd>
				</div>
				<div>
					<dt className='text-muted-foreground'>
						{t(prefix + 'adapterGuideExchange')}
					</dt>
					<dd className='mt-1'>
						{t(prefix + 'adapterExchange-' + descriptor.exchange)}
					</dd>
				</div>
				<div className='min-w-0 sm:col-span-2'>
					<dt className='text-muted-foreground'>
						{t(prefix + 'adapterGuideCapabilities')}
					</dt>
					<dd className='mt-1 font-mono text-xs break-all'>
						{descriptor.requiredUpstreamCapabilities.join(', ')}
					</dd>
				</div>
			</dl>
			{descriptor.exchange === 'job' && (
				<p className='text-muted-foreground text-xs'>
					{props.draft.requestProtocol === 'dashscope'
						? t(prefix + 'adapterGuideNativeTask', {
								path: `GET ${DASHSCOPE_TASKS_PATH}/:taskId?model=${encodeURIComponent(props.draft.modelId)}`,
							})
						: t(prefix + 'adapterGuideConvertedTask')}
				</p>
			)}
			{descriptor.lossyFeatures && descriptor.lossyFeatures.length > 0 && (
				<div className='text-sm'>
					<h5 className='font-medium'>
						{t(prefix + 'adapterGuideUnsupported')}
					</h5>
					<p className='mt-1 font-mono text-xs break-words'>
						{descriptor.lossyFeatures.join(', ')}
					</p>
				</div>
			)}
			{descriptor.protectedUpstreamPaths &&
				descriptor.protectedUpstreamPaths.length > 0 && (
					<div className='text-sm'>
						<h5 className='font-medium'>
							{t(prefix + 'adapterGuideProtected')}
						</h5>
						<p className='text-muted-foreground mt-1 text-xs'>
							{t(prefix + 'adapterGuideProtectedHint')}
						</p>
						<p className='mt-1 font-mono text-xs break-all'>
							{descriptor.protectedUpstreamPaths.join(', ')}
						</p>
					</div>
				)}
			{descriptor.extraBodyNote === 'dashscope_tts_input' && (
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'adapterGuideTtsInput')}
				</p>
			)}
			{example && (
				<details className='min-w-0 rounded-lg border p-3'>
					<summary className='cursor-pointer text-sm'>
						{t(prefix + 'adapterGuideExample')}
					</summary>
					<pre className='bg-muted mt-3 max-h-64 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap'>
						{example}
					</pre>
					<div className='mt-3 flex flex-wrap items-center gap-3'>
						<Button
							type='button'
							size='sm'
							variant='outline'
							onClick={() => void copy()}
						>
							{t(prefix + 'adapterGuideCopy')}
						</Button>
						{copied?.key === descriptor.optionKey && (
							<span role='status' className='text-muted-foreground text-xs'>
								{t(
									prefix +
										(copied.ok
											? 'adapterGuideCopied'
											: 'adapterGuideCopyFailed')
								)}
							</span>
						)}
					</div>
				</details>
			)}
		</section>
	)
}
