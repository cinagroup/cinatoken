'use client';
import { OMIT_AUDIT_LOG_SNAPSHOT_FIELDS } from '@/lib/audit-log-display';

/**
 * 全站用户审计日志（`user_audit_logs`）：筛选、分页；数据来自 `/api/admin/budget-audit-logs`。
 */
import { FilterDisclosure } from '@/components/FilterDisclosure';
import { useTranslations } from 'next-intl';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Link from 'next/link';
import { readApiJson } from '@/lib/api-json';
import {
	API_KEY_BUDGET_AUDIT_ACTOR_TYPES,
	API_KEY_BUDGET_AUDIT_EVENT_TYPES,
	API_KEY_BUDGET_AUDIT_SOURCE_CHANNELS,
	type GatewayApiKeyBudgetAuditLog,
} from '@/lib/types';
import { GatewayTimeRangePicker } from '@/components/GatewayTimeRangePicker';
import {
	createRangeValue,
	DEFAULT_GATEWAY_TIME_RANGE_PRESET,
	detectRollingPreset,
	type GatewayTimeRangeValue,
} from '@/lib/analytics-range';
import { useListPageBrowserReady, useReplaceListPageQuery } from '@/lib/use-replace-list-query';
import { formatGatewayDateTime } from '@/lib/datetime';
import { formatGatewayMoneyCode, formatGatewayMoneyCodeSigned } from '@/lib/format-gateway-currency';
import { GATEWAY_MONEY_DECIMAL_PLACES } from '@/lib/gateway-money';
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown';
import { AuditChangeDetailModal, AuditLogSharedCells } from '@/components/AuditLogSharedCells';
import { auditEnumLabel } from '@/lib/audit-log-display';
import { useBillingCurrency } from '@/lib/use-billing-currency';
import { useGatewayDateTime } from '@/lib/use-gateway-datetime';

const DEFAULT_AUDIT_LOG_EVENT_TYPES = API_KEY_BUDGET_AUDIT_EVENT_TYPES.filter((type) => type !== 'usage_charge');
const AUDIT_LOG_EVENT_TYPE_SET = new Set<string>(API_KEY_BUDGET_AUDIT_EVENT_TYPES);
const DEFAULT_AUDIT_LOG_ACTOR_TYPES = [...API_KEY_BUDGET_AUDIT_ACTOR_TYPES];
const AUDIT_LOG_ACTOR_TYPE_SET = new Set<string>(API_KEY_BUDGET_AUDIT_ACTOR_TYPES);
const DEFAULT_AUDIT_LOG_SOURCE_CHANNELS = [...API_KEY_BUDGET_AUDIT_SOURCE_CHANNELS];
const AUDIT_LOG_SOURCE_CHANNEL_SET = new Set<string>(API_KEY_BUDGET_AUDIT_SOURCE_CHANNELS);
/** 筛选 UI 不含历史 Master Key；全选时不传 `actor_kind`，默认列表仍含老 `admin:` 行。 */
const AUDIT_LOG_ACTOR_KIND_FILTERS = ['console', 'admin_key', 'system', 'service', 'portal'] as const;
const AUDIT_LOG_ACTOR_KIND_FILTER_SET = new Set<string>(AUDIT_LOG_ACTOR_KIND_FILTERS);

type AuditLogFilterOptions = {
	reasonCodes: string[];
};

function normalizeAuditEventTypes(values: string[]): string[] {
	const normalized: string[] = [];
	values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.forEach((value) => {
			if (AUDIT_LOG_EVENT_TYPE_SET.has(value) && !normalized.includes(value)) normalized.push(value);
		});
	return normalized;
}

function normalizeAuditActorTypes(values: string[]): string[] {
	const normalized: string[] = [];
	values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.forEach((value) => {
			if (AUDIT_LOG_ACTOR_TYPE_SET.has(value) && !normalized.includes(value)) normalized.push(value);
		});
	return normalized;
}

function normalizeAuditActorKinds(values: string[]): string[] {
	const normalized: string[] = [];
	values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.forEach((value) => {
			if (AUDIT_LOG_ACTOR_KIND_FILTER_SET.has(value) && !normalized.includes(value)) normalized.push(value);
		});
	return normalized;
}

/** `actor_id` 形如 `<kind>:<identifier>`；未知或缺失前缀时 kind 为 null，整串按标识符展示。 */
function parseAuditActorId(actorId: string | null | undefined): {
	kind: string | null;
	identifier: string;
} {
	if (!actorId) return { kind: null, identifier: '' };
	const separator = actorId.indexOf(':');
	if (separator === -1) return { kind: null, identifier: actorId };
	const kind = actorId.slice(0, separator);
	if (!AUDIT_LOG_ACTOR_KIND_FILTER_SET.has(kind)) return { kind: null, identifier: actorId };
	return { kind, identifier: actorId.slice(separator + 1) };
}

