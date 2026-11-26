# Frontend Architecture and Component Documentation Guide (#1142)

> **Audience**: Contributors, integrators, and reviewers who need a clear
> picture of the dashboard structure before adding a new feature or fixing
> a bug.

---

## 1. Project Overview

The Notify-Chain frontend consists of **two separate React applications**:

| Application | Path | Stack | Purpose |
|-------------|------|-------|---------|
| **Dashboard** | `dashboard/` | React 19, Vite 6, Zustand 5, Storybook, Jest + Playwright | Operator dashboard — primary day-to-day interface |
| **Frontend** | `frontend/` | React 18, Vite 5, Tailwind CSS, Zustand 4, Vitest | Secondary UI for end-user flows (subscription forms, filters, preferences) |

Both consume the **listener HTTP API** (`listener/`) directly.  Neither has
its own backend.

---

## 2. Dashboard Application (`dashboard/`)

### 2.1 Directory Structure

```
dashboard/
├── src/
│   ├── App.tsx               ← Root component; hash-based tab router
│   ├── main.tsx              ← Entry point; mounts <App />
│   ├── index.css
│   ├── vite-env.d.ts
│   │
│   ├── pages/                ← One file per top-level tab/view
│   ├── components/           ← Reusable UI atoms and panels
│   ├── layouts/              ← Full-page structural shells
│   ├── hooks/                ← Custom React hooks
│   ├── services/             ← HTTP API client functions
│   ├── store/                ← Zustand state stores
│   ├── context/              ← React context providers
│   ├── types/                ← TypeScript interfaces and unions
│   ├── utils/                ← Pure helper functions
│   ├── config/               ← Environment-derived constants
│   ├── theme/                ← CSS-in-JS and design tokens
│   ├── styles/               ← Global CSS
│   ├── stories/              ← Storybook component stories
│   ├── benchmark/            ← RPC benchmark utilities
│   ├── test/                 ← Shared test helpers and fixtures
│   ├── __tests__/            ← Integration and cross-component tests
│   └── ...
└── package.json
```

### 2.2 Routing

The dashboard uses **hash-based routing** — no React Router or file-based
router.  `App.tsx` reads `window.location.hash` and renders the matching
`<TabPanel>`.

```
URL hash       Tab id               Page component
──────────     ──────────────────   ────────────────────────────
#explorer      explorer             EventExplorerPage
#timeline      timeline             NotificationTimelineView
#activity      activity             ActivityFeed
#user-activity user-activity        UserActivityTimeline
#retry-stats   retry-stats          RetryStatisticsPanel
#webhooks      webhooks             WebhookDashboardPage
#export-history export-history      ExportHistoryPage
#search        search               NotificationSearchPage
#preferences   preferences          NotificationPreferencesPage
#templates     templates            TemplatesPage
#channels      channels             ChannelDetailsPage
#destinations  destinations         NotificationDestinationsPage
#rpc-benchmark rpc-benchmark        RpcBenchmarkPage
#contract-detail?address=<addr>     ContractDetailPage
```

**Navigation items** are defined in `components/MobileNavDrawer.tsx` as the
`NAV_ITEMS` array.  To add a new tab:

1. Add an entry to `NAV_ITEMS` in `MobileNavDrawer.tsx`.
2. Create the page component under `pages/`.
3. Add a `case` to `renderPanel()` in `App.tsx`.
4. Import and render the page inside the `case`.

The active tab is kept in sync with the hash via two `useEffect` hooks in
`App.tsx` — one that updates the hash when the tab state changes, and one that
updates the tab when the hash changes externally (browser back/forward).

---

## 3. Major Pages and Their Responsibilities

| Page | File | Responsibility |
|------|------|----------------|
| Event Explorer | `pages/EventExplorerPage.tsx` | Table of raw blockchain events from `/api/events`; filter, sort, paginate |
| Notification Search | `pages/NotificationSearchPage.tsx` | Full-text + filtered search over `/api/notifications/search` |
| Webhook Dashboard | `pages/WebhookDashboardPage.tsx` | Webhook delivery health, failures, charts |
| Export History | `pages/ExportHistoryPage.tsx` | Tracks data export jobs via `/api/notifications/export` |
| Templates | `pages/TemplatesPage.tsx` | CRUD for notification templates via `/api/templates` |
| Channel Details | `pages/ChannelDetailsPage.tsx` | Stellar contract channel metadata and subscription state |
| Notification Destinations | `pages/NotificationDestinationsPage.tsx` | Configure Discord/email/webhook delivery endpoints |
| Notification Preferences | `pages/NotificationPreferencesPage.tsx` | Per-user notification preference settings |
| RPC Benchmark | `pages/RpcBenchmarkPage.tsx` | Latency testing for the Stellar RPC connection |
| Contract Detail | `pages/ContractDetailPage.tsx` | Deep-dive view for a single contract address (linked from Event Explorer) |

