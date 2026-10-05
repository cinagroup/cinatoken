import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { GuardrailTrace } from '../../guardrail-contracts'
import type { GuardrailsManager } from './use-guardrails-manager'

const privacyReason: Record<string, string> = {
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
const plannerReason: Record<string, string> = {
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
function Trace(props: { trace: GuardrailTrace }) {
	const { t } = useTranslation()
	return (
		<section className='space-y-2'>
			<h3 className='font-medium'>
				{t('cinatoken.account.guardrails.previewLayers')}
			</h3>
			{props.trace.length === 0 ? (
				<p className='text-muted-foreground text-sm'>
					{t('cinatoken.account.guardrails.none')}
				</p>
			) : null}
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
		</section>
	)
}
function Exclusions(props: {
	reasons: Record<string, number>
	labels: Record<string, string>
	title: string
}) {
	const { t } = useTranslation()
	return (
		<section className='space-y-2'>
			<h4 className='text-sm font-medium'>{props.title}</h4>
			<ul className='space-y-1 text-sm'>
				{Object.entries(props.reasons).map(([reason, count]) => (
					<li className='flex justify-between gap-3' key={reason}>
						<span>
							{t(`cinatoken.account.guardrails.${props.labels[reason]}`)}
						</span>
						<span className='font-mono'>{count}</span>
					</li>
				))}
			</ul>
			{Object.keys(props.reasons).length === 0 ? (
				<p className='text-muted-foreground text-sm'>
					{t('cinatoken.account.guardrails.none')}
				</p>
			) : null}
		</section>
	)
}
export function EffectiveGuardrails(props: { manager: GuardrailsManager }) {
	const { t, i18n } = useTranslation()
	const manager = props.manager
	const text = (key: string) => t(`cinatoken.account.guardrails.${key}`)
	const result =
		!manager.blocked && !manager.preview.isError
			? manager.preview.data
			: undefined
	const preview = result?.success ? result.data : null
	const evidence = preview?.routeCandidates.plannerEvidence
	const keys =
		!manager.blocked && manager.canUseKeys
			? (manager.keys.data?.keys.filter((key) => key.status === 'active') ?? [])
			: []
	const display = (values: readonly string[] | null) =>
		values === null ? text('unrestricted') : values.join(', ') || text('none')
	const number = (value: number | null) =>
		value === null
			? text('unknown')
			: new Intl.NumberFormat(i18n.resolvedLanguage, {
					maximumFractionDigits: 6,
				}).format(value)
	const range = (value: { minimum: number | null; maximum: number | null }) =>
		value.minimum === null || value.maximum === null
			? text('unknown')
			: `${number(value.minimum)}–${number(value.maximum)}`
	return (
		<Card>
			<CardHeader>
				<CardTitle>{text('previewTitle')}</CardTitle>
				<p className='text-muted-foreground text-sm leading-6'>
					{text('previewHint')}
				</p>
			</CardHeader>
			<CardContent className='space-y-5'>
				<div className='flex flex-col gap-3 sm:flex-row'>
					<label
						className='min-w-0 flex-1 space-y-1'
						htmlFor='guardrail-preview-key'
					>
						<span className='text-sm'>{text('previewIdentity')}</span>
						{manager.keySelectionAllowed ? (
							<select
								id='guardrail-preview-key'
								className='bg-background h-9 w-full min-w-0 rounded-md border px-2 text-sm'
								value={manager.apiKeyId ?? ''}
								disabled={
									manager.pending ||
									manager.blocked !== null ||
									!manager.canUseKeys
								}
								onChange={(event) =>
									manager.setApiKeyId(event.target.value || null)
								}
							>
								<option value=''>{text('previewUserOnly')}</option>
								{keys.map((key) => (
									<option value={key.id} key={key.id}>
										{key.name || key.key}
									</option>
								))}
							</select>
						) : (
							<p className='text-muted-foreground pt-2 text-sm'>
								{text('previewUserOnly')}
							</p>
						)}
					</label>
					<Button
						variant='outline'
						className='sm:self-end'
						disabled={manager.pending || manager.preview.isFetching}
						onClick={() => void manager.refresh()}
					>
						{text(
							manager.preview.isFetching ? 'previewLoading' : 'previewAction'
						)}
					</Button>
				</div>
				{manager.preview.isPending ? (
					<p role='status' className='text-sm'>
						{text('previewLoading')}
					</p>
				) : null}
				{manager.preview.isError || manager.blocked ? (
					<Alert variant='destructive'>
						<AlertDescription>{text('previewFailed')}</AlertDescription>
					</Alert>
				) : null}
				{result && !result.success ? (
					<>
						<Alert variant='destructive'>
							<AlertDescription>
								{text('previewConflict')}
								<p className='mt-2 font-mono text-xs break-words'>
									{result.message}
								</p>
							</AlertDescription>
						</Alert>
						<Trace trace={result.trace} />
					</>
				) : null}
				{preview && evidence ? (
					<>
						{preview.routeCandidates.truncated ? (
							<Alert>
								<AlertDescription>
									{text('previewTruncatedWarning')}
								</AlertDescription>
							</Alert>
						) : null}
						<div className='grid gap-3 sm:grid-cols-2'>
							{(
								[
									['previewAllowedModels', preview.effective.allowedModels],
									['previewIgnoredModels', preview.effective.ignoredModels],
									[
										'previewAllowedProviders',
										preview.effective.allowedProviders,
									],
									[
										'previewIgnoredProviders',
										preview.effective.ignoredProviders,
									],
								] as const
							).map(([title, values]) => (
								<div className='bg-muted/40 rounded-lg p-3' key={title}>
									<h3 className='text-sm font-medium'>{text(title)}</h3>
									<p className='mt-1 text-sm break-words'>{display(values)}</p>
								</div>
							))}
						</div>
						<p className='text-sm'>
							{t('cinatoken.account.guardrails.previewPrivacy', {
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
							{Object.entries(preview.effective.zdr).map(
								([group, required]) => (
									<Badge variant={required ? 'default' : 'outline'} key={group}>
										{group}:{' '}
										{required ? text('required') : text('callerDefault')}
									</Badge>
								)
							)}
						</div>
						<p className='text-muted-foreground text-sm'>
							{t('cinatoken.account.guardrails.previewFilters', {
								builtins: preview.effective.contentFilterBuiltins.length,
								input: preview.effective.inputFilters.length,
								output: preview.effective.outputFilters.length,
								budgets: preview.effective.budgets.length,
							})}
						</p>
						<div className='space-y-2 text-sm'>
							{preview.effective.contentFilterBuiltins.map((filter) => (
								<p key={filter.slug}>
									{filter.slug}: {text(filter.action)}
								</p>
							))}
							{[
								...preview.effective.inputFilters,
								...preview.effective.outputFilters,
							].map((filter, index) => (
								<p key={`${filter.id}:${index}`}>
									{filter.label || filter.id}: {text(filter.action)}
								</p>
							))}
							{preview.effective.budgets.map((budget) => (
								<p
									className='break-words'
									key={`${budget.guardrailId}:${budget.scopeType}:${budget.scopeId}`}
								>
									{t('cinatoken.account.guardrails.budgetSource', {
										name: budget.guardrailName,
										period: text(budget.period),
										limit: number(budget.limit),
										currency: preview.budgetCurrency,
									})}
								</p>
							))}
						</div>
						<section className='space-y-3 rounded-lg border p-3'>
							<h3 className='font-medium'>
								{text('previewCandidateRoutes')}:{' '}
								{preview.routeCandidates.count}
							</h3>
							<p className='text-sm break-words'>
								{text('previewCandidateModels')}:{' '}
								{display(preview.routeCandidates.modelIds)}
							</p>
							<p className='text-sm break-words'>
								{text('previewCandidateProviders')}:{' '}
								{display(preview.routeCandidates.providers)}
							</p>
							<p className='text-sm'>
								{text('previewEndpointEvidence')}:{' '}
								{text(
									preview.routeCandidates.routeEvidence.required
										? 'required'
										: 'notRequired'
								)}{' '}
								·{' '}
								{t('cinatoken.account.guardrails.previewEligibleFraction', {
									eligible: preview.routeCandidates.routeEvidence.eligibleCount,
									checked: preview.routeCandidates.routeEvidence.checkedCount,
								})}
							</p>
							<Exclusions
								reasons={preview.routeCandidates.routeEvidence.excludedByReason}
								labels={privacyReason}
								title={text('previewEvidenceExclusions')}
							/>
							<ul className='space-y-1 text-xs'>
								{preview.routeCandidates.routeEvidence.eligibleExamples.map(
									(route, index) => (
										<li className='break-words' key={index}>
											{route.modelId} · {route.provider} · {route.protocol}/
											{route.operation} · {route.routeGroup}
										</li>
									)
								)}
							</ul>
						</section>
						<section className='space-y-3 rounded-lg border p-3'>
							<h3 className='font-medium'>{text('previewPlannerEvidence')}</h3>
							<dl className='grid gap-3 text-sm sm:grid-cols-2'>
								<div>
									<dt className='font-medium'>
										{text('previewPlannerEligible')}
									</dt>
									<dd>
										{t('cinatoken.account.guardrails.previewEligibleFraction', {
											eligible: evidence.staticallyEligibleCount,
											checked: evidence.checkedCount,
										})}
									</dd>
								</div>
								<div>
									<dt className='font-medium'>
										{text('previewPlannerCapability')}
									</dt>
									<dd>
										{t(
											'cinatoken.account.guardrails.previewPlannerCapabilityValue',
											{
												verified: evidence.operationCapabilities.verifiedCount,
												requestDependent:
													evidence.operationCapabilities.requestDependentCount,
											}
										)}
									</dd>
								</div>
								<div>
									<dt className='font-medium'>
										{text('previewPlannerCapacity')}
									</dt>
									<dd>
										{t(
											'cinatoken.account.guardrails.previewPlannerCapacityValue',
											{
												known: evidence.outputCapacity.knownCount,
												applicable: evidence.outputCapacity.applicableCount,
												range: `${number(evidence.outputCapacity.minimumTokens)}–${number(evidence.outputCapacity.maximumTokens)}`,
											}
										)}{' '}
										· {text('unknown')}: {evidence.outputCapacity.unknownCount}
									</dd>
								</div>
								<div>
									<dt className='font-medium'>
										{text('previewPlannerPerformance')}
									</dt>
									<dd>
										{t(
											'cinatoken.account.guardrails.previewPlannerPerformanceValue',
											{
												sampled: evidence.performance.sampledRoutes,
												checked: evidence.performance.checkedRoutes,
												latency: number(evidence.performance.p50LatencyMs),
												throughput: number(
													evidence.performance.p50ThroughputTokensPerSecond
												),
											}
										)}{' '}
										· {evidence.performance.sampleCount}
									</dd>
								</div>
							</dl>
							{evidence.performance.truncated ? (
								<p className='text-muted-foreground text-xs'>
									{text('previewPlannerPerformanceTruncated')}
								</p>
							) : null}
							<div className='space-y-2 text-sm'>
								<h4 className='font-medium'>{text('previewPlannerPricing')}</h4>
								<p>
									{t(
										'cinatoken.account.guardrails.previewPlannerPricingValue',
										{
											comparable: evidence.pricing.comparableCount,
											prompt: range(evidence.pricing.promptPerMillion),
											completion: range(evidence.pricing.completionPerMillion),
											request: range(evidence.pricing.request),
											image: range(evidence.pricing.image),
											timezone: evidence.pricing.businessTimezone,
										}
									)}
								</p>
								<p className='text-muted-foreground text-xs'>
									{t('cinatoken.account.guardrails.pricingAsOf', {
										currency: preview.pricingCurrency,
										time: new Intl.DateTimeFormat(i18n.resolvedLanguage, {
											dateStyle: 'medium',
											timeStyle: 'short',
										}).format(new Date(evidence.pricing.evaluatedAt)),
										timezone: evidence.pricing.businessTimezone,
									})}
								</p>
							</div>
							<Exclusions
								reasons={evidence.excludedByReason}
								labels={plannerReason}
								title={text('previewPlannerExclusions')}
							/>
						</section>
						<Alert>
							<AlertDescription>
								<p>{text('previewEvidenceWarning')}</p>
								<p className='mt-2'>
									{t(
										'cinatoken.account.guardrails.previewPlannerRequestDependent',
										{
											wildcard:
												evidence.requestDependent.wildcardOperationCount,
											endpoint:
												evidence.requestDependent.explicitEndpointOptInCount,
										}
									)}
								</p>
								<p className='mt-2'>
									{text('previewPlannerCircuitDispatchOnly')}
								</p>
							</AlertDescription>
						</Alert>
						<Trace trace={preview.trace} />
					</>
				) : null}
			</CardContent>
		</Card>
	)
}
