import type { DashboardColumnId, DashboardPreferences } from '../utils/dashboardPreferences';

const COLUMNS: { id: DashboardColumnId; label: string }[] = [
  { id: 'contract', label: 'Contract' },
  { id: 'event', label: 'Event' },
  { id: 'kind', label: 'Kind' },
  { id: 'received', label: 'Received' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'transaction', label: 'Transaction' },
];

interface DashboardViewPreferencesProps {
  preferences: DashboardPreferences;
  onChange: (preferences: DashboardPreferences) => void;
  onReset: () => void;
}

export function DashboardViewPreferences({
  preferences,
  onChange,
  onReset,
}: DashboardViewPreferencesProps) {
  const toggleColumn = (column: DashboardColumnId) => {
    const visibleColumns = preferences.visibleColumns.includes(column)
      ? preferences.visibleColumns.filter((visible) => visible !== column)
      : [...preferences.visibleColumns, column];

    if (visibleColumns.length > 0) {
      onChange({ ...preferences, visibleColumns });
    }
  };

  return (
    <details className="dashboard-view-preferences">
      <summary>Dashboard view settings</summary>
      <div className="dashboard-view-preferences__body">
        <label className="dashboard-view-preferences__density">
          Table density
          <select
            value={preferences.density}
            onChange={(event) => {
              const density = event.target.value === 'compact' ? 'compact' : 'comfortable';
              onChange({
                ...preferences,
                density,
              });
            }}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>

        <fieldset className="dashboard-view-preferences__columns">
          <legend>Visible event columns</legend>
          {COLUMNS.map(({ id, label }) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={preferences.visibleColumns.includes(id)}
                disabled={
                  preferences.visibleColumns.length === 1 && preferences.visibleColumns.includes(id)
                }
                onChange={() => toggleColumn(id)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        <button type="button" className="dashboard-view-preferences__reset" onClick={onReset}>
          Reset dashboard view
        </button>
      </div>
    </details>
  );
}
