/**
 * Notification export helpers for filtered search results.
 *
 * ## Export format
 *
 * ### JSON (`application/json`)
 * ```json
 * {
 *   "exportedAt": "2026-07-26T15:00:00.000Z",
 *   "format": "json",
 *   "filters": { "q": "...", "status": "COMPLETED", ... },
 *   "total": 2,
 *   "notifications": [
 *     {
 *       "id": 1,
 *       "source": "scheduled",
 *       "eventId": null,
 *       "txHash": null,
 *       "contractAddress": null,
 *       "notificationType": "discord",
 *       "targetRecipient": "https://...",
 *       "status": "COMPLETED",
 *       "createdAt": "2026-07-26T14:00:00.000Z",
 *       "payload": "{...}"
 *     }
 *   ]
 * }
 * ```
 *
 * ### CSV (`text/csv`)
 * Header row:
 * `id,source,eventId,txHash,contractAddress,notificationType,targetRecipient,status,createdAt,payload`
 *
 * - Values are comma-separated.
 * - Fields containing commas/quotes/newlines are double-quoted; quotes are escaped as `""`.
 * - `payload` is exported as a single CSV cell (JSON string escaped).
 * - Applied search filters are *not* embedded in the CSV body; they are reflected by
 *   which rows are included (only matching notifications are exported).
 */

import type { NotificationSearchParams, NotificationSearchResult } from '../services/eventsApi';

export type NotificationExportFormat = 'json' | 'csv';

export interface NotificationExportDocument {
  exportedAt: string;
  format: 'json';
  filters: Partial<NotificationSearchParams>;
  total: number;
  notifications: NotificationSearchResult[];
}

export function buildNotificationExportJson(
  notifications: NotificationSearchResult[],
  filters: Partial<NotificationSearchParams> = {},
): string {
  const doc: NotificationExportDocument = {
    exportedAt: new Date().toISOString(),
    format: 'json',
    filters,
    total: notifications.length,
    notifications,
  };
  return JSON.stringify(doc, null, 2);
}

export function buildNotificationExportCsv(notifications: NotificationSearchResult[]): string {
  const headers = [
    'id',
    'source',
    'eventId',
    'txHash',
    'contractAddress',
    'notificationType',
    'targetRecipient',
    'status',
    'createdAt',
    'payload',
  ];

  const rows = notifications.map((n) =>
    [
      String(n.id),
      n.source,
      n.eventId ?? '',
      n.txHash ?? '',
      n.contractAddress ?? '',
      n.notificationType ?? '',
      n.targetRecipient ?? '',
      n.status,
      n.createdAt,
      n.payload ?? '',
    ]
      .map(escapeCsvField)
      .join(','),
  );

  return [headers.join(','), ...rows].join('\n');
}

export function buildNotificationExportBlob(
  notifications: NotificationSearchResult[],
  format: NotificationExportFormat,
  filters: Partial<NotificationSearchParams> = {},
): { blob: Blob; filename: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (format === 'csv') {
    return {
      blob: new Blob([buildNotificationExportCsv(notifications)], {
        type: 'text/csv;charset=utf-8',
      }),
      filename: `notifications_export_${stamp}.csv`,
    };
  }

  return {
    blob: new Blob([buildNotificationExportJson(notifications, filters)], {
      type: 'application/json;charset=utf-8',
    }),
    filename: `notifications_export_${stamp}.json`,
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
