import {
  EVENT_TYPE_PRESENTATIONS,
  UNKNOWN_EVENT_TYPE_PRESENTATION,
  getEventBadgeClass,
  getEventKindClass,
  getEventKindLabel,
  getEventTypePresentation,
  isKnownEventType,
} from './eventTypeMapping';

describe('isKnownEventType (issue #612)', () => {
  it('returns true for catalogued event names', () => {
    expect(isKnownEventType('TaskCreated')).toBe(true);
    expect(isKnownEventType('NotificationScheduled')).toBe(true);
  });

  it('matches catalogued event names case-insensitively', () => {
    expect(isKnownEventType('taskcreated')).toBe(true);
    expect(isKnownEventType('CONTRACT')).toBe(true);
  });

  it('returns false for event types the dashboard has not seen yet', () => {
    expect(isKnownEventType('FutureContractEvent')).toBe(false);
    expect(isKnownEventType('reputation_updated')).toBe(false);
  });

  it('returns false for empty, null and undefined input', () => {
    expect(isKnownEventType('')).toBe(false);
    expect(isKnownEventType(null)).toBe(false);
    expect(isKnownEventType(undefined)).toBe(false);
  });
});

describe('getEventTypePresentation fallback for unknown event types (issue #612)', () => {
  it('returns the neutral fallback presentation for an unmapped type', () => {
    const presentation = getEventTypePresentation('FutureContractEvent');

    expect(presentation.badgeClass).toBe(UNKNOWN_EVENT_TYPE_PRESENTATION.badgeClass);
    expect(presentation.kindBadgeClass).toBe(UNKNOWN_EVENT_TYPE_PRESENTATION.kindBadgeClass);
    expect(presentation.kindLabel).toBe('Unknown');
    expect(presentation.category).toBe('General');
    expect(presentation.color).toBe('gray');
  });

  it('keeps the raw event type as the label so the payload stays identifiable', () => {
    expect(getEventTypePresentation('FutureContractEvent').label).toBe('FutureContractEvent');
  });

  it('never returns undefined presentation fields for an unknown type', () => {
    const presentation = getEventTypePresentation('brand_new_event');

    for (const value of Object.values(presentation)) {
      expect(value).toBeDefined();
    }
  });

  it('still resolves catalogued types exactly', () => {
    const known = getEventTypePresentation('TaskCreated');

    expect(known).toBe(EVENT_TYPE_PRESENTATIONS.TaskCreated);
  });

  it('helpers fall back safely for unknown types', () => {
    expect(getEventBadgeClass('FutureContractEvent')).toBe(
      UNKNOWN_EVENT_TYPE_PRESENTATION.badgeClass,
    );
    expect(getEventKindClass('FutureContractEvent')).toBe(
      UNKNOWN_EVENT_TYPE_PRESENTATION.kindBadgeClass,
    );
    expect(getEventKindLabel('FutureContractEvent')).toBe('Unknown');
  });
});