---

## 4. Reusable Components

Components live in `dashboard/src/components/`.  Each component is a focused
UI unit with a single, named export.

### 4.1 Layout and Navigation

| Component | File | Responsibility |
|-----------|------|----------------|
| `DashboardLayout` | `layouts/DashboardLayout.tsx` | Full-page shell: sidebar on desktop, hamburger on mobile |
| `Sidebar` | `components/Sidebar.tsx` | Desktop vertical tab list |
| `MobileNavDrawer` | `components/MobileNavDrawer.tsx` | Slide-in navigation drawer (mobile); exports `NAV_ITEMS` and `Tab` type |

### 4.2 Event Display

| Component | File | Responsibility |
|-----------|------|----------------|
| `EventExplorerTable` | `components/EventExplorerTable.tsx` | Virtualized table of blockchain events |
| `EventCard` | `components/EventCard.tsx` | Compact card for a single event |
| `EventRow` | `components/EventRow.tsx` | Table row for the events list |
| `EventList` | `components/EventList.tsx` | Scrollable list of `EventCard` items |
| `EventFiltersBar` | `components/EventFiltersBar.tsx` | Contract/type/date filter controls for the Event Explorer |
| `EventExplorerCard` | `components/EventExplorerCard.tsx` | Detailed card variant for the explorer grid |
| `EventActivityChart` | `components/EventActivityChart.tsx` | Bar/line chart of event volume over time |

### 4.3 Notifications

| Component | File | Responsibility |
|-----------|------|----------------|
| `NotificationDetailsDrawer` | `components/NotificationDetailsDrawer.tsx` | Slide-in drawer with full notification metadata |
| `NotificationSearchBar` | `components/NotificationSearchBar.tsx` | Search input with debouncing |
| `NotificationSummaryCards` | `components/NotificationSummaryCards.tsx` | KPI cards (sent, failed, pending counts) |
| `NotificationSummaryPanel` | `components/NotificationSummaryPanel.tsx` | Aggregated stats panel |
| `NotificationTimelineView` | `components/NotificationTimelineView.tsx` | Chronological delivery timeline |
| `NotificationHealthPanel` | `components/NotificationHealthPanel.tsx` | Service health indicators for the notification pipeline |
| `RetryStatisticsPanel` | `components/RetryStatisticsPanel.tsx` | Retry queue depth and failure rates |
| `DeliveryHeatmap` | `components/DeliveryHeatmap.tsx` | Calendar-based heatmap of delivery activity |

### 4.4 Webhooks

| Component | File | Responsibility |
|-----------|------|----------------|
| `WebhookSummaryCards` | `components/WebhookSummaryCards.tsx` | Delivery rate, error rate, latency KPIs |
| `WebhookDeliveryChart` | `components/WebhookDeliveryChart.tsx` | Time-series chart of webhook delivery outcomes |
| `WebhookFailedTable` | `components/WebhookFailedTable.tsx` | Table of recent failed webhook deliveries |
| `WebhookFiltersBar` | `components/WebhookFiltersBar.tsx` | Date/status filters for the webhook view |

### 4.5 Utility / Shared

