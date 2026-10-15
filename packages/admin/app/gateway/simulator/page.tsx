'use client';

/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import dynamic from 'next/dynamic';
import { AdvancedEditorLink } from '@/components/routing-workbench/AdvancedEditorGate';

const LegacyDiagnosticsShell = dynamic(() => import('@/components/diagnostics/LegacyDiagnosticsShell'), { ssr: false });

export default function AdminSimulatorPage() {
	return (
		<>
			<AdvancedEditorLink feature="simulator" />
			<LegacyDiagnosticsShell feature="simulator" />
		</>
	);
}
