import { create } from 'zustand';
import {
  DEFAULT_TIMEZONE_PREFERENCE,
  normalizeTimezonePreference,
  resolveTimeZone,
  type TimezonePreference,
} from '../utils/timezone';

export const TIMEZONE_STORAGE_KEY = 'notify-chain:timezone-preference';
export const LOCALE_STORAGE_KEY = 'notify-chain:locale-preference';

/** Safe fallback used whenever a stored or requested locale is unsupported. */
export const DEFAULT_LOCALE = 'en-US';

/**
 * Returns `true` when `value` is a well-formed BCP 47 language tag that the
 * runtime's `Intl` implementation can actually resolve.
 */
export function isSupportedLocale(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    // `Intl.getCanonicalLocales` throws on structurally invalid tags.
    const [canonical] = Intl.getCanonicalLocales(value.trim());
    if (!canonical) return false;
    // `resolvedOptions` falls back silently for unknown-but-valid tags, so
    // verify the runtime kept the requested language.
    const resolved = new Intl.DateTimeFormat(canonical).resolvedOptions().locale;
    return resolved.toLowerCase() === canonical.toLowerCase();
  } catch {
    return false;
  }
}

/** Normalizes any input into a supported locale, falling back to `en-US`. */
export function normalizeLocale(value: unknown): string {
  return isSupportedLocale(value) ? value.trim() : DEFAULT_LOCALE;
}

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

function readStoredLocale(): string {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

function writeStoredLocale(locale: string): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage may be unavailable (private mode, quota); the preference still
    // applies for the current session.
  }
}

export interface TimezoneState {
  preference: TimezonePreference;
  /** `timeZone` option for `Intl`; `undefined` means the browser's local zone. */
  timeZone: string | undefined;
  /** BCP 47 locale used by the formatting helpers; never unsupported. */
  locale: string;
  setPreference: (preference: unknown) => void;
  setLocale: (locale: unknown) => void;
}

export const useTimezoneStore = create<TimezoneState>((set) => {
  const initial = readStoredPreference();
  const initialLocale = readStoredLocale();
  return {
    preference: initial,
    timeZone: resolveTimeZone(initial),
    locale: initialLocale,
    setPreference: (value) => {
      const preference = normalizeTimezonePreference(value);
      writeStoredPreference(preference);
      set({ preference, timeZone: resolveTimeZone(preference) });
    },
    setLocale: (value) => {
      const locale = normalizeLocale(value);
      writeStoredLocale(locale);
      set({ locale });
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

/** Non-reactive accessor for the active locale, used by formatting helpers. */
export function getActiveLocale(): string {
  return useTimezoneStore.getState().locale;
}

/**
 * Subscribes a component to the active locale so it re-renders when the
 * preference changes. Returns the locale to pass to formatters.
 */
export function useActiveLocale(): string {
  return useTimezoneStore((state) => state.locale);
}
