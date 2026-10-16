import { parseSelectedEventId } from '../utils/eventUrlState';

describe('EventExplorerPage URL state', () => {
  it('reads a selected event ID from the query string', () => {
    expect(parseSelectedEventId('?page=2&eventId=evt-42')).toBe('evt-42');
  });

  it('treats missing and blank event IDs as no selection', () => {
    expect(parseSelectedEventId('')).toBeNull();
    expect(parseSelectedEventId('?eventId=')).toBeNull();
    expect(parseSelectedEventId('?eventId=%20')).toBeNull();
  });

  it('decodes URL-encoded event IDs', () => {
    expect(parseSelectedEventId('?eventId=event%2F42')).toBe('event/42');
  });
});
