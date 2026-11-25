import * as fs from 'fs';
import * as path from 'path';

/** WCAG relative luminance contrast for two #rrggbb colors. */
export function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [0, 2, 4].map((index) => {
      const value = parseInt(hex.slice(index + 1, index + 3), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

function decl(rules: string, name: string): string {
  const match = rules.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`missing ${name}`);
  return match[1];
}

const css = fs.readFileSync(path.join(__dirname, '../index.css'), 'utf8');

const KEY_SCREENS = [
  '.event-explorer__lead',
  '.activity-feed__subtitle',
  '.timeline__entry-time',
  '.webhook-dashboard__lead',
  '.webhook-dashboard__eyebrow',
  '.timeline__entry-error',
];

describe('dashboard theme contrast', () => {
  const themes = [
    { name: 'dark', selector: ':root' },
    { name: 'light', selector: '[data-theme="light"]' },
  ] as const;

  it.each(themes)('$name text tokens meet WCAG AA against the page background', ({ selector }) => {
    const rules = block(css, selector);
    const background = decl(rules, 'background');
    for (const token of ['color', '--text-muted', '--text-accent', '--text-danger', '--hm-text-tertiary']) {
      const foreground = decl(rules, token);
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('binds key screens to theme tokens so both modes stay readable', () => {
    const bindings: Record<string, string> = {
      '.event-explorer__lead': 'var(--text-muted)',
      '.activity-feed__subtitle': 'var(--text-muted)',
      '.timeline__entry-time': 'var(--text-muted)',
      '.webhook-dashboard__lead': 'var(--text-muted)',
      '.webhook-dashboard__eyebrow': 'var(--text-accent)',
      '.timeline__entry-error': 'var(--text-danger)',
    };
    for (const selector of KEY_SCREENS) {
      expect(block(css, selector)).toContain(bindings[selector]);
    }
  });
});
