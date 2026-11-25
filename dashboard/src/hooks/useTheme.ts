import { useState, useEffect, useCallback } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'notify-chain-theme';

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;

  // Respect OS preference
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }

  return 'dark';
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Manages the dark/light theme toggle. Persists choice to localStorage
 * and applies a `data-theme` attribute to `<html>` for CSS consumption.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const initial = getInitialTheme();
    if (typeof document !== 'undefined') applyTheme(initial);
    return initial;
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  return { theme, toggleTheme, setTheme } as const;
}
