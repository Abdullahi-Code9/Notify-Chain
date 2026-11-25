/**
 * Localization (i18n) — user-facing text separated from delivery logic.
 *
 * Notification text is resolved through a {@link Translator} backed by external
 * message catalogs (see `./locales`). Delivery code depends only on message
 * *keys*, never on literal strings, so adding a locale or tweaking wording is a
 * data change rather than a code change.
 *
 * Fallback is deterministic and predictable:
 *   1. requested locale (when a catalog exists for it)
 *   2. the configured default locale
 *   3. the key itself (never throws)
 */

import en from './locales/en';
import es from './locales/es';

export type MessageCatalog = Record<string, string>;

/** The locale used when none is configured or a translation is missing. */
export const DEFAULT_LOCALE = 'en';

/** Locales shipped with the listener. */
export const SUPPORTED_LOCALES: readonly string[] = ['en', 'es'] as const;

/** Built-in catalogs keyed by locale code. */
export const BUILT_IN_CATALOGS: Readonly<Record<string, MessageCatalog>> = {
  en,
  es,
};

export interface TranslatorOptions {
  /** Locale used when the requested locale has no catalog or no translation. */
  defaultLocale?: string;
  /**
   * Extra or overriding catalogs. Merged over the built-in catalogs by locale,
   * which lets tests inject partial catalogs without exporting new ones.
   */
  catalogs?: Record<string, MessageCatalog>;
}

export type TranslationParams = Record<string, string | number>;

/**
 * Resolve the initial locale from the `DEFAULT_LOCALE` environment variable,
 * falling back to {@link DEFAULT_LOCALE} when unset or unsupported.
 */
export function resolveDefaultLocale(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DEFAULT_LOCALE?.trim().toLowerCase();
  if (!raw) return DEFAULT_LOCALE;
  return raw;
}

/**
 * Interpolate `{name}` placeholders with values from `params`.
 *
 * Placeholders without a matching parameter are left untouched so a missing
 * value degrades gracefully instead of rendering `undefined`.
 */
export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export class Translator {
  private readonly defaultLocale: string;
  private readonly catalogs: Record<string, MessageCatalog>;

  constructor(options: TranslatorOptions = {}) {
    const merged: Record<string, MessageCatalog> = { ...BUILT_IN_CATALOGS };
    for (const [locale, catalog] of Object.entries(options.catalogs ?? {})) {
      merged[locale] = { ...(merged[locale] ?? {}), ...catalog };
    }
    this.catalogs = merged;

    const requested = options.defaultLocale?.trim().toLowerCase();
    this.defaultLocale = requested && merged[requested] ? requested : DEFAULT_LOCALE;
  }

  /** The locale used for fallback. */
  get fallbackLocale(): string {
    return this.defaultLocale;
  }

  /** True when a catalog exists for `locale`. */
  hasLocale(locale: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.catalogs, locale);
  }

  /**
   * Resolve the effective locale: the requested one when known, otherwise the
   * configured default.
   */
  resolveLocale(locale?: string): string {
    const candidate = locale?.trim().toLowerCase();
    if (candidate && this.hasLocale(candidate)) return candidate;
    return this.defaultLocale;
  }

  /** True when `key` has a translation in the effective locale or the fallback. */
  has(key: string, locale?: string): boolean {
    const effective = this.resolveLocale(locale);
    return (
      this.catalogs[effective]?.[key] !== undefined ||
      this.catalogs[this.defaultLocale]?.[key] !== undefined
    );
  }

  /**
   * Translate `key`, interpolating `params`.
   *
   * Falls back to the default locale, then to the key itself, so callers can
   * always render something meaningful.
   */
  t(key: string, params?: TranslationParams, locale?: string): string {
    const effective = this.resolveLocale(locale);
    const template =
      this.catalogs[effective]?.[key] ?? this.catalogs[this.defaultLocale]?.[key] ?? key;
    return interpolate(template, params);
  }
}

/** Convenience factory mirroring the constructor. */
export function createTranslator(options?: TranslatorOptions): Translator {
  return new Translator(options);
}

/**
 * Process-wide translator built from the environment. Delivery services use
 * this when no translator is injected, so `DEFAULT_LOCALE` configures the
 * listener's initial locale without touching call sites.
 */
let defaultTranslator: Translator | null = null;

export function getDefaultTranslator(): Translator {
  if (!defaultTranslator) {
    defaultTranslator = new Translator({ defaultLocale: resolveDefaultLocale() });
  }
  return defaultTranslator;
}

/** Reset the shared translator — used by tests and when config is reloaded. */
export function resetDefaultTranslator(): void {
  defaultTranslator = null;
}
