'use client';

import {
	ArrowDownIcon,
	ArrowPathIcon,
	ArrowUpIcon,
	KeyIcon,
	PencilSquareIcon,
	PlusIcon,
	TrashIcon,
	XMarkIcon,
} from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useTransition,
} from 'react';
import { usePortalWorkspace } from '@/components/portal/PortalWorkspaceContext';
import { readPortalJson } from '@/lib/portal-fetch';

type ByokKey = {
	id: string;
	workspace_id: string;
	provider: string;
	name: string | null;
	label: string;
	disabled: boolean;
	is_fallback: boolean;
	always_use_for_provider: boolean;
	always_use_for_matching_models: boolean;
	sort_order: number;
	allowed_models: string[] | null;
	allowed_user_ids: string[] | null;
	allowed_api_key_hashes: string[] | null;
	created_at: string;
};

type SharedCapacityPolicy = 'allow' | 'matching_models' | 'provider';

type ByokListEnvelope = {
	success?: boolean;
	data?: ByokKey[];
	message?: string;
	total?: number;
	workspaceId?: string;
};

type FormState = {
	provider: string;
	name: string;
	key: string;
	isFallback: boolean;
	sharedCapacityPolicy: SharedCapacityPolicy;
	disabled: boolean;
	allowedModels: string;
	allowedUserIds: string;
	allowedApiKeyHashes: string;
};

const PAGE_SIZE = 50;
const EMPTY_FORM: FormState = {
	provider: '',
	name: '',
	key: '',
	isFallback: false,
	sharedCapacityPolicy: 'allow',
	disabled: false,
	allowedModels: '',
	allowedUserIds: '',
	allowedApiKeyHashes: '',
};

function ordered(rows: ByokKey[]): ByokKey[] {
	return rows.toSorted((left, right) =>
		Number(left.is_fallback) - Number(right.is_fallback)
		|| left.sort_order - right.sort_order
		|| left.id.localeCompare(right.id),
	);
}

function listValue(value: string): string[] | null {
	const items = value
		.split(/[\n,]/u)
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? [...new Set(items)] : null;
}

function editForm(row: ByokKey): FormState {
	return {
		provider: row.provider,
		name: row.name ?? '',
		key: '',
		isFallback: row.is_fallback,
		sharedCapacityPolicy: row.always_use_for_provider
			? 'provider'
			: row.always_use_for_matching_models
				? 'matching_models'
				: 'allow',
		disabled: row.disabled,
		allowedModels: row.allowed_models?.join('\n') ?? '',
		allowedUserIds: row.allowed_user_ids?.join('\n') ?? '',
		allowedApiKeyHashes: row.allowed_api_key_hashes?.join('\n') ?? '',
	};
}

