const EVENT_ID_PARAM = 'eventId';

export function parseSelectedEventId(search: string): string | null {
  const eventId = new URLSearchParams(search).get(EVENT_ID_PARAM);
  return eventId?.trim() || null;
}
