/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { I18nextProvider } from 'react-i18next'
import { PublicAuthProvider } from '../auth/public-auth-context'
import { PublicLocationProvider } from './public-location'
import type { PublicRequestApp } from './public-request-app'

export function PublicApplication(props: {
	app: Pick<PublicRequestApp, 'i18n' | 'queryClient' | 'location' | 'router'>
}) {
	return (
		<I18nextProvider i18n={props.app.i18n}>
			<QueryClientProvider client={props.app.queryClient}>
				<PublicLocationProvider value={props.app.location}>
					<PublicAuthProvider>
						<RouterProvider router={props.app.router} />
					</PublicAuthProvider>
				</PublicLocationProvider>
			</QueryClientProvider>
		</I18nextProvider>
	)
}
