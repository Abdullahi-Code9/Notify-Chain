import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  Translator,
  createTranslator,
  getDefaultTranslator,
  interpolate,
  resetDefaultTranslator,
  resolveDefaultLocale,
} from './translator';

describe('i18n translator', () => {
  describe('interpolate', () => {
    it('replaces named placeholders', () => {
      expect(interpolate('Hello {name}, you have {count} alerts', { name: 'Ada', count: 3 })).toBe(
        'Hello Ada, you have 3 alerts',
      );
    });

    it('leaves unknown placeholders untouched', () => {
      expect(interpolate('Hi {name}', {})).toBe('Hi {name}');
    });

    it('returns the template when no params are supplied', () => {
      expect(interpolate('plain text')).toBe('plain text');
    });
  });

  describe('translation across locales', () => {
    const translator = createTranslator({ defaultLocale: 'en' });

    it('formats the Discord event title in English', () => {
      expect(translator.t('discord.event.title', { eventName: 'TaskCreated' }, 'en')).toBe(
        '📡 Event: TaskCreated',
      );
    });

    it('formats the Discord event title in Spanish', () => {
      expect(translator.t('discord.event.title', { eventName: 'TaskCreated' }, 'es')).toBe(
        '📡 Evento: TaskCreated',
      );
    });

    it('translates field labels per locale', () => {
      expect(translator.t('discord.field.contract', undefined, 'en')).toBe('Contract');
      expect(translator.t('discord.field.contract', undefined, 'es')).toBe('Contrato');
    });

    it('honours the configured initial locale', () => {
      const spanish = createTranslator({ defaultLocale: 'es' });
      // No explicit locale → uses the configured default.
      expect(spanish.t('discord.field.ledger')).toBe('Libro mayor');
    });

    it('exposes every shipped locale', () => {
      for (const locale of SUPPORTED_LOCALES) {
        expect(translator.hasLocale(locale)).toBe(true);
      }
    });
  });

  describe('fallback behaviour', () => {
    it('falls back to the default locale when a key is missing', () => {
      const translator = new Translator({
        defaultLocale: 'en',
        catalogs: { fr: { 'discord.field.type': 'Type 2' } },
      });

      // Present in 'fr'.
      expect(translator.t('discord.field.type', undefined, 'fr')).toBe('Type 2');
      // Missing in 'fr' → falls back to English.
      expect(translator.t('discord.field.contract', undefined, 'fr')).toBe('Contract');
    });

    it('falls back to the default locale when the requested locale is unknown', () => {
      const translator = createTranslator({ defaultLocale: 'en' });
      expect(translator.resolveLocale('de')).toBe('en');
      expect(translator.t('discord.field.value', undefined, 'de')).toBe('Value');
    });

    it('returns the key itself when no catalog defines it', () => {
      const translator = createTranslator();
      expect(translator.t('does.not.exist')).toBe('does.not.exist');
    });

    it('reports translation availability via has()', () => {
      const translator = createTranslator();
      expect(translator.has('discord.field.type', 'en')).toBe(true);
      expect(translator.has('missing.key', 'en')).toBe(false);
    });
  });

  describe('resolveDefaultLocale', () => {
    it('defaults to en when unset', () => {
      expect(resolveDefaultLocale({} as NodeJS.ProcessEnv)).toBe(DEFAULT_LOCALE);
    });

    it('normalises and returns the configured locale', () => {
      expect(resolveDefaultLocale({ DEFAULT_LOCALE: ' ES ' } as unknown as NodeJS.ProcessEnv)).toBe(
        'es',
      );
    });
  });

  describe('shared translator', () => {
    afterEach(() => {
      resetDefaultTranslator();
      delete process.env.DEFAULT_LOCALE;
    });

    it('reads DEFAULT_LOCALE from the environment', () => {
      process.env.DEFAULT_LOCALE = 'es';
      resetDefaultTranslator();
      expect(getDefaultTranslator().fallbackLocale).toBe('es');
    });

    it('memoises the shared instance', () => {
      resetDefaultTranslator();
      expect(getDefaultTranslator()).toBe(getDefaultTranslator());
    });
  });
});
