'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useCinaAuthPopup } from './CinaAuthPopupProvider';

/** Start from the original click, preserving the browser's popup permission. */
export default function CinaAuthAccessLink({ href, intent, className, children }: {
	href: string;
	intent: 'admin' | 'portal';
	className?: string;
	children: ReactNode;
}) {
	const router = useRouter();
	const { begin } = useCinaAuthPopup();
	return (
		<a href={href} className={className} onClick={(event) => {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			begin({ intent, callbackPath: href, onAuthenticated: () => {
				router.push(href);
				router.refresh();
			} });
		}}>
			{children}
		</a>
	);
}
