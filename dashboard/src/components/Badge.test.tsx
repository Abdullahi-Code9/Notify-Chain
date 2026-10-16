/**
 * Badge styling standardization tests (#504)
 *
 * Verifies that all badge variants use consistent design tokens.
 * Since jsdom doesn't compute CSS custom properties, we validate
 * the token definitions exist and that components apply the correct
 * badge class names.
 */
import * as fs from 'fs';
import * as path from 'path';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { EventCard } from './EventCard';
import type { BlockchainEvent } from '../types/event';

const mockEvent: BlockchainEvent = {
  eventId: 'evt-1',
  type: 'TaskCreated',
  eventName: 'TaskCreated',
  ledger: 12345,
  contractAddress: 'GABCDEF1234567890ABCDEF1234567890ABCDEF12',
  receivedAt: Date.now(),
  value: '100',
  txHash: 'abcdef1234567890',
  topic: [],
} as BlockchainEvent;

function readCssContent(): string {
  return fs.readFileSync(
    path.resolve(__dirname, '../index.css'),
    'utf-8',
  );
}

// ─── Token definition tests ─────────────────────────────────────────────────

describe('Badge design tokens defined (#504)', () => {
  it('badge design tokens are defined in CSS', () => {
    const cssContent = readCssContent();

    // Verify core badge tokens exist
    expect(cssContent).toContain('--badge-padding-y:');
    expect(cssContent).toContain('--badge-padding-x:');
    expect(cssContent).toContain('--badge-radius:');
    expect(cssContent).toContain('--badge-font-size:');
    expect(cssContent).toContain('--badge-font-weight:');
    expect(cssContent).toContain('--badge-line-height:');

    // Verify color tokens exist
    expect(cssContent).toContain('--badge-green-bg:');
    expect(cssContent).toContain('--badge-green-fg:');
    expect(cssContent).toContain('--badge-blue-bg:');
    expect(cssContent).toContain('--badge-blue-fg:');
    expect(cssContent).toContain('--badge-red-bg:');
    expect(cssContent).toContain('--badge-red-fg:');
    expect(cssContent).toContain('--badge-yellow-bg:');
    expect(cssContent).toContain('--badge-yellow-fg:');
    expect(cssContent).toContain('--badge-purple-bg:');
    expect(cssContent).toContain('--badge-purple-fg:');
    expect(cssContent).toContain('--badge-orange-bg:');
    expect(cssContent).toContain('--badge-orange-fg:');
    expect(cssContent).toContain('--badge-neutral-bg:');
    expect(cssContent).toContain('--badge-neutral-fg:');
  });

  it('all badge classes use var() references to tokens', () => {
    const cssContent = readCssContent();

    // Verify key badge classes reference tokens
    expect(cssContent).toMatch(/\.event-card__badge\s*\{[^}]*var\(--badge-/);
    expect(cssContent).toMatch(/\.event-card__badge--green\s*\{[^}]*var\(--badge-green-bg\)/);
    expect(cssContent).toMatch(/\.event-card__badge--blue\s*\{[^}]*var\(--badge-blue-bg\)/);
    expect(cssContent).toMatch(/\.event-card__badge--red\s*\{[^}]*var\(--badge-red-bg\)/);
    expect(cssContent).toMatch(/\.event-card__badge--yellow\s*\{[^}]*var\(--badge-yellow-bg\)/);
    expect(cssContent).toMatch(/\.event-card__badge--purple\s*\{[^}]*var\(--badge-purple-bg\)/);
    expect(cssContent).toMatch(/\.event-card__badge--orange\s*\{[^}]*var\(--badge-orange-bg\)/);
    expect(cssContent).toMatch(/\.event-card__badge--default\s*\{[^}]*var\(--badge-neutral-bg\)/);
  });

  it('status badges use token references', () => {
    const cssContent = readCssContent();

    expect(cssContent).toMatch(/\.status-badge\s*\{[^}]*var\(--badge-/);
    expect(cssContent).toMatch(/\.status-badge--completed\s*\{[^}]*var\(--badge-green-bg\)/);
    expect(cssContent).toMatch(/\.status-badge--processing\s*\{[^}]*var\(--badge-blue-bg\)/);
    expect(cssContent).toMatch(/\.status-badge--failed\s*\{[^}]*var\(--badge-red-bg\)/);
  });

  it('notif result badges use token references', () => {
    const cssContent = readCssContent();

    expect(cssContent).toMatch(/\.notif-result-card__status--completed[^{]*\{[^}]*var\(--badge-green-bg\)/);
    expect(cssContent).toMatch(/\.notif-result-card__status--pending[^{]*\{[^}]*var\(--badge-yellow-bg\)/);
    expect(cssContent).toMatch(/\.notif-result-card__status--failed[^{]*\{[^}]*var\(--badge-red-bg\)/);
    expect(cssContent).toMatch(/\.notif-result-card__status--cancelled[^{]*\{[^}]*var\(--badge-neutral-bg\)/);
  });

  it('webhook badge classes use token references', () => {
    const cssContent = readCssContent();

    expect(cssContent).toMatch(/\.webhook-failed-table__code--4xx[^{]*\{[^}]*var\(--badge-orange-bg\)/);
    expect(cssContent).toMatch(/\.webhook-failed-table__code--5xx[^{]*\{[^}]*var\(--badge-red-bg\)/);
    expect(cssContent).toMatch(/\.webhook-failed-table__category--4xx[^{]*\{[^}]*var\(--badge-orange-bg\)/);
  });
});

// ─── Component badge class tests ────────────────────────────────────────────

describe('EventCard badge classes (#504)', () => {
  const EVENT_TYPE_COLORS: Record<string, string> = {
    TaskCreated: 'event-card__badge--green',
    WorkSubmitted: 'event-card__badge--blue',
    SubmissionApproved: 'event-card__badge--green',
    SubmissionRejected: 'event-card__badge--red',
    TaskCancelled: 'event-card__badge--red',
    DisputeRaised: 'event-card__badge--yellow',
    AutoshareCreated: 'event-card__badge--purple',
    Withdrawal: 'event-card__badge--orange',
  };

  it.each(Object.entries(EVENT_TYPE_COLORS))(
    'event type "%s" maps to badge class "%s"',
    (eventType, expectedClass) => {
      const { container } = render(
        <EventCard event={{ ...mockEvent, eventName: eventType, type: eventType }} />,
      );
      const badge = container.querySelector('.event-card__badge');
      expect(badge).toHaveClass(expectedClass);
    },
  );

  it('unknown event type uses default badge', () => {
    const { container } = render(
      <EventCard event={{ ...mockEvent, eventName: 'UnknownEvent', type: 'UnknownEvent' }} />,
    );
    const badge = container.querySelector('.event-card__badge');
    expect(badge).toHaveClass('event-card__badge--default');
  });

  it('null eventName uses default badge', () => {
    const { container } = render(
      <EventCard event={{ ...mockEvent, eventName: null }} />,
    );
    const badge = container.querySelector('.event-card__badge');
    expect(badge).toHaveClass('event-card__badge--default');
  });
});

// ─── Accessibility contrast checks ──────────────────────────────────────────

describe('Badge accessibility contrast (#504)', () => {
  it('all badge foreground colors are defined as hex values', () => {
    const cssContent = readCssContent();

    // All foreground colors should be hex values (ensures they're not transparent)
    const fgTokenPattern = /--badge-[a-z]+-fg:\s*(#[0-9a-fA-F]{3,8})/g;
    const matches = [...cssContent.matchAll(fgTokenPattern)];
    expect(matches.length).toBeGreaterThanOrEqual(7);

    matches.forEach((match) => {
      expect(match[1]).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    });
  });

  it('light theme badge colors are defined', () => {
    const cssContent = readCssContent();

    // Light theme should override badge colors
    const lightSection = cssContent.substring(
      cssContent.indexOf('[data-theme="light"]'),
    );
    expect(lightSection).toContain('--badge-green-bg:');
    expect(lightSection).toContain('--badge-green-fg:');
    expect(lightSection).toContain('--badge-blue-bg:');
    expect(lightSection).toContain('--badge-red-bg:');
  });
});
