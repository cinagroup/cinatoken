'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import ConsoleThemeToggle from '@/components/unified/ConsoleThemeToggle';
import Sidebar from './Sidebar';

export default function AdminMobileHeader() {
	const [open, setOpen] = useState(false);
	const tBrand = useTranslations('brand');
	const tHomeNav = useTranslations('home.nav');
	const tCommon = useTranslations('common');

	useEffect(() => {
		if (!open) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = previous;
		};
	}, [open]);

	return (
		<>
			<header className="console-panel sticky top-0 z-40 flex h-14 items-center gap-3 border-b px-3 lg:hidden">
				<button
					type="button"
					onClick={() => setOpen(true)}
					className="console-nav-link grid h-9 w-9 place-items-center rounded-lg"
					aria-label={tHomeNav('label')}
					aria-expanded={open}
				>
					<Bars3Icon className="h-5 w-5" />
				</button>
				<Link href="/dashboard" className="flex min-w-0 flex-1 items-center gap-2">
					<Image src="/brand/logo.png" alt={tBrand('logoAlt')} width={30} height={30} className="h-[30px] w-[30px] rounded-lg" />
					<span className="truncate text-sm font-semibold">{tBrand('wordmark')}</span>
				</Link>
				<ConsoleThemeToggle />
			</header>

			{open && (
				<div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
					<button
						type="button"
						className="absolute inset-0 bg-black/45"
						onClick={() => setOpen(false)}
						aria-label={tCommon('close')}
					/>
					<div className="relative h-dvh w-64 max-w-[85vw] shadow-2xl">
						<Sidebar mobile onNavigate={() => setOpen(false)} />
						<button
							type="button"
							onClick={() => setOpen(false)}
							className="console-nav-link absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-lg"
							aria-label={tCommon('close')}
						>
							<XMarkIcon className="h-5 w-5" />
						</button>
					</div>
				</div>
			)}
		</>
	);
}
