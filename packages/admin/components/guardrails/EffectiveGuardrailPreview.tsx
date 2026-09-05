'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { readPortalJson } from '@/lib/portal-fetch';

type GatewayKey = { id: string; name: string | null; key: string; status: string };
type NumericRange = { minimum: number | null; maximum: number | null };
type PlannerExclusionReason =
	| 'provider_missing' | 'provider_inactive' | 'provider_credential_missing'
	| 'provider_shared_channel' | 'provider_protocol_unsupported'
	| 'endpoint_binding_missing' | 'endpoint_binding_ambiguous' | 'endpoint_invalid'
	| 'endpoint_identity_mismatch' | 'endpoint_subject_unverifiable'
	| 'endpoint_subject_mismatch' | 'endpoint_metadata_drift' | 'operation_unsupported';

type EffectivePreview = {
	workspaceId: string;
	userId?: string;
	apiKeyId: string | null;
	trace: Array<{
		assignmentId: string;
		guardrailId: string;
		guardrailName: string;
		version: number;
		scopeType: 'account' | 'workspace' | 'user' | 'api_key';
		scopeId: string;
	}>;
	effective: {
		allowedModels: string[] | null;
		ignoredModels: string[];
		allowedProviders: string[] | null;
		ignoredProviders: string[];
		dataCollection: 'deny' | null;
		requireZdr: boolean;
		zdr: Record<'anthropic' | 'openai' | 'google' | 'xai' | 'other', boolean>;
		contentFilterBuiltins: Array<{ slug: string; action: string }>;
		inputFilters: Array<{ id: string; action: string }>;
		outputFilters: Array<{ id: string; action: string }>;
		budgets: Array<{ guardrailId: string; guardrailName: string; limit: number; period: string }>;
	};
	routeCandidates: {
		count: number;
		modelIds: string[];
		providers: string[];
		truncated: boolean;
		requiresEndpointEvidence: boolean;
		routeEvidence: {
			required: boolean;
			checkedCount: number;
			eligibleCount: number;
			excludedCount: number;
			excludedByReason: Partial<Record<
				'provider_missing' | 'shared_channel' | 'policy_missing' | 'policy_expired'
				| 'policy_unverified' | 'subject_mismatch' | 'subject_unverifiable'
				| 'zdr_not_supported' | 'no_collection_not_supported',
				number
			>>;
		};
		plannerEvidence: {
			checkedCount: number;
			staticallyEligibleCount: number;
			excludedCount: number;
			excludedByReason: Partial<Record<PlannerExclusionReason, number>>;
			operationCapabilities: { verifiedCount: number; requestDependentCount: number };
			outputCapacity: {
				applicableCount: number;
				knownCount: number;
				unknownCount: number;
				minimumTokens: number | null;
				maximumTokens: number | null;
			};
			pricing: {
				evidenceReadyCount: number;
				comparableCount: number;
				requestDependentCount: number;
				promptPerMillion: NumericRange;
				completionPerMillion: NumericRange;
				request: NumericRange;
				image: NumericRange;
				evaluatedAt: string;
				businessTimezone: string;
			};
			performance: {
				windowSeconds: number;
				checkedRoutes: number;
				truncated: boolean;
				sampledRoutes: number;
				unsampledRoutes: number;
				sampleCount: number;
				p50LatencyMs: number | null;
				p50ThroughputTokensPerSecond: number | null;
			};
			requestDependent: { wildcardOperationCount: number; explicitEndpointOptInCount: number };
			circuit: { evaluated: false; scope: 'dispatch_isolate' };
		};
	};
};

function formatRange(range: NumericRange, fractionDigits = 4): string {
	if (range.minimum == null || range.maximum == null) return '—';
	const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: fractionDigits });
	return range.minimum === range.maximum
		? format(range.minimum)
		: `${format(range.minimum)}–${format(range.maximum)}`;
}

function formatNullable(value: number | null, fractionDigits = 1): string {
	return value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: fractionDigits });
}

function Tags({
	values,
	nullLabel,
	emptyLabel,
}: {
	values: string[] | null;
	nullLabel: string;
	emptyLabel: string;
}) {
	if (values === null) return <span className="console-muted text-xs">{nullLabel}</span>;
	if (values.length === 0) return <span className="console-muted text-xs">{emptyLabel}</span>;
	return <div className="flex flex-wrap gap-1.5">{values.map((value) => (
		<span key={value.toLowerCase()} className="rounded-full border px-2 py-0.5 text-xs">{value}</span>
	))}</div>;
}

