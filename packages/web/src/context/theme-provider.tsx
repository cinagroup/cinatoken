/*
Copyright (C) 2023-2026 CinaGroup

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@cinagroup.com
*/
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { getCookie, setCookie, removeCookie } from '@/lib/cookies'

type Theme = 'dark' | 'light' | 'system'
type ResolvedTheme = Exclude<Theme, 'system'>

const DEFAULT_THEME = 'system'
const THEME_COOKIE_NAME = 'vite-ui-theme'
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year
const THEMES = new Set<Theme>(['dark', 'light', 'system'])

type ThemeProviderProps = {
	children: React.ReactNode
	defaultTheme?: Theme
	storageKey?: string
}

type ThemeProviderState = {
	defaultTheme: Theme
	resolvedTheme: ResolvedTheme
	theme: Theme
	setTheme: (theme: Theme) => void
	resetTheme: () => void
}

const initialState: ThemeProviderState = {
	defaultTheme: DEFAULT_THEME,
	resolvedTheme: 'light',
	theme: DEFAULT_THEME,
	setTheme: () => null,
	resetTheme: () => null,
}

const ThemeContext = createContext<ThemeProviderState>(initialState)

function getSystemTheme(): ResolvedTheme {
	if (typeof window === 'undefined') return 'light'
	return window.matchMedia('(prefers-color-scheme: dark)').matches
		? 'dark'
		: 'light'
}

function resolveTheme(theme: Theme): ResolvedTheme {
	return theme === 'system' ? getSystemTheme() : theme
}

// null is an absent cookie; undefined means optional storage could not be read.
function readThemeCookie(storageKey: string): string | null | undefined {
	try {
		return getCookie(storageKey) ?? null
	} catch {
		return undefined
	}
}

function parseTheme(value: string | null | undefined, fallback: Theme): Theme {
	return value && THEMES.has(value as Theme) ? (value as Theme) : fallback
}

export function ThemeProvider({
	children,
	defaultTheme = DEFAULT_THEME,
	storageKey = THEME_COOKIE_NAME,
	...props
}: ThemeProviderProps) {
	const [initialCookie] = useState(() => readThemeCookie(storageKey))
	const storedCookie = useRef(initialCookie)
	const [theme, _setTheme] = useState<Theme>(() =>
		parseTheme(initialCookie, defaultTheme)
	)
	const currentTheme = useRef(theme)
	const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
		resolveTheme(parseTheme(initialCookie, defaultTheme))
	)

	useEffect(() => {
		const root = window.document.documentElement
		const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

		const applyTheme = (selection: Theme) => {
			const nextResolvedTheme =
				selection === 'system' ? getSystemTheme() : selection
			root.classList.remove('light', 'dark')
			root.classList.add(nextResolvedTheme)
			setResolvedTheme(nextResolvedTheme)
		}

		const applyCurrentTheme = () => applyTheme(currentTheme.current)
		const restore = () => {
			const current = readThemeCookie(storageKey)
			let selection = currentTheme.current
			if (current !== undefined) {
				const changed =
					storedCookie.current !== undefined && current !== storedCookie.current
				storedCookie.current = current
				// An unavailable previous read cannot prove an external change.
				if (changed) {
					selection = parseTheme(current, defaultTheme)
					currentTheme.current = selection
					_setTheme(selection)
				}
			}
			// A frozen document may miss media events, even with an unchanged cookie.
			applyTheme(selection)
		}
		applyCurrentTheme()

		mediaQuery.addEventListener('change', applyCurrentTheme)
		window.addEventListener('pageshow', restore)

		return () => {
			mediaQuery.removeEventListener('change', applyCurrentTheme)
			window.removeEventListener('pageshow', restore)
		}
	}, [defaultTheme, storageKey, theme])

	const setTheme = useCallback(
		(theme: Theme) => {
			try {
				setCookie(storageKey, theme, THEME_COOKIE_MAX_AGE)
			} catch {
				// Preference storage is optional; apply the user's current selection.
			}
			const current = readThemeCookie(storageKey)
			if (current !== undefined) storedCookie.current = current
			currentTheme.current = theme
			_setTheme(theme)
		},
		[storageKey]
	)

	const resetTheme = useCallback(() => {
		try {
			removeCookie(storageKey)
		} catch {
			// Reset still applies for this document when persistence is denied.
		}
		const current = readThemeCookie(storageKey)
		if (current !== undefined) storedCookie.current = current
		currentTheme.current = defaultTheme
		_setTheme(defaultTheme)
	}, [defaultTheme, storageKey])

	const contextValue = useMemo(
		() => ({
			defaultTheme,
			resolvedTheme,
			resetTheme,
			theme,
			setTheme,
		}),
		[defaultTheme, resolvedTheme, resetTheme, theme, setTheme]
	)

	return (
		<ThemeContext value={contextValue} {...props}>
			{children}
		</ThemeContext>
	)
}

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => {
	const context = useContext(ThemeContext)

	if (!context) throw new Error('useTheme must be used within a ThemeProvider')

	return context
}
