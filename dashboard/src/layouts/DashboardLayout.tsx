import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { Sidebar } from '../components/Sidebar';
import { NAV_ITEMS, type Tab } from '../components/MobileNavDrawer';

interface DashboardLayoutProps {
  activeTab: Tab;
  onSelectTab: (tab: Tab) => void;
  drawerOpen: boolean;
  onDrawerOpen: () => void;
  onDrawerClose: () => void;
  tabListRef: RefObject<HTMLDivElement | null>;
  hamburgerRef: RefObject<HTMLButtonElement | null>;
  onTabKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  themeBar: ReactNode;
  children: ReactNode;
}

export function DashboardLayout({
  activeTab,
  onSelectTab,
  drawerOpen,
  onDrawerOpen,
  tabListRef,
  hamburgerRef,
  onTabKeyDown,
  themeBar,
  children,
}: DashboardLayoutProps) {
  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <div className="app">
        <header className="app__header" role="banner">
          <div className="app__header-inner">
            <button
              ref={hamburgerRef}
              type="button"
              className="app__hamburger"
              aria-label="Open navigation menu"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav-drawer"
              onClick={onDrawerOpen}
            >
              <span className="app__hamburger-bar" aria-hidden="true" />
              <span className="app__hamburger-bar" aria-hidden="true" />
              <span className="app__hamburger-bar" aria-hidden="true" />
            </button>

            <span className="app__brand">NotifyChain</span>

            <div className="app__theme-bar">{themeBar}</div>
          </div>
        </header>

        <Sidebar
          activeTab={activeTab}
          onSelectTab={onSelectTab}
          tabListRef={tabListRef}
          onTabKeyDown={onTabKeyDown}
        />

        <main id="main-content" className="app__content" tabIndex={-1}>
          {children}
        </main>

        <footer className="app__footer" role="contentinfo" aria-label="Dashboard footer">
          <p className="app__footer-text">NotifyChain Dashboard — {NAV_ITEMS.length} sections</p>
        </footer>
      </div>
    </>
  );
}
