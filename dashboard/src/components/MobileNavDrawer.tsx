/**
 * MobileNavDrawer — accessible off-canvas navigation drawer (#396)
 *
 * Accessibility features:
 *  - aria-expanded on the hamburger toggle
 *  - role="dialog" + aria-modal on the overlay
 *  - Focus trap inside the drawer while open
 *  - Escape key closes the drawer
 *  - Restores focus to the hamburger button on close
 */

import { useEffect, useRef, type KeyboardEvent } from 'react';

export type Tab =
  | 'explorer'
  | 'timeline'
  | 'activity'
  | 'user-activity'
  | 'retry-stats'
  | 'webhooks'
  | 'export-history'
  | 'search'
  | 'preferences'
  | 'templates'
  | 'channels'
  | 'rpc-benchmark';

export interface NavItem {
  id: Tab;
  label: string;
  group?: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: 'explorer',
    label: 'Event Explorer',
    group: 'Monitoring',
  },
  {
    id: 'timeline',
    label: 'Delivery Timeline',
    group: 'Monitoring',
  },
  {
    id: 'activity',
    label: 'Activity Feed',
    group: 'Monitoring',
  },
  {
    id: 'user-activity',
    label: 'User Activity',
    group: 'Monitoring',
  },
  {
    id: 'retry-stats',
    label: 'Retry Stats',
    group: 'Operations',
  },
  {
    id: 'webhooks',
    label: 'Webhook Performance',
    group: 'Operations',
  },
  {
    id: 'export-history',
    label: 'Export History',
    group: 'Operations',
  },
  {
    id: 'search',
    label: 'Notification Search',
    group: 'Search & Config',
  },
  {
    id: 'preferences',
    label: 'Preferences',
    group: 'Search & Config',
  },
  {
    id: 'templates',
    label: 'Templates',
    group: 'Search & Config',
  },
  {
    id: 'channels',
    label: 'Channels',
    group: 'Search & Config',
  },
  {
    id: 'rpc-benchmark',
    label: 'RPC Benchmark',
    group: 'Diagnostics',
  },
];

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface MobileNavDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: Tab;
  onSelectTab: (tab: Tab) => void;
}

export function MobileNavDrawer({
  isOpen,
  onClose,
  activeTab,
  onSelectTab,
}: MobileNavDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // Focus management on open/close
  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current =
        document.activeElement as HTMLElement;

      document.body.style.overflow = 'hidden';

      // Focus first nav item after a small delay to let DOM render
      const timer = setTimeout(() => {
        const first =
          drawerRef.current?.querySelector<HTMLElement>(
            FOCUSABLE_SELECTOR,
          );

        first?.focus();
      }, 50);

      return () => clearTimeout(timer);
    }

    document.body.style.overflow = '';
    previousActiveElement.current?.focus();
  }, [isOpen]);

  // Escape key
  useEffect(() => {
    const handleEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  // Focus trap
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') {
      return;
    }

    const focusable = Array.from(
      drawerRef.current?.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      ) ?? [],
    );

    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleSelect = (tab: Tab) => {
    onSelectTab(tab);
    onClose();
  };

  // Group items by group label
  const groups = NAV_ITEMS.reduce<Record<string, NavItem[]>>(
    (acc, item) => {
      const group = item.group ?? 'Other';

      if (!acc[group]) {
        acc[group] = [];
      }

      acc[group].push(item);

      return acc;
    },
    {},
  );

  if (!isOpen) {
    return null;
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="mobile-drawer__backdrop"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        className={`mobile-drawer${
          isOpen ? ' mobile-drawer--open' : ''
        }`}
        onKeyDown={handleKeyDown}
      >
        <div className="mobile-drawer__header">
          <span className="mobile-drawer__title">
            NotifyChain
          </span>

          <button
            type="button"
            className="mobile-drawer__close"
            aria-label="Close navigation menu"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <nav
          aria-label="Mobile navigation"
          className="mobile-drawer__nav"
        >
          {Object.entries(groups).map(([groupLabel, items]) => (
            <div
              key={groupLabel}
              className="mobile-drawer__group"
            >
              <p
                className="mobile-drawer__group-label"
                aria-hidden="true"
              >
                {groupLabel}
              </p>

              <ul
                role="menu"
                className="mobile-drawer__list"
              >
                {items.map((item) => (
                  <li key={item.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      aria-current={
                        activeTab === item.id
                          ? 'page'
                          : undefined
                      }
                      className={`mobile-drawer__item${
                        activeTab === item.id
                          ? ' mobile-drawer__item--active'
                          : ''
                      }`}
                      onClick={() =>
                        handleSelect(item.id)
                      }
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </>
  );
}