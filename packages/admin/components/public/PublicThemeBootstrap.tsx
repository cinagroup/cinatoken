const PUBLIC_THEME_BOOTSTRAP = `(() => {
	let stored = null;
	try {
		stored = localStorage.getItem('cinatoken.home-theme.v1');
	} catch {}
	if (stored !== 'light' && stored !== 'dark' && stored !== 'system') {
		stored = (document.cookie || '')
			.split('; ')
			.find((entry) => entry.startsWith('cinatoken_home_theme='))
			?.slice('cinatoken_home_theme='.length) ?? null;
	}
	const preference = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
	const resolved = preference === 'system'
		? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
		: preference;
	document.documentElement.dataset.homeThemePreference = preference;
	document.documentElement.dataset.homeTheme = resolved;
})();`;

export default function PublicThemeBootstrap() {
	return <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: PUBLIC_THEME_BOOTSTRAP }} />;
}
