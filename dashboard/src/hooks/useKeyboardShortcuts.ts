/**
 * useKeyboardShortcuts — Global keyboard shortcuts for the dashboard (#505)
 *
 * Shortcuts:
 *  - 1-9: Switch to the corresponding tab
 *  - T: Toggle theme (dark/light)
 *  - ?: Show keyboard shortcut help
 *  - R: Refresh events
 *  - Escape: Close shortcut help overlay
 *
 * Shortcuts are disabled while the user is typing in an input, textarea,
 * or contentEditable element.
 */
import { useEffect, useCallback } from 'react';
import type { Tab } from '../components/MobileNavDrawer';
import { NAV_ITEMS } from '../components/MobileNavDrawer';

interface UseKeyboardShortcutsOptions {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onToggleTheme: () => void;
  onRefresh?: () => void;
  helpOpen: boolean;
  onToggleHelp: () => void;
  onCloseHelp: () => void;
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts({
  activeTab,
  onTabChange,
  onToggleTheme,
  onRefresh,
  helpOpen,
  onToggleHelp,
  onCloseHelp,
}: UseKeyboardShortcutsOptions) {
  const handleKeyDown = useCallback(
    (e: globalThis.KeyboardEvent) => {
      // Always allow Escape to close help
      if (e.key === 'Escape' && helpOpen) {
        onCloseHelp();
        return;
      }

      // Skip shortcuts while typing in form fields
      if (isEditableElement(e.target as Element)) return;

      // Skip if modifier keys are held (Ctrl, Alt, Meta) to avoid browser conflicts
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // ? — Toggle help
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        onToggleHelp();
        return;
      }

      // Don't process further shortcuts if help is open
      if (helpOpen) return;

      // 1-9 — Switch tabs
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9 && num <= NAV_ITEMS.length) {
        e.preventDefault();
        const targetTab = NAV_ITEMS[num - 1]?.id;
        if (targetTab) onTabChange(targetTab);
        return;
      }

      // T — Toggle theme
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        onToggleTheme();
        return;
      }

      // R — Refresh
      if ((e.key === 'r' || e.key === 'R') && onRefresh) {
        e.preventDefault();
        onRefresh();
        return;
      }
    },
    [activeTab, onTabChange, onToggleTheme, onRefresh, helpOpen, onToggleHelp, onCloseHelp],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
