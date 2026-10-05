/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useNavigate, useSearch } from '@tanstack/react-router'
import { PublicChatPage } from './PublicChatPage'

export function PublicChatRoute() {
	const search = useSearch({ from: '/chat' })
	const navigate = useNavigate({ from: '/chat' })
	return (
		<PublicChatPage
			modelId={search.model}
			onModelChange={(model) => {
				void navigate({ search: { model }, replace: true })
			}}
		/>
	)
}