function normalizeAuditSourceChannels(values: string[]): string[] {
	const normalized: string[] = [];
	values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.forEach((value) => {
			if (AUDIT_LOG_SOURCE_CHANNEL_SET.has(value) && !normalized.includes(value)) normalized.push(value);
		});
	return normalized;
}

function normalizeAuditReasonCodes(values: string[]): string[] {
	const normalized: string[] = [];
	values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.forEach((value) => {
			if (value !== '' && !normalized.includes(value)) normalized.push(value);
		});
	return normalized;
}

function isSameStringSet(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const rightSet = new Set(right);
	return left.every((value) => rightSet.has(value));
}

/** 浏览器 URL：Default（8 种，不含 usage_charge）省略参数，短链刷新仍还原为 Default UI。 */
function appendAuditEventTypeUrlParams(params: URLSearchParams, eventTypes: string[]): void {
	if (isSameStringSet(eventTypes, DEFAULT_AUDIT_LOG_EVENT_TYPES)) return;
	eventTypes.forEach((eventType) => params.append('event_type', eventType));
}

/** API 查询：仅全选 9 种时省略（不过滤）；Default 必须带上 8 个 event_type。 */
function appendAuditEventTypeQueryParams(params: URLSearchParams, eventTypes: string[]): void {
	if (isSameStringSet(eventTypes, API_KEY_BUDGET_AUDIT_EVENT_TYPES)) return;
	eventTypes.forEach((eventType) => params.append('event_type', eventType));
}

function appendAuditActorTypeParams(params: URLSearchParams, actorTypes: string[]): void {
	if (actorTypes.length === DEFAULT_AUDIT_LOG_ACTOR_TYPES.length) return;
	actorTypes.forEach((actorType) => params.append('actor_type', actorType));
}

function appendAuditActorKindParams(params: URLSearchParams, actorKinds: string[]): void {
	if (actorKinds.length === AUDIT_LOG_ACTOR_KIND_FILTERS.length) return;
	actorKinds.forEach((actorKind) => params.append('actor_kind', actorKind));
}

function appendAuditSourceParams(params: URLSearchParams, sources: string[]): void {
	if (sources.length === DEFAULT_AUDIT_LOG_SOURCE_CHANNELS.length) return;
	sources.forEach((source) => params.append('source', source));
}

function appendAuditReasonCodeParams(params: URLSearchParams, reasonCodes: string[], allReasonCodes: string[]): void {
	const selectedSet = new Set(reasonCodes);
	const isAllSelected = allReasonCodes.length > 0 && allReasonCodes.every((reasonCode) => selectedSet.has(reasonCode));
	if (reasonCodes.length === 0 || isAllSelected) return;
	reasonCodes.forEach((reasonCode) => params.append('reason_code', reasonCode));
}

/** change_payload 展开行：去掉已由 Budget plan / Time / Event 列展示的键 */
function shouldOmitChangePayloadDisplayLine(line: string): boolean {
	const colon = line.indexOf(':');
	const key = (colon === -1 ? line : line.slice(0, colon)).trim();
	if (!key) return false;
	if (key.startsWith('before_budget_') || key.startsWith('after_budget_')) return true;
	if (['actor_id', 'reason_code', 'reason_text', 'source', 'correlation_id'].includes(key)) return true;
	return false;
}

function formatSignedMoney(value: number, currency: string): string {
	return formatGatewayMoneyCodeSigned(value, currency, GATEWAY_MONEY_DECIMAL_PLACES);
}

function formatPlainMoney(value: number, currency: string): string {
	return formatGatewayMoneyCode(value, currency, GATEWAY_MONEY_DECIMAL_PLACES);
}

function formatBudgetMax(value: number | null, currency: string, noLimitLabel = 'no limit'): string {
	if (value == null) return noLimitLabel;
	return formatGatewayMoneyCode(value, currency, GATEWAY_MONEY_DECIMAL_PLACES);
}

function formatAuditTime(iso: string | null | undefined, timeZone: string): string {
	if (iso == null || iso === '') return '—';
	return formatGatewayDateTime(iso, timeZone);
}

