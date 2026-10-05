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
import type { AdminModel } from '../model-contracts'
import {
	modelPolicyStrategy,
	routeStrategies,
	type RoutePoolView,
} from './route-domain'
import { routeErrorKey } from './route-errors'

const prefix = 'cinatoken.adminRoutes.'
const labels: Record<string, string> = {
	hash_affinity: 'strategyHash',
	weighted_random: 'strategyRandom',
	weight_priority: 'strategyPriority',
	weighted_round_robin: 'strategyRoundRobin',
}
const selectClass = 'bg-background h-10 w-full rounded-md border px-3 text-sm'

export function RouteModelPolicyDialog(props: {
	pool: RoutePoolView
	model: AdminModel | null
	disabled: boolean
	pending: boolean
	error: unknown
	onSave: (
		protocol: string | null,
		operation: string | null,
		expectedPolicy: string | null
	) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const surface = props.pool.surface
	const [baseline] = useState(props.model)
	const [protocol, setProtocol] = useState(() =>
		baseline
			? (modelPolicyStrategy(baseline.route_policy, {
					protocol: surface.request_protocol,
					operation: null,
					group: props.pool.group,
				}) ?? '')
			: ''
	)
	const [operation, setOperation] = useState(() =>
		baseline && surface.request_operation !== '*'
			? (modelPolicyStrategy(baseline.route_policy, {
					protocol: surface.request_protocol,
					operation: surface.request_operation,
					group: props.pool.group,
				}) ?? '')
			: ''
	)
	function options(value: string, set: (value: string) => void) {
		return (
			<select
				className={selectClass}
				value={value}
				disabled={props.disabled || !props.model}
				onChange={(event) => set(event.target.value)}
			>
				<option value=''>{t(prefix + 'inherited')}</option>
				{routeStrategies.map((name) => (
					<option key={name} value={name}>
						{t(prefix + labels[name])}
					</option>
				))}
			</select>
		)
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
				className='sm:max-w-xl'
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(prefix + 'modelPolicy')}
					</DialogTitle>
					<DialogDescription>
						{props.pool.modelName} · {surface.request_protocol}.
						{surface.request_operation} · {props.pool.group}
					</DialogDescription>
				</DialogHeader>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'modelPolicyHelp')}
				</p>
				{props.error != null && (
					<p role='alert' className='text-destructive text-sm'>
						{t(routeErrorKey(props.error))}
					</p>
				)}
				<label className='space-y-1 text-sm'>
					{t(prefix + 'protocolRule')}
					{options(protocol, setProtocol)}
				</label>
				{surface.request_operation !== '*' && (
					<label className='space-y-1 text-sm'>
						{t(prefix + 'operationRule')}
						{options(operation, setOperation)}
					</label>
				)}
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
							!props.model ||
							props.error != null
						}
						onClick={() => {
							if (baseline)
								props.onSave(
									protocol || null,
									operation || null,
									baseline.route_policy
								)
						}}
					>
						{t(prefix + 'save')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
