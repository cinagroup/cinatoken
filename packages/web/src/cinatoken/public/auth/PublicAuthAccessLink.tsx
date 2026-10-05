/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { MouseEvent, ReactNode } from 'react'
import {
	buildAuthStartPath,
	type LoginOptions,
} from '../../auth-popup-contract'
import { usePublicAuth } from './public-auth-context'

export type PublicAuthAccessLinkProps = {
	options: LoginOptions
	children: ReactNode
	className?: string
	href?: string
	target?: string
	rel?: string
}

export function PublicAuthAccessLink(props: PublicAuthAccessLinkProps) {
	const auth = usePublicAuth()
	const href = props.href ?? buildAuthStartPath(props.options)
	const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			(event.currentTarget.target && event.currentTarget.target !== '_self') ||
			!href.startsWith('/') ||
			href.startsWith('//') ||
			event.currentTarget.origin !== window.location.origin
		)
			return
		event.preventDefault()
		auth.begin(props.options, event.currentTarget)
	}
	return (
		<a
			href={href}
			className={props.className}
			target={props.target}
			rel={props.rel}
			onClick={onClick}
		>
			{props.children}
		</a>
	)
}
