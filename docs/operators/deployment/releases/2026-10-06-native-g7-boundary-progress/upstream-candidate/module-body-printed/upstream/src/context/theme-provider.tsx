type Theme = 'dark' | 'light' | 'system'
type ResolvedTheme = Exclude<Theme, 'system'>
const DEFAULT_THEME = 'system'
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
export function ThemeProvider({
  children,
  defaultTheme = DEFAULT_THEME,
  storageKey = THEME_STORAGE_KEYS.mode,
  ...props
}: ThemeProviderProps) {
  const [theme, _setTheme] = useState<Theme>(() =>
    readThemePreference(storageKey, THEMES, defaultTheme),
  )
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(theme),
  )
  useEffect(() => {
    const root = window.document.documentElement
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const nextResolvedTheme = theme === 'system' ? getSystemTheme() : theme
      root.classList.remove('light', 'dark')
      root.classList.add(nextResolvedTheme)
      setResolvedTheme(nextResolvedTheme)
    }
    applyTheme()
    mediaQuery.addEventListener('change', applyTheme)
    return () => mediaQuery.removeEventListener('change', applyTheme)
  }, [theme])
  const setTheme = useCallback(
    (theme: Theme) => {
      writeThemePreference(storageKey, theme)
      _setTheme(theme)
    },
    [storageKey],
  )
  const resetTheme = useCallback(() => {
    writeThemePreference(storageKey, null)
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
    [defaultTheme, resolvedTheme, resetTheme, theme, setTheme],
  )
  return (
    <ThemeContext value={contextValue} {...props}>
      {children}
    </ThemeContext>
  )
}
export const useTheme = () => {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within a ThemeProvider')
  return context
}
