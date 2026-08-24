'use client';

import { ComputerDesktopIcon, MoonIcon, SunIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { useConsoleTheme } from './ConsoleThemeProvider';

const options = [
  { value: 'light' as const, Icon: SunIcon },
  { value: 'system' as const, Icon: ComputerDesktopIcon },
  { value: 'dark' as const, Icon: MoonIcon },
];

export default function ConsoleThemeToggle() {
  const t = useTranslations('home.theme');
  const { theme, setTheme } = useConsoleTheme();
  return (
    <div className="console-theme-toggle" role="group" aria-label={t('label')}>
      {options.map(({ value, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          aria-label={t(value)}
          title={t(value)}
          aria-pressed={theme === value}
          className="console-theme-toggle-button"
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