export default function ByokCredentialManager() {
	const t = useTranslations('portal.byok');
	const { context, isSwitching } = usePortalWorkspace();
	const workspaceId = context?.currentWorkspace.id ?? '';
	const workspaceName = context?.currentWorkspace.name ?? workspaceId;
	const activeWorkspaceIdRef = useRef(workspaceId);
	activeWorkspaceIdRef.current = workspaceId;
	const [rows, setRows] = useState<ByokKey[]>([]);
	const [total, setTotal] = useState(0);
	const [page, setPage] = useState(0);
	const [providerFilter, setProviderFilter] = useState('');
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<FormState>(EMPTY_FORM);
	const [isMutating, startMutation] = useTransition();

	const load = useCallback(async (signal?: AbortSignal) => {
		if (!workspaceId) {
			setRows([]);
			setTotal(0);
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			const query = new URLSearchParams({
				offset: String(page * PAGE_SIZE),
				limit: String(PAGE_SIZE),
			});
			if (providerFilter.trim()) query.set('provider', providerFilter.trim().toLowerCase());
			const response = await fetch(`/api/user/byok?${query}`, { cache: 'no-store', signal });
			const payload = await response.json().catch(() => null) as ByokListEnvelope | null;
			if (signal?.aborted) return;
			if (!response.ok || !payload?.success || payload.workspaceId !== workspaceId) {
				setRows([]);
				setTotal(0);
				setMessage({ error: true, text: payload?.message ?? t('loadFailed') });
				return;
			}
			const nextRows = payload.data ?? [];
			if (nextRows.some((row) => row.workspace_id !== workspaceId)) {
				setRows([]);
				setTotal(0);
				setMessage({ error: true, text: t('loadFailed') });
				return;
			}
			setRows(nextRows);
			setTotal(payload.total ?? 0);
			setMessage(null);
		} catch (error) {
			if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
			setRows([]);
			setTotal(0);
			setMessage({ error: true, text: t('loadFailed') });
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	}, [page, providerFilter, t, workspaceId]);

	useEffect(() => {
		const controller = new AbortController();
		setEditorOpen(false);
		setEditingId(null);
		setForm(EMPTY_FORM);
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const groups = useMemo(() => {
		const map = new Map<string, ByokKey[]>();
		for (const row of rows) {
			const group = map.get(row.provider) ?? [];
			group.push(row);
			map.set(row.provider, group);
		}
		return [...map.entries()]
			.map(([provider, providerRows]) => [provider, ordered(providerRows)] as const)
			.toSorted(([left], [right]) => left.localeCompare(right));
	}, [rows]);

	const openCreate = (provider = '') => {
		setEditingId(null);
		setForm({ ...EMPTY_FORM, provider });
		setEditorOpen(true);
		setMessage(null);
	};

	const openEdit = (row: ByokKey) => {
		if (row.workspace_id !== workspaceId) return;
		setEditingId(row.id);
		setForm(editForm(row));
		setEditorOpen(true);
		setMessage(null);
	};

	const closeEditor = () => {
		if (isMutating) return;
		setEditorOpen(false);
		setEditingId(null);
		setForm(EMPTY_FORM);
	};

	const mutate = async (
		url: string,
		init: RequestInit,
		fallback: string,
	): Promise<ByokKey | null> => {
		const response = await fetch(url, init);
		const payload = await readPortalJson<ByokKey>(response);
		if (!response.ok || !payload?.success) {
			throw new Error(payload?.message ?? fallback);
		}
		if (payload.data && payload.data.workspace_id !== activeWorkspaceIdRef.current) {
			throw new Error(t('workspaceChanged'));
		}
		return payload.data ?? null;
	};

	const save = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!workspaceId || isMutating) return;
		startMutation(async () => {
			try {
				const common = {
					name: form.name.trim() || null,
					disabled: form.disabled,
					is_fallback: form.isFallback,
					always_use_for_provider:
						!form.isFallback && form.sharedCapacityPolicy === 'provider',
					always_use_for_matching_models:
						!form.isFallback && form.sharedCapacityPolicy === 'matching_models',
					allowed_models: listValue(form.allowedModels),
					allowed_user_ids: listValue(form.allowedUserIds),
					allowed_api_key_hashes: listValue(form.allowedApiKeyHashes),
				};
				if (editingId) {
					await mutate(`/api/user/byok/${encodeURIComponent(editingId)}`, {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ ...common, ...(form.key ? { key: form.key } : {}) }),
					}, t('saveFailed'));
				} else {
					await mutate('/api/user/byok', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							...common,
							workspace_id: workspaceId,
							provider: form.provider.trim().toLowerCase(),
							key: form.key,
						}),
					}, t('saveFailed'));
				}
				setEditorOpen(false);
				setEditingId(null);
				setForm(EMPTY_FORM);
				setMessage({ error: false, text: t(editingId ? 'updated' : 'created') });
				await load();
			} catch (error) {
				setMessage({ error: true, text: error instanceof Error ? error.message : t('saveFailed') });
			}
		});
	};

	const patchRow = (row: ByokKey, patch: Record<string, unknown>) => {
		if (row.workspace_id !== workspaceId || isMutating) return;
		startMutation(async () => {
			try {
				await mutate(`/api/user/byok/${encodeURIComponent(row.id)}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(patch),
				}, t('updateFailed'));
				setMessage({ error: false, text: t('updated') });
				await load();
			} catch (error) {
				setMessage({ error: true, text: error instanceof Error ? error.message : t('updateFailed') });
			}
		});
	};

	const fetchProvider = async (provider: string): Promise<ByokKey[]> => {
		const response = await fetch(`/api/user/byok?provider=${encodeURIComponent(provider)}&limit=100`, {
			cache: 'no-store',
		});
		const payload = await response.json().catch(() => null) as ByokListEnvelope | null;
		if (!response.ok || !payload?.success || payload.workspaceId !== activeWorkspaceIdRef.current) {
			throw new Error(payload?.message ?? t('reorderFailed'));
		}
		if ((payload.total ?? 0) !== (payload.data?.length ?? 0)) throw new Error(t('reorderFailed'));
		return ordered(payload.data ?? []);
	};

	const reorder = async (provider: string, nextRows: ByokKey[]) => {
		const response = await fetch('/api/user/byok/reorder', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				workspace_id: activeWorkspaceIdRef.current,
				provider,
				keys: nextRows.map((row) => ({ id: row.id, is_fallback: row.is_fallback })),
			}),
		});
		const payload = await readPortalJson(response);
		if (!response.ok || !payload?.success) throw new Error(payload?.message ?? t('reorderFailed'));
	};

	const move = (row: ByokKey, direction: -1 | 1) => {
		if (row.workspace_id !== workspaceId || isMutating) return;
		startMutation(async () => {
			try {
				const providerRows = await fetchProvider(row.provider);
				const index = providerRows.findIndex((item) => item.id === row.id);
				const target = index + direction;
				if (
					index < 0
					|| target < 0
					|| target >= providerRows.length
					|| providerRows[index].is_fallback !== providerRows[target].is_fallback
				) return;
				[providerRows[index], providerRows[target]] = [providerRows[target], providerRows[index]];
				await reorder(row.provider, providerRows);
				setMessage({ error: false, text: t('reordered') });
				await load();
			} catch (error) {
				setMessage({ error: true, text: error instanceof Error ? error.message : t('reorderFailed') });
			}
		});
	};

	const changePartition = (row: ByokKey) => {
		if (row.workspace_id !== workspaceId || isMutating) return;
		startMutation(async () => {
			try {
				if (
					!row.is_fallback
					&& (row.always_use_for_provider || row.always_use_for_matching_models)
				) {
					await mutate(`/api/user/byok/${encodeURIComponent(row.id)}`, {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							always_use_for_provider: false,
							always_use_for_matching_models: false,
						}),
					}, t('updateFailed'));
				}
				const providerRows = await fetchProvider(row.provider);
				const current = providerRows.find((item) => item.id === row.id);
				if (!current) throw new Error(t('reorderFailed'));
				const targetFallback = !current.is_fallback;
				const changed = {
					...current,
					is_fallback: targetFallback,
					always_use_for_provider: false,
					always_use_for_matching_models: false,
				};
				const remaining = providerRows.filter((item) => item.id !== row.id);
				const primary = remaining.filter((item) => !item.is_fallback);
				const fallback = remaining.filter((item) => item.is_fallback);
				await reorder(row.provider, targetFallback
					? [...primary, ...fallback, changed]
					: [...primary, changed, ...fallback]);
				setMessage({ error: false, text: t('reordered') });
				await load();
			} catch (error) {
				setMessage({ error: true, text: error instanceof Error ? error.message : t('reorderFailed') });
			}
		});
	};

	const remove = (row: ByokKey) => {
		if (row.workspace_id !== workspaceId || isMutating || !window.confirm(t('confirmDelete', {
			name: row.name ?? `${row.provider} ${row.label}`,
		}))) return;
		startMutation(async () => {
			try {
				const response = await fetch(`/api/user/byok/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
				const payload = await readPortalJson(response);
				if (!response.ok || !payload?.success) throw new Error(payload?.message ?? t('deleteFailed'));
				setMessage({ error: false, text: t('deleted') });
				await load();
			} catch (error) {
				setMessage({ error: true, text: error instanceof Error ? error.message : t('deleteFailed') });
			}
		});
	};

	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return (
		<div className="w-full min-w-0 max-w-full overflow-hidden space-y-6">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
					<p className="console-muted mt-1 max-w-3xl text-sm leading-6">{t('subtitle')}</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<span className="console-badge hidden rounded-full px-2.5 py-1 text-xs sm:inline-flex">
						{t('workspaceScope', { name: workspaceName })}
					</span>
					<button
						type="button"
						disabled={!workspaceId || isSwitching || isMutating}
						onClick={() => openCreate()}
						className="inline-flex items-center gap-2 rounded-lg bg-neutral-950 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
					>
						<PlusIcon className="h-4 w-4" />
						{t('add')}
					</button>
				</div>
			</div>

			<div className="console-panel flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center" style={{ borderColor: 'var(--console-border)' }}>
				<label className="min-w-0 flex-1">
					<span className="sr-only">{t('providerFilter')}</span>
					<input
						value={providerFilter}
						onChange={(event) => { setProviderFilter(event.target.value.toLowerCase()); setPage(0); }}
						placeholder={t('providerFilterPlaceholder')}
						className="console-input w-full rounded-lg border px-3 py-2 text-sm"
					/>
				</label>
				<button type="button" onClick={() => void load()} disabled={loading || isMutating} className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-50">
					<ArrowPathIcon className="h-4 w-4" />{t('refresh')}
				</button>
			</div>

			{message && (
				<div className={`rounded-lg border p-3 text-sm ${message.error
					? 'border-red-400/40 bg-red-500/10 text-red-600'
					: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-600'}`}>
					{message.text}
				</div>
			)}

			{loading ? (
				<div className="console-muted py-16 text-center text-sm">{t('loading')}</div>
			) : groups.length === 0 ? (
				<div className="console-panel rounded-xl border px-5 py-16 text-center" style={{ borderColor: 'var(--console-border)' }}>
					<KeyIcon className="console-muted mx-auto h-8 w-8" />
					<h2 className="mt-3 text-sm font-semibold">{t('empty')}</h2>
					<p className="console-muted mt-1 text-sm">{t('emptyHint')}</p>
					<button type="button" onClick={() => openCreate(providerFilter)} className="mt-4 text-sm font-medium text-cyan-600 hover:text-cyan-500">{t('add')}</button>
				</div>
			) : (
				<div className="min-w-0 max-w-full space-y-4">
					{groups.map(([provider, providerRows]) => (
						<section key={provider} className="console-panel min-w-0 max-w-full overflow-hidden rounded-xl border" style={{ borderColor: 'var(--console-border)' }}>
							<div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--console-border)' }}>
								<div className="min-w-0">
									<h2 className="truncate text-sm font-semibold">{provider}</h2>
									<p className="console-muted text-xs">{t('credentialCount', { count: providerRows.length })}</p>
								</div>
								<button type="button" onClick={() => openCreate(provider)} className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-600 hover:text-cyan-500">
									<PlusIcon className="h-3.5 w-3.5" />{t('addToProvider', { provider })}
								</button>
							</div>
							<div className="max-w-full overflow-x-auto">
								<table className="w-full min-w-[1040px] text-left text-sm">
									<thead className="console-muted text-xs">
										<tr className="border-b" style={{ borderColor: 'var(--console-border)' }}>
											<th className="px-4 py-2.5 font-medium">{t('name')}</th>
											<th className="px-4 py-2.5 font-medium">{t('type')}</th>
											<th className="px-4 py-2.5 font-medium">{t('status')}</th>
											<th className="px-4 py-2.5 font-medium">{t('restrictions')}</th>
											<th className="px-4 py-2.5 font-medium">{t('sharedCapacity')}</th>
											<th className="px-4 py-2.5 text-right font-medium">{t('actions')}</th>
										</tr>
									</thead>
									<tbody>
										{providerRows.map((row, index) => {
											const samePartitionBefore = index > 0 && providerRows[index - 1].is_fallback === row.is_fallback;
											const samePartitionAfter = index + 1 < providerRows.length && providerRows[index + 1].is_fallback === row.is_fallback;
											return (
												<tr key={row.id} className="border-b last:border-0" style={{ borderColor: 'var(--console-border)' }}>
													<td className="px-4 py-3">
														<div className="font-medium">{row.name || t('unnamed')}</div>
														<code className="console-muted text-xs">{row.label}</code>
													</td>
													<td className="px-4 py-3"><span className="console-badge rounded-md px-2 py-1 text-xs">{t(row.is_fallback ? 'fallback' : 'primary')}</span></td>
													<td className="px-4 py-3"><span className="inline-flex items-center gap-1.5 text-xs"><span className={`h-1.5 w-1.5 rounded-full ${row.disabled ? 'bg-neutral-400' : 'bg-emerald-500'}`} />{t(row.disabled ? 'disabled' : 'enabled')}</span></td>
													<td className="console-muted px-4 py-3 text-xs leading-5">
														<div>{t('modelsCount', { count: row.allowed_models?.length ?? 0 })}</div>
														<div>{t('usersCount', { count: row.allowed_user_ids?.length ?? 0 })}</div>
														<div>{t('gatewayKeysCount', { count: row.allowed_api_key_hashes?.length ?? 0 })}</div>
													</td>
											<td className="px-4 py-3">
												<span className="console-badge rounded-md px-2 py-1 text-xs">
													{t(row.always_use_for_provider
														? 'sharedCapacityProvider'
														: row.always_use_for_matching_models
															? 'sharedCapacityMatching'
															: 'sharedCapacityAllow')}
												</span>
											</td>
													<td className="px-4 py-3">
														<div className="flex justify-end gap-1">
															<button type="button" disabled={!samePartitionBefore || isMutating} onClick={() => move(row, -1)} aria-label={t('moveUp')} className="rounded-md border p-1.5 disabled:opacity-30"><ArrowUpIcon className="h-3.5 w-3.5" /></button>
															<button type="button" disabled={!samePartitionAfter || isMutating} onClick={() => move(row, 1)} aria-label={t('moveDown')} className="rounded-md border p-1.5 disabled:opacity-30"><ArrowDownIcon className="h-3.5 w-3.5" /></button>
															<button type="button" disabled={isMutating} onClick={() => changePartition(row)} className="rounded-md border px-2 py-1 text-xs disabled:opacity-50">{t(row.is_fallback ? 'makePrimary' : 'makeFallback')}</button>
															<button type="button" disabled={isMutating} onClick={() => patchRow(row, { disabled: !row.disabled })} className="rounded-md border px-2 py-1 text-xs disabled:opacity-50">{t(row.disabled ? 'enable' : 'disable')}</button>
															<button type="button" disabled={isMutating} onClick={() => openEdit(row)} aria-label={t('edit')} className="rounded-md border p-1.5 disabled:opacity-50"><PencilSquareIcon className="h-3.5 w-3.5" /></button>
															<button type="button" disabled={isMutating} onClick={() => remove(row)} aria-label={t('delete')} className="rounded-md border border-red-500/30 p-1.5 text-red-500 disabled:opacity-50"><TrashIcon className="h-3.5 w-3.5" /></button>
														</div>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						</section>
					))}
				</div>
			)}

			{pageCount > 1 && (
				<div className="flex items-center justify-between gap-3 text-sm">
					<span className="console-muted">{t('pagination', { page: page + 1, pages: pageCount, total })}</span>
					<div className="flex gap-2">
						<button type="button" disabled={page === 0 || loading} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded-md border px-3 py-1.5 disabled:opacity-40">{t('previous')}</button>
						<button type="button" disabled={page + 1 >= pageCount || loading} onClick={() => setPage((value) => value + 1)} className="rounded-md border px-3 py-1.5 disabled:opacity-40">{t('next')}</button>
					</div>
				</div>
			)}

			{editorOpen && (
				<div className="fixed inset-0 z-50 flex justify-end bg-black/25" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
					<section role="dialog" aria-modal="true" aria-labelledby="byok-editor-title" className="console-panel flex h-full w-full max-w-xl flex-col border-l shadow-2xl" style={{ borderColor: 'var(--console-border)' }}>
						<div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--console-border)' }}>
							<h2 id="byok-editor-title" className="text-lg font-semibold">{t(editingId ? 'editTitle' : 'createTitle')}</h2>
							<button type="button" onClick={closeEditor} aria-label={t('close')} className="rounded-md p-1.5 hover:bg-black/5 dark:hover:bg-white/10"><XMarkIcon className="h-5 w-5" /></button>
						</div>
						<form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
							<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
								<label className="block text-sm font-medium">{t('provider')}<input required disabled={Boolean(editingId)} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={128} value={form.provider} onChange={(event) => setForm((value) => ({ ...value, provider: event.target.value.toLowerCase() }))} placeholder={t('providerPlaceholder')} className="console-input mt-1.5 w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-60" /></label>
								<label className="block text-sm font-medium">{t('name')}<input maxLength={255} value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} placeholder={t('namePlaceholder')} className="console-input mt-1.5 w-full rounded-lg border px-3 py-2 text-sm" /></label>
								<label className="block text-sm font-medium">{t(editingId ? 'replacementKey' : 'secretKey')}<input required={!editingId} type="password" autoComplete="new-password" value={form.key} onChange={(event) => setForm((value) => ({ ...value, key: event.target.value }))} placeholder={t(editingId ? 'replacementKeyPlaceholder' : 'secretKeyPlaceholder')} className="console-input mt-1.5 w-full rounded-lg border px-3 py-2 font-mono text-sm" /><span className="console-muted mt-1 block text-xs">{t('secretHint')}</span></label>
								<fieldset className="space-y-2"><legend className="text-sm font-medium">{t('routingType')}</legend><label className="flex items-start gap-2 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--console-border)' }}><input type="radio" checked={!form.isFallback} onChange={() => setForm((value) => ({ ...value, isFallback: false }))} className="mt-0.5" /><span><span className="block font-medium">{t('primary')}</span><span className="console-muted text-xs">{t('primaryHint')}</span></span></label><label className="flex items-start gap-2 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--console-border)' }}><input type="radio" checked={form.isFallback} onChange={() => setForm((value) => ({ ...value, isFallback: true, sharedCapacityPolicy: 'allow' }))} className="mt-0.5" /><span><span className="block font-medium">{t('fallback')}</span><span className="console-muted text-xs">{t('fallbackHint')}</span></span></label></fieldset>
								<label className="block border-y py-4 text-sm font-medium" style={{ borderColor: 'var(--console-border)' }}>
									{t('sharedCapacity')}
									<select
										disabled={form.isFallback}
										value={form.isFallback ? 'allow' : form.sharedCapacityPolicy}
										onChange={(event) => setForm((value) => ({
											...value,
											sharedCapacityPolicy: event.target.value as SharedCapacityPolicy,
										}))}
										className="console-input mt-1.5 w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
									>
										<option value="allow">{t('sharedCapacityAllow')}</option>
										<option value="matching_models">{t('sharedCapacityMatching')}</option>
										<option value="provider">{t('sharedCapacityProvider')}</option>
									</select>
									<span className="console-muted mt-1 block text-xs leading-5">{t('sharedCapacityHint')}</span>
								</label>
								<label className="block text-sm font-medium">{t('allowedModels')}<textarea rows={3} value={form.allowedModels} onChange={(event) => setForm((value) => ({ ...value, allowedModels: event.target.value }))} placeholder={t('listPlaceholder')} className="console-input mt-1.5 w-full rounded-lg border px-3 py-2 font-mono text-xs" /><span className="console-muted mt-1 block text-xs">{t('allowedModelsHint')}</span></label>
								<label className="block text-sm font-medium">{t('allowedUserIds')}<textarea rows={3} value={form.allowedUserIds} onChange={(event) => setForm((value) => ({ ...value, allowedUserIds: event.target.value }))} placeholder={t('listPlaceholder')} className="console-input mt-1.5 w-full rounded-lg border px-3 py-2 font-mono text-xs" /><span className="console-muted mt-1 block text-xs">{t('allowedUserIdsHint')}</span></label>
								<label className="block text-sm font-medium">{t('allowedGatewayKeyHashes')}<textarea rows={3} value={form.allowedApiKeyHashes} onChange={(event) => setForm((value) => ({ ...value, allowedApiKeyHashes: event.target.value }))} placeholder={t('hashListPlaceholder')} className="console-input mt-1.5 w-full rounded-lg border px-3 py-2 font-mono text-xs" /><span className="console-muted mt-1 block text-xs">{t('allowedGatewayKeyHashesHint')}</span></label>
								<label className="flex items-start justify-between gap-4 border-t pt-4" style={{ borderColor: 'var(--console-border)' }}><span><span className="block text-sm font-medium">{t('disabled')}</span><span className="console-muted mt-1 block text-xs">{t('disabledHint')}</span></span><input type="checkbox" checked={form.disabled} onChange={(event) => setForm((value) => ({ ...value, disabled: event.target.checked }))} className="mt-1 h-4 w-4" /></label>
							</div>
							<div className="flex items-center justify-end gap-2 border-t px-5 py-4" style={{ borderColor: 'var(--console-border)' }}><button type="button" onClick={closeEditor} disabled={isMutating} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">{t('cancel')}</button><button type="submit" disabled={isMutating || isSwitching || !workspaceId} className="rounded-lg bg-neutral-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-950">{isMutating ? t('saving') : t('save')}</button></div>
						</form>
					</section>
				</div>
			)}
		</div>
	);
}
