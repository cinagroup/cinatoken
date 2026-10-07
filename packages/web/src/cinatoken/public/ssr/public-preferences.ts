/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
declare global {
	interface Window {
		cinatokenPublicPreferences?: {
			syncControls: () => void
			dispose: () => void
		}
	}
}

// Fixed JavaScript, shared by both SSR targets. Serializing a transpiled function
// can capture bundler helpers. This literal never interpolates request data.
export const publicPreferencesScript = String.raw`(function (browser) {
	if (browser.cinatokenPublicPreferences) return;
	const document = browser.document;
	const media = browser.matchMedia('(prefers-color-scheme: dark)');
	const locales = ['en', 'zh', 'ja', 'ko'];
	const readCookie = (name) => {
		try {
			return document.cookie.split(';').map((part) => part.trim())
				.find((part) => part.startsWith(name + '='))?.slice(name.length + 1) ?? null;
		} catch {
			return undefined;
		}
	};
	const writeCookie = (name, value) => {
		try {
			document.cookie = name + '=' + value + '; Path=/; SameSite=Lax; Max-Age=31536000';
		} catch {
			// Public preferences still work for this document when cookies are blocked.
		}
	};
	const parseTheme = (value) => value === 'light' || value === 'dark' ? value : 'system';
	let stored = readCookie('cinatoken-theme');
	let theme = parseTheme(stored);
	const applyTheme = () => {
		let appearance = theme === 'dark' ? 'dark' : 'light';
		if (theme === 'system') appearance = media.matches ? 'dark' : 'light';
		document.documentElement.classList.remove('light', 'dark');
		document.documentElement.classList.add(appearance);
	};
	const syncControls = () => {
		const root = document.getElementById('root');
		if (!root) return;
		for (const select of root.querySelectorAll('select[data-cinatoken-public-preference="theme"]'))
			select.value = theme;
		const locale = browser.location.pathname.split('/')[1] ?? '';
		if (!locales.includes(locale)) return;
		for (const select of root.querySelectorAll('select[data-cinatoken-public-preference="locale"]'))
			select.value = locale;
	};
	const change = (event) => {
		const select = event.target;
		if (!(select instanceof browser.HTMLSelectElement) || !document.getElementById('root')?.contains(select))
			return;
		const kind = select.getAttribute('data-cinatoken-public-preference');
		const value = select.value;
		if (kind === 'theme') {
			if (value !== 'system' && value !== 'light' && value !== 'dark') return;
			theme = value;
			writeCookie('cinatoken-theme', value);
			const current = readCookie('cinatoken-theme');
			if (current !== undefined) stored = current;
			applyTheme();
			syncControls();
			return;
		}
		if (kind !== 'locale' || !locales.includes(value)) return;
		const pathname = browser.location.pathname;
		const currentLocale = pathname.split('/')[1] ?? '';
		if (!locales.includes(currentLocale)) return;
		const bare = pathname.slice(currentLocale.length + 1) || '/';
		if (pathname.includes('\\') ||
			(!/^\/(?:models|providers|compare|chat|rankings|benchmarks)?\/?$/.test(bare) &&
			 !/^\/models\/[^/]+\/[^/]+\/?$/.test(bare))) return;
		writeCookie('NEXT_LOCALE', value);
		if (currentLocale === value) return;
		browser.location.assign('/' + value + (bare === '/' ? '' : bare) + browser.location.search + browser.location.hash);
	};
	const restore = () => {
		const current = readCookie('cinatoken-theme');
		if (current !== undefined && current !== stored) {
			const previouslyObserved = stored !== undefined;
			stored = current;
			// A first readable value cannot prove a change while storage was denied.
			if (previouslyObserved) theme = parseTheme(current);
		}
		applyTheme();
		syncControls();
	};
	let disposed = false;
	const preferences = {
		syncControls,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			document.removeEventListener('change', change, true);
			media.removeEventListener('change', applyTheme);
			browser.removeEventListener('pageshow', restore);
			if (browser.cinatokenPublicPreferences === preferences)
				delete browser.cinatokenPublicPreferences;
		}
	};
	browser.cinatokenPublicPreferences = preferences;
	document.addEventListener('change', change, true);
	media.addEventListener('change', applyTheme);
	browser.addEventListener('pageshow', restore);
	applyTheme();
	syncControls();
})(window);`
