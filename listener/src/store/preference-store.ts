import { UserPreferences, PreferencesUpdateInput, QuietHours, DeliveryWindow } from '../types/preferences';
import { InputValidator, isBoolean, isNonEmptyString, isPlainObject } from '../utils/validation';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

function isValidTimezone(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export class PreferenceStore {
  private store = new Map<string, UserPreferences>();

  /** Returns preferences for userId, creating defaults if absent */
  get(userId: string): UserPreferences {
    if (!this.store.has(userId)) {
      const defaults: UserPreferences = {
        userId,
        categories: { discord: true },
        quietHours: null,
        deliveryWindow: null,
        updatedAt: Date.now(),
      };
      this.store.set(userId, defaults);
    }
    const stored = this.store.get(userId)!;
    return {
      ...stored,
      categories: { ...stored.categories },
      quietHours: stored.quietHours ? { ...stored.quietHours } : null,
      deliveryWindow: stored.deliveryWindow ? { ...stored.deliveryWindow } : null,
    };
  }

  /** Merges category updates, returns updated preferences. Throws ValidationError on invalid input. */
  update(userId: string, input: PreferencesUpdateInput): UserPreferences {
    const v = new InputValidator();
    v.check(isNonEmptyString(userId), 'userId', 'is required');
    if (v.check(isPlainObject(input?.categories), 'categories', 'must be an object of category name to boolean')) {
      for (const [category, enabled] of Object.entries(input.categories)) {
        v.check(isNonEmptyString(category), 'categories', 'category names must be non-empty strings');
        v.check(isBoolean(enabled), `categories.${category}`, `must be a boolean, received ${JSON.stringify(enabled)}`);
      }
    }

    if (input?.quietHours !== undefined && input.quietHours !== null) {
      if (v.check(isPlainObject(input.quietHours), 'quietHours', 'must be an object or null')) {
        const qh = input.quietHours as QuietHours;
        v.check(isValidTime(qh.start), 'quietHours.start', 'must be a time in HH:MM format');
        v.check(isValidTime(qh.end), 'quietHours.end', 'must be a time in HH:MM format');
        v.check(isValidTimezone(qh.timezone), 'quietHours.timezone', 'must be a valid IANA timezone');
      }
    }

    if (input?.deliveryWindow !== undefined && input.deliveryWindow !== null) {
      if (v.check(isPlainObject(input.deliveryWindow), 'deliveryWindow', 'must be an object or null')) {
        const dw = input.deliveryWindow as DeliveryWindow;
        v.check(isValidTime(dw.start), 'deliveryWindow.start', 'must be a time in HH:MM format');
        v.check(isValidTime(dw.end), 'deliveryWindow.end', 'must be a time in HH:MM format');
        v.check(isValidTimezone(dw.timezone), 'deliveryWindow.timezone', 'must be a valid IANA timezone');
      }
    }
    v.throwIfInvalid();

    const existing = this.get(userId);
    const updated: UserPreferences = {
      ...existing,
      categories: { ...existing.categories, ...input.categories },
      quietHours:
        input.quietHours === undefined
          ? existing.quietHours
          : input.quietHours === null
            ? null
            : { ...(input.quietHours as QuietHours) },
      deliveryWindow:
        input.deliveryWindow === undefined
          ? existing.deliveryWindow
          : input.deliveryWindow === null
            ? null
            : { ...(input.deliveryWindow as DeliveryWindow) },
      updatedAt: Date.now(),
    };
    this.store.set(userId, updated);
    return {
      ...updated,
      categories: { ...updated.categories },
      quietHours: updated.quietHours ? { ...updated.quietHours } : null,
      deliveryWindow: updated.deliveryWindow ? { ...updated.deliveryWindow } : null,
    };
  }

  /** Returns true if the given category is enabled for userId */
  isCategoryEnabled(userId: string, category: string): boolean {
    const prefs = this.get(userId);
    // If the category has never been set, default to enabled
    return prefs.categories[category] !== false;
  }
}

export const preferenceStore = new PreferenceStore();