| Component | File | Responsibility |
|-----------|------|----------------|
| `ErrorBoundary` | `components/ErrorBoundary.tsx` | Catches React render errors; every tab panel is wrapped |
| `EmptyState` | `components/EmptyState.tsx` | Placeholder UI for empty lists or missing data |
| `Modal` | `components/Modal.tsx` | Accessible dialog with focus trap |
| `ConfirmationDialog` | `components/ConfirmationDialog.tsx` | Modal variant for destructive actions |
| `FormField` | `components/FormField.tsx` | Labelled input wrapper with error display |
| `PaginationControls` | `components/PaginationControls.tsx` | Page navigation for tables |
| `CopyButton` | `components/CopyButton.tsx` | One-click copy to clipboard |
| `SyncStatus` | `components/SyncStatus.tsx` | Live event-sync state badge in the top bar |
| `IndexingHealthPanel` | `components/IndexingHealthPanel.tsx` | Ledger lag and indexing status indicator |
| `SearchAutocomplete` | `components/SearchAutocomplete.tsx` | Typeahead search with suggestion dropdown |
| `ThemeToggle` | `components/ThemeToggle.tsx` | Dark/light mode switch |
| `TimezoneSelector` | `components/TimezoneSelector.tsx` | Time zone picker persisted to localStorage |
| `KeyboardShortcutsHelp` | `components/KeyboardShortcutsHelp.tsx` | Modal listing all keyboard shortcuts |
| `ActivityFeed` | `components/ActivityFeed.tsx` | Live activity stream with pagination |
| `UserActivityTimeline` | `components/UserActivityTimeline.tsx` | Per-user activity history |
| `WalletConnectButton` | `components/WalletConnectButton.tsx` | Stellar wallet connection (Freighter / ALBEDO via Stellar Wallets Kit) |
| `TemplatePreviewModal` | `components/TemplatePreviewModal.tsx` | In-place template render preview |

**Convention**: every component:
- Has a single named export matching its filename.
- Accepts a typed props interface defined in the same file or the nearest `types/` file.
- Is wrapped in `ErrorBoundary` at the page level, not inside the component itself.
- Has a `.test.tsx` test file alongside it (or in `__tests__/`).
- May have a `.stories.tsx` Storybook file.

---

## 5. State Management

State is managed with **Zustand** (v5 for the dashboard, v4 for the frontend).
Zustand stores are plain modules that export a typed `create()` hook.

### 5.1 Dashboard Stores (`dashboard/src/store/`)

| Store | File | What it holds |
|-------|------|---------------|
| `useEventStore` | `eventStore.ts` | All fetched `BlockchainEvent[]`, filter state, sort preference, loading/error state |
| `useTimezoneStore` | `timezoneStore.ts` | Active IANA timezone, persisted to localStorage |
| `useRpcBenchmarkStore` | `rpcBenchmarkStore.ts` | RPC latency samples and benchmark state |
| `useWalletStore` | `walletStore.ts` | Connected Stellar wallet address and connection state |

### 5.2 Event Store Detail (`eventStore.ts`)

The event store is the central data hub for the Event Explorer and related
components.  Key state fields:

```ts
events: BlockchainEvent[]          // deduplicated by eventId
filters: EventFilters              // contract, type, status, date, txHash, search
isLoading: boolean
error: string | null
lastFetchedAt: number              // Unix ms, drives cache invalidation
lastSuccessfulSyncAt: number | null
lastSyncFailureAt: number | null
lastSyncError: string | null
```

Mutations:
- `setEvents(events)` — replaces the entire list (deduplicated).
- `appendEvents(events)` — merges new events (SSE feed).
- `updateEventStatus(eventId, status)` — patches a single event's
  `notificationStatus` after a status-change event arrives.
- `markSyncSuccess() / markSyncFailure(error)` — updated by the polling loop.

**Sort preference** is persisted to `localStorage` under the key
`notifychain:sortBy` so it survives page refreshes.

---

## 6. API Integration Patterns

All HTTP calls to the listener go through typed service modules in
`dashboard/src/services/`.  Components call services, never `fetch()` directly.

### 6.1 Service Modules

| Module | Listener endpoint(s) | Description |
|--------|----------------------|-------------|
| `eventsApi.ts` | `/api/events`, `/api/status` | Fetch events, contract pause status |
| `activityApi.ts` | `/api/activity` | Activity feed pagination |
| `timelineApi.ts` | `/api/notifications/history` | Delivery timeline |
| `notificationSummaryApi.ts` | `/api/notifications/analytics` | KPI aggregates |
| `notificationHealthApi.ts` | `/api/notifications/health` | Pipeline health |
| `webhookApi.ts` | `/api/webhooks` | Webhook summary and delivery history |
| `templatesApi.ts` | `/api/templates` | Template CRUD |
| `destinationsApi.ts` | `/api/notifications/destinations` | Delivery endpoints CRUD |
| `retryStatisticsApi.ts` | `/api/notifications/retry-stats` | Retry queue metrics |
| `userActivityApi.ts` | `/api/user-activity` | Per-user event history |
| `indexingHealthApi.ts` | `/api/indexing/health` | Ledger lag and indexing status |
| `rpcBenchmarkService.ts` | Direct Stellar RPC | Latency sampling (bypasses listener) |
| `eventStream.ts` | `/api/events/stream` (SSE) | Server-sent event feed |