export default function EffectiveGuardrailPreview({
	mode,
	workspaceId,
	keys,
}: {
	mode: 'user' | 'admin';
	workspaceId: string;
	keys: GatewayKey[];
}) {
	const t = useTranslations('guardrails');
	const [apiKeyId, setApiKeyId] = useState('');
	const [adminWorkspaceId, setAdminWorkspaceId] = useState('');
	const [adminUserId, setAdminUserId] = useState('');
	const [adminApiKeyId, setAdminApiKeyId] = useState('');
	const [preview, setPreview] = useState<EffectivePreview | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const activeWorkspaceIdRef = useRef(workspaceId);
	const requestIdRef = useRef(0);
	activeWorkspaceIdRef.current = workspaceId;

	useEffect(() => {
		requestIdRef.current += 1;
		setApiKeyId('');
		setPreview(null);
		setError(null);
		setLoading(false);
	}, [workspaceId]);

	const loadPreview = async () => {
		const requestedWorkspaceId = mode === 'user' ? workspaceId : adminWorkspaceId.trim();
		const requestedUserId = mode === 'admin' ? adminUserId.trim() : '';
		const requestedApiKeyId = mode === 'user' ? apiKeyId : adminApiKeyId.trim();
		if (!requestedWorkspaceId || (mode === 'admin' && !requestedUserId)) {
			setError(t('previewRequired'));
			return;
		}
		const requestId = ++requestIdRef.current;
		const query = new URLSearchParams();
		if (mode === 'admin') {
			query.set('workspace_id', requestedWorkspaceId);
			query.set('user_id', requestedUserId);
		}
		if (requestedApiKeyId) query.set('api_key_id', requestedApiKeyId);
		setLoading(true);
		setError(null);
		try {
			const response = await fetch(`/api/${mode}/guardrails/effective?${query.toString()}`, { cache: 'no-store' });
			const payload = await readPortalJson<EffectivePreview>(response);
			if (!response.ok || !payload?.success || !payload.data) {
				throw new Error(payload?.message ?? t('previewFailed'));
			}
			if (requestId !== requestIdRef.current
				|| (mode === 'user' && activeWorkspaceIdRef.current !== requestedWorkspaceId)) return;
			if (payload.data.workspaceId !== requestedWorkspaceId
				|| (mode === 'admin' && payload.data.userId !== requestedUserId)
				|| payload.data.apiKeyId !== (requestedApiKeyId || null)) {
				throw new Error(t('previewFailed'));
			}
			setPreview(payload.data);
		} catch (caught) {
			if (requestId !== requestIdRef.current) return;
			setPreview(null);
			setError(caught instanceof Error ? caught.message : t('previewFailed'));
		} finally {
			if (requestId === requestIdRef.current) setLoading(false);
		}
	};

	const zdrGroups = preview
		? Object.entries(preview.effective.zdr).filter(([, required]) => required).map(([group]) => group)
		: [];
	const evidenceReasonLabels = preview ? {
		provider_missing: t('previewReasonProviderMissing'),
		shared_channel: t('previewReasonSharedChannel'),
		policy_missing: t('previewReasonPolicyMissing'),
		policy_expired: t('previewReasonPolicyExpired'),
		policy_unverified: t('previewReasonPolicyUnverified'),
		subject_mismatch: t('previewReasonSubjectMismatch'),
		subject_unverifiable: t('previewReasonSubjectUnverifiable'),
		zdr_not_supported: t('previewReasonZdrUnsupported'),
		no_collection_not_supported: t('previewReasonCollectionUnsupported'),
	} : null;
	const plannerReasonLabels: Record<PlannerExclusionReason, string> | null = preview ? {
		provider_missing: t('previewPlannerReasonProviderMissing'),
		provider_inactive: t('previewPlannerReasonProviderInactive'),
		provider_credential_missing: t('previewPlannerReasonCredentialMissing'),
		provider_shared_channel: t('previewPlannerReasonSharedChannel'),
		provider_protocol_unsupported: t('previewPlannerReasonProtocolUnsupported'),
		endpoint_binding_missing: t('previewPlannerReasonBindingMissing'),
		endpoint_binding_ambiguous: t('previewPlannerReasonBindingAmbiguous'),
		endpoint_invalid: t('previewPlannerReasonEndpointInvalid'),
		endpoint_identity_mismatch: t('previewPlannerReasonIdentityMismatch'),
		endpoint_subject_unverifiable: t('previewPlannerReasonSubjectUnverifiable'),
		endpoint_subject_mismatch: t('previewPlannerReasonSubjectMismatch'),
		endpoint_metadata_drift: t('previewPlannerReasonMetadataDrift'),
		operation_unsupported: t('previewPlannerReasonOperationUnsupported'),
	} : null;

	return <section className="console-panel rounded-xl border p-4 sm:p-6" style={{ borderColor: 'var(--console-border)' }}>
		<div>
			<h2 className="font-semibold">{t('previewTitle')}</h2>
			<p className="console-muted mt-1 text-xs">{t('previewHint')}</p>
		</div>
		{mode === 'user' ? <label className="mt-4 block text-sm">
			{t('previewIdentity')}
			<select className="console-input mt-1 w-full rounded-lg border px-3 py-2" value={apiKeyId} onChange={(event) => setApiKeyId(event.target.value)}>
				<option value="">{t('previewUserOnly')}</option>
				{keys.filter((key) => key.status === 'active').map((key) => (
					<option key={key.id} value={key.id}>{key.name || key.key}</option>
				))}
			</select>
		</label> : <div className="mt-4 grid gap-3 lg:grid-cols-3">
			<label className="text-sm">{t('workspace')}<input className="console-input mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs" value={adminWorkspaceId} onChange={(event) => setAdminWorkspaceId(event.target.value)} /></label>
			<label className="text-sm">{t('previewUserId')}<input className="console-input mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs" value={adminUserId} onChange={(event) => setAdminUserId(event.target.value)} /></label>
			<label className="text-sm">{t('previewApiKeyId')}<input className="console-input mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs" value={adminApiKeyId} onChange={(event) => setAdminApiKeyId(event.target.value)} /></label>
		</div>}
		<button type="button" disabled={loading || (mode === 'user' && !workspaceId)} onClick={() => void loadPreview()} className="mt-4 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50">
			{loading ? t('previewLoading') : t('previewAction')}
		</button>
		{error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
		{preview ? <div className="mt-5 space-y-5 border-t pt-5" style={{ borderColor: 'var(--console-border)' }}>
			{(() => {
				const planner = preview.routeCandidates.plannerEvidence;
				return <div className="space-y-3">
					<h3 className="text-sm font-semibold">{t('previewPlannerEvidence')}</h3>
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
						<div className="rounded-lg border p-3"><p className="console-muted text-xs">{t('previewPlannerEligible')}</p><p className="mt-1 text-sm font-semibold">{t('previewEligibleFraction', { eligible: planner.staticallyEligibleCount, checked: planner.checkedCount })}</p></div>
						<div className="rounded-lg border p-3"><p className="console-muted text-xs">{t('previewPlannerCapability')}</p><p className="mt-1 text-sm font-semibold">{t('previewPlannerCapabilityValue', { verified: planner.operationCapabilities.verifiedCount, requestDependent: planner.operationCapabilities.requestDependentCount })}</p></div>
						<div className="rounded-lg border p-3"><p className="console-muted text-xs">{t('previewPlannerCapacity')}</p><p className="mt-1 text-sm font-semibold">{t('previewPlannerCapacityValue', { known: planner.outputCapacity.knownCount, applicable: planner.outputCapacity.applicableCount, range: formatRange({ minimum: planner.outputCapacity.minimumTokens, maximum: planner.outputCapacity.maximumTokens }, 0) })}</p></div>
						<div className="rounded-lg border p-3"><p className="console-muted text-xs">{t('previewPlannerPerformance')}</p><p className="mt-1 text-sm font-semibold">{t('previewPlannerPerformanceValue', { sampled: planner.performance.sampledRoutes, checked: planner.performance.checkedRoutes, latency: formatNullable(planner.performance.p50LatencyMs, 0), throughput: formatNullable(planner.performance.p50ThroughputTokensPerSecond) })}</p></div>
					</div>
					<div className="rounded-lg border p-3 text-xs">
						<p className="font-medium">{t('previewPlannerPricing')}</p>
						<p className="console-muted mt-1">{t('previewPlannerPricingValue', { comparable: planner.pricing.comparableCount, prompt: formatRange(planner.pricing.promptPerMillion), completion: formatRange(planner.pricing.completionPerMillion), request: formatRange(planner.pricing.request), image: formatRange(planner.pricing.image), timezone: planner.pricing.businessTimezone })}</p>
					</div>
					{planner.excludedCount > 0 && plannerReasonLabels ? <div>
						<h4 className="mb-2 text-xs font-semibold">{t('previewPlannerExclusions')}</h4>
						<div className="flex flex-wrap gap-2">{Object.entries(planner.excludedByReason).map(([reason, count]) => (
							<span key={reason} className="rounded-full border px-2 py-1 text-xs">{plannerReasonLabels[reason as PlannerExclusionReason]}: {count}</span>
						))}</div>
					</div> : null}
					{planner.requestDependent.wildcardOperationCount > 0 || planner.requestDependent.explicitEndpointOptInCount > 0 || planner.pricing.requestDependentCount > 0
						? <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">{t('previewPlannerRequestDependent', { wildcard: planner.requestDependent.wildcardOperationCount, endpoint: planner.requestDependent.explicitEndpointOptInCount })}</p>
						: null}
					{planner.performance.truncated ? <p className="rounded-lg border p-3 text-xs">{t('previewPlannerPerformanceTruncated')}</p> : null}
					<p className="rounded-lg border p-3 text-xs">{t('previewPlannerCircuitDispatchOnly')}</p>
				</div>;
			})()}
			<div className="grid gap-3 sm:grid-cols-3">
				<div className="rounded-lg border p-3"><p className="console-muted text-xs">{t('previewLayers')}</p><p className="mt-1 text-xl font-semibold">{preview.trace.length}</p></div>
				<div className="rounded-lg border p-3"><p className="console-muted text-xs">{t('previewCandidateRoutes')}</p><p className="mt-1 text-xl font-semibold">{preview.routeCandidates.count}</p></div>
				<div className="rounded-lg border p-3"><p className="console-muted text-xs">{t('previewEndpointEvidence')}</p><p className="mt-1 text-sm font-semibold">{preview.routeCandidates.routeEvidence.required
					? t('previewEligibleFraction', { eligible: preview.routeCandidates.routeEvidence.eligibleCount, checked: preview.routeCandidates.routeEvidence.checkedCount })
					: t('notRequired')}</p></div>
			</div>
			<div className="grid gap-4 lg:grid-cols-2">
				<div><h3 className="mb-2 text-sm font-semibold">{t('previewAllowedModels')}</h3><Tags values={preview.effective.allowedModels} nullLabel={t('unrestricted')} emptyLabel="∅" /></div>
				<div><h3 className="mb-2 text-sm font-semibold">{t('previewIgnoredModels')}</h3><Tags values={preview.effective.ignoredModels} nullLabel={t('none')} emptyLabel={t('none')} /></div>
				<div><h3 className="mb-2 text-sm font-semibold">{t('previewAllowedProviders')}</h3><Tags values={preview.effective.allowedProviders} nullLabel={t('unrestricted')} emptyLabel="∅" /></div>
				<div><h3 className="mb-2 text-sm font-semibold">{t('previewIgnoredProviders')}</h3><Tags values={preview.effective.ignoredProviders} nullLabel={t('none')} emptyLabel={t('none')} /></div>
			</div>
			<div className="rounded-lg border p-3 text-xs">
				<p>{t('previewPrivacy', {
					collection: preview.effective.dataCollection === 'deny' ? t('denied') : t('callerDefault'),
					zdr: preview.effective.requireZdr ? t('allModels') : (zdrGroups.join(', ') || t('none')),
				})}</p>
				<p className="console-muted mt-1">{t('previewFilters', {
					builtins: preview.effective.contentFilterBuiltins.length,
					input: preview.effective.inputFilters.length,
					output: preview.effective.outputFilters.length,
					budgets: preview.effective.budgets.length,
				})}</p>
			</div>
			<div><h3 className="mb-2 text-sm font-semibold">{t('previewCandidateModels')}</h3><Tags values={preview.routeCandidates.modelIds} nullLabel={t('none')} emptyLabel={t('none')} /></div>
			<div><h3 className="mb-2 text-sm font-semibold">{t('previewCandidateProviders')}</h3><Tags values={preview.routeCandidates.providers} nullLabel={t('none')} emptyLabel={t('none')} /></div>
			{preview.routeCandidates.routeEvidence.excludedCount > 0 && evidenceReasonLabels ? <div>
				<h3 className="mb-2 text-sm font-semibold">{t('previewEvidenceExclusions')}</h3>
				<div className="flex flex-wrap gap-2">{Object.entries(preview.routeCandidates.routeEvidence.excludedByReason).map(([reason, count]) => (
					<span key={reason} className="rounded-full border px-2 py-1 text-xs">{evidenceReasonLabels[reason as keyof typeof evidenceReasonLabels]}: {count}</span>
				))}</div>
			</div> : null}
			{preview.routeCandidates.truncated ? <p className="rounded-lg border p-3 text-xs">{t('previewTruncatedWarning')}</p> : null}
			{preview.routeCandidates.requiresEndpointEvidence ? <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">{t('previewEvidenceWarning')}</p> : null}
			<div><h3 className="mb-2 text-sm font-semibold">{t('previewLayers')}</h3><div className="space-y-2">{preview.trace.map((layer) => (
				<div key={layer.assignmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
					<span>{layer.guardrailName} · v{layer.version}</span><code>{layer.scopeType}:{layer.scopeId}</code>
				</div>
			))}</div></div>
		</div> : null}
	</section>;
}
