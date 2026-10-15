'use client';

/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import dynamic from 'next/dynamic';
import { AdvancedEditorLink } from '@/components/routing-workbench/AdvancedEditorGate';

const LegacyRoutingWorkbenchShell = dynamic(
	() => import('@/components/routing-workbench/LegacyRoutingWorkbenchShell'),
	{ ssr: false },
);

export default function Page() {
	return (
		<>
			<AdvancedEditorLink feature="routes" />
			<LegacyRoutingWorkbenchShell feature="routes" />
		</>
	);
}
