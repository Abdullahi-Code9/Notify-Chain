import { useCallback } from 'react';
import type { Theme } from '../hooks/useTheme';

interface ThemeToggleProps {
  theme: Theme;
  onToggle: () => void;
}

/**
 * A sleek toggle switch for dark / light theme.
 * Renders a sun ☀ and moon 🌙 icon pair.
 */
export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggle();
      }
    },
    [onToggle],
  );

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      onKeyDown={handleKeyDown}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      id="theme-toggle-button"
      title={`Currently ${theme} theme — click to switch`}
    >
      <span
        className={`theme-toggle__icon ${theme === 'light' ? 'theme-toggle__icon--active' : ''}`}
      >
        {/* Sun icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      </span>
      <span
        className={`theme-toggle__icon ${theme === 'dark' ? 'theme-toggle__icon--active' : ''}`}
      >
        {/* Moon icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
        </svg>
      </span>
    </button>
  );
}
