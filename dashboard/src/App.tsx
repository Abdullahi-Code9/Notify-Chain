
import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';

import { EventExplorerPage } from './pages/EventExplorerPage';
import { NotificationTimelineView } from './components/NotificationTimelineView';
import { ActivityFeed } from './components/ActivityFeed';
import { UserActivityTimeline } from './components/UserActivityTimeline';
import { RetryStatisticsPanel } from './components/RetryStatisticsPanel';
import { WebhookDashboardPage } from './pages/WebhookDashboardPage';
import { ExportHistoryPage } from './pages/ExportHistoryPage';
import { NotificationSearchPage } from './pages/NotificationSearchPage';
import { NotificationPreferencesPage } from './pages/NotificationPreferencesPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { ChannelDetailsPage } from './pages/ChannelDetailsPage';
import { RpcBenchmarkPage } from './pages/RpcBenchmarkPage';

import { ThemeToggle } from './components/ThemeToggle';
import { MobileNavDrawer, NAV_ITEMS, type Tab } from './components/MobileNavDrawer';
import { ToastProvider } from './context/ToastContext';
import { useTheme } from './hooks/useTheme';
import { useIsMobileNav } from './hooks/useMediaQuery';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { KeyboardShortcutsHelp } from './components/KeyboardShortcutsHelp';
import { DeliveryHeatmap } from './components/DeliveryHeatmap';
import { useEventStore } from './store/eventStore';
import { SyncStatus } from './components/SyncStatus';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DashboardLayout } from './layouts/DashboardLayout';

export function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const hash = window.location.hash.slice(1);

    if (NAV_ITEMS.some((item) => item.id === hash)) {
      return hash as Tab;
    }

    return 'explorer';
  });

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const isMobileNav = useIsMobileNav();
  const { theme, toggleTheme } = useTheme();
  const events = useEventStore((state) => state.events);

  const tabListRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  // Keyboard shortcuts
  const handleToggleHelp = useCallback(() => {
    setHelpOpen((prev) => !prev);
  }, []);

  const handleCloseHelp = useCallback(() => {
    setHelpOpen(false);
  }, []);

  useKeyboardShortcuts({
    activeTab: tab,
    onTabChange: setTab,
    onToggleTheme: toggleTheme,
    helpOpen,
    onToggleHelp: handleToggleHelp,
    onCloseHelp: handleCloseHelp,
  });

  // Keyboard navigation inside the tab list
  const handleTabKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const tabs = Array.from(
        tabListRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="tab"]',
        ) ?? [],
      );

      if (tabs.length === 0) return;

      const current = tabs.findIndex(
        (element) => element === document.activeElement,
      );

      if (current === -1) return;

      let next = current;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        next = (current + 1) % tabs.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        next = (current - 1 + tabs.length) % tabs.length;
      } else if (e.key === 'Home') {
        e.preventDefault();
        next = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        next = tabs.length - 1;
      }

      if (next !== current) {
        tabs[next]?.focus();

        const navItem = NAV_ITEMS.find(
          (item) => item.id === tabs[next]?.id.replace('tab-', ''),
        );

        if (navItem) {
          setTab(navItem.id);
        }
      }
    },
    [],
  );

  const handleDrawerOpen = useCallback(() => {
    setDrawerOpen(true);
  }, []);

  const handleDrawerClose = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  // Keep the URL hash in sync with the active tab
  useEffect(() => {
    if (window.location.hash.slice(1) !== tab) {
      window.location.hash = tab;
    }
  }, [tab]);

  // Update the active tab when the URL hash changes
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1);

      if (NAV_ITEMS.some((item) => item.id === hash)) {
        setTab(hash as Tab);
      }
    };

    window.addEventListener('hashchange', handleHashChange);

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

  // Close the mobile drawer when switching to desktop layout
  useEffect(() => {
    if (!isMobileNav && drawerOpen) {
      setDrawerOpen(false);
    }
  }, [isMobileNav, drawerOpen]);

  return (
    <ToastProvider>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <KeyboardShortcutsHelp
        isOpen={helpOpen}
        onClose={handleCloseHelp}
      />

      <DashboardLayout
        activeTab={tab}
        onSelectTab={setTab}
        drawerOpen={drawerOpen}
        onDrawerOpen={handleDrawerOpen}
        onDrawerClose={handleDrawerClose}
        tabListRef={tabListRef}
        hamburgerRef={hamburgerRef}
        onTabKeyDown={handleTabKeyDown}
        themeBar={
          <>
            <SyncStatus />
            <ThemeToggle
              theme={theme}
              onToggle={toggleTheme}
            />
          </>
        }
      >
        <main id="main-content" tabIndex={-1}>
          {NAV_ITEMS.map((item) => (
            <div
              key={item.id}
              role="tabpanel"
              id={`panel-${item.id}`}
              aria-labelledby={`tab-${item.id}`}
              hidden={tab !== item.id}
              className="app__panel"
            >
              {tab === item.id && renderPanel(item.id, events)}
            </div>
          ))}
        </main>
      </DashboardLayout>

      <MobileNavDrawer
        isOpen={drawerOpen}
        onClose={handleDrawerClose}
        activeTab={tab}
        onSelectTab={(selectedTab) => {
          setTab(selectedTab);
          handleDrawerClose();
        }}
      />
    </ToastProvider>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderPanel(tab: Tab, events: any[]) {
  switch (tab) {
    case 'explorer':
      return (
        <ErrorBoundary section="Event Explorer">
          <>
            <EventExplorerPage />
            <DeliveryHeatmap events={events} />
          </>
        </ErrorBoundary>
      );

    case 'timeline':
      return (
        <ErrorBoundary section="Delivery Timeline">
          <NotificationTimelineView />
        </ErrorBoundary>
      );

    case 'activity':
      return (
        <ErrorBoundary section="Activity Feed">
          <ActivityFeed />
        </ErrorBoundary>
      );

    case 'user-activity':
      return (
        <ErrorBoundary section="User Activity">
          <UserActivityTimeline />
        </ErrorBoundary>
      );

    case 'retry-stats':
      return (
        <ErrorBoundary section="Retry Statistics">
          <RetryStatisticsPanel />
        </ErrorBoundary>
      );

    case 'webhooks':
      return (
        <ErrorBoundary section="Webhook Performance">
          <WebhookDashboardPage />
        </ErrorBoundary>
      );

    case 'export-history':
      return (
        <ErrorBoundary section="Export History">
          <ExportHistoryPage />
        </ErrorBoundary>
      );

    case 'search':
      return (
        <ErrorBoundary section="Notification Search">
          <NotificationSearchPage />
        </ErrorBoundary>
      );

    case 'preferences':
      return (
        <ErrorBoundary section="Notification Preferences">
          <NotificationPreferencesPage />
        </ErrorBoundary>
      );

    case 'templates':
      return (
        <ErrorBoundary section="Templates">
          <TemplatesPage />
        </ErrorBoundary>
      );

    case 'channels':
      return (
        <ErrorBoundary section="Channel Details">
          <ChannelDetailsPage />
        </ErrorBoundary>
      );

    case 'rpc-benchmark':
      return (
        <ErrorBoundary section="RPC Benchmark">
          <RpcBenchmarkPage />
        </ErrorBoundary>
      );

    default:
      return null;
  }
}