function shortId(id: string | null | undefined): string {
	if (id == null || id === '') return '—';
	if (id.length < 14) return id;
	return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** Reason 行：code / text 并存且不同时压缩为一行「code · text」，否则单行。 */
function auditReasonOneLine(
	reasonCode: string | null | undefined,
	reasonText: string | null | undefined,
): {
	line: string;
	isMono: boolean;
	title: string;
} {
	const rc = (reasonCode ?? '').trim();
	const rt = (reasonText ?? '').trim();
	if (!rc && !rt) return { line: '—', isMono: true, title: '' };
	if (rc && rt && rc !== rt) {
		const line = `${rc} · ${rt}`;
		return { line, isMono: false, title: line };
	}
	const single = rt || rc;
	return { line: single, isMono: !!rc && !rt, title: single };
}

/** 从 `change_payload` 解析的扩展字段（与 `@octafuse/core` `mergeUserAuditChangePayload` 写入结构对齐） */
function auditDisplayExtras(item: GatewayApiKeyBudgetAuditLog) {
	let m: Record<string, unknown> = {};
	try {
		const raw = item.change_payload;
		if (raw) m = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		/* keep empty */
	}
	const str = (v: unknown) => (typeof v === 'string' ? v : null);
	return {
		reason_text: item.reason_text ?? str(m.reason_text),
		reason_code: item.reason_code ?? str(m.reason_code),
		actor_id: item.actor_id ?? str(m.actor_id),
		source: item.source ?? str(m.source),
		correlation_id: item.correlation_id ?? str(m.correlation_id),
		before_budget_period: item.before_budget_period ?? str(m.before_budget_period),
		after_budget_period: item.after_budget_period ?? str(m.after_budget_period),
		before_budget_reset_at: item.before_budget_reset_at ?? str(m.before_budget_reset_at),
		after_budget_reset_at: item.after_budget_reset_at ?? str(m.after_budget_reset_at),
	};
}

function isAuditObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** 与网关金额精度一致，用于判断 budget_max / budget_base 是否变化 */
function budgetMoneySemanticallyEqual(before: number | null | undefined, after: number | null | undefined): boolean {
	if (before == null && after == null) return true;
	if (before == null || after == null) return false;
	return before.toFixed(GATEWAY_MONEY_DECIMAL_PLACES) === after.toFixed(GATEWAY_MONEY_DECIMAL_PLACES);
}

function budgetResetAtSemanticallyEqual(before: string | null | undefined, after: string | null | undefined): boolean {
	if ((before == null || before === '') && (after == null || after === '')) return true;
	if (!before || !after) return false;
	const tb = new Date(before).getTime();
	const ta = new Date(after).getTime();
	if (Number.isNaN(tb) || Number.isNaN(ta)) return before === after;
	return tb === ta;
}

const budgetPlanHighlight = {
	before: 'rounded px-0.5 bg-amber-50 text-amber-900',
	after: 'rounded px-0.5 bg-sky-50 text-sky-900',
} as const;

type AuditDiffRow = {
	group: 'snapshot' | 'payload';
	field: string;
	before: string;
	after: string;
};

function parseAuditJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (isAuditObject(parsed)) return parsed;
	} catch {
		/* keep null */
	}
	return null;
}

function parseAuditChangedFields(raw: string | null | undefined): string[] | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
	} catch {
		return null;
	}
}

function formatAuditDiffValue(value: unknown): string {
	if (value == null || value === '') return '—';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function pushAuditDiffRow(
	rows: AuditDiffRow[],
	group: AuditDiffRow['group'],
	field: string,
	before: unknown,
	after: unknown,
) {
	const beforeText = formatAuditDiffValue(before);
	const afterText = formatAuditDiffValue(after);
	if (beforeText === afterText) return;
	rows.push({ group, field, before: beforeText, after: afterText });
}

function pushNestedAuditDiffRows(
	rows: AuditDiffRow[],
	group: AuditDiffRow['group'],
	field: string,
	before: unknown,
	after: unknown,
	depth = 0,
) {
	if ((isAuditObject(before) || isAuditObject(after)) && depth < 4) {
		const beforeObject = isAuditObject(before) ? before : {};
		const afterObject = isAuditObject(after) ? after : {};
		const keys = Array.from(new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)]));
		keys.forEach((key) => {
			pushNestedAuditDiffRows(rows, group, `${field}.${key}`, beforeObject[key], afterObject[key], depth + 1);
		});
		return;
	}
	pushAuditDiffRow(rows, group, field, before, after);
}

function appendSnapshotDiffRows(rows: AuditDiffRow[], item: GatewayApiKeyBudgetAuditLog) {
	const before = parseAuditJsonObject(item.before_user_snapshot ?? null);
	const after = parseAuditJsonObject(item.after_user_snapshot ?? null);
	if (!before && !after) return;

	const fields = parseAuditChangedFields(item.changed_fields ?? null);
	const keys =
		fields && fields.length > 0
			? fields
			: Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).filter((key) => key !== 'id');
	const omitted = new Set<string>(OMIT_AUDIT_LOG_SNAPSHOT_FIELDS);
	keys.forEach((key) => {
		if (omitted.has(key)) return;
		pushNestedAuditDiffRows(rows, 'snapshot', key, before?.[key], after?.[key]);
	});
}

