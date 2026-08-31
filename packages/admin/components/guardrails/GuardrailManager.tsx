'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useOptionalPortalWorkspace } from '@/components/portal/PortalWorkspaceContext';
import { readPortalJson } from '@/lib/portal-fetch';

type Guardrail = { id: string; workspaceId: string; ownerUserId: string; name: string; description: string | null; status: 'active' | 'archived'; designatedVersion: number; latestVersion: number; config: Record<string, unknown> | null; updatedAt: string };
type Version = { id: string; version: number; config: Record<string, unknown> | null; createdAt: string };
type Assignment = { id: string; workspaceId: string; guardrailId: string; scopeType: 'user' | 'api_key'; scopeId: string; createdAt: string };
type GatewayKey = { id: string; workspaceId: string; name: string | null; key: string; status: string };
type PortalMe = { userId: string };
type UserGuardrailCollection = { workspaceId: string; guardrails: Guardrail[] };

const DEFAULT_CONFIG = `{
  "allowed_models": [],
  "allowed_providers": [],
  "input_filters": [],
  "output_filters": [],
  "require_zdr": false
}`;

export default function GuardrailManager({ mode }: { mode: 'user' | 'admin' }) {
	const t = useTranslations('guardrails');
	const portalWorkspace = useOptionalPortalWorkspace();
	const workspaceId = mode === 'user' ? portalWorkspace?.context?.currentWorkspace.id ?? '' : '';
	const workspaceName = mode === 'user' ? portalWorkspace?.context?.currentWorkspace.name ?? '' : '';
	const activeWorkspaceIdRef = useRef(workspaceId);
	activeWorkspaceIdRef.current = workspaceId;
	const base = mode === 'user' ? '/api/user/guardrails' : '/api/admin/guardrails';
	const [rows, setRows] = useState<Guardrail[]>([]);
	const [versions, setVersions] = useState<Record<string, Version[]>>({});
	const [assignments, setAssignments] = useState<Record<string, Assignment[]>>({});
	const [expanded, setExpanded] = useState<string | null>(null);
	const [keys, setKeys] = useState<GatewayKey[]>([]);
	const [me, setMe] = useState<PortalMe | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [adminScope, setAdminScope] = useState<Record<string, { type: 'user' | 'api_key'; id: string }>>({});
	const [form, setForm] = useState({ name: '', description: '', config: DEFAULT_CONFIG });

	const load = useCallback(async (signal?: AbortSignal) => {
		if (mode === 'user' && !workspaceId) {
			setRows([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			const response = await fetch(base, { cache: 'no-store', signal });
			const payload = await readPortalJson<Guardrail[] | UserGuardrailCollection>(response);
			if (signal?.aborted) return;
			if (!response.ok || !payload?.success) throw new Error(payload?.message ?? t('loadFailed'));
			const data = payload.data;
			const responseWorkspaceId = mode === 'user' && data && !Array.isArray(data) ? data.workspaceId : null;
			const nextRows = Array.isArray(data) ? data : data?.guardrails ?? [];
			if (mode === 'user' && (responseWorkspaceId !== workspaceId
				|| nextRows.some((row) => row.workspaceId !== workspaceId))) throw new Error(t('loadFailed'));
			setRows(nextRows);
			setMessage(null);
		} catch (error) {
			if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
			setRows([]);
			setMessage({ error: true, text: error instanceof Error ? error.message : t('loadFailed') });
		} finally { if (!signal?.aborted) setLoading(false); }
	}, [base, mode, t, workspaceId]);

	useEffect(() => {
		const controller = new AbortController();
		setExpanded(null);
		setVersions({});
		setAssignments({});
		setEditingId(null);
		setForm({ name: '', description: '', config: DEFAULT_CONFIG });
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);
	useEffect(() => {
		if (mode !== 'user') return;
		const controller = new AbortController();
		setMe(null);
		setKeys([]);
		void Promise.all([
			fetch('/api/user/me', { cache: 'no-store', signal: controller.signal }).then((r) => readPortalJson<PortalMe>(r)),
			fetch('/api/user/gateway-keys', { cache: 'no-store', signal: controller.signal }).then((r) => readPortalJson<GatewayKey[]>(r)),
		]).then(([mePayload, keyPayload]) => {
			if (controller.signal.aborted) return;
			const nextKeys = keyPayload?.data ?? [];
			if (nextKeys.some((key) => key.workspaceId !== workspaceId)) {
				setMessage({ error: true, text: t('loadFailed') });
				return;
			}
			setMe(mePayload?.data ?? null);
			setKeys(nextKeys);
		}).catch((error) => {
			if (!(error instanceof DOMException && error.name === 'AbortError')) setMessage({ error: true, text: t('loadFailed') });
		});
		return () => controller.abort();
	}, [mode, t, workspaceId]);

	const save = async () => {
		let config: Record<string, unknown>;
		try {
			const value = JSON.parse(form.config) as unknown;
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
			config = value as Record<string, unknown>;
		} catch { setMessage({ error: true, text: t('invalidJson') }); return; }
		setSaving(true);
		try {
			const url = editingId ? `${base}/${editingId}/versions` : base;
			const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.name, description: form.description || null, config }) });
			const payload = await readPortalJson<Guardrail>(response);
			if (!response.ok || !payload?.success) throw new Error(payload?.message ?? t('saveFailed'));
			if (mode === 'user' && payload.data?.workspaceId !== activeWorkspaceIdRef.current) return;
			setMessage({ error: false, text: t('saved') }); setEditingId(null); setForm({ name: '', description: '', config: DEFAULT_CONFIG }); await load();
		} catch (error) { setMessage({ error: true, text: error instanceof Error ? error.message : t('saveFailed') }); }
		finally { setSaving(false); }
	};

	const edit = (row: Guardrail) => {
		if (mode === 'user' && row.workspaceId !== workspaceId) return;
		setEditingId(row.id); setForm({ name: row.name, description: row.description ?? '', config: JSON.stringify(row.config ?? {}, null, 2) }); window.scrollTo({ top: 0, behavior: 'smooth' });
	};

	const patchRow = async (row: Guardrail, body: Record<string, unknown>) => {
		if (mode === 'user' && row.workspaceId !== workspaceId) return;
		const response = await fetch(`${base}/${row.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const payload = await readPortalJson<Guardrail>(response);
		if (!response.ok || !payload?.success) setMessage({ error: true, text: payload?.message ?? t('updateFailed') });
		else if (mode === 'user' && payload.data?.workspaceId !== activeWorkspaceIdRef.current) return;
		else await load();
	};

	const showDetails = async (row: Guardrail) => {
		if (mode === 'user' && row.workspaceId !== workspaceId) return;
		if (expanded === row.id) { setExpanded(null); return; }
		const [vr, ar] = await Promise.all([fetch(`${base}/${row.id}/versions`, { cache: 'no-store' }), fetch(`${base}/${row.id}/assignments`, { cache: 'no-store' })]);
		const [vp, ap] = await Promise.all([readPortalJson<Version[]>(vr), readPortalJson<Assignment[]>(ar)]);
		if (!vr.ok || !ar.ok || !vp?.success || !ap?.success) { setMessage({ error: true, text: vp?.message ?? ap?.message ?? t('loadFailed') }); return; }
		if (mode === 'user' && (row.workspaceId !== activeWorkspaceIdRef.current
			|| (ap.data ?? []).some((assignment) => assignment.workspaceId !== activeWorkspaceIdRef.current))) return;
		setVersions((value) => ({ ...value, [row.id]: vp.data ?? [] })); setAssignments((value) => ({ ...value, [row.id]: ap.data ?? [] })); setExpanded(row.id);
	};

	const designate = async (row: Guardrail, version: number) => {
		if (mode === 'user' && row.workspaceId !== workspaceId) return;
		const response = await fetch(`${base}/${row.id}/designate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version }) });
		const payload = await readPortalJson<Guardrail>(response);
		if (!response.ok || !payload?.success) setMessage({ error: true, text: payload?.message ?? t('updateFailed') });
		else if (mode === 'user' && payload.data?.workspaceId !== activeWorkspaceIdRef.current) return;
		else { await load(); setExpanded(null); await showDetails({ ...row, designatedVersion: version }); }
	};

	const bind = async (row: Guardrail, scopeType: 'user' | 'api_key', scopeId: string) => {
		if (!scopeId || (mode === 'user' && row.workspaceId !== workspaceId)) return;
		const response = await fetch(`${base}/${row.id}/assignments`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope_type: scopeType, scope_id: scopeId }) });
		const payload = await readPortalJson<Assignment>(response);
		if (!response.ok || !payload?.success) setMessage({ error: true, text: payload?.message ?? t('assignFailed') });
		else if (payload.data?.workspaceId !== row.workspaceId) setMessage({ error: true, text: t('assignFailed') });
		else { setMessage({ error: false, text: t('assigned') }); setExpanded(null); await showDetails(row); }
	};

	const unbind = async (row: Guardrail, assignment: Assignment) => {
		if (assignment.workspaceId !== row.workspaceId || (mode === 'user' && row.workspaceId !== workspaceId)) return;
		const workspaceQuery = mode === 'admin' ? `?workspace_id=${encodeURIComponent(row.workspaceId)}` : '';
		const response = await fetch(`${base}/assignments/${assignment.scopeType}/${encodeURIComponent(assignment.scopeId)}${workspaceQuery}`, { method: 'DELETE' });
		const payload = await readPortalJson(response);
		if (!response.ok || !payload?.success) setMessage({ error: true, text: payload?.message ?? t('updateFailed') }); else { setExpanded(null); await showDetails(row); }
	};

	return <div className="space-y-6">
		<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-2xl font-bold">{mode === 'admin' ? t('adminTitle') : t('title')}</h1><p className="console-muted mt-1 text-sm">{mode === 'admin' ? t('adminSubtitle') : t('subtitle')}</p></div>{mode === 'user' && <div className="console-badge self-start rounded-full px-2.5 py-1 text-xs">{t('workspaceScope', { name: workspaceName || workspaceId })}</div>}</div>
		{message && <div className={`rounded-lg border p-3 text-sm ${message.error ? 'border-red-300 bg-red-50 text-red-700' : 'border-emerald-300 bg-emerald-50 text-emerald-700'}`}>{message.text}</div>}
		{mode === 'user' && <section className="console-panel rounded-xl border p-4 sm:p-6" style={{ borderColor: 'var(--console-border)' }}>
			<div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{editingId ? t('newVersion') : t('editorTitle')}</h2><p className="console-muted mt-1 text-xs">{t('editorHint')}</p></div>{editingId && <button type="button" className="text-xs text-cyan-600" onClick={() => { setEditingId(null); setForm({ name: '', description: '', config: DEFAULT_CONFIG }); }}>{t('cancel')}</button>}</div>
			<div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm">{t('name')}<input className="console-input mt-1 w-full rounded-lg border px-3 py-2" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label className="text-sm">{t('description')}<input className="console-input mt-1 w-full rounded-lg border px-3 py-2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label><label className="text-sm sm:col-span-2">{t('config')}<textarea className="console-input mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs" rows={15} spellCheck={false} value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} /></label></div>
			<button type="button" disabled={saving || portalWorkspace?.isSwitching || !workspaceId || !form.name.trim()} onClick={() => void save()} className="mt-4 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? t('saving') : t('saveVersion')}</button>
		</section>}
		<section className="space-y-3">{loading ? <div className="console-muted py-10 text-center text-sm">{t('loading')}</div> : rows.length === 0 ? <div className="console-panel console-muted rounded-xl border p-8 text-center text-sm" style={{ borderColor: 'var(--console-border)' }}>{t('empty')}</div> : rows.map((row) => <article key={row.id} className="console-panel rounded-xl border p-4" style={{ borderColor: 'var(--console-border)' }}>
			<div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{row.name}</h2><span className="rounded-full border px-2 py-0.5 text-xs">v{row.designatedVersion}</span><span className="rounded-full border px-2 py-0.5 text-xs">{t(row.status)}</span></div><p className="console-muted mt-2 text-sm">{row.description || t('noDescription')}</p>{mode === 'admin' && <p className="console-muted mt-1 break-all text-xs">{t('workspace')}: {row.workspaceId} · {t('owner')}: {row.ownerUserId}</p>}</div><div className="flex flex-wrap gap-2 text-xs">{mode === 'user' && <button type="button" onClick={() => edit(row)} className="rounded-md border px-3 py-1.5">{t('newVersion')}</button>}<button type="button" onClick={() => void showDetails(row)} className="rounded-md border px-3 py-1.5">{t('details')}</button><button type="button" onClick={() => void patchRow(row, { status: row.status === 'active' ? 'archived' : 'active' })} className="rounded-md border px-3 py-1.5">{row.status === 'active' ? t('archive') : t('restore')}</button></div></div>
			{expanded === row.id && <div className="mt-4 space-y-4 border-t pt-4" style={{ borderColor: 'var(--console-border)' }}>
				<div><h3 className="text-sm font-semibold">{t('assignments')}</h3><div className="mt-2 flex flex-wrap gap-2">{mode === 'user' ? <><button disabled={!me || row.status !== 'active'} className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50" onClick={() => me && void bind(row, 'user', me.userId)}>{t('bindAccount')}</button>{keys.filter((key) => key.status === 'active').map((key) => <button key={key.id} disabled={row.status !== 'active'} className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50" onClick={() => void bind(row, 'api_key', key.id)}>{t('bindKey')}: {key.name || key.key}</button>)}</> : <><select className="console-input rounded-md border px-2 py-1.5 text-xs" value={adminScope[row.id]?.type ?? 'user'} onChange={(e) => setAdminScope((value) => ({ ...value, [row.id]: { type: e.target.value as 'user' | 'api_key', id: value[row.id]?.id ?? '' } }))}><option value="user">user</option><option value="api_key">api_key</option></select><input className="console-input min-w-64 rounded-md border px-2 py-1.5 font-mono text-xs" placeholder={t('scopeId')} value={adminScope[row.id]?.id ?? ''} onChange={(e) => setAdminScope((value) => ({ ...value, [row.id]: { type: value[row.id]?.type ?? 'user', id: e.target.value } }))} /><button className="rounded-md border px-3 py-1.5 text-xs" onClick={() => { const scope = adminScope[row.id]; if (scope) void bind(row, scope.type, scope.id); }}>{t('bind')}</button></>}</div><div className="mt-2 space-y-1">{(assignments[row.id] ?? []).length === 0 ? <p className="console-muted text-xs">{t('noAssignments')}</p> : (assignments[row.id] ?? []).map((assignment) => <div key={assignment.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"><code className="break-all">{assignment.scopeType}:{assignment.scopeId}</code><button className="text-red-600" onClick={() => void unbind(row, assignment)}>{t('unbind')}</button></div>)}</div></div>
				<div className="overflow-x-auto"><h3 className="mb-2 text-sm font-semibold">{t('versions')}</h3><table className="w-full min-w-[480px] text-left text-xs"><thead className="console-muted"><tr><th className="py-2">{t('version')}</th><th>{t('createdAt')}</th><th>{t('actions')}</th></tr></thead><tbody>{(versions[row.id] ?? []).map((version) => <tr key={version.id} className="border-t" style={{ borderColor: 'var(--console-border)' }}><td className="py-2">v{version.version}{version.version === row.designatedVersion ? ` · ${t('designated')}` : ''}</td><td>{new Date(version.createdAt).toLocaleString()}</td><td>{version.version !== row.designatedVersion && row.status === 'active' ? <button className="text-cyan-600" onClick={() => void designate(row, version.version)}>{t('designate')}</button> : '—'}</td></tr>)}</tbody></table></div>
			</div>}
		</article>)}</section>
	</div>;
}
