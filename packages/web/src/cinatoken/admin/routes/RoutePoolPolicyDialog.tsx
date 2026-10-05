/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import { routeStrategies, type RoutePoolView } from './route-domain'
import { routeErrorKey } from './route-errors'
import type { RoutePoolPolicyPatch } from './routes-contracts'

const prefix = 'cinatoken.adminRoutes.'
const selectClass = 'bg-background h-10 w-full rounded-md border px-3 text-sm'
const strategyLabels: Record<string, string> = {
	hash_affinity: 'strategyHash',
	weighted_random: 'strategyRandom',
	weight_priority: 'strategyPriority',
	weighted_round_robin: 'strategyRoundRobin',
}
function readTiers(raw: string | null): Record<string, string> | null {
	if (!raw) return {}
	try {
		const value: unknown = JSON.parse(raw)
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null
		for (const [key, strategy] of Object.entries(value)) {
			if (
				!/^-?\d+$/u.test(key) ||
				typeof strategy !== 'string' ||
				!routeStrategies.some((name) => name === strategy)
			)
				return null
		}
		return value as Record<string, string>
	} catch {
		return null
	}
}

export function RoutePoolPolicyDialog(props: {
	pool: RoutePoolView
	disabled: boolean
	pending: boolean
	error: unknown
	onSave: (patch: RoutePoolPolicyPatch) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const [strategy, setStrategy] = useState(props.pool.strategy ?? '')
	const [tiers, setTiers] = useState<Record<string, string> | null>(() =>
		readTiers(props.pool.tierStrategies)
	)
	const [localError, setLocalError] = useState(false)
	const priorities = [
		...new Set(props.pool.targets.map((row) => row.priority)),
	].sort((a, b) => b - a)
	function save(): void {
		if (!props.pool.id || props.disabled || props.pending) return
		const patch: RoutePoolPolicyPatch = {}
		if (strategy !== (props.pool.strategy ?? ''))
			patch.strategy = strategy
				? (strategy as RoutePoolPolicyPatch['strategy'])
				: null
		const originalTiers = readTiers(props.pool.tierStrategies)
		if (
			tiers &&
			originalTiers &&
			JSON.stringify(tiers) !== JSON.stringify(originalTiers)
		)
			patch.tier_strategies = Object.keys(tiers).length
				? (tiers as RoutePoolPolicyPatch['tier_strategies'])
				: null
		if (!Object.keys(patch).length) {
			props.onClose()
			return
		}
		if (tiers === null || originalTiers === null) {
			setLocalError(true)
			return
		}
		props.onSave(patch)
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				initialFocus={title}
				showCloseButton={false}
				className='max-h-[90vh] overflow-y-auto sm:max-w-xl'
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(prefix + 'poolPolicy')}
					</DialogTitle>
					<DialogDescription>
						{props.pool.modelName} · {props.pool.surface.request_protocol}.
						{props.pool.surface.request_operation} · {props.pool.group}
					</DialogDescription>
				</DialogHeader>
				<p className='text-muted-foreground rounded-lg border p-3 text-sm'>
					{t(prefix + 'poolShared')}
				</p>
				{!props.pool.id && (
					<p role='alert' className='text-destructive text-sm'>
						{t(prefix + 'noPool')}
					</p>
				)}
				{(tiers === null || localError) && (
					<p role='alert' className='text-destructive text-sm'>
						{t(prefix + 'invalidResponse')}
					</p>
				)}
				{props.error != null && (
					<p role='alert' className='text-destructive text-sm'>
						{t(routeErrorKey(props.error))}
					</p>
				)}
				<label className='space-y-1 text-sm'>
					{t(prefix + 'strategy')}
					<select
						className={selectClass}
						value={strategy}
						disabled={props.disabled}
						onChange={(event) => setStrategy(event.target.value)}
					>
						<option value=''>{t(prefix + 'inherited')}</option>
						{routeStrategies.map((name) => (
							<option key={name} value={name}>
								{t(prefix + strategyLabels[name])}
							</option>
						))}
					</select>
				</label>
				<div className='space-y-3'>
					{priorities.map((priority) => (
						<label key={priority} className='block space-y-1 text-sm'>
							{t(prefix + 'priorityTier', { priority })}
							<select
								className={selectClass}
								value={tiers?.[String(priority)] ?? ''}
								disabled={props.disabled || tiers === null}
								onChange={(event) => {
									const next = { ...tiers }
									if (event.target.value)
										next[String(priority)] = event.target.value
									else delete next[String(priority)]
									setTiers(next)
								}}
							>
								<option value=''>{t(prefix + 'inherited')}</option>
								{routeStrategies.map((name) => (
									<option key={name} value={name}>
										{t(prefix + strategyLabels[name])}
									</option>
								))}
							</select>
						</label>
					))}
				</div>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'strategyHelp')}
				</p>
				<DialogFooter>
					<Button
						type='button'
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'cancel')}
					</Button>
					<Button
						type='button'
						disabled={
							props.disabled ||
							props.pending ||
							!props.pool.id ||
							tiers === null ||
							props.error != null
						}
						onClick={save}
					>
						{t(prefix + 'save')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
