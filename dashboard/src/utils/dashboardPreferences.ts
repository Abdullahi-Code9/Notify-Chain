import type { NotificationSortOption } from '../types/event';

export type DashboardDensity = 'comfortable' | 'compact';
export type DashboardColumnId =
  | 'contract'
  | 'event'
  | 'kind'
  | 'received'
  | 'ledger'
  | 'transaction';

export interface DashboardPreferences {
  density: DashboardDensity;
  visibleColumns: DashboardColumnId[];
  defaultSort: NotificationSortOption;
}

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  density: 'comfortable',
  visibleColumns: ['contract', 'event', 'kind', 'received', 'ledger', 'transaction'],
  defaultSort: 'newest',
};

const STORAGE_KEY = 'notify-chain:dashboard-preferences:v1';
const LEGACY_SORT_KEY = 'notifychain:sortBy';
const COLUMN_IDS = new Set<DashboardColumnId>(DEFAULT_DASHBOARD_PREFERENCES.visibleColumns);
const SORT_OPTIONS = new Set<NotificationSortOption>([
  'newest',
  'oldest',
  'priority',
  'delivery_status',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSort(value: unknown): value is NotificationSortOption {
  return typeof value === 'string' && SORT_OPTIONS.has(value as NotificationSortOption);
}

export function normalizeDashboardPreferences(value: unknown): DashboardPreferences {
  if (!isRecord(value)) {
    return {
      ...DEFAULT_DASHBOARD_PREFERENCES,
      visibleColumns: [...DEFAULT_DASHBOARD_PREFERENCES.visibleColumns],
    };
  }

  const visibleColumns = Array.isArray(value.visibleColumns)
    ? [
        ...new Set(
          value.visibleColumns.filter(
            (column): column is DashboardColumnId =>
              typeof column === 'string' && COLUMN_IDS.has(column as DashboardColumnId),
          ),
        ),
      ]
    : [...DEFAULT_DASHBOARD_PREFERENCES.visibleColumns];

  return {
    density:
      value.density === 'compact' || value.density === 'comfortable'
        ? value.density
        : DEFAULT_DASHBOARD_PREFERENCES.density,
    visibleColumns:
      visibleColumns.length > 0
        ? visibleColumns
        : [...DEFAULT_DASHBOARD_PREFERENCES.visibleColumns],
    defaultSort: validSort(value.defaultSort)
      ? value.defaultSort
      : DEFAULT_DASHBOARD_PREFERENCES.defaultSort,
  };
}

export function loadDashboardPreferences(): DashboardPreferences {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      return normalizeDashboardPreferences(JSON.parse(saved) as unknown);
    }

    const legacySort = localStorage.getItem(LEGACY_SORT_KEY);
    return normalizeDashboardPreferences({
      ...DEFAULT_DASHBOARD_PREFERENCES,
      defaultSort: validSort(legacySort) ? legacySort : DEFAULT_DASHBOARD_PREFERENCES.defaultSort,
    });
  } catch {
    return normalizeDashboardPreferences(DEFAULT_DASHBOARD_PREFERENCES);
  }
}

export function saveDashboardPreferences(preferences: DashboardPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeDashboardPreferences(preferences)));
  } catch {
    // Preferences remain usable for the current session when storage is unavailable.
  }
}
