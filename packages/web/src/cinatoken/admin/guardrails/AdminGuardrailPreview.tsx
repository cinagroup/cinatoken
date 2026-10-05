/** @jsxRuntime automatic */
/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '../../../components/ui/alert'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from '../../../components/ui/card'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { CinaTokenApiError } from '../../api'
import { AdminDomainWriteError } from '../domain-write-recovery'
import type {
	AdminGuardrailPreviewApi,
	AdminGuardrailPreviewTarget,
	AdminGuardrailPreviewOptions,
} from './preview-api'
import type {
	AdminGuardrailPreview,
	AdminGuardrailPreviewResult,
	AdminGuardrailPreviewTrace,
} from './preview-contracts'

const namespace = 'cinatoken.account.guardrails.'
const privacyReasons: Record<string, string> = {
	provider_missing: 'previewReasonProviderMissing',
	shared_channel: 'previewReasonSharedChannel',
	policy_missing: 'previewReasonPolicyMissing',
	policy_expired: 'previewReasonPolicyExpired',
	policy_unverified: 'previewReasonPolicyUnverified',
	subject_mismatch: 'previewReasonSubjectMismatch',
	subject_unverifiable: 'previewReasonSubjectUnverifiable',
	zdr_not_supported: 'previewReasonZdrUnsupported',
	no_collection_not_supported: 'previewReasonCollectionUnsupported',
}
const plannerReasons: Record<string, string> = {
	provider_missing: 'previewPlannerReasonProviderMissing',
	provider_inactive: 'previewPlannerReasonProviderInactive',
	provider_credential_missing: 'previewPlannerReasonCredentialMissing',
	provider_shared_channel: 'previewPlannerReasonSharedChannel',
	provider_protocol_unsupported: 'previewPlannerReasonProtocolUnsupported',
	endpoint_binding_missing: 'previewPlannerReasonBindingMissing',
	endpoint_binding_ambiguous: 'previewPlannerReasonBindingAmbiguous',
	endpoint_invalid: 'previewPlannerReasonEndpointInvalid',
	endpoint_identity_mismatch: 'previewPlannerReasonIdentityMismatch',
	endpoint_subject_unverifiable: 'previewPlannerReasonSubjectUnverifiable',
	endpoint_subject_mismatch: 'previewPlannerReasonSubjectMismatch',
	endpoint_metadata_drift: 'previewPlannerReasonMetadataDrift',
	operation_unsupported: 'previewPlannerReasonOperationUnsupported',
}

type PreviewState =
	| { key: string; kind: 'loading' }
	| { key: string; kind: 'ready'; result: AdminGuardrailPreviewResult }
	| { key: string; kind: 'error'; error: 'access' | 'invalid' | 'failed' }

export type AdminGuardrailPreviewProps = {
	api: AdminGuardrailPreviewApi
	/** Verified Console identity/access scope. Remount or change on session recheck. */
	scopeKey: string
	canRead: boolean
	readOptions: (signal?: AbortSignal) => AdminGuardrailPreviewOptions
	/** Initial edit target; callers remount when the selected key changes. */
	initialTarget?: AdminGuardrailPreviewTarget
	onAccessLost?: () => void
	onReadFailure?: (error: unknown) => void
}

function PreviewTrace(props: { trace: AdminGuardrailPreviewTrace }) {
	const { t } = useTranslation()
	return (
		<section className='space-y-2'>
			<h3 className='font-medium'>{t(namespace + 'previewLayers')}</h3>
			{props.trace.length === 0 ? (
				<p className='text-muted-foreground text-sm'>{t(namespace + 'none')}</p>
			) : (
				<ol className='space-y-2'>
					{props.trace.map((layer) => (
						<li
							key={`${layer.assignmentId}:${layer.scopeType}:${layer.scopeId}`}
							className='rounded-lg border p-3 text-sm'
						>
							<p className='font-medium break-words'>
								{layer.guardrailName} · v{layer.version}
							</p>
							<p className='text-muted-foreground font-mono text-xs break-all'>
								{layer.scopeType} · {layer.scopeId}
							</p>
						</li>
					))}
				</ol>
			)}
		</section>
	)
}

