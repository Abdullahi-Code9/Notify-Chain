import type { KeyboardEvent, RefObject } from 'react';
import { NAV_ITEMS, type Tab } from './MobileNavDrawer';

interface SidebarProps {
  activeTab: Tab;
  onSelectTab: (tab: Tab) => void;
  tabListRef: RefObject<HTMLDivElement | null>;
  onTabKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  isAdmin?: boolean;
}

export function Sidebar({ activeTab, onSelectTab, tabListRef, onTabKeyDown, isAdmin = false }: SidebarProps) {
  const navItems = isAdmin
    ? [...NAV_ITEMS, { id: 'audit' as Tab, label: 'Audit History' }]
    : NAV_ITEMS;

  return (
    <aside className="app-sidebar" aria-label="Sidebar navigation">
      <nav className="app-tabs" aria-label="Primary dashboard navigation">
        <div
          ref={tabListRef}
          role="tablist"
          aria-label="Dashboard sections"
          className="app-tabs__list"
          onKeyDown={onTabKeyDown}
        >
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={activeTab === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={activeTab === item.id ? 0 : -1}
              className={`app-tabs__btn${activeTab === item.id ? ' app-tabs__btn--active' : ''}`}
              onClick={() => onSelectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </nav>
    </aside>
  );
}