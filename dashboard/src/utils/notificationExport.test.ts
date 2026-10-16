import {
  buildNotificationExportCsv,
  buildNotificationExportJson,
  buildNotificationExportBlob,
} from './notificationExport';
import type { NotificationSearchResult } from '../services/eventsApi';

const sample: NotificationSearchResult[] = [
  {
    id: 1,
    source: 'scheduled',
    eventId: 'evt-1',
    txHash: 'abc',
    contractAddress: 'CC…',
    notificationType: 'discord',
    targetRecipient: 'https://hooks.example/1',
    status: 'COMPLETED',
    createdAt: '2026-07-26T12:00:00.000Z',
    payload: '{"message":"hi"}',
    failureReason: null,
  },
  {
    id: 2,
    source: 'processed',
    eventId: null,
    txHash: null,
    contractAddress: null,
    notificationType: 'email',
    targetRecipient: 'a@b.com',
    status: 'FAILED',
    createdAt: '2026-07-26T13:00:00.000Z',
    payload: null,
    failureReason: 'Timeout',
  },
];

describe('notificationExport', () => {
  it('builds JSON that includes filters and all rows', () => {
    const json = buildNotificationExportJson(
      sample,
      {
        status: 'COMPLETED',
        q: 'hi',
      },
    );

    const parsed = JSON.parse(json);

    expect(parsed.format).toBe('json');
    expect(parsed.filters.status).toBe('COMPLETED');
    expect(parsed.total).toBe(2);
    expect(parsed.notifications).toHaveLength(2);
  });

  it('builds CSV with header and escaped fields', () => {
    const csv = buildNotificationExportCsv(sample);
    const lines = csv.split('\n');

    expect(lines[0]).toContain(
      'id,source,eventId',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('COMPLETED');
  });

  it('creates downloadable blobs for json and csv', () => {
    const jsonBlob = buildNotificationExportBlob(
      sample,
      'json',
      { type: 'discord' },
    );

    expect(jsonBlob.filename).toMatch(/\.json$/);
    expect(jsonBlob.blob.type).toContain('json');

    const csvBlob = buildNotificationExportBlob(
      sample,
      'csv',
    );

    expect(csvBlob.filename).toMatch(/\.csv$/);
    expect(csvBlob.blob.type).toContain('csv');
  });
});