function ExclusionCounts(props: {
	title: string
	reasons: Record<string, number>
	labels: Record<string, string>
}) {
	const { t } = useTranslation()
	return (
		<section className='space-y-1 text-sm'>
			<h4 className='font-medium'>{props.title}</h4>
			{Object.entries(props.reasons).length === 0 ? (
				<p className='text-muted-foreground'>{t(namespace + 'none')}</p>
			) : (
				<ul className='space-y-1'>
					{Object.entries(props.reasons).map(([reason, count]) => (
						<li key={reason} className='flex justify-between gap-3'>
							<span>{t(namespace + props.labels[reason])}</span>
							<span className='font-mono'>{count}</span>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}

export function AdminGuardrailPreviewEvidence(props: {
	result: AdminGuardrailPreviewResult
}) {
	const { t, i18n } = useTranslation()
	const text = (key: string) => t(namespace + key)
	const locale = i18n.resolvedLanguage || 'en'
	const number = (value: number | null) =>
		value === null
			? text('unknown')
			: new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(
					value
				)
	const range = (value: { minimum: number | null; maximum: number | null }) =>
		value.minimum === null || value.maximum === null
			? text('unknown')
			: `${number(value.minimum)}–${number(value.maximum)}`
	const display = (values: readonly string[] | null) =>
		values === null ? text('unrestricted') : values.join(', ') || text('none')
	if (props.result.kind === 'conflict')
		return (
			<div className='space-y-4' role='status'>
				<Alert variant='destructive'>
					<AlertDescription>{text('previewConflict')}</AlertDescription>
				</Alert>
				<PreviewTrace trace={props.result.trace} />
			</div>
		)
	const preview: AdminGuardrailPreview = props.result.preview
	const candidates = preview.routeCandidates
	const evidence = candidates.plannerEvidence
	return (
		<div className='space-y-5' role='status'>
			{candidates.truncated ? (
				<Alert>
					<AlertDescription>{text('previewTruncatedWarning')}</AlertDescription>
				</Alert>
			) : null}
			<div className='grid gap-3 sm:grid-cols-2'>
				{(
					[
						['previewAllowedModels', preview.effective.allowedModels],
						['previewIgnoredModels', preview.effective.ignoredModels],
						['previewAllowedProviders', preview.effective.allowedProviders],
						['previewIgnoredProviders', preview.effective.ignoredProviders],
					] as const
				).map(([label, values]) => (
					<div key={label} className='bg-muted/40 rounded-lg p-3'>
						<h3 className='text-sm font-medium'>{text(label)}</h3>
						<p className='mt-1 text-sm break-words'>{display(values)}</p>
					</div>
				))}
			</div>
			<p className='text-sm'>
				{t(namespace + 'previewPrivacy', {
					collection: text(
						preview.effective.dataCollection === 'deny'
							? 'denied'
							: 'callerDefault'
					),
					zdr: text(
						preview.effective.requireZdr ? 'allModels' : 'callerDefault'
					),
				})}
			</p>
			<div className='flex flex-wrap gap-2'>
				{Object.entries(preview.effective.zdr).map(([group, required]) => (
					<Badge key={group} variant={required ? 'default' : 'outline'}>
						{group}: {required ? text('required') : text('callerDefault')}
					</Badge>
				))}
			</div>
			<section className='space-y-2 text-sm'>
				<h3 className='font-medium'>
					{t(namespace + 'previewFilters', {
						builtins: preview.effective.contentFilterBuiltins.length,
						input: preview.effective.inputFilters.length,
						output: preview.effective.outputFilters.length,
						budgets: preview.effective.budgets.length,
					})}
				</h3>
				{preview.effective.contentFilterBuiltins.map((filter) => (
					<p key={filter.slug} className='break-words'>
						{filter.slug}: {text(filter.action)}
					</p>
				))}
				{[
					...preview.effective.inputFilters,
					...preview.effective.outputFilters,
				].map((filter, index) => (
					<p key={`${filter.id}:${index}`} className='break-words'>
						{filter.label || filter.id}: {text(filter.action)}
					</p>
				))}
				{preview.effective.budgets.map((budget) => (
					<p
						key={`${budget.guardrailId}:${budget.scopeType}:${budget.scopeId}`}
						className='break-words'
					>
						{t(namespace + 'budgetSource', {
							name: budget.guardrailName,
							period: text(budget.period),
							limit: number(budget.limit),
							currency: preview.budgetCurrency,
						})}
					</p>
				))}
			</section>
			<section className='space-y-2 rounded-lg border p-3 text-sm'>
				<h3 className='font-medium'>
					{text('previewCandidateRoutes')}: {candidates.count}
				</h3>
				<p className='break-words'>
					{text('previewCandidateModels')}: {display(candidates.modelIds)}
				</p>
				<p className='break-words'>
					{text('previewCandidateProviders')}: {display(candidates.providers)}
				</p>
				<p>
					{text('previewEndpointEvidence')}:{' '}
					{t(namespace + 'previewEligibleFraction', {
						eligible: candidates.routeEvidence.eligibleCount,
						checked: candidates.routeEvidence.checkedCount,
					})}
				</p>
				<ExclusionCounts
					title={text('previewEvidenceExclusions')}
					reasons={candidates.routeEvidence.excludedByReason}
					labels={privacyReasons}
				/>
				<ul className='space-y-1 text-xs'>
					{candidates.routeEvidence.eligibleExamples.map((route, index) => (
						<li key={index} className='break-words'>
							{route.modelId} · {route.provider} · {route.protocol}/
							{route.operation} · {route.routeGroup}
						</li>
					))}
				</ul>
			</section>
			<section className='space-y-3 rounded-lg border p-3 text-sm'>
				<h3 className='font-medium'>{text('previewPlannerEvidence')}</h3>
				<p>
					{text('previewPlannerEligible')}:{' '}
					{t(namespace + 'previewEligibleFraction', {
						eligible: evidence.staticallyEligibleCount,
						checked: evidence.checkedCount,
					})}
				</p>
				<p>
					{text('previewPlannerCapability')}:{' '}
					{t(namespace + 'previewPlannerCapabilityValue', {
						verified: evidence.operationCapabilities.verifiedCount,
						requestDependent:
							evidence.operationCapabilities.requestDependentCount,
					})}
				</p>
				<p>
					{text('previewPlannerCapacity')}:{' '}
					{t(namespace + 'previewPlannerCapacityValue', {
						known: evidence.outputCapacity.knownCount,
						applicable: evidence.outputCapacity.applicableCount,
						range: `${number(evidence.outputCapacity.minimumTokens)}–${number(evidence.outputCapacity.maximumTokens)}`,
					})}
				</p>
				<p>
					{text('previewPlannerPerformance')}:{' '}
					{t(namespace + 'previewPlannerPerformanceValue', {
						sampled: evidence.performance.sampledRoutes,
						checked: evidence.performance.checkedRoutes,
						latency: number(evidence.performance.p50LatencyMs),
						throughput: number(
							evidence.performance.p50ThroughputTokensPerSecond
						),
					})}
				</p>
				{evidence.performance.truncated ? (
					<p className='text-muted-foreground text-xs'>
						{text('previewPlannerPerformanceTruncated')}
					</p>
				) : null}
				<h4 className='font-medium'>{text('previewPlannerPricing')}</h4>
				<p>
					{t(namespace + 'previewPlannerPricingValue', {
						comparable: evidence.pricing.comparableCount,
						prompt: range(evidence.pricing.promptPerMillion),
						completion: range(evidence.pricing.completionPerMillion),
						request: range(evidence.pricing.request),
						image: range(evidence.pricing.image),
						timezone: evidence.pricing.businessTimezone,
					})}
				</p>
				<p className='text-muted-foreground text-xs'>
					{t(namespace + 'pricingAsOf', {
						currency: preview.pricingCurrency,
						time: new Intl.DateTimeFormat(locale, {
							dateStyle: 'medium',
							timeStyle: 'short',
						}).format(new Date(evidence.pricing.evaluatedAt)),
						timezone: evidence.pricing.businessTimezone,
					})}
				</p>
				<ExclusionCounts
					title={text('previewPlannerExclusions')}
					reasons={evidence.excludedByReason}
					labels={plannerReasons}
				/>
			</section>
			<Alert>
				<AlertDescription>
					<p>{text('previewEvidenceWarning')}</p>
					<p className='mt-2'>
						{t(namespace + 'previewPlannerRequestDependent', {
							wildcard: evidence.requestDependent.wildcardOperationCount,
							endpoint: evidence.requestDependent.explicitEndpointOptInCount,
						})}
					</p>
					<p className='mt-2'>{text('previewPlannerCircuitDispatchOnly')}</p>
				</AlertDescription>
			</Alert>
			<PreviewTrace trace={preview.trace} />
		</div>
	)
}

export function AdminGuardrailPreview(props: AdminGuardrailPreviewProps) {
	return (
		<PreviewForm
			key={JSON.stringify([props.scopeKey, props.canRead])}
			{...props}
		/>
	)
}

function PreviewForm(props: AdminGuardrailPreviewProps) {
	const { t } = useTranslation()
	const text = (key: string) => t(namespace + key)
	const [workspaceId, setWorkspaceId] = useState(
		() => props.initialTarget?.workspaceId ?? ''
	)
	const [userId, setUserId] = useState(() => props.initialTarget?.userId ?? '')
	const [apiKeyId, setApiKeyId] = useState(
		() => props.initialTarget?.apiKeyId ?? ''
	)
	const [state, setState] = useState<PreviewState | null>(null)
	const sequence = useRef(0)
	const controller = useRef<AbortController | null>(null)
	const key = JSON.stringify([
		props.scopeKey,
		workspaceId.trim(),
		userId.trim(),
		apiKeyId.trim() || null,
	])
	useLayoutEffect(
		() => () => {
			sequence.current += 1
			controller.current?.abort()
			controller.current = null
		},
		[props.scopeKey]
	)
	const visible = props.canRead && state?.key === key ? state : null
	function invalidate(): void {
		sequence.current += 1
		controller.current?.abort()
		controller.current = null
		setState(null)
	}
	async function load(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault()
		if (!props.canRead) return
		const target = {
			workspaceId: workspaceId.trim(),
			userId: userId.trim(),
			apiKeyId: apiKeyId.trim() || null,
		}
		if (!target.workspaceId || !target.userId) {
			setState({ key, kind: 'error', error: 'invalid' })
			return
		}
		invalidate()
		const requestId = ++sequence.current
		const abort = new AbortController()
		controller.current = abort
		setState({ key, kind: 'loading' })
		try {
			const result = await props.api.previewGuardrail(
				target,
				props.readOptions(abort.signal)
			)
			if (requestId === sequence.current && !abort.signal.aborted)
				setState({ key, kind: 'ready', result })
		} catch (error) {
			props.onReadFailure?.(error)
			if (requestId !== sequence.current) return
			const access =
				(error instanceof CinaTokenApiError ||
					error instanceof AdminDomainWriteError) &&
				(error.status === 401 || error.status === 403)
			let reason: 'access' | 'invalid' | 'failed' = 'failed'
			if (access) reason = 'access'
			else if (error instanceof TypeError) reason = 'invalid'
			setState({ key, kind: 'error', error: reason })
			if (access) props.onAccessLost?.()
		} finally {
			if (controller.current === abort) controller.current = null
		}
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>{text('previewTitle')}</CardTitle>
				<p className='text-muted-foreground text-sm'>{text('previewHint')}</p>
			</CardHeader>
			<CardContent className='space-y-5'>
				<form onSubmit={(event) => void load(event)} className='space-y-3'>
					<div className='grid gap-3 sm:grid-cols-3'>
						<div className='space-y-1'>
							<Label htmlFor='admin-guardrail-preview-workspace'>
								{text('workspace')}
							</Label>
							<Input
								id='admin-guardrail-preview-workspace'
								value={workspaceId}
								disabled={!props.canRead}
								maxLength={600}
								autoComplete='off'
								onChange={(event) => {
									invalidate()
									setWorkspaceId(event.target.value)
								}}
							/>
						</div>
						<div className='space-y-1'>
							<Label htmlFor='admin-guardrail-preview-user'>
								{text('previewUserId')}
							</Label>
							<Input
								id='admin-guardrail-preview-user'
								value={userId}
								disabled={!props.canRead}
								maxLength={256}
								autoComplete='off'
								onChange={(event) => {
									invalidate()
									setUserId(event.target.value)
								}}
							/>
						</div>
						<div className='space-y-1'>
							<Label htmlFor='admin-guardrail-preview-key'>
								{text('previewApiKeyId')}
							</Label>
							<Input
								id='admin-guardrail-preview-key'
								value={apiKeyId}
								disabled={!props.canRead}
								maxLength={256}
								autoComplete='off'
								onChange={(event) => {
									invalidate()
									setApiKeyId(event.target.value)
								}}
							/>
						</div>
					</div>
					<Button
						type='submit'
						variant='outline'
						disabled={!props.canRead || visible?.kind === 'loading'}
					>
						{text(
							visible?.kind === 'loading' ? 'previewLoading' : 'previewAction'
						)}
					</Button>
				</form>
				{visible?.kind === 'loading' ? (
					<p role='status' className='text-sm'>
						{text('previewLoading')}
					</p>
				) : null}
				{visible?.kind === 'error' ? (
					<Alert variant='destructive' role='alert'>
						<AlertDescription>
							{text(
								{
									access: 'accessDenied',
									invalid: 'previewRequired',
									failed: 'previewFailed',
								}[visible.error]
							)}
						</AlertDescription>
					</Alert>
				) : null}
				{visible?.kind === 'ready' ? (
					<AdminGuardrailPreviewEvidence result={visible.result} />
				) : null}
			</CardContent>
		</Card>
	)
}
