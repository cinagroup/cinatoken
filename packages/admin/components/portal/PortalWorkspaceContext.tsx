'use client';

import {
	createContext,
	useContext,
	useMemo,
	type ReactNode,
} from 'react';
import type { WorkspaceContextProjection } from '@octafuse/core';

export type PortalWorkspaceState = {
	context: WorkspaceContextProjection | null;
	isSwitching: boolean;
	error: 'load' | 'switch' | null;
	selectWorkspace: (workspaceId: string) => void;
};

const PortalWorkspaceContext = createContext<PortalWorkspaceState | null>(null);

export function PortalWorkspaceProvider({
	children,
	context,
	isSwitching,
	error,
	selectWorkspace,
}: PortalWorkspaceState & { children: ReactNode }) {
	const value = useMemo<PortalWorkspaceState>(() => ({
		context,
		isSwitching,
		error,
		selectWorkspace,
	}), [context, error, isSwitching, selectWorkspace]);
	return <PortalWorkspaceContext.Provider value={value}>{children}</PortalWorkspaceContext.Provider>;
}

export function usePortalWorkspace(): PortalWorkspaceState {
	const value = useContext(PortalWorkspaceContext);
	if (!value) throw new Error('usePortalWorkspace must be used inside PortalWorkspaceProvider');
	return value;
}

export function useOptionalPortalWorkspace(): PortalWorkspaceState | null {
	return useContext(PortalWorkspaceContext);
}