### 6.2 API Call Pattern

Every service function follows this structure:

```ts
// 1. Build URL with typed params
const url = new URL(`${BASE_URL}/api/resource`);
url.searchParams.set('limit', String(params.limit ?? 50));

// 2. Fetch with timeout
const response = await fetchWithTimeout(url.toString());

// 3. Guard on HTTP status
if (!response.ok) {
  throw new Error(`Failed: ${response.status}`);
}

// 4. Return typed JSON
return response.json() as Promise<ResourceResponse>;
```

The `fetchWithTimeout` helper (defined in `eventsApi.ts`) wraps `fetch` with
an `AbortController` and a configurable timeout (`LISTENER_API_TIMEOUT_MS =
10 000 ms` by default).  It throws a recognisable `'timed out'` message on
timeout so the UI can display a specific message rather than a generic error.

### 6.3 Failure Injection (Testing)

`eventsApi.ts` exports a `withFailureInjection(component, fn)` helper and
`injectFailure / clearInjectedFailures` utilities.  These allow component and
integration tests to simulate RPC, database, scheduler, and provider failures
deterministically without real network calls.

```ts
// In a test:
injectFailure('rpc', 1, 'Simulated RPC timeout');
await expect(fetchStatus(baseUrl)).rejects.toThrow('Simulated RPC timeout');
clearInjectedFailures();
```

---

## 7. Custom Hooks

Hooks live in `dashboard/src/hooks/`.  They encapsulate reusable stateful
logic that would otherwise be duplicated across components.

| Hook | File | Purpose |
|------|------|---------|
| `useTheme` | `useTheme.ts` | Dark/light mode toggle; persists to `localStorage` |
| `useIsMobileNav` | `useMediaQuery.ts` | Returns `true` when viewport is below the mobile breakpoint |
| `useKeyboardShortcuts` | `useKeyboardShortcuts.ts` | Global keyboard shortcut handler (tab switching, theme, help) |
| `useEventSelectors` | `useEventSelectors.ts` | Memoized selectors over `useEventStore` for filtered/sorted event slices |
| `useNotificationSummary` | `useNotificationSummary.ts` | Fetches and caches notification KPI data |
| `useWebhookDashboard` | `useWebhookDashboard.ts` | Fetches webhook summary and handles refresh |
| `useAccessibleAnnouncement` | `useAccessibleAnnouncement.ts` | Posts messages to an ARIA live region for screen readers |
| `useCopyId` | `useCopyId.ts` | Clipboard copy with transient "copied" feedback state |
| `useDebounce` | `useDebounce.ts` | Debounces a value by a configurable delay |
| `useWalletAccountSync` | `useWalletAccountSync.ts` | Syncs the connected Stellar wallet address into `useWalletStore` |

---

## 8. Component Conventions

### Naming and File Organization

- Component names and filenames use **PascalCase** (`EventCard.tsx`).
- Hook names and filenames use **camelCase with `use` prefix** (`useTheme.ts`).
- Service modules are **camelCase** with a domain suffix (`eventsApi.ts`,
  `templatesApi.ts`).
- Each component, hook, and service has a co-located test file
  (`*.test.ts` or `*.test.tsx`).

### Props

- Props interfaces are **named and exported** so they can be referenced by
  tests and Storybook stories.
- Optional props use `?` rather than `| undefined` unions.
- Event handler props follow the `onAction` naming convention
  (`onSelectTab`, `onClose`).

### Error Handling

- Every `<TabPanel>` in `App.tsx` is wrapped in `<ErrorBoundary section="...">`.
- Service functions throw typed `Error` instances with descriptive messages.
- Components display the `EmptyState` component for empty data rather than
  `null`/blank renders.
- Loading and error states are stored in Zustand and read via selectors.

### Accessibility

- Interactive elements carry `role`, `aria-label`, and `aria-controls`
  attributes where native semantics are insufficient.
- The tab navigation in `App.tsx` follows the ARIA
  [Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/), with
  `role="tablist"`, `role="tab"`, and `role="tabpanel"`.
- Keyboard navigation (Arrow keys, Home, End) is handled in
  `handleTabKeyDown` in `App.tsx`.
- The `<a href="#main-content">` skip link allows keyboard users to bypass
  the navigation bar.
- Announcements for dynamic content changes use `useAccessibleAnnouncement`.

---

## 9. Frontend Application (`frontend/`)

