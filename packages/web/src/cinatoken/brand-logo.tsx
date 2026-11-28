/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Unmodified CinaBrand 2.1.1 symbol; keep the supplied proportions and corners. */
export function BrandLogo(props: { className?: string }) {
	return (
		<img
			src='/web-assets/cinagroup-logo.31da4b7fb36b.png'
			alt='CinaToken'
			width={32}
			height={32}
			className={props.className ?? 'size-8 shrink-0'}
		/>
	)
}

/** Keep the image asset intact and pair it with a visible, non-translated brand name. */
export function BrandIdentity(props: { className?: string }) {
	return (
		<span className='inline-flex shrink-0 items-center gap-2 font-semibold tracking-tight whitespace-nowrap'>
			<BrandLogo className={props.className} />
			<span aria-hidden='true'>CinaToken</span>
		</span>
	)
}