function appendPayloadDiffRows(rows: AuditDiffRow[], raw: string | null | undefined) {
	const payload = parseAuditJsonObject(raw);
	if (!payload) return;

	const handled = new Set<string>();
	const status = payload.status;
	if (isAuditObject(status) && ('from' in status || 'to' in status)) {
		pushAuditDiffRow(rows, 'payload', 'status', status.from, status.to);
		handled.add('status');
	}

	const metadata = payload.metadata;
	if (isAuditObject(metadata)) {
		handled.add('metadata');
		const changes = metadata.changes;
		if (isAuditObject(changes)) {
			Object.entries(changes).forEach(([key, value]) => {
				if (isAuditObject(value) && ('from' in value || 'to' in value)) {
					pushAuditDiffRow(rows, 'payload', `metadata.${key}`, value.from, value.to);
				} else {
					pushAuditDiffRow(rows, 'payload', `metadata.${key}`, '—', value);
				}
			});
		} else if ('from' in metadata || 'to' in metadata) {
			pushAuditDiffRow(rows, 'payload', 'metadata', metadata.from, metadata.to);
			pushNestedAuditDiffRows(rows, 'payload', 'metadata', metadata.from, metadata.to);
		} else {
			Object.entries(metadata).forEach(([key, value]) => {
				if (key === 'operation') return;
				pushAuditDiffRow(rows, 'payload', `metadata.${key}`, '—', value);
			});
		}
	}

	Object.entries(payload).forEach(([key, value]) => {
		if (handled.has(key)) return;
		if (key.startsWith('before_') || key.startsWith('after_')) return;
		if (key === 'metadata_patch_keys' || shouldOmitChangePayloadDisplayLine(`${key}:`)) return;
		if (isAuditObject(value) && ('from' in value || 'to' in value)) {
			pushAuditDiffRow(rows, 'payload', key, value.from, value.to);
		}
	});

	Object.keys(payload)
		.filter((key) => key.startsWith('before_'))
		.forEach((beforeKey) => {
			const suffix = beforeKey.slice('before_'.length);
			const afterKey = `after_${suffix}`;
			if (!(afterKey in payload)) return;
			if (shouldOmitChangePayloadDisplayLine(beforeKey) || shouldOmitChangePayloadDisplayLine(afterKey)) return;
			pushAuditDiffRow(rows, 'payload', suffix, payload[beforeKey], payload[afterKey]);
		});
}

