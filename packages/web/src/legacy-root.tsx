/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import './cinatoken/i18n'
import { router } from './cinatoken/router'
import { CinaTokenSessionProvider } from './cinatoken/session-context'
import { ThemeProvider } from './context/theme-provider'

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: true },
		mutations: { retry: false, gcTime: 0 },
	},
})

export function startLegacyApplication(element: HTMLElement): void {
	createRoot(element).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<ThemeProvider storageKey='cinatoken-theme'>
					<CinaTokenSessionProvider>
						<RouterProvider router={router} />
					</CinaTokenSessionProvider>
				</ThemeProvider>
			</QueryClientProvider>
		</StrictMode>
	)
}
