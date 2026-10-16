export interface NotificationExport {
  id: string;
  name: string;
  format: 'CSV' | 'JSON' | 'PDF';
  status: 'Completed' | 'Processing' | 'Failed';
  createdAt: number;
  recordCount: number;
  fileSize: string;
}

export function generateMockExports(): NotificationExport[] {
  const baseTime = 1782399000000; // Represents roughly mid 2026
  const formats: ('CSV' | 'JSON' | 'PDF')[] = ['CSV', 'JSON', 'PDF'];

  const names = [
    'System Alert Notification logs',
    'Monthly billing export',
    'Contract event dispatch history',
    'Urgent error broadcast records',
    'Stellar network sync logs',
    'User activity digest export',
    'AutoShare usage tracking audit',
    'Revocation history summary',
    'Priority dispatch queue telemetry',
    'Security auditing report',
    'Deduplication database logs',
    'Webhook delivery metrics',
    'Client preferences dump',
    'API access token usage report',
    'Failure recovery logs',
  ];

  return names.map((name, index) => {
    // Determine status (mostly completed, some processing/failed for realism)
    let status: 'Completed' | 'Processing' | 'Failed' = 'Completed';
    if (index === 1) {
      status = 'Processing';
    } else if (index === 5) {
      status = 'Failed';
    } else if (index === 8) {
      status = 'Processing';
    }

    // Determine format
    const format = formats[index % formats.length];

    // Determine size and count
    const recordCount = (index + 1) * 384 + (index % 3) * 12;
    const fileSize =
      status === 'Failed'
        ? '0 KB'
        : status === 'Processing'
          ? '--'
          : `${(recordCount * 0.15 + (index % 5)).toFixed(1)} KB`;

    return {
      id: `exp-${1000 + index}`,
      name,
      format,
      status,
      createdAt: baseTime - index * 3 * 3600 * 1000 - (index % 5) * 15 * 60 * 1000,
      recordCount: status === 'Failed' ? 0 : recordCount,
      fileSize,
    };
  });
}
