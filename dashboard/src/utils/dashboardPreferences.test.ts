import {
  DEFAULT_DASHBOARD_PREFERENCES,
  loadDashboardPreferences,
  normalizeDashboardPreferences,
  saveDashboardPreferences,
} from './dashboardPreferences';

const STORAGE_KEY = 'notify-chain:dashboard-preferences:v1';

describe('dashboard preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses defaults when storage is empty and restores valid preferences', () => {
    expect(loadDashboardPreferences()).toEqual(DEFAULT_DASHBOARD_PREFERENCES);

    const saved = {
      density: 'compact' as const,
      visibleColumns: ['event', 'transaction'] as const,
      defaultSort: 'oldest' as const,
    };
    saveDashboardPreferences({ ...saved, visibleColumns: [...saved.visibleColumns] });

    expect(loadDashboardPreferences()).toEqual(saved);
  });

  it('falls back safely from malformed storage and invalid preference values', () => {
    localStorage.setItem(STORAGE_KEY, '{bad json');
    expect(loadDashboardPreferences()).toEqual(DEFAULT_DASHBOARD_PREFERENCES);

    expect(
      normalizeDashboardPreferences({
        density: 'dense',
        visibleColumns: ['unknown', 'event', 'event'],
        defaultSort: 'random',
      }),
    ).toEqual({
      ...DEFAULT_DASHBOARD_PREFERENCES,
      visibleColumns: ['event'],
    });

    expect(normalizeDashboardPreferences({ visibleColumns: [] }).visibleColumns).toEqual(
      DEFAULT_DASHBOARD_PREFERENCES.visibleColumns,
    );
  });

  it('migrates the previous sort preference into dashboard preferences', () => {
    localStorage.setItem('notifychain:sortBy', 'priority');

    expect(loadDashboardPreferences().defaultSort).toBe('priority');
  });
});
