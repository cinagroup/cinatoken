'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import {
	CheckIcon,
	ComputerDesktopIcon,
	MoonIcon,
	SunIcon,
} from '@heroicons/react/24/outline';

type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'cinatoken.home-theme.v1';
const COOKIE_KEY = 'cinatoken_home_theme';
const THEME_CHANGE_EVENT = 'cinatoken-home-theme-change';
const OPTIONS: Array<{
	value: ThemePreference;
	icon: typeof SunIcon;
}> = [
	{ value: 'light', icon: SunIcon },
	{ value: 'dark', icon: MoonIcon },
	{ value: 'system', icon: ComputerDesktopIcon },
];

function isThemePreference(value: string | null): value is ThemePreference {
	return value === 'light' || value === 'dark' || value === 'system';
}

function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
	if (preference !== 'system') return preference;
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(preference: ThemePreference) {
	const root = document.documentElement;
	root.dataset.homeThemePreference = preference;
	root.dataset.homeTheme = resolveTheme(preference);

	try {
		window.localStorage.setItem(STORAGE_KEY, preference);
	} catch {
		// The cookie below keeps the preference when storage is unavailable.
	}
	document.cookie = `${COOKIE_KEY}=${preference}; Path=/; Max-Age=31536000; SameSite=Lax`;

	window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function getCookiePreference(): ThemePreference | null {
	const value = (document.cookie || '')
		.split('; ')
		.find((entry) => entry.startsWith(`${COOKIE_KEY}=`))
		?.slice(COOKIE_KEY.length + 1) ?? null;
	return isThemePreference(value) ? value : null;
}

function getThemePreferenceSnapshot(): ThemePreference {
	try {
		const storedPreference = window.localStorage.getItem(STORAGE_KEY);
		if (isThemePreference(storedPreference)) return storedPreference;
	} catch {
		// Fall through to the cookie and bootstrap dataset.
	}
	const cookiePreference = getCookiePreference();
	if (cookiePreference) return cookiePreference;

	const datasetPreference = document.documentElement.dataset.homeThemePreference ?? null;
	return isThemePreference(datasetPreference) ? datasetPreference : 'system';
}

function subscribeToThemePreference(onStoreChange: () => void) {
	const handleStorage = (event: StorageEvent) => {
		if (event.key === STORAGE_KEY) onStoreChange();
	};

	window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
	window.addEventListener('storage', handleStorage);
	return () => {
		window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
		window.removeEventListener('storage', handleStorage);
	};
}

export default function HomeThemeSwitcher() {
	const t = useTranslations('home.theme');
	const preference = useSyncExternalStore<ThemePreference>(
		subscribeToThemePreference,
		getThemePreferenceSnapshot,
		() => 'system',
	);
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

	useEffect(() => {
		applyTheme(preference);
		if (preference !== 'system') return;

		const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		const handleSystemThemeChange = () => applyTheme('system');
		mediaQuery.addEventListener('change', handleSystemThemeChange);
		return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
	}, [preference]);

	useEffect(() => {
		if (!open) return;

		const handlePointerDown = (event: MouseEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			setOpen(false);
			triggerRef.current?.focus();
		};

		document.addEventListener('mousedown', handlePointerDown);
		document.addEventListener('keydown', handleKeyDown);
		return () => {
			document.removeEventListener('mousedown', handlePointerDown);
			document.removeEventListener('keydown', handleKeyDown);
		};
	}, [open]);

	const focusOption = (index: number) => {
		optionRefs.current[(index + OPTIONS.length) % OPTIONS.length]?.focus();
	};

	const openMenu = () => {
		setOpen(true);
		window.requestAnimationFrame(() => {
			focusOption(Math.max(0, OPTIONS.findIndex((option) => option.value === preference)));
		});
	};

	const selectPreference = (nextPreference: ThemePreference) => {
		applyTheme(nextPreference);
		setOpen(false);
		triggerRef.current?.focus();
	};

	const ActiveIcon = OPTIONS.find((option) => option.value === preference)?.icon ?? ComputerDesktopIcon;

	return (
		<div ref={containerRef} className="relative">
			<button
				ref={triggerRef}
				type="button"
				className="home-theme-trigger"
				aria-label={`${t('label')}: ${t(preference)}`}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => (open ? setOpen(false) : openMenu())}
				onKeyDown={(event) => {
					if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
					event.preventDefault();
					openMenu();
				}}
			>
				<ActiveIcon className="h-4 w-4" strokeWidth={1.7} aria-hidden />
			</button>

			{open ? (
				<div className="home-theme-menu" role="menu" aria-label={t('label')}>
					{OPTIONS.map((option, index) => {
						const Icon = option.icon;
						const selected = option.value === preference;
						return (
							<button
								key={option.value}
								ref={(node) => { optionRefs.current[index] = node; }}
								type="button"
								role="menuitemradio"
								aria-checked={selected}
								className="home-theme-option"
								onClick={() => selectPreference(option.value)}
								onKeyDown={(event) => {
									if (event.key === 'ArrowDown') {
										event.preventDefault();
										focusOption(index + 1);
									} else if (event.key === 'ArrowUp') {
										event.preventDefault();
										focusOption(index - 1);
									} else if (event.key === 'Home') {
										event.preventDefault();
										focusOption(0);
									} else if (event.key === 'End') {
										event.preventDefault();
										focusOption(OPTIONS.length - 1);
									}
								}}
							>
								<Icon className="h-4 w-4" strokeWidth={1.7} aria-hidden />
								<span>{t(option.value)}</span>
								<CheckIcon className={`ml-auto h-4 w-4 ${selected ? 'opacity-100' : 'opacity-0'}`} strokeWidth={2} aria-hidden />
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