The secondary `frontend/` application handles **end-user-facing flows** that
are distinct from the operator dashboard.

### Directory Structure

```
frontend/
├── src/
│   ├── components/
│   │   ├── SubscriptionForm.tsx       — Subscribe a wallet to a channel
│   │   ├── SavedFiltersPanel.tsx      — Manage user-defined event filters
│   │   └── preferences/               — Notification preference UI
│   ├── hooks/                         — Custom hooks
│   ├── services/                      — API client wrappers
│   ├── stores/
│   │   └── useSavedFilters.ts         — Zustand store for saved filter sets
│   └── types/
├── app/                               — Next.js App Router pages
│   ├── layout.tsx                     — Root layout
│   ├── page.tsx                       — Home / landing page
│   └── analytics/                     — Analytics sub-page
├── next.config.js                     — Next.js configuration
├── vite.config.ts                     — Vite configuration (migration in progress)
└── package.json
```

> **Note**: The `frontend/` app is in a Vite → Next.js App Router migration.
> Both configs coexist during the transition period.

### Responsibilities

- `SubscriptionForm.tsx` — allows a user to subscribe their wallet address
  to a named Stellar contract channel.  Calls the listener
  `POST /api/subscriptions` endpoint.
- `SavedFiltersPanel.tsx` — renders and manages a user's saved filter
  presets (persisted in Zustand / localStorage).
- `preferences/` — notification preference settings (frequency, channels)
  for end users (distinct from the operator preferences in the dashboard).

---

## 10. Adding a New Dashboard Feature

Follow these steps to add a new page or capability to the dashboard.

### New tab / page

```bash
# 1. Create the page component
touch dashboard/src/pages/MyFeaturePage.tsx

# 2. Create its test file
touch dashboard/src/pages/MyFeaturePage.test.tsx
```

```tsx
// dashboard/src/pages/MyFeaturePage.tsx
export function MyFeaturePage() {
  return <div>My feature</div>;
}
```

```tsx
// dashboard/src/components/MobileNavDrawer.tsx
// Add to NAV_ITEMS array:
{ id: 'my-feature', label: 'My Feature', icon: '🔧' }
```

```tsx
// dashboard/src/App.tsx
import { MyFeaturePage } from './pages/MyFeaturePage';

// In renderPanel():
case 'my-feature':
  return (
    <ErrorBoundary section="My Feature">
      <MyFeaturePage />
    </ErrorBoundary>
  );
```

### New API call

```ts
// dashboard/src/services/myFeatureApi.ts
import { getEventsApiBaseUrl } from '../config/eventsApiUrl';

const BASE_URL = getEventsApiBaseUrl();

export interface MyFeatureResponse { /* ... */ }

export async function fetchMyFeature(): Promise<MyFeatureResponse> {
  const response = await fetch(`${BASE_URL}/api/my-feature`);
  if (!response.ok) throw new Error(`Failed: ${response.status}`);
  return response.json();
}
```

### New Zustand store

```ts
// dashboard/src/store/myFeatureStore.ts
import { create } from 'zustand';

interface MyFeatureState {
  data: MyFeatureDatum[];
  isLoading: boolean;
  setData: (data: MyFeatureDatum[]) => void;
  setLoading: (v: boolean) => void;
}

export const useMyFeatureStore = create<MyFeatureState>((set) => ({
  data: [],
  isLoading: false,
  setData: (data) => set({ data }),
  setLoading: (isLoading) => set({ isLoading }),
}));
```

---

## 11. Related Documentation

| Document | Contents |
|----------|----------|
| [`ARCHITECTURE_OVERVIEW.md`](ARCHITECTURE_OVERVIEW.md) | Full system architecture including the listener and smart contract layers |
| [`SYSTEM_ARCHITECTURE.md`](SYSTEM_ARCHITECTURE.md) | Mermaid diagrams of all system layers |
| [`BACKEND_ARCHITECTURE.md`](BACKEND_ARCHITECTURE.md) | Listener service internals |
| [`listener/API.md`](listener/API.md) | Complete listener REST API reference |
| [`listener/API_ERROR_REFERENCE.md`](listener/API_ERROR_REFERENCE.md) | Error code catalogue |
| [`NOTIFICATION_LIFECYCLE.md`](NOTIFICATION_LIFECYCLE.md) | End-to-end notification delivery lifecycle |
| [`SESSION_LIFECYCLE.md`](SESSION_LIFECYCLE.md) | Session expiration and revocation policy (#1140) |
