/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
	parseFirstEventTimeoutMs,
	parseFirstEventTimeoutRouteGroups,
	STREAM_FIRST_EVENT_TIMEOUT_MAX_MS,
} from '@octafuse/core/lib/stream-first-event-timeout-config'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
} from '../../../components/ui/card'
import { Input } from '../../../components/ui/input'
import { streamTimeoutFormSchema } from './config-stream-timeout'
import { useStreamTimeout, type StreamTimeoutProps } from './use-stream-timeout'

const prefix = 'cinatoken.adminConfigFull.'
export function StreamTimeoutCard(props: StreamTimeoutProps) {
	const { t } = useTranslation()
	const manager = useStreamTimeout(props)
	const isMs = props.field === 'streamFirstEventTimeoutMs'
	const id = `admin-config-${props.field}`
	const [confirmed, setConfirmed] = useState(false)
	const baseline = useRef(props.configuration?.revision ?? null)
	const form = useForm<{ value: string }>({
		resolver: zodResolver(streamTimeoutFormSchema(props.field)),
		defaultValues: { value: props.configuration?.value ?? '' },
		mode: 'onChange',
	})
	const dirty = form.formState.isDirty
	const valid = form.formState.isValid
	useEffect(() => {
		if (!dirty && props.configuration) {
			form.reset({ value: props.configuration.value })
			baseline.current = props.configuration.revision
		}
	}, [dirty, form, props.configuration])
	const current = props.configuration
	let effective = t(prefix + 'streamUnavailable')
	if (current && isMs) {
		const ms = parseFirstEventTimeoutMs(current.value)
		effective =
			ms > 0
				? t(prefix + 'streamEffectiveMs', { value: ms })
				: t(prefix + 'streamDisabled')
		if (ms > STREAM_FIRST_EVENT_TIMEOUT_MAX_MS)
			effective = t(prefix + 'streamUnsafeTimer')
	}
	if (current && !isMs) {
		const groups = parseFirstEventTimeoutRouteGroups(current.value)
		effective =
			groups === '*'
				? t(prefix + 'streamAllGroups')
				: t(prefix + 'streamSelectedGroups', { value: groups.join(', ') })
	}
	async function submit(values: { value: string }) {
		if (!confirmed || !dirty) return
		const saved = await manager.save(values.value, baseline.current)
		setConfirmed(false)
		if (saved) {
			form.reset({ value: saved.value })
			baseline.current = saved.revision
		}
	}
	return (
		<Card aria-labelledby={id + '-title'} className='min-w-0'>
			<CardHeader>
				<CardTitle id={id + '-title'}>
					{t(prefix + (isMs ? 'streamTimeoutTitle' : 'streamGroupsTitle'))}
				</CardTitle>
				<CardDescription>
					{t(prefix + (isMs ? 'streamTimeoutHint' : 'streamGroupsHint'))}
				</CardDescription>
			</CardHeader>
			<CardContent className='min-w-0 space-y-4'>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'streamCacheHint')}
				</p>
				<p className='text-sm [overflow-wrap:anywhere] break-words'>
					{effective}
				</p>
				{current ? (
					<p className='text-muted-foreground text-sm [overflow-wrap:anywhere] break-words'>
						{t(prefix + 'streamRaw')}:{' '}
						<code className='whitespace-pre-wrap'>
							{current.value || t(prefix + 'streamEmpty')}
						</code>
					</p>
				) : null}
				{current?.source === 'invalid' ? (
					<p role='status' className='text-sm'>
						{t(prefix + 'streamLegacy')}
					</p>
				) : null}
				{manager.error ? (
					<p role='alert' className='text-destructive text-sm'>
						{t(manager.error)}
					</p>
				) : null}
				{manager.message ? (
					<p role='status' className='text-sm'>
						{t(manager.message)}
					</p>
				) : null}
				{manager.status !== 'ready' ? (
					<p role='alert' className='text-sm'>
						{t(
							prefix +
								(manager.status === 'pending'
									? 'streamPending'
									: 'storageUnavailable')
						)}
					</p>
				) : null}
				{current && props.canWrite && manager.status === 'ready' ? (
					<form
						onSubmit={(event) => void form.handleSubmit(submit)(event)}
						className='space-y-3'
					>
						<label className='text-sm font-medium' htmlFor={id}>
							{t(prefix + (isMs ? 'streamMsLabel' : 'streamGroupsLabel'))}
						</label>
						<Input
							id={id}
							{...form.register('value', {
								onChange: () => setConfirmed(false),
							})}
							type='text'
							inputMode={isMs ? 'numeric' : 'text'}
							autoComplete='off'
							spellCheck={false}
							disabled={!manager.canEdit}
							aria-invalid={!!form.formState.errors.value}
							aria-describedby={id + '-hint'}
						/>
						<p id={id + '-hint'} className='text-muted-foreground text-sm'>
							{t(
								prefix + (isMs ? 'streamMsValidation' : 'streamGroupValidation')
							)}
						</p>
						{form.formState.errors.value ? (
							<p role='alert' className='text-destructive text-sm'>
								{t(prefix + 'invalidSetting')}
							</p>
						) : null}
						<label className='flex items-start gap-2 text-sm'>
							<input
								type='checkbox'
								checked={confirmed}
								disabled={!manager.canEdit || !dirty}
								onChange={(event) => setConfirmed(event.target.checked)}
								className='mt-1 shrink-0'
							/>
							{t(prefix + 'streamConfirm')}
						</label>
						<div className='flex flex-wrap gap-2'>
							<Button
								type='submit'
								disabled={!manager.canEdit || !dirty || !confirmed || !valid}
							>
								{t(prefix + (isMs ? 'streamSaveMs' : 'streamSaveGroups'))}
							</Button>
							<Button
								type='button'
								variant='outline'
								disabled={!manager.canEdit || !dirty}
								onClick={() => {
									form.reset({ value: current.value })
									baseline.current = current.revision
									setConfirmed(false)
								}}
							>
								{t(prefix + 'streamDiscard')}
							</Button>
						</div>
					</form>
				) : null}
				<Button
					type='button'
					variant='outline'
					disabled={manager.pending || props.disabled}
					onClick={manager.read}
				>
					{t(prefix + 'streamCheck')}
				</Button>
			</CardContent>
		</Card>
	)
}
