'use client';

/** Adapted from cinatoken-go/web/default ThemeProvider. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type Theme = 'dark' | 'light' | 'system';
type ResolvedTheme = Exclude<Theme, 'system'>;
const STORAGE_KEY = 'cinatoken.home-theme.v1';
const COOKIE_KEY = 'cinatoken_home_theme';

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ConsoleThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system');
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light');

  useEffect(() => {
    const stored = document.documentElement.dataset.consoleThemePreference
      ?? window.localStorage.getItem(STORAGE_KEY);
	if (stored !== 'light' && stored !== 'dark' && stored !== 'system') return;
	const frame = window.requestAnimationFrame(() => setThemeState(stored));
	return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? systemTheme() : theme;
      document.documentElement.dataset.consoleThemePreference = theme;
      document.documentElement.dataset.consoleTheme = resolved;
      setResolvedTheme(resolved);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    document.cookie = `${COOKIE_KEY}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    setThemeState(next);
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useConsoleTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useConsoleTheme must be used inside ConsoleThemeProvider');
  return value;
}
