import { create } from 'zustand';
import {
  DEFAULT_TIMEZONE_PREFERENCE,
  normalizeTimezonePreference,
  resolveTimeZone,
  type TimezonePreference,
} from '../utils/timezone';

export const TIMEZONE_STORAGE_KEY = 'notify-chain:timezone-preference';

function readStoredPreference(): TimezonePreference {
  try {
    return normalizeTimezonePreference(localStorage.getItem(TIMEZONE_STORAGE_KEY));
  } catch {
    return DEFAULT_TIMEZONE_PREFERENCE;
  }
}

function writeStoredPreference(preference: TimezonePreference): void {
  try {
    localStorage.setItem(TIMEZONE_STORAGE_KEY, preference);
  } catch {
    // Storage may be unavailable (private mode, quota); the preference still
    // applies for the current session.
  }
}

export interface TimezoneState {
  preference: TimezonePreference;
  /** `timeZone` option for `Intl`; `undefined` means the browser's local zone. */
  timeZone: string | undefined;
  setPreference: (preference: unknown) => void;
}

export const useTimezoneStore = create<TimezoneState>((set) => {
  const initial = readStoredPreference();
  return {
    preference: initial,
    timeZone: resolveTimeZone(initial),
    setPreference: (value) => {
      const preference = normalizeTimezonePreference(value);
      writeStoredPreference(preference);
      set({ preference, timeZone: resolveTimeZone(preference) });
    },
  };
});

/** Non-reactive accessor used as the default by the formatting helpers. */
export function getActiveTimeZone(): string | undefined {
  return useTimezoneStore.getState().timeZone;
}

/**
 * Subscribes a component to the active timezone so it re-renders when the
 * preference changes. Returns the `timeZone` value to pass to formatters.
 */
export function useActiveTimeZone(): string | undefined {
  return useTimezoneStore((state) => state.timeZone);
}
