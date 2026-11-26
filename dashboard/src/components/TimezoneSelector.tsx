import { useId, type ChangeEvent } from 'react';
import { useTimezoneStore } from '../store/timezoneStore';
import { getLocalTimeZoneName, TIMEZONE_OPTIONS } from '../utils/timezone';

/**
 * Dashboard-wide timezone preference selector (issue #1108).
 *
 * Switches every event table and detail view between the browser's local
 * timezone and UTC. Raw UTC timestamps remain visible in event metadata
 * regardless of the selection.
 */
export function TimezoneSelector() {
  const id = useId();
  const preference = useTimezoneStore((state) => state.preference);
  const setPreference = useTimezoneStore((state) => state.setPreference);
  const localName = getLocalTimeZoneName();

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setPreference(e.target.value);
  };

  // A persisted IANA zone other than local/UTC is still shown as selected.
  const isKnown = TIMEZONE_OPTIONS.some((option) => option.value === preference);

  return (
    <div className="timezone-selector">
      <label htmlFor={id} className="timezone-selector__label">
        Timezone
      </label>
      <select
        id={id}
        className="timezone-selector__select"
        value={preference}
        onChange={handleChange}
        aria-describedby={`${id}-hint`}
      >
        {TIMEZONE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.value === 'local' ? `${option.label} (${localName})` : option.label}
          </option>
        ))}
        {!isKnown && <option value={preference}>{preference}</option>}
      </select>
      <span id={`${id}-hint`} className="sr-only">
        Controls how timestamps are displayed across event tables and detail views.
      </span>
    </div>
  );
}
