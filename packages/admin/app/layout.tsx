/**
 * 全站根布局：系统无衬线字体栈（避免 next/font/google 构建时拉取 Google Fonts，离线/受限网络下可正常 build）。
 */
import './globals.css';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import AuthWrapper from '@/components/layout/AuthWrapper';
import DocumentTitle from '@/components/layout/DocumentTitle';
import { ConsoleThemeProvider } from '@/components/unified/ConsoleThemeProvider';
import CinaAuthPopupProvider from '@/components/auth/CinaAuthPopupProvider';

const CONSOLE_THEME_BOOTSTRAP = `(() => {
	let stored = null;
	try { stored = localStorage.getItem('cinatoken.home-theme.v1'); } catch {}
	if (stored !== 'light' && stored !== 'dark' && stored !== 'system') {
		stored = (document.cookie || '').split('; ')
			.find((entry) => entry.startsWith('cinatoken_home_theme='))
			?.slice('cinatoken_home_theme='.length) ?? null;
	}
	const preference = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
	const resolved = preference === 'system'
		? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
		: preference;
	document.documentElement.dataset.consoleThemePreference = preference;
	document.documentElement.dataset.consoleTheme = resolved;
})();`;

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations('metadata');
	const appTitle = t('title');
	return {
		title: {
			default: appTitle,
			template: `%s · ${appTitle}`,
		},
		description: t('description'),
		icons: {
			icon: [{ url: '/favicon.ico', type: 'image/x-icon' }],
			shortcut: '/favicon.ico',
		},
		robots: 'noindex, nofollow',
	};
}

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const locale = await getLocale();
	const messages = await getMessages();

	return (
		<html lang={locale} data-scroll-behavior="smooth" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: CONSOLE_THEME_BOOTSTRAP }} />
			</head>
			<body className="min-h-screen bg-white font-sans">
				<NextIntlClientProvider locale={locale} messages={messages}>
					<ConsoleThemeProvider>
						<DocumentTitle />
						<CinaAuthPopupProvider>
							<AuthWrapper>{children}</AuthWrapper>
						</CinaAuthPopupProvider>
					</ConsoleThemeProvider>
				</NextIntlClientProvider>
			</body>
		</html>
	);
}
