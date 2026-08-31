'use client';

import { useId } from 'react';
import { BuildingOffice2Icon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { usePortalWorkspace } from './PortalWorkspaceContext';

function workspaceLabel(
	workspace: NonNullable<ReturnType<typeof usePortalWorkspace>['context']>['workspaces'][number],
	personalLabel: string,
	organizationLabel: string,
): string {
	if (workspace.scopeType === 'personal') return `${personalLabel} · ${workspace.name}`;
	return `${workspace.organizationName ?? organizationLabel} · ${workspace.name}`;
}

export default function PortalWorkspaceSwitcher({ compact = false }: { compact?: boolean }) {
	const id = useId();
	const t = useTranslations('portal.workspace');
	const { context, error, isSwitching, selectWorkspace } = usePortalWorkspace();
	const currentWorkspace = context?.currentWorkspace ?? null;

	return (
		<div className={compact ? 'min-w-0 flex-1' : 'border-b px-3 py-3'} style={compact ? undefined : { borderColor: 'var(--console-border)' }}>
			<div className="mb-1.5 flex items-center justify-between gap-2">
				<label htmlFor={id} className="console-muted flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider">
					<BuildingOffice2Icon className="h-3.5 w-3.5 shrink-0" />
					<span className="truncate">{t('label')}</span>
				</label>
				<span className="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{ borderColor: 'var(--console-border)', color: 'var(--console-accent)' }}>
					{t('preview')}
				</span>
			</div>
			<select
				id={id}
				value={currentWorkspace?.id ?? ''}
				disabled={!context || isSwitching}
				onChange={(event) => selectWorkspace(event.currentTarget.value)}
				aria-describedby={`${id}-hint`}
				className="w-full rounded-lg border px-2.5 py-2 text-xs outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
				style={{
					background: 'var(--console-panel-subtle)',
					borderColor: 'var(--console-border)',
					color: 'var(--console-text)',
				}}
			>
				{context?.workspaces.map((workspace) => (
					<option key={workspace.id} value={workspace.id}>
						{workspaceLabel(workspace, t('personal'), t('organization'))}
					</option>
				))}
			</select>
			<p id={`${id}-hint`} className="console-muted mt-1.5 text-[10px] leading-4">
				{isSwitching
					? t('switching')
					: error === 'load'
						? t('unavailable')
						: error === 'switch'
							? t('switchFailed')
							: t('migrationNotice')}
			</p>
		</div>
	);
}