function auditDiffRows(item: GatewayApiKeyBudgetAuditLog): AuditDiffRow[] {
	const rows: AuditDiffRow[] = [];
	appendSnapshotDiffRows(rows, item);
	appendPayloadDiffRows(rows, item.change_payload);
	const seen = new Set<string>();
	return rows.filter((row) => {
		const key = `${row.field}:${row.before}:${row.after}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function isSerializedAuditObject(value: string): boolean {
	return isAuditObject(parseAuditJsonObject(value));
}

function auditSummaryDiffRows(rows: AuditDiffRow[]): AuditDiffRow[] {
	return rows.filter((row) => {
		if (row.field === 'metadata') return false;
		if (isSerializedAuditObject(row.before) || isSerializedAuditObject(row.after)) return false;
		return true;
	});
}

function createAuditInitialFilters() {
	const params = new URLSearchParams(window.location.search);
	const startDate = params.get('start_date');
	const endDate = params.get('end_date');
	const hasStart = startDate != null && startDate !== '';
	const hasEnd = endDate != null && endDate !== '';
	const start = hasStart ? startDate : '';
	const end = hasEnd ? endDate : '';
	const eventTypes = normalizeAuditEventTypes(params.getAll('event_type'));
	const actorTypes = normalizeAuditActorTypes(params.getAll('actor_type'));
	const actorKinds = normalizeAuditActorKinds(params.getAll('actor_kind'));
	const sources = normalizeAuditSourceChannels(params.getAll('source'));
	const parsedPage = parseInt(params.get('page') ?? '', 10);
	return {
		apiKeyId: params.get('api_key_id') ?? '',
		userId: params.get('user_id') ?? '',
		userEmail: params.get('user_email') ?? '',
		eventTypes: eventTypes.length > 0 ? eventTypes : [...DEFAULT_AUDIT_LOG_EVENT_TYPES],
		actorTypes: actorTypes.length > 0 ? actorTypes : [...DEFAULT_AUDIT_LOG_ACTOR_TYPES],
		actorKinds: actorKinds.length > 0 ? actorKinds : [...AUDIT_LOG_ACTOR_KIND_FILTERS],
		actorId: params.get('actor_id') ?? '',
		reasonCodes: normalizeAuditReasonCodes(params.getAll('reason_code')),
		sources: sources.length > 0 ? sources : [...DEFAULT_AUDIT_LOG_SOURCE_CHANNELS],
		correlationId: params.get('correlation_id') ?? '',
		rangeValue:
			hasStart || hasEnd
				? ({
						preset: hasStart && hasEnd ? (detectRollingPreset(start, end) ?? 'custom') : 'custom',
						start_date: start,
						end_date: end,
					} satisfies GatewayTimeRangeValue)
				: createRangeValue(DEFAULT_GATEWAY_TIME_RANGE_PRESET),
		page: !Number.isNaN(parsedPage) && parsedPage >= 1 ? parsedPage : 1,
	};
}

export default function GatewayAuditLogsPage() {
	const tCommon = useTranslations('common');
	const browserReady = useListPageBrowserReady();
	return browserReady ? <GatewayAuditLogs /> : <div className="p-8 text-gray-600">{tCommon('loading')}</div>;
}

function GatewayAuditLogs() {
	const t = useTranslations('auditLogs');
	const tCommon = useTranslations('common');
	const [initialFilters] = useState(createAuditInitialFilters);
	const [page, setPage] = useState(initialFilters.page);
	const pageSize = 50;
	const { currency: billingCurrency } = useBillingCurrency();
	const { businessTimezone } = useGatewayDateTime();

	const [filterApiKeyId, setFilterApiKeyId] = useState(initialFilters.apiKeyId);
	const [filterUserId, setFilterUserId] = useState(initialFilters.userId);
	const [filterUserEmail, setFilterUserEmail] = useState(initialFilters.userEmail);
	const [filterEventTypes, setFilterEventTypes] = useState(initialFilters.eventTypes);
	const [filterActorTypes, setFilterActorTypes] = useState(initialFilters.actorTypes);
	const [filterActorKinds, setFilterActorKinds] = useState<string[]>(initialFilters.actorKinds);
	const [filterActorId, setFilterActorId] = useState(initialFilters.actorId);
	const [filterReasonCodes, setFilterReasonCodes] = useState(initialFilters.reasonCodes);
	const [filterSources, setFilterSources] = useState(initialFilters.sources);
	const [reasonCodeOptions, setReasonCodeOptions] = useState<string[]>([]);
	const [filterCorrelationId, setFilterCorrelationId] = useState(initialFilters.correlationId);
	const [rangeValue, setRangeValue] = useState<GatewayTimeRangeValue>(initialFilters.rangeValue);
	const [detailLog, setDetailLog] = useState<GatewayApiKeyBudgetAuditLog | null>(null);
	const reasonCodeUrlFilter = initialFilters.reasonCodes.length > 0;

	useEffect(() => {
		const controller = new AbortController();
		async function fetchFilterOptions() {
			try {
				const response = await fetch('/api/admin/budget-audit-logs/filters', {
					signal: controller.signal,
				});
				const data = await readApiJson<AuditLogFilterOptions>(response);
				if (!data.success || controller.signal.aborted) return;
				const options = data.data?.reasonCodes ?? [];
				setReasonCodeOptions(options);
				if (!reasonCodeUrlFilter) {
					setFilterReasonCodes(options);
				}
			} catch (e) {
				if (controller.signal.aborted) return;
				console.error('Fetch audit log filter options error:', e);
			}
		}
		fetchFilterOptions();
		return () => controller.abort();
	}, [reasonCodeUrlFilter]);

	useReplaceListPageQuery(() => {
		const params = new URLSearchParams({
			page: page.toString(),
			page_size: pageSize.toString(),
		});
		if (filterApiKeyId) params.append('api_key_id', filterApiKeyId);
		if (filterUserId) params.append('user_id', filterUserId);
		if (filterUserEmail) params.append('user_email', filterUserEmail);
		appendAuditEventTypeUrlParams(params, filterEventTypes);
		appendAuditActorTypeParams(params, filterActorTypes);
		appendAuditActorKindParams(params, filterActorKinds);
		if (filterActorId) params.append('actor_id', filterActorId);
		appendAuditReasonCodeParams(params, filterReasonCodes, reasonCodeOptions);
		appendAuditSourceParams(params, filterSources);
		if (filterCorrelationId) params.append('correlation_id', filterCorrelationId);
		if (rangeValue.start_date) params.append('start_date', rangeValue.start_date);
		if (rangeValue.end_date) params.append('end_date', rangeValue.end_date);
		return params;
	}, [
		page,
		pageSize,
		filterApiKeyId,
		filterUserId,
		filterUserEmail,
		filterEventTypes,
		filterActorTypes,
		filterActorKinds,
		filterActorId,
		filterReasonCodes,
		filterSources,
		reasonCodeOptions,
		filterCorrelationId,
		rangeValue.start_date,
		rangeValue.end_date,
	]);

	const request = useMemo(() => {
		const params = new URLSearchParams({
			page: page.toString(),
			page_size: pageSize.toString(),
		});
		if (filterApiKeyId) params.append('api_key_id', filterApiKeyId);
		if (filterUserId) params.append('user_id', filterUserId);
		if (filterUserEmail) params.append('user_email', filterUserEmail);
		appendAuditEventTypeUrlParams(params, filterEventTypes);
		appendAuditActorTypeParams(params, filterActorTypes);
		appendAuditActorKindParams(params, filterActorKinds);
		if (filterActorId) params.append('actor_id', filterActorId);
		appendAuditReasonCodeParams(params, filterReasonCodes, reasonCodeOptions);
		appendAuditSourceParams(params, filterSources);
		if (filterCorrelationId) params.append('correlation_id', filterCorrelationId);
		if (rangeValue.start_date) params.append('start_date', rangeValue.start_date);
		if (rangeValue.end_date) params.append('end_date', rangeValue.end_date);

		return { url: `/api/admin/budget-audit-logs?${params.toString()}` };
	}, [
		page,
		filterApiKeyId,
		filterUserId,
		filterUserEmail,
		filterEventTypes,
		filterActorTypes,
		filterActorKinds,
		filterActorId,
		filterReasonCodes,
		filterSources,
		reasonCodeOptions,
		filterCorrelationId,
		rangeValue.start_date,
		rangeValue.end_date,
		pageSize,
	]);
	const [result, setResult] = useState<{
		request: typeof request | null;
		logs: GatewayApiKeyBudgetAuditLog[];
		total: number;
	}>({ request: null, logs: [], total: 0 });
	const { logs, total } = result;
	const isLoading = result.request !== request;

	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			try {
				const response = await fetch(request.url, {
					signal: controller.signal,
				});
				const data = await readApiJson<GatewayApiKeyBudgetAuditLog[]>(response);
				if (controller.signal.aborted) return;
				if (data.success) {
					setResult({ request, logs: data.data || [], total: data.total || 0 });
				} else {
					setResult((current) => ({ ...current, request }));
				}
			} catch (e) {
				if (controller.signal.aborted) return;
				console.error('Fetch budget audit logs error:', e);
				setResult((current) => ({ ...current, request }));
			}
		})();
		return () => controller.abort();
	}, [request]);

	const totalPages = Math.ceil(total / pageSize);
	const setEventTypeChecked = (eventType: string, checked: boolean) => {
		setFilterEventTypes((current) => {
			if (checked) return current.includes(eventType) ? current : [...current, eventType];
			if (current.length <= 1) return current;
			return current.filter((value) => value !== eventType);
		});
		setPage(1);
	};
	const setActorTypeChecked = (actorType: string, checked: boolean) => {
		setFilterActorTypes((current) => {
			if (checked) return current.includes(actorType) ? current : [...current, actorType];
			if (current.length <= 1) return current;
			return current.filter((value) => value !== actorType);
		});
		setPage(1);
	};
	const setActorKindChecked = (actorKind: string, checked: boolean) => {
		setFilterActorKinds((current) => {
			if (checked) return current.includes(actorKind) ? current : [...current, actorKind];
			if (current.length <= 1) return current;
			return current.filter((value) => value !== actorKind);
		});
		setPage(1);
	};
	const setSourceChecked = (source: string, checked: boolean) => {
		setFilterSources((current) => {
			if (checked) return current.includes(source) ? current : [...current, source];
			if (current.length <= 1) return current;
			return current.filter((value) => value !== source);
		});
		setPage(1);
	};
	const setReasonCodeChecked = (reasonCode: string, checked: boolean) => {
		setFilterReasonCodes((current) => {
			if (checked) return current.includes(reasonCode) ? current : [...current, reasonCode];
			if (current.length <= 1) return current;
			return current.filter((value) => value !== reasonCode);
		});
		setPage(1);
	};

	return (
		<div className="min-w-0 p-4 sm:p-6 lg:p-8">
			<div className="mb-6">
				<h1 className="text-3xl font-bold text-gray-900">{t('title')}</h1>
				<p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
			</div>

			<div className="mb-4 w-full min-w-0">
				<GatewayTimeRangePicker
					value={rangeValue}
					onChange={(v) => {
						setRangeValue(v);
						setPage(1);
					}}
				/>
			</div>

			<FilterDisclosure
				className="mb-4 rounded-xl border border-gray-200 bg-white p-3 sm:p-4 shadow-sm"
				activeCount={
					[filterActorId, filterUserEmail, filterCorrelationId, filterUserId, filterApiKeyId].filter(Boolean).length +
					Number(!isSameStringSet(filterEventTypes, DEFAULT_AUDIT_LOG_EVENT_TYPES)) +
					Number(!isSameStringSet(filterSources, DEFAULT_AUDIT_LOG_SOURCE_CHANNELS)) +
					Number(!isSameStringSet(filterReasonCodes, reasonCodeOptions)) +
					Number(!isSameStringSet(filterActorTypes, DEFAULT_AUDIT_LOG_ACTOR_TYPES)) +
					Number(!isSameStringSet(filterActorKinds, AUDIT_LOG_ACTOR_KIND_FILTERS))
				}
			>
				<div className="admin-filter-grid">
					<MultiSelectDropdown
						label={t('filters.eventType')}
						options={API_KEY_BUDGET_AUDIT_EVENT_TYPES.map((eventType) => ({
							value: eventType,
							label: auditEnumLabel(t, 'eventTypes', eventType),
							title: eventType,
						}))}
						selected={filterEventTypes}
						onToggle={setEventTypeChecked}
						headerActions={
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={() => {
										setFilterEventTypes([...API_KEY_BUDGET_AUDIT_EVENT_TYPES]);
										setPage(1);
									}}
									className="text-blue-600 hover:underline"
								>
									{tCommon('selectAll')}
								</button>
								<span className="text-gray-300">|</span>
								<button
									type="button"
									onClick={() => {
										setFilterEventTypes([...DEFAULT_AUDIT_LOG_EVENT_TYPES]);
										setPage(1);
									}}
									className="text-blue-600 hover:underline"
								>
									{t('filters.defaultEventTypes')}
								</button>
							</div>
						}
					/>
					<MultiSelectDropdown
						label={t('filters.source')}
						options={API_KEY_BUDGET_AUDIT_SOURCE_CHANNELS.map((source) => ({
							value: source,
							label: auditEnumLabel(t, 'sourceChannels', source),
							title: source,
						}))}
						selected={filterSources}
						onToggle={setSourceChecked}
						headerActions={
							<button
								type="button"
								onClick={() => {
									setFilterSources([...DEFAULT_AUDIT_LOG_SOURCE_CHANNELS]);
									setPage(1);
								}}
								className="text-blue-600 hover:underline"
							>
								{tCommon('selectAll')}
							</button>
						}
					/>
					<MultiSelectDropdown
						label={t('filters.reasonCode')}
						options={reasonCodeOptions.map((reasonCode) => ({
							value: reasonCode,
							label: reasonCode,
							mono: true,
						}))}
						selected={filterReasonCodes}
						onToggle={setReasonCodeChecked}
						emptyText={t('filters.noReasonCodes')}
						headerActions={
							<button
								type="button"
								onClick={() => {
									setFilterReasonCodes([...reasonCodeOptions]);
									setPage(1);
								}}
								className="text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline"
								disabled={reasonCodeOptions.length === 0}
							>
								{tCommon('selectAll')}
							</button>
						}
					/>
					<MultiSelectDropdown
						label={t('filters.actor')}
						options={API_KEY_BUDGET_AUDIT_ACTOR_TYPES.map((actorType) => ({
							value: actorType,
							label: auditEnumLabel(t, 'actorTypes', actorType),
							title: actorType,
						}))}
						selected={filterActorTypes}
						onToggle={setActorTypeChecked}
						align="end"
						headerActions={
							<button
								type="button"
								onClick={() => {
									setFilterActorTypes([...DEFAULT_AUDIT_LOG_ACTOR_TYPES]);
									setPage(1);
								}}
								className="text-blue-600 hover:underline"
							>
								{tCommon('selectAll')}
							</button>
						}
					/>
					<MultiSelectDropdown
						label={t('filters.actorKind')}
						options={AUDIT_LOG_ACTOR_KIND_FILTERS.map((actorKind) => ({
							value: actorKind,
							label: auditEnumLabel(t, 'actorKinds', actorKind),
							title: actorKind,
						}))}
						selected={filterActorKinds}
						onToggle={setActorKindChecked}
						align="end"
						headerActions={
							<button
								type="button"
								onClick={() => {
									setFilterActorKinds([...AUDIT_LOG_ACTOR_KIND_FILTERS]);
									setPage(1);
								}}
								className="text-blue-600 hover:underline"
							>
								{tCommon('selectAll')}
							</button>
						}
					/>
				</div>

				<div className="admin-filter-grid mt-4">
					<div>
						<label className="block text-sm text-gray-500 mb-1">{t('filters.actorId')}</label>
						<input
							type="text"
							value={filterActorId}
							onChange={(e) => {
								setFilterActorId(e.target.value);
								setPage(1);
							}}
							placeholder={t('filters.actorIdPlaceholder')}
							className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs"
						/>
					</div>
					<div>
						<label className="block text-sm text-gray-500 mb-1">{t('filters.userEmail')}</label>
						<input
							type="text"
							value={filterUserEmail}
							onChange={(e) => {
								setFilterUserEmail(e.target.value);
								setPage(1);
							}}
							placeholder={t('filters.exactMatch')}
							className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
						/>
					</div>
					<div>
						<label className="block text-sm text-gray-500 mb-1">{t('filters.correlationId')}</label>
						<input
							type="text"
							value={filterCorrelationId}
							onChange={(e) => {
								setFilterCorrelationId(e.target.value);
								setPage(1);
							}}
							placeholder={t('filters.correlationPlaceholder')}
							className="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs"
						/>
					</div>
					<div className="flex items-end">
						<button
							type="button"
							onClick={() => {
								setFilterEventTypes([...DEFAULT_AUDIT_LOG_EVENT_TYPES]);
								setFilterActorTypes([...DEFAULT_AUDIT_LOG_ACTOR_TYPES]);
								setFilterActorKinds([...AUDIT_LOG_ACTOR_KIND_FILTERS]);
								setFilterActorId('');
								setFilterReasonCodes([...reasonCodeOptions]);
								setFilterSources([...DEFAULT_AUDIT_LOG_SOURCE_CHANNELS]);
								setFilterCorrelationId('');
								setFilterUserEmail('');
								setFilterUserId('');
								setFilterApiKeyId('');
								setRangeValue({
									preset: 'custom',
									start_date: '',
									end_date: '',
								});
								setPage(1);
							}}
							className="h-10 whitespace-nowrap px-4 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
						>
							{tCommon('clearFiltersLower')}
						</button>
					</div>
				</div>
			</FilterDisclosure>

			<div className="mb-3 text-sm text-gray-500">{t('totalRecords', { count: total })}</div>

			{isLoading ? (
				<div className="flex items-center justify-center py-16 text-gray-600">{tCommon('loading')}</div>
			) : (
				<div className="bg-white rounded-lg shadow-md overflow-hidden">
					<div className="overflow-x-auto max-h-[calc(100vh-16rem)] overflow-y-auto">
						<table className="min-w-full divide-y divide-gray-200 text-sm">
							<thead className="bg-gray-50 sticky top-0 z-10">
								<tr>
									<th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">
										{t('table.time')}
									</th>
									<th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap min-w-[11rem] max-w-[15rem]">
										{t('table.event')}
									</th>
									<th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap min-w-[8.5rem] max-w-[12rem]">
										{t('table.actor')}
									</th>
									<th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap min-w-[14rem]">
										{t('table.identity')}
									</th>
									<th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase min-w-[14rem]">
										{t('table.budget')}
									</th>
									<th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase min-w-[12rem]">
										{t('table.periodPlan')}
									</th>
									<th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase min-w-[14rem]">
										{t('table.wallet')}
									</th>
									<th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase min-w-[16rem]">
										{t('table.userChangeDetail')}
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-100 bg-white">
								{logs.length === 0 ? (
									<tr>
										<td colSpan={8} className="px-4 py-8 text-center text-gray-500">
											{t('empty')}
										</td>
									</tr>
								) : (
									logs.map((item) => (
										<tr key={item.id} className="hover:bg-gray-50">
											<AuditLogSharedCells
												item={item}
												currency={billingCurrency}
												timezone={businessTimezone}
												onViewDetail={setDetailLog}
											/>
										</tr>
									))
								)}
							</tbody>
						</table>
					</div>
				</div>
			)}

			{detailLog ? (
				<AuditChangeDetailModal item={detailLog} timezone={businessTimezone} onClose={() => setDetailLog(null)} />
			) : null}

			{totalPages > 1 && !isLoading && (
				<div className="mt-4 flex justify-center gap-2">
					<button
						type="button"
						onClick={() => setPage(Math.max(1, page - 1))}
						disabled={page === 1}
						className="px-4 py-2 border border-gray-300 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
					>
						{tCommon('previous')}
					</button>
					<span className="px-4 py-2 text-sm text-gray-600">{tCommon('pageOf', { page, totalPages })}</span>
					<button
						type="button"
						onClick={() => setPage(Math.min(totalPages, page + 1))}
						disabled={page === totalPages}
						className="px-4 py-2 border border-gray-300 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
					>
						{tCommon('next')}
					</button>
				</div>
			)}
		</div>
	);
